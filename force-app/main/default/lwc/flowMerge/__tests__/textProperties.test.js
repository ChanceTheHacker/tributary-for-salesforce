import { createMerge, resolveMerge, textPick } from "c/flowMerge";
import { toXml, fromXml } from "c/flowXml";

const base = {
  label: "Flow",
  description: "Original",
  processType: "AutoLaunchedFlow"
};
const merge = createMerge({
  base,
  ours: { ...base, description: "First change", processType: "Flow" },
  theirs: {
    ...base,
    description: "Second change",
    processType: "InvocableProcess"
  }
});

describe("custom flow text", () => {
  it("preserves edited text as metadata, including XML-sensitive characters", () => {
    const text = "First & second <review>\nApproved description";
    const result = resolveMerge(merge, { "prop|description": { text } });
    expect(result.metadata.description).toBe(text);
    expect(result.choices["prop|description"]).toBe("custom");
    expect(result.conflicts).not.toContain("prop|description");
    expect(result.conflicts).toContain("prop|processType");
    expect(fromXml(toXml(result.metadata).text).description).toBe(text);
    expect(merge.sides.ours.props.description).toBe("First change");
  });

  it("accepts deliberately cleared text but rejects malformed edits and nontext properties", () => {
    expect(
      resolveMerge(merge, { "prop|description": { text: "" } }).metadata
        .description
    ).toBe("");
    for (const bad of ["custom", "unknown", null, { text: 4 }, []]) {
      expect(
        resolveMerge(merge, { "prop|description": bad }).conflicts
      ).toContain("prop|description");
    }
    const result = resolveMerge(merge, {
      "prop|processType": { text: "Anything" }
    });
    expect(result.metadata.processType).toBe("Flow");
    expect(result.conflicts).toContain("prop|processType");
    expect(textPick(undefined, { text: "ignored" })).toBe(false);
  });
});
