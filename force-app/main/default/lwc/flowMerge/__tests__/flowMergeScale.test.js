// Flows of hundreds of elements, all made up (fixtures/synthetic): what the
// merge, diff, mapping and layout make of them, and how long each takes.
// The time limits are loose, to catch work that grows with the square of a
// flow's size rather than a slow machine. PERF=1 prints the timings; the
// numbers in docs/performance.md come from it.
import {
  createMerge,
  resolveMerge,
  placePlan,
  insertPicks,
  groupPicks,
  unitsForNode,
  wireId,
  validateFlow,
  CONFLICT,
  SAME
} from "c/flowMerge";
import { planMapping, suggestedChoices, translateFlow } from "c/flowMapping";
import { buildModel } from "c/flowModel";
import { diffFlows } from "c/flowDiff";
import { mergeScene, diffScene } from "c/flowScene";
import { large, revise } from "fixtures/synthetic";

const SIZES = [100, 300, 600];
// Milliseconds, for the largest flow.
const LIMIT = 500;

// The middle of three runs, after one to warm up.
function timed(fn) {
  let result = fn();
  const runs = [];
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    result = fn();
    runs.push(performance.now() - start);
  }
  runs.sort((a, b) => a - b);
  return { result, ms: Math.round(runs[1] * 10) / 10 };
}

const report = [];
afterAll(() => {
  if (process.env.PERF) {
    console.log(report.map((row) => row.join("\t")).join("\n"));
  }
});

// The elements of blocks from..to of a large() flow: a step; a decision,
// its three arms and their join; a loop and its body; an update and its
// fault handler, in turn.
function blockKeys(from, to) {
  const keys = [];
  for (let index = from; index <= to; index++) {
    const id = String(index).padStart(4, "0");
    keys.push(
      ...[
        [`S${id}`],
        [`D${id}`, `D${id}a`, `D${id}b`, `D${id}c`, `J${id}`],
        [`L${id}`, `L${id}b`],
        [`U${id}`, `U${id}h`]
      ][index % 4]
    );
  }
  return keys;
}

// Base, and two revisions that each change a tenth of its assignments
// (different ones) and move every element sideways by different amounts.
function sides(size) {
  const base = large(size);
  return {
    base,
    ours: revise(base, { every: 10, offset: 0, move: 40 }),
    theirs: revise(base, { every: 10, offset: 5, move: 80 })
  };
}

describe.each(SIZES)("a flow of %i elements", (size) => {
  const { base, ours, theirs } = sides(size);
  const model = buildModel(base);
  const time = (label, fn) => {
    const { result, ms } = timed(fn);
    report.push([size, label, ms]);
    if (size === SIZES[SIZES.length - 1]) {
      expect(ms).toBeLessThan(LIMIT);
    }
    return result;
  };

  it("is the size it says", () => {
    const elements = [...model.nodes.values()].filter(
      (node) => node.type !== "start"
    );
    expect(elements).toHaveLength(size);
    // Branches, loops and fault paths, not just a line.
    const kinds = new Set([...model.edges.values()].map((edge) => edge.kind));
    expect([...kinds]).toEqual(
      expect.arrayContaining([
        "outcome",
        "default",
        "loopNext",
        "loopEnd",
        "fault"
      ])
    );
    expect(validateFlow(model).filter((issue) => issue.severity)).toEqual([]);
    report.push([
      size,
      "nodes/edges/resources",
      `${model.nodes.size}/${model.edges.size}/${model.resources.size}`
    ]);
  });

  it("merges three versions, stopping only where both changed a thing", () => {
    const merge = time("createMerge (3-way)", () =>
      createMerge({ base, ours, theirs })
    );
    report.push([size, "units", merge.units.size]);
    const units = [...merge.units.values()];
    // Each side changed different steps; both moved every element.
    expect(units.filter((unit) => unit.status === CONFLICT)).toEqual([]);
    expect(
      units.filter((unit) => unit.kind === "pos" && unit.status !== SAME)
    ).toHaveLength(size);
    const resolved = time("resolveMerge (3-way)", () =>
      resolveMerge(merge, {})
    );
    expect(resolved.errors).toBe(0);
    expect(resolved.conflicts).toEqual([]);
    const revised = (flow) =>
      flow.assignments.filter((item) => item.label.endsWith("(revised)"))
        .length;
    const labels = [...resolved.model.nodes.values()].filter((node) =>
      String(node.fields.label).endsWith("(revised)")
    );
    expect(labels).toHaveLength(revised(ours) + revised(theirs));
    const { scene } = time("mergeScene (3-way)", () =>
      mergeScene(merge, resolved)
    );
    expect(scene.nodes).toHaveLength(model.nodes.size);
  });

  it("never calls moving an element a change", () => {
    // The same flow with every element shifted, and nothing else.
    const moved = revise(base, { offset: -1, move: 120 });
    const diff = time("diffFlows (moved only)", () => diffFlows(base, moved));
    expect(diff.layoutOnly).toBe(true);
    expect(diff.summary.nodes.changed).toBe(0);
    expect(diff.summary.nodes.moved).toBe(size);
    const view = diffScene(diff, "after");
    expect(view.nodes.filter((node) => node.status !== "unchanged")).toEqual(
      []
    );

    // Merged, the move is there to take but isn't a difference to review.
    const merge = createMerge({ before: base, after: moved });
    const changed = [...merge.units.values()].filter(
      (unit) => unit.status !== SAME
    );
    expect(changed.length).toBe(size);
    expect(changed.every((unit) => unit.kind === "pos")).toBe(true);
    const resolved = resolveMerge(merge, {});
    const { diff: result } = mergeScene(merge, resolved);
    expect(result.summary.nodes.changed).toBe(0);
    expect(result.summary.nodes.added + result.summary.nodes.removed).toBe(0);
  });

  it("diffs two versions", () => {
    const diff = time("diffFlows", () => diffFlows(base, ours));
    const changed = diff.nodes.filter((entry) => entry.status === "changed");
    expect(changed).toHaveLength(Math.ceil(base.assignments.length / 10));
    const view = time("diffScene", () => diffScene(diff, "after"));
    expect(view.nodes).toHaveLength(model.nodes.size);
  });

  it("finds an element's parts at once, however many there are", () => {
    const merge = createMerge({ before: base, after: ours });
    const keys = [...model.nodes.keys()];
    const all = time("unitsForNode (every element)", () =>
      keys.map((key) => unitsForNode(merge, key))
    );
    const expected = (key) =>
      [...merge.units.values()].filter(
        (unit) => unit.nodeKey === key && unit.kind !== "follows"
      );
    for (const key of keys.slice(0, 40)) {
      expect(all[keys.indexOf(key)]).toEqual(expected(key));
    }
    // A copy: changing it changes nothing.
    unitsForNode(merge, keys[1]).length = 0;
    expect(unitsForNode(merge, keys[1])).toEqual(expected(keys[1]));
  });

  it("shows where a group of twenty goes before it's put there", () => {
    const merge = createMerge({ before: base, after: ours });
    const resolved = resolveMerge(merge, {});
    // Eight blocks from the fifth on, moved up to follow the first step.
    const keys = blockKeys(4, 11);
    expect(keys).toHaveLength(20);
    const at = ["S0000", "connector"];
    const preview = time("placePlan (20 elements)", () =>
      placePlan(merge, resolved, keys, "after", ...at, {})
    );
    expect(preview.entry).toBe("S0004");
    expect(preview.next).toBe("D0001");
    // Where its two ends go is asked; going on to D0001 would loop back
    // round to it, which the preview says.
    expect(preview.open).toBe(2);
    expect(preview.cycles).toHaveLength(1);
    expect(preview.cycles[0]).toEqual(
      expect.arrayContaining(["S0004", "D0001"])
    );

    const routes = {
      [wireId("U0011", "connector")]: "S0012",
      [wireId("U0011h", "connector")]: "S0012"
    };
    const plan = placePlan(merge, resolved, keys, "after", ...at, { routes });
    expect(plan.open).toBe(0);
    expect(plan.cycles).toEqual([]);
    // What it now skips over is named before it's done.
    expect([...plan.stranded].sort()).toEqual(blockKeys(1, 3).sort());
    const after = resolveMerge(merge, plan.picks);
    expect(after.errors).toBe(0);
    for (const edge of after.model.edges.values()) {
      expect(after.model.nodes.has(edge.target)).toBe(true);
    }
    const target = (key) => after.model.edges.get(key).target;
    expect(target("S0000.connector")).toBe("S0004");
    expect(target("U0011.connector")).toBe("S0012");
  });

  it("puts and takes half the flow as one group", () => {
    const merge = createMerge({ before: base, after: ours });
    const resolved = resolveMerge(merge, {});
    const keys = blockKeys(4, Math.round(size / 5));
    const at = ["S0000", "connector"];
    const picks = time("insertPicks (half the flow)", () =>
      insertPicks(merge, resolved, keys, "after", ...at)
    );
    expect(picks).toEqual(
      placePlan(merge, resolved, keys, "after", ...at).picks
    );
    const taken = time("groupPicks (half the flow)", () =>
      groupPicks(merge, keys, "after")
    );
    for (const key of keys) {
      for (const unit of unitsForNode(merge, key)) {
        expect(taken[unit.id]).toBe("after");
      }
    }
  });

  it("brings a chain of twenty formulas one uses in turn", () => {
    // S0000 adds F00, which adds F01, and so on: the chain is ours alone.
    const chained = JSON.parse(JSON.stringify(ours));
    chained.formulas = Array.from({ length: 20 }, (_, index) => ({
      name: `F${String(index).padStart(2, "0")}`,
      dataType: "Number",
      scale: 0,
      expression:
        index < 19 ? `{!F${String(index + 1).padStart(2, "0")}} + 1` : "1"
    }));
    chained.assignments[0].assignmentItems[0].value = {
      elementReference: "F00"
    };
    const merge = createMerge({ before: base, after: chained });
    const resolved = time("resolveMerge (chain of 20)", () =>
      resolveMerge(merge, { "field|S0000|assignmentItems": "after" })
    );
    expect(resolved.autoIncluded).toHaveLength(20);
    expect(resolved.errors).toBe(0);
  });

  it("maps a different flow onto it", () => {
    // A third of the size, with names of its own where they'd clash.
    const source = large(Math.round(size / 3));
    const plan = time("planMapping", () => planMapping(base, source));
    const translation = time("translateFlow", () =>
      translateFlow(base, source, suggestedChoices(plan), plan)
    );
    expect(translation.issues).toEqual([]);
    // Its resources are this flow's, by name and type.
    expect(translation.notes.mapped.length).toBe(plan.roots.length);
    expect(translation.notes.mapped.every((row) => row.from === row.to)).toBe(
      true
    );
    // An element both have that does something different in each is kept
    // twice, the other flow's under a new name; one the same in both is one.
    const differ = plan.elements
      .filter((row) => !row.same)
      .map((row) => row.name);
    expect(differ.length).toBeGreaterThan(0);
    expect(differ.length).toBeLessThan(plan.elements.length);
    const renamed = translation.notes.renamed.filter(
      (row) => row.kind === "element"
    );
    expect(renamed.map((row) => row.from).sort()).toEqual(differ.sort());
    expect(renamed.every((row) => row.to === `${row.from}_2`)).toBe(true);
  });
});
