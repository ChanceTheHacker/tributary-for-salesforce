import { createElement } from "lwc";
import FlowTextMerge from "c/flowTextMerge";
import * as lineDiff from "c/lineDiff";

const base = require("fixtures/flows/Case_Email_Routing/v4.json").Metadata;
const copy = () => JSON.parse(JSON.stringify(base));

function mount(props) {
  const element = createElement("c-flow-text-merge", { is: FlowTextMerge });
  const changes = [];
  element.addEventListener("resultchange", (event) =>
    changes.push(event.detail)
  );
  Object.assign(element, props);
  document.body.appendChild(element);
  return { element, changes };
}

// Typing is checked once it pauses.
function type(area) {
  area.dispatchEvent(new CustomEvent("input"));
  jest.runOnlyPendingTimers();
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  window.sessionStorage.clear();
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
});

describe("c-flow-text-merge", () => {
  it("keeps the first side until a change is taken", async () => {
    const after = copy();
    after.recordLookups[0].label = "Renamed";
    const { element, changes } = mount({ sides: { before: base, after } });
    await Promise.resolve();
    expect(changes[0].metadata.recordLookups[0].label).toBe("Get Routing");
    const group = element.shadowRoot.querySelector("lightning-radio-group");
    group.dispatchEvent(new CustomEvent("change", { detail: { value: "b" } }));
    expect(changes.at(-1).metadata.recordLookups[0].label).toBe("Renamed");
    expect(changes.at(-1).error).toBeUndefined();
  });

  it("reports three-way conflicts until they're picked", async () => {
    const ours = copy();
    ours.recordLookups[0].label = "Ours";
    const theirs = copy();
    theirs.recordLookups[0].label = "Theirs";
    theirs.description = "Only theirs";
    const { element, changes } = mount({ sides: { base, ours, theirs } });
    await Promise.resolve();
    expect(changes[0].unresolved).toBe(1);
    expect(changes[0].metadata.description).toBe("Only theirs");
    const group = element.shadowRoot.querySelector("lightning-radio-group");
    group.dispatchEvent(
      new CustomEvent("change", { detail: { value: "theirs" } })
    );
    expect(changes.at(-1).unresolved).toBe(0);
    expect(changes.at(-1).metadata.recordLookups[0].label).toBe("Theirs");
  });

  it("doesn't stop for elements that were only moved", async () => {
    const discounts = (v) =>
      require(`fixtures/flows/UAT_Discounts_A/v${v}.json`).Metadata;
    const { element, changes } = mount({
      sides: { base: discounts(1), ours: discounts(2), theirs: discounts(3) }
    });
    await Promise.resolve();
    const conflicts = [
      ...element.shadowRoot.querySelectorAll("lightning-radio-group.pick")
    ];
    // Round Discount (deleted by ours, only moved by theirs) and every
    // locationY both sides changed settle by themselves.
    expect(changes[0].unresolved).toBe(conflicts.length);
    // 20 when every canvas move counted.
    expect(conflicts.length).toBe(5);
    for (const group of conflicts) {
      const text = group.closest(".change").textContent;
      expect(text).not.toMatch(/^[^<]*<locationY>[^<]*<\/locationY>[^<]*$/);
    }
    expect(element.shadowRoot.textContent).toContain(
      "differ only in where elements sit on the canvas"
    );
    expect(changes[0].metadata.assignments.map((a) => a.name)).not.toContain(
      "Round_Discount"
    );
  });

  it("offers Both only where two copies can make sense", async () => {
    const ours = copy();
    ours.recordLookups[0].label = "Ours";
    const theirs = copy();
    theirs.recordLookups[0].label = "Theirs";
    const { element } = mount({ sides: { base, ours, theirs } });
    await Promise.resolve();
    const group = element.shadowRoot.querySelector("lightning-radio-group");
    expect(group.options.map((option) => option.value)).toEqual([
      "ours",
      "theirs"
    ]);
  });

  it("says where each conflict is, without the shared indentation", async () => {
    const variable = (name) => ({
      name,
      dataType: "String",
      isCollection: false,
      isInput: false,
      isOutput: false
    });
    const start = { ...copy(), description: "Base" };
    const ours = { ...copy(), description: "Ours" };
    ours.variables.push(variable("oursNote"));
    const theirs = { ...copy(), description: "Theirs" };
    theirs.variables.push(variable("theirsNote"));
    const { element } = mount({ sides: { base: start, ours, theirs } });
    await Promise.resolve();
    const cards = [...element.shadowRoot.querySelectorAll(".change")];
    const card = (text) =>
      cards.find((item) => item.querySelector(".element").textContent === text);

    const property = card("description");
    expect(property.querySelector(".text").textContent).toBe(
      "<description>Ours</description>"
    );
    expect(property.querySelector(".hint")).toBeNull();

    const added = card("variables › oursNote and variables › theirsNote");
    expect(added.querySelector(".hint").textContent).toMatch(/Both keeps/);
    expect(added.querySelector(".text").textContent).toBe("<variables>");
    expect(Number(added.querySelector(".no").textContent)).toBeGreaterThan(1);
  });

  it("keeps the picks when the same flows are passed again", async () => {
    const after = copy();
    after.recordLookups[0].label = "Renamed";
    const sides = { before: base, after };
    const { element } = mount({ sides });
    await Promise.resolve();
    const group = () =>
      element.shadowRoot.querySelector("lightning-radio-group");
    group().dispatchEvent(
      new CustomEvent("change", { detail: { value: "b" } })
    );
    element.sides = { ...sides };
    await Promise.resolve();
    expect(group().value).toBe("b");
    element.sides = { before: base, after: copy() };
    await Promise.resolve();
    expect(
      element.shadowRoot.querySelector("lightning-radio-group")
    ).toBeNull();
  });

  it("reports well-formed XML that Salesforce would reject", async () => {
    const after = copy();
    after.recordLookups[0].connector = { targetReference: "Nowhere" };
    const { element, changes } = mount({ sides: { before: base, after } });
    await Promise.resolve();
    expect(changes[0].problems).toEqual([]);
    const group = element.shadowRoot.querySelector("lightning-radio-group");
    group.dispatchEvent(new CustomEvent("change", { detail: { value: "b" } }));
    await Promise.resolve();
    expect(changes.at(-1).metadata).toBeDefined();
    expect(changes.at(-1).problems).toEqual([
      expect.stringContaining("Nowhere")
    ]);
    const status = element.shadowRoot.querySelector("[role=status]");
    expect(status.className).toContain("status-error");
    expect(status.textContent).toContain("Salesforce would reject it");
  });

  it("brings unpicked conflicts into the editor between markers", async () => {
    const ours = copy();
    ours.recordLookups[0].label = "Ours";
    const theirs = copy();
    theirs.recordLookups[0].label = "Theirs";
    const { element, changes } = mount({
      sides: { base, ours, theirs },
      labels: { ours: "Mine", theirs: "Yours" }
    });
    await Promise.resolve();
    element.shadowRoot.querySelector(".edit").click();
    await Promise.resolve();
    const area = element.shadowRoot.querySelector("textarea");
    expect(area.value).toContain("<<<<<<< Mine");
    expect(area.value).toContain(">>>>>>> Yours");
    // Editing doesn't wave the conflict through.
    expect(changes.at(-1).unresolved).toBe(1);
    const status = element.shadowRoot.querySelector("[role=status]");
    expect(status.textContent).toMatch(/^Resolve 1 conflict/);

    // Keeping theirs and deleting the markers resolves it.
    area.value = area.value.replace(
      /<<<<<<< Mine\n[\s\S]*?=======\n([\s\S]*?)>>>>>>> Yours\n/,
      "$1"
    );
    type(area);
    expect(changes.at(-1).unresolved).toBe(0);
    expect(changes.at(-1).metadata.recordLookups[0].label).toBe("Theirs");
    await Promise.resolve();
    const edit = element.shadowRoot.querySelector(".edit");
    expect(edit.label).toBe("Discard hand edits");

    // Discarding goes back to the picks, where it's still open.
    edit.click();
    await Promise.resolve();
    expect(changes.at(-1).unresolved).toBe(1);
    expect(element.shadowRoot.querySelector("textarea")).toBeNull();
  });

  it("counts the lines edited by hand", async () => {
    const { element, changes } = mount({
      sides: { before: base, after: copy() }
    });
    await Promise.resolve();
    expect(changes.at(-1).handEdits).toBeNull();
    element.shadowRoot.querySelector(".edit").click();
    await Promise.resolve();
    const area = element.shadowRoot.querySelector("textarea");
    const lines = area.value.split("\n");
    lines.splice(2, 1, "<!-- replaced -->", "<!-- added -->");
    area.value = lines.join("\n");
    type(area);
    expect(changes.at(-1).handEdits).toEqual({ added: 2, removed: 1 });
  });

  it("reports XML that doesn't parse after a hand edit", async () => {
    const { element, changes } = mount({
      sides: { before: base, after: copy() }
    });
    await Promise.resolve();
    element.shadowRoot.querySelector(".edit").click();
    await Promise.resolve();
    const area = element.shadowRoot.querySelector("textarea");
    area.value = "<Flow><label>broken</Flow>";
    type(area);
    expect(changes.at(-1).metadata).toBeUndefined();
    expect(changes.at(-1).error).toMatch(/^Line 1: /);
    expect(changes.at(-1).error).not.toMatch(/Line 1: Line 1:/);
  });
  it("numbers the editor's lines and goes to the next conflict", async () => {
    const ours = copy();
    ours.recordLookups[0].label = "Ours";
    ours.description = "Ours too";
    const theirs = copy();
    theirs.recordLookups[0].label = "Theirs";
    theirs.description = "Theirs too";
    const { element } = mount({
      sides: { base, ours, theirs },
      labels: { ours: "Mine", theirs: "Yours" }
    });
    await Promise.resolve();
    element.shadowRoot.querySelector(".edit").click();
    await Promise.resolve();
    const area = element.shadowRoot.querySelector("textarea");
    const lines = area.value.split("\n");
    const gutter = element.shadowRoot.querySelector(".gutter").textContent;
    expect(gutter.split("\n")).toHaveLength(lines.length);
    expect(gutter.startsWith("1\n2\n3")).toBe(true);

    const jump = element.shadowRoot.querySelector(".jump");
    expect(jump.label).toBe("Go to the next conflict");
    const markers = lines
      .map((text, index) => (text.startsWith("<<<<<<<") ? index : -1))
      .filter((index) => index >= 0);
    expect(markers.length).toBe(2);
    area.setSelectionRange(0, 0);
    jump.click();
    const lineAt = () =>
      area.value.slice(0, area.selectionStart).split("\n").length - 1;
    expect(lineAt()).toBe(markers[0]);
    jump.click();
    expect(lineAt()).toBe(markers[1]);
    // Past the last one, it starts again at the top.
    jump.click();
    expect(lineAt()).toBe(markers[0]);
  });

  it("offers the line XML stops reading at", async () => {
    const { element } = mount({ sides: { before: base, after: copy() } });
    await Promise.resolve();
    element.shadowRoot.querySelector(".edit").click();
    await Promise.resolve();
    const area = element.shadowRoot.querySelector("textarea");
    area.value = "<Flow>\n<label>broken</Flow>\n";
    type(area);
    await Promise.resolve();
    const jump = element.shadowRoot.querySelector(".jump");
    expect(jump.label).toMatch(/^Go to line \d+$/);
  });

  it("keeps picks and hand edits through a reload", async () => {
    const after = copy();
    after.recordLookups[0].label = "Renamed";
    const sides = { before: base, after };
    let { element } = mount({ sides, draftKey: "k1" });
    await Promise.resolve();
    element.shadowRoot
      .querySelector("lightning-radio-group")
      .dispatchEvent(new CustomEvent("change", { detail: { value: "b" } }));
    element.shadowRoot.querySelector(".edit").click();
    await Promise.resolve();
    const area = element.shadowRoot.querySelector("textarea");
    area.value = area.value.replace("Renamed", "Renamed by hand");
    // Leaving before the typing pauses still keeps it.
    area.dispatchEvent(new CustomEvent("input"));
    document.body.removeChild(element);

    let changes;
    ({ element, changes } = mount({ sides, draftKey: "k1" }));
    await Promise.resolve();
    expect(element.shadowRoot.querySelector("textarea").value).toContain(
      "Renamed by hand"
    );
    expect(element.shadowRoot.querySelector(".restored").textContent).toBe(
      "Your hand edits from before the page reloaded are back."
    );
    expect(changes.at(-1).metadata.recordLookups[0].label).toBe(
      "Renamed by hand"
    );
    // Discarding the edits keeps the pick made before them.
    element.shadowRoot.querySelector(".edit").click();
    await Promise.resolve();
    expect(changes.at(-1).metadata.recordLookups[0].label).toBe("Renamed");
    expect(element.shadowRoot.querySelector(".restored")).toBeNull();
    document.body.removeChild(element);

    // Another merge doesn't pick up this one's draft.
    ({ element, changes } = mount({ sides, draftKey: "k2" }));
    await Promise.resolve();
    expect(changes.at(-1).metadata.recordLookups[0].label).toBe("Get Routing");
  });
  it("checks hand edits once typing pauses, and can't be saved before", async () => {
    const { element, changes } = mount({
      sides: { before: base, after: copy() }
    });
    await Promise.resolve();
    element.shadowRoot.querySelector(".edit").click();
    await Promise.resolve();
    const area = element.shadowRoot.querySelector("textarea");
    const before = changes.length;
    area.value = "<Flow><label>broken</Flow>";
    area.dispatchEvent(new CustomEvent("input"));
    area.value = "<Flow><label>still broken</Flow>";
    area.dispatchEvent(new CustomEvent("input"));
    // One word that a check is coming, and no check yet.
    expect(changes.slice(before)).toEqual([{ pending: true }]);
    jest.runOnlyPendingTimers();
    expect(changes.length).toBe(before + 2);
    expect(changes.at(-1).error).toMatch(/^Line 1: /);
    expect(changes.at(-1).text).toContain("still broken");
  });

  it("doesn't carry hand edits into another merge", async () => {
    const after = copy();
    after.recordLookups[0].label = "Renamed";
    const { element } = mount({
      sides: { before: base, after },
      draftKey: "k1"
    });
    await Promise.resolve();
    element.shadowRoot.querySelector(".edit").click();
    await Promise.resolve();
    const area = element.shadowRoot.querySelector("textarea");
    area.value = area.value.replace("Get Routing", "Edited by hand");
    type(area);

    // New versions arrive before their key, as the parent sets them.
    const other = copy();
    other.recordLookups[0].label = "Other";
    element.sides = { before: base, after: other };
    element.draftKey = "k2";
    await Promise.resolve();
    expect(element.shadowRoot.querySelector("textarea")).toBeNull();
    expect(element.shadowRoot.querySelector(".restored")).toBeNull();
  });

  it("sets aside XML edits made against other XML, and brings them back", async () => {
    const after = copy();
    after.recordLookups[0].label = "Renamed";
    // The same versions under another mapping compare different XML.
    const remapped = copy();
    remapped.recordLookups[0].label = "Mapped differently";
    const first = { before: base, after };
    const { element, changes } = mount({ sides: first, draftKey: "k1" });
    await Promise.resolve();
    element.shadowRoot.querySelector(".edit").click();
    await Promise.resolve();
    let area = element.shadowRoot.querySelector("textarea");
    area.value = area.value.replace("Get Routing", "Edited by hand");
    // Changing the mapping right after typing still keeps what was typed.
    area.dispatchEvent(new CustomEvent("input"));

    element.sides = { before: base, after: remapped };
    await Promise.resolve();
    const root = element.shadowRoot;
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.querySelector(".restored")).toBeNull();
    expect(root.querySelector(".aside p").textContent).toMatch(
      /made against different XML \(another mapping/
    );
    expect(root.querySelector(".aside pre").textContent).toContain(
      "Edited by hand"
    );
    expect(changes.at(-1).metadata.recordLookups[0].label).toBe("Get Routing");

    // A pick against this XML keeps the earlier edits aside, not over them.
    root
      .querySelector("lightning-radio-group")
      .dispatchEvent(new CustomEvent("change", { detail: { value: "b" } }));
    const kept = JSON.parse(
      window.sessionStorage.getItem("flowCompare.textDraft")
    );
    expect(kept.value.picks).toEqual({ 0: "b" });
    expect(kept.value.aside).toHaveLength(1);
    expect(kept.value.aside[0].text).toContain("Edited by hand");

    // Back on the first mapping, its edits are back and the pick waits.
    element.sides = { ...first };
    await Promise.resolve();
    area = root.querySelector("textarea");
    expect(area.value).toContain("Edited by hand");
    expect(root.querySelector(".restored").textContent).toBe(
      "Your hand edits for this mapping are back."
    );
    expect(root.querySelector(".aside p").textContent).toMatch(
      /^Your earlier XML picks were/
    );
    expect(changes.at(-1).metadata.recordLookups[0].label).toBe(
      "Edited by hand"
    );
  });

  it("lets XML set aside go, oldest first, when storage is full", async () => {
    const after = copy();
    after.recordLookups[0].label = "Renamed";
    // Newest first, each made against other XML.
    const aside = [1, 2, 3].map((n) => ({
      format: 1,
      source: `other-${n}`,
      text: `edit ${n} `.repeat(2000)
    }));
    window.sessionStorage.setItem(
      "flowCompare.textDraft",
      JSON.stringify({ key: "k1", value: { aside } })
    );
    const real = Storage.prototype.setItem;
    const setItem = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (key, value) {
        if (value.length > 32000) {
          throw new DOMException("Full", "QuotaExceededError");
        }
        return real.call(this, key, value);
      });
    try {
      const { element } = mount({
        sides: { before: base, after },
        draftKey: "k1"
      });
      await Promise.resolve();
      element.shadowRoot
        .querySelector("lightning-radio-group")
        .dispatchEvent(new CustomEvent("change", { detail: { value: "b" } }));
      const kept = JSON.parse(
        window.sessionStorage.getItem("flowCompare.textDraft")
      );
      // This merge's pick is kept; the oldest work set aside made room.
      expect(kept.value.picks).toEqual({ 0: "b" });
      expect(kept.value.aside.map((draft) => draft.source)).toEqual([
        "other-1",
        "other-2"
      ]);
    } finally {
      setItem.mockRestore();
    }
  });

  it("sets aside a draft from an earlier version, until discarded", async () => {
    const after = copy();
    after.recordLookups[0].label = "Renamed";
    const sides = { before: base, after };
    // Kept before drafts named their XML.
    window.sessionStorage.setItem(
      "flowCompare.textDraft",
      JSON.stringify({ key: "k1", value: { picks: { 0: "b" } } })
    );
    const { element, changes } = mount({ sides, draftKey: "k1" });
    await Promise.resolve();
    const root = element.shadowRoot;
    expect(changes.at(-1).metadata.recordLookups[0].label).toBe("Get Routing");
    expect(root.querySelector(".aside p").textContent).toMatch(
      /made with an earlier version of Tributary/
    );
    expect(root.querySelector(".aside pre")).toBeNull();
    root.querySelector(".discard-aside").click();
    await Promise.resolve();
    expect(root.querySelector(".aside")).toBeNull();
    expect(window.sessionStorage.getItem("flowCompare.textDraft")).toBeNull();
  });

  it("starts a long change folded, and picks it all the same", async () => {
    const after = copy();
    after.recordLookups[0].label = "Renamed";
    after.variables = [
      ...(after.variables || []),
      ...Array.from({ length: 12 }, (_, index) => ({
        name: `extra${index}`,
        dataType: "String",
        isCollection: false,
        isInput: false,
        isOutput: false
      }))
    ];
    const { element, changes } = mount({ sides: { before: base, after } });
    await Promise.resolve();
    const root = element.shadowRoot;
    const sections = [...root.querySelectorAll("section.change")];
    const long = sections.find((section) => section.querySelector(".fold"));
    const short = sections.find((section) => !section.querySelector(".fold"));
    expect(short.querySelectorAll(".line").length).toBeGreaterThan(0);
    const fold = long.querySelector(".fold");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent.trim()).toMatch(/^Show all \d+ lines$/);
    expect(long.querySelectorAll(".line")).toHaveLength(0);
    // Counted and picked while folded.
    expect(root.querySelector(".count").textContent).toBe(
      `${sections.length} changes`
    );
    long
      .querySelector("lightning-radio-group")
      .dispatchEvent(new CustomEvent("change", { detail: { value: "b" } }));
    expect(changes.at(-1).metadata.variables).toHaveLength(
      after.variables.length
    );

    fold.click();
    await Promise.resolve();
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(fold.textContent.trim()).toBe("Fold these lines");
    expect(long.querySelectorAll(".line").length).toBeGreaterThan(40);
    expect(long.textContent).toContain("extra11");
  });

  it("lists hundreds of small changes a page at a time", async () => {
    const variables = (description) =>
      Array.from({ length: 120 }, (_, index) => ({
        name: `note${String(index).padStart(3, "0")}`,
        dataType: "String",
        description,
        isCollection: false,
        isInput: false,
        isOutput: false
      }));
    const before = { ...copy(), variables: variables("Old") };
    const after = { ...copy(), variables: variables("New") };
    const { element, changes } = mount({ sides: { before, after } });
    await Promise.resolve();
    const root = element.shadowRoot;
    const listed = () => root.querySelectorAll("section.change").length;
    const more = () => root.querySelector(".more-changes");
    expect(root.querySelector(".count").textContent).toBe("120 changes");
    expect(listed()).toBe(50);
    expect(root.querySelectorAll("lightning-radio-group").length).toBe(50);
    expect(more().label).toBe("Show the next 50 changes (70 not shown)");
    more().click();
    await Promise.resolve();
    expect(listed()).toBe(100);
    expect(more().label).toBe("Show the next 20 changes (20 not shown)");
    more().click();
    await Promise.resolve();
    expect(listed()).toBe(120);
    expect(more()).toBeNull();
    // Taking a side for all takes it for every change, listed or not.
    root.querySelector('lightning-button[data-side="b"]').click();
    const taken = changes.at(-1).metadata.variables;
    expect(taken.length).toBe(120);
    expect(taken.every((variable) => variable.description === "New")).toBe(
      true
    );
  });

  it("diffs a three-way merge's sides once, however many picks", async () => {
    const plan = jest.spyOn(lineDiff, "planThreeWay");
    const discounts = (v) =>
      require(`fixtures/flows/UAT_Discounts_A/v${v}.json`).Metadata;
    const { element, changes } = mount({
      sides: { base: discounts(1), ours: discounts(2), theirs: discounts(3) }
    });
    await Promise.resolve();
    const groups = [
      ...element.shadowRoot.querySelectorAll("lightning-radio-group.pick")
    ];
    expect(groups.length).toBe(5);
    for (const group of groups) {
      group.dispatchEvent(
        new CustomEvent("change", { detail: { value: "theirs" } })
      );
    }
    await Promise.resolve();
    expect(changes.at(-1).unresolved).toBe(0);
    expect(plan).toHaveBeenCalledTimes(1);
    plan.mockRestore();
  });
});
