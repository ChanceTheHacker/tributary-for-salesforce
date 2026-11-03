import { visibleText } from "c/flowUtils";

describe("review text", () => {
  it("reveals invisible direction and zero-width controls without modifying the source", () => {
    const source = "Add‮Promo‬​";
    expect(visibleText(source)).toBe("Add⟦U+202E⟧Promo⟦U+202C⟧⟦U+200B⟧");
    expect(source).toBe("Add‮Promo‬​");
    expect(visibleText(visibleText(source))).toBe(visibleText(source));
  });

  it("preserves ordinary international text and absent values", () => {
    expect(visibleText("مرحبا שלום 日本語")).toBe("مرحبا שלום 日本語");
    expect(visibleText(undefined)).toBeUndefined();
    expect(visibleText(4)).toBe(4);
  });
});
