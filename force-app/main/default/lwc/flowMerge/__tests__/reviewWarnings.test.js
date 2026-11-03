import { createMerge, groupPicks, resolveMerge } from "c/flowMerge";

const base = {
  label: "Review fixture",
  processType: "AutoLaunchedFlow",
  start: { connector: { targetReference: "Keep" } },
  assignments: [{ name: "Keep", label: "Keep" }]
};

const added = {
  ...base,
  assignments: [
    { ...base.assignments[0], connector: { targetReference: "Extra" } },
    {
      name: "Extra",
      label: "Extra",
      assignmentItems: [
        {
          assignToReference: "scratch",
          operator: "Assign",
          value: { numberValue: 1 }
        }
      ]
    }
  ],
  variables: [
    {
      name: "scratch",
      dataType: "Number",
      scale: 0,
      isInput: false,
      isOutput: false
    }
  ]
};

describe("review warnings", () => {
  it("keeps a removed group's resource and warns when its references disappear", () => {
    const merge = createMerge({ base, ours: added, theirs: base });
    const resolved = resolveMerge(merge, groupPicks(merge, ["Extra"], "base"));
    expect(resolved.model.resources.has("scratch")).toBe(true);
    expect(resolved.issues).toContainEqual(
      expect.objectContaining({
        code: "unusedResource",
        resourceKey: "scratch"
      })
    );
    expect(resolved.errors).toBe(0);
  });

  it("does not call an externally exposed variable unused", () => {
    const exposed = {
      ...added,
      variables: [{ ...added.variables[0], isOutput: true }]
    };
    const merge = createMerge({ base, ours: exposed, theirs: base });
    const resolved = resolveMerge(merge, groupPicks(merge, ["Extra"], "base"));
    expect(resolved.model.resources.has("scratch")).toBe(true);
    expect(
      resolved.issues.some((issue) => issue.code === "unusedResource")
    ).toBe(false);
  });

  it("does not warn while another element still refers to the resource", () => {
    const merge = createMerge({ base, ours: added, theirs: base });
    expect(
      resolveMerge(merge).issues.some(
        (issue) => issue.code === "unusedResource"
      )
    ).toBe(false);
  });
});
