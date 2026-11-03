import {
  createMerge,
  resolveMerge,
  changeGroups,
  groupPicks,
  insertPicks,
  CONFLICT
} from "c/flowMerge";
import { planMapping, suggestedChoices, translateFlow } from "c/flowMapping";
import { buildModel } from "c/flowModel";

// The flows test/e2e/seed-flows.js puts in the org, as it dumps them.
const load = (name, version = 1) =>
  JSON.parse(
    JSON.stringify(require(`fixtures/flows/${name}/v${version}.json`))
  );

describe("three-way merge of a large flow", () => {
  const discounts = () =>
    createMerge({
      base: load("UAT_Discounts_A", 1).Metadata,
      ours: load("UAT_Discounts_A", 2).Metadata,
      theirs: load("UAT_Discounts_A", 3).Metadata
    });
  const groupWith = (merge, key) =>
    changeGroups(merge).find((group) => group.keys.includes(key));

  it("stops only where both changed the same thing", () => {
    const merge = discounts();
    const conflicts = [...merge.units.values()]
      .filter((unit) => unit.status === CONFLICT)
      .map((unit) => unit.id)
      .sort();
    expect(conflicts).toEqual([
      "field|Set_Large_Discount|assignmentItems",
      "prop|description"
    ]);
    // Ours deleted Round Discount; theirs only moved it down the canvas.
    expect(merge.units.get("node|Round_Discount").status).not.toBe(CONFLICT);
    // Both moved elements around; that's no reason to stop.
    expect(
      [...merge.units.values()].some(
        (unit) => unit.kind === "pos" && unit.status === CONFLICT
      )
    ).toBe(false);
    const resolved = resolveMerge(merge, {});
    expect(resolved.errors).toBe(0);
    expect(resolved.model.nodes.has("Check_Loyalty")).toBe(true);
    expect(resolved.model.nodes.has("Score_Risk")).toBe(true);
    expect(resolved.model.nodes.has("Round_Discount")).toBe(false);
  });

  it("never puts two elements on one spot", () => {
    const merge = discounts();
    const theirs = Object.fromEntries(
      [...merge.units.values()]
        .filter((unit) => unit.kind === "pos")
        .map((unit) => [unit.id, "theirs"])
    );
    for (const picks of [{}, theirs]) {
      const placed = [...resolveMerge(merge, picks).model.nodes.values()]
        .filter((node) => typeof node.x === "number")
        .map((node) => `${node.x},${node.y}`);
      expect(new Set(placed).size).toBe(placed.length);
    }
    // Elements where ours has them stay there.
    const ours = load("UAT_Discounts_A", 2).Metadata;
    const loyalty = ours.decisions.find(
      (item) => item.name === "Check_Loyalty"
    );
    const node = resolveMerge(merge, {}).model.nodes.get("Check_Loyalty");
    expect([node.x, node.y]).toEqual([loyalty.locationX, loyalty.locationY]);
  });

  it("groups what changed together", () => {
    const merge = discounts();
    const loyalty = groupWith(merge, "Check_Loyalty");
    const risk = groupWith(merge, "Score_Risk");
    expect(loyalty.keys).toEqual(
      expect.arrayContaining(["Loyalty_Bonus", "Loyalty_Note", "Check_Tier"])
    );
    expect(risk.keys).toEqual(
      expect.arrayContaining(["Check_Risk", "Hold_Order", "Notify_Risk_Team"])
    );
    expect(risk.keys).not.toContain("Check_Loyalty");
    expect(groupWith(merge, "Round_Discount").keys).toContain("Build_Summary");
  });

  it("takes whole groups from different sides", () => {
    const merge = discounts();
    const loyalty = groupWith(merge, "Check_Loyalty").keys;
    const risk = groupWith(merge, "Score_Risk").keys;
    let picks = groupPicks(merge, loyalty, "ours");
    picks = { ...picks, ...groupPicks(merge, risk, "base", picks) };
    const resolved = resolveMerge(merge, picks);
    expect(resolved.errors).toBe(0);
    expect(
      resolved.issues.map(({ code, resourceKey }) => ({ code, resourceKey }))
    ).toEqual([
      { code: "unusedResource", resourceKey: "riskEstimate" },
      { code: "unusedResource", resourceKey: "riskScore" }
    ]);
    expect(resolved.model.resources.has("riskScore")).toBe(true);
    expect(resolved.model.nodes.has("Loyalty_Bonus")).toBe(true);
    expect(resolved.model.nodes.has("Platinum_Bonus")).toBe(false);
    expect(resolved.model.nodes.has("Score_Risk")).toBe(false);
    expect(resolved.model.nodes.has("Hold_Order")).toBe(false);
    expect(resolved.conflicts).not.toContain(
      "field|Set_Large_Discount|assignmentItems"
    );
  });
});

describe("merging flows that start differently", () => {
  const record = () => buildModel(load("UAT_Case_Triage_Record"));
  const sub = () => buildModel(load("UAT_Case_Triage_Sub"));
  const screen = () => buildModel(load("UAT_Case_Screen"));

  const place = (target, source) => {
    const plan = planMapping(target, source);
    const { model, notes } = translateFlow(
      target,
      source,
      suggestedChoices(plan),
      plan
    );
    const merge = createMerge({ before: target, after: model });
    const picks = insertPicks(
      merge,
      resolveMerge(merge, {}),
      notes.added,
      "after",
      "$Start",
      "startElementReference",
      notes.entry
    );
    return { plan, notes, resolved: resolveMerge(merge, picks) };
  };
  const mapped = (notes) =>
    Object.fromEntries(notes.mapped.map((row) => [row.from, row.to]));

  it.each([
    [
      "the subflow into the record-triggered flow",
      record,
      sub,
      { caseRecord: "$Record" }
    ],
    [
      "the record-triggered flow into the subflow",
      sub,
      record,
      { $Record: "caseRecord" }
    ],
    [
      "the subflow into the screen flow",
      screen,
      sub,
      { caseRecord: "Get_Case" }
    ]
  ])(
    "places %s with nothing left to fix",
    (title, target, source, expected) => {
      const { notes, resolved } = place(target(), source());
      expect(mapped(notes)).toEqual(expected);
      expect(resolved.errors).toBe(0);
      expect(resolved.issues).toEqual([]);
    }
  );

  it.each([
    [
      "the record-triggered flow",
      record,
      { recordId: "$Record.Id", Get_Case: "$Record" },
      "a record-triggered flow"
    ],
    [
      "the subflow",
      sub,
      { recordId: "caseRecord.Id", Get_Case: "caseRecord" },
      "an autolaunched flow"
    ]
  ])(
    "maps the screen flow into %s but says its screens can't go there",
    (title, target, expected, kind) => {
      const { notes, resolved } = place(target(), screen());
      expect(mapped(notes)).toEqual(expected);
      const screens = resolved.issues.filter(
        (issue) => issue.code === "screenNotAllowed"
      );
      expect(screens.length).toBeGreaterThan(0);
      expect(screens.length).toBe(resolved.errors);
      expect(screens.length).toBe(resolved.issues.length);
      expect(screens[0].message).toContain(`${kind} can't show screens`);
    }
  );

  it("keeps both of a shared element whose paths differ", () => {
    const { plan, resolved } = place(sub(), screen());
    const check = plan.elements.find((row) => row.name === "Check_Priority");
    expect(check.same).toBe(false);
    expect(check.defaultChoice).toBe("both");
    expect(resolved.model.nodes.has("Check_Priority_2")).toBe(true);
  });
});
