import {
  createMerge,
  resolveMerge,
  changedUnits,
  presetPicks,
  picksForNode,
  reconnectFix,
  unitForChange,
  orderedUnion,
  validateFlow,
  wireId,
  wiresOf,
  groupPicks,
  insertPicks,
  placePlan,
  cycles,
  changeGroups,
  connectorSlots,
  mainSlot,
  ERROR,
  WARNING,
  SAME,
  DIFFERS,
  OURS,
  THEIRS,
  CONFLICT,
  THREE_WAY,
  TWO_WAY
} from "c/flowMerge";
import {
  buildModel,
  normalize,
  NODE_COLLECTIONS,
  RESOURCE_COLLECTIONS
} from "c/flowModel";
import { diffFlows } from "c/flowDiff";
import { fromXml, toXml } from "c/flowXml";
import { step, small, grown, branchy } from "fixtures/synthetic";

const versions = [1, 2, 3, 4].map((v) =>
  require(`fixtures/flows/Case_Email_Routing/v${v}.json`)
);
const v4 = versions[3];
const copy = (value) => JSON.parse(JSON.stringify(value));

// Metadata without the status, with element lists in name order: a merge
// keeps the target's element order, which carries no meaning.
function comparable(metadata) {
  const out = normalize(metadata.Metadata || metadata);
  delete out.status;
  for (const key of [...NODE_COLLECTIONS, ...RESOURCE_COLLECTIONS]) {
    if (Array.isArray(out[key])) {
      out[key] = [...out[key]].sort((a, b) => (a.name < b.name ? -1 : 1));
    }
  }
  return out;
}

const fs = require("fs");
const path = require("path");
const root = path.join(process.cwd(), "test/fixtures/flows");
const allFlows = fs
  .readdirSync(root)
  .flatMap((flow) =>
    fs
      .readdirSync(path.join(root, flow))
      .map((file) => require(`fixtures/flows/${flow}/${file}`))
  );

describe("orderedUnion", () => {
  it("keeps the first order and slots new keys in after their predecessor", () => {
    expect(
      orderedUnion([
        ["a", "b", "c"],
        ["a", "x", "c", "y"]
      ])
    ).toEqual(["a", "b", "x", "c", "y"]);
    expect(
      orderedUnion([
        ["a", "b"],
        ["z", "a"]
      ])
    ).toEqual(["z", "a", "b"]);
  });

  it("puts keys from later lists after earlier insertions at the same point", () => {
    expect(
      orderedUnion([
        ["a", "o"],
        ["a", "t"]
      ])
    ).toEqual(["a", "o", "t"]);
  });
});

describe("two-way merge", () => {
  it("has nothing to pick between a flow and itself", () => {
    const merge = createMerge({ before: v4, after: v4 });
    expect(merge.mode).toBe(TWO_WAY);
    expect(changedUnits(merge)).toEqual([]);
    const result = resolveMerge(merge);
    expect(comparable(result.metadata)).toEqual(comparable(v4));
    expect(result.errors).toBe(0);
  });

  it("offers the rewired connector between versions 3 and 4", () => {
    const merge = createMerge({ before: versions[2], after: v4 });
    const units = changedUnits(merge);
    expect(units.map((unit) => unit.id)).toEqual([
      "edge|loop_matching_templates.nextValueConnector"
    ]);
    expect(units[0].status).toBe(DIFFERS);
    expect(comparable(resolveMerge(merge).metadata)).toEqual(
      comparable(versions[2])
    );
    const taken = resolveMerge(merge, { [units[0].id]: "after" });
    expect(comparable(taken.metadata)).toEqual(comparable(v4));
  });

  it("gives either flow back when every unit takes its side, for every fixture pair", () => {
    for (const a of allFlows) {
      for (const b of allFlows) {
        const merge = createMerge({ before: a, after: b });
        expect(
          comparable(resolveMerge(merge, presetPicks(merge, "after")).metadata)
        ).toEqual(comparable(b));
        expect(comparable(resolveMerge(merge).metadata)).toEqual(comparable(a));
      }
    }
  });

  it("follows the picked side's outcome order", () => {
    const reordered = copy(v4);
    const decision = reordered.Metadata.decisions.find(
      (d) => d.rules && d.rules.length > 0
    );
    decision.rules.push({
      ...copy(decision.rules[0]),
      name: "Second",
      label: "Second"
    });
    const swapped = copy(reordered);
    swapped.Metadata.decisions
      .find((d) => d.name === decision.name)
      .rules.reverse();
    const merge = createMerge({ before: reordered, after: swapped });
    expect(changedUnits(merge).map((unit) => unit.id)).toEqual([
      `order|${decision.name}|rules`
    ]);
    const result = resolveMerge(merge, presetPicks(merge, "after"));
    expect(comparable(result.metadata)).toEqual(comparable(swapped));
  });

  it("pulls in the resources an accepted element uses", () => {
    const after = copy(v4);
    after.Metadata.variables.push({
      name: "newCounter",
      dataType: "Number",
      isCollection: false,
      isInput: false,
      isOutput: false,
      scale: 0
    });
    after.Metadata.assignments.push({
      name: "Count_It",
      label: "Count It",
      locationX: 100,
      locationY: 900,
      assignmentItems: [
        {
          assignToReference: "newCounter",
          operator: "Add",
          value: { numberValue: 1 }
        }
      ]
    });
    const merge = createMerge({ before: v4, after });
    expect(
      changedUnits(merge)
        .map((unit) => unit.id)
        .sort()
    ).toEqual(["node|Count_It", "resource|newCounter"]);

    const result = resolveMerge(
      merge,
      picksForNode(merge, "Count_It", "after")
    );
    expect(result.autoIncluded).toEqual(["resource|newCounter"]);
    expect(result.model.resources.has("newCounter")).toBe(true);
    // Version 4 already strands a decision; the new element isn't wired in.
    expect(result.errors).toBe(0);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "unreachable", nodeKey: "Count_It" })
    );

    // An explicit pick wins over the automatic one, and the gap is an error.
    const refused = resolveMerge(merge, {
      ...picksForNode(merge, "Count_It", "after"),
      "resource|newCounter": "before"
    });
    expect(refused.autoIncluded).toEqual([]);
    expect(refused.issues).toContainEqual(
      expect.objectContaining({
        code: "missingReference",
        name: "newCounter",
        nodeKey: "Count_It"
      })
    );
    expect(refused.errors).toBe(1);
  });

  it("flags a connector to an element that wasn't taken", () => {
    const merge = createMerge({ before: versions[2], after: v4 });
    const after = copy(v4);
    after.Metadata.loops[0].nextValueConnector.targetReference = "Nowhere";
    const bad = createMerge({ before: v4, after });
    const result = resolveMerge(bad, presetPicks(bad, "after"));
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "danglingConnector",
        nodeKey: "loop_matching_templates",
        name: "Nowhere"
      })
    );
    expect(resolveMerge(merge).errors).toBe(0);
  });

  it("offers to reconnect an element nothing leads to", () => {
    const after = copy(v4);
    after.Metadata.decisions.find(
      (element) => element.name === "Should_Case_Be_Updated"
    ).defaultConnector.targetReference = "Log_Result";
    after.Metadata.assignments.push({
      name: "Log_Result",
      label: "Log Result",
      locationX: 0,
      locationY: 0,
      assignmentItems: [],
      connector: { targetReference: "Unhandled_Case_Update" }
    });
    const merge = createMerge({ before: v4, after });
    const edge = changedUnits(merge).find((unit) => unit.kind === "edge");
    // The new element, but the old connector: nothing leads to it.
    const picks = {
      ...picksForNode(merge, "Log_Result", "after"),
      [edge.id]: "before"
    };
    const stranded = resolveMerge(merge, picks);
    expect(stranded.issues).toContainEqual(
      expect.objectContaining({ code: "unreachable", nodeKey: "Log_Result" })
    );
    const fix = reconnectFix(merge, stranded, "Log_Result");
    expect(fix).toEqual({ unitId: edge.id, side: "after", edgeUnit: edge });

    const fixed = resolveMerge(merge, { ...picks, [fix.unitId]: fix.side });
    expect(
      fixed.issues.filter((issue) => issue.nodeKey === "Log_Result")
    ).toEqual([]);
    expect(reconnectFix(merge, fixed, "Log_Result")).toBeUndefined();
  });

  it("drops a connector whose outcome was left out", () => {
    const after = copy(v4);
    const decision = after.Metadata.decisions[0];
    decision.rules.push({
      name: "Extra",
      label: "Extra",
      conditionLogic: "and",
      conditions: copy(decision.rules[0].conditions),
      connector: {
        targetReference: decision.rules[0].connector.targetReference
      }
    });
    const merge = createMerge({ before: v4, after });
    const edgeId = `edge|${decision.name}.rules.Extra.connector`;
    expect(merge.units.get(edgeId).status).toBe(DIFFERS);
    const result = resolveMerge(merge, { [edgeId]: "after" });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "droppedConnector", unitId: edgeId })
    );
    const both = resolveMerge(merge, {
      [edgeId]: "after",
      [`field|${decision.name}|rules|Extra`]: "after"
    });
    expect(comparable(both.metadata)).toEqual(comparable(after));
  });

  it("drops an outcome's connector when the merged decision has no outcomes", () => {
    const withDecision = (rules) => ({
      ...small(),
      decisions: [
        {
          name: "Check",
          label: "Check",
          locationX: 0,
          locationY: 300,
          defaultConnector: { targetReference: "B" },
          ...(rules ? { rules } : {})
        }
      ]
    });
    const before = withDecision([
      {
        name: "Big",
        label: "Big",
        conditionLogic: "and",
        conditions: [
          {
            leftValueReference: "Count",
            operator: "GreaterThan",
            rightValue: { numberValue: 5 }
          }
        ],
        connector: { targetReference: "A" }
      }
    ]);
    const merge = createMerge({ before, after: withDecision() });
    const result = resolveMerge(merge, {
      "field|Check|rules|Big": "after",
      "edge|Check.rules.Big.connector": "before"
    });
    const decision = result.metadata.decisions[0];
    expect(decision.rules).toBeUndefined();
    expect(result.issues.map((issue) => issue.code)).toContain(
      "droppedConnector"
    );
  });

  it("doesn't count an action's parameter names as names the flow defines", () => {
    const action = {
      name: "Act",
      label: "Act",
      locationX: 0,
      locationY: 300,
      actionName: "Notify",
      actionType: "apex",
      inputParameters: [
        { name: "recordId", value: { elementReference: "recordId" } }
      ]
    };
    const flow = { ...small(), actionCalls: [action] };
    const side = {
      ...flow,
      variables: [
        ...flow.variables,
        { name: "recordId", dataType: "String", isCollection: false }
      ]
    };
    const issues = validateFlow(buildModel(flow), [buildModel(side)]);
    expect(
      issues.some(
        (issue) =>
          issue.code === "missingReference" && issue.name === "recordId"
      )
    ).toBe(true);
    expect(validateFlow(buildModel(side), [buildModel(side)])).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ code: "missingReference" })
      ])
    );
  });

  it("combines two unrelated flows and reports clashing names", () => {
    const lead = require("fixtures/flows/lead_automation_test/v1.json");
    const merge = createMerge({ before: v4, after: lead });
    const union = resolveMerge(merge, presetPicks(merge, "union"));
    for (const key of buildModel(lead).nodes.keys()) {
      expect(union.model.nodes.has(key)).toBe(true);
    }
    for (const key of buildModel(v4).nodes.keys()) {
      expect(union.model.nodes.has(key)).toBe(true);
    }

    const clash = copy(v4);
    clash.Metadata.variables.push({
      name: "Get_Routing",
      dataType: "String",
      isCollection: false,
      isInput: false,
      isOutput: false
    });
    const issues = validateFlow(buildModel(clash));
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "nameClash", name: "Get_Routing" })
    );
  });

  it("reports a name defined twice in hand-edited XML, which the model keeps once", () => {
    const edited = copy(v4);
    const variable = edited.Metadata.variables[0];
    edited.Metadata.variables.push({ ...variable, dataType: "Number" });
    const decision = edited.Metadata.decisions[0];
    edited.Metadata.assignments = [
      ...(edited.Metadata.assignments || []),
      { name: decision.name, label: "Also", locationX: 0, locationY: 0 }
    ];
    // Read back from XML, as the text merge checks a hand edit.
    const model = buildModel(fromXml(toXml(normalize(edited.Metadata)).text));
    expect(model.resources.get(variable.name).fields.dataType).toBe("Number");
    const errors = validateFlow(model).filter(
      (issue) => issue.code === "duplicateName"
    );
    expect(errors).toEqual([
      expect.objectContaining({
        severity: ERROR,
        name: decision.name,
        nodeKey: decision.name
      }),
      expect.objectContaining({
        severity: ERROR,
        name: variable.name,
        resourceKey: variable.name
      })
    ]);
    expect(errors[1].message).toContain("variables, variables");
  });

  it("finds no repeated names in any version read from Salesforce", () => {
    for (const record of allFlows) {
      expect(buildModel(record).duplicates).toEqual([]);
    }
  });

  describe("resources a picked part uses in turn", () => {
    const formula = (name, expression) => ({
      name,
      dataType: "Number",
      scale: 0,
      expression
    });
    const variable = (name) => ({
      name,
      dataType: "Number",
      scale: 0,
      isCollection: false
    });
    // Use → F0 → F1 and T1; F1 → F2 → V1 and C1; T1 → V2, and back to F0.
    const after = () => {
      const flow = small();
      flow.assignments.push(
        step("Use", "Use", 300, {
          assignmentItems: [
            {
              assignToReference: "Count",
              operator: "Add",
              value: { elementReference: "F0" }
            }
          ]
        })
      );
      flow.formulas = [
        formula("F0", "{!F1} + LEN({!T1})"),
        formula("F1", "{!F2}"),
        formula("F2", "{!V1} + {!C1}")
      ];
      flow.textTemplates = [{ name: "T1", text: "{!F0} and {!V2}" }];
      flow.variables.push(variable("V1"), variable("V2"));
      flow.constants = [
        { name: "C1", dataType: "Number", value: { numberValue: 2 } }
      ];
      return flow;
    };

    it("brings the whole chain, round by round, and checks the result", () => {
      const merge = createMerge({ before: small(), after: after() });
      const result = resolveMerge(merge, picksForNode(merge, "Use", "after"));
      expect(result.autoIncluded).toEqual([
        "resource|F0",
        "resource|F1",
        "resource|T1",
        "resource|F2",
        "resource|V2",
        "resource|V1",
        "resource|C1"
      ]);
      expect(result.errors).toBe(0);
      expect([...result.model.resources.keys()].sort()).toEqual(
        ["C1", "Count", "F0", "F1", "F2", "T1", "V1", "V2"].sort()
      );
    });

    it("stops where a resource is picked out, and says what's missing", () => {
      const merge = createMerge({ before: small(), after: after() });
      const result = resolveMerge(merge, {
        ...picksForNode(merge, "Use", "after"),
        "resource|F1": "before"
      });
      expect(result.autoIncluded).toEqual([
        "resource|F0",
        "resource|T1",
        "resource|V2"
      ]);
      expect(
        result.issues.filter((issue) => issue.code === "missingReference")
      ).toEqual([
        expect.objectContaining({
          name: "F1",
          resourceKey: "F0",
          severity: ERROR
        })
      ]);
    });

    it("takes a resource from the side it prefers", () => {
      const flow = after();
      const base = small();
      base.formulas = [formula("F2", "3")];
      const merge = createMerge({ base, ours: small(), theirs: flow });
      // Ours deleted F2, so it isn't in the result until something uses it.
      const picks = picksForNode(merge, "Use", "theirs");
      const result = resolveMerge(merge, picks);
      expect(result.choices["resource|F2"]).toBe("theirs");
      expect(result.model.resources.get("F2").fields.expression).toBe(
        "{!V1} + {!C1}"
      );
      expect(result.errors).toBe(0);
    });
  });

  it("maps diff changes to units", () => {
    const after = copy(v4);
    after.Metadata.decisions[0].rules[0].label = "Renamed";
    after.Metadata.decisions[0].label = "Relabelled";
    const merge = createMerge({ before: v4, after });
    const diff = diffFlows(v4, after);
    const entry = diff.nodes.find((e) => e.status === "changed");
    const ids = entry.changes.map(
      (change) => unitForChange(merge, "node", entry.key, change.path).id
    );
    const name = after.Metadata.decisions[0].name;
    const rule = after.Metadata.decisions[0].rules[0].name;
    expect(ids.sort()).toEqual([
      `field|${name}|label`,
      `field|${name}|rules|${rule}`
    ]);
  });
});

describe("three-way merge", () => {
  const ours = copy(v4);
  ours.Metadata.decisions[0].label = "Ours";
  const theirs = copy(v4);
  theirs.Metadata.recordLookups[0].label = "Theirs";
  theirs.Metadata.assignments[0].locationX += 40;

  it("applies changes made on one side only", () => {
    const merge = createMerge({ base: v4, ours, theirs });
    expect(merge.mode).toBe(THREE_WAY);
    const statuses = Object.fromEntries(
      changedUnits(merge).map((unit) => [unit.id, unit.status])
    );
    expect(Object.values(statuses).sort()).toEqual([OURS, THEIRS, THEIRS]);
    const result = resolveMerge(merge);
    expect(result.conflicts).toEqual([]);
    const expected = copy(ours);
    expected.Metadata.recordLookups[0].label = "Theirs";
    expected.Metadata.assignments[0].locationX += 40;
    expect(comparable(result.metadata)).toEqual(comparable(expected));
  });

  it("reports conflicting changes and resolves them by pick", () => {
    const other = copy(theirs);
    other.Metadata.decisions[0].label = "Theirs too";
    const merge = createMerge({ base: v4, ours, theirs: other });
    const name = v4.Metadata.decisions[0].name;
    const id = `field|${name}|label`;
    expect(merge.units.get(id).status).toBe(CONFLICT);
    const result = resolveMerge(merge);
    expect(result.conflicts).toEqual([id]);
    expect(result.model.nodes.get(name).label).toBe("Ours");
    const picked = resolveMerge(merge, { [id]: "theirs" });
    expect(picked.conflicts).toEqual([]);
    expect(picked.model.nodes.get(name).label).toBe("Theirs too");
  });

  it("treats an edit against a deletion as a conflict", () => {
    const deleted = copy(v4);
    deleted.Metadata.assignments = [];
    const edited = copy(v4);
    edited.Metadata.assignments[0].label = "Edited";
    const merge = createMerge({ base: v4, ours: edited, theirs: deleted });
    const key = v4.Metadata.assignments[0].name;
    expect(merge.units.get(`node|${key}`).status).toBe(CONFLICT);
    expect(resolveMerge(merge).model.nodes.get(key).label).toBe("Edited");
  });

  it("lets a deletion through when the other side only moved the element", () => {
    const deleted = copy(v4);
    deleted.Metadata.assignments = [];
    const moved = copy(v4);
    moved.Metadata.assignments[0].locationY += 320;
    const merge = createMerge({ base: v4, ours: moved, theirs: deleted });
    const key = v4.Metadata.assignments[0].name;
    expect(merge.units.get(`node|${key}`).status).toBe(THEIRS);
    const result = resolveMerge(merge);
    expect(result.conflicts).not.toContain(`node|${key}`);
    expect(result.model.nodes.has(key)).toBe(false);
  });

  it("keeps ours' place for an element both added alike in different places", () => {
    const add = (y) => {
      const flow = copy(v4);
      flow.Metadata.assignments.push({
        ...copy(v4.Metadata.assignments[0]),
        name: "Both_Added",
        label: "Both added",
        locationY: y
      });
      return flow;
    };
    const merge = createMerge({ base: v4, ours: add(100), theirs: add(900) });
    expect(merge.units.get("node|Both_Added").status).toBe(OURS);
    expect(resolveMerge(merge).model.nodes.get("Both_Added").y).toBe(100);
  });

  const addRule = (flow, name, index) => {
    const decision = flow.Metadata.decisions[0];
    const rule = {
      name,
      label: name,
      conditionLogic: "and",
      conditions: copy(decision.rules[0].conditions)
    };
    decision.rules.splice(
      index === undefined ? decision.rules.length : index,
      0,
      rule
    );
  };
  const ruleNames = (result) =>
    result.model.nodes
      .get(v4.Metadata.decisions[0].name)
      .fields.rules.map((rule) => rule.name);

  it("asks which goes first when both sides add an outcome in the same place", () => {
    const a = copy(v4);
    addRule(a, "From_Ours");
    const b = copy(v4);
    addRule(b, "From_Theirs");
    const merge = createMerge({ base: v4, ours: a, theirs: b });
    const order = `order|${v4.Metadata.decisions[0].name}|rules`;
    const result = resolveMerge(merge);
    expect(result.conflicts).toEqual([order]);
    expect(ruleNames(result).slice(-2)).toEqual(["From_Ours", "From_Theirs"]);
    const theirsFirst = resolveMerge(merge, { [order]: "theirs" });
    expect(theirsFirst.conflicts).toEqual([]);
    expect(ruleNames(theirsFirst).slice(-2)).toEqual([
      "From_Theirs",
      "From_Ours"
    ]);
  });

  it("merges outcomes added in different places without asking", () => {
    const a = copy(v4);
    addRule(a, "From_Ours", 0);
    const b = copy(v4);
    addRule(b, "From_Theirs");
    const result = resolveMerge(createMerge({ base: v4, ours: a, theirs: b }));
    expect(result.conflicts).toEqual([]);
    const rules = ruleNames(result);
    expect(rules[0]).toBe("From_Ours");
    expect(rules[rules.length - 1]).toBe("From_Theirs");
  });

  it("flags an outcome both sides added in different places", () => {
    const a = copy(v4);
    addRule(a, "Both", 0);
    const b = copy(v4);
    addRule(b, "Both");
    const merge = createMerge({ base: v4, ours: a, theirs: b });
    expect(resolveMerge(merge).conflicts).toContain(
      `order|${v4.Metadata.decisions[0].name}|rules`
    );
  });

  it("shows a conflict in the connectors of an element both sides added", () => {
    const withNew = (target) => ({
      ...small(),
      assignments: [
        ...small().assignments,
        step("New", "New", 300, { connector: { targetReference: target } })
      ]
    });
    const merge = createMerge({
      base: small(),
      ours: withNew("A"),
      theirs: withNew("B")
    });
    expect(merge.units.get("node|New").status).toBe(CONFLICT);
    expect(changedUnits(merge).map((unit) => unit.id)).toEqual(["node|New"]);
    expect(resolveMerge(merge).conflicts).toEqual(["node|New"]);
    const picked = resolveMerge(merge, { "node|New": "theirs" });
    expect(picked.conflicts).toEqual([]);
    expect(picked.model.edges.get("New.connector").target).toBe("B");

    const same = createMerge({
      base: small(),
      ours: withNew("A"),
      theirs: withNew("A")
    });
    expect(same.units.get("node|New").status).toBe(SAME);
  });

  it("follows an action's paths by pathName when one side reorders them", () => {
    const withAction = (paths) => {
      const flow = small();
      flow.start.connector.targetReference = "Act";
      flow.actionCalls = [
        {
          name: "Act",
          label: "Act",
          locationX: 0,
          locationY: 50,
          actionName: "approve",
          actionType: "apex",
          actionCallPaths: paths.map(([pathName, target]) => ({
            pathName,
            connector: { targetReference: target }
          }))
        }
      ];
      return flow;
    };
    const base = withAction([
      ["Success", "A"],
      ["Failure", "A"]
    ]);
    const reroutes = withAction([
      ["Success", "B"],
      ["Failure", "A"]
    ]);
    const reorders = withAction([
      ["Failure", "A"],
      ["Success", "A"]
    ]);
    const merge = createMerge({
      base,
      ours: reroutes,
      theirs: reorders
    });
    const result = resolveMerge(merge);
    expect(result.conflicts).toEqual([]);
    expect(result.metadata.actionCalls[0].actionCallPaths).toEqual([
      { pathName: "Failure", connector: { targetReference: "A" } },
      { pathName: "Success", connector: { targetReference: "B" } }
    ]);
    expect(connectorSlots(merge.sides.ours.nodes.get("Act"))).toEqual(
      expect.arrayContaining([
        "actionCallPaths.Success.connector",
        "actionCallPaths.Failure.connector"
      ])
    );
    // A wire saved when paths went by position finds no path now.
    const stale = resolveMerge(merge, {
      [wireId("Act", "actionCallPaths.0.connector")]: "B"
    });
    expect(stale.metadata.actionCalls[0].actionCallPaths).toEqual(
      result.metadata.actionCalls[0].actionCallPaths
    );
  });

  it("marks units every side agrees on as the same", () => {
    const merge = createMerge({ base: v4, ours: v4, theirs: v4 });
    expect([...merge.units.values()].every((u) => u.status === SAME)).toBe(
      true
    );
  });
});

const route = (model, from) => {
  const out = [];
  for (let key = from; key;) {
    out.push(key);
    const next = [...model.edges.values()].find(
      (edge) => edge.source === key && edge.kind !== "fault"
    );
    key = next && next.target;
  }
  return out;
};

describe("wires and groups", () => {
  it("rewires a connector to any element, or to nothing", () => {
    const merge = createMerge({ before: small(), after: small() });
    const picks = {
      [wireId("$Start", "connector")]: "B",
      [wireId("A", "connector")]: "",
      "node|A": "before"
    };
    expect(wiresOf(picks)).toEqual([
      {
        id: "wire|$Start|connector",
        source: "$Start",
        slot: "connector",
        target: "B"
      },
      { id: "wire|A|connector", source: "A", slot: "connector", target: "" }
    ]);
    const result = resolveMerge(merge, picks);
    expect(result.wired).toEqual(["wire|$Start|connector", "wire|A|connector"]);
    expect(result.model.edges.get("$Start.connector").target).toBe("B");
    expect(result.model.edges.has("A.connector")).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "unreachable", nodeKey: "A" })
    );
    // A wire undone (null) is no wire.
    expect(wiresOf({ [wireId("A", "connector")]: null })).toEqual([]);
  });

  it("names the connector slots of each kind of element", () => {
    const model = buildModel({
      FullName: "Slots",
      Metadata: {
        ...small(),
        decisions: [
          {
            name: "Check",
            label: "Check",
            rules: [
              { name: "Yes", label: "Yes", conditionLogic: "and" },
              { name: "Maybe", label: "Maybe", conditionLogic: "and" }
            ],
            defaultConnectorLabel: "No"
          }
        ],
        loops: [{ name: "Each", label: "Each", collectionReference: "Count" }],
        recordUpdates: [{ name: "Save", label: "Save", inputReference: "X" }]
      }
    });
    const slots = (key) => connectorSlots(model.nodes.get(key));
    expect(slots("Check")).toEqual([
      "rules.Yes.connector",
      "rules.Maybe.connector",
      "defaultConnector"
    ]);
    expect(mainSlot(model.nodes.get("Check"))).toBe("defaultConnector");
    expect(slots("Each")).toEqual([
      "nextValueConnector",
      "noMoreValuesConnector"
    ]);
    expect(mainSlot(model.nodes.get("Each"))).toBe("nextValueConnector");
    expect(slots("Save")).toEqual(["connector", "faultConnector"]);
    expect(slots("A")).toEqual(["connector"]);
    expect(connectorSlots(undefined)).toEqual([]);
    const old = buildModel({
      FullName: "Old",
      Metadata: { ...small(), start: undefined, startElementReference: "A" }
    });
    expect(connectorSlots(old.nodes.get("$Start"))).toEqual([
      "startElementReference"
    ]);
  });

  it("groups changed elements that connectors join", () => {
    const merge = createMerge({ before: small(), after: grown() });
    const groups = changeGroups(merge);
    expect(groups.map((group) => [...group.keys].sort())).toEqual([
      ["A", "X1", "X2"],
      ["Y1", "Y2"]
    ]);
    expect(groups[0]).toMatchObject({ added: 2, removed: 0, changed: 1 });
    expect(groups[1]).toMatchObject({ added: 2, removed: 0, changed: 0 });
  });

  it("takes a group in one step, and leaves it out without dangling connectors", () => {
    const merge = createMerge({ before: small(), after: grown() });
    const [group] = changeGroups(merge);
    const taken = resolveMerge(merge, groupPicks(merge, group.keys, "after"));
    expect(route(taken.model, "$Start")).toEqual([
      "$Start",
      "A",
      "X1",
      "X2",
      "B"
    ]);
    expect(taken.errors).toBe(0);

    // A's connector and a wire lead into X1; leaving X1 and X2 out
    // sends A back to B and undoes the wire.
    const current = {
      ...groupPicks(merge, group.keys, "after"),
      [wireId("B", "connector")]: "X1"
    };
    const out = groupPicks(merge, ["X1", "X2"], "before", current);
    expect(out["edge|A.connector"]).toBe("before");
    expect(out["wire|B|connector"]).toBeNull();
    const left = resolveMerge(merge, { ...current, ...out });
    expect(left.model.nodes.has("X1")).toBe(false);
    expect(route(left.model, "$Start")).toEqual(["$Start", "A", "B"]);
    expect(left.errors).toBe(0);
  });

  it("puts elements from the other side on a path", () => {
    const merge = createMerge({ before: small(), after: grown() });
    const resolved = resolveMerge(merge);
    const between = insertPicks(
      merge,
      resolved,
      ["Y1", "Y2"],
      "after",
      "A",
      "connector"
    );
    expect(between).toMatchObject({
      "node|Y1": "after",
      "node|Y2": "after",
      "wire|A|connector": "Y1",
      "wire|Y2|connector": "B"
    });
    const result = resolveMerge(merge, between);
    expect(route(result.model, "$Start")).toEqual([
      "$Start",
      "A",
      "Y1",
      "Y2",
      "B"
    ]);
    expect(result.issues).toEqual([]);

    // At the end of the flow: nothing to go on to.
    const end = insertPicks(
      merge,
      resolved,
      ["Y1", "Y2"],
      "after",
      "B",
      "connector"
    );
    expect(end["wire|Y2|connector"]).toBeNull();
    expect(route(resolveMerge(merge, end).model, "A")).toEqual([
      "A",
      "B",
      "Y1",
      "Y2"
    ]);

    // Placed again, it doesn't keep the way on the first placement gave
    // it, which would now lead back round to B.
    const placed = resolveMerge(merge, between);
    const again = {
      ...between,
      ...insertPicks(merge, placed, ["Y1", "Y2"], "after", "B", "connector")
    };
    const moved = resolveMerge(merge, again).model;
    expect(moved.edges.has("Y2.connector")).toBe(false);
    expect(route(moved, "B")).toEqual(["B", "Y1", "Y2"]);
    expect(cycles(moved)).toEqual([]);

    // Told where the path goes in.
    const into = insertPicks(
      merge,
      resolved,
      ["Y1", "Y2"],
      "after",
      "A",
      "connector",
      "Y2"
    );
    expect(into["wire|A|connector"]).toBe("Y2");
  });

  // X is an Action in one version and an Assignment in the other, which
  // has no fault path.
  const retyped = (extra = {}) => {
    const action = small();
    action.assignments[0].connector.targetReference = "X";
    action.actionCalls = [
      {
        name: "X",
        label: "X",
        locationX: 0,
        locationY: 150,
        actionName: "chatterPost",
        actionType: "chatterPost",
        connector: { targetReference: "B" },
        ...extra
      }
    ];
    const assignment = small();
    assignment.assignments[0].connector.targetReference = "X";
    assignment.assignments.push(
      step("X", "X", 150, { connector: { targetReference: "B" } })
    );
    return createMerge({ before: action, after: assignment });
  };
  const faultOf = (result) =>
    result.metadata.assignments.find((item) => item.name === "X")
      .faultConnector;

  it("doesn't keep a wire the placed element's type has no room for", () => {
    const merge = retyped();
    const current = { "node|X": "before", "wire|X|faultConnector": "B" };
    const resolved = resolveMerge(merge, current);
    expect(resolved.model.edges.get("X.faultConnector").target).toBe("B");
    const placed = insertPicks(
      merge,
      resolved,
      ["X"],
      "after",
      "A",
      "connector"
    );
    expect(placed["wire|X|faultConnector"]).toBeNull();
    expect(faultOf(resolveMerge(merge, { ...current, ...placed }))).toBe(
      undefined
    );
  });

  it("undoes a path cut on the element's other type when it is placed", () => {
    const merge = retyped({ faultConnector: { targetReference: "A" } });
    const current = { "node|X": "before", "wire|X|faultConnector": "" };
    const resolved = resolveMerge(merge, current);
    expect(resolved.model.edges.has("X.faultConnector")).toBe(false);
    const placed = insertPicks(
      merge,
      resolved,
      ["X"],
      "after",
      "A",
      "connector"
    );
    expect(placed["wire|X|faultConnector"]).toBeNull();
    // Picking the Action again brings back its own fault path.
    const back = resolveMerge(merge, {
      ...current,
      ...placed,
      "node|X": "before"
    });
    expect(back.model.edges.get("X.faultConnector").target).toBe("A");
  });

  it("leaves out a wire the picked element's type has no room for", () => {
    const merge = retyped();
    const result = resolveMerge(merge, {
      "node|X": "after",
      "wire|X|faultConnector": "B"
    });
    expect(result.model.edges.has("X.faultConnector")).toBe(false);
    expect(faultOf(result)).toBe(undefined);
    expect(
      result.metadata.assignments.find((item) => item.name === "X")
    ).toMatchObject({ connector: { targetReference: "B" } });
  });
});

describe("placing a group", () => {
  const merge = createMerge({ before: small(), after: branchy() });
  const resolved = resolveMerge(merge);
  const plan = (keys, afterKey, options) =>
    placePlan(merge, resolved, keys, "after", afterKey, "connector", options);
  const exit = (found, id) => found.exits.find((item) => item.id === id);

  it("asks before a fault path whose handler isn't brought goes anywhere", () => {
    const branch = ["D", "P1", "P2", "Q1"];
    const found = plan(branch, "A");
    expect(found).toMatchObject({ entry: "D", entries: ["D"], next: "B" });
    expect(found.open).toBe(1);
    expect(exit(found, "wire|P1|faultConnector")).toMatchObject({
      kind: "fault",
      target: "H",
      value: "",
      choice: true,
      decided: false
    });
    // The path that ended goes on; the one that rejoined B still does.
    expect(exit(found, "wire|P2|connector")).toMatchObject({
      kind: "next",
      value: "B"
    });
    expect(exit(found, "wire|Q1|connector")).toMatchObject({ value: "B" });
    expect(found.dependencies).toEqual(["Rec"]);
    expect(found.detached).toEqual([]);

    // Until someone says, the fault path is left unhandled, not rerouted.
    const left = resolveMerge(merge, found.picks);
    expect(left.model.edges.has("P1.faultConnector")).toBe(false);
    expect(route(left.model, "$Start")).toEqual([
      "$Start",
      "A",
      "D",
      "P1",
      "P2",
      "B"
    ]);
    expect(left.model.edges.get("D.defaultConnector").target).toBe("Q1");
    expect(left.model.edges.get("P2.connector").target).toBe("B");
    expect(left.errors).toBe(0);

    const told = plan(branch, "A", {
      routes: { "wire|P1|faultConnector": "B" }
    });
    expect(told.open).toBe(0);
    expect(
      resolveMerge(merge, told.picks).model.edges.get("P1.faultConnector")
        .target
    ).toBe("B");
    // Only the offered ways count as an answer.
    expect(
      plan(branch, "A", { routes: { "wire|P1|faultConnector": "Z" } }).open
    ).toBe(1);
  });

  it("keeps a brought fault handler's path ended unless told otherwise", () => {
    const found = plan(["D", "P1", "P2", "Q1", "H"], "A");
    expect(exit(found, "wire|P1|faultConnector")).toBeUndefined();
    expect(exit(found, "wire|H|connector")).toMatchObject({
      value: "",
      choice: true,
      decided: false
    });
    expect(found.open).toBe(1);
    const result = resolveMerge(merge, found.picks);
    expect(result.model.edges.get("P1.faultConnector").target).toBe("H");
    expect(result.model.edges.has("H.connector")).toBe(false);
    const on = plan(["D", "P1", "P2", "Q1", "H"], "A", {
      routes: { "wire|H|connector": "B" }
    });
    expect(on.open).toBe(0);
    expect(on.picks["wire|H|connector"]).toBe("B");
  });

  it("goes on after a Loop is done, and doesn't count its round as a cycle", () => {
    const found = plan(["LB", "L"], "A");
    expect(found).toMatchObject({ entry: "L", entries: ["L"], open: 0 });
    expect(exit(found, "wire|L|noMoreValuesConnector")).toMatchObject({
      kind: "next",
      value: "B"
    });
    const result = resolveMerge(merge, found.picks);
    expect(result.model.edges.get("A.connector").target).toBe("L");
    expect(result.model.edges.get("L.nextValueConnector").target).toBe("LB");
    expect(result.model.edges.get("LB.connector").target).toBe("L");
    expect(result.model.edges.get("L.noMoreValuesConnector").target).toBe("B");
    expect(found.cycles).toEqual([]);
    expect(result.issues.filter((issue) => issue.code === "cycle")).toEqual([]);
  });

  it("asks whether the way out goes back where it did, and reports the round", () => {
    const found = plan(["R"], "B");
    expect(found.next).toBeUndefined();
    expect(exit(found, "wire|R|connector")).toMatchObject({
      value: "",
      choice: true,
      decided: false,
      options: [
        { value: "", label: "End" },
        { value: "A", label: "Go where it did" }
      ]
    });
    expect(found.open).toBe(1);
    expect(found.cycles).toEqual([]);

    const back = plan(["R"], "B", { routes: { "wire|R|connector": "A" } });
    expect(back.open).toBe(0);
    expect(back.cycles).toEqual([["A", "B", "R"]]);
    const result = resolveMerge(merge, back.picks);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "cycle",
        severity: WARNING,
        keys: ["A", "B", "R"]
      })
    );
  });

  it("makes the way in a choice when a group has more than one", () => {
    const found = plan(["E1", "E2", "M"], "A");
    expect(found.entries).toEqual(["E1", "E2"]);
    expect(found.open).toBe(1);
    expect(found.detached).toEqual(["E2"]);
    const chosen = plan(["E1", "E2", "M"], "A", { first: "E2" });
    expect(chosen).toMatchObject({ entry: "E2", open: 0, detached: ["E1"] });
    expect(route(resolveMerge(merge, chosen.picks).model, "$Start")).toEqual([
      "$Start",
      "A",
      "E2",
      "M",
      "B"
    ]);
  });

  it("names connectors into the group it doesn't bring", () => {
    expect(plan(["M"], "A").incoming).toEqual([
      { source: "E1", slot: "connector", target: "M" },
      { source: "E2", slot: "connector", target: "M" }
    ]);
  });

  it("gives the same picks as insertPicks, and checks against the picks so far", () => {
    const routes = { "wire|R|connector": "A" };
    expect(
      insertPicks(
        merge,
        resolved,
        ["R"],
        "after",
        "B",
        "connector",
        undefined,
        routes
      )
    ).toEqual(plan(["R"], "B", { routes }).picks);
    // With A's path already ending at A, R's return makes no round.
    const current = { [wireId("A", "connector")]: "" };
    expect(plan(["R"], "B", { routes, current }).cycles).toEqual([]);
  });
});

describe("leaving a group out", () => {
  it("sends a new element's connector on past the group", () => {
    const after = grown();
    after.assignments.push(
      step("P", "P", 700, { connector: { targetReference: "X1" } })
    );
    const merge = createMerge({ before: small(), after });
    const current = picksForNode(merge, "P", "after");
    const out = groupPicks(merge, ["X1", "X2"], "before", current);
    expect(out["wire|P|connector"]).toBe("B");
    const result = resolveMerge(merge, { ...current, ...out });
    expect(result.model.nodes.has("X1")).toBe(false);
    expect(result.model.edges.get("P.connector").target).toBe("B");
    expect(
      result.issues.filter((issue) => issue.code === "danglingConnector")
    ).toEqual([]);
    expect(result.errors).toBe(0);
  });

  it("keeps the way past the group when a wire already led into it", () => {
    const after = grown();
    after.assignments.push(
      step("P", "P", 700, { connector: { targetReference: "X1" } })
    );
    const merge = createMerge({ before: small(), after });
    // P's path was put into X1 by hand, as placing X1 after P does.
    const current = {
      ...picksForNode(merge, "P", "after"),
      [wireId("P", "connector")]: "X1"
    };
    const out = groupPicks(merge, ["X1", "X2"], "before", current);
    expect(out["wire|P|connector"]).toBe("B");
    const result = resolveMerge(merge, { ...current, ...out });
    expect(result.model.edges.get("P.connector").target).toBe("B");
    expect(result.errors).toBe(0);
  });

  it("leaves a wire that already leads outside the group", () => {
    const after = grown();
    after.assignments.push(
      step("P", "P", 700, { connector: { targetReference: "X1" } })
    );
    const merge = createMerge({ before: small(), after });
    const current = {
      ...picksForNode(merge, "P", "after"),
      [wireId("P", "connector")]: "Y1"
    };
    const out = groupPicks(merge, ["X1", "X2"], "before", current);
    expect(out["wire|P|connector"]).toBeUndefined();
    const result = resolveMerge(merge, { ...current, ...out });
    expect(result.model.edges.get("P.connector").target).toBe("Y1");
  });

  it("ends a connector whose path went nowhere else", () => {
    const after = grown();
    after.assignments.push(
      step("P", "P", 700, { connector: { targetReference: "Y1" } })
    );
    const merge = createMerge({ before: small(), after });
    const current = picksForNode(merge, "P", "after");
    const out = groupPicks(merge, ["Y1", "Y2"], "before", current);
    expect(out["wire|P|connector"]).toBe("");
    const result = resolveMerge(merge, { ...current, ...out });
    expect(result.model.edges.has("P.connector")).toBe(false);
    expect(result.errors).toBe(0);
  });
});

describe("cycles", () => {
  const model = (extra) =>
    buildModel({
      FullName: "Round",
      Metadata: {
        ...small(),
        loops: [
          {
            name: "L",
            label: "L",
            collectionReference: "Items",
            nextValueConnector: { targetReference: "A" },
            noMoreValuesConnector: { targetReference: "B" }
          }
        ],
        variables: [
          ...small().variables,
          { name: "Items", dataType: "String", isCollection: true }
        ],
        ...extra
      }
    });

  it("doesn't count a Loop going round its items", () => {
    const flow = model({
      assignments: [
        step("A", "A", 100, { connector: { targetReference: "L" } }),
        step("B", "B", 200)
      ],
      start: { connector: { targetReference: "L" } }
    });
    expect(cycles(flow)).toEqual([]);
  });

  it("counts coming back to a Loop once it's done", () => {
    const flow = model({
      assignments: [
        step("A", "A", 100, { connector: { targetReference: "L" } }),
        step("B", "B", 200, { connector: { targetReference: "L" } })
      ],
      start: { connector: { targetReference: "L" } }
    });
    expect(cycles(flow)).toEqual([["B", "L"]]);
    expect(validateFlow(flow)).toContainEqual(
      expect.objectContaining({ code: "cycle", nodeKey: "B" })
    );
  });

  it("counts an element that leads to itself", () => {
    const flow = model({
      assignments: [
        step("A", "A", 100, { connector: { targetReference: "A" } }),
        step("B", "B", 200)
      ]
    });
    expect(cycles(flow)).toEqual([["A"]]);
  });
});

describe("screen checks", () => {
  it("flags a trigger that runs an action its screen doesn't have", () => {
    const screen = (handler) =>
      buildModel({
        label: "Screens",
        processType: "Flow",
        start: { connector: { targetReference: "S" } },
        screens: [
          {
            name: "S",
            label: "S",
            actions: [{ name: "Fetch", label: "Fetch", actionName: "Fetch" }],
            triggers: [
              {
                eventName: "change",
                eventSource: "S",
                handlers: [{ screenActionName: handler }]
              }
            ]
          }
        ]
      });
    const missing = (model) =>
      validateFlow(model).filter(
        (issue) => issue.code === "missingScreenAction"
      );
    expect(missing(screen("fetch"))).toEqual([]);
    expect(missing(screen("Fetch_2"))).toEqual([
      expect.objectContaining({
        severity: ERROR,
        nodeKey: "S",
        name: "Fetch_2"
      })
    ]);
  });
  it("flags a trigger on a component the merge took off its screen", () => {
    const picker = {
      name: "Case_Picker",
      fieldType: "InputField",
      dataType: "String",
      fieldText: "Case"
    };
    const screen = (extra) => ({
      label: "Screens",
      processType: "Flow",
      start: { connector: { targetReference: "S" } },
      screens: [{ name: "S", label: "S", fields: [picker], ...extra }]
    });
    const base = screen();
    // Ours takes the picker off; theirs acts when it changes.
    const ours = screen({ fields: [] });
    const theirs = screen({
      actions: [{ name: "FetchCases", label: "Fetch", actionName: "Fetch" }],
      triggers: [
        {
          eventName: "change",
          eventSource: "Case_Picker",
          handlers: [{ screenActionName: "FetchCases" }]
        }
      ]
    });
    const result = resolveMerge(createMerge({ base, ours, theirs }));
    expect(result.conflicts).toEqual([]);
    expect(
      result.issues.filter((issue) => issue.code === "missingEventSource")
    ).toEqual([
      expect.objectContaining({
        severity: ERROR,
        nodeKey: "S",
        name: "Case_Picker"
      })
    ]);

    // Kept, or a source no version defines on the screen, isn't flagged.
    const kept = resolveMerge(createMerge({ base, ours: base, theirs }));
    expect(kept.issues).toEqual([]);
    const platform = copy(theirs);
    platform.screens[0].triggers[0].eventSource = "flow__screen";
    const other = resolveMerge(createMerge({ base, ours, theirs: platform }));
    expect(
      other.issues.filter((issue) => issue.code === "missingEventSource")
    ).toEqual([]);
  });
});

describe("names inside elements", () => {
  const screens = (fieldsA = [], fieldsB = []) => ({
    label: "Screens",
    processType: "Flow",
    start: { locationX: 0, locationY: 0, connector: { targetReference: "A" } },
    screens: [
      {
        name: "A",
        label: "A",
        locationX: 0,
        locationY: 100,
        fields: fieldsA,
        connector: { targetReference: "B" }
      },
      { name: "B", label: "B", locationX: 0, locationY: 200, fields: fieldsB }
    ]
  });
  const input = (name) => ({
    name,
    fieldType: "InputField",
    dataType: "String",
    fieldText: name
  });
  const clashes = (issues) =>
    issues.filter((issue) => issue.code === "nameClash");

  it("stops at a screen input both sides added under one name", () => {
    const merge = createMerge({
      base: screens(),
      ours: screens([input("CustomerEmail")]),
      theirs: screens([], [input("customeremail")])
    });
    const result = resolveMerge(merge);
    expect(result.conflicts).toEqual([]);
    expect(clashes(result.issues)).toEqual([
      expect.objectContaining({
        severity: ERROR,
        nodeKey: "A",
        name: "CustomerEmail",
        message:
          "CustomerEmail in A (A) and customeremail in B (B) have the same API name."
      })
    ]);
  });

  it("counts inputs inside a section, and outcomes, but not parameters", () => {
    const section = {
      name: "Details",
      fieldType: "RegionContainer",
      fields: [
        {
          name: "Column",
          fieldType: "Region",
          fields: [input("Route")],
          inputParameters: [{ name: "width", value: { stringValue: "12" } }]
        }
      ]
    };
    const flow = screens([section], [input("width")]);
    flow.decisions = [
      {
        name: "Route_Decision",
        label: "Route",
        locationX: 0,
        locationY: 300,
        rules: [{ name: "Route", label: "Route", conditionLogic: "and" }]
      }
    ];
    expect(clashes(validateFlow(buildModel(flow)))).toEqual([
      expect.objectContaining({ name: "Route", nodeKey: "Route_Decision" })
    ]);
  });

  it("leaves a clash a version already had", () => {
    const had = screens([input("Email")], [input("Email")]);
    expect(clashes(validateFlow(buildModel(had)))).toHaveLength(1);
    expect(clashes(validateFlow(buildModel(had), [buildModel(had)]))).toEqual(
      []
    );
  });
});

describe("record checks", () => {
  const using = (start, reference) =>
    buildModel({
      FullName: "Uses",
      Metadata: {
        ...small(),
        start: { ...start, connector: { targetReference: "A" } },
        assignments: [
          step("A", "A", 100, {
            assignmentItems: [
              {
                assignToReference: "Count",
                operator: "Add",
                value: { elementReference: reference }
              }
            ]
          })
        ]
      }
    });
  const codes = (model) =>
    validateFlow(model).map((issue) => [issue.code, issue.severity]);

  it("flags $Record in a flow no record starts", () => {
    const issues = validateFlow(using({}, "$Record.NumberOfEmployees"));
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "recordWithoutTrigger",
        severity: ERROR,
        nodeKey: "A",
        name: "$Record"
      })
    );
    expect(issues[0].message).toContain("doesn't start from a record");
  });

  it("flags $Record__Prior where there's no earlier version", () => {
    const trigger = {
      object: "Account",
      triggerType: "RecordAfterSave",
      recordTriggerType: "Create"
    };
    expect(codes(using(trigger, "$Record__Prior.NumberOfEmployees"))).toEqual([
      ["priorWithoutUpdate", WARNING]
    ]);
    expect(
      codes(
        using(
          { ...trigger, recordTriggerType: "Update" },
          "$Record__Prior.NumberOfEmployees"
        )
      )
    ).toEqual([]);
    expect(codes(using({}, "$Record__Prior.NumberOfEmployees"))).toContainEqual(
      ["priorWithoutUpdate", ERROR]
    );
    expect(codes(using(trigger, "$Record.NumberOfEmployees"))).toEqual([]);
  });
});

it("includes a dependency chain longer than twenty resources", () => {
  const before = {
    label: "Demo",
    start: { connector: { targetReference: "Use" } },
    assignments: [{ name: "Use", label: "Use", assignmentItems: [] }]
  };
  const after = {
    ...before,
    assignments: [
      {
        ...before.assignments[0],
        assignmentItems: [
          {
            assignToReference: "result",
            operator: "Assign",
            value: { elementReference: "Formula0" }
          }
        ]
      }
    ],
    variables: [{ name: "result", dataType: "String", isCollection: false }],
    formulas: Array.from({ length: 25 }, (_, i) => ({
      name: `Formula${i}`,
      dataType: "String",
      expression: i === 24 ? '"end"' : `{!Formula${i + 1}}`
    }))
  };
  const merge = createMerge({ before, after });
  const resolved = resolveMerge(merge, {
    "field|Use|assignmentItems": "after"
  });
  expect(resolved.errors).toBe(0);
  expect(resolved.metadata.formulas).toHaveLength(25);
});
