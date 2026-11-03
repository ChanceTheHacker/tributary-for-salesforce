import {
  diffFlows,
  diffValues,
  ADDED,
  REMOVED,
  CHANGED,
  UNCHANGED,
  RETARGETED,
  REORDERED
} from "c/flowDiff";
import { buildModel } from "c/flowModel";

const versions = [1, 2, 3, 4].map((v) =>
  require(`fixtures/flows/Case_Email_Routing/v${v}.json`)
);
const leadAutomation = require("fixtures/flows/lead_automation_test/v1.json");

const changed = (entries) =>
  entries.filter((entry) => entry.status !== UNCHANGED);

describe("diffValues", () => {
  it("reports scalar changes with their path", () => {
    expect(diffValues({ a: { b: 1 } }, { a: { b: 2 } })).toEqual([
      { path: ["a", "b"], status: CHANGED, before: 1, after: 2 }
    ]);
  });

  it("reports fields that appear or disappear", () => {
    expect(diffValues({ a: 1 }, { a: 1, b: "x" })).toEqual([
      { path: ["b"], status: ADDED, after: "x" }
    ]);
    expect(diffValues({ a: 1, b: "x" }, { a: 1 })).toEqual([
      { path: ["b"], status: REMOVED, before: "x" }
    ]);
  });

  it("matches named list items by name, wherever they sit", () => {
    const before = {
      rules: [
        { name: "A", label: "A" },
        { name: "B", label: "B" }
      ]
    };
    const after = {
      rules: [
        { name: "B", label: "B2" },
        { name: "A", label: "A" },
        { name: "C", label: "C" }
      ]
    };
    expect(diffValues(before, after)).toEqual([
      {
        path: ["rules"],
        status: REORDERED,
        before: ["A", "B"],
        after: ["B", "A"]
      },
      {
        path: ["rules", "B", "label"],
        status: CHANGED,
        before: "B",
        after: "B2"
      },
      { path: ["rules", "C"], status: ADDED, after: { name: "C", label: "C" } }
    ]);
  });

  it("matches an action's paths by pathName", () => {
    const before = {
      actionCallPaths: [{ pathName: "Success" }, { pathName: "Failure" }]
    };
    const after = {
      actionCallPaths: [{ pathName: "Failure" }, { pathName: "Success" }]
    };
    expect(diffValues(before, after)).toEqual([
      {
        path: ["actionCallPaths"],
        status: REORDERED,
        before: ["Success", "Failure"],
        after: ["Failure", "Success"]
      }
    ]);
  });

  it("reports a removed named item", () => {
    expect(
      diffValues(
        { rules: [{ name: "A" }, { name: "B" }] },
        { rules: [{ name: "A" }] }
      )
    ).toEqual([
      { path: ["rules", "B"], status: REMOVED, before: { name: "B" } }
    ]);
  });

  it("aligns unnamed list items like a line diff", () => {
    const condition = (field) => ({
      leftValueReference: field,
      operator: "EqualTo"
    });
    const before = {
      conditions: [condition("a"), condition("b"), condition("c")]
    };
    const after = {
      conditions: [
        condition("a"),
        condition("x"),
        condition("b"),
        condition("c")
      ]
    };
    expect(diffValues(before, after)).toEqual([
      { path: ["conditions", 1], status: ADDED, after: condition("x") }
    ]);
  });

  it("pairs off replaced unnamed items and diffs inside them", () => {
    const before = {
      conditions: [
        { left: "a", operator: "EqualTo" },
        { left: "b", operator: "EqualTo" }
      ]
    };
    const after = {
      conditions: [
        { left: "a", operator: "EqualTo" },
        { left: "b", operator: "NotEqualTo" }
      ]
    };
    expect(diffValues(before, after)).toEqual([
      {
        path: ["conditions", 1, "operator"],
        status: CHANGED,
        before: "EqualTo",
        after: "NotEqualTo"
      }
    ]);
  });

  describe("long unnamed lists", () => {
    const item = (n) => ({ field: `F${n % 7}`, value: n });
    const list = (size) => Array.from({ length: size }, (_, n) => item(n));

    it("reports an item added at the end, the start or the middle by its place", () => {
      const before = list(2000);
      expect(diffValues(before, [...before, item(5000)])).toEqual([
        { path: [2000], status: ADDED, after: item(5000) }
      ]);
      expect(diffValues(before, [item(5000), ...before])).toEqual([
        { path: [0], status: ADDED, after: item(5000) }
      ]);
      const inserted = [...before];
      inserted.splice(1000, 0, item(5000));
      expect(diffValues(before, inserted)).toEqual([
        { path: [1000], status: ADDED, after: item(5000) }
      ]);
    });

    it("reports a removed or changed item in the middle by its place", () => {
      const before = list(2000);
      const removed = before.filter((_, n) => n !== 700);
      expect(diffValues(before, removed)).toEqual([
        { path: [700], status: REMOVED, before: item(700) }
      ]);
      const changedOne = before.map((entry, n) =>
        n === 700 ? { ...entry, value: -1 } : entry
      );
      expect(diffValues(before, changedOne)).toEqual([
        { path: [700, "value"], status: CHANGED, before: 700, after: -1 }
      ]);
    });

    it("adds or removes every item when one side is empty", () => {
      expect(diffValues([item(1), item(8)], [])).toEqual([
        { path: [0], status: REMOVED, before: item(1) },
        { path: [1], status: REMOVED, before: item(8) }
      ]);
      // All F1, so the list isn't keyed by field.
      expect(diffValues([item(1)], [item(1), item(8), item(15)])).toEqual([
        { path: [1], status: ADDED, after: item(8) },
        { path: [2], status: ADDED, after: item(15) }
      ]);
    });

    it("pairs a repeated item at the end with the other side's last one", () => {
      const q = { value: "q" };
      const y = { value: "y" };
      const r = { value: "r" };
      expect(diffValues([q, y], [y, r, y])).toEqual([
        { path: [0, "value"], status: CHANGED, before: "q", after: "y" },
        { path: [1], status: ADDED, after: r }
      ]);
    });

    it("aligns a long run of changes without the full table", () => {
      // Every third item from 300 to 1101 changes: 800 items on each side
      // are left between the equal ends, past what the table is used for.
      const before = list(1500);
      const edited = (n) => n >= 300 && n <= 1101 && n % 3 === 0;
      const after = before.map((entry, n) =>
        edited(n) ? { ...entry, value: -n } : entry
      );
      const expected = before
        .map((_, n) => n)
        .filter(edited)
        .map((n) => ({
          path: [n, "value"],
          status: CHANGED,
          before: n,
          after: -n
        }));
      expect(diffValues(before, after)).toEqual(expected);
    });
  });

  it("does not key a list by name when names repeat", () => {
    const before = {
      items: [
        { name: "A", v: 1 },
        { name: "A", v: 2 }
      ]
    };
    const after = {
      items: [
        { name: "A", v: 1 },
        { name: "A", v: 3 }
      ]
    };
    expect(diffValues(before, after)).toEqual([
      { path: ["items", 1, "v"], status: CHANGED, before: 2, after: 3 }
    ]);
  });
});

describe("diffFlows on versions of one flow", () => {
  it("finds the single rewired connector between versions 3 and 4", () => {
    const diff = diffFlows(versions[2], versions[3]);
    expect(changed(diff.nodes)).toEqual([]);
    expect(changed(diff.resources)).toEqual([]);
    expect(diff.props).toEqual([]);

    const edges = changed(diff.edges);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      status: RETARGETED,
      source: "loop_matching_templates",
      kind: "loopNext",
      before: { target: "Was_a_match_found" },
      after: { target: "Should_Case_Be_Updated" }
    });
    expect(diff.summary.edges).toMatchObject({
      changed: 1,
      added: 0,
      removed: 0
    });
    expect(diff.identical).toBe(false);
    expect(diff.layoutOnly).toBe(false);
  });

  it("treats versions that only moved an element as a layout change", () => {
    const diff = diffFlows(versions[0], versions[1]);
    expect(changed(diff.nodes)).toEqual([]);
    expect(changed(diff.edges)).toEqual([]);
    const moved = diff.nodes.filter((entry) => entry.moved);
    expect(moved.length).toBeGreaterThan(0);
    expect(diff.summary.nodes.moved).toBe(moved.length);
    expect(diff.layoutOnly).toBe(true);
    expect(diff.identical).toBe(false);
  });

  it("ignores the version status", () => {
    // Version 1 is Active and version 2 Obsolete.
    expect(diffFlows(versions[0], versions[1]).props).toEqual([]);
  });

  it("finds nothing between a version and itself", () => {
    const diff = diffFlows(versions[3], versions[3]);
    expect(diff.identical).toBe(true);
    expect(diff.layoutOnly).toBe(false);
    expect(diff.summary.nodes).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
      unchanged: 8
    });
  });

  it("accepts prebuilt models", () => {
    const a = buildModel(versions[2]);
    const b = buildModel(versions[3]);
    expect(diffFlows(a, b).before).toBe(a);
    expect(changed(diffFlows(a, b).edges)).toHaveLength(1);
  });

  it("reports a connector whose only change is its metadata values", () => {
    const edited = JSON.parse(JSON.stringify(versions[3]));
    const lookup = edited.Metadata.recordLookups[0];
    lookup.connector.processMetadataValues = [
      { name: "Note", value: { stringValue: "checked" } }
    ];
    const diff = diffFlows(versions[3], edited);
    expect(diff.identical).toBe(false);
    expect(changed(diff.edges)).toEqual([
      expect.objectContaining({
        key: "Get_Routing.connector",
        status: CHANGED
      })
    ]);
    expect(diff.summary.edges.changed).toBe(1);
  });

  it("reports field changes on an element, and connector changes on their own", () => {
    const before = buildModel(versions[3]);
    const edited = JSON.parse(JSON.stringify(versions[3]));
    const lookup = edited.Metadata.recordLookups[0];
    lookup.label = "Get Routing Templates";
    lookup.connector = null;
    const diff = diffFlows(before, edited);

    expect(changed(diff.nodes)).toEqual([
      expect.objectContaining({
        id: "recordLookups:Get_Routing",
        status: CHANGED,
        changes: [
          {
            path: ["label"],
            status: CHANGED,
            before: "Get Routing",
            after: "Get Routing Templates"
          }
        ]
      })
    ]);
    expect(changed(diff.edges)).toEqual([
      expect.objectContaining({
        status: REMOVED,
        source: "Get_Routing",
        slot: "connector",
        kind: "next"
      })
    ]);
  });
});

describe("diffFlows on unrelated flows", () => {
  const diff = diffFlows(versions[3], leadAutomation);

  it("adds and removes elements by name, and compares the start elements", () => {
    const byStatus = (status) =>
      diff.nodes
        .filter((entry) => entry.status === status)
        .map((entry) => entry.key);
    expect(byStatus(REMOVED)).toEqual(
      expect.arrayContaining(["Get_Routing", "loop_matching_templates"])
    );
    expect(byStatus(ADDED).length).toBeGreaterThan(0);
    expect(diff.nodes.find((entry) => entry.key === "$Start").status).toBe(
      CHANGED
    );
  });

  it("splits same-named elements of different types into a removal and an addition", () => {
    const a = {
      assignments: [{ name: "Step", label: "Step", locationX: 0, locationY: 0 }]
    };
    const b = {
      decisions: [{ name: "Step", label: "Step", locationX: 0, locationY: 0 }]
    };
    const nodes = diffFlows(a, b).nodes;
    expect(nodes.map((entry) => [entry.id, entry.status])).toEqual([
      ["decisions:Step", ADDED],
      ["assignments:Step", REMOVED]
    ]);
  });
});

describe("diffFlows on every fixture pair", () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(process.cwd(), "test/fixtures/flows");
  const flows = fs
    .readdirSync(root)
    .flatMap((flow) =>
      fs
        .readdirSync(path.join(root, flow))
        .map((file) => require(`fixtures/flows/${flow}/${file}`))
    );

  it("compares any two flows, and every flow to itself", () => {
    for (const a of flows) {
      expect(diffFlows(a, a).identical).toBe(true);
      for (const b of flows) {
        const diff = diffFlows(a, b);
        const touched = diff.nodes.filter((e) => e.status !== UNCHANGED);
        for (const entry of touched) {
          expect(entry.before || entry.after).toBeDefined();
        }
      }
    }
  });
});
