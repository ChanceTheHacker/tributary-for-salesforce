// The merge view on a made-up flow of 300 elements (fixtures/synthetic):
// however an element is reached (the change list, the stepper, arrow keys
// on the canvas or finding it by name), the canvas and the side panel show
// the same one. PERF=1 prints how long each step took.
import { createElement } from "lwc";
import FlowMergeView from "c/flowMergeView";
import { large, revise } from "fixtures/synthetic";

jest.mock(
  "@salesforce/apex/FlowCompareController.saveVersion",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareController.saveAsNewFlow",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.getFlowStatus",
  () => ({ default: jest.fn(() => Promise.resolve({ pending: [] })) }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.requestActivation",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.activateVersion",
  () => ({ default: jest.fn() }),
  { virtual: true }
);

const SIZE = 300;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const $ = (root, selector) => root.shadowRoot.querySelector(selector);
const $$ = (root, selector) => [...root.shadowRoot.querySelectorAll(selector)];

const timings = [];
async function timed(label, fn) {
  const start = performance.now();
  await fn();
  await flush();
  timings.push([label, Math.round(performance.now() - start)]);
}

afterAll(() => {
  if (process.env.PERF) {
    console.log(timings.map((row) => row.join("\t")).join("\n"));
  }
});

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
});

describe(`the merge view on a flow of ${SIZE} elements`, () => {
  let element;
  let canvas;
  // What the canvas and the side panel each say is selected.
  const shown = () => {
    const panel = $(element, "c-flow-element-panel");
    const node = canvas.scene.nodes.find(
      (item) => item.id === canvas.selectedId
    );
    return {
      canvas: node && node.key,
      panel: panel ? panel.entry.key : undefined
    };
  };
  const tile = (key) => {
    const node = canvas.scene.nodes.find((item) => item.key === key);
    return [...canvas.shadowRoot.querySelectorAll(".node")].find(
      (item) => item.dataset.id === node.id
    );
  };

  beforeEach(async () => {
    const base = large(SIZE);
    await timed("mount (3-way)", () => {
      element = createElement("c-flow-merge-view", { is: FlowMergeView });
      element.labels = { base: "Base", ours: "Ours", theirs: "Theirs" };
      element.sides = {
        base,
        ours: revise(base, { every: 10, offset: 0, move: 40 }),
        theirs: revise(base, { every: 10, offset: 5, move: 80 })
      };
      document.body.appendChild(element);
    });
    canvas = $(element, "c-flow-canvas");
  });

  it("lists what changed, not what only moved", async () => {
    expect(canvas.scene.nodes).toHaveLength(SIZE + 1);
    const revised = canvas.scene.nodes.filter((node) =>
      String(node.label).endsWith("(revised)")
    );
    // Every element moved; only the revised ones are differences, each
    // with its label and what it assigns. They're listed 50 at a time.
    const rows = $$(element, ".row-title");
    expect(rows).toHaveLength(50);
    expect($(element, ".page-text").textContent).toBe(
      `Differences 1–50 of ${revised.length * 2}`
    );
    expect($(element, ".page-previous").disabled).toBe(true);
    await timed("next page", () => $(element, ".page-next").click());
    rows.push(...$$(element, ".row-title"));
    expect($(element, ".page-next").disabled).toBe(true);
    expect(rows.map((row) => row.dataset.kind)).not.toContain("pos");
    expect([...new Set(rows.map((row) => row.dataset.target))].sort()).toEqual(
      revised.map((node) => node.key).sort()
    );
    expect(rows).toHaveLength(revised.length * 2);
    const tab = $$(element, ".tab").find((item) =>
      item.textContent.startsWith("Differences")
    );
    expect(tab.textContent).toBe(`Differences (${rows.length})`);
  });

  it("keeps the change list, stepper, keyboard, find and panel together", async () => {
    // The change list.
    const rows = $$(element, ".row-title");
    const changed = canvas.scene.nodes.filter((node) =>
      String(node.label).endsWith("(revised)")
    ).length;
    const [row] = rows;
    await timed("open from the list", () => row.click());
    expect(shown()).toEqual({
      canvas: row.dataset.target,
      panel: row.dataset.target
    });

    // The stepper goes on to the next change, on both.
    const first = shown().panel;
    const next = $$(element, ".stepper lightning-button-icon").pop();
    await timed("step to the next change", () => next.click());
    const second = shown();
    expect(second.canvas).toBe(second.panel);
    expect(second.panel).not.toBe(first);
    expect($(element, ".position").textContent).toBe(
      `Changed item 2 of ${changed}`
    );

    // Arrow keys on the canvas follow the connector down; Enter selects.
    tile("S0000").focus();
    await timed("arrow down", () =>
      tile("S0000").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      )
    );
    expect(canvas.shadowRoot.activeElement).toBe(tile("D0001"));
    await timed("select with Enter", () =>
      tile("D0001").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      )
    );
    expect(shown()).toEqual({ canvas: "D0001", panel: "D0001" });

    // Find, by name: each match in turn, top to bottom.
    await timed("open find", () =>
      $(canvas, ".frame").dispatchEvent(
        new KeyboardEvent("keydown", { key: "/", bubbles: true })
      )
    );
    const input = $(canvas, ".find-input");
    expect(input).not.toBeNull();
    input.value = "J0005";
    await timed("type in find", () =>
      input.dispatchEvent(new CustomEvent("input"))
    );
    // Shown first; selected when asked.
    expect($(canvas, ".find-count").textContent).toBe("1 of 1");
    expect(shown()).toEqual({ canvas: "D0001", panel: "D0001" });
    await timed("go to the match", () => $(canvas, ".find-next").click());
    expect(shown()).toEqual({ canvas: "J0005", panel: "J0005" });
    expect($(canvas, ".find-count").textContent).toBe("1 of 1");

    input.value = "revised";
    await timed("find many", () =>
      input.dispatchEvent(new CustomEvent("input"))
    );
    const revised = canvas.scene.nodes
      .filter((node) => String(node.label).endsWith("(revised)"))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    expect($(canvas, ".find-count").textContent).toBe(`1 of ${revised.length}`);
    await timed("next match", () => $(canvas, ".find-next").click());
    expect(shown()).toEqual({ canvas: revised[0].key, panel: revised[0].key });
    await timed("next match", () => $(canvas, ".find-next").click());
    expect(shown()).toEqual({ canvas: revised[1].key, panel: revised[1].key });
    expect($(canvas, ".find-count").textContent).toBe(`2 of ${revised.length}`);
    await timed("previous match", () => $(canvas, ".find-previous").click());
    expect(shown()).toEqual({ canvas: revised[0].key, panel: revised[0].key });
    await timed("previous match", () => $(canvas, ".find-previous").click());
    const last = revised[revised.length - 1].key;
    expect(shown()).toEqual({ canvas: last, panel: last });

    // Closing the panel leaves nothing selected on the canvas either.
    await timed("close the panel", () =>
      $(element, "c-flow-element-panel").dispatchEvent(new CustomEvent("close"))
    );
    expect(shown()).toEqual({ canvas: undefined, panel: undefined });
  });

  it("takes a side for one change and undoes it", async () => {
    const revised = () =>
      canvas.scene.nodes
        .filter((node) => String(node.label).endsWith("(revised)"))
        .map((node) => node.key);
    const before = revised();
    expect(before).toContain("S0000");
    const pick = $$(element, ".row-pick").find(
      (item) => item.dataset.unit === "field|S0000|label"
    );
    await timed("pick a side for a row", () =>
      pick.dispatchEvent(
        new CustomEvent("change", { detail: { value: "base" } })
      )
    );
    expect(revised()).toEqual(before.filter((key) => key !== "S0000"));
    await timed("undo", () => $(element, ".undo").click());
    expect(revised()).toEqual(before);
    await timed("redo", () => $(element, ".redo").click());
    expect(revised()).not.toContain("S0000");
  });

  it("pages the differences, keeping picks and stepping to the right page", async () => {
    const base = large(SIZE);
    const theirs = revise(base, { every: 10, offset: 5, move: 80 });
    theirs.description = "Changed in theirs";
    element.sides = {
      base,
      ours: revise(base, { every: 10, offset: 0, move: 40 }),
      theirs
    };
    await flush();
    const unitPick = (id) =>
      $$(element, ".row-pick").find((item) => item.dataset.unit === id);
    unitPick("field|S0000|label").dispatchEvent(
      new CustomEvent("change", { detail: { value: "base" } })
    );
    await flush();
    $(element, ".page-next").click();
    await flush();
    expect(unitPick("field|S0000|label")).toBeUndefined();
    expect($(element, ".page-text").textContent).toMatch(/^Differences 51–/);
    $(element, ".page-previous").click();
    await flush();
    // The pick outlives its row leaving the page.
    expect(unitPick("field|S0000|label").value).toBe("base");
    expect($(element, ".page-text").textContent).toMatch(/^Differences 1–50/);

    // The flow property is the last step, and listed on the last page.
    const [previous] = $$(element, ".stepper lightning-button-icon");
    previous.click();
    await flush();
    const current = $(element, ".row-current");
    expect(current).not.toBeNull();
    expect(current.dataset.unit).toBe("prop|description");
    expect($(element, ".page-text").textContent).toMatch(/^Differences 51–/);
    expect($(element, ".position").textContent).toMatch(/^Changed item \d+ of/);
  });
});
