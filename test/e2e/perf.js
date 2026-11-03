// Times the app's pages in a real org: how long each takes to be usable, every
// Apex call it made (time and response size), and the browser's own busy time.
// Read-only. Never logs URLs.
//   node perf.js [name...] [--runs=2] [--json=file]
const fs = require("fs");
const { open, ORG, NS, DISCOUNTS } = require("./session");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split("=")[1] : fallback;
};
const only = args.filter((arg) => !arg.startsWith("--"));
const runs = Number(option("runs", 2));
const jsonOut = option("json", "");

const compare = (query) => `${ORG}/lightning/n/${NS}Flow_Compare?${query}`;
const DEMO = "c__flow=Flow_Compare_Demo";
const LARGE = `c__flow=UAT_Discounts_A&c__va=${DISCOUNTS.ours}&c__vb=${DISCOUNTS.theirs}&c__base=${DISCOUNTS.base}`;
const CROSS =
  "c__mode=flows&c__flow=UAT_Case_Triage_Record&c__flowB=UAT_Case_Triage_Sub";

// A page is usable once its loading state is gone and `ready` is on screen.
// The page's own component carries the org's namespace in its tag name, so
// `ready` names what it renders rather than its tag.
const canvasReady = "c-flow-canvas .node";
const scenarios = [
  ["compare-empty", compare(""), "c-flow-picker"],
  ["compare-demo", compare(`${DEMO}&c__va=1&c__vb=3`), canvasReady],
  ["compare-large", compare(LARGE), canvasReady],
  ["merge-large", compare(`${LARGE}&c__tab=merge`), canvasReady],
  ["merge-cross", compare(`${CROSS}&c__tab=merge`), canvasReady],
  ["governed", `${ORG}/lightning/n/${NS}Governed_Flows`, "table tbody tr"],
  ["approvals", `${ORG}/lightning/n/${NS}Flow_Approvals`, "h2.request-title, .empty-text"],
  ["setup", `${ORG}/lightning/n/${NS}Flow_Compare_Setup`, "section.card"]
];

// Every Apex action in an Aura request, named Class.method.
function actionsOf(body) {
  try {
    const message = new URLSearchParams(body).get("message");
    return JSON.parse(message).actions.map((action) => {
      const params = action.params || {};
      return params.classname
        ? `${params.classname}.${params.method}`
        : action.descriptor.replace(/^.*ACTION\$/, "");
    });
  } catch (error) {
    return [];
  }
}

async function measure(page, cdp, url, ready) {
  const calls = [];
  const pending = new Map();
  const onRequest = (request) => {
    if (!request.url().includes("/aura?")) return;
    const names = actionsOf(request.postData() || "");
    if (names.some((name) => /Flow|Governance|Setup/.test(name))) {
      pending.set(request, { names, start: Date.now() });
    }
  };
  const onFinished = async (request) => {
    const entry = pending.get(request);
    if (!entry) return;
    pending.delete(request);
    let bytes = 0;
    try {
      bytes = (await (await request.response()).body()).length;
    } catch (error) {
      bytes = -1;
    }
    calls.push({
      actions: entry.names.join(" + "),
      ms: Date.now() - entry.start,
      kb: Math.round(bytes / 1024)
    });
  };
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  const before = await metrics(cdp);
  const start = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  let usable = null;
  try {
    await page.waitForSelector(ready, { timeout: 60000 });
    // Playwright's selectors see inside components; document's do not.
    await page
      .locator('div.loading[role="status"]')
      .first()
      .waitFor({ state: "detached", timeout: 60000 });
    usable = Date.now() - start;
  } catch (error) {
    usable = -1;
  }
  // Let late calls and renders finish before reading the counters.
  await page.waitForTimeout(2500);
  const after = await metrics(cdp);
  const longTasks = await page.evaluate(() => {
    const tasks = window.__longTasks || [];
    return {
      count: tasks.length,
      total: Math.round(tasks.reduce((sum, t) => sum + t, 0)),
      worst: Math.round(Math.max(0, ...tasks))
    };
  });
  const nodes = await page.evaluate(
    () => document.querySelectorAll("*").length
  );
  page.off("request", onRequest);
  page.off("requestfinished", onFinished);
  // A full navigation starts the counters again, so a smaller value after it
  // is already this page's own total.
  const delta = (key) =>
    Math.round(
      (after[key] >= before[key] ? after[key] - before[key] : after[key]) * 1000
    );
  return {
    usable,
    script: delta("ScriptDuration"),
    layout: delta("LayoutDuration"),
    style: delta("RecalcStyleDuration"),
    task: delta("TaskDuration"),
    heapMb: Math.round(after.JSHeapUsedSize / 1048576),
    domNodes: nodes,
    longTasks,
    calls
  };
}

async function metrics(cdp) {
  const { metrics: list } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

(async () => {
  const { browser, context, page } = await open(
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
            // No long-task timing in this browser.
          }
        })
    }
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  // Warm Lightning's own caches once so every page is measured the same way.
  await page.waitForTimeout(8000);
  const results = {};
  for (const [name, url, ready] of scenarios) {
    if (only.length && !only.includes(name)) continue;
    results[name] = [];
    for (let run = 0; run < runs; run++) {
      const result = await measure(page, cdp, url, ready);
      results[name].push(result);
      const calls = result.calls
        .map((c) => `${c.actions} ${c.ms}ms ${c.kb}KB`)
        .join("; ");
      console.log(
        `${name} #${run + 1}: usable ${result.usable}ms, script ${result.script}ms, ` +
          `layout ${result.layout}ms, style ${result.style}ms, long tasks ${result.longTasks.count} ` +
          `(${result.longTasks.total}ms, worst ${result.longTasks.worst}ms), DOM ${result.domNodes}, ` +
          `heap ${result.heapMb}MB\n  calls: ${calls || "none"}`
      );
    }
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
