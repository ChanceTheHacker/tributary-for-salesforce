import { createElement } from "lwc";
import FlowTextDiff from "c/flowTextDiff";

const source = require("fixtures/flows/Case_Email_Routing/v4.json").Metadata;
const edited = JSON.parse(JSON.stringify(source));
edited.recordLookups[0].label = "Get Routing Rules";

function mount(props) {
  const element = createElement("c-flow-text-diff", { is: FlowTextDiff });
  Object.assign(element, props);
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
});

describe("c-flow-text-diff", () => {
  it("shows changed lines with context and the element they belong to", async () => {
    const element = mount({ before: source, after: edited });
    await Promise.resolve();
    const root = element.shadowRoot;
    expect(root.querySelectorAll(".row-delete")).toHaveLength(1);
    expect(root.querySelectorAll(".row-insert")).toHaveLength(1);
    expect(root.querySelector(".row-insert .line").textContent).toContain(
      "Get Routing Rules"
    );
    expect(root.querySelector(".hunk-header").textContent).toContain(
      "recordLookups › Get_Routing"
    );
    expect(root.querySelector(".stat-added").textContent).toBe("+1");
  });

  it.each(["unified", "split"])(
    "emphasizes changed text within a %s XML line",
    async (layout) => {
      const before = { label: "Apply 10% discount 😀" };
      const after = { label: "Apply 20% discount 😃" };
      const element = mount({ before, after, layout });
      await Promise.resolve();
      const marks = [...element.shadowRoot.querySelectorAll(".inline-change")];
      expect(marks.map((mark) => mark.textContent)).toEqual([
        "10% discount 😀",
        "20% discount 😃"
      ]);
      expect(element.shadowRoot.querySelectorAll("label")).toHaveLength(0);
      expect(element.shadowRoot.textContent).toContain("<label>Apply");
      expect(before.label).toBe("Apply 10% discount 😀");
    }
  );

  it("does not present different XML properties as an inline edit", async () => {
    const element = mount({
      before: { label: "Old" },
      after: { description: "New" }
    });
    await Promise.resolve();
    expect(element.shadowRoot.querySelector(".inline-change")).toBeNull();
  });

  it("shows direction controls in XML without changing the source", async () => {
    const after = { label: "Safe‮hidden‬" };
    const element = mount({ before: { label: "Old" }, after });
    await Promise.resolve();
    expect(
      element.shadowRoot.querySelector(".row-insert .line").textContent
    ).toContain("Safe⟦U+202E⟧hidden⟦U+202C⟧");
    expect(after.label).toBe("Safe‮hidden‬");
  });

  it("selects the element of a clicked line", async () => {
    const element = mount({ before: source, after: edited });
    const handler = jest.fn();
    element.addEventListener("select", handler);
    await Promise.resolve();
    element.shadowRoot.querySelector(".row-insert").click();
    expect(handler.mock.calls[0][0].detail.id).toBe(
      "recordLookups:Get_Routing"
    );
  });

  it("lays changes side by side", async () => {
    const element = mount({ before: source, after: edited, layout: "split" });
    await Promise.resolve();
    const pair = element.shadowRoot.querySelector(".cell-delete").parentNode;
    expect(pair.querySelector(".cell-insert")).not.toBeNull();
  });

  it("never lines up one element's lines with another's", async () => {
    // One variable removed and a different one added in its place.
    const after = JSON.parse(JSON.stringify(source));
    const removed = after.variables.shift();
    after.variables.unshift({ ...removed, name: "zzNewNote" });
    const element = mount({ before: source, after, layout: "split" });
    await Promise.resolve();
    const pairs = [...element.shadowRoot.querySelectorAll(".pair")];
    const changed = pairs.filter((pair) =>
      pair.querySelector(".cell-delete, .cell-insert")
    );
    expect(changed.length).toBeGreaterThan(0);
    for (const pair of changed) {
      const [left, right] = pair.children;
      // A changed row has only one side.
      expect(
        left.classList.contains("cell-empty") ||
          right.classList.contains("cell-empty")
      ).toBe(true);
    }
    const header = element.shadowRoot.querySelector(".hunk-header .inspect");
    expect(header.textContent).toContain(`variables › ${removed.name}`);
  });

  it("shows a focused element even when it didn't change", async () => {
    const element = mount({
      before: source,
      after: edited,
      focusId: "variables:matchFound"
    });
    await Promise.resolve();
    const focused = element.shadowRoot.querySelectorAll(".focused");
    expect(focused.length).toBeGreaterThan(2);
    expect(focused[0].dataset.first).toBe("variables:matchFound");
  });

  it("opens only the unchanged lines that were chosen", async () => {
    // Two changes far apart leave three folded stretches.
    const twice = JSON.parse(JSON.stringify(edited));
    twice.label = "Case Email Routing (edited)";
    const element = mount({ before: source, after: twice });
    await Promise.resolve();
    const root = element.shadowRoot;
    const gaps = root.querySelectorAll(".skipped");
    expect(gaps.length).toBeGreaterThan(1);
    const collapsed = root.querySelectorAll(".row").length;
    const hidden = Number(gaps[0].textContent.match(/\d+/)[0]);

    gaps[0].click();
    await Promise.resolve();
    expect(root.querySelectorAll(".row")).toHaveLength(collapsed + hidden);
    expect(root.querySelectorAll(".row.fresh")).toHaveLength(hidden);
    expect(root.querySelectorAll(".skipped")).toHaveLength(gaps.length - 1);
    // The button went with its lines, so the diff keeps focus.
    expect(root.activeElement).toBe(root.querySelector(".code"));
    expect(root.querySelector("lightning-button.collapse")).not.toBeNull();
  });

  it("shows every line, and folds them again", async () => {
    const element = mount({ before: source, after: edited });
    await Promise.resolve();
    const root = element.shadowRoot;
    const collapsed = root.querySelectorAll(".row").length;
    expect(root.querySelector("lightning-button.collapse")).toBeNull();

    root.querySelector("lightning-button.show-all").click();
    await Promise.resolve();
    expect(root.querySelectorAll(".row").length).toBeGreaterThan(collapsed);
    expect(root.querySelector(".skipped")).toBeNull();
    expect(root.querySelector("lightning-button.show-all")).toBeNull();

    root.querySelector("lightning-button.collapse").click();
    await Promise.resolve();
    expect(root.querySelectorAll(".row")).toHaveLength(collapsed);
  });

  it("shows every line of identical flows", async () => {
    const element = mount({ before: source, after: source });
    await Promise.resolve();
    const root = element.shadowRoot;
    expect(root.querySelector(".identical")).not.toBeNull();
    expect(root.querySelectorAll(".row")).toHaveLength(0);

    root.querySelector("lightning-button.show-all").click();
    await Promise.resolve();
    const rows = root.querySelectorAll(".row");
    expect(rows.length).toBeGreaterThan(20);
    expect(root.querySelector(".skipped")).toBeNull();
    expect(rows[0].querySelector(".line").textContent).toContain("<?xml");
  });

  it("keeps added and removed colours on the selected element", async () => {
    const element = mount({
      before: source,
      after: edited,
      layout: "split",
      focusId: "recordLookups:Get_Routing"
    });
    await Promise.resolve();
    const root = element.shadowRoot;
    expect(root.querySelector(".cell-insert").classList).toContain("focused");
    expect(root.querySelector(".cell-delete").classList).toContain("focused");
  });

  it("says which lines were added and removed without relying on colour", async () => {
    const element = mount({ before: source, after: edited, layout: "split" });
    await Promise.resolve();
    const root = element.shadowRoot;
    expect(
      root.querySelector(".cell-insert .slds-assistive-text").textContent
    ).toContain("Added line");
    expect(
      root.querySelector(".cell-delete .slds-assistive-text").textContent
    ).toContain("Removed line");
  });

  it("selects a hunk's element from its header, by keyboard too", async () => {
    const element = mount({ before: source, after: edited });
    const handler = jest.fn();
    element.addEventListener("select", handler);
    await Promise.resolve();
    const inspect = element.shadowRoot.querySelector(".hunk-header .inspect");
    expect(inspect.tagName).toBe("BUTTON");
    inspect.click();
    expect(handler.mock.calls[0][0].detail.id).toBe(
      "recordLookups:Get_Routing"
    );
  });

  it("scrolls its own lines to an element, not the page", async () => {
    const element = mount({ before: source, after: edited });
    await Promise.resolve();
    const code = element.shadowRoot.querySelector(".code");
    Object.defineProperty(code, "scrollHeight", { value: 2000 });
    Object.defineProperty(code, "clientHeight", { value: 400 });
    code.scrollTo = jest.fn();
    const intoView = jest.fn();
    HTMLElement.prototype.scrollIntoView = intoView;

    element.reveal("recordLookups:Get_Routing");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(code.scrollTo).toHaveBeenCalled();
    expect(intoView).not.toHaveBeenCalled();
    delete HTMLElement.prototype.scrollIntoView;
  });

  it("says when nothing differs", async () => {
    const element = mount({ before: source, after: source });
    await Promise.resolve();
    expect(element.shadowRoot.querySelector(".identical")).not.toBeNull();
  });
});
