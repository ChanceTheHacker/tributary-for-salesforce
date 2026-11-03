// Times what a reviewer does on the large three-way merge: switching tabs,
// stepping through changes, selecting on the canvas and picking a side. Each
// time runs from the click to the second frame after it, so it includes the
// render and paint the click caused. Read-only: picks are never saved.
//   node perf-interact.js [--repeat=3]
const { open, ORG, NS, DISCOUNTS } = require("./session");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split("=")[1] : fallback;
};
const repeat = Number(option("repeat", 3));
const url = `${ORG}/lightning/n/${NS}Flow_Compare?c__flow=UAT_Discounts_A&c__va=${DISCOUNTS.ours}&c__vb=${DISCOUNTS.theirs}&c__base=${DISCOUNTS.base}&c__tab=merge`;

// Clicks and waits two frames; returns the time and the main-thread time
// taken by long tasks meanwhile.
async function timeClick(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate(async (element) => {
    const before = (window.__longTasks || []).length;
    const start = performance.now();
    element.click();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
    const ms = performance.now() - start;
    const tasks = (window.__longTasks || []).slice(before);
    return { ms, blocked: tasks.reduce((sum, t) => sum + t, 0) };
  });
}

const stats = {};
function record(name, result) {
  (stats[name] = stats[name] || []).push(result);
}

(async () => {
  const { browser, page } = await open(
    `/lightning/n/${NS}Flow_Compare`,
    {
      prepare: (ctx) =>
        ctx.addInitScript(() => {
          window.__longTasks = [];
          try {
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                window.__longTasks.push(entry.duration);
              }
            }).observe({ type: "longtask", buffered: true });
          } catch (error) {
            // No long-task timing here.
          }
        })
    }
  );
  await page.waitForTimeout(6000);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector("c-flow-merge-view c-flow-canvas .node", {
    timeout: 60000
  });
  await page.waitForTimeout(3000);
  const tab = (name) =>
    page.locator(`button[role="tab"][data-tab="${name}"]`);
  const nodes = page.locator("c-flow-merge-view c-flow-canvas .node");
  const nodeCount = await nodes.count();
  console.log(`merge canvas has ${nodeCount} nodes`);

  for (let run = 0; run < repeat; run++) {
    for (const name of ["compare", "activate", "merge"]) {
      if (await tab(name).count()) {
        record(`tab → ${name}`, await timeClick(page, tab(name)));
        await page.waitForTimeout(1500);
      }
    }
    await page.waitForSelector("c-flow-merge-view c-flow-canvas .node");
    const next = page
      .locator("c-flow-merge-view .stepper lightning-button-icon button")
      .nth(1);
    for (let i = 0; i < 3; i++) {
      record("next change", await timeClick(page, next));
      await page.waitForTimeout(700);
    }
    for (const index of [3, Math.floor(nodeCount / 2), nodeCount - 2]) {
      record("select node", await timeClick(page, nodes.nth(index)));
      await page.waitForTimeout(700);
    }
    // Close the element panel so the change list shows, then pick the other
    // side on the first change row and undo it.
    const close = page.locator('c-flow-element-panel button[title="Close"]');
    if (await close.count()) {
      record("close panel", await timeClick(page, close.first()));
      await page.waitForTimeout(700);
    }
    const row = page.locator("c-flow-merge-view .row-pick[data-unit]").first();
    if (await row.count()) {
      const choices = row.locator("label");
      const n = await choices.count();
      if (n > 1) {
        record("pick side", await timeClick(page, choices.nth(n - 1)));
        await page.waitForTimeout(700);
        const undo = page.locator("c-flow-merge-view .undo button");
        if (await undo.isEnabled()) {
          record("undo", await timeClick(page, undo));
          await page.waitForTimeout(700);
        }
      }
    }
  }
  for (const [name, list] of Object.entries(stats)) {
    const ms = list.map((r) => Math.round(r.ms));
    const blocked = list.map((r) => Math.round(r.blocked));
    console.log(
      `${name.padEnd(16)} ms ${ms.join(", ")}   long-task ms ${blocked.join(", ")}`
    );
  }
  await browser.close();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
