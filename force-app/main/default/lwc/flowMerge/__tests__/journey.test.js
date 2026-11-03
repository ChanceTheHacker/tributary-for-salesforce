// One journey through composing two unrelated flows, end to end on the
// model: map what the other flow uses, take a group of its elements, see
// where they'll go, put them on a path, undo, and write the draft. Both
// flows are the synthetic Case Triage and Case Helper fixtures.
import {
  isCrossFlow,
  planMapping,
  suggestedChoices,
  translateFlow,
  withMappingIssues
} from "c/flowMapping";
import {
  createMerge,
  resolveMerge,
  placePlan,
  wireId,
  ERROR
} from "c/flowMerge";
import { buildModel, toMetadata, RESOURCE_COLLECTIONS } from "c/flowModel";
import { fromXml, toXml } from "c/flowXml";

const flow = (name) =>
  JSON.parse(JSON.stringify(require(`fixtures/flows/${name}/v1.json`)));

// Everything about a flow that isn't one of its elements or resources.
function settings(metadata) {
  const out = {};
  for (const [field, value] of Object.entries(metadata)) {
    if (!Array.isArray(value) || field === "processMetadataValues") {
      out[field] = value;
    }
  }
  return out;
}

function setUp() {
  const target = flow("Case_Triage");
  const source = flow("Case_Helper");
  const sourceBefore = JSON.stringify(source);
  const plan = planMapping(target, source);
  const choices = suggestedChoices(plan);
  // Its case id is the triggering record's: confirmed, not assumed.
  choices.roots.recordid = { to: "$Record.Id" };
  const translation = translateFlow(target, source, choices, plan);
  const before = buildModel(target);
  const merge = createMerge({ before, after: translation.model });
  const resolve = (picks) =>
    withMappingIssues(resolveMerge(merge, picks), translation);
  return {
    target,
    source,
    sourceBefore,
    translation,
    before,
    merge,
    resolve
  };
}

describe("composing an unrelated flow's group into another", () => {
  it("maps, previews, places, undoes and writes a draft", () => {
    const {
      target,
      source,
      sourceBefore,
      translation,
      before,
      merge,
      resolve
    } = setUp();
    expect(isCrossFlow(before, translation.model)).toBe(true);
    expect(translation.issues).toEqual([]);
    expect(translation.notes.mapped).toEqual([
      { from: "Get_Case", to: "$Record" },
      { from: "recordId", to: "$Record.Id" }
    ]);
    // Its note clashes with the target's, which is a Number: a new one.
    expect(translation.notes.renamed).toContainEqual({
      from: "note",
      to: "note_2",
      kind: "resource"
    });

    // To begin with, nothing of it is in.
    const start = {};
    const initial = resolve(start);
    expect(initial.errors).toBe(0);
    expect(initial.model.nodes.has("Route")).toBe(false);

    // Take Route and Set_Note, and put them on Check_Priority's High path.
    const keys = ["Route", "Set_Note"];
    const at = ["Check_Priority", "rules.High.connector"];
    const preview = placePlan(merge, initial, keys, "after", ...at, {
      current: start
    });
    expect(preview.entry).toBe("Route");
    expect(preview.next).toBe("Escalate");
    expect(preview.dependencies).toEqual(["note_2"]);
    expect(preview.detached).toEqual([]);
    expect(preview.stranded).toEqual([]);
    expect(preview.cycles).toEqual([]);
    // Route's default ended the other flow; Set_Note led to that flow's
    // own Escalate, which isn't brought. Both are for someone to decide.
    expect(preview.open).toBe(2);
    expect(
      preview.exits.filter((exit) => exit.choice).map((exit) => exit.id)
    ).toEqual([
      wireId("Route", "defaultConnector"),
      wireId("Set_Note", "connector")
    ]);

    const routes = {
      [wireId("Route", "defaultConnector")]: "Escalate",
      [wireId("Set_Note", "connector")]: "Escalate"
    };
    const plan = placePlan(merge, initial, keys, "after", ...at, {
      routes,
      current: start
    });
    expect(plan.open).toBe(0);
    const picks = { ...start, ...plan.picks };
    const resolved = resolve(picks);

    expect(resolved.errors).toBe(0);
    expect(resolved.issues.filter((issue) => issue.severity === ERROR)).toEqual(
      []
    );
    const { model } = resolved;
    expect(model.nodes.has("Route")).toBe(true);
    expect(model.nodes.has("Set_Note")).toBe(true);
    expect(model.nodes.has("Escalate_2")).toBe(false);
    // The new variable it uses comes with it, with the type it had.
    expect(model.resources.get("note_2").fields.dataType).toBe("String");
    expect(model.resources.get("note").fields.dataType).toBe("Number");
    const edge = (key) => model.edges.get(key) && model.edges.get(key).target;
    expect(edge("Check_Priority.rules.High.connector")).toBe("Route");
    expect(edge("Route.rules.High_2.connector")).toBe("Set_Note");
    expect(edge("Route.defaultConnector")).toBe("Escalate");
    expect(edge("Set_Note.connector")).toBe("Escalate");
    // It uses the triggering record where it used its own lookup.
    const route = model.nodes.get("Route").fields;
    expect(route.rules[0].conditions[0].leftValueReference).toBe(
      "$Record.Priority"
    );
    const assignment = model.nodes.get("Set_Note").fields.assignmentItems[0];
    expect(assignment.assignToReference).toBe("note_2");
    expect(assignment.value.stringValue).toBe(
      "Case {!$Record.CaseNumber} is high"
    );

    // The target keeps its settings, its start and its trigger.
    const original = toMetadata(before);
    expect(settings(resolved.metadata)).toEqual(settings(original));
    expect(resolved.metadata.start).toEqual(original.start);
    // The other flow is as it was.
    expect(JSON.stringify(source)).toBe(sourceBefore);
    expect(target.FullName).toBe("Case_Triage");

    // Undoing is going back to the picks before: the target as it was.
    expect(resolve(start).metadata).toEqual(initial.metadata);
    expect(initial.metadata.decisions).toEqual(original.decisions);

    // The draft is written as XML and reads back the same, as a draft.
    const xml = toXml({ ...resolved.metadata, status: "Draft" }).text;
    expect(xml).toContain("<status>Draft</status>");
    expect(xml).not.toContain("<status>Active</status>");
    const read = fromXml(xml);
    expect(read.status).toBe("Draft");
    const { status, ...rest } = read; // eslint-disable-line no-unused-vars
    expect(buildModel(rest).nodes.get("Set_Note").fields).toEqual(
      model.nodes.get("Set_Note").fields
    );
    for (const field of RESOURCE_COLLECTIONS) {
      expect((rest[field] || []).map((item) => item.name).sort()).toEqual(
        (resolved.metadata[field] || []).map((item) => item.name).sort()
      );
    }
  });

  it("won't route a path somewhere that isn't offered", () => {
    const { merge, resolve } = setUp();
    const initial = resolve({});
    const plan = placePlan(
      merge,
      initial,
      ["Route", "Set_Note"],
      "after",
      "Check_Priority",
      "rules.High.connector",
      {
        routes: {
          [wireId("Route", "defaultConnector")]: "Escalate_2",
          [wireId("Set_Note", "connector")]: ""
        }
      }
    );
    // Ending Set_Note is offered; going to the other flow's Escalate isn't.
    expect(plan.open).toBe(1);
    expect(plan.picks[wireId("Set_Note", "connector")]).toBe("");
  });

  it("ends a path where asked, without leaving it dangling", () => {
    const { merge, resolve } = setUp();
    const initial = resolve({});
    const routes = {
      [wireId("Route", "defaultConnector")]: "",
      [wireId("Set_Note", "connector")]: ""
    };
    const plan = placePlan(
      merge,
      initial,
      ["Route", "Set_Note"],
      "after",
      "Check_Priority",
      "rules.High.connector",
      { routes }
    );
    expect(plan.open).toBe(0);
    // Ending both skips what the High path led to: said before it's done.
    expect(plan.stranded).toEqual(["Escalate"]);
    const resolved = resolve(plan.picks);
    expect(resolved.errors).toBe(0);
    const { model } = resolved;
    expect(model.edges.has("Route.defaultConnector")).toBe(false);
    expect(model.edges.has("Set_Note.connector")).toBe(false);
    // Nothing leads anywhere that isn't there.
    for (const item of model.edges.values()) {
      expect(model.nodes.has(item.target)).toBe(true);
    }
    // Escalate is now reached only when Check_Priority's path isn't High.
    expect(
      [...model.edges.values()].filter((item) => item.target === "Escalate")
    ).toEqual([]);
    expect(
      resolved.issues.some(
        (issue) => issue.code === "unreachable" && issue.nodeKey === "Escalate"
      )
    ).toBe(true);
  });
});
