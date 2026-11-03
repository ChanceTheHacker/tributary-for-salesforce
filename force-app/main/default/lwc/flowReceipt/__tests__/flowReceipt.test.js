import { createHash } from "crypto";
import {
  sha256,
  shortFingerprint,
  utcText,
  sourceText,
  receiptChecks,
  buildReceipt,
  receiptText,
  PASSED,
  WARNED,
  FAILED,
  NOT_RUN,
  PENDING
} from "c/flowReceipt";

const node = (text) => createHash("sha256").update(text, "utf8").digest("hex");

describe("sha256", () => {
  it.each([
    ["nothing", ""],
    ["a short string", "abc"],
    ["exactly one block less its padding", "x".repeat(55)],
    ["one byte over", "x".repeat(56)],
    ["a whole block", "x".repeat(64)],
    ["accents and symbols", "Café — naïve ≠ “quoted” €"],
    ["characters outside the basic plane", "flow 🌊 merge 𝔉"],
    [
      "flow metadata",
      JSON.stringify({ label: "Démo", decisions: [{ name: "D1" }] })
    ]
  ])("matches Node's for %s", (label, text) => {
    expect(sha256(text)).toBe(node(text));
  });

  it("matches Node's for a large flow", () => {
    const text = JSON.stringify(
      Array.from({ length: 4000 }, (_, index) => ({
        name: `Step_${index}`,
        label: `Étape ${index} 🌊`
      }))
    );
    expect(text.length).toBeGreaterThan(100000);
    expect(sha256(text)).toBe(node(text));
  });

  it("gives the known digest of the empty string", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("encodes a lone surrogate as a replacement character", () => {
    expect(sha256("a\ud800b")).toBe(node("a�b"));
  });

  it("shortens for reading out", () => {
    expect(shortFingerprint(sha256("abc"))).toBe("ba7816bf8f01");
    expect(shortFingerprint(undefined)).toBe("");
  });
});

describe("the receipt", () => {
  const sources = [
    {
      role: "base",
      label: "Version 2 (base)",
      connectionLabel: "This org",
      apiName: "Discounts",
      versionNumber: 2,
      versionId: "301000000000002AAA",
      lastModifiedDate: "2026-09-01T10:00:00.000Z",
      lastModifiedBy: "Ada"
    },
    {
      role: "ours",
      label: "Version 3",
      connectionLabel: "This org",
      apiName: "Discounts",
      versionNumber: 3,
      versionId: "301000000000003AAA",
      lastModifiedDate: "2026-09-02T11:30:00.000Z"
    }
  ];

  it("says where each source lives and when it last changed, in UTC", () => {
    expect(sourceText(sources[0])).toBe(
      "This org: Discounts v2, last changed 2026-09-01 10:00 UTC by Ada, id 301000000000002AAA"
    );
    expect(sourceText({ apiName: "Discounts" })).toBe("Discounts");
    expect(utcText("not a date")).toBe("");
  });

  it("keeps the metadata checks, Apex tests and the org's check apart", () => {
    const [model, apex, org] = receiptChecks({ errors: 0, warnings: 0 });
    expect(model.status).toBe(PASSED);
    expect(model.summary).toBe("No errors or warnings found.");
    // What it covers, and that it didn't run anything.
    expect(model.detail).toContain("The flow wasn't run.");
    expect(apex.status).toBe(NOT_RUN);
    expect(apex.summary).toBe("Not run by Tributary.");
    expect(org.status).toBe(PENDING);

    const warned = receiptChecks({
      errors: 0,
      warnings: 2,
      messages: ["Loop_1 has no path out."]
    });
    expect(warned[0].status).toBe(WARNED);
    expect(warned[0].summary).toBe("2 warnings found.");
    expect(warned[0].messages).toEqual(["Loop_1 has no path out."]);
    expect(receiptChecks({ errors: 1, warnings: 1 })[0].summary).toBe(
      "1 error and 1 warning found."
    );
    expect(receiptChecks({ errors: 1 })[0].status).toBe(FAILED);
    // Nothing checked isn't nothing found.
    expect(receiptChecks(undefined)[0]).toEqual(
      expect.objectContaining({ status: NOT_RUN, summary: "Not checked." })
    );
  });

  it("says the org accepting a version isn't proof it behaves", () => {
    const org = receiptChecks({}, { versionNumber: 7 })[2];
    expect(org.status).toBe(PASSED);
    expect(org.summary).toBe("Accepted as inactive version 7.");
    expect(org.detail).toContain("isn't proof the flow does what was intended");
  });

  it("writes the history text without the org's own lines", () => {
    const receipt = buildReceipt({
      candidate: sha256("{}"),
      sources,
      decisions: ["4 differences: 2 from Version 3, 2 from Version 4.", ""],
      checks: { errors: 0, warnings: 1, messages: ["Loop_1 has no path out."] }
    });
    expect(receipt.short).toHaveLength(12);
    expect(receipt.decisions).toHaveLength(1);
    expect(receiptText(receipt).split("\n")).toEqual([
      "From:",
      "- Version 2 (base): This org: Discounts v2, last changed 2026-09-01 10:00 UTC by Ada, id 301000000000002AAA",
      "- Version 3: This org: Discounts v3, last changed 2026-09-02 11:30 UTC, id 301000000000003AAA",
      "Decided:",
      "- 4 differences: 2 from Version 3, 2 from Version 4.",
      "Checked in Tributary: 1 warning found. Connectors, references and required parts, read from the metadata. The flow wasn't run.",
      "- Loop_1 has no path out.",
      "Apex tests: Not run by Tributary. Run the org's tests that cover this flow before it's activated, where the flow calls or is called by Apex."
    ]);
  });
});
