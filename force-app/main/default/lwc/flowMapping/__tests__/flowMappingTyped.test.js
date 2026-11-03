// Adversarial typed mappings: every mapping is checked on its types, never
// on names alone, and one that doesn't fit blocks a result that otherwise
// reads as a valid flow.
import {
  planMapping,
  suggestedChoices,
  translateFlow,
  withMappingIssues
} from "c/flowMapping";
import {
  createMerge,
  presetPicks,
  resolveMerge,
  unresolvedReferences,
  validateFlow,
  ERROR,
  WARNING
} from "c/flowMerge";
import { buildModel } from "c/flowModel";
import { fromXml, toXml } from "c/flowXml";

const variable = (name, dataType, extra = {}) => ({
  name,
  dataType,
  isCollection: false,
  isInput: false,
  isOutput: false,
  ...extra
});

// Record-triggered on Case updates, with a resource of every kind a
// mapping could land on.
const typedTarget = () => ({
  FullName: "Typed_Target",
  Metadata: {
    label: "Typed Target",
    processType: "AutoLaunchedFlow",
    start: {
      object: "Case",
      triggerType: "RecordAfterSave",
      recordTriggerType: "Update",
      connector: { targetReference: "Get_Owner" }
    },
    recordLookups: [
      {
        name: "Get_Owner",
        label: "Get Owner",
        object: "User",
        getFirstRecordOnly: true,
        storeOutputAutomatically: true,
        filterLogic: "and",
        filters: [
          {
            field: "Id",
            operator: "EqualTo",
            value: { elementReference: "$Record.OwnerId" }
          }
        ],
        connector: { targetReference: "Check_Priority" }
      }
    ],
    decisions: [
      {
        name: "Check_Priority",
        label: "Check Priority",
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
            ]
          }
        ]
      }
    ],
    variables: [
      variable("caseVar", "SObject", { objectType: "Case", isInput: true }),
      variable("caseList", "SObject", {
        objectType: "Case",
        isCollection: true
      }),
      variable("acctVar", "SObject", { objectType: "Account" }),
      variable("note", "String"),
      variable("noteList", "String", { isCollection: true }),
      variable("score", "Number", { scale: 0 }),
      variable("case_subject", "String")
    ],
    formulas: [
      {
        name: "daysOpen",
        dataType: "Number",
        scale: 0,
        expression: "TODAY() - DATEVALUE({!$Record.CreatedDate})"
      }
    ],
    textTemplates: [{ name: "greeting", text: "Hello {!$Record.Subject}" }]
  }
});

// Record-triggered on Case too: reads and writes $Record, looks a case up
// and uses names that look like the ones it maps.
const typedSource = () => ({
  FullName: "Typed_Source",
  Metadata: {
    label: "Typed Source",
    processType: "AutoLaunchedFlow",
    start: {
      object: "Case",
      triggerType: "RecordAfterSave",
      recordTriggerType: "Update",
      connector: { targetReference: "Get_Case" }
    },
    recordLookups: [
      {
        name: "Get_Case",
        label: "Get Case",
        object: "Case",
        getFirstRecordOnly: true,
        storeOutputAutomatically: true,
        filterLogic: "and",
        filters: [
          {
            field: "ParentId",
            operator: "EqualTo",
            value: { elementReference: "$Record.Id" }
          }
        ],
        connector: { targetReference: "Is_Changed" }
      }
    ],
    decisions: [
      {
        name: "Is_Changed",
        label: "Is Changed",
        rules: [
          {
            name: "Changed",
            label: "Changed",
            conditionLogic: "and",
            conditions: [
              {
                leftValueReference: "$record.subject",
                operator: "NotEqualTo",
                rightValue: { elementReference: "$Record__Prior.Subject" }
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
            value: {
              stringValue:
                "{!$Record.CaseNumber} from {!Get_Case.Subject}; label {!Get_Case_Label}"
            }
          },
          {
            assignToReference: "srcNote",
            operator: "Assign",
            // A literal that only looks like a reference stays as it is.
            value: { stringValue: "Get_Case.Subject" }
          },
          {
            assignToReference: "tags",
            operator: "Add",
            value: { elementReference: "Get_Case.Subject" }
          },
          {
            assignToReference: "NOTE",
            operator: "Add",
            value: { numberValue: 1 }
          }
        ]
      }
    ],
    variables: [
      variable("srcNote", "String"),
      variable("tags", "String", { isCollection: true }),
      variable("Get_Case_Label", "String"),
      variable("caseId", "String", { isInput: true }),
      // The same name as the target's, but a number.
      variable("NOTE", "Number", { scale: 2 }),
      variable("caseSubject", "String", { isInput: true })
    ],
    formulas: [
      {
        name: "subjectLength",
        dataType: "Number",
        scale: 0,
        expression: "LEN({!Get_Case.Subject}) + LEN({!caseSubject})"
      }
    ]
  }
});

const rowOf = (plan, key) => plan.roots.find((row) => row.key === key);
const codes = (issues) => issues.map((issue) => issue.code).sort();

// The suggested choices with some rows chosen by hand.
function choose(plan, roots) {
  const choices = suggestedChoices(plan);
  Object.assign(choices.roots, roots);
  return choices;
}

function translate(roots) {
  const plan = planMapping(typedTarget(), typedSource());
  const translation = translateFlow(
    typedTarget(),
    typedSource(),
    choose(plan, roots),
    plan
  );
  return { plan, translation, ...translation };
}

// Merges the translation into the target taking everything the other flow
// brings.
function mergeAll(translation) {
  const merge = createMerge({
    before: buildModel(typedTarget()),
    after: translation.model
  });
  return {
    merge,
    resolved: withMappingIssues(
      resolveMerge(merge, presetPicks(merge, "after")),
      translation
    )
  };
}

describe("c/flowMapping typed mappings", () => {
  it("rewrites record.Field onto a Case variable's fields, and nothing else", () => {
    const { model, issues } = translate({
      $record: { to: "caseVar" },
      get_case: { create: "Get_Case" }
    });
    const stamp = model.nodes.get("Stamp").fields.assignmentItems;
    expect(stamp[0].assignToReference).toBe("caseVar.Description");
    expect(stamp[0].value.stringValue).toBe(
      "{!caseVar.CaseNumber} from {!Get_Case.Subject}; label {!Get_Case_Label}"
    );
    // Literals and look-alike names are left alone.
    expect(stamp[1].value.stringValue).toBe("Get_Case.Subject");
    // References match whatever their case.
    const condition =
      model.nodes.get("Is_Changed").fields.rules[0].conditions[0];
    expect(condition.leftValueReference).toBe("caseVar.subject");
    // $Record__Prior is its own name: mapped separately.
    expect(condition.rightValue.elementReference).toBe(
      "$Record__Prior.Subject"
    );
    expect(
      model.nodes.get("Get_Case").fields.filters[0].value.elementReference
    ).toBe("caseVar.Id");
    expect(codes(issues)).not.toContain("mappingType");
    expect(issues.filter((issue) => issue.severity === ERROR)).toEqual([]);
  });

  it("rewrites a lookup's fields in formulas and merge text, not look-alikes", () => {
    const { model, issues } = translate({ get_case: { to: "caseVar" } });
    expect(model.nodes.has("Get_Case")).toBe(false);
    expect(model.resources.get("subjectLength").fields.expression).toBe(
      "LEN({!caseVar.Subject}) + LEN({!caseSubject})"
    );
    const stamp = model.nodes.get("Stamp").fields.assignmentItems;
    expect(stamp[0].value.stringValue).toBe(
      "{!$Record.CaseNumber} from {!caseVar.Subject}; label {!Get_Case_Label}"
    );
    expect(stamp[1].value.stringValue).toBe("Get_Case.Subject");
    expect(stamp[2].value.elementReference).toBe("caseVar.Subject");
    expect(model.resources.has("Get_Case_Label")).toBe(true);
    expect(issues.filter((issue) => issue.severity === ERROR)).toEqual([]);
  });

  it("offers only what fits: single against collection, one object against another", () => {
    const plan = planMapping(typedTarget(), typedSource());
    const targets = (key) => rowOf(plan, key).options.map((o) => o.to);
    // A text collection only fits the text collection.
    expect(targets("tags")).toEqual(["noteList"]);
    // The target's note is text; this NOTE is a number, whatever its name.
    expect(targets("note")).not.toContain("note");
    expect(targets("note")).toEqual(["score"]);
    expect(rowOf(plan, "note").defaultChoice).toEqual({ create: "NOTE_2" });
    expect(targets("get_case")).not.toContain("acctVar");
    expect(targets("get_case")).not.toContain("caseList");
    expect(targets("get_case")).toContain("caseVar");
  });

  it("blocks a collection mapped onto a single value", () => {
    const { issues } = translate({ tags: { to: "note" } });
    const issue = issues.find((item) => item.mappingKey === "tags");
    expect(issue).toMatchObject({ severity: ERROR, code: "mappingType" });
    expect(issue.message).toBe(
      "tags (Text collection) is mapped to note (Text), which can't hold it."
    );
    expect(
      translate({ tags: { to: "noteList" } }).issues.filter(
        (item) => item.mappingKey === "tags"
      )
    ).toEqual([]);
  });

  it("blocks a record mapped onto another object or a collection", () => {
    expect(
      translate({ $record: { to: "acctVar" } }).issues.find(
        (item) => item.mappingKey === "$record"
      )
    ).toMatchObject({ severity: ERROR, code: "mappingType" });
    expect(
      translate({ get_case: { to: "caseList" } }).issues.find(
        (item) => item.mappingKey === "get_case"
      )
    ).toMatchObject({ severity: ERROR, code: "mappingType" });
  });

  it("blocks a name the flow changes mapped onto something read-only", () => {
    // srcNote is assigned to; greeting is a text template.
    const template = translate({ srcnote: { to: "greeting" } }).issues.find(
      (item) => item.mappingKey === "srcnote"
    );
    expect(template).toMatchObject({
      severity: ERROR,
      code: "mappingReadOnly"
    });
    expect(template.message).toBe(
      "srcNote (Text) is mapped to greeting, which can't be changed, but Stamp changes it. Map it to a variable, or bring it in as its own."
    );
    // $Record is changed by Stamp; the target's lookup result is read-only.
    for (const to of ["$Record__Prior", "Get_Owner"]) {
      expect(
        translate({ $record: { to } }).issues.find(
          (item) => item.mappingKey === "$record"
        )
      ).toMatchObject({ severity: ERROR });
    }
    // A field of $Record__Prior can't be written either.
    expect(
      translate({ srcnote: { to: "$Record__Prior.Subject" } }).issues.find(
        (item) => item.mappingKey === "srcnote"
      )
    ).toMatchObject({ severity: ERROR, code: "mappingReadOnly" });
    // Read-only is fine for a name only read.
    const plan = planMapping(typedTarget(), typedSource());
    expect(rowOf(plan, "casesubject").written).toBe(false);
    expect(
      translate({ casesubject: { to: "greeting" } }).issues.filter(
        (item) => item.mappingKey === "casesubject"
      )
    ).toEqual([]);
    // NOTE is added to: a formula can't take that.
    expect(
      translate({ note: { to: "daysOpen" } }).issues.find(
        (item) => item.mappingKey === "note"
      )
    ).toMatchObject({ severity: ERROR, code: "mappingReadOnly" });
  });

  it("blocks unresolved mappings that would otherwise pass", () => {
    const { translation } = translate({ srcnote: { to: "noSuchVariable" } });
    const merge = createMerge({
      before: buildModel(typedTarget()),
      after: translation.model
    });
    const plain = resolveMerge(merge, {});
    // Neither flow defines the name, so the flow's own checks pass it.
    expect(
      plain.issues.filter((issue) => issue.name === "noSuchVariable")
    ).toEqual([]);
    const checked = withMappingIssues(plain, translation);
    expect(checked.errors).toBe(plain.errors + 1);
    expect(checked.issues[0]).toMatchObject({
      severity: ERROR,
      code: "mappingUnresolved",
      mappingKey: "srcnote",
      message:
        "srcNote (Text) is mapped to noSuchVariable, which Typed Target doesn't have."
    });
  });

  it("blocks mappings onto things that hold no value or have no fields", () => {
    const issue = (roots, key) =>
      translate(roots).issues.find((item) => item.mappingKey === key);
    expect(
      issue({ srcnote: { to: "Check_Priority" } }, "srcnote")
    ).toMatchObject({ severity: ERROR, code: "mappingType" });
    expect(issue({ srcnote: { to: "note.Length" } }, "srcnote")).toMatchObject({
      severity: ERROR,
      code: "mappingType"
    });
    expect(
      issue({ srcnote: { to: "caseList.Subject" } }, "srcnote")
    ).toMatchObject({ severity: ERROR, code: "mappingType" });
    // A record's field is allowed, but its type can't be checked here.
    const field = issue({ srcnote: { to: "caseVar.Subject" } }, "srcnote");
    expect(field).toMatchObject({
      severity: WARNING,
      code: "mappingUnchecked"
    });
  });

  it("never treats similar names as the same thing", () => {
    const plan = planMapping(typedTarget(), typedSource());
    // caseSubject and case_subject: the same text type and a similar name.
    const row = rowOf(plan, "casesubject");
    const option = row.options.find((item) => item.to === "case_subject");
    expect(option).toMatchObject({ byName: true, score: 60 });
    expect(option.basis).toBe("Similar name, same type");
    // A guess from the name isn't used without asking.
    expect(row.defaultChoice).toEqual({ create: "caseSubject" });
    // caseId is text named like an ID: suggested, and flagged as a guess.
    // It could be caseVar's ID as well; the triggering record comes first.
    const id = rowOf(plan, "caseid");
    expect(id.options.slice(0, 2).map((item) => item.to)).toEqual([
      "$Record.Id",
      "caseVar.Id"
    ]);
    expect(id.defaultChoice).toEqual({ to: "$Record.Id" });
    expect(id.options[0]).toMatchObject({
      byName: true,
      basis: "Text named like a record ID, so taken to be the Case ID"
    });
    const suggested = translate({}).issues.find(
      (item) => item.mappingKey === "caseid"
    );
    expect(suggested).toMatchObject({
      severity: WARNING,
      code: "mappingAssumed"
    });
    // Choosing it clears the warning.
    expect(
      translate({ caseid: { to: "$Record.Id" } }).issues.filter(
        (item) => item.mappingKey === "caseid"
      )
    ).toEqual([]);
    // Structure, not the name, suggests the record a lookup finds, and
    // says when it's less sure.
    const lookup = rowOf(plan, "get_case").options.find(
      (item) => item.to === "$Record"
    );
    expect(lookup).toMatchObject({
      byName: false,
      score: 50,
      basis:
        "Gets a Case (not by ID), taken to be the one this flow starts from"
    });
    expect(rowOf(plan, "get_case").defaultChoice).toEqual({
      create: "Get_Case"
    });
  });

  it("warns when names mapped onto one share what's stored in it", () => {
    const { issues } = translate({
      srcnote: { to: "note" },
      get_case_label: { to: "note" }
    });
    expect(issues.filter((item) => item.code === "mappingShared")).toEqual([
      expect.objectContaining({
        severity: WARNING,
        mappingKey: "srcnote",
        message:
          "srcNote and Get_Case_Label are all mapped to note, and srcNote is changed, so they no longer hold separate values."
      })
    ]);
  });

  it("renames on collisions whatever their case, and says so", () => {
    const { model, notes, issues } = translate({
      // Typed in a different case from the target's note.
      srcnote: { create: "NOTE" },
      $record: { create: "caseVar" }
    });
    // srcNote asked for NOTE, which the target has as note: NOTE_2.
    expect(notes.renamed).toContainEqual({
      from: "srcNote",
      to: "NOTE_2",
      kind: "resource"
    });
    const stamp = model.nodes.get("Stamp").fields.assignmentItems;
    expect(stamp[1].assignToReference).toBe("NOTE_2");
    expect(model.resources.get("NOTE_2").fields.dataType).toBe("String");
    // The other flow's own NOTE (a number) goes on to NOTE_3.
    expect(notes.renamed).toContainEqual({
      from: "NOTE",
      to: "NOTE_3",
      kind: "resource"
    });
    expect(stamp[3].assignToReference).toBe("NOTE_3");
    expect(model.resources.get("NOTE_3").fields).toMatchObject({
      dataType: "Number",
      scale: 2
    });
    // Every name that isn't the one asked for is reported.
    const renamed = issues.filter((item) => item.code === "mappingRenamed");
    expect(renamed.map((item) => item.mappingKey).sort()).toEqual([
      "$record",
      "note",
      "srcnote"
    ]);
    expect(notes.created).toEqual([{ name: "caseVar_2", from: "$Record" }]);
    expect(renamed.find((item) => item.mappingKey === "$record").message).toBe(
      "caseVar is already a name in Typed Target (names ignore case), so $Record comes in as caseVar_2."
    );
    // Nothing in the result clashes.
    const { resolved } = mergeAll({ model, notes, issues });
    expect(resolved.issues.filter((item) => item.code === "nameClash")).toEqual(
      []
    );
  });

  it("blocks a new name that can't be an API name", () => {
    const { notes, issues } = translate({ $record: { create: "my case" } });
    expect(issues.find((item) => item.mappingKey === "$record")).toMatchObject({
      severity: ERROR,
      code: "mappingName"
    });
    // The flow is still built, under the suggested name, to show the rest.
    expect(notes.created[0].name).toBe("CaseRecord");
  });

  it("round-trips new variables and renamed references through the XML", () => {
    const { translation } = translate({
      $record: { create: "CaseRecord" },
      $record__prior: { create: "CasePrior" },
      get_case: { to: "caseVar" },
      tags: { to: "noteList" },
      caseid: { to: "$Record.Id" }
    });
    expect(translation.issues.filter((i) => i.severity === ERROR)).toEqual([]);
    const { merge, resolved } = mergeAll(translation);
    expect(resolved.errors).toBe(0);

    const xml = toXml(resolved.metadata).text;
    const back = buildModel({
      FullName: "Typed_Target",
      Metadata: fromXml(xml)
    });
    expect(unresolvedReferences(back)).toEqual([]);
    expect(
      validateFlow(back, [merge.sides.before, merge.sides.after]).filter(
        (issue) => issue.severity === ERROR
      )
    ).toEqual([]);
    for (const name of ["CaseRecord", "CasePrior"]) {
      expect(back.resources.get(name).fields).toMatchObject({
        dataType: "SObject",
        objectType: "Case",
        isCollection: false,
        isInput: true,
        isOutput: false
      });
    }
    const stamp = back.nodes.get("Stamp").fields.assignmentItems;
    expect(stamp[0].assignToReference).toBe("CaseRecord.Description");
    expect(stamp[2]).toMatchObject({
      assignToReference: "noteList",
      value: { elementReference: "caseVar.Subject" }
    });
    const condition =
      back.nodes.get("Is_Changed").fields.rules[0].conditions[0];
    expect(condition.rightValue.elementReference).toBe("CasePrior.Subject");
    // The renamed number variable keeps its type and scale.
    expect(back.resources.get("NOTE_2").fields).toMatchObject({
      dataType: "Number",
      scale: 2
    });
    // The target's start and settings are its own.
    expect(back.nodes.get("$Start").fields).toMatchObject({
      object: "Case",
      recordTriggerType: "Update"
    });
    expect(back.props.label).toBe("Typed Target");
  });
});
