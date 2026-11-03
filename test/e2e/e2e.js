// Visits each Tributary page and saves a screenshot. Never logs URLs.
// Exits non-zero when a page fails to load or logs an error.
const { open, ORG, NS, OTHER, OUT } = require("./session");
const pages = [
  ["setup", `/lightning/n/${NS}Flow_Compare_Setup`],
  [
    "compare",
    `/lightning/n/${NS}Flow_Compare?c__flow=Case_Email_Routing&c__va=3&c__vb=4`
  ],
  [
    "merge",
    `/lightning/n/${NS}Flow_Compare?c__flow=Case_Email_Routing&c__va=3&c__vb=4&c__base=2&c__tab=merge`
  ],
  [
    "activate",
    `/lightning/n/${NS}Flow_Compare?c__flow=Case_Email_Routing&c__va=3&c__vb=4&c__tab=activate`
  ],
  ["governed", `/lightning/n/${NS}Governed_Flows`],
  ["approvals", `/lightning/n/${NS}Flow_Approvals`],
  [
    "demo-compare",
    `/lightning/n/${NS}Flow_Compare?c__flow=Flow_Compare_Demo&c__va=1&c__vb=3`
  ],
  [
    "demo-text",
    `/lightning/n/${NS}Flow_Compare?c__flow=Flow_Compare_Demo&c__va=1&c__vb=3`,
    "XML"
  ],
  [
    "orgs",
    `/lightning/n/${NS}Flow_Compare?c__mode=orgs&c__connB=${OTHER.name}&c__flow=Flow_Compare_Demo&c__va=5&c__vb=2`
  ],
  [
    "flows",
    `/lightning/n/${NS}Flow_Compare?c__mode=flows&c__flow=Flow_Compare_Demo&c__flowB=lead_automation_test`
  ],
  [
    "demo-merge",
    `/lightning/n/${NS}Flow_Compare?c__flow=Flow_Compare_Demo&c__va=3&c__vb=4&c__base=2&c__tab=merge`
  ]
];
(async () => {
  const only = process.argv.slice(2);
  const { browser, page } = await open(`/lightning/n/${NS}Flow_Compare_Setup`);
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text().slice(0, 200));
  });
  page.on("pageerror", (err) => errors.push(String(err).slice(0, 200)));
  await page.waitForTimeout(8000);
  const failed = [];
  for (const [name, path, view] of pages) {
    if (only.length && !only.includes(name)) continue;
    errors.length = 0;
    try {
      await page.goto(ORG + path, {
        waitUntil: "domcontentloaded",
        timeout: 90000
      });
      await page.waitForTimeout(12000);
      if (view) {
        // The diff view mode isn't in the URL, so pick it the way a user would.
        await page.getByText(view, { exact: true }).first().click();
        await page.waitForTimeout(3000);
      }
    } catch (e) {
      errors.push(String(e).split("\n")[0].slice(0, 200));
    }
    await page.screenshot({ path: `${OUT}/${name}.png` });
    const text = await page.evaluate(() => document.title);
    const shown = errors.filter((e) => !/sid|frontdoor/i.test(e));
    if (errors.length) {
      failed.push(name);
    }
    console.log(name, "|", text, "|", shown.slice(0, 3).join(" || "));
  }
  await browser.close();
  if (failed.length) {
    console.log(`Errors on: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error(
    String(e)
      .replace(/(sid|otp|token)=[^&\s]+/g, "$1=…")
      .slice(0, 400)
  );
  process.exit(1);
});
