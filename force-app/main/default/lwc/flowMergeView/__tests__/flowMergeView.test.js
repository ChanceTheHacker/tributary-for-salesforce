import { createElement } from "lwc";
import FlowMergeView from "c/flowMergeView";
import { fromXml } from "c/flowXml";
import { changedUnits } from "c/flowMerge";

// The real merge, watched so a test can tell when its lists are rebuilt.
jest.mock("c/flowMerge", () => {
  const actual = jest.requireActual("c/flowMerge");
  return { ...actual, changedUnits: jest.fn(actual.changedUnits) };
});

jest.mock(
  "@salesforce/apex/FlowCompareController.saveVersion",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareController.saveAsNewFlow",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.getFlowStatus",
  () => ({ default: jest.fn(() => Promise.resolve({ pending: [] })) }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.requestActivation",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.activateVersion",
  () => ({ default: jest.fn() }),
  { virtual: true }
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const metadata = (version) => {
  const source = require(`fixtures/flows/Case_Email_Routing/v${version}.json`);
  return JSON.parse(JSON.stringify(source.Metadata || source));
};

// Version 4 with one element removed, one added and one relabelled.
function edited() {
  const result = metadata(4);
  result.recordUpdates = result.recordUpdates.filter(
    (element) => element.name !== "Unhandled_Case_Update"
  );
  result.decisions.find(
    (element) => element.name === "Should_Case_Be_Updated"
  ).defaultConnector.targetReference = "Log_Result";
  result.recordLookups[0].label = "Get Routing Rules";
  result.assignments.push({
    name: "Log_Result",
    label: "Log Result",
    locationX: 0,
    locationY: 0,
    assignmentItems: []
  });
  return result;
}

// Two different flows: Case Helper looks a case up by id and routes it;
// Case Triage is record-triggered on Case.
const flow = (name) =>
  JSON.parse(JSON.stringify(require(`fixtures/flows/${name}/v1.json`)));

// Version 4 with a path of two new elements after the lookup.
function grown() {
  const result = metadata(4);
  const lookup = result.recordLookups[0];
  const next = lookup.connector.targetReference;
  lookup.connector = { targetReference: "Note_One" };
  result.assignments = result.assignments || [];
  result.assignments.push(
    {
      name: "Note_One",
      label: "Note One",
      locationX: 0,
      locationY: 0,
      assignmentItems: [],
      connector: { targetReference: "Note_Two" }
    },
    {
      name: "Note_Two",
      label: "Note Two",
      locationX: 0,
      locationY: 0,
      assignmentItems: [],
      connector: { targetReference: next }
    }
  );
  return result;
}

function mount(props) {
  const element = createElement("c-flow-merge-view", { is: FlowMergeView });
  Object.assign(element, {
    connections: [{ name: "local", label: "This org", canSave: true }],
    targets: [
      {
        connection: "local",
        apiName: "Case_Email_Routing",
        label: "Case Email Routing"
      }
    ],
    canSave: true,
    ...props
  });
  document.body.appendChild(element);
  return element;
}

const $ = (element, selector) => element.shadowRoot.querySelector(selector);
const $$ = (element, selector) => [
  ...element.shadowRoot.querySelectorAll(selector)
];
const chips = (element) => $$(element, ".chip").map((chip) => chip.textContent);

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
  window.sessionStorage.clear();
});

describe("c-flow-merge-view", () => {
  it("keeps custom text through undo, reload and the save receipt", async () => {
    const props = () => ({
      draftKey: "custom-description",
      sides: {
        base: { ...metadata(4), description: "Original" },
        ours: { ...metadata(4), description: "First change" },
        theirs: { ...metadata(4), description: "Second change" }
      }
    });
    let element = mount(props());
    await flush();
    const open = () => $(element, '.row-title[data-kind="prop"]').click();
    open();
    await flush();
    const panel = $(element, "c-flow-resources-panel");
    expect(panel).not.toBeNull();
    panel.dispatchEvent(
      new CustomEvent("pick", {
        detail: { picks: { "prop|description": { text: "Reviewed together" } } }
      })
    );
    await flush();
    expect($(element, "c-flow-save-dialog").metadata.description).toBe(
      "Reviewed together"
    );
    const undo = $$(element, "lightning-button-icon").find((button) =>
      button.title?.startsWith("Undo")
    );
    undo.click();
    await flush();
    expect($(element, "c-flow-save-dialog").metadata.description).toBe(
      "First change"
    );
    const redo = $$(element, "lightning-button-icon").find((button) =>
      button.title?.startsWith("Redo")
    );
    redo.click();
    await flush();
    document.body.removeChild(element);
    element = mount(props());
    await flush();
    expect($(element, "c-flow-save-dialog").metadata.description).toBe(
      "Reviewed together"
    );
    $(element, "lightning-button.save").click();
    await flush();
    expect(
      $(element, "c-flow-save-dialog").review.decisions.join(" ")
    ).toContain("Text combined or edited by hand: Description");
  });

  it("draws a two-way merge and lists what can be picked", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Edited" },
      sides: { before: metadata(4), after: edited() }
    });
    await flush();
    const canvas = $(element, "c-flow-canvas");
    expect(canvas.scene.nodes.length).toBeGreaterThan(0);
    const rows = $$(element, ".row");
    expect(rows.length).toBeGreaterThan(0);
    // Starting from before, nothing from after is taken yet.
    const picks = $$(element, ".row-pick").map((group) => group.value);
    expect(new Set(picks)).toEqual(new Set(["before"]));
    expect(chips(element)).toContain("No errors");
  });

  it("names inclusion and exclusion choices without changing side picks", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Edited" },
      sides: { before: metadata(4), after: edited() }
    });
    await flush();
    const picker = $(element, '.row-pick[data-unit="node|Log_Result"]');
    expect(picker.options).toEqual([
      { value: "before", label: "Leave it out · Version 4" },
      { value: "after", label: "Keep it · Edited" }
    ]);
    picker.dispatchEvent(
      new CustomEvent("change", { detail: { value: "after" } })
    );
    await flush();
    expect(
      $(element, "c-flow-save-dialog").metadata.assignments.some(
        (item) => item.name === "Log_Result"
      )
    ).toBe(true);
    picker.dispatchEvent(
      new CustomEvent("change", { detail: { value: "before" } })
    );
    await flush();
    expect(
      $(element, "c-flow-save-dialog").metadata.assignments.some(
        (item) => item.name === "Log_Result"
      )
    ).toBe(false);
  });

  it("keeps its lists and scene while only the selection changes", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Edited" },
      sides: { before: metadata(4), after: edited() }
    });
    await flush();
    const canvas = $(element, "c-flow-canvas");
    const scene = canvas.scene;
    const [first, second] = scene.nodes;
    canvas.dispatchEvent(
      new CustomEvent("select", { detail: { id: first.id } })
    );
    await flush();
    changedUnits.mockClear();
    canvas.dispatchEvent(
      new CustomEvent("select", { detail: { id: second.id } })
    );
    await flush();
    expect($(element, "c-flow-element-panel").entry.id).toBe(second.id);
    expect(changedUnits).not.toHaveBeenCalled();
    expect(canvas.scene).toBe(scene);

    $(element, "lightning-button-menu").dispatchEvent(
      new CustomEvent("select", { detail: { value: "after" } })
    );
    await flush();
    expect(canvas.scene).not.toBe(scene);
  });

  it("brings picks back after the page reloads", async () => {
    const props = () => ({
      labels: { before: "Version 4", after: "Edited" },
      draftKey: "local:v4|local:edited",
      sides: { before: metadata(4), after: edited() }
    });
    let element = mount(props());
    await flush();
    $(element, "lightning-button-menu").dispatchEvent(
      new CustomEvent("select", { detail: { value: "after" } })
    );
    await flush();
    const taken = $$(element, ".row-pick").length;
    expect(taken).toBeGreaterThan(0);
    document.body.removeChild(element);

    element = mount(props());
    await flush();
    const picks = $$(element, ".row-pick").map((group) => group.value);
    expect(new Set(picks)).toEqual(new Set(["after"]));
    expect(chips(element).join(" ")).toMatch(/\d+ earlier picks restored/);

    // Undo sets them aside, and Redo brings them back.
    expect($(element, ".undo").disabled).toBe(false);
    $(element, ".undo").click();
    await flush();
    const cleared = $$(element, ".row-pick").map((group) => group.value);
    expect(new Set(cleared)).toEqual(new Set(["before"]));
    expect(chips(element).join(" ")).not.toMatch(/restored/);
    $(element, ".redo").click();
    await flush();
    expect($$(element, ".row-pick").map((group) => group.value)).toEqual(picks);

    // Another merge doesn't inherit them.
    document.body.removeChild(element);
    element = mount({ ...props(), draftKey: "local:v3|local:edited" });
    await flush();
    const fresh = $$(element, ".row-pick").map((group) => group.value);
    expect(new Set(fresh)).toEqual(new Set(["before"]));
    expect(chips(element).join(" ")).not.toMatch(/restored/);
  });

  it("forgets the picks once the merge is saved", async () => {
    const props = () => ({
      labels: { before: "Version 4", after: "Edited" },
      draftKey: "local:v4|local:edited",
      sides: { before: metadata(4), after: edited() }
    });
    let element = mount(props());
    await flush();
    $(element, "lightning-button-menu").dispatchEvent(
      new CustomEvent("select", { detail: { value: "after" } })
    );
    await flush();
    expect(window.sessionStorage.length).toBe(1);
    document.body.removeChild(element);

    element = mount(props());
    await flush();
    expect(chips(element).join(" ")).toMatch(/restored/);
    const saved = jest.fn();
    element.addEventListener("saved", saved);
    const dialog = $(element, "c-flow-save-dialog");
    dialog.dispatchEvent(
      new CustomEvent("saved", {
        detail: {
          apiName: "Case_Email_Routing",
          receipt: "Saved as v5.",
          saveKey: dialog.saveKey
        }
      })
    );
    await flush();
    // The receipt the org kept goes with any request to activate it.
    expect(saved.mock.calls[0][0].detail.summary).toBe("Saved as v5.");
    expect(window.sessionStorage.length).toBe(0);
    expect(chips(element).join(" ")).not.toMatch(/restored/);
  });

  it("keeps the other mode's draft when one mode is saved", async () => {
    const props = () => ({
      labels: { before: "Version 4", after: "Edited" },
      draftKey: "local:v4|local:edited",
      sides: { before: metadata(4), after: edited() }
    });
    const mode = (element, value) =>
      $(element, "lightning-radio-group").dispatchEvent(
        new CustomEvent("change", { detail: { value } })
      );
    const save = (element) => {
      const dialog = $(element, "c-flow-save-dialog");
      dialog.dispatchEvent(
        new CustomEvent("saved", {
          detail: { result: { versionNumber: 5 }, saveKey: dialog.saveKey }
        })
      );
    };
    const label = `<label>${metadata(4).label}</label>`;
    let element = mount(props());
    await flush();
    // Hand-edit the XML, then save the visual merge.
    mode(element, "text");
    await flush();
    let text = $(element, "c-flow-text-merge");
    text.shadowRoot.querySelector(".edit").click();
    await flush();
    const area = text.shadowRoot.querySelector("textarea");
    area.value = area.value.replace(label, "<label>Edited by hand</label>");
    area.dispatchEvent(new CustomEvent("input"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    mode(element, "canvas");
    await flush();
    $(element, "lightning-button-menu").dispatchEvent(
      new CustomEvent("select", { detail: { value: "after" } })
    );
    await flush();
    save(element);
    await flush();
    document.body.removeChild(element);

    // After a reload, the visual picks are gone and the XML edit isn't.
    element = mount(props());
    await flush();
    expect(chips(element).join(" ")).not.toMatch(/restored/);
    mode(element, "text");
    await flush();
    text = $(element, "c-flow-text-merge");
    expect(text.shadowRoot.querySelector("textarea").value).toContain(
      "<label>Edited by hand</label>"
    );

    // The other way: pick visually, then save the XML merge.
    mode(element, "canvas");
    await flush();
    $(element, "lightning-button-menu").dispatchEvent(
      new CustomEvent("select", { detail: { value: "after" } })
    );
    await flush();
    mode(element, "text");
    await flush();
    save(element);
    await flush();
    document.body.removeChild(element);

    element = mount(props());
    await flush();
    expect(chips(element).join(" ")).toMatch(/\d+ earlier picks restored/);
    mode(element, "text");
    await flush();
    text = $(element, "c-flow-text-merge");
    expect(text.shadowRoot.querySelector("textarea")).toBeNull();
  });

  it("takes everything from one side with a preset", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Edited" },
      sides: { before: metadata(4), after: edited() }
    });
    await flush();
    $(element, "lightning-button-menu").dispatchEvent(
      new CustomEvent("select", { detail: { value: "after" } })
    );
    await flush();
    const picks = $$(element, ".row-pick").map((group) => group.value);
    expect(new Set(picks)).toEqual(new Set(["after"]));
    const status = (key) =>
      $(element, "c-flow-canvas").scene.nodes.find((node) => node.key === key)
        .status;
    expect(status("Log_Result")).toBe("added");
    expect(status("Unhandled_Case_Update")).toBe("removed");
    expect(status("Get_Routing")).toBe("changed");
  });

  it("blocks saving until three-way conflicts are resolved", async () => {
    const base = metadata(4);
    const ours = metadata(4);
    ours.recordLookups[0].label = "Ours";
    const theirs = metadata(4);
    theirs.recordLookups[0].label = "Theirs";
    const lineage = [{ role: "base", label: "Version 4", versionId: "301" }];
    const element = mount({
      labels: { base: "Version 4", ours: "Mine", theirs: "Yours" },
      sides: { base, ours, theirs },
      lineage
    });
    await flush();
    const save = $(element, "lightning-button.save");
    expect(save.disabled).toBe(true);
    // The review is worked out only for the dialog.
    expect($(element, "c-flow-save-dialog").review).toBeUndefined();
    expect(chips(element).join(" ")).toMatch(/1 conflict to resolve/);
    const conflictNode = $(element, "c-flow-canvas").scene.nodes.find(
      (node) => node.conflict
    );
    expect(conflictNode.key).toBe(base.recordLookups[0].name);

    const row = $(element, ".row-conflict .row-pick");
    // An open conflict has no side picked, though the canvas previews one.
    expect(row.value).toBe("");
    expect($(element, ".save-note").textContent).toBe(
      "Resolve every conflict first."
    );
    $$(element, ".stepper lightning-button-icon")[1].click();
    await flush();
    expect($(element, ".position").textContent).toBe("1 of 1 open conflict");
    expect($(element, "c-flow-element-panel")).not.toBeNull();
    row.dispatchEvent(
      new CustomEvent("change", { detail: { value: "theirs" } })
    );
    await flush();
    expect(chips(element)).toContain("No unresolved conflicts");
    expect(save.disabled).toBe(false);

    save.click();
    await flush();
    const dialog = $(element, "c-flow-save-dialog");
    expect(dialog.open).toBe(true);
    expect(dialog.metadata.recordLookups[0].label).toBe("Theirs");
    expect(dialog.changeSummary).toBe(
      "Merged Mine and Yours from Version 4: 1 difference, 1 from Yours."
    );
    // The receipt's review: where it came from, the conflict and which side
    // settled it, and what the checks found.
    expect(dialog.review.sources).toEqual(lineage);
    expect(dialog.review.decisions).toEqual([
      "Merged Mine and Yours from Version 4: 1 difference, 1 from Yours.",
      expect.stringMatching(/^1 conflict settled: .+: Yours\.$/)
    ]);
    expect(dialog.review.checks).toEqual(
      expect.objectContaining({ errors: 0 })
    );

    // Saving was refused: the page is asked to compare again.
    const recompare = jest.fn();
    element.addEventListener("recompare", recompare);
    dialog.dispatchEvent(new CustomEvent("recompare"));
    expect(recompare).toHaveBeenCalled();

    // Closing the dialog hands focus back to the Save button.
    const focus = jest.spyOn(save, "focus").mockImplementation(() => {});
    dialog.dispatchEvent(new CustomEvent("close"));
    await flush();
    expect(dialog.open).toBe(false);
    expect(focus).toHaveBeenCalled();
    focus.mockRestore();
  });

  it("steps through conflicts, taking focus to each one's choices", async () => {
    const base = metadata(4);
    const ours = metadata(4);
    const theirs = metadata(4);
    ours.recordLookups[0].label = "Ours lookup";
    theirs.recordLookups[0].label = "Theirs lookup";
    ours.recordUpdates[1].label = "Ours update";
    theirs.recordUpdates[1].label = "Theirs update";
    ours.description = "Routes cases by rule.";
    theirs.description = "Routes cases by region.";
    const element = mount({
      labels: { base: "Version 4", ours: "Mine", theirs: "Yours" },
      sides: { base, ours, theirs }
    });
    await flush();
    const focus = jest.spyOn(HTMLElement.prototype, "focus");
    const [, next] = $$(element, ".stepper lightning-button-icon");
    const said = () => $(element, ".stepper [role=status]").textContent;
    expect($(element, ".position").textContent).toBe("3 open conflicts");

    next.click();
    await flush();
    expect(said()).toMatch(/^1 of 3 open conflicts: /);
    // Focus goes to the conflict's first choice, which scrolls it into view.
    const panel = $(element, "c-flow-element-panel");
    const radio = panel.shadowRoot.querySelector(".unit-conflict input");
    expect(focus.mock.contexts).toContain(radio);
    expect(radio.getAttribute("aria-label")).toBe("Version 4");
    expect(panel.nextLabel).toBe("Next conflict");

    // The panel's own Next goes on to the second conflict.
    panel.dispatchEvent(new CustomEvent("next"));
    await flush();
    expect(said()).toMatch(/^2 of 3 open conflicts: /);
    const second = $(element, "c-flow-element-panel").entry.key;

    // Picking it takes it off the list; Next goes to the one after it.
    const unit = [...$(element, "c-flow-element-panel").merge.units.values()]
      .filter((item) => item.nodeKey === second && item.status === "conflict")
      .map((item) => item.id)[0];
    $(element, "c-flow-element-panel").dispatchEvent(
      new CustomEvent("pick", { detail: { picks: { [unit]: "theirs" } } })
    );
    await flush();
    expect($(element, ".position").textContent).toBe("2 open conflicts");
    next.click();
    await flush();
    expect(said()).toBe("2 of 2 open conflicts: Description, flow property");
    // A flow property shows each side's value in its row.
    const current = $(element, ".row-current");
    expect(
      [...current.querySelectorAll(".row-value dd")].map(
        (value) => value.textContent
      )
    ).toEqual(["Not set", "Routes cases by rule.", "Routes cases by region."]);

    next.click();
    await flush();
    expect(said()).toMatch(/^1 of 2 open conflicts: .*, back to the start$/);
    focus.mockRestore();
  });

  it("counts an element with two conflicts as one place to step to", async () => {
    const base = metadata(4);
    const ours = metadata(4);
    const theirs = metadata(4);
    ours.recordLookups[0].label = "Ours lookup";
    theirs.recordLookups[0].label = "Theirs lookup";
    ours.recordLookups[0].description = "Ours note";
    theirs.recordLookups[0].description = "Theirs note";
    ours.description = "Routes cases by rule.";
    theirs.description = "Routes cases by region.";
    const element = mount({
      labels: { base: "Version 4", ours: "Mine", theirs: "Yours" },
      sides: { base, ours, theirs }
    });
    await flush();
    expect(chips(element)).toContain("3 conflicts to resolve");
    expect($(element, ".position").textContent).toBe(
      "2 places with open conflicts"
    );
    const [, next] = $$(element, ".stepper lightning-button-icon");
    next.click();
    await flush();
    expect($(element, ".stepper [role=status]").textContent).toMatch(
      /^1 of 2 places with open conflicts: /
    );
  });

  it("keeps a row picked under Only unresolved until focus leaves it", async () => {
    const base = metadata(4);
    const ours = metadata(4);
    ours.recordLookups[0].label = "Ours";
    const theirs = metadata(4);
    theirs.recordLookups[0].label = "Theirs";
    const element = mount({
      labels: { base: "Version 4", ours: "Mine", theirs: "Yours" },
      sides: { base, ours, theirs }
    });
    await flush();
    const only = $(element, ".tab-panel lightning-input");
    only.checked = true;
    only.dispatchEvent(new CustomEvent("change"));
    await flush();
    expect($$(element, ".row").length).toBe(1);

    $(element, ".row-pick").dispatchEvent(
      new CustomEvent("change", { detail: { value: "ours" } })
    );
    await flush();
    // Still there, so the choices can be arrowed through.
    const row = $(element, ".row");
    expect(row.querySelector(".row-status").textContent).toBe("Resolved");
    $(element, ".row-pick").dispatchEvent(
      new CustomEvent("change", { detail: { value: "theirs" } })
    );
    await flush();
    expect($(element, ".row-pick").value).toBe("theirs");

    row.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null }));
    await flush();
    expect($$(element, ".row").length).toBe(0);
    expect($(element, ".empty").textContent).toBe(
      "Every conflict has a side picked."
    );
  });

  it("says whether a part was added, removed or changed", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Edited" },
      sides: { before: metadata(4), after: edited() }
    });
    await flush();
    const status = (name) =>
      $$(element, ".row")
        .filter(
          (row) =>
            row.querySelector(".row-name > span").textContent === name &&
            row.querySelector(".row-detail").textContent === "Whole element"
        )
        .map((row) => row.querySelector(".row-status").textContent)[0];
    expect(status("Log Result")).toBe("Added in Edited");
    expect(status("Unhandled Case Update")).toBe("Removed in Edited");
  });

  it("lists moved elements only when asked", async () => {
    const moved = edited();
    moved.recordLookups[0].locationX += 200;
    const element = mount({
      labels: { before: "Version 4", after: "Edited" },
      sides: { before: metadata(4), after: moved }
    });
    await flush();
    const details = () =>
      $$(element, ".row-detail").map((detail) => detail.textContent);
    expect(details()).not.toContain("Position on the canvas");
    const toggle = $(element, "lightning-input.show-moves");
    expect(toggle.label).toBe("Show moved elements (1)");
    toggle.checked = true;
    toggle.dispatchEvent(new CustomEvent("change"));
    await flush();
    expect(details()).toContain("Position on the canvas");
  });

  it("names a connector by where it leads", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Edited" },
      sides: { before: metadata(4), after: edited() }
    });
    await flush();
    const row = $$(element, ".row").find(
      (candidate) =>
        candidate.querySelector(".row-name > span").textContent ===
        "Should Case Be Updated?"
    );
    expect(row.querySelector(".row-detail").textContent).toBe(
      "“Set Owner To Unrouted” connector"
    );
    // Reconnected: each version's target.
    expect(
      [...row.querySelectorAll(".row-value dd")].map((dd) => dd.textContent)
    ).toEqual(["→ Unhandled Case Update", "→ Log Result"]);
  });

  it("offers to connect an element nothing leads to", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Edited" },
      sides: { before: metadata(4), after: edited() }
    });
    await flush();
    // Take the new element but keep the old connector, so nothing leads to it.
    $(element, "lightning-button-menu").dispatchEvent(
      new CustomEvent("select", { detail: { value: "after" } })
    );
    await flush();
    const row = $$(element, ".row").find(
      (candidate) =>
        candidate.querySelector(".row-name > span").textContent ===
        "Should Case Be Updated?"
    );
    row
      .querySelector("lightning-radio-group")
      .dispatchEvent(
        new CustomEvent("change", { detail: { value: "before" } })
      );
    await flush();
    $(element, '[data-tab="problems"]').click();
    await flush();
    const fixes = () => $$(element, ".problem-fix");
    expect(fixes().map((fix) => fix.label)).toEqual([
      "Connect it as in Edited"
    ]);
    fixes()[0].click();
    await flush();
    expect(fixes()).toHaveLength(0);
  });

  it("won't save the same merge twice", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Edited" },
      sides: { before: metadata(4), after: edited() }
    });
    await flush();
    const menu = $(element, "lightning-button-menu");
    expect(menu.label).toBe("Pick for all");
    menu.dispatchEvent(
      new CustomEvent("select", { detail: { value: "after" } })
    );
    await flush();
    const save = $(element, "lightning-button.save");
    expect(save.disabled).toBe(false);
    const dialog = $(element, "c-flow-save-dialog");
    dialog.dispatchEvent(
      new CustomEvent("saved", {
        detail: {
          result: { versionNumber: 5 },
          connection: "local",
          saveKey: dialog.saveKey
        }
      })
    );
    await flush();
    expect(save.disabled).toBe(true);
    expect($(element, ".save-note").textContent).toBe(
      "Saved as version 5. Change the merge to save again."
    );
    menu.dispatchEvent(
      new CustomEvent("select", { detail: { value: "union" } })
    );
    await flush();
    expect(save.disabled).toBe(false);
  });

  it("keeps later changes unsaved when an earlier save finishes", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Edited" },
      draftKey: "local:v4|local:edited",
      sides: { before: metadata(4), after: edited() }
    });
    await flush();
    const menu = $(element, "lightning-button-menu");
    menu.dispatchEvent(
      new CustomEvent("select", { detail: { value: "after" } })
    );
    await flush();
    const dialog = $(element, "c-flow-save-dialog");
    const sent = dialog.saveKey;
    // The dialog is closed while it saves, and the merge changes.
    menu.dispatchEvent(
      new CustomEvent("select", { detail: { value: "union" } })
    );
    await flush();
    const saved = jest.fn();
    element.addEventListener("saved", saved);
    dialog.dispatchEvent(
      new CustomEvent("saved", {
        detail: {
          result: { versionNumber: 5 },
          connection: "local",
          saveKey: sent
        }
      })
    );
    await flush();
    expect(saved).toHaveBeenCalled();
    expect($(element, "lightning-button.save").disabled).toBe(false);
    expect(window.sessionStorage.length).toBe(1);
  });

  it("opens an element from the change list", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Edited" },
      sides: { before: metadata(4), after: edited() }
    });
    await flush();
    const open = $$(element, ".row-title").find(
      (button) =>
        button.dataset.kind !== "prop" && button.dataset.kind !== "resource"
    );
    open.click();
    await flush();
    const panel = $(element, "c-flow-element-panel");
    expect(panel).not.toBeNull();
    expect(panel.entry.key).toBe(open.dataset.target);
    expect($(element, ".position").textContent).toMatch(/of/);
    panel.dispatchEvent(new CustomEvent("close"));
    await flush();
    expect($(element, "c-flow-element-panel")).toBeNull();
  });

  it("saves the XML merge in text mode", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Edited" },
      sides: { before: metadata(4), after: edited() }
    });
    await flush();
    $(element, "lightning-radio-group").dispatchEvent(
      new CustomEvent("change", { detail: { value: "text" } })
    );
    await flush();
    const text = $(element, "c-flow-text-merge");
    expect(text).not.toBeNull();
    expect(text.sides.before.label).toBe(metadata(4).label);
    expect($(element, ".canvas-mode").classList).toContain("slds-hide");
    expect($(element, "lightning-button.save").label).toBe("Save XML merge");

    // Going to the visual merge and back keeps the same XML merge, so its
    // picks and hand edits survive.
    const modes = $(element, "lightning-radio-group");
    modes.dispatchEvent(
      new CustomEvent("change", { detail: { value: "canvas" } })
    );
    await flush();
    expect($(element, ".text-mode").classList).toContain("slds-hide");
    modes.dispatchEvent(
      new CustomEvent("change", { detail: { value: "text" } })
    );
    await flush();
    expect($(element, "c-flow-text-merge")).toBe(text);

    const edits = { ...metadata(4), label: "From XML" };
    const sides = text.sides;
    text.dispatchEvent(
      new CustomEvent("resultchange", {
        detail: {
          metadata: edits,
          problems: [],
          unresolved: 0,
          text: "<Flow/>"
        }
      })
    );
    await flush();
    // Re-rendering passes the same flows, so the picks made there stay.
    expect($(element, "c-flow-text-merge").sides).toBe(sides);
    const save = $(element, "lightning-button.save");
    expect(save.disabled).toBe(false);
    save.click();
    await flush();
    expect($(element, "c-flow-save-dialog").metadata.label).toBe("From XML");
    expect($(element, "c-flow-save-dialog").review).toEqual({
      sources: [],
      decisions: [expect.stringMatching(/ as XML\.$/)],
      checks: { errors: 0, warnings: 0, messages: [] }
    });

    // Hand edits aren't from either version, so the receipt says so.
    text.dispatchEvent(
      new CustomEvent("resultchange", {
        detail: {
          metadata: edits,
          problems: [],
          unresolved: 0,
          text: "<Flow/>",
          handEdits: { added: 3, removed: 1 }
        }
      })
    );
    await flush();
    expect($(element, "c-flow-save-dialog").review.decisions).toEqual([
      expect.stringMatching(/ as XML\.$/),
      "Edited by hand after picking: 3 lines added, 1 line removed."
    ]);
    expect($(element, "c-flow-save-dialog").changeSummary).toContain(
      "Edited by hand"
    );

    // Warnings, such as elements the start no longer reaches, aren't a pass.
    text.dispatchEvent(
      new CustomEvent("resultchange", {
        detail: {
          metadata: edits,
          problems: [],
          warnings: ["Cap Discount isn't connected to the start."],
          unresolved: 0,
          text: "<Flow/>"
        }
      })
    );
    await flush();
    expect(chips(element)).toEqual(["No errors", "1 warning"]);

    text.dispatchEvent(
      new CustomEvent("resultchange", {
        detail: { error: "Bad XML", unresolved: 0 }
      })
    );
    await flush();
    expect(save.disabled).toBe(true);
    expect(chips(element)).toContain("The XML isn't a valid flow");

    text.dispatchEvent(
      new CustomEvent("resultchange", {
        detail: {
          metadata: edits,
          problems: ["A connector goes nowhere."],
          unresolved: 0
        }
      })
    );
    await flush();
    expect(save.disabled).toBe(true);
    expect(save.title).toBe("Fix the errors first.");
    expect(chips(element)).toContain("1 error");
  });

  it("keeps the XML merge blocked while a conflict is open", async () => {
    const base = metadata(4);
    const ours = metadata(4);
    ours.label = "Ours";
    ours.recordLookups[0].label = "Ours";
    const theirs = metadata(4);
    theirs.label = "Theirs";
    theirs.recordLookups[0].label = "Theirs";
    const element = mount({
      labels: { base: "Version 4", ours: "Mine", theirs: "Yours" },
      sides: { base, ours, theirs }
    });
    await flush();
    $(element, "lightning-radio-group").dispatchEvent(
      new CustomEvent("change", { detail: { value: "text" } })
    );
    await flush();
    const text = $(element, "c-flow-text-merge");
    const pickers = text.shadowRoot.querySelectorAll("lightning-radio-group");
    expect(pickers.length).toBe(2);

    // A real picker's change bubbles out of the XML merge; it mustn't pass
    // for the merge's result.
    pickers[0].dispatchEvent(
      new CustomEvent("change", {
        detail: { value: "theirs" },
        bubbles: true,
        composed: true
      })
    );
    await flush();
    const save = $(element, "lightning-button.save");
    expect(chips(element)).toContain("1 conflict to resolve");
    expect(save.disabled).toBe(true);
  });
  it("maps a different flow onto this one before merging", async () => {
    const element = mount({
      labels: { before: "Case Triage v1", after: "Case Helper v1" },
      draftKey: "local:triage|local:helper",
      sides: { before: flow("Case_Triage"), after: flow("Case_Helper") }
    });
    await flush();
    // A different flow opens on its mapping.
    const tabs = $$(element, ".tab").map((tab) => tab.dataset.tab);
    expect(tabs[0]).toBe("mapping");
    const panel = $(element, "c-flow-mapping-panel");
    expect(panel).not.toBeNull();
    expect(panel.plan.source.name).toBe("Case_Helper");
    // recordId maps onto the triggering case's id; the lookup onto $Record.
    expect(panel.choices.roots.recordid).toEqual({
      to: "$Record.Id",
      suggested: true
    });
    expect(panel.notes.added).toContain("Route");

    // Put the other flow after the decision's default outcome.
    panel.dispatchEvent(
      new CustomEvent("place", {
        detail: { afterKey: "Check_Priority", slot: "defaultConnector" }
      })
    );
    await flush();
    const canvas = $(element, "c-flow-canvas");
    const route = canvas.scene.nodes.find((node) => node.key === "Route");
    expect(route.status).toBe("added");
    expect(chips(element)).toContain("No errors");

    // A new mapping is a new merge; the draft keeps the mapping.
    panel.dispatchEvent(
      new CustomEvent("mappingchange", {
        detail: {
          choices: {
            ...panel.choices,
            roots: { ...panel.choices.roots, note: { create: "caseNote" } }
          }
        }
      })
    );
    await flush();
    const again = $(element, "c-flow-mapping-panel");
    expect(again.notes.renamed).toContainEqual(
      expect.objectContaining({ from: "note", to: "caseNote" })
    );
    expect(
      JSON.parse(window.sessionStorage.getItem("flowCompare.mappingDraft"))
    ).toBeTruthy();

    // Saving says what was mapped.
    $(element, "lightning-button.save").click();
    await flush();
    const dialog = $(element, "c-flow-save-dialog");
    expect(dialog.changeSummary).toMatch(/Mapped .*recordId → \$Record\.Id/);
    expect(dialog.changeSummary).toMatch(/connectors? rewired/);
    // The receipt lists each on its own line.
    const decisions = dialog.review.decisions;
    expect(decisions).toContainEqual(
      expect.stringMatching(
        /^Mapped from the other flow: .*recordId → \$Record\.Id/
      )
    );
    expect(decisions).toContainEqual(
      expect.stringMatching(
        /^Connectors rewired: Check_Priority \(defaultConnector\) → Route/
      )
    );
  });

  it("blocks saving on a mapping that can't work, and opens it", async () => {
    const element = mount({
      labels: { before: "Case Triage v1", after: "Case Helper v1" },
      sides: { before: flow("Case_Triage"), after: flow("Case_Helper") }
    });
    await flush();
    const panel = $(element, "c-flow-mapping-panel");
    panel.dispatchEvent(
      new CustomEvent("mappingchange", {
        detail: {
          choices: {
            ...panel.choices,
            roots: { ...panel.choices.roots, recordid: { to: "No_Such" } }
          }
        }
      })
    );
    await flush();
    const save = $(element, "lightning-button.save");
    expect(save.disabled).toBe(true);
    expect(chips(element).join()).toMatch(/1 error/);
    // The mapping says what's wrong where it's chosen.
    const row = $(element, "c-flow-mapping-panel").shadowRoot.querySelector(
      '.root[data-key="recordid"]'
    );
    expect(row.querySelector(".root-error").textContent).toMatch(
      /mapped to No_Such, which Case Triage doesn't have/
    );

    // From the problem list, the mapping opens with its choice focused.
    $(element, '[data-tab="problems"]').click();
    await flush();
    const problem = $$(element, ".problem-text").find(
      (item) => item.dataset.mapping === "recordid"
    );
    expect(problem.textContent).toMatch(/No_Such/);
    problem.click();
    await flush();
    expect(
      $(element, '[data-tab="mapping"]').getAttribute("aria-selected")
    ).toBe("true");
    const pick = $(element, "c-flow-mapping-panel").shadowRoot.querySelector(
      '.root-pick[data-key="recordid"]'
    );
    expect(pick.value).toBe("to:No_Such");
  });

  it("carries the mapping's problems and decisions into the XML merge", async () => {
    const element = mount({
      labels: { before: "Case Triage v1", after: "Case Helper v1" },
      sides: { before: flow("Case_Triage"), after: flow("Case_Helper") }
    });
    await flush();
    const panel = $(element, "c-flow-mapping-panel");
    const suggested = panel.choices;
    // A name that can't be used: the XML gets a fallback name that can.
    panel.dispatchEvent(
      new CustomEvent("mappingchange", {
        detail: {
          choices: {
            ...suggested,
            roots: { ...suggested.roots, note: { create: "2bad" } }
          }
        }
      })
    );
    await flush();
    // Several elements are marked on the canvas when the XML merge opens.
    const canvas = $(element, "c-flow-canvas");
    const ids = canvas.scene.nodes
      .filter((node) => node.key !== "$Start")
      .slice(0, 2)
      .map((node) => node.id);
    for (const id of ids) {
      canvas.dispatchEvent(
        new CustomEvent("select", { detail: { id, additive: true } })
      );
    }
    await flush();
    expect($(element, "c-flow-group-panel")).not.toBeNull();
    $(element, "lightning-radio-group").dispatchEvent(
      new CustomEvent("change", { detail: { value: "text" } })
    );
    await flush();
    const save = $(element, "lightning-button.save");
    expect(save.disabled).toBe(true);
    expect($(element, ".save-note").textContent).toMatch(
      /^Fix the mapping first/
    );
    expect(chips(element)).toContain("1 error");
    // It says why, and opens the mapping where it's fixed.
    const problems = $$(element, ".text-mapping-open");
    expect(problems[0].textContent).toMatch(/"2bad" can't be the name/);
    const focus = jest.spyOn(HTMLElement.prototype, "focus");
    problems[0].click();
    await flush();
    expect($(element, ".text-mode").classList).toContain("slds-hide");
    expect($(element, "c-flow-group-panel")).toBeNull();
    expect(
      $(element, '[data-tab="mapping"]').getAttribute("aria-selected")
    ).toBe("true");
    // The mapping's row takes focus.
    const row = [
      ...$(element, "c-flow-mapping-panel").shadowRoot.querySelectorAll(".root")
    ].find((item) => item.dataset.key === problems[0].dataset.mapping);
    expect(focus.mock.contexts).toContain(row.querySelector(".root-pick"));
    focus.mockRestore();

    // Fixed, the XML saves, and its receipt keeps the mapping's warning
    // and what was mapped.
    $(element, "c-flow-mapping-panel").dispatchEvent(
      new CustomEvent("mappingchange", { detail: { choices: suggested } })
    );
    await flush();
    $(element, "lightning-radio-group").dispatchEvent(
      new CustomEvent("change", { detail: { value: "text" } })
    );
    await flush();
    expect(save.disabled).toBe(false);
    save.click();
    await flush();
    const dialog = $(element, "c-flow-save-dialog");
    const { decisions, checks } = dialog.review;
    expect(decisions).toContainEqual(
      expect.stringMatching(
        /^Mapped from the other flow: .*recordId → \$Record\.Id/
      )
    );
    expect(checks.errors).toBe(0);
    expect(checks.messages).toContainEqual(
      expect.stringMatching(/recordId is mapped to \$Record\.Id only because/)
    );
    expect(dialog.changeSummary).toMatch(/as XML\. Mapped .*recordId/);
  });

  it("merges versions of one flow without a mapping", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Edited" },
      sides: {
        before: { FullName: "Case_Email_Routing", Metadata: metadata(4) },
        after: { FullName: "Case_Email_Routing", Metadata: edited() }
      }
    });
    await flush();
    const tabs = $$(element, ".tab").map((tab) => tab.dataset.tab);
    expect(tabs).not.toContain("mapping");
    expect($(element, "c-flow-mapping-panel")).toBeNull();
  });

  it("takes a group of changes in one step", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Grown" },
      sides: { before: metadata(4), after: grown() }
    });
    await flush();
    const groupsTab = $$(element, ".tab").find(
      (tab) => tab.dataset.tab === "groups"
    );
    expect(groupsTab.textContent).toMatch(/Groups \(1\)/);
    groupsTab.click();
    await flush();
    const pick = $(element, ".group-row .row-pick");
    expect(pick.value).toBe("before");
    pick.dispatchEvent(
      new CustomEvent("change", { detail: { value: "after" } })
    );
    await flush();
    const canvas = $(element, "c-flow-canvas");
    const added = canvas.scene.nodes
      .filter((node) => node.status === "added")
      .map((node) => node.key)
      .sort();
    expect(added).toEqual(["Note_One", "Note_Two"]);
    expect($(element, ".group-row .row-pick").value).toBe("after");
    expect(chips(element)).toContain("No errors");

    // Select opens the group panel, marking the elements on the canvas.
    $(element, ".group-select").click();
    await flush();
    // The lookup is in the group too: its connector changed to lead there.
    const group = $(element, "c-flow-group-panel");
    expect([...group.keys].sort()).toEqual([
      "Get_Routing",
      "Note_One",
      "Note_Two"
    ]);
    expect(canvas.markedIds).toHaveLength(3);
    group.dispatchEvent(new CustomEvent("clear"));
    await flush();
    expect($(element, "c-flow-group-panel")).toBeNull();
  });

  it("undoes and redoes each change as one step", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Grown" },
      sides: { before: metadata(4), after: grown() }
    });
    await flush();
    const added = () =>
      $(element, "c-flow-canvas")
        .scene.nodes.filter((node) => node.status === "added")
        .map((node) => node.key)
        .sort();
    expect($(element, ".undo").disabled).toBe(true);
    expect($(element, ".redo").disabled).toBe(true);

    $$(element, ".tab")
      .find((tab) => tab.dataset.tab === "groups")
      .click();
    await flush();
    // Taking the group changes several parts; one undo puts them all back.
    $(element, ".group-row .row-pick").dispatchEvent(
      new CustomEvent("change", { detail: { value: "after" } })
    );
    await flush();
    expect(added()).toEqual(["Note_One", "Note_Two"]);
    $(element, ".undo").click();
    await flush();
    expect(added()).toEqual([]);
    expect($(element, ".group-row .row-pick").value).toBe("before");
    expect($(element, ".undo").disabled).toBe(true);
    expect($(element, ".stepper .slds-assistive-text").textContent).toBe(
      "Undid the last change"
    );
    $(element, ".redo").click();
    await flush();
    expect(added()).toEqual(["Note_One", "Note_Two"]);
    // The next edit clears the message about the last one.
    $(element, ".group-row .row-pick").dispatchEvent(
      new CustomEvent("change", { detail: { value: "before" } })
    );
    await flush();
    expect($(element, ".stepper .slds-assistive-text").textContent).toBe("");
    $(element, ".undo").click();
    await flush();

    // The keyboard does the same, but not while typing in a field.
    const key = (target, init) =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, composed: true, ...init })
      );
    const view = $(element, ".merge-view");
    key(view, { key: "z", ctrlKey: true });
    await flush();
    expect(added()).toEqual([]);
    key(view, { key: "z", ctrlKey: true, shiftKey: true });
    await flush();
    expect(added()).toEqual(["Note_One", "Note_Two"]);
    // As from a text field inside one of the view's components.
    const typing = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      composed: true
    });
    const input = document.createElement("input");
    typing.composedPath = () => [input, view];
    view.dispatchEvent(typing);
    await flush();
    expect(added()).toEqual(["Note_One", "Note_Two"]);

    // A new change after an undo drops what could be redone.
    key(view, { key: "z", metaKey: true });
    await flush();
    $(element, "lightning-button-menu").dispatchEvent(
      new CustomEvent("select", { detail: { value: "after" } })
    );
    await flush();
    expect($(element, ".redo").disabled).toBe(true);
    expect(added()).toContain("Note_One");
  });

  it("sets XML edits aside when the mapping changes, and keeps them", async () => {
    const element = mount({
      labels: { before: "Case Triage v1", after: "Case Helper v1" },
      draftKey: "local:triage|local:helper",
      sides: { before: flow("Case_Triage"), after: flow("Case_Helper") }
    });
    await flush();
    const mode = (value) =>
      $(element, "lightning-radio-group").dispatchEvent(
        new CustomEvent("change", { detail: { value } })
      );
    mode("text");
    await flush();
    const text = $(element, "c-flow-text-merge");
    text.shadowRoot.querySelector(".edit").click();
    await flush();
    const area = text.shadowRoot.querySelector("textarea");
    area.value = area.value.replace(
      "<label>Case Triage</label>",
      "<label>Edited under the first mapping</label>"
    );
    area.dispatchEvent(new CustomEvent("input"));
    // Once typing pauses, the edit is kept.
    await new Promise((resolve) => setTimeout(resolve, 300));

    mode("canvas");
    await flush();
    const panel = $(element, "c-flow-mapping-panel");
    panel.dispatchEvent(
      new CustomEvent("mappingchange", {
        detail: {
          choices: {
            ...panel.choices,
            roots: { ...panel.choices.roots, note: { create: "caseNote" } }
          }
        }
      })
    );
    await flush();
    mode("text");
    await flush();
    // The edits were made against the other flow mapped another way.
    const root = $(element, "c-flow-text-merge").shadowRoot;
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.querySelector(".aside p").textContent).toMatch(
      /another mapping/
    );

    // Saving this merge doesn't lose them.
    $(element, "lightning-button.save").click();
    await flush();
    const dialog = $(element, "c-flow-save-dialog");
    dialog.dispatchEvent(
      new CustomEvent("saved", {
        detail: { result: { versionNumber: 2 }, saveKey: dialog.saveKey }
      })
    );
    await flush();
    const kept = JSON.parse(
      window.sessionStorage.getItem("flowCompare.textDraft")
    );
    expect(kept.value.aside[0].text).toContain(
      "Edited under the first mapping"
    );

    // The first mapping again brings them back.
    mode("canvas");
    await flush();
    $(element, ".undo").click();
    await flush();
    mode("text");
    await flush();
    expect(
      $(element, "c-flow-text-merge").shadowRoot.querySelector("textarea").value
    ).toContain("Edited under the first mapping");
  });

  it("undoes a change of mapping", async () => {
    const element = mount({
      labels: { before: "Case Triage v1", after: "Case Helper v1" },
      sides: { before: flow("Case_Triage"), after: flow("Case_Helper") }
    });
    await flush();
    const panel = $(element, "c-flow-mapping-panel");
    const before = panel.choices;
    panel.dispatchEvent(
      new CustomEvent("mappingchange", {
        detail: {
          choices: {
            ...before,
            roots: { ...before.roots, note: { create: "caseNote" } }
          }
        }
      })
    );
    await flush();
    expect($(element, "c-flow-mapping-panel").choices.roots.note).toEqual({
      create: "caseNote"
    });
    $(element, ".undo").click();
    await flush();
    expect($(element, "c-flow-mapping-panel").choices).toEqual(before);
    $(element, ".redo").click();
    await flush();
    expect($(element, "c-flow-mapping-panel").choices.roots.note).toEqual({
      create: "caseNote"
    });
  });

  it("keeps a mapping chosen in the panel's own controls", async () => {
    const element = mount({
      labels: { before: "Case Triage v1", after: "Case Helper v1" },
      sides: { before: flow("Case_Triage"), after: flow("Case_Helper") }
    });
    await flush();
    // A base control's change event bubbles out of the panel, as in the org.
    const pick = $(element, "c-flow-mapping-panel").shadowRoot.querySelector(
      '.root-pick[data-key="recordid"]'
    );
    pick.dispatchEvent(
      new CustomEvent("change", {
        detail: { value: "create" },
        bubbles: true,
        composed: true
      })
    );
    await flush();
    expect($(element, "c-flow-mapping-panel").choices.roots.recordid).toEqual({
      create: "recordId"
    });
  });

  it("takes a group from an unrelated flow, from mapping to a draft", async () => {
    const element = mount({
      labels: { before: "Case Triage v1", after: "Case Helper v1" },
      sides: { before: flow("Case_Triage"), after: flow("Case_Helper") }
    });
    await flush();
    // Confirm that its case id is the triggering record's.
    const mapping = $(element, "c-flow-mapping-panel");
    mapping.dispatchEvent(
      new CustomEvent("mappingchange", {
        detail: {
          choices: {
            ...mapping.choices,
            roots: { ...mapping.choices.roots, recordid: { to: "$Record.Id" } }
          }
        }
      })
    );
    await flush();

    // Mark Route and Set_Note on the canvas.
    const canvas = () => $(element, "c-flow-canvas");
    const select = (key, additive) =>
      canvas().dispatchEvent(
        new CustomEvent("select", {
          detail: {
            id: canvas().scene.nodes.find((node) => node.key === key).id,
            additive
          }
        })
      );
    const inResult = () =>
      canvas()
        .scene.nodes.filter((node) => node.status === "added")
        .map((node) => node.key)
        .sort();
    expect(inResult()).toEqual([]);
    select("Route", false);
    await flush();
    select("Set_Note", true);
    await flush();
    const group = $(element, "c-flow-group-panel");
    expect(group.keys).toEqual(["Route", "Set_Note"]);

    // Put them on Check Priority's High path: the preview says where each
    // path goes and waits for the two that are someone's call.
    const place = group.shadowRoot.querySelector("c-flow-place");
    const inPlace = (selector) => [
      ...place.shadowRoot.querySelectorAll(selector)
    ];
    const change = (target, value) =>
      target.dispatchEvent(new CustomEvent("change", { detail: { value } }));
    change(place.shadowRoot.querySelector("c-flow-picker"), "Check_Priority");
    await flush();
    change(
      place.shadowRoot.querySelector(".place-slot"),
      "rules.High.connector"
    );
    await flush();
    expect(inPlace(".entry")[0].textContent).toBe(
      "Goes into Route, then on to Escalate."
    );
    const notes = () => inPlace(".note").map((node) => node.textContent);
    expect(notes()).toContain("Brings in 1 resource they use: note_2.");
    expect(notes()).toContain("Choose where the 2 marked paths go first.");
    const button = place.shadowRoot.querySelector(".place-button");
    expect(button.disabled).toBe(true);

    // Ending both would leave Escalate with nothing leading to it.
    const picks = inPlace(".exit-pick");
    expect(picks.map((pick) => pick.closest(".exit").dataset.id)).toEqual([
      "wire|Route|defaultConnector",
      "wire|Set_Note|connector"
    ]);
    for (const pick of picks) {
      change(pick, "-");
    }
    await flush();
    expect(notes()).toContain("Nothing will lead to Escalate any more.");
    for (const pick of inPlace(".exit-pick")) {
      change(pick, "Escalate");
    }
    await flush();
    expect(notes()).not.toContain("Nothing will lead to Escalate any more.");
    expect(button.disabled).toBe(false);
    button.click();
    await flush();
    expect(inResult()).toEqual(["Route", "Set_Note"]);

    // Before saving, the summary names the new variable and the renames.
    const dialog = () => $(element, "c-flow-save-dialog");
    expect(dialog().changeSummary).toContain("New: note_2 (variable).");
    expect(dialog().changeSummary).toContain("Renamed note → note_2");
    expect(chips(element)).toContain("Local checks passed");

    // One undo takes the whole placing back; redo puts it again.
    $(element, ".undo").click();
    await flush();
    expect(inResult()).toEqual([]);
    $(element, ".redo").click();
    await flush();
    expect(inResult()).toEqual(["Route", "Set_Note"]);

    // The draft download is the flow the save dialog would save, as a
    // draft, under the target's name.
    const saved = [];
    const click = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function () {
        saved.push({ href: this.href, name: this.download });
      });
    const download = $(element, "lightning-button.download");
    expect(download.disabled).toBe(false);
    download.click();
    click.mockRestore();
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("Case_Triage.flow-meta.xml");
    const text = decodeURIComponent(
      saved[0].href.split(",").slice(1).join(",")
    );
    const { status, ...draft } = fromXml(text);
    expect(status).toBe("Draft");
    expect(JSON.parse(JSON.stringify(draft))).toEqual(
      JSON.parse(JSON.stringify(dialog().metadata))
    );
    expect(draft.start.connector.targetReference).toBe("Check_Priority");
    expect(draft.variables.map((item) => item.name).sort()).toEqual([
      "note",
      "note_2"
    ]);
    expect(dialog().metadata.status).toBeUndefined();
  });

  it("won't download a draft while a conflict is open", async () => {
    const base = metadata(4);
    const ours = metadata(4);
    ours.recordLookups[0].label = "Ours";
    const theirs = metadata(4);
    theirs.recordLookups[0].label = "Theirs";
    const element = mount({
      labels: { base: "Version 4", ours: "Mine", theirs: "Yours" },
      sides: { base, ours, theirs }
    });
    await flush();
    const download = $(element, "lightning-button.download");
    expect(download.disabled).toBe(true);
    expect(download.title).toBe("Resolve every conflict first.");
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click");
    download.click();
    expect(click).not.toHaveBeenCalled();

    // Resolved, it downloads under the flow's name.
    $(element, ".row-conflict .row-pick").dispatchEvent(
      new CustomEvent("change", { detail: { value: "ours" } })
    );
    await flush();
    expect(download.disabled).toBe(false);
    click.mockImplementation(() => {});
    download.click();
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.contexts[0].download).toBe(
      "Case_Email_Routing.flow-meta.xml"
    );
    click.mockRestore();
  });

  it("picks several elements with Shift-click", async () => {
    const element = mount({
      labels: { before: "Version 4", after: "Grown" },
      sides: { before: metadata(4), after: grown() }
    });
    await flush();
    const canvas = $(element, "c-flow-canvas");
    const idOf = (key) =>
      canvas.scene.nodes.find((node) => node.key === key).id;
    const select = (key, additive) =>
      canvas.dispatchEvent(
        new CustomEvent("select", { detail: { id: idOf(key), additive } })
      );
    select("Note_One", false);
    await flush();
    expect($(element, "c-flow-element-panel")).not.toBeNull();
    select("Note_Two", true);
    await flush();
    const group = $(element, "c-flow-group-panel");
    expect(group.keys).toEqual(["Note_One", "Note_Two"]);

    // Leave them both out, then take them from Grown.
    group.dispatchEvent(
      new CustomEvent("pick", {
        detail: {
          picks: { "node|Note_One": "after", "node|Note_Two": "after" }
        }
      })
    );
    await flush();
    expect(
      canvas.scene.nodes.find((node) => node.key === "Note_One").status
    ).toBe("added");

    // Shift-clicking one again leaves one: it's simply selected.
    select("Note_Two", true);
    await flush();
    expect($(element, "c-flow-group-panel")).toBeNull();
    expect($(element, "c-flow-element-panel").entry.key).toBe("Note_One");
  });

  it("keeps rewired connectors across a reload", async () => {
    const props = () => ({
      labels: { before: "Version 4", after: "Grown" },
      draftKey: "local:v4|local:grown",
      sides: { before: metadata(4), after: grown() }
    });
    let element = mount(props());
    await flush();
    const lookup = metadata(4).recordLookups[0].name;
    let panel;
    const canvas = $(element, "c-flow-canvas");
    const id = canvas.scene.nodes.find((node) => node.key === lookup).id;
    canvas.dispatchEvent(new CustomEvent("select", { detail: { id } }));
    await flush();
    panel = $(element, "c-flow-element-panel");
    panel.dispatchEvent(
      new CustomEvent("pick", {
        detail: { picks: { [`wire|${lookup}|connector`]: "" } }
      })
    );
    await flush();
    expect($(element, "c-flow-element-panel").picks).toEqual({
      [`wire|${lookup}|connector`]: ""
    });
    document.body.removeChild(element);

    element = mount(props());
    await flush();
    expect(chips(element).join(" ")).toMatch(/1 earlier pick restored/);
  });
});
