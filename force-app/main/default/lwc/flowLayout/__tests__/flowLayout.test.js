import {
  layoutAround,
  layoutFlow,
  layoutFlows,
  overlaps as overlapping,
  spotIndex,
  usesAutoLayout,
  nodeId,
  routeEdge,
  spread,
  crossings,
  NODE_WIDTH,
  NODE_HEIGHT,
  TILE
} from "c/flowLayout";
import { buildModel, START } from "c/flowModel";

const load = (flow, version = 1) =>
  buildModel(require(`fixtures/flows/${flow}/v${version}.json`));

const FLOWS = [
  ["Analyze_Flows", 1],
  ["Case_Email_Routing", 4],
  ["Case_Routing_Template_Creation", 1],
  ["lead_automation_test", 1],
  ["sfdc_default_ReportExport_Protection_Flow", 1]
];

function overlaps(positions) {
  const list = [...positions.entries()];
  const found = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, p] = list[i];
      const [b, q] = list[j];
      if (
        Math.abs(p.x - q.x) < NODE_WIDTH &&
        Math.abs(p.y - q.y) < NODE_HEIGHT
      ) {
        found.push([a, b]);
      }
    }
  }
  return found;
}

describe("flowLayout", () => {
  it("keeps stored positions for free-form flows", () => {
    const model = load("Case_Email_Routing", 4);
    expect(usesAutoLayout(model)).toBe(false);
    const layout = layoutFlow(model);
    expect(layout.auto).toBe(false);
    expect(layout.nodes.get(`start:${START}`)).toEqual({ x: 526, y: 48 });
    expect(layout.nodes.get("recordLookups:Get_Routing")).toEqual({
      x: 655,
      y: 409
    });
  });

  it("lays out auto-layout flows and flows without positions", () => {
    expect(usesAutoLayout(load("Analyze_Flows"))).toBe(true);
    const zero = load("sfdc_default_ReportExport_Protection_Flow");
    expect(usesAutoLayout(zero)).toBe(true);
    const layout = layoutFlow(zero);
    expect(layout.auto).toBe(true);
    // The synthetic start comes first, then the decision it leads to.
    const start = layout.nodes.get(`start:${START}`);
    const first = layout.nodes.get(
      nodeId(zero.nodes.get(zero.props.startElementReference))
    );
    expect(start.y).toBeLessThan(first.y);
  });

  it.each(FLOWS)(
    "places every element of %s v%s without overlaps",
    (flow, v) => {
      const model = load(flow, v);
      const layout = layoutFlow(model);
      expect(layout.nodes.size).toBe(model.nodes.size);
      expect(layout.auto ? overlaps(layout.nodes) : []).toEqual([]);
      for (const node of model.nodes.values()) {
        const p = layout.nodes.get(nodeId(node));
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      }
    }
  );

  it("puts every element below the elements that lead into it", () => {
    const model = load("Analyze_Flows");
    const layout = layoutFlow(model);
    const pos = (key) => layout.nodes.get(nodeId(model.nodes.get(key)));
    // Only connectors that close a loop may point upward.
    const upward = [...model.edges.values()].filter(
      (edge) =>
        !edge.isGoTo &&
        model.nodes.has(edge.target) &&
        pos(edge.target).y <= pos(edge.source).y
    );
    expect(upward.filter((edge) => edge.kind === "fault")).toEqual([]);
    const start = pos(START);
    for (const node of model.nodes.values()) {
      expect(pos(node.key).y).toBeGreaterThanOrEqual(start.y);
    }
  });

  it("places a loop's exit below the loop body", () => {
    const loopFlow = {
      processType: "AutoLaunchedFlow",
      start: { connector: { targetReference: "Each" } },
      loops: [
        {
          name: "Each",
          nextValueConnector: { targetReference: "Body_1" },
          noMoreValuesConnector: { targetReference: "After" }
        }
      ],
      assignments: [
        { name: "Body_1", connector: { targetReference: "Body_2" } },
        { name: "Body_2", connector: { targetReference: "Each" } },
        { name: "After" }
      ]
    };
    const model = buildModel(loopFlow);
    const layout = layoutFlow(model);
    const y = (key) => layout.nodes.get(nodeId(model.nodes.get(key))).y;
    expect(y("Body_1")).toBeGreaterThan(y("Each"));
    expect(y("Body_2")).toBeGreaterThan(y("Body_1"));
    expect(y("After")).toBeGreaterThan(y("Body_2"));
  });

  it("centres a decision's branches under it and rejoins them", () => {
    const flow = {
      processType: "AutoLaunchedFlow",
      start: { connector: { targetReference: "Pick" } },
      decisions: [
        {
          name: "Pick",
          rules: [{ name: "Yes", connector: { targetReference: "Left" } }],
          defaultConnector: { targetReference: "Right" }
        }
      ],
      assignments: [
        { name: "Left", connector: { targetReference: "Join" } },
        { name: "Right", connector: { targetReference: "Join" } },
        { name: "Join" }
      ]
    };
    const model = buildModel(flow);
    const layout = layoutFlow(model);
    const p = (key) => layout.nodes.get(nodeId(model.nodes.get(key)));
    expect(p("Left").y).toBe(p("Right").y);
    expect(p("Left").x).toBeLessThan(p("Right").x);
    expect(
      Math.abs((p("Left").x + p("Right").x) / 2 - p("Pick").x)
    ).toBeLessThan(2);
    expect(Math.abs(p("Join").x - p("Pick").x)).toBeLessThan(2);
    expect(p("Join").y).toBeGreaterThan(p("Left").y);
  });

  it("gives a shared place to elements of two versions", () => {
    const before = buildModel({
      processType: "AutoLaunchedFlow",
      start: { connector: { targetReference: "A" } },
      assignments: [
        { name: "A", connector: { targetReference: "C" } },
        { name: "C" }
      ]
    });
    const after = buildModel({
      processType: "AutoLaunchedFlow",
      start: { connector: { targetReference: "A" } },
      assignments: [
        { name: "A", connector: { targetReference: "B" } },
        { name: "B", connector: { targetReference: "C" } },
        { name: "C" }
      ]
    });
    const layout = layoutFlows([before, after]);
    expect(layout.nodes.size).toBe(4);
    const y = (key) => layout.nodes.get(`assignments:${key}`).y;
    expect(y("A")).toBeLessThan(y("B"));
    expect(y("B")).toBeLessThan(y("C"));
  });

  it("draws a merge's free-form elements where its result has them", () => {
    const flow = (assignments) =>
      buildModel({
        processType: "AutoLaunchedFlow",
        start: { locationX: 50, locationY: 0 },
        assignments
      });
    const ours = flow([{ name: "A", locationX: 50, locationY: 200 }]);
    const theirs = flow([
      { name: "A", locationX: 400, locationY: 200 },
      { name: "B", locationX: 50, locationY: 200 }
    ]);
    const result = flow([{ name: "A", locationX: 50, locationY: 200 }]);
    const layout = layoutAround([ours, theirs], result);
    const at = (key) => layout.nodes.get(`assignments:${key}`);
    // A where the result saves it, not where the last side has it; B, left
    // out and on the same spot there, moved clear of it.
    expect(at("A")).toEqual({ x: 50, y: 200 });
    expect(overlaps(layout.nodes)).toEqual([]);
    expect(at("B").y).toBe(200);
    // Auto-layout flows keep the sides' layout whatever the result.
    const auto = [ours, theirs].map((model) => ({
      ...model,
      canvasMode: "AUTO_LAYOUT_CANVAS"
    }));
    expect(layoutAround(auto, result)).toEqual(layoutFlows(auto));
  });

  describe("free-form flows drawn together", () => {
    const flow = (collections) =>
      buildModel({
        processType: "AutoLaunchedFlow",
        start: {
          locationX: 50,
          locationY: 0,
          connector: { targetReference: "A" }
        },
        ...collections
      });
    const at = (x, y, extra = {}) => ({ locationX: x, locationY: y, ...extra });

    it("moves an element retyped in place clear of its new self", () => {
      const before = flow({
        assignments: [
          { name: "A", ...at(50, 200) },
          { name: "B", ...at(50, 400) }
        ]
      });
      const after = flow({
        recordCreates: [{ name: "A", ...at(50, 200) }],
        assignments: [{ name: "B", ...at(50, 400) }]
      });
      const layout = layoutFlows([before, after]);
      // The later version's element stays where it's saved; the earlier
      // one's moves beside it. The rest keep their places.
      expect(layout.nodes.get("recordCreates:A")).toEqual({ x: 50, y: 200 });
      const moved = layout.nodes.get("assignments:A");
      expect(overlapping(moved, { x: 50, y: 200 })).toBe(false);
      expect(moved.y).toBe(200);
      expect(layout.nodes.get("assignments:B")).toEqual({ x: 50, y: 400 });
      expect(layout.nodes.get("start:$Start")).toEqual({ x: 50, y: 0 });
      expect(overlaps(layout.nodes)).toEqual([]);
      // Nothing saved moves.
      expect(before.nodes.get("A").x).toBe(50);
    });

    it("keeps unrelated flows' elements on the same spot apart", () => {
      const one = flow({
        assignments: [
          { name: "A", ...at(50, 200) },
          { name: "B", ...at(50, 400) }
        ]
      });
      const two = flow({
        assignments: [
          { name: "X", ...at(50, 200) },
          { name: "Y", ...at(60, 410) }
        ]
      });
      const layout = layoutFlows([one, two]);
      expect(layout.nodes.get("assignments:X")).toEqual({ x: 50, y: 200 });
      expect(layout.nodes.get("assignments:Y")).toEqual({ x: 60, y: 410 });
      for (const key of ["A", "B"]) {
        const p = layout.nodes.get(`assignments:${key}`);
        for (const other of ["X", "Y"]) {
          expect(overlapping(p, layout.nodes.get(`assignments:${other}`))).toBe(
            false
          );
        }
      }
    });

    it("moves an element whose label would cover another's icon", () => {
      const before = flow({ assignments: [{ name: "Old", ...at(98, 200) }] });
      const after = flow({ recordCreates: [{ name: "New", ...at(50, 200) }] });
      const layout = layoutFlows([before, after]);
      // The icons only touch, but the old element's label, and the area
      // that selects it, would lie over the new one.
      expect(layout.nodes.get("recordCreates:New")).toEqual({ x: 50, y: 200 });
      const moved = layout.nodes.get("assignments:Old");
      expect(
        overlapping(moved, { x: 50, y: 200 }, NODE_WIDTH, NODE_HEIGHT)
      ).toBe(false);
    });

    it("moves elements clear when both sit left of and above the origin", () => {
      const before = flow({ assignments: [{ name: "A", ...at(-300, -300) }] });
      const after = flow({ recordCreates: [{ name: "A", ...at(-300, -300) }] });
      const layout = layoutFlows([before, after]);
      expect(layout.nodes.get("recordCreates:A")).toEqual({
        x: -300,
        y: -300
      });
      const moved = layout.nodes.get("assignments:A");
      expect(
        overlapping(moved, { x: -300, y: -300 }, NODE_WIDTH, NODE_HEIGHT)
      ).toBe(false);
      expect(moved.y).toBe(-300);
    });

    it("leaves overlaps a flow drew itself, and elements that only moved", () => {
      const before = flow({
        assignments: [
          { name: "A", ...at(50, 200) },
          { name: "B", ...at(50, 200) },
          { name: "C", ...at(300, 200) }
        ]
      });
      const after = flow({
        assignments: [
          { name: "A", ...at(50, 200) },
          { name: "B", ...at(50, 200) },
          { name: "C", ...at(50, 600) }
        ]
      });
      const layout = layoutFlows([before, after]);
      expect(layout.nodes.get("assignments:A")).toEqual({ x: 50, y: 200 });
      expect(layout.nodes.get("assignments:B")).toEqual({ x: 50, y: 200 });
      expect(layout.nodes.get("assignments:C")).toEqual({ x: 50, y: 600 });
    });

    it("keeps every version of a real flow where it's saved", () => {
      const versions = [1, 2, 3, 4].map((v) => load("Case_Email_Routing", v));
      for (const a of versions) {
        for (const b of versions) {
          const layout = layoutFlows([a, b]);
          const saved = [...a.nodes.values(), ...b.nodes.values()]
            .map((node) => b.nodes.get(node.key) || node)
            .filter((node) => typeof node.x === "number");
          for (const node of saved) {
            expect(layout.nodes.get(nodeId(node))).toEqual({
              x: node.x,
              y: node.y
            });
          }
        }
      }
    });
  });

  it("places free-form elements missing a position near their predecessor", () => {
    const model = load("Case_Email_Routing", 4);
    const extra = buildModel({
      ...require("fixtures/flows/Case_Email_Routing/v4.json").Metadata,
      assignments: [
        ...require("fixtures/flows/Case_Email_Routing/v4.json").Metadata
          .assignments,
        { name: "Floating" }
      ]
    });
    extra.edges.set("Get_Routing.faultConnector", {
      key: "Get_Routing.faultConnector",
      source: "Get_Routing",
      target: "Floating",
      slot: "faultConnector",
      kind: "fault",
      isGoTo: false
    });
    const layout = layoutFlows([model, extra]);
    const p = layout.nodes.get("assignments:Floating");
    expect(p.x).toBe(655);
    expect(p.y).toBeGreaterThan(409);
  });

  it("spreads positions with minimum gaps (pool adjacent violators)", () => {
    const placed = spread(
      [
        { value: 0, weight: 1 },
        { value: 0, weight: 1 },
        { value: 0, weight: 1 }
      ],
      [0, 10, 10]
    );
    expect(placed).toEqual([-10, 0, 10]);
    expect(
      spread(
        [
          { value: 0, weight: 1 },
          { value: 100, weight: 1 }
        ],
        [0, 10]
      )
    ).toEqual([0, 100]);
  });

  it("routes connectors down, and around the side when they go back up", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 300 };
    const down = routeEdge(a, b);
    expect(down.back).toBe(false);
    expect(down.d.startsWith(`M ${TILE / 2} ${NODE_HEIGHT}`)).toBe(true);
    expect(down.d.endsWith(`${TILE / 2} 300`)).toBe(true);
    const up = routeEdge(b, a);
    expect(up.back).toBe(true);
    expect(up.d.endsWith(`${TILE} ${TILE / 2}`)).toBe(true);
    const fault = routeEdge(a, b, { kind: "fault" });
    expect(fault.d.startsWith(`M ${TILE} ${TILE / 2}`)).toBe(true);
    const spreadExits = [0, 1, 2].map(
      (i) => routeEdge(a, b, { exitIndex: i, exitCount: 3 }).d.split(" ")[1]
    );
    expect(new Set(spreadExits).size).toBe(3);
  });

  it("finds what's near a spot as looking at every one would", () => {
    // A fixed scatter, on and off the grid, some of it negative.
    let seed = 7;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed;
    };
    const placed = Array.from({ length: 400 }, () => ({
      x: (next() % 3000) - 500,
      y: (next() % 3000) - 500
    }));
    const index = spotIndex(placed);
    const odd = (other) => other.x % 2 !== 0;
    for (let probe = 0; probe < 400; probe++) {
      const spot = { x: (next() % 3200) - 600, y: (next() % 3200) - 600 };
      for (const [width, height] of [
        [TILE, TILE],
        [NODE_WIDTH, NODE_HEIGHT],
        [1, 1],
        [TILE * 3 + 5, TILE / 2]
      ]) {
        const near = (other) => overlapping(spot, other, width, height);
        expect(index.some(spot, width, height)).toBe(placed.some(near));
        expect(index.some(spot, width, height, odd)).toBe(
          placed.some((other) => near(other) && odd(other))
        );
      }
    }
    // Added after it's made, a position is found like the rest.
    const late = { x: 10000, y: 10000 };
    expect(index.some(late)).toBe(false);
    index.add(late);
    expect(index.some({ x: 10000 + TILE - 1, y: 10000 })).toBe(true);
  });
  it("counts crossing connectors as comparing every pair would", () => {
    // Connector pairs whose ends are in opposite orders; sharing an end
    // isn't crossing.
    const pairwise = (upper, lower, down) => {
      const pairs = [];
      upper.forEach((id, a) => {
        for (const target of down.get(id)) {
          if (lower.includes(target)) {
            pairs.push([a, lower.indexOf(target)]);
          }
        }
      });
      let count = 0;
      for (let i = 0; i < pairs.length; i++) {
        for (let j = i + 1; j < pairs.length; j++) {
          if ((pairs[i][0] - pairs[j][0]) * (pairs[i][1] - pairs[j][1]) < 0) {
            count++;
          }
        }
      }
      return count;
    };
    let seed = 11;
    const next = (limit) => {
      seed = (seed * 48271) % 2147483647;
      return seed % limit;
    };
    for (let trial = 0; trial < 200; trial++) {
      const upper = Array.from({ length: 1 + next(12) }, (_, i) => `u${i}`);
      const lower = Array.from({ length: 1 + next(12) }, (_, i) => `l${i}`);
      const down = new Map(
        upper.map((id) => [
          id,
          // Some to elsewhere, some twice, in any order.
          Array.from({ length: next(5) }, () =>
            next(4) ? lower[next(lower.length)] : "elsewhere"
          )
        ])
      );
      expect(crossings(upper, lower, down)).toBe(pairwise(upper, lower, down));
    }
  });

  it("lays out decisions with paths to every step of a long chain", () => {
    // Start → D → E0 → D2 → E1 → ... → E<n-1>. D's outcomes go to every
    // step, last first, and D2's to the second half, last first: long skip
    // connectors that cross the chain and each other, so the layout routes
    // tens of thousands of connector points and reorders every layer.
    const n = 200;
    const outcome = (name, target) => ({
      name,
      label: name,
      connector: { targetReference: target }
    });
    const assignments = [];
    for (let i = 0; i < n; i++) {
      assignments.push({
        name: `E${i}`,
        label: `E${i}`,
        ...(i + 1 < n
          ? { connector: { targetReference: i ? `E${i + 1}` : "D2" } }
          : {})
      });
    }
    const model = buildModel({
      start: { connector: { targetReference: "D" } },
      decisions: [
        {
          name: "D",
          label: "D",
          rules: assignments.map((_, i) => outcome(`R${i}`, `E${n - 1 - i}`))
        },
        {
          name: "D2",
          label: "D2",
          defaultConnector: { targetReference: "E1" },
          rules: assignments
            .slice(0, n / 2)
            .map((_, i) => outcome(`Q${i}`, `E${n - 1 - i}`))
        }
      ],
      assignments
    });
    expect(usesAutoLayout(model)).toBe(true);
    const began = performance.now();
    const layout = layoutFlow(model);
    // Loose, to catch work growing with the square of a layer's width.
    expect(performance.now() - began).toBeLessThan(3000);
    const at = (key) => layout.nodes.get(`assignments:${key}`);
    for (let i = 1; i < n; i++) {
      expect(at(`E${i}`).y).toBeGreaterThan(at(`E${i - 1}`).y);
    }
    // D's path to E150 passes the 151 layers between them.
    expect(layout.via.get("decisions:D>assignments:E150")).toHaveLength(151);
  });
});
