import {
  elementInfo,
  resourceInfo,
  connectorLabel,
  flowTypeLabel,
  startSummary,
  humanize,
  formatValue,
  phrase,
  phraseContext
} from "c/flowElements";
import { buildModel, NODE_COLLECTIONS } from "c/flowModel";

const load = (flow, version = 1) =>
  buildModel(require(`fixtures/flows/${flow}/v${version}.json`));

describe("flowElements", () => {
  it("has a label and icon for every element type", () => {
    for (const type of NODE_COLLECTIONS) {
      const info = elementInfo({ type, fields: {} });
      expect(info.label).toBeTruthy();
      expect(info.icon).toMatch(/^standard:[a-z_]+$/);
    }
    expect(elementInfo({ type: "somethingNew" })).toEqual({
      label: "Something New",
      icon: "standard:default"
    });
  });

  it("picks icons by action type and collection processor", () => {
    expect(
      elementInfo({ type: "actionCalls", fields: { actionType: "apex" } }).icon
    ).toBe("standard:apex");
    expect(
      elementInfo({
        type: "collectionProcessors",
        fields: { elementSubtype: "SortCollectionProcessor" }
      }).label
    ).toBe("Collection Sort");
  });

  it("describes resources", () => {
    expect(
      resourceInfo({
        type: "variables",
        fields: { dataType: "SObject", isCollection: true }
      }).label
    ).toBe("Record Collection Variable");
    expect(resourceInfo({ type: "formulas", fields: {} }).icon).toBe(
      "standard:formula"
    );
  });

  it("labels connectors", () => {
    const model = load("Case_Email_Routing", 4);
    const labels = [...model.edges.values()].map(connectorLabel);
    expect(labels).toContain("For Each Item");
    expect(labels).toContain("After Last Item");
    expect(connectorLabel({ kind: "next" })).toBeUndefined();
    expect(
      connectorLabel({ kind: "outcome", slot: "rules.Match.connector" })
    ).toBe("Match");
  });

  it("describes the flow and its start", () => {
    const model = load("Case_Email_Routing", 4);
    expect(flowTypeLabel(model)).toMatch(/Flow/);
    expect(startSummary(model)).toMatch(/Case|Flow/);
    expect(flowTypeLabel(load("Analyze_Flows"))).toBe("Screen Flow");
  });

  it("formats names and values", () => {
    expect(humanize("recordLookups")).toBe("Record Lookups");
    expect(humanize("Custom_Field__c")).toBe("Custom Field");
    expect(formatValue({ stringValue: "x" })).toBe("x");
    expect(formatValue({ elementReference: "var" })).toBe("{!var}");
    expect(formatValue(undefined)).toBe("—");
    expect(formatValue(true)).toBe("true");
    expect(formatValue([1, 2])).toContain("1");
  });

  it("reads lists and records as lines rather than JSON", () => {
    const rule = {
      conditionLogic: "and",
      conditions: [
        {
          leftValueReference: "amount",
          operator: "GreaterThan",
          rightValue: { numberValue: 20000, stringValue: null }
        }
      ],
      connector: { targetReference: "Set_Large", isGoTo: null },
      description: null,
      processMetadataValues: [],
      label: "Large Order"
    };
    expect(formatValue(rule)).toBe(
      [
        "Condition logic: All conditions are met",
        "Conditions:",
        "  1. amount is greater than 20000",
        "Connector: Set_Large",
        "Label: Large Order"
      ].join("\n")
    );
    expect(formatValue({})).toBe("None");
  });

  it("reads conditions, filters and assignments as sentences", () => {
    const condition = (operator, rightValue) =>
      phrase({ leftValueReference: "Amount", operator, rightValue });
    expect(condition("GreaterThan", { numberValue: 10000 })).toBe(
      "Amount is greater than 10000"
    );
    expect(condition("EqualTo", { stringValue: "Won" })).toBe(
      "Amount equals “Won”"
    );
    expect(condition("EqualTo", { elementReference: "Limit" })).toBe(
      "Amount equals Limit"
    );
    expect(condition("IsNull", { booleanValue: false })).toBe(
      "Amount isn't null"
    );
    expect(condition("IsToday")).toBe("Amount is today");
    expect(condition("LastNumberOfDays", { numberValue: 30 })).toBe(
      "Amount is in the last 30 days"
    );
    expect(
      phrase({
        field: "StageName",
        operator: "NotEqualTo",
        value: { stringValue: "Closed" }
      })
    ).toBe("StageName doesn't equal “Closed”");
    expect(
      phrase({
        assignToReference: "Total",
        operator: "Add",
        value: { numberValue: 5 }
      })
    ).toBe("Add 5 to Total");
    expect(phrase({ field: "Status", value: { stringValue: "New" } })).toBe(
      "Set Status to “New”"
    );
    expect(
      phrase(
        { name: "recordId", value: { elementReference: "Id" } },
        "inputParameters"
      )
    ).toBe("Set input recordId to Id");
    // A name and value alone could be anything outside a parameter list.
    expect(phrase({ name: "x", value: { numberValue: 1 } })).toBeUndefined();
    expect(formatValue("GreaterThan", "operator")).toBe("is greater than");
    expect(formatValue("1 AND (2 OR 3)", "conditionLogic")).toBe(
      "Custom: 1 AND (2 OR 3)"
    );
  });

  it("finds the sentence a change sits in", () => {
    const fields = {
      rules: [
        {
          name: "Big",
          conditions: [
            {
              leftValueReference: "Amount",
              operator: "GreaterThan",
              rightValue: { numberValue: 15000 }
            }
          ]
        }
      ]
    };
    const context = phraseContext(fields, [
      "rules",
      "Big",
      "conditions",
      0,
      "rightValue",
      "numberValue"
    ]);
    expect(context.path).toEqual(["rules", "Big", "conditions", 0]);
    expect(context.key).toBe("conditions");
    expect(phraseContext(fields, ["rules", "Big", "label"])).toBeUndefined();
  });
});
