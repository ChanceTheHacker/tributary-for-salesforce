// Screenshots every screen and state for design review. Read-only: dialogs
// and confirmations are opened and cancelled, nothing is saved or activated,
// and only Flow_Compare_Demo is ever asked to activate. Never logs URLs.
//   node tour.js [name...] [--width=1600] [--out=dir]
const path = require("path");
const fs = require("fs");
const { open, ORG, NS, DISCOUNTS, OUT } = require("./session");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split("=")[1] : fallback;
};
const only = args.filter((arg) => !arg.startsWith("--"));
const width = Number(option("width", 1600));
const dir = option("out", path.join(OUT, "tour"));
fs.mkdirSync(dir, { recursive: true });

const compare = (query) => `${ORG}/lightning/n/${NS}Flow_Compare?${query}`;
const DEMO = "c__flow=Flow_Compare_Demo";
const ROUTING = "c__flow=Case_Email_Routing";
// Seeded by seed-flows.js as base, ours and theirs.
const LARGE = `c__flow=UAT_Discounts_A&c__va=${DISCOUNTS.ours}&c__vb=${DISCOUNTS.theirs}&c__base=${DISCOUNTS.base}&c__tab=merge`;
const CROSS =
  "c__mode=flows&c__flow=UAT_Case_Triage_Record&c__flowB=UAT_Case_Triage_Sub&c__tab=merge";
const node = (page, label) =>
  page.locator("c-flow-canvas .node", { hasText: label }).first();

async function go(page, url, settle = 9000) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(settle);
}

const steps = [
  ["setup", (page) => go(page, `${ORG}/lightning/n/${NS}Flow_Compare_Setup`)],
  [
    "setup-checks",
    (page) =>
      go(page, `${ORG}/lightning/n/${NS}Flow_Compare_Setup?c__section=monitor`)
  ],
  [
    // Opening the guide changes nothing; at most it tests the connection.
    "setup-guide",
    async (page) => {
      await go(page, `${ORG}/lightning/n/${NS}Flow_Compare_Setup`);
      await page.getByRole("button", { name: "Set up step by step" }).click();
      await page.waitForTimeout(1200);
    }
  ],
  ["compare-empty", (page) => go(page, compare(""))],
  [
    "compare-picker",
    async (page) => {
      await go(page, compare(""));
      await page.getByRole("combobox", { name: "Flow" }).first().click();
      await page.keyboard.type("demo");
      await page.waitForTimeout(800);
    },
    (page) => page.keyboard.press("Escape")
  ],
  [
    "compare-loading",
    (page) => go(page, compare(`${DEMO}&c__va=1&c__vb=3`), 1800)
  ],
  ["compare-split", (page) => go(page, compare(`${DEMO}&c__va=1&c__vb=3`))],
  [
    "compare-element",
    async (page) => {
      await go(page, compare(`${DEMO}&c__va=1&c__vb=3`));
      await page.locator(".node.status-changed").first().click();
      await page.waitForTimeout(1500);
    }
  ],
  [
    "compare-find",
    async (page) => {
      await go(page, compare(`${DEMO}&c__va=1&c__vb=3`));
      await page
        .locator("lightning-button-icon.find-open button")
        .first()
        .click();
      await page.keyboard.type("update");
      await page.waitForTimeout(1200);
    },
    (page) => page.keyboard.press("Escape")
  ],
  [
    "compare-combined",
    async (page) => {
      await go(page, compare(`${DEMO}&c__va=1&c__vb=3`));
      await page.getByText("Combined", { exact: true }).first().click();
      await page.waitForTimeout(2500);
    }
  ],
  [
    "compare-xml",
    async (page) => {
      await go(page, compare(`${DEMO}&c__va=1&c__vb=3`));
      await page.getByText("XML", { exact: true }).first().click();
      await page.waitForTimeout(2500);
    }
  ],
  [
    "compare-xml-gap",
    async (page) => {
      await go(page, compare(`${DEMO}&c__va=1&c__vb=3`));
      await page.getByText("XML", { exact: true }).first().click();
      await page.waitForTimeout(2000);
      await page.locator("c-flow-text-diff button.skipped").first().click();
      await page.waitForTimeout(1000);
    }
  ],
  [
    "compare-large",
    (page) => go(page, compare(`${ROUTING}&c__va=3&c__vb=4`), 12000)
  ],
  [
    "compare-flows",
    (page) =>
      go(
        page,
        compare(`c__mode=flows&${DEMO}&c__flowB=lead_automation_test`),
        12000
      )
  ],
  [
    "merge",
    (page) =>
      go(page, compare(`${DEMO}&c__va=3&c__vb=4&c__base=2&c__tab=merge`))
  ],
  [
    "merge-conflict",
    async (page) => {
      await go(page, compare(`${DEMO}&c__va=3&c__vb=4&c__base=2&c__tab=merge`));
      await page.locator(".node.has-conflict").first().click();
      await page.waitForTimeout(1500);
    }
  ],
  [
    "merge-text",
    async (page) => {
      await go(page, compare(`${DEMO}&c__va=3&c__vb=4&c__base=2&c__tab=merge`));
      await page.getByText("XML merge", { exact: true }).first().click();
      await page.waitForTimeout(2500);
    }
  ],
  [
    "merge-text-edit",
    async (page) => {
      await go(page, compare(`${DEMO}&c__va=3&c__vb=4&c__base=2&c__tab=merge`));
      await page.getByText("XML merge", { exact: true }).first().click();
      await page.waitForTimeout(2000);
      await page
        .getByRole("button", { name: "Edit the result by hand" })
        .click();
      await page.waitForTimeout(1000);
    }
  ],
  ["merge-large", (page) => go(page, compare(LARGE), 12000)],
  [
    "merge-groups",
    async (page) => {
      await go(page, compare(LARGE), 12000);
      await page.getByRole("tab", { name: /^Groups/ }).click();
      await page.waitForTimeout(1200);
    }
  ],
  [
    "merge-multi",
    async (page) => {
      await go(page, compare(LARGE), 12000);
      await node(page, "Check Loyalty").click();
      await node(page, "Loyalty Bonus").click({ modifiers: ["Shift"] });
      await node(page, "Loyalty Note").click({ modifiers: ["Shift"] });
      await page.waitForTimeout(1500);
    }
  ],
  [
    "merge-goes-to",
    async (page) => {
      await go(page, compare(LARGE), 12000);
      await node(page, "Check Tier").click();
      await page.waitForTimeout(1200);
      await page.getByText("Goes to", { exact: true }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
    }
  ],
  [
    "merge-mapping",
    async (page) => {
      await go(page, compare(CROSS), 12000);
      await page.getByRole("tab", { name: "Mapping" }).click();
      await page.waitForTimeout(1200);
    }
  ],
  [
    "merge-mapping-place",
    async (page) => {
      await go(page, compare(CROSS), 12000);
      await page.getByRole("tab", { name: "Mapping" }).click();
      await page.getByText("Put it on a path").scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
    }
  ],
  [
    "merge-save-dialog",
    async (page) => {
      await go(page, compare(`${DEMO}&c__va=1&c__vb=3&c__tab=merge`));
      await page
        .getByRole("button", { name: /^Save (visual|XML) merge/ })
        .click();
      await page.waitForTimeout(1500);
    },
    async (page) => {
      await page
        .locator("c-flow-save-dialog")
        .getByRole("button", { name: "Cancel" })
        .click();
    }
  ],
  [
    "activate",
    (page) => go(page, compare(`${DEMO}&c__va=1&c__vb=3&c__tab=activate`))
  ],
  [
    // The confirmation only, on the demo flow, then Cancel.
    "activate-confirm",
    async (page) => {
      await go(page, compare(`${DEMO}&c__va=1&c__vb=3&c__tab=activate`));
      await page
        .locator("c-flow-activation")
        .getByRole("button", {
          name: /^(?:Activate|Approve and activate) version/
        })
        .and(page.locator(":enabled"))
        .first()
        .click();
      await page.waitForTimeout(800);
    },
    async (page) => {
      await page
        .locator("c-flow-activation .confirm")
        .getByRole("button", { name: "Cancel" })
        .click();
    }
  ],
  ["governed", (page) => go(page, `${ORG}/lightning/n/${NS}Governed_Flows`)],
  [
    "governed-editor",
    async (page) => {
      await go(page, `${ORG}/lightning/n/${NS}Governed_Flows`);
      await page.getByRole("button", { name: "Govern a flow" }).click();
      await page.waitForTimeout(1500);
    },
    async (page) => {
      await page.getByRole("button", { name: "Cancel" }).click();
    }
  ],
  [
    "governed-history",
    async (page) => {
      await go(page, `${ORG}/lightning/n/${NS}Governed_Flows`);
      await page
        .locator("table.governed tbody tr")
        .first()
        .locator("lightning-button.history button")
        .click();
      await page.waitForTimeout(2500);
    }
  ],
  [
    "governed-menu",
    async (page) => {
      await go(page, `${ORG}/lightning/n/${NS}Governed_Flows`);
      await page
        .locator("table.governed tbody tr")
        .first()
        .locator("lightning-button-menu.row-menu button")
        .click();
      await page.waitForTimeout(800);
    },
    (page) => page.keyboard.press("Escape")
  ],
  ["approvals", (page) => go(page, `${ORG}/lightning/n/${NS}Flow_Approvals`)],
  [
    "approvals-submitted",
    (page) =>
      go(
        page,
        `${ORG}/lightning/n/${NS}Flow_Approvals?c__scope=submitted&c__status=any`
      )
  ],
  [
    "approvals-all",
    (page) => go(page, `${ORG}/lightning/n/${NS}Flow_Approvals?c__scope=all`)
  ]
];

(async () => {
  const { browser, page } = await open(`/lightning/n/${NS}Flow_Compare_Setup`, {
    viewport: { width, height: Math.round(width * 0.625) }
  });
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err).slice(0, 200)));
  await page.waitForTimeout(6000);
  let failed = errors.length ? 1 : 0;
  for (const [name, show, close] of steps) {
    if (only.length && !only.includes(name)) continue;
    errors.length = 0;
    try {
      await show(page);
      await page.screenshot({ path: path.join(dir, `${name}.png`) });
      if (close) {
        await close(page);
      }
      if (errors.length) failed += 1;
      console.log(name, errors.length ? `FAILED | ${errors.join(" || ")}` : "");
    } catch (e) {
      failed += 1;
      await page.screenshot({ path: path.join(dir, `${name}.png`) });
      console.log(`${name} FAILED: ${String(e).split("\n")[0].slice(0, 200)}`);
    }
  }
  await browser.close();
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error(
    String(e)
      .replace(/(sid|otp|token)=[^&\s]+/g, "$1=…")
      .slice(0, 400)
  );
  process.exit(1);
});
