// Shared headless browser session for the test org. The login link is never printed.
// E2E_ORG picks the org by its sf alias (tributary-dev unless set). Everything
// deployed there takes the org's namespace, so pages and fields are prefixed NS.
// discounts names the UAT_Discounts_A versions seed-flows.js made in each org.
// other is the org's second Flow Connection, for the two-org checks.
const { chromium } = require("playwright-core");
const { execFileSync } = require("child_process");
const ORGS = {
  "tributary-dev": {
    ns: "cllc",
    discounts: { base: 6, ours: 7, theirs: 8 },
    // Added by hand when needed; see docs/setup.md §4.
    other: { name: "Loopback", label: "Loopback" }
  },
  "trib-ns": {
    ns: "trib",
    discounts: { base: 1, ours: 2, theirs: 3 },
    // Reaches tributary-dev.
    other: { name: "Dev_Org", label: "Dev org" }
  }
};
const ALIAS = process.env.E2E_ORG || "tributary-dev";
if (!ORGS[ALIAS]) {
  throw new Error(`E2E_ORG must be one of ${Object.keys(ORGS).join(", ")}`);
}
// The org's My Domain, as the CLI knows it. sf may print a warning before the JSON.
function instanceUrl() {
  const out = execFileSync(
    "sf",
    ["org", "display", "--target-org", ALIAS, "--json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  return JSON.parse(out.slice(out.indexOf("{"))).result.instanceUrl;
}
const ORG = instanceUrl();
const NS = `${ORGS[ALIAS].ns}__`;
const DISCOUNTS = ORGS[ALIAS].discounts;
const OTHER = ORGS[ALIAS].other;
// Set CHROMIUM_PATH if Chromium isn't at /usr/bin/chromium.
const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
async function open(retURL, opts = {}) {
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true
  });
  const context = await browser.newContext({
    viewport: opts.viewport || { width: 1600, height: 1000 },
    deviceScaleFactor: opts.scale || 1
  });
  // Routes and scripts a caller needs in place before the first page loads.
  if (opts.prepare) {
    await opts.prepare(context);
  }
  const page = await context.newPage();
  // A one-time login link from the CLI; it is never printed.
  const out = execFileSync(
    "sf",
    [
      "org",
      "open",
      "--target-org",
      ALIAS,
      "--path",
      retURL,
      "--url-only",
      "--json"
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  const url = JSON.parse(out.slice(out.indexOf("{"))).result.url;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  return { browser, context, page };
}
// Screenshots land here (git-ignored).
const OUT = require("path").join(__dirname, "out");
require("fs").mkdirSync(OUT, { recursive: true });
module.exports = { open, ALIAS, ORG, NS, DISCOUNTS, OTHER, OUT, CHROMIUM };
