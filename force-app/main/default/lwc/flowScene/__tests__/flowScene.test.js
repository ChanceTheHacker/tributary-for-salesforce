import {
  flowScene,
  placeScene,
  diffScene,
  mergeScene,
  EXCLUDED,
  diffLayout,
  diffCounts,
  BEFORE,
  AFTER,
  UNIFIED
} from "c/flowScene";
import { buildModel, START } from "c/flowModel";
import { TILE, NODE_WIDTH, NODE_HEIGHT, routeEdge } from "c/flowLayout";
import { visibleText } from "c/flowUtils";
import { diffFlows, ADDED, REMOVED, CHANGED } from "c/flowDiff";
import { createMerge, resolveMerge, presetPicks } from "c/flowMerge";

const load = (flow, version = 1) =>
  buildModel(require(`fixtures/flows/${flow}/v${version}.json`));

// Case_Email_Routing v4 with one element removed, one added, one relabelled
// and the removed element's incoming connector sent elsewhere.
function edited() {
  const source = require("fixtures/flows/Case_Email_Routing/v4.json");
  const metadata = JSON.parse(JSON.stringify(source.Metadata || source));
  metadata.recordUpdates = metadata.recordUpdates.filter(
    (element) => element.name !== "Unhandled_Case_Update"
  );
  const decision = metadata.decisions.find(
    (element) => element.name === "Should_Case_Be_Updated"
  );
  decision.defaultConnector.targetReference = "Log_Result";
  metadata.recordLookups[0].label = "Get Routing Rules";
  metadata.assignments.push({
    name: "Log_Result",
    label: "Log Result",
    locationX: 0,
    locationY: 0,
    assignmentItems: []
  });
  return buildModel(metadata);
}

// A decision whose three branches fan out to three assignments, like the
// discount flows testers kept finding overlapping labels on.
function branching() {
  const assignment = (name, next) => ({
    name,
    label: name.replace(/_/g, " "),
    locationX: 0,
    locationY: 0,
    assignmentItems: [],
    ...(next && { connector: { targetReference: next } })
  });
  const rule = (name, target) => ({
    name,
    label: name.replace(/_/g, " "),
    conditionLogic: "and",
    conditions: [],
    connector: { targetReference: target }
  });
  return buildModel({
    label: "Discounts",
    processType: "AutoLaunchedFlow",
    start: {
      locationX: 0,
      locationY: 0,
      connector: { targetReference: "Check_Amount" }
    },
    decisions: [
      {
        name: "Check_Amount",
        label: "Check Amount",
        locationX: 0,
        locationY: 0,
        defaultConnector: { targetReference: "Set_Standard_Discount" },
        defaultConnectorLabel: "Standard",
        rules: [
          rule("Large_Order", "Set_Large_Discount"),
          rule("Priority_Region", "Set_Region_Discount")
        ]
      }
    ],
    assignments: [
      assignment("Set_Large_Discount", "Build_Summary"),
      assignment("Set_Standard_Discount", "Build_Summary"),
      assignment("Set_Region_Discount", "Build_Summary"),
      assignment("Build_Summary")
    ]
  });
}

// Approximate rendered pill dimensions, including visibly escaped controls.
function pill(edge) {
  const half = Math.min(140, 18 + 6.2 * visibleText(edge.label).length) / 2;
  return {
    left: edge.labelX - half,
    right: edge.labelX + half,
    top: edge.labelY - 11,
    bottom: edge.labelY + 11
  };
}

describe("flowScene", () => {
  it("keeps connector labels clear of each other", () => {
    const scene = flowScene(branching());
    const labelled = scene.edges.filter((edge) => edge.label);
    expect(labelled.map((edge) => edge.label).sort()).toEqual([
      "Large Order",
      "Priority Region",
      "Standard"
    ]);
    const boxes = labelled.map(pill);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const apart =
          a.right <= b.left ||
          b.right <= a.left ||
          a.bottom <= b.top ||
          b.bottom <= a.top;
        expect([labelled[i].label, labelled[j].label, apart]).toEqual([
          labelled[i].label,
          labelled[j].label,
          true
        ]);
      }
    }
    for (const edge of scene.edges) {
      expect(edge.labels).toBeUndefined();
    }
  });

  it("keeps branch labels off node captions and source-pick chips", () => {
    const base = flowScene(branching());
    const nodes = base.nodes.map((node) => ({
      ...node,
      pickLabel: "Version B"
    }));
    const layout = {
      nodes: new Map(nodes.map((node) => [node.id, node])),
      via: new Map()
    };
    const scene = placeScene(layout, nodes, base.edges);
    for (const edge of scene.edges.filter((item) => item.label)) {
      const box = pill(edge);
      for (const node of scene.nodes) {
        expect(
          box.right <= node.x - (NODE_WIDTH - TILE) / 2 ||
            box.left >= node.x + (NODE_WIDTH + TILE) / 2 ||
            box.bottom <= node.y ||
            box.top >= node.y + NODE_HEIGHT + 16
        ).toBe(true);
      }
    }
  });

  it("includes loop label pills and source-pick chips in padded bounds", () => {
    const node = { id: "a", x: 0, y: 0, pickLabel: "Version B" };
    const scene = placeScene(
      { nodes: new Map([[node.id, node]]), via: new Map() },
      [node],
      [{ key: "loop", sourceId: "a", targetId: "a", label: "‮‮" }]
    );
    const box = pill(scene.edges[0]);
    expect(scene.bounds.x + scene.bounds.width).toBeGreaterThanOrEqual(
      box.right + 60
    );
    expect(scene.bounds.y + scene.bounds.height).toBeGreaterThanOrEqual(
      NODE_HEIGHT + 16 + 60
    );
    const route = routeEdge(node, node);
    expect(route.back).toBe(true);
    expect(new Set(route.labels.map((point) => point.y)).size).toBeGreaterThan(
      1
    );
    expect(route.labels.every((point) => point.x === route.label.x)).toBe(true);
  });

  it("places every element and routes every connector of a flow", () => {
    const model = load("Case_Email_Routing", 4);
    const scene = flowScene(model);
    expect(scene.nodes).toHaveLength(model.nodes.size);
    expect(scene.edges).toHaveLength(model.edges.size);
    for (const edge of scene.edges) {
      expect(edge.d).toMatch(/^M /);
      expect(edge.arrow.split(" ")).toHaveLength(3);
    }
    const start = scene.nodes.find((node) => node.key === START);
    expect(start.label).toBe("Start");
    expect(start.apiName).toBe("");
    expect(scene.bounds.width).toBeGreaterThan(0);
    expect(scene.nodes.every((node) => node.status === "unchanged")).toBe(true);
  });

  it("gives connectors unique ids", () => {
    for (const [flow, version] of [
      ["Analyze_Flows", 1],
      ["lead_automation_test", 1],
      ["Case_Routing_Template_Creation", 1]
    ]) {
      const scene = flowScene(load(flow, version));
      const ids = scene.edges.map((edge) => edge.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("diffScene connectors", () => {
  it("gives the connectors of a retyped element their own ids", () => {
    const flow = (type) => ({
      label: "Retyped",
      start: {
        locationX: 0,
        locationY: 0,
        connector: { targetReference: "X" }
      },
      [type]: [
        {
          name: "X",
          label: "X",
          locationX: 0,
          locationY: 100,
          connector: { targetReference: "Y" }
        }
      ],
      screens: [{ name: "Y", label: "Y", locationX: 0, locationY: 200 }]
    });
    const diff = diffFlows(
      buildModel(flow("assignments")),
      buildModel(flow("recordCreates"))
    );
    const ids = diffScene(diff, UNIFIED).edges.map((edge) => edge.id);
    expect(ids.filter((id) => id.includes("X.connector"))).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("draws a retyped element and what it replaced side by side", () => {
    const flow = (type) => ({
      label: "Retyped",
      start: { locationX: 0, locationY: 0 },
      [type]: [{ name: "X", label: "X", locationX: 0, locationY: 100 }]
    });
    const diff = diffFlows(
      buildModel(flow("assignments")),
      buildModel(flow("recordCreates"))
    );
    const { nodes } = diffScene(diff, UNIFIED);
    const added = nodes.find((node) => node.id === "recordCreates:X");
    const removed = nodes.find((node) => node.id === "assignments:X");
    expect({ x: added.x, y: added.y }).toEqual({ x: 0, y: 100 });
    // Clear of it, not on top where it would hide it and take its clicks.
    expect(Math.abs(removed.x - added.x)).toBeGreaterThanOrEqual(48);
  });
});

describe("diffScene", () => {
  const before = load("Case_Email_Routing", 4);
  const after = edited();
  const diff = diffFlows(before, after);
  const layout = diffLayout(diff);

  it("shows removed elements only on the before side", () => {
    const left = diffScene(diff, BEFORE, { layout });
    const right = diffScene(diff, AFTER, { layout });
    const removed = diff.nodes.filter((entry) => entry.status === REMOVED);
    const added = diff.nodes.filter((entry) => entry.status === ADDED);
    expect(left.nodes).toHaveLength(before.nodes.size);
    expect(right.nodes).toHaveLength(after.nodes.size);
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    for (const entry of removed) {
      expect(left.nodes.find((node) => node.id === entry.id).status).toBe(
        REMOVED
      );
      expect(right.nodes.find((node) => node.id === entry.id)).toBeUndefined();
    }
    for (const entry of added) {
      expect(right.nodes.find((node) => node.id === entry.id).status).toBe(
        ADDED
      );
    }
  });

  it("puts an element at the same place on both sides", () => {
    const left = diffScene(diff, BEFORE, { layout });
    const right = diffScene(diff, AFTER, { layout });
    const moved = left.nodes.filter((node) => {
      const other = right.nodes.find((candidate) => candidate.id === node.id);
      return other && (other.x !== node.x || other.y !== node.y);
    });
    expect(moved).toEqual([]);
  });

  it("draws both sides on the unified canvas", () => {
    const unified = diffScene(diff, UNIFIED, { layout });
    expect(unified.nodes).toHaveLength(diff.nodes.length);
    const changed = diff.nodes.filter((entry) => entry.status === CHANGED);
    expect(changed.length).toBeGreaterThan(0);
    for (const entry of changed) {
      const node = unified.nodes.find((candidate) => candidate.id === entry.id);
      expect(node.status).toBe(CHANGED);
      expect(node.changeCount).toBe(entry.changes.length);
    }
    const retargeted = diff.edges.filter(
      (entry) => entry.status === "retargeted"
    );
    expect(retargeted).toHaveLength(1);
    const drawn = unified.edges.filter((edge) =>
      retargeted.some((entry) => entry.key === edge.key)
    );
    expect(drawn).toHaveLength(retargeted.length * 2);
  });

  it("copies markers onto elements", () => {
    const id = diff.nodes[1].id;
    const scene = diffScene(diff, UNIFIED, {
      layout,
      markers: new Map([[id, { conflict: true }]])
    });
    expect(scene.nodes.find((node) => node.id === id).conflict).toBe(true);
  });

  it("can hide moves", () => {
    const moved = {
      ...diff,
      nodes: diff.nodes.map((n) => ({ ...n, moved: true }))
    };
    expect(diffScene(moved, UNIFIED, { layout }).nodes[0].moved).toBe(true);
    expect(
      diffScene(moved, UNIFIED, { layout, showMoved: false }).nodes[0].moved
    ).toBe(false);
  });

  it("counts what changed", () => {
    const counts = diffCounts(diff);
    expect(counts.added).toBe(1);
    expect(counts.removed).toBe(1);
    expect(counts.changed).toBeGreaterThan(0);
    expect(diffCounts(diffFlows(after, after)).changed).toBe(0);
  });
});

describe("mergeScene", () => {
  const before = load("Case_Email_Routing", 4);
  const after = edited();

  it("starts from the before side and fades what it leaves out", () => {
    const merge = createMerge({ before, after });
    const resolved = resolveMerge(merge, {});
    const { scene, diff } = mergeScene(merge, resolved, {
      sideLabels: { before: "v4", after: "Edited" }
    });
    expect(diff.identical).toBe(true);
    const excluded = scene.nodes.filter((node) => node.status === EXCLUDED);
    expect(excluded.map((node) => node.key)).toEqual(["Log_Result"]);
    expect(excluded[0].pickLabel).toBe("Edited");
    const relabelled = scene.nodes.find((node) => node.key === "Get_Routing");
    expect(relabelled.pickLabel).toBe("v4");
  });

  it("marks what the picks change", () => {
    const merge = createMerge({ before, after });
    const resolved = resolveMerge(merge, presetPicks(merge, "after"));
    const { scene } = mergeScene(merge, resolved);
    const status = (key) => scene.nodes.find((node) => node.key === key).status;
    expect(status("Log_Result")).toBe(ADDED);
    expect(status("Unhandled_Case_Update")).toBe(REMOVED);
    expect(status("Get_Routing")).toBe(CHANGED);
    expect(scene.nodes.find((n) => n.key === "Get_Routing").picked).toBe(
      "after"
    );
  });

  it("marks conflicts in a three-way merge", () => {
    const base = load("Case_Email_Routing", 4);
    const theirs = edited();
    const source = require("fixtures/flows/Case_Email_Routing/v4.json");
    const metadata = JSON.parse(JSON.stringify(source.Metadata || source));
    metadata.recordLookups[0].label = "Ours";
    const ours = buildModel(metadata);
    const merge = createMerge({ base, ours, theirs });
    const resolved = resolveMerge(merge, {});
    expect(resolved.conflicts.length).toBeGreaterThan(0);
    const { scene } = mergeScene(merge, resolved);
    expect(scene.nodes.find((n) => n.key === "Get_Routing").conflict).toBe(
      true
    );
  });
});
