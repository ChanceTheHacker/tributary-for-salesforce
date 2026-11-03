import { createElement } from "lwc";
import FlowElementPanel from "c/flowElementPanel";
import { buildModel } from "c/flowModel";
import { diffFlows } from "c/flowDiff";
import { createMerge, resolveMerge } from "c/flowMerge";
import { formatValue } from "c/flowElements";

// Counts how often values are formatted, which is the panel's costly part.
jest.mock("c/flowElements", () => {
  const actual = jest.requireActual("c/flowElements");
  return { ...actual, formatValue: jest.fn(actual.formatValue) };
});

const source = require("fixtures/flows/Case_Email_Routing/v4.json");
const before = buildModel(source);

function edited() {
  const metadata = JSON.parse(JSON.stringify(source.Metadata));
  metadata.recordLookups[0].label = "Get Routing Rules";
  metadata.decisions.find(
    (d) => d.name === "Should_Case_Be_Updated"
  ).defaultConnector.targetReference = "Update_Case_Record";
  return buildModel(metadata);
}

const after = edited();
const diff = diffFlows(before, after);
const labels = { before: "Version 4", after: "Edited" };

function mount(props) {
  const element = createElement("c-flow-element-panel", {
    is: FlowElementPanel
  });
  Object.assign(element, props);
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
});

describe("c-flow-element-panel", () => {
  it("lists an element's changes with both sides", async () => {
    const entry = diff.nodes.find((n) => n.key === "Get_Routing");
    const element = mount({ entry, diff, labels });
    await Promise.resolve();
    const root = element.shadowRoot;
    expect(root.querySelector(".title").textContent).toBe("Get Routing Rules");
    const card = root.querySelector(".changes .change");
    expect(card.querySelector(".path").textContent).toBe("Label");
    expect(card.querySelector(".path").title).toBe("label");
    const sides = [...card.querySelectorAll(".line-side")].map(
      (side) => side.textContent
    );
    expect(sides).toEqual(["Version 4", "Edited"]);
    expect(card.querySelector(".after .text").textContent).toBe(
      "Get Routing Rules"
    );
  });

  it("shows a changed condition as a sentence before and after", async () => {
    const metadata = JSON.parse(JSON.stringify(source.Metadata));
    const rule = metadata.decisions.find(
      (d) => d.name === "Should_Case_Be_Updated"
    ).rules[0];
    rule.conditions[0].operator = "NotEqualTo";
    rule.conditions[0].rightValue = { stringValue: "Nope" };
    const changed = diffFlows(before, buildModel(metadata));
    const entry = changed.nodes.find((n) => n.key === "Should_Case_Be_Updated");
    const element = mount({ entry, diff: changed, labels });
    await Promise.resolve();
    const cards = element.shadowRoot.querySelectorAll(".changes .change");
    // Operator and value changed; they read as one condition.
    expect(cards.length).toBe(1);
    expect(cards[0].querySelector(".path").textContent).toMatch(
      /^Outcome .+ › Condition 1$/
    );
    expect(cards[0].querySelector(".before .text").textContent).toBe(
      "matchFound equals true"
    );
    expect(cards[0].querySelector(".after .text").textContent).toBe(
      "matchFound doesn't equal “Nope”"
    );
  });

  it("shows reconnected connectors with their old target", async () => {
    const entry = diff.nodes.find((n) => n.key === "Should_Case_Be_Updated");
    const element = mount({ entry, diff, labels });
    await Promise.resolve();
    const moved = element.shadowRoot.querySelector(".connector-retargeted");
    expect(moved.querySelector(".old-target").textContent).toMatch(/^was /);
    expect(moved.querySelector(".target").textContent).toMatch(/^now /);
    expect(moved.querySelector(".connector-status")).toBeNull();
    // Its own settings match, but it isn't "Unchanged".
    expect(entry.status).toBe("unchanged");
    const status = element.shadowRoot.querySelector(".status");
    expect(status.textContent).toBe("Reconnected");
    expect(status.className).toContain("status-changed");
    expect(element.shadowRoot.querySelector(".summary").textContent).toBe(
      "Only its connectors changed."
    );
  });

  it("shows only the connectors of an element's own type", async () => {
    // Get_Routing becomes an assignment going somewhere else.
    const metadata = JSON.parse(JSON.stringify(source.Metadata));
    metadata.recordLookups = [];
    metadata.assignments.push({
      name: "Get_Routing",
      label: "Get Routing",
      locationX: 0,
      locationY: 0,
      assignmentItems: [],
      connector: { targetReference: "Assign_Matching_Template" }
    });
    const retyped = diffFlows(before, buildModel(metadata));
    const targets = async (entry) => {
      const element = mount({ entry, diff: retyped, labels });
      await Promise.resolve();
      const rows = [...element.shadowRoot.querySelectorAll(".connector")];
      element.remove();
      return rows.map((row) => row.className.replace("connector ", ""));
    };
    const old = retyped.nodes.find(
      (n) => n.key === "Get_Routing" && n.status === "removed"
    );
    const added = retyped.nodes.find(
      (n) => n.key === "Get_Routing" && n.status === "added"
    );
    expect(await targets(old)).toEqual(["connector-removed"]);
    expect(await targets(added)).toEqual(["connector-added"]);
  });

  it("picks sides in a merge", async () => {
    const merge = createMerge({ before, after });
    const resolved = resolveMerge(merge, {});
    const entry = diffFlows(before, resolved.model).nodes.find(
      (n) => n.key === "Get_Routing"
    );
    const element = mount({ entry, diff, labels, merge, resolved });
    const handler = jest.fn();
    element.addEventListener("pick", handler);
    await Promise.resolve();
    const radios = element.shadowRoot.querySelectorAll("input[type=radio]");
    expect(radios.length).toBeGreaterThanOrEqual(2);
    expect(radios[0].checked).toBe(true);
    radios[1].checked = true;
    radios[1].dispatchEvent(new CustomEvent("change"));
    expect(Object.values(handler.mock.calls[0][0].detail.picks)).toEqual([
      "after"
    ]);
    const takeAll = element.shadowRoot.querySelectorAll(
      ".take-all lightning-button"
    );
    expect(takeAll[1].label).toBe("Edited");
    expect(takeAll).toHaveLength(2);
    takeAll[1].click();
    const picks = handler.mock.calls[1][0].detail.picks;
    expect(Object.values(picks).every((side) => side === "after")).toBe(true);
  });

  it("asks whether to keep an element only one version has", async () => {
    const metadata = JSON.parse(JSON.stringify(source.Metadata));
    metadata.assignments.push({
      name: "Log_Result",
      label: "Log Result",
      locationX: 0,
      locationY: 0,
      assignmentItems: []
    });
    const added = buildModel(metadata);
    const merge = createMerge({ before, after: added });
    const resolved = resolveMerge(merge, {});
    const entry = diffFlows(before, added).nodes.find(
      (n) => n.key === "Log_Result"
    );
    const element = mount({ entry, diff, labels, merge, resolved });
    await Promise.resolve();
    const cells = [...element.shadowRoot.querySelectorAll(".cell")];
    expect(
      cells.map((cell) => cell.querySelector(".cell-action").textContent)
    ).toEqual(["Leave it out", "Keep it"]);
    expect(
      [...element.shadowRoot.querySelectorAll(".cell input")].map((radio) =>
        radio.getAttribute("aria-label")
      )
    ).toEqual(["Version 4: leave it out", "Edited: keep it"]);
    expect(cells[0].querySelector(".value").textContent).toBe(
      "Not in Version 4"
    );
    // The details above show the element; its choice needn't repeat them.
    expect(cells[1].querySelector(".value").textContent).toBe("");
  });

  it("shows where each version's paths lead in a whole-element choice", async () => {
    const withRoute = (target) => {
      const metadata = JSON.parse(JSON.stringify(source.Metadata));
      metadata.assignments.push({
        name: "Route",
        label: "Route",
        locationX: 0,
        locationY: 0,
        assignmentItems: [],
        connector: { targetReference: target }
      });
      return buildModel(metadata);
    };
    const merge = createMerge({
      base: before,
      ours: withRoute("Get_Routing"),
      theirs: withRoute("Update_Case_Record")
    });
    expect(merge.units.get("node|Route").status).toBe("conflict");
    const resolved = resolveMerge(merge, {});
    const entry = diffFlows(merge.sides.base, resolved.model).nodes.find(
      (n) => n.key === "Route"
    );
    const element = mount({
      entry,
      labels: { base: "Version 4", ours: "Mine", theirs: "Theirs" },
      merge,
      resolved
    });
    await Promise.resolve();
    const values = [...element.shadowRoot.querySelectorAll(".cell")].map(
      (cell) => cell.querySelector(".value").textContent
    );
    expect(values[0]).toBe("Not in Version 4");
    expect(values[1]).toContain("Next: Get_Routing");
    expect(values[2]).toContain("Next: Update_Case_Record");
    const expand = element.shadowRoot.querySelector(".expand");
    if (expand) expand.click();
    await Promise.resolve();
    const whole = [...element.shadowRoot.querySelectorAll(".value")]
      .map((cell) => cell.textContent)
      .join(" ");
    expect(whole).not.toContain("Synthetic:");
    expect(whole).not.toContain("Type: assignments");
    expect(whole).toContain("Type: Assignment");
  });

  it("shows an issue a resource has on its own panel", async () => {
    // An autolaunched flow, so there's no $Record for Discount to use.
    const flow = (withDiscount, stepUses) =>
      buildModel({
        label: "Discounts",
        processType: "AutoLaunchedFlow",
        start: { connector: { targetReference: "Step" } },
        assignments: [
          {
            name: "Step",
            label: "Step",
            assignmentItems: [
              {
                assignToReference: "Total",
                operator: "Assign",
                value: { elementReference: stepUses }
              }
            ]
          }
        ],
        variables: [{ name: "Total", dataType: "Number", scale: 2 }],
        formulas: withDiscount
          ? [
              {
                name: "Discount",
                dataType: "Number",
                scale: 2,
                expression: "{!$Record.Amount} * 0.1"
              }
            ]
          : undefined
      });
    const messages = async (stepUses) => {
      const start = flow(false, stepUses);
      const later = flow(true, stepUses);
      const merge = createMerge(
        { before: start, after: later },
        { defaultSide: "after" }
      );
      const resolved = resolveMerge(merge, {});
      const entry = diffFlows(start, later).resources.find(
        (r) => r.key === "Discount"
      );
      const element = mount({
        entry,
        kind: "resource",
        labels,
        merge,
        resolved
      });
      await Promise.resolve();
      const shown = [...element.shadowRoot.querySelectorAll(".issue")].map(
        (issue) => issue.textContent
      );
      document.body.removeChild(element);
      return shown;
    };
    // Discount alone uses it, and then with an element that uses it too.
    expect(await messages("Total")).toEqual([
      "Resource Discount uses $Record, but the flow doesn't start from a record, so there's no $Record."
    ]);
    expect(await messages("$Record.Amount")).toEqual([
      "Step (Step) and 1 more use $Record, but the flow doesn't start from a record, so there's no $Record."
    ]);
  });

  it("asks to show the element as text", async () => {
    const entry = diff.nodes[0];
    const element = mount({ entry, diff, labels });
    const handler = jest.fn();
    element.addEventListener("showtext", handler);
    await Promise.resolve();
    element.shadowRoot.querySelector(".footer lightning-button").click();
    expect(handler.mock.calls[0][0].detail.id).toBe(entry.id);
  });

  it("names each choice briefly and marks where long values differ", async () => {
    const decision = (metadata) =>
      metadata.decisions.find((d) => d.name === "Should_Case_Be_Updated");
    const change = (value) => {
      const metadata = JSON.parse(JSON.stringify(source.Metadata));
      const rule = decision(metadata).rules[0];
      rule.conditions[0].rightValue = { stringValue: value };
      rule.description = "Checks whether the case matched a template.";
      // Long enough that only the lines that differ show at first.
      for (const field of ["Status", "Origin", "Priority"]) {
        rule.conditions.push({
          leftValueReference: field,
          operator: "IsNull",
          rightValue: { booleanValue: false }
        });
      }
      return buildModel(metadata);
    };
    const merge = createMerge({
      base: before,
      ours: change("Ours"),
      theirs: change("Theirs")
    });
    const resolved = resolveMerge(merge, {});
    const entry = diffFlows(merge.sides.ours, resolved.model).nodes.find(
      (n) => n.key === "Should_Case_Be_Updated"
    );
    const element = mount({
      entry,
      labels: { base: "Version 4", ours: "Mine", theirs: "Theirs" },
      merge,
      resolved,
      nextLabel: "Next conflict"
    });
    const handler = jest.fn();
    element.addEventListener("next", handler);
    await Promise.resolve();
    const root = element.shadowRoot;
    const conflict = root.querySelector(".unit-conflict");
    const cells = [...conflict.querySelectorAll(".cell")];
    const radio = cells[2].querySelector("input");
    // The radio is named by its side; what differs is its description.
    expect(radio.getAttribute("aria-label")).toBe("Theirs");
    expect(cells[2].querySelector(".slds-assistive-text").hidden).toBe(true);
    expect(cells[2].querySelector(".slds-assistive-text").textContent).toMatch(
      /matchFound equals “Theirs”/
    );
    // Only the differing lines show until the row is opened out.
    const shown = () =>
      [...cells[2].querySelectorAll(".vline")].map((line) => line.textContent);
    expect(shown()).toContain("1. matchFound equals “Theirs”");
    expect(shown()).not.toContain("Label: Update Case");
    const expand = conflict.querySelector(".expand");
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expand.click();
    await Promise.resolve();
    const all = [...root.querySelectorAll(".unit-conflict .cell")][2];
    expect(
      [...all.querySelectorAll(".vline")].map((line) => line.textContent)
    ).toContain("Label: Update Case");
    expect(all.querySelectorAll(".vline-diff").length).toBeGreaterThan(0);

    // Focus goes to the conflict's first choice.
    const focus = jest.spyOn(HTMLElement.prototype, "focus");
    element.focusChoice();
    expect(focus.mock.contexts[0]).toBe(
      root.querySelector(".unit-conflict input")
    );
    focus.mockRestore();
    root.querySelector(".next lightning-button").click();
    expect(handler).toHaveBeenCalled();
  });

  it("leaves an open conflict unpicked and says what it previews", async () => {
    const theirs = JSON.parse(JSON.stringify(source.Metadata));
    theirs.recordLookups[0].label = "Find Routing Rules";
    const merge = createMerge({
      base: before,
      ours: after,
      theirs: buildModel(theirs)
    });
    const resolved = resolveMerge(merge, {});
    const entry = diffFlows(after, resolved.model).nodes.find(
      (n) => n.key === "Get_Routing"
    );
    const element = mount({
      entry,
      diff,
      labels: { base: "Version 4", ours: "Mine", theirs: "Theirs" },
      merge,
      resolved
    });
    await Promise.resolve();
    const root = element.shadowRoot;
    expect(root.querySelector(".status").textContent).toBe("Conflict");
    expect(root.querySelector(".summary").textContent).toContain(
      "1 conflict to resolve"
    );
    const conflict = root.querySelector(".unit-conflict");
    const radios = [...conflict.querySelectorAll("input[type=radio]")];
    expect(radios.some((radio) => radio.checked)).toBe(false);
    expect(conflict.querySelector(".preview")).not.toBeNull();
  });

  it("names the version a resolved conflict uses", async () => {
    const theirs = JSON.parse(JSON.stringify(source.Metadata));
    theirs.recordLookups[0].label = "Find Routing Rules";
    const merge = createMerge({
      base: before,
      ours: after,
      theirs: buildModel(theirs)
    });
    const conflict = [...merge.units.values()].find(
      (unit) => unit.nodeKey === "Get_Routing" && unit.status === "conflict"
    );
    const resolved = resolveMerge(merge, { [conflict.id]: "theirs" });
    const entry = diffFlows(after, resolved.model).nodes.find(
      (n) => n.key === "Get_Routing"
    );
    const element = mount({
      entry,
      diff,
      labels: { base: "Version 4", ours: "Mine", theirs: "Theirs" },
      merge,
      resolved
    });
    await Promise.resolve();
    const root = element.shadowRoot;
    // Not "Unchanged", which reads as though the pick did nothing.
    expect(root.querySelector(".status").textContent).toBe("Resolved");
    expect(root.querySelector(".summary").textContent).toBe(
      "Resolved: the result uses Theirs here."
    );
  });

  it("lays out properties only once they're opened", async () => {
    const entry = diff.nodes.find((n) => n.key === "Get_Routing");
    const element = mount({ entry, diff, labels });
    await Promise.resolve();
    const root = element.shadowRoot;
    const details = root.querySelector("details.properties");
    expect(details.open).toBe(false);
    expect(root.querySelectorAll(".property")).toHaveLength(0);

    details.open = true;
    details.dispatchEvent(new CustomEvent("toggle"));
    await Promise.resolve();
    const names = [...root.querySelectorAll(".property dt")].map(
      (dt) => dt.textContent
    );
    expect(names).toContain("Label");

    // Another element keeps the section open.
    element.entry = diff.nodes.find((n) => n.key === "Update_Case_Record");
    await Promise.resolve();
    expect(root.querySelector("details.properties").open).toBe(true);
    expect(root.querySelectorAll(".property").length).toBeGreaterThan(0);

    details.open = false;
    details.dispatchEvent(new CustomEvent("toggle"));
    await Promise.resolve();
    expect(root.querySelectorAll(".property")).toHaveLength(0);
  });

  it("doesn't format values again when nothing they show changed", async () => {
    const merge = createMerge({ before, after });
    const resolved = resolveMerge(merge, {});
    const entry = diffFlows(before, resolved.model).nodes.find(
      (n) => n.key === "Get_Routing"
    );
    const element = mount({ entry, diff, labels, merge, resolved });
    await Promise.resolve();
    expect(element.shadowRoot.querySelectorAll(".unit").length).toBeGreaterThan(
      0
    );
    formatValue.mockClear();
    element.nextLabel = "Next conflict";
    await Promise.resolve();
    expect(element.shadowRoot.querySelector(".next")).not.toBeNull();
    expect(formatValue).not.toHaveBeenCalled();

    // A pick is a new resolved merge, so the rows are worked out again.
    element.resolved = resolveMerge(merge, {
      [merge.units.keys().next().value]: "after"
    });
    await Promise.resolve();
    expect(formatValue).toHaveBeenCalled();
  });
});
