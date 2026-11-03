import { createElement } from "lwc";
import FlowReceiptCard from "c/flowReceiptCard";
import { buildReceipt, sha256 } from "c/flowReceipt";

const receipt = (saved) =>
  buildReceipt({
    candidate: sha256("{}"),
    sources: [
      {
        role: "before",
        label: "Version 3",
        connectionLabel: "This org",
        apiName: "Discounts",
        versionNumber: 3,
        versionId: "301000000000003AAA",
        lastModifiedDate: "2026-09-02T11:30:00.000Z"
      }
    ],
    decisions: ["Merged Version 3 and Version 4: 2 differences."],
    checks: { errors: 0, warnings: 1, messages: ["Loop_1 has no path out."] },
    saved
  });

function mount(props) {
  const element = createElement("c-flow-receipt-card", { is: FlowReceiptCard });
  Object.assign(element, props);
  document.body.appendChild(element);
  return element;
}

const texts = (element, selector) =>
  [...element.shadowRoot.querySelectorAll(selector)].map((node) =>
    node.textContent.replace(/\s+/g, " ").trim()
  );

describe("c-flow-receipt-card", () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  it("shows the fingerprint, sources, decisions and each check", () => {
    const element = mount({ receipt: receipt() });
    const code = element.shadowRoot.querySelector("code");
    expect(element.shadowRoot.querySelector("details.technical").open).toBe(
      false
    );
    expect(texts(element, ".heading")[0]).toBe("Decided");
    expect(code.textContent).toBe(sha256("{}").slice(0, 12));
    expect(code.title).toBe(sha256("{}"));
    expect(texts(element, ".fingerprint .aside")[0]).toContain(
      "saves only if it matches"
    );
    expect(texts(element, ".source-label")).toEqual(["Version 3:"]);
    expect(texts(element, ".sources .aside")).toEqual([
      "This org: Discounts v3, last changed 2026-09-02 11:30 UTC, id 301000000000003AAA"
    ]);
    expect(texts(element, ".decisions li")).toEqual([
      "Merged Version 3 and Version 4: 2 differences."
    ]);
    const icons = [
      ...element.shadowRoot.querySelectorAll(".check lightning-icon")
    ].map((icon) => [icon.iconName, icon.alternativeText]);
    expect(icons).toEqual([
      ["utility:warning", "Warnings"],
      ["utility:dash", "Not run"],
      ["utility:clock", "Not yet"]
    ]);
    expect(texts(element, ".messages li")).toEqual(["Loop_1 has no path out."]);
  });

  it("says the org checked it once saved", () => {
    const element = mount({
      receipt: receipt({ versionNumber: 5 }),
      saved: true
    });
    expect(texts(element, ".fingerprint .aside")[0]).toContain(
      "Checked by the org before saving."
    );
    const last = texts(element, ".check").pop();
    expect(last).toContain("Accepted as inactive version 5.");
    expect(
      element.shadowRoot.querySelectorAll(".check lightning-icon")[2].iconName
    ).toBe("utility:success");
  });

  it("leaves out empty sections", () => {
    const element = mount({
      receipt: buildReceipt({ candidate: sha256("") })
    });
    expect(element.shadowRoot.querySelector(".sources")).toBeNull();
    expect(element.shadowRoot.querySelector(".decisions")).toBeNull();
    expect(element.shadowRoot.querySelectorAll(".check")).toHaveLength(3);
  });
});
