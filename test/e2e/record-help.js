// Records the help videos that Tributary's help buttons play, headless, in
// the test org (see session.js), and writes each one as a static resource
// with its steps in force-app/.../lwc/flowHelp/helpTopics.js.
//
//   node record-help.js              every topic in help-scenes.js
//   node record-help.js merge save   only these, in this order
//   node record-help.js --keep       also keep each topic's frames
//
// Nothing real is filmed. The scenes use the synthetic Order_Discounts and
// Partner_Discounts flows (seed-flows.js), and every response from the org is
// rewritten on its way to the page so people's names, usernames, emails and
// the org's name read as made-up ones. The Salesforce header, with the
// user's photo, is cropped away. Before a video is kept, the text on screen
// at each step is checked for anything that should have been rewritten; a
// match throws the video away and fails the run.
//
// Captions aren't burned in: the player shows each step's text over the
// video, so it stays sharp, can be read aloud and can be corrected in
// helpTopics.js without recording again.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { open, ALIAS, ORG, NS } = require("./session");
const SCENES = require("./help-scenes");

const ROOT = path.join(__dirname, "..", "..", "force-app", "main", "default");
const RESOURCES = path.join(ROOT, "staticresources");
const CATALOG = path.join(ROOT, "lwc", "flowHelp", "helpTopics.js");
const WORK = path.join(__dirname, "out", "help");
const VIEWPORT = { width: 1280, height: 800 };
const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const only = args.filter((arg) => !arg.startsWith("--"));

// ---- Synthetic names ----------------------------------------------------

const PEOPLE = [
  "Alex Morgan",
  "Sam Ortiz",
  "Priya Nair",
  "Jordan Lee",
  "Taylor Reed",
  "Casey Kim",
  "Riley Chen",
  "Jamie Fox"
];
// Accounts named for what they are, not for a person, read the same anywhere.
const GENERIC =
  /^(Automated Process|Data\.com Clean|Chatter Expert|Platform Integration User|Security User)$/;

function sf(cliArgs) {
  const out = execFileSync(
    "sf",
    [...cliArgs, "--target-org", ALIAS, "--json"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }
  );
  return JSON.parse(out.slice(out.indexOf("{"))).result;
}

// The REST API as the CLI's user; the token stays in this process.
let token;
async function rest(api, init = {}) {
  token = token || sf(["org", "auth", "show-access-token"]).accessToken;
  const response = await fetch(`${ORG}/services/data/v67.0${api}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${api.split("?")[0]} answered ${response.status}`);
  }
  return text ? JSON.parse(text) : undefined;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// [pattern, replacement] pairs, longest first, and the words that must not
// be seen once they've been applied.
function synthetic() {
  const users = sf([
    "data",
    "query",
    "--query",
    "SELECT Name, FirstName, LastName, Username, Email FROM User ORDER BY CreatedDate"
  ]).records;
  const org = sf(["data", "query", "--query", "SELECT Name FROM Organization"])
    .records[0].Name;
  const pairs = [];
  const banned = new Set();
  const host = new URL(ORG).hostname;
  const myDomain = host.split(".")[0];
  let next = 0;
  for (const user of users) {
    if (GENERIC.test(user.Name)) {
      continue;
    }
    const name = PEOPLE[next++ % PEOPLE.length];
    const [first, last] = name.split(" ");
    const email = `${first}.${last}@example.com`.toLowerCase();
    pairs.push([user.Name, name]);
    for (const address of [user.Username, user.Email]) {
      pairs.push([address, email]);
      banned.add(address.toLowerCase());
    }
    // First and last names alone only for people: "User" is a word.
    if (!/ User$/.test(user.Name)) {
      pairs.push([user.FirstName, first], [user.LastName, last]);
      banned.add(user.FirstName?.toLowerCase());
      banned.add(user.LastName.toLowerCase());
    }
  }
  pairs.push([org, "Northwind Traders"]);
  banned.add(org.toLowerCase());
  banned.add(myDomain.toLowerCase());
  // The dev org's namespace, on the demo flows' names.
  pairs.push([`${NS}Order_Discounts`, "Order_Discounts"]);
  pairs.push([`${NS}Partner_Discounts`, "Partner_Discounts"]);
  banned.add(NS.toLowerCase());
  pairs.sort((a, b) => b[0].length - a[0].length);
  const rules = pairs
    .filter(([from]) => from)
    .map(([from, to]) => [new RegExp(`\\b${escape(from)}\\b`, "g"), to]);
  return { rules, banned: [...banned].filter(Boolean) };
}

const rewrite = (text, rules) =>
  rules.reduce((out, [pattern, to]) => out.replace(pattern, to), text);

// Only the synthetic flows appear in any list: every other flow in the org,
// and anything recorded about it, is left out of the answer.
const FILMED = new Set(["Order_Discounts", "Partner_Discounts"]);
function onlyFilmed(value) {
  if (Array.isArray(value)) {
    return value
      .filter(
        (item) =>
          !item ||
          typeof item.apiName !== "string" ||
          FILMED.has(item.apiName.replace(/^\w+?__/, ""))
      )
      .map(onlyFilmed);
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      value[key] = onlyFilmed(value[key]);
    }
  }
  return value;
}

function answer(text, rules) {
  const body = rewrite(text, rules);
  const start = body.indexOf("{");
  if (start < 0) {
    return body;
  }
  try {
    return (
      body.slice(0, start) +
      JSON.stringify(onlyFilmed(JSON.parse(body.slice(start))))
    );
  } catch {
    return body;
  }
}

async function prepare(context, rules) {
  // The org's own hosts: Lightning pages are served from another one.
  const myDomain = `${new URL(ORG).hostname.split(".")[0]}.`;
  await context.route(
    (url) => url.hostname.startsWith(myDomain),
    async (route) => {
      const type = route.request().resourceType();
      if (!["xhr", "fetch"].includes(type)) {
        return route.continue();
      }
      let response;
      try {
        response = await route.fetch();
      } catch {
        return route.abort();
      }
      const kind = response.headers()["content-type"] || "";
      if (!/json|html|javascript|text/.test(kind)) {
        return route.fulfill({ response });
      }
      return route.fulfill({
        response,
        body: /json/.test(kind)
          ? answer(await response.text(), rules)
          : rewrite(await response.text(), rules)
      });
    }
  );
  // A cursor and click ripple, which headless Chromium doesn't draw, and no
  // help buttons: the videos are what they open.
  await context.addInitScript(() => {
    const style = `
      #help-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647;
        width: 22px; height: 22px; pointer-events: none;
        transform: translate(-100px, -100px); }
      .help-ripple { position: fixed; z-index: 2147483646; width: 36px; height: 36px;
        margin: -18px 0 0 -18px; border-radius: 50%; pointer-events: none;
        background: rgba(1, 118, 211, 0.35); border: 2px solid rgba(1, 118, 211, 0.8);
        animation: help-ripple 500ms ease-out forwards; }
      @keyframes help-ripple { from { transform: scale(0.3); opacity: 1; }
        to { transform: scale(1.4); opacity: 0; } }
      c-flow-help, c-flow-help-toggle { display: none !important; }`;
    const add = () => {
      if (document.getElementById("help-cursor")) {
        return;
      }
      const sheet = document.createElement("style");
      sheet.textContent = style;
      document.head.appendChild(sheet);
      const cursor = document.createElement("div");
      cursor.id = "help-cursor";
      cursor.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10.1 13 L16 13 Z" fill="#181818" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
      document.documentElement.appendChild(cursor);
      window.addEventListener(
        "mousemove",
        (event) => {
          cursor.style.transform = `translate(${event.clientX - 3}px, ${event.clientY - 2}px)`;
        },
        true
      );
      window.addEventListener(
        "mousedown",
        (event) => {
          const ripple = document.createElement("div");
          ripple.className = "help-ripple";
          ripple.style.left = `${event.clientX}px`;
          ripple.style.top = `${event.clientY}px`;
          document.documentElement.appendChild(ripple);
          setTimeout(() => ripple.remove(), 600);
        },
        true
      );
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", add);
    } else {
      add();
    }
  });
}

// ---- Acting like a person -----------------------------------------------

function actor(page) {
  let at = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  const pause = (ms) => page.waitForTimeout(ms);
  // Spans of real time left out of the video, such as waiting on the server.
  const cuts = [];
  async function moveTo(x, y) {
    const distance = Math.hypot(x - at.x, y - at.y);
    const steps = Math.max(8, Math.min(40, Math.round(distance / 18)));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      await page.mouse.move(at.x + (x - at.x) * ease, at.y + (y - at.y) * ease);
      await pause(12);
    }
    at = { x, y };
  }
  async function point(locator) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) {
      throw new Error(`Nothing to point at: ${locator}`);
    }
    await moveTo(box.x + box.width / 2, box.y + box.height / 2);
  }
  return {
    page,
    pause,
    moveTo,
    point,
    cuts,
    // Runs a slow wait off camera: the video jumps straight to its result.
    async cut(wait) {
      const from = Date.now() / 1000;
      await wait();
      await pause(300);
      cuts.push([from, Date.now() / 1000]);
    },
    async hover(locator, ms = 600) {
      await point(locator);
      await pause(ms);
    },
    async click(locator, ms = 700) {
      await point(locator);
      await pause(150);
      await page.mouse.down();
      await page.mouse.up();
      await pause(ms);
    },
    async type(text, ms = 600) {
      await page.keyboard.type(text, { delay: 70 });
      await pause(ms);
    }
  };
}

// ---- Filming --------------------------------------------------------------

async function film(page, scene, act, dir) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    const file = path.join(
      dir,
      `f${String(frames.length).padStart(5, "0")}.jpg`
    );
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, at: Date.now() / 1000 });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 92,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height
  });
  const start = Date.now() / 1000;
  const steps = [];
  const seen = [];
  await act.pause(600);
  for (const step of scene.steps) {
    steps.push({ at: Date.now() / 1000, text: step.text });
    await step.run(act);
    await act.pause(step.hold ?? 1400);
    seen.push(await visibleText(cdp));
  }
  const end = Date.now() / 1000;
  await cdp.send("Page.stopScreencast");
  await cdp.detach();
  return { frames, steps, start, end, seen, clock: clock(start, act.cuts) };
}

// Everything laid out inside the part of the page that's kept, and every
// field's value, read natively so nothing on the page can hide it.
async function visibleText(cdp) {
  const { documents, strings } = await cdp.send("DOMSnapshot.captureSnapshot", {
    computedStyles: []
  });
  const texts = [];
  for (const doc of documents) {
    const { layout, nodes } = doc;
    layout.text.forEach((index, i) => {
      const [x, y, width, height] = layout.bounds[i];
      if (index >= 0 && width > 0 && height > 0 && y + height > CROP.top) {
        texts.push(strings[index]);
      }
    });
    (nodes.inputValue?.index || []).forEach((node, i) => {
      texts.push(strings[nodes.inputValue.value[i]]);
    });
  }
  return texts.join("\n");
}

// The Salesforce header, with the user's photo and the org's own search,
// is cut away; the app's navigation bar below it stays.
const CROP = { top: 98 };

// Video time for a moment of real time, with the cut spans taken out.
function clock(start, cuts) {
  return (time) =>
    Math.max(0, time - start) -
    cuts.reduce(
      (total, [from, to]) =>
        total + Math.max(0, Math.min(time, to) - Math.max(from, start)),
      0
    );
}

const FPS = 30;

function encode(frames, start, end, cuts, clock, file, dir) {
  const first = frames.findIndex((frame) => frame.at >= start - 0.05);
  // Inside a cut only the last frame is kept, shown as the cut ends.
  const inside = (at) => cuts.find(([from, to]) => at > from && at < to);
  const kept = frames
    .slice(Math.max(0, first - 1))
    .filter((frame) => frame.at <= end)
    .filter((frame, i, all) => {
      const span = inside(frame.at);
      return !span || !all[i + 1] || inside(all[i + 1].at) !== span;
    })
    .map((frame) => ({ file: frame.file, time: clock(frame.at) }));
  render(kept, clock(end), file, dir);
}

// Screencast frames come whenever the page changes, often milliseconds
// apart; ffmpeg would round those onto its own clock and stretch the video
// out of step with the captions. So each tick of a fixed frame rate shows the
// latest frame by then, as a numbered sequence.
function render(kept, duration, file, dir) {
  const sequence = path.join(dir, "sequence");
  fs.rmSync(sequence, { recursive: true, force: true });
  fs.mkdirSync(sequence);
  let shown = 0;
  for (let tick = 0; tick < Math.round(duration * FPS); tick += 1) {
    while (
      shown + 1 < kept.length &&
      kept[shown + 1].time <= tick / FPS + 0.001
    ) {
      shown += 1;
    }
    fs.symlinkSync(
      kept[shown].file,
      path.join(sequence, `${String(tick).padStart(5, "0")}.jpg`)
    );
  }
  fs.writeFileSync(path.join(dir, "timeline.json"), JSON.stringify(kept));
  const height = VIEWPORT.height - CROP.top;
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      String(FPS),
      "-i",
      path.join(sequence, "%05d.jpg"),
      "-vf",
      `crop=${VIEWPORT.width}:${height - (height % 2)}:0:${CROP.top},format=yuv420p`,
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "27",
      "-movflags",
      "+faststart",
      "-an",
      file
    ],
    { stdio: "inherit" }
  );
}

// ---- The catalog the app reads -------------------------------------------

function readCatalog() {
  const text = fs.existsSync(CATALOG) ? fs.readFileSync(CATALOG, "utf8") : "";
  const found = text.match(/const TOPICS = (\{[\s\S]*\});\n/);
  // The file is ours but Prettier may have reformatted it, so it's read as JS.
  return found
    ? new Function(
        `return (${found[1].replace(/("?video"?): \w+/g, "$1: null")});`
      )()
    : {};
}

function writeCatalog(topics) {
  const keys = SCENES.map((scene) => scene.topic).filter((key) => topics[key]);
  const imports = keys.map(
    (key) =>
      `import ${resourceVar(key)} from "@salesforce/resourceUrl/${resourceName(key)}";`
  );
  const body = JSON.stringify(
    Object.fromEntries(
      keys.map((key) => [key, { ...topics[key], video: `@@${key}@@` }])
    ),
    null,
    2
  ).replace(/"@@([\w-]+)@@"/g, (match, key) => resourceVar(key));
  fs.writeFileSync(
    CATALOG,
    [
      "// Written by test/e2e/record-help.js from test/e2e/help-scenes.js. Captions",
      "// can be corrected here; recording a topic again rewrites its entry.",
      "// at: seconds into the video where each step starts.",
      ...imports,
      "",
      `const TOPICS = ${body};`,
      "",
      "export default TOPICS;",
      ""
    ].join("\n")
  );
  execFileSync("npx", ["prettier", "--write", CATALOG], { stdio: "ignore" });
}

const resourceName = (key) =>
  `Help_${key.replace(/(^|-)(\w)/g, (m, dash, letter) => letter.toUpperCase())}`;
const resourceVar = (key) =>
  key.replace(/-(\w)/g, (m, letter) => letter.toUpperCase()) + "Video";

function writeResource(key, video) {
  const name = resourceName(key);
  fs.mkdirSync(RESOURCES, { recursive: true });
  fs.copyFileSync(video, path.join(RESOURCES, `${name}.resource`));
  fs.writeFileSync(
    path.join(RESOURCES, `${name}.resource-meta.xml`),
    `<?xml version="1.0" encoding="UTF-8" ?>
<StaticResource xmlns="http://soap.sforce.com/2006/04/metadata">
    <cacheControl>Public</cacheControl>
    <contentType>video/mp4</contentType>
    <description>Help video: ${SCENES.find((s) => s.topic === key).title}</description>
</StaticResource>
`
  );
}

// ---- Running ---------------------------------------------------------------

async function main() {
  const scenes = only.length
    ? only.map((key) => {
        const scene = SCENES.find((s) => s.topic === key);
        if (!scene) {
          throw new Error(`No scene called ${key}`);
        }
        return scene;
      })
    : SCENES;
  const { rules, banned } = synthetic();
  const { browser, page } = await open(`/lightning/app/${NS}Flow_Compare`, {
    viewport: VIEWPORT,
    prepare: (context) => prepare(context, rules)
  });
  const topics = readCatalog();
  let failed = 0;
  try {
    await page.waitForTimeout(8000);
    for (const scene of scenes) {
      const dir = path.join(WORK, scene.topic);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const act = actor(page);
      try {
        await scene.setup?.({ ORG, NS, sf, rest, page, act });
        const { frames, steps, start, end, seen, clock } = await film(
          page,
          scene,
          act,
          dir
        );
        const leaks = banned.filter((word) =>
          seen.some((text) => new RegExp(`\\b${escape(word)}`, "i").test(text))
        );
        if (leaks.length && process.env.HELP_DEBUG) {
          const all = seen.join("\n");
          for (const word of leaks) {
            const at = all.toLowerCase().indexOf(word);
            console.log(
              `  ${word}: …${all.slice(Math.max(0, at - 60), at + 60).replace(/\n/g, " | ")}…`
            );
          }
        }
        if (leaks.length) {
          throw new Error(
            `Real details were on screen (${leaks.length} kinds); the video was thrown away`
          );
        }
        const video = path.join(dir, `${scene.topic}.mp4`);
        encode(frames, start, end, act.cuts, clock, video, dir);
        writeResource(scene.topic, video);
        topics[scene.topic] = {
          title: scene.title,
          action: scene.action,
          duration: Number(clock(end).toFixed(1)),
          steps: steps.map((step) => ({
            at: Number(Math.max(0, clock(step.at) - 0.3).toFixed(1)),
            text: step.text
          }))
        };
        writeCatalog(topics);
        const size = fs.statSync(video).size;
        console.log(
          `${scene.topic}: ${topics[scene.topic].duration}s, ${(size / 1024).toFixed(0)} KB, ${steps.length} steps`
        );
      } catch (error) {
        failed += 1;
        console.log(`${scene.topic}: ${error.message.split("\n")[0]}`);
        await page
          .screenshot({ path: path.join(dir, "failed.png") })
          .catch(() => {});
      } finally {
        await scene.cleanup?.({ ORG, NS, sf, rest, page }).catch((error) => {
          failed += 1;
          console.log(`${scene.topic} cleanup: ${error.message}`);
        });
        if (!KEEP) {
          for (const file of fs.readdirSync(dir)) {
            if (file.endsWith(".jpg") || file === "frames.txt") {
              fs.rmSync(path.join(dir, file));
            }
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  if (failed) {
    console.log(`${failed} topic(s) failed`);
    process.exit(1);
  }
}

// Other recordings (the trailer's shoot, say) reuse the safeguards.
module.exports = { synthetic, prepare, actor, visibleText, FILMED, CROP };

if (require.main === module) {
  main().catch((error) => {
    console.log(error.message.split("\n")[0]);
    process.exit(1);
  });
}
