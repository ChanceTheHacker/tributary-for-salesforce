import {
  buildModel,
  normalize,
  outgoing,
  incoming,
  toMetadata,
  START
} from "c/flowModel";

const caseRouting = require("fixtures/flows/Case_Email_Routing/v4.json");
const caseRoutingV3 = require("fixtures/flows/Case_Email_Routing/v3.json");
const templateCreation = require("fixtures/flows/Case_Routing_Template_Creation/v1.json");
const reportExport = require("fixtures/flows/sfdc_default_ReportExport_Protection_Flow/v1.json");

describe("normalize", () => {
  it("drops nulls, empty lists and empty objects, and sorts keys", () => {
    const value = normalize({
      b: null,
      a: { z: [], y: { x: null } },
      list: [
        null,
        { name: "n", value: { stringValue: "s", booleanValue: null } },
        {}
      ],
      flag: false,
      zero: 0
    });
    expect(value).toEqual({
      flag: false,
      list: [{ name: "n", value: { stringValue: "s" } }],
      zero: 0
    });
    expect(Object.keys(value)).toEqual(["flag", "list", "zero"]);
  });

  it("returns undefined when nothing is left", () => {
    expect(normalize({ a: null, b: [] })).toBeUndefined();
  });
});

describe("buildModel", () => {
  const model = buildModel(caseRouting);

  it("reads the record-level details", () => {
    expect(model).toMatchObject({
      name: "cllc__Case_Email_Routing",
      label: "Case Email Routing",
      version: 4,
      status: "Obsolete",
      processType: "AutoLaunchedFlow",
      canvasMode: "FREE_FORM_CANVAS"
    });
    expect(model.props.status).toBeUndefined();
  });

  it("strips the version suffix from older FullNames", () => {
    expect(buildModel(caseRoutingV3).name).toBe("cllc__Case_Email_Routing");
  });

  it("collects every canvas element, with the start element under a fixed key", () => {
    expect([...model.nodes.keys()].sort()).toEqual(
      [
        START,
        "Assign_Matching_Template",
        "Get_Routing",
        "Should_Case_Be_Updated",
        "Unhandled_Case_Update",
        "Update_Case_Record",
        "Was_a_match_found",
        "loop_matching_templates"
      ].sort()
    );
    const start = model.nodes.get(START);
    expect(start.type).toBe("start");
    expect(start.fields).toMatchObject({
      object: "Case",
      recordTriggerType: "Create",
      triggerType: "RecordAfterSave"
    });
  });

  it("keeps position, name and connectors out of element fields", () => {
    const lookup = model.nodes.get("Get_Routing");
    expect(lookup).toMatchObject({
      type: "recordLookups",
      label: "Get Routing",
      x: 655,
      y: 409
    });
    expect(lookup.fields).not.toHaveProperty("name");
    expect(lookup.fields).not.toHaveProperty("locationX");
    expect(lookup.fields).not.toHaveProperty("connector");
    expect(lookup.fields.object).toBe("cllc__Case_Routing_Template__c");
  });

  it("drops the connector inside each decision outcome but keeps the outcome", () => {
    const decision = model.nodes.get("Was_a_match_found");
    for (const rule of decision.fields.rules) {
      expect(rule).not.toHaveProperty("connector");
      expect(rule.name).toEqual(expect.any(String));
    }
  });

  it("finds connectors with their kind and label, in canvas order", () => {
    expect(
      outgoing(model, START).map((edge) => [edge.kind, edge.target])
    ).toEqual([["next", "Get_Routing"]]);

    expect(
      outgoing(model, "loop_matching_templates").map((edge) => [
        edge.kind,
        edge.target
      ])
    ).toEqual([
      ["loopNext", "Should_Case_Be_Updated"],
      ["loopEnd", "Should_Case_Be_Updated"]
    ]);

    expect(
      outgoing(model, "Was_a_match_found").map((edge) => [
        edge.kind,
        edge.label,
        edge.target
      ])
    ).toEqual([
      ["outcome", "Match Found", "Assign_Matching_Template"],
      ["default", "No Match", "loop_matching_templates"]
    ]);
  });

  it("gives every connector a unique key and a target that exists", () => {
    for (const edge of model.edges.values()) {
      expect(edge.key).toBe(`${edge.source}.${edge.slot}`);
      expect(model.nodes.has(edge.target)).toBe(true);
    }
    expect(incoming(model, "Get_Routing").map((edge) => edge.source)).toContain(
      START
    );
  });

  it("separates resources from canvas elements", () => {
    const screenFlow = buildModel(templateCreation);
    expect(
      [...screenFlow.resources.values()].map((r) => r.type).sort()
    ).toEqual(["dynamicChoiceSets", "variables"]);
    expect(screenFlow.nodes.get(START).type).toBe("start");
    expect(
      [...screenFlow.nodes.values()].filter((n) => n.type === "screens")
    ).toHaveLength(2);
  });

  it("gives flows without a start element a synthetic one", () => {
    const flow = buildModel(reportExport);
    expect(flow.nodes.get(START)).toMatchObject({
      type: "start",
      synthetic: true
    });
    expect(outgoing(flow, START)).toEqual([
      expect.objectContaining({ target: "ConditionBuilder", kind: "next" })
    ]);
    expect(outgoing(flow, "ConditionBuilder")).toEqual([
      expect.objectContaining({
        kind: "outcome",
        label: "MatchAll",
        target: "EvaluationOutcomeAssignment"
      }),
      expect.objectContaining({
        kind: "default",
        label: "EvaluationOutcomeAssignmentFalse",
        target: "EvaluationOutcomeAssignmentFalse"
      })
    ]);
  });

  it("accepts bare metadata as well as a Tooling record", () => {
    const bare = buildModel(caseRouting.Metadata);
    expect(bare.name).toBeUndefined();
    expect([...bare.edges.keys()]).toEqual([...model.edges.keys()]);
  });
});

describe("toMetadata", () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(process.cwd(), "test/fixtures/flows");
  const records = fs
    .readdirSync(root)
    .flatMap((flow) =>
      fs
        .readdirSync(path.join(root, flow))
        .map((file) => [
          `${flow}/${file}`,
          require(`fixtures/flows/${flow}/${file}`)
        ])
    );

  it.each(records)(
    "writes %s back exactly, apart from status",
    (name, record) => {
      const expected = normalize(record.Metadata);
      delete expected.status;
      expect(toMetadata(buildModel(record))).toEqual(expected);
    }
  );

  it("writes an edited connector into its slot", () => {
    const model = buildModel(caseRouting);
    const edge = model.edges.get(
      "Was_a_match_found.rules.Match_Found.connector"
    );
    expect(edge).toBeDefined();
    model.edges.set(edge.key, { ...edge, target: "Update_Case_Record" });
    const decision = toMetadata(model).decisions.find(
      (d) => d.name === "Was_a_match_found"
    );
    expect(decision.rules[0].connector).toEqual({
      targetReference: "Update_Case_Record"
    });
  });

  it("reads and writes a legacy step's list of connectors", () => {
    const metadata = {
      label: "Steps",
      startElementReference: "First",
      steps: [
        {
          name: "First",
          label: "First",
          locationX: 0,
          locationY: 0,
          connectors: [
            { targetReference: "Second" },
            { targetReference: "Third" }
          ]
        },
        { name: "Second", label: "Second", locationX: 0, locationY: 100 },
        { name: "Third", label: "Third", locationX: 0, locationY: 200 }
      ]
    };
    const model = buildModel(metadata);
    expect(model.nodes.get("First").fields.connectors).toBeUndefined();
    expect(outgoing(model, "First").map((edge) => edge.target)).toEqual([
      "Second",
      "Third"
    ]);
    expect(outgoing(model, "First")[0].kind).toBe("next");
    expect(toMetadata(model)).toEqual(normalize(metadata));
  });

  it("keys an action's paths by pathName, not by position", () => {
    const action = (paths) => ({
      label: "Paths",
      actionCalls: [
        {
          name: "Act",
          label: "Act",
          locationX: 0,
          locationY: 0,
          actionName: "approve",
          actionType: "apex",
          actionCallPaths: paths
        }
      ]
    });
    const actionPath = (pathName, target) => ({
      pathName,
      connector: { targetReference: target }
    });
    const model = buildModel(
      action([actionPath("Success", "A"), actionPath("Failure", "B")])
    );
    expect(
      model.edges.get("Act.actionCallPaths.Success.connector").target
    ).toBe("A");
    expect(
      model.edges.get("Act.actionCallPaths.Failure.connector").target
    ).toBe("B");
    // Written into a reordered list, each connector finds its own path.
    model.nodes.get("Act").fields.actionCallPaths.reverse();
    expect(toMetadata(model).actionCalls[0].actionCallPaths).toEqual([
      actionPath("Failure", "B"),
      actionPath("Success", "A")
    ]);
  });

  it("recreates a missing list of connectors as a list", () => {
    const model = buildModel({
      label: "Steps",
      steps: [{ name: "First", label: "First", locationX: 0, locationY: 0 }]
    });
    model.edges.set("First.connectors.0", {
      key: "First.connectors.0",
      source: "First",
      target: "Second",
      slot: "connectors.0",
      kind: "next",
      isGoTo: false
    });
    expect(toMetadata(model).steps[0].connectors).toEqual([
      { targetReference: "Second" }
    ]);
  });
});
