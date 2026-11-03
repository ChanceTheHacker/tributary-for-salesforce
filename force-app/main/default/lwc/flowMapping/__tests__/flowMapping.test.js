import {
  compatible,
  isCrossFlow,
  planMapping,
  suggestedChoices,
  translateFlow,
  typeLabel,
  validName
} from "c/flowMapping";
import {
  createMerge,
  resolveMerge,
  insertPicks,
  changedUnits,
  validateFlow
} from "c/flowMerge";
import { buildModel } from "c/flowModel";

const FREE_FORM = [
  { name: "CanvasMode", value: { stringValue: "FREE_FORM_CANVAS" } }
];

// Record-triggered on Case: escalates high-priority cases.
const target = () => ({
  FullName: "Case_Triage",
  Metadata: {
    label: "Case Triage",
    processType: "AutoLaunchedFlow",
    processMetadataValues: FREE_FORM,
    start: {
      locationX: 50,
      locationY: 0,
      object: "Case",
      triggerType: "RecordAfterSave",
      recordTriggerType: "CreateAndUpdate",
      connector: { targetReference: "Check_Priority" }
    },
    decisions: [
      {
        name: "Check_Priority",
        label: "Check Priority",
        locationX: 50,
        locationY: 150,
        defaultConnectorLabel: "Default",
        rules: [
          {
            name: "High",
            label: "High",
            conditionLogic: "and",
            conditions: [
              {
                leftValueReference: "$Record.Priority",
                operator: "EqualTo",
                rightValue: { stringValue: "High" }
              }
            ],
            connector: { targetReference: "Escalate" }
          }
        ]
      }
    ],
    recordUpdates: [
      {
        name: "Escalate",
        label: "Escalate",
        locationX: 50,
        locationY: 300,
        inputReference: "$Record",
        inputAssignments: [
          { field: "IsEscalated", value: { booleanValue: true } }
        ]
      }
    ],
    variables: [
      {
        name: "note",
        dataType: "Number",
        scale: 0,
        isCollection: false,
        isInput: false,
        isOutput: false
      }
    ]
  }
});

// Autolaunched, given a case id: looks the case up and notes it.
const source = () => ({
  FullName: "Case_Helper",
  Metadata: {
    label: "Case Helper",
    processType: "AutoLaunchedFlow",
    processMetadataValues: FREE_FORM,
    start: {
      locationX: 0,
      locationY: 0,
      connector: { targetReference: "Get_Case" }
    },
    recordLookups: [
      {
        name: "Get_Case",
        label: "Get Case",
        locationX: 0,
        locationY: 100,
        object: "Case",
        getFirstRecordOnly: true,
        storeOutputAutomatically: true,
        filterLogic: "and",
        filters: [
          {
            field: "Id",
            operator: "EqualTo",
            value: { elementReference: "recordId" }
          }
        ],
        connector: { targetReference: "Route" }
      }
    ],
    decisions: [
      {
        name: "Route",
        label: "Route",
        locationX: 0,
        locationY: 200,
        rules: [
          {
            name: "High",
            label: "High",
            conditionLogic: "and",
            conditions: [
              {
                leftValueReference: "Get_Case.Priority",
                operator: "EqualTo",
                rightValue: { stringValue: "High" }
              }
            ],
            connector: { targetReference: "Set_Note" }
          }
        ]
      }
    ],
    assignments: [
      {
        name: "Set_Note",
        label: "Set Note",
        locationX: 0,
        locationY: 300,
        assignmentItems: [
          {
            assignToReference: "note",
            operator: "Assign",
            value: { stringValue: "Case {!Get_Case.CaseNumber} is high" }
          }
        ],
        connector: { targetReference: "Escalate" }
      }
    ],
    recordUpdates: [
      {
        name: "Escalate",
        label: "Escalate",
        locationX: 0,
        locationY: 400,
        inputReference: "Get_Case",
        inputAssignments: [
          { field: "IsEscalated", value: { booleanValue: true } },
          { field: "Description", value: { elementReference: "note" } }
        ]
      }
    ],
    variables: [
      {
        name: "recordId",
        dataType: "String",
        isCollection: false,
        isInput: true,
        isOutput: false
      },
      {
        name: "note",
        dataType: "String",
        isCollection: false,
        isInput: false,
        isOutput: false
      }
    ]
  }
});

// Record-triggered on Case, using $Record throughout.
const recordFlow = () => ({
  FullName: "Case_Closer",
  Metadata: {
    label: "Case Closer",
    processType: "AutoLaunchedFlow",
    start: {
      object: "Case",
      triggerType: "RecordAfterSave",
      recordTriggerType: "Update",
      connector: { targetReference: "Is_Closed" }
    },
    decisions: [
      {
        name: "Is_Closed",
        label: "Is Closed",
        rules: [
          {
            name: "Closed",
            label: "Closed",
            conditionLogic: "and",
            conditions: [
              {
                leftValueReference: "$Record.Status",
                operator: "EqualTo",
                rightValue: { stringValue: "Closed" }
              },
              {
                leftValueReference: "$Record__Prior.Status",
                operator: "NotEqualTo",
                rightValue: { stringValue: "Closed" }
              }
            ],
            connector: { targetReference: "Stamp" }
          }
        ]
      }
    ],
    assignments: [
      {
        name: "Stamp",
        label: "Stamp",
        assignmentItems: [
          {
            assignToReference: "$Record.Description",
            operator: "Assign",
            value: { stringValue: "Closed {!$Record.CaseNumber}" }
          }
        ]
      }
    ]
  }
});

// Autolaunched with a Case variable passed in.
const varFlow = (variables) => ({
  FullName: "Case_Sub",
  Metadata: {
    label: "Case Sub",
    processType: "AutoLaunchedFlow",
    start: { connector: { targetReference: "Log" } },
    assignments: [
      {
        name: "Log",
        label: "Log",
        assignmentItems: [
          {
            assignToReference: "logText",
            operator: "Assign",
            value: { stringValue: "{!theCase.Subject}" }
          }
        ]
      }
    ],
    variables: [
      {
        name: "logText",
        dataType: "String",
        isCollection: false,
        isInput: false,
        isOutput: false
      },
      ...variables
    ]
  }
});

const caseVar = (name) => ({
  name,
  dataType: "SObject",
  objectType: "Case",
  isCollection: false,
  isInput: true,
  isOutput: false
});

const rowOf = (plan, key) => plan.roots.find((row) => row.key === key);

describe("c/flowMapping", () => {
  it("tells different flows from versions of one", () => {
    expect(isCrossFlow({ name: "A" }, { name: "B" })).toBe(true);
    expect(isCrossFlow({ name: "Flow_A" }, { name: "flow_a" })).toBe(false);
    expect(isCrossFlow({ name: "A" }, undefined)).toBe(false);
  });

  it("checks API names", () => {
    expect(validName("Case_Record")).toBe(true);
    expect(validName("2fast")).toBe(false);
    expect(validName("a__b")).toBe(false);
    expect(validName("trailing_")).toBe(false);
    expect(validName("has space")).toBe(false);
    expect(validName("x".repeat(81))).toBe(false);
  });

  it("describes and compares types", () => {
    const record = {
      kind: "data",
      dataType: "SObject",
      objectType: "Case",
      collection: false
    };
    expect(typeLabel(record)).toBe("Case record");
    expect(typeLabel({ ...record, collection: true })).toBe("Case records");
    expect(typeLabel({ kind: "data", dataType: "String" })).toBe("Text");
    expect(typeLabel({ kind: "choices" })).toBe("Choice");
    expect(compatible(record, { ...record })).toBe(true);
    expect(compatible(record, { ...record, objectType: "Account" })).toBe(
      false
    );
    expect(compatible(record, { ...record, collection: true })).toBe(false);
    // Picklists hold text; formulas can't be stored into.
    const text = { kind: "data", dataType: "String" };
    expect(compatible(text, { kind: "data", dataType: "Picklist" })).toBe(true);
    expect(compatible(text, { ...text, readOnly: true }, true)).toBe(false);
    expect(compatible(text, { ...text, readOnly: true }, false)).toBe(true);
  });

  it("maps $Record onto a Case variable passed in", () => {
    const plan = planMapping(varFlow([caseVar("theCase")]), recordFlow());
    const record = rowOf(plan, "$record");
    expect(record.kind).toBe("record");
    expect(record.typeLabel).toBe("Case record");
    expect([...record.uses].sort()).toEqual(["Is_Closed", "Stamp"]);
    expect(record.written).toBe(true);
    expect(record.options[0].to).toBe("theCase");
    expect(record.defaultChoice).toEqual({ to: "theCase" });

    const { model, notes } = translateFlow(
      varFlow([caseVar("theCase")]),
      recordFlow(),
      suggestedChoices(plan)
    );
    const decision = model.nodes.get("Is_Closed");
    expect(decision.fields.rules[0].conditions[0].leftValueReference).toBe(
      "theCase.Status"
    );
    const stamp = model.nodes.get("Stamp").fields.assignmentItems[0];
    expect(stamp.assignToReference).toBe("theCase.Description");
    expect(stamp.value.stringValue).toBe("Closed {!theCase.CaseNumber}");
    expect(notes.mapped).toContainEqual({ from: "$Record", to: "theCase" });
    // The target keeps its own start; the other flow's trigger is noted.
    expect(model.nodes.get("$Start").fields.object).toBeUndefined();
    expect(notes.sourceStart).toEqual({
      object: "Case",
      triggerType: "RecordAfterSave",
      recordTriggerType: "Update"
    });
    expect(notes.entry).toBe("Is_Closed");
    expect([...notes.added].sort()).toEqual(["Is_Closed", "Stamp"]);
    // Named after the flow it came from, with the target's settings.
    expect(model.name).toBe("Case_Closer");
    expect(model.props.label).toBe("Case Sub");
  });

  it("maps a Case variable onto $Record the other way round", () => {
    const plan = planMapping(recordFlow(), varFlow([caseVar("theCase")]));
    const row = rowOf(plan, "thecase");
    expect(row.defaultChoice).toEqual({ to: "$Record" });
    // $Record__Prior is there to pick, but not suggested.
    expect(row.options.map((option) => option.to)).toContain("$Record__Prior");
    const { model } = translateFlow(
      recordFlow(),
      varFlow([caseVar("theCase")]),
      suggestedChoices(plan)
    );
    expect(
      model.nodes.get("Log").fields.assignmentItems[0].value.stringValue
    ).toBe("{!$Record.Subject}");
    expect(model.resources.has("theCase")).toBe(false);
  });

  it("makes a variable for $Record when the target has nothing to map it to", () => {
    const plan = planMapping(varFlow([]), recordFlow());
    expect(rowOf(plan, "$record").defaultChoice).toEqual({
      create: "CaseRecord"
    });
    expect(rowOf(plan, "$record__prior").defaultChoice).toEqual({
      create: "CasePriorRecord"
    });
    const choices = suggestedChoices(plan);
    choices.roots.$record = { create: "closingCase" };
    const { model, notes } = translateFlow(varFlow([]), recordFlow(), choices);
    expect(model.resources.get("closingCase").fields).toMatchObject({
      dataType: "SObject",
      objectType: "Case",
      isInput: true
    });
    expect(model.resources.has("CasePriorRecord")).toBe(true);
    const conditions = model.nodes.get("Is_Closed").fields.rules[0].conditions;
    expect(conditions.map((c) => c.leftValueReference)).toEqual([
      "closingCase.Status",
      "CasePriorRecord.Status"
    ]);
    expect(notes.created.map((c) => c.name)).toEqual([
      "closingCase",
      "CasePriorRecord"
    ]);
  });

  it("asks before taking a lookup of another record to be the triggering one", () => {
    // Gets the case's parent by an ID of its own, not the case itself.
    const parent = source();
    parent.Metadata.variables[0].name = "parentCaseId";
    parent.Metadata.recordLookups[0].filters[0].value.elementReference =
      "parentCaseId";
    const lookup = rowOf(planMapping(target(), parent), "get_case");
    expect(lookup.suggestion).toBe("$Record");
    expect(lookup.defaultChoice).toEqual({ create: "Get_Case" });
    // Nor when the ID is anything but equal.
    const other = source();
    other.Metadata.recordLookups[0].filters[0].operator = "NotEqualTo";
    expect(
      rowOf(planMapping(target(), other), "get_case").defaultChoice
    ).toEqual({ create: "Get_Case" });
  });

  it("plans a lookup, an id and clashing names", () => {
    const plan = planMapping(target(), source());
    expect(plan.target.label).toBe("Case Triage");
    expect(plan.source.name).toBe("Case_Helper");
    // Records first.
    expect(plan.roots.map((row) => row.key)).toEqual([
      "get_case",
      "recordid",
      "note"
    ]);
    const lookup = rowOf(plan, "get_case");
    expect(lookup.kind).toBe("lookup");
    expect(lookup.typeLabel).toBe("Case record");
    expect(lookup.defaultChoice).toEqual({ to: "$Record" });
    expect(rowOf(plan, "recordid").defaultChoice).toEqual({
      to: "$Record.Id"
    });
    // The target's note is a number: this one comes along renamed.
    const note = rowOf(plan, "note");
    expect(note.options).toEqual([]);
    expect(note.defaultChoice).toEqual({ create: "note_2" });
    expect(plan.elements).toEqual([
      {
        key: "escalate",
        name: "Escalate",
        targetKey: "Escalate",
        type: "recordUpdates",
        label: "Escalate",
        // The other flow's also sets the description: keep both.
        same: false,
        defaultChoice: "both"
      }
    ]);
  });

  it("suggests one element where both do the same once mapped", () => {
    const helper = source();
    helper.Metadata.recordUpdates[0].inputAssignments.pop();
    helper.Metadata.recordUpdates[0].label = "Escalate it";
    const plan = planMapping(target(), helper);
    expect(plan.elements[0]).toMatchObject({
      same: true,
      defaultChoice: "one"
    });
    expect(suggestedChoices(plan).elements).toEqual({ escalate: "one" });
    const { model, notes } = translateFlow(target(), helper, {}, plan);
    expect(model.nodes.has("Escalate_2")).toBe(false);
    expect(model.edges.get("Set_Note.connector").target).toBe("Escalate");
    expect(notes.added).not.toContain("Escalate");
  });

  it("brings the other flow in with lookups bypassed and clashes renamed", () => {
    const plan = planMapping(target(), source());
    const choices = suggestedChoices(plan);
    choices.elements.escalate = "one";
    const { model, notes } = translateFlow(target(), source(), choices, plan);
    expect(model.nodes.has("Get_Case")).toBe(false);
    expect(model.resources.has("recordId")).toBe(false);
    const route = model.nodes.get("Route");
    // Its outcome was named like the target's; references follow the map.
    expect(route.fields.rules[0].name).toBe("High_2");
    expect(route.fields.rules[0].conditions[0].leftValueReference).toBe(
      "$Record.Priority"
    );
    expect(model.edges.get("Route.rules.High_2.connector").target).toBe(
      "Set_Note"
    );
    const item = model.nodes.get("Set_Note").fields.assignmentItems[0];
    expect(item.assignToReference).toBe("note_2");
    expect(item.value.stringValue).toBe("Case {!$Record.CaseNumber} is high");
    expect(model.resources.get("note_2").fields.dataType).toBe("String");
    expect(model.resources.get("note").fields.dataType).toBe("Number");
    // Escalate is one element: the other flow's version, where the target's is.
    const escalate = model.nodes.get("Escalate");
    expect(escalate.fields.inputReference).toBe("$Record");
    expect(escalate.fields.inputAssignments).toHaveLength(2);
    expect([escalate.x, escalate.y]).toEqual([50, 300]);
    // The rest sits to the right of the target's elements.
    expect(model.nodes.get("Route")).toMatchObject({ x: 362, y: 0 });
    expect(model.nodes.get("Set_Note")).toMatchObject({ x: 362, y: 100 });
    expect(notes.entry).toBe("Route");
    expect([...notes.added].sort()).toEqual(["Route", "Set_Note"]);
    expect(notes.renamed).toEqual([
      { from: "note", to: "note_2", kind: "resource" },
      { from: "High", to: "High_2", kind: "name" }
    ]);
    expect(notes.dropped).toEqual([
      { name: "recordId", kind: "resource", reason: "mapped" },
      { name: "Get_Case", kind: "element", reason: "mapped" }
    ]);
  });

  it("keeps both elements when asked, and takes typed names", () => {
    const plan = planMapping(target(), source());
    const choices = suggestedChoices(plan);
    expect(choices.elements.escalate).toBe("both");
    choices.roots.note = { create: "noteText" };
    choices.roots.get_case = { create: "Get_Case" };
    const { model, notes } = translateFlow(target(), source(), choices, plan);
    expect(model.nodes.get("Escalate").fields.inputReference).toBe("$Record");
    expect(model.nodes.get("Escalate_2").fields.inputReference).toBe(
      "Get_Case"
    );
    expect(model.edges.get("Set_Note.connector").target).toBe("Escalate_2");
    expect(model.nodes.has("Get_Case")).toBe(true);
    expect(model.edges.get("$Start.connector").target).toBe("Check_Priority");
    expect(
      model.nodes.get("Set_Note").fields.assignmentItems[0].assignToReference
    ).toBe("noteText");
    expect(notes.entry).toBe("Get_Case");
  });

  // varFlow with a Get Records filling theCase first, by `filters`.
  const loadFlow = (filters, extra = {}) => {
    const flow = varFlow([
      caseVar("theCase"),
      {
        name: "recordId",
        dataType: "String",
        isCollection: false,
        isInput: true,
        isOutput: false
      }
    ]);
    flow.Metadata.start.connector.targetReference = "Load";
    flow.Metadata.recordLookups = [
      {
        name: "Load",
        label: "Load",
        object: "Case",
        getFirstRecordOnly: true,
        filterLogic: "and",
        filters,
        outputReference: "theCase",
        connector: { targetReference: "Log" },
        ...extra
      }
    ];
    return flow;
  };
  const idIs = (ref) => ({
    field: "Id",
    operator: "EqualTo",
    value: { elementReference: ref }
  });

  it("drops a Get Records that only filled a mapped variable with the same record", () => {
    const flow = loadFlow([idIs("recordId")]);
    const plan = planMapping(recordFlow(), flow);
    expect(rowOf(plan, "recordid").defaultChoice).toEqual({
      to: "$Record.Id"
    });
    expect(rowOf(plan, "thecase").defaultChoice).toEqual({ to: "$Record" });
    const { model, notes } = translateFlow(
      recordFlow(),
      flow,
      suggestedChoices(plan)
    );
    expect(model.nodes.has("Load")).toBe(false);
    expect(notes.entry).toBe("Log");
  });

  it.each([
    ["no condition", []],
    ["another record's ID", [idIs("$Record.ParentId")]],
    [
      "another condition as well",
      [
        idIs("recordId"),
        { field: "Status", operator: "EqualTo", value: { stringValue: "New" } }
      ]
    ]
  ])(
    "keeps a Get Records filling a mapped variable by %s",
    (label, filters) => {
      const flow = loadFlow(filters);
      const plan = planMapping(recordFlow(), flow);
      const { model } = translateFlow(
        recordFlow(),
        flow,
        suggestedChoices(plan)
      );
      // It stays, and fills what the variable is mapped to.
      expect(model.nodes.get("Load").fields.outputReference).toBe("$Record");
    }
  );

  it("keeps a Get Records whose Id condition is ORed with another", () => {
    const flow = source();
    const lookup = flow.Metadata.recordLookups[0];
    lookup.filterLogic = "or";
    lookup.filters.push({
      field: "Status",
      operator: "EqualTo",
      value: { stringValue: "New" }
    });
    const plan = planMapping(target(), flow);
    expect(rowOf(plan, "get_case").defaultChoice).toEqual({
      create: "Get_Case"
    });
    const { model } = translateFlow(
      target(),
      flow,
      suggestedChoices(plan),
      plan
    );
    expect(model.nodes.has("Get_Case")).toBe(true);
    expect(
      model.nodes.get("Route").fields.rules[0].conditions[0].leftValueReference
    ).toBe("Get_Case.Priority");
  });

  it.each([
    ["a limit", { limit: { numberValue: 1 } }],
    ["related records", { relatedRecords: [{ name: "Comments" }] }],
    ["more than one record", { getFirstRecordOnly: false }]
  ])("doesn't take a Get Records with %s to be $Record", (label, extra) => {
    const flow = source();
    Object.assign(flow.Metadata.recordLookups[0], extra);
    expect(
      rowOf(planMapping(target(), flow), "get_case").defaultChoice
    ).toEqual({ create: "Get_Case" });
  });

  it("keeps a suggested lookup mapping only while its ID is still mapped", () => {
    const plan = planMapping(target(), source());
    const choices = suggestedChoices(plan);
    expect(choices.roots.get_case).toEqual({ to: "$Record", suggested: true });
    choices.roots.recordid = { create: "recordId" };
    const { model, issues } = translateFlow(target(), source(), choices, plan);
    expect(model.nodes.has("Get_Case")).toBe(true);
    expect(issues.map((issue) => issue.code)).not.toContain("mappingQuery");
  });

  it("warns when someone maps a lookup of another record onto $Record", () => {
    const parent = source();
    parent.Metadata.variables[0].name = "parentCaseId";
    parent.Metadata.recordLookups[0].filters[0].value.elementReference =
      "parentCaseId";
    const plan = planMapping(target(), parent);
    const choices = suggestedChoices(plan);
    choices.roots.get_case = { to: "$Record" };
    const { model, issues } = translateFlow(target(), parent, choices, plan);
    expect(model.nodes.has("Get_Case")).toBe(false);
    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "mappingQuery",
        mappingKey: "get_case"
      })
    );
  });

  it("renames a screen action with the triggers that run it", () => {
    const screenFlow = (fullName, screen) => ({
      FullName: fullName,
      Metadata: {
        label: fullName,
        processType: "Flow",
        start: { connector: { targetReference: screen } },
        screens: [
          {
            name: screen,
            label: screen,
            actions: [
              {
                name: "FetchCases",
                label: "Fetch Cases",
                actionName: "Fetch_Cases",
                actionType: "flow"
              }
            ],
            fields: [
              {
                name: "Case_Picker",
                fieldType: "ComponentInstance",
                extensionName: "flowruntime:lookup"
              }
            ],
            triggers: [
              {
                eventName: "change",
                eventSource: "Case_Picker",
                handlers: [{ screenActionName: "FetchCases" }]
              }
            ]
          }
        ]
      }
    });
    const into = screenFlow("Target_Screens", "T");
    const from = screenFlow("Source_Screens", "S");
    const plan = planMapping(into, from);
    const { model, notes } = translateFlow(
      into,
      from,
      suggestedChoices(plan),
      plan
    );
    const screen = model.nodes.get("S").fields;
    expect(screen.actions[0].name).toBe("FetchCases_2");
    // The action it runs is the flow's own, not a name to rewrite.
    expect(screen.actions[0].actionName).toBe("Fetch_Cases");
    expect(screen.fields[0].name).toBe("Case_Picker_2");
    expect(screen.triggers).toEqual([
      {
        eventName: "change",
        eventSource: "Case_Picker_2",
        handlers: [{ screenActionName: "FetchCases_2" }]
      }
    ]);
    expect(notes.renamed).toEqual(
      expect.arrayContaining([
        { from: "FetchCases", to: "FetchCases_2", kind: "name" }
      ])
    );
    expect(
      validateFlow(model).filter(
        (issue) => issue.code === "missingScreenAction"
      )
    ).toEqual([]);
  });

  it("keeps renamed group members and source branches in their own flow", () => {
    const grouped = (name) => ({
      FullName: name,
      Metadata: {
        processType: "AutoLaunchedFlow",
        start: { connector: { targetReference: "Route" } },
        decisions: [
          {
            name: "Route",
            rules: [
              { name: "Continue", connector: { targetReference: "Work" } }
            ]
          }
        ],
        groups: [
          {
            name: "Branch",
            sourceReference: "Route",
            sourceBranchApiName: "Continue"
          }
        ],
        assignments: [{ name: "Work", group: "Branch" }]
      }
    });
    const into = grouped("Target");
    const from = grouped("Source");
    const plan = planMapping(into, from);
    const choices = suggestedChoices(plan);
    for (const row of plan.elements) {
      choices.elements[row.key] = "both";
    }
    const { model } = translateFlow(into, from, choices, plan);
    expect(model.nodes.get("Work").fields.group).toBe("Branch");
    expect(model.nodes.get("Work_2").fields.group).toBe("Branch_2");
    expect(model.nodes.get("Branch_2").fields).toMatchObject({
      sourceReference: "Route_2",
      sourceBranchApiName: "Continue_2"
    });
  });

  it("produces valid names when a numeric suffix exceeds integer precision", () => {
    const name = `Step_${"1" + "0".repeat(21)}`;
    const into = { assignments: [{ name }] };
    const from = { assignments: [{ name }] };
    const plan = planMapping(into, from);
    const { notes } = translateFlow(
      into,
      from,
      { elements: { [name.toLowerCase()]: "both" } },
      plan
    );
    expect(notes.renamed).toHaveLength(1);
    expect(validName(notes.renamed[0].to)).toBe(true);
    expect(notes.renamed[0].to).not.toBe(name);
  });

  it("resets the suffix before repeated collisions exceed integer precision", () => {
    const name = "Step_9007199254740989";
    const into = {
      assignments: [name, "Step_9007199254740990", "Step_9007199254740991"].map(
        (key) => ({ name: key })
      )
    };
    const from = { assignments: [{ name }] };
    const { notes } = translateFlow(into, from, {
      elements: { [name.toLowerCase()]: "both" }
    });
    expect(notes.renamed).toContainEqual({
      from: name,
      to: `${name}_2`,
      kind: "element"
    });
  });

  it("reports a missing source entry without crashing or silently dropping it", () => {
    const broken = source();
    broken.Metadata.start.connector.targetReference = "Deleted_Step";
    const plan = planMapping(target(), broken);
    const { notes, issues } = translateFlow(
      target(),
      broken,
      suggestedChoices(plan),
      plan
    );
    expect(notes.entry).toBeUndefined();
    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "mappingEntry",
        message: expect.stringContaining("Deleted_Step")
      })
    );
  });

  it("gives a merge that only differs by what the other flow brings", () => {
    const plan = planMapping(target(), source());
    const { model, notes } = translateFlow(
      target(),
      source(),
      suggestedChoices(plan),
      plan
    );
    const merge = createMerge({
      before: buildModel(target()),
      after: model
    });
    const changed = changedUnits(merge).map((unit) => unit.id);
    expect(changed).toEqual(
      expect.arrayContaining(["node|Route", "node|Set_Note"])
    );
    expect(changed.some((id) => id.startsWith("prop|"))).toBe(false);
    expect(changed.some((id) => id.includes("$Start"))).toBe(false);
    expect(changed).not.toContain("node|Check_Priority");

    // Put the other flow's path on the target's default path.
    const resolved = resolveMerge(merge, {});
    const picks = insertPicks(
      merge,
      resolved,
      notes.added,
      "after",
      "Check_Priority",
      "defaultConnector",
      notes.entry
    );
    const result = resolveMerge(merge, picks);
    expect(result.errors).toBe(0);
    expect(
      result.model.edges.get("Check_Priority.defaultConnector").target
    ).toBe("Route");
    expect(result.model.edges.get("Set_Note.connector").target).toBe(
      "Escalate_2"
    );
    expect(result.model.resources.has("note_2")).toBe(true);
  });
});
