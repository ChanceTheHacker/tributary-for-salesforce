// Browser server for user-acceptance testing. Testers drive Tributary
// through `uat.js` without seeing any login link, and a guard keeps them
// inside the app and away from the org's real flows and people.
//   node uat-server.js            (listens on 127.0.0.1:47391)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const { execFileSync } = require("child_process");
// Keep real people's names in local configuration, never in published source.
// Refuse to start without the list rather than silently disabling protection.
const protectedNames = (process.env.UAT_PROTECTED_NAMES || "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
if (!protectedNames.length) {
  throw new Error(
    "Set UAT_PROTECTED_NAMES to the comma-separated names to protect."
  );
}
const { ORG, CHROMIUM } = require("./session");

const PORT = Number(process.env.UAT_PORT || 47391);
const SHOTS = process.env.UAT_SHOTS || "/tmp/uat/shots";
const PAGES = {
  compare: "cllc__Flow_Compare",
  governed: "cllc__Governed_Flows",
  approvals: "cllc__Flow_Approvals",
  setup: "cllc__Flow_Compare_Setup"
};
const ROOTS =
  "cllc-flow-compare-app, cllc-flow-governance, cllc-flow-approvals, cllc-flow-compare-setup";
const ALLOWED_PATH =
  /^\/lightning\/n\/cllc__(Flow_Compare|Governed_Flows|Flow_Approvals|Flow_Compare_Setup)\b/;
// The org's real flows and people. Nothing that changes data may run while
// one of them is on screen, and testers may not type them.
const PEOPLE = new RegExp(
  protectedNames
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "i"
);
const REAL = new RegExp(
  `case.?email.?routing|case.?routing.?template|analyze.?flows|lead.?automation|reportexport|${PEOPLE.source}`,
  "i"
);
const CHANGES =
  /activat|approv|reject|save|submit|request|revert|govern|stop|start|run check|delete|remove|confirm|withdraw|connect|verify|apply|merge|create|schedule|restore|owner|mode/i;

const sessions = new Map();
let browser;

function loginUrl(page) {
  const out = execFileSync(
    "sf",
    [
      "org",
      "open",
      "--target-org",
      "tributary-dev",
      "--path",
      `/lightning/n/${PAGES[page]}`,
      "--url-only",
      "--json"
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  return JSON.parse(out.slice(out.indexOf("{"))).result.url;
}

const safePath = (url) => {
  try {
    const u = new URL(url);
    return /frontdoor|sid=/i.test(u.search + u.pathname)
      ? "(login)"
      : u.pathname + u.search;
  } catch {
    return "(unknown)";
  }
};

async function root(s) {
  const found = s.page.locator(ROOTS).filter({ visible: true }).first();
  await found.waitFor({ state: "attached", timeout: 30000 });
  return found;
}

async function settle(s, ms = 700) {
  await s.page.waitForTimeout(ms);
  await s.page.waitForLoadState("domcontentloaded").catch(() => {});
}

// Visible text plus field values, for the guard.
async function screenText(s) {
  const r = await root(s);
  return r.evaluate((el) => {
    const values = [...el.querySelectorAll("input, textarea")]
      .map((i) => i.value)
      .join(" ");
    return `${el.innerText}\n${values}`;
  });
}

async function nameOf(locator) {
  return locator.evaluate((el) => {
    const button =
      el.closest(
        "button, a, [role=button], [role=menuitem], [role=tab], [role=option]"
      ) || el;
    return [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.innerText,
      button.value
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 200);
  });
}

async function guardChange(s, name) {
  if (PEOPLE.test(name))
    throw new Error(
      "BLOCKED by the UAT guard: don't pick a real person; use yourself or Integration User."
    );
  if (!CHANGES.test(name)) return;
  const text = await screenText(s);
  const hit = text.match(REAL);
  if (hit) {
    throw new Error(
      `BLOCKED by the UAT guard: "${name.trim()}" could change a real flow or notify a real person ("${hit[0]}" is on screen). Only change your own UAT flow.`
    );
  }
}

async function afterAction(s) {
  await settle(s);
  const page = s.page;
  const where = safePath(page.url());
  if (!ALLOWED_PATH.test(new URL(page.url()).pathname)) {
    await page
      .goto(s.lastGood, { waitUntil: "domcontentloaded", timeout: 90000 })
      .catch(() => {});
    await settle(s, 6000);
    return `BLOCKED: that left Tributary (went to ${where}); you're back on the previous page.`;
  }
  s.lastGood = page.url();
  const toast = await page
    .locator(".forceToastMessage, .slds-notify_toast")
    .filter({ visible: true })
    .allInnerTexts()
    .catch(() => []);
  const popups = s.closedPopups.splice(0);
  return [
    `page: ${where}`,
    toast.length ? `toast: ${toast.join(" | ").replace(/\s+/g, " ")}` : "",
    popups.length
      ? `note: a new browser tab opened and was closed (${popups.join(", ")})`
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

// Testers reach for [exact=true]; Playwright spells exact names as [name="…" s].
const normalize = (selector) =>
  selector
    .replace(/\[name=("(?:[^"\\]|\\.)*")\]\[exact(?:=true)?\]/g, "[name=$1 s]")
    .replace(/\[exact(?:=true)?\]/g, "");

// SLDS hides real checkboxes and radios behind a styled label, so click the label.
async function clickable(loc) {
  const label = await loc.evaluateHandle((el) => {
    if (el.tagName !== "INPUT" || !/^(checkbox|radio)$/.test(el.type))
      return null;
    return (
      (el.id &&
        el.getRootNode().querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
      el.closest("label")
    );
  });
  return label.asElement() || loc;
}

async function target(s, rawSelector, nth) {
  const selector = normalize(rawSelector);
  const r = await root(s);
  let loc = r.locator(selector);
  if ((await loc.count()) === 0) {
    // Dropdowns and dialogs can render outside the component.
    const outside = s.page
      .locator("[role=dialog], [role=listbox], [role=menu]")
      .filter({ visible: true })
      .locator(selector);
    if ((await outside.count()) > 0) loc = outside;
  }
  const count = await loc.count();
  if (count === 0) throw new Error(`No element matches ${selector}`);
  const index = nth === undefined ? 0 : Number(nth);
  return { loc: loc.nth(index), count };
}

async function insideApp(s, x, y) {
  const r = await root(s);
  const box = await r.boundingBox();
  if (
    !box ||
    x < box.x ||
    y < box.y ||
    x > box.x + box.width ||
    y > box.y + box.height
  ) {
    throw new Error("BLOCKED: that point is outside Tributary.");
  }
}

const flag = (args, name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

const commands = {
  async start(s, args) {
    if (s.page) return "already started";
    const width = Number(args[0] || 1440);
    const height = Number(args[1] || Math.round(width * 0.625));
    s.context = await browser.newContext({ viewport: { width, height } });
    s.context.on("page", async (p) => {
      if (!s.page || p === s.page) return;
      s.closedPopups.push(safePath(p.url()));
      await p.close().catch(() => {});
    });
    s.page = await s.context.newPage();
    s.page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await s.page.goto(loginUrl("compare"), {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });
    await s.page.waitForURL(/lightning\/n\//, { timeout: 90000 });
    await settle(s, 8000);
    s.lastGood = s.page.url();
    return `started at ${width}x${height}\n${await afterAction(s)}`;
  },
  async open(s, args) {
    const name = args[0];
    if (!PAGES[name])
      throw new Error(`open one of: ${Object.keys(PAGES).join(", ")}`);
    const query = args[1] ? `?${args[1].replace(/^\?/, "")}` : "";
    await s.page.goto(`${ORG}/lightning/n/${PAGES[name]}${query}`, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });
    await settle(s, 7000);
    return afterAction(s);
  },
  async reload(s) {
    await s.page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
    await settle(s, 7000);
    return afterAction(s);
  },
  async back(s) {
    await s.page
      .goBack({ waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => {});
    await settle(s, 4000);
    return afterAction(s);
  },
  async snap(s, args) {
    const limit = Number(flag(args, "--lines") || 400);
    const r = await root(s);
    const scope = args[0] ? r.locator(normalize(args[0])).first() : r;
    let text = await scope.ariaSnapshot({ timeout: 20000 });
    const dialogs = await s.page
      .locator("body > [role=dialog], .uiModal")
      .filter({ visible: true })
      .count();
    if (dialogs) text += "\n(also a dialog outside the app is open)";
    const lines = text.split("\n");
    return lines.length > limit
      ? `${lines.slice(0, limit).join("\n")}\n… ${lines.length - limit} more lines (snap <selector> to narrow)`
      : text;
  },
  async text(s, args) {
    const r = await root(s);
    const scope = args[0] ? r.locator(normalize(args[0])).first() : r;
    const t = await scope.innerText({ timeout: 20000 });
    return t.length > 12000 ? `${t.slice(0, 12000)}\n… truncated` : t;
  },
  async shot(s, args) {
    fs.mkdirSync(path.join(SHOTS, s.name), { recursive: true });
    s.shots += 1;
    const label = (args[0] || "shot").replace(/[^\w-]+/g, "-").slice(0, 40);
    const file = path.join(
      SHOTS,
      s.name,
      `${String(s.shots).padStart(3, "0")}-${label}.png`
    );
    await s.page.screenshot({ path: file });
    return file;
  },
  async click(s, args) {
    const nth = flag(args, "--nth");
    const { loc, count } = await target(s, args.join(" "), nth);
    await guardChange(s, await nameOf(loc));
    await (await clickable(loc)).click({ timeout: 15000 });
    return `${count > 1 && nth === undefined ? `(clicked the first of ${count} matches)\n` : ""}${await afterAction(s)}`;
  },
  async dblclick(s, args) {
    const nth = flag(args, "--nth");
    const { loc } = await target(s, args.join(" "), nth);
    await loc.dblclick({ timeout: 15000 });
    return afterAction(s);
  },
  async hover(s, args) {
    const nth = flag(args, "--nth");
    const { loc } = await target(s, args.join(" "), nth);
    await loc.hover({ timeout: 15000 });
    return afterAction(s);
  },
  async fill(s, args) {
    const value = args.pop();
    if (REAL.test(value))
      throw new Error(
        "BLOCKED by the UAT guard: that names a real flow or person."
      );
    const nth = flag(args, "--nth");
    const { loc } = await target(s, args.join(" "), nth);
    await loc.fill(value, { timeout: 15000 });
    return afterAction(s);
  },
  async type(s, args) {
    const value = args.join(" ");
    if (REAL.test(value))
      throw new Error(
        "BLOCKED by the UAT guard: that names a real flow or person."
      );
    await s.page.keyboard.type(value, { delay: 30 });
    return afterAction(s);
  },
  async press(s, args) {
    const key = args[0];
    const times = Number(args[1] || 1);
    if (/^(Enter|Space| )$/.test(key)) {
      const name = await s.page.evaluate(() => {
        let el = document.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement)
          el = el.shadowRoot.activeElement;
        return el
          ? [el.getAttribute("aria-label"), el.innerText, el.value]
              .filter(Boolean)
              .join(" ")
              .slice(0, 200)
          : "";
      });
      await guardChange(s, name);
    }
    for (let i = 0; i < times; i++) await s.page.keyboard.press(key);
    return `${await afterAction(s)}\nfocus: ${await commands.focus(s)}`;
  },
  async focus(s) {
    return s.page.evaluate(() => {
      let el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement)
        el = el.shadowRoot.activeElement;
      if (!el || el === document.body) return "(nothing focused)";
      const role = el.getAttribute("role") || el.tagName.toLowerCase();
      const name =
        el.getAttribute("aria-label") ||
        (el.innerText || el.value || "").trim().slice(0, 80);
      return `${role} "${name}"`;
    });
  },
  async select(s, args) {
    // select <combobox label> <option text>
    const option = args.pop();
    const label = args.join(" ");
    const r = await root(s);
    const box = r.getByRole("combobox", { name: label }).first();
    await box.click({ timeout: 15000 });
    await s.page.waitForTimeout(500);
    const choice = r
      .getByRole("option", { name: option })
      .or(s.page.getByRole("option", { name: option }))
      .first();
    // Picking a real flow to compare is read-only; the guard stops changes later.
    await choice.click({ timeout: 15000 });
    return afterAction(s);
  },
  async clickxy(s, args) {
    const [x, y] = args.map(Number);
    await insideApp(s, x, y);
    await s.page.mouse.click(x, y);
    return afterAction(s);
  },
  async drag(s, args) {
    const [x1, y1, x2, y2] = args.map(Number);
    await insideApp(s, x1, y1);
    await s.page.mouse.move(x1, y1);
    await s.page.mouse.down();
    await s.page.mouse.move(x2, y2, { steps: 12 });
    await s.page.mouse.up();
    return afterAction(s);
  },
  async wheel(s, args) {
    const [x, y, dy] = args.map(Number);
    await insideApp(s, x, y);
    await s.page.mouse.move(x, y);
    await s.page.mouse.wheel(0, dy);
    return afterAction(s);
  },
  async scroll(s, args) {
    await s.page.mouse.wheel(0, Number(args[0] || 600));
    return afterAction(s);
  },
  async resize(s, args) {
    const width = Number(args[0]);
    const height = Number(args[1] || Math.round(width * 0.625));
    await s.page.setViewportSize({ width, height });
    return afterAction(s);
  },
  async wait(s, args) {
    await s.page.waitForTimeout(Math.min(Number(args[0] || 1000), 30000));
    return afterAction(s);
  },
  async where(s) {
    return afterAction(s);
  },
  async stop(s) {
    await s.context?.close();
    sessions.delete(s.name);
    return "stopped";
  }
};

async function handle(body) {
  const { session, command, args = [] } = body;
  if (!/^[\w-]{1,32}$/.test(session || ""))
    throw new Error("usage: uat <session> <command> [args]");
  const run = commands[command];
  if (!run) throw new Error(`commands: ${Object.keys(commands).join(", ")}`);
  let s = sessions.get(session);
  if (!s) {
    if (command !== "start") {
      throw new Error(
        `session ${session} isn't started. If you were mid-test, the UAT server was restarted: run "uat ${session} start <width> <height>" again, reopen your page and carry on.`
      );
    }
    const dir = path.join(SHOTS, session);
    const shots = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    s = { name: session, shots, closedPopups: [], queue: Promise.resolve() };
    sessions.set(session, s);
  }
  // One command at a time per session.
  const result = s.queue.then(() => run(s, [...args]));
  s.queue = result.catch(() => {});
  return result;
}

(async () => {
  browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true
  });
  http
    .createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", async () => {
        try {
          const out = await handle(JSON.parse(data || "{}"));
          res.writeHead(200).end(String(out));
        } catch (e) {
          res.writeHead(400).end(
            String(e.message || e)
              .split("\n")
              .slice(0, 8)
              .join("\n")
              .replace(/https?:\/\/\S+/g, "(url)")
          );
        }
      });
    })
    .listen(PORT, "127.0.0.1", () => console.log(`uat server on ${PORT}`));
})();
