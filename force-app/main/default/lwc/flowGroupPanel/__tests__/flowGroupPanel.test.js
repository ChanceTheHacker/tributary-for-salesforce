import { createElement } from "lwc";
import FlowGroupPanel from "c/flowGroupPanel";
import { createMerge, resolveMerge } from "c/flowMerge";

const FREE_FORM = [
  { name: "CanvasMode", value: { stringValue: "FREE_FORM_CANVAS" } }
];
const step = (name, next) => ({
  name,
  label: name.replace("_", " "),
  locationX: 0,
  locationY: 0,
  assignmentItems: [],
  ...(next ? { connector: { targetReference: next } } : {})
});
const flow = (assignments) => ({
  processType: "AutoLaunchedFlow",
  processMetadataValues: FREE_FORM,
  start: { locationX: 0, locationY: 0, connector: { targetReference: "A" } },
  assignments
});

// After adds X1 → X2 between A and B.
function setup(picks = {}) {
  const merge = createMerge({
    before: flow([step("A", "B"), step("B")]),
    after: flow([step("A", "X1"), step("X1", "X2"), step("X2", "B"), step("B")])
  });
  return { merge, resolved: resolveMerge(merge, picks), picks };
}

function mount(props) {
  const element = createElement("c-flow-group-panel", { is: FlowGroupPanel });
  Object.assign(element, {
    labels: { before: "Version 1", after: "Version 2" },
    keys: ["X1", "X2"],
    ...setup(),
    ...props
  });
  document.body.appendChild(element);
  return element;
}

const flush = () => Promise.resolve();
const $ = (element, selector) => element.shadowRoot.querySelector(selector);
const $$ = (element, selector) => [
  ...element.shadowRoot.querySelectorAll(selector)
];

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
});

describe("c-flow-group-panel", () => {
  it("lists the elements, where they're from and whether they're in", async () => {
    const element = mount();
    await flush();
    expect($(element, ".title").textContent).toBe("2 elements selected");
    const details = $$(element, ".member-detail").map((d) => d.textContent);
    expect(details[0]).toMatch(/Only in Version 2/);
    expect($$(element, ".state").map((s) => s.textContent)).toEqual([
      "Left out",
      "Left out"
    ]);
  });

  it("takes them all from a version, wired in", async () => {
    const element = mount();
    const handler = jest.fn();
    element.addEventListener("pick", handler);
    await flush();
    const buttons = $$(element, ".sides lightning-button");
    expect(buttons.map((button) => button.label)).toEqual([
      "Leave out",
      "Use Version 2's"
    ]);
    buttons[1].click();
    const picks = handler.mock.calls[0][0].detail.picks;
    const { merge } = setup();
    const result = resolveMerge(merge, picks);
    expect(result.model.nodes.has("X1")).toBe(true);
    expect(result.model.edges.get("A.connector").target).toBe("X1");
    expect(result.errors).toBe(0);
  });

  it("warns before replacing mixed-version selections without changing their picks", async () => {
    const props = setup({ "node|X1": "after", "node|X2": "before" });
    const element = mount(props);
    const handler = jest.fn();
    element.addEventListener("pick", handler);
    await flush();
    expect($(element, ".mixed-warning").textContent).toContain(
      "combine versions"
    );
    expect(element.picks).toEqual(props.picks);
    expect(handler).not.toHaveBeenCalled();
    Object.assign(element, setup());
    await flush();
    expect($(element, ".mixed-warning")).toBeNull();
  });

  it("puts them on another path", async () => {
    const element = mount();
    const handler = jest.fn();
    element.addEventListener("pick", handler);
    await flush();
    const place = $(element, "c-flow-place");
    expect(place.exclude).toEqual(["X1", "X2"]);
    place.dispatchEvent(
      new CustomEvent("place", { detail: { afterKey: "B", slot: "connector" } })
    );
    const picks = handler.mock.calls[0][0].detail.picks;
    const { merge } = setup();
    const result = resolveMerge(merge, picks);
    expect(result.model.edges.get("B.connector").target).toBe("X1");
    expect(result.model.edges.get("A.connector").target).toBe("B");
    expect(result.model.edges.has("X2.connector")).toBe(false);
  });

  it("opens, drops and clears", async () => {
    const element = mount();
    const open = jest.fn();
    const unmark = jest.fn();
    const clear = jest.fn();
    element.addEventListener("open", open);
    element.addEventListener("unmark", unmark);
    element.addEventListener("clear", clear);
    await flush();
    $$(element, ".member-name")[1].click();
    expect(open.mock.calls[0][0].detail.key).toBe("X2");
    $$(element, ".member lightning-button-icon")[0].click();
    expect(unmark.mock.calls[0][0].detail.key).toBe("X1");
    $(element, ".head lightning-button-icon").click();
    expect(clear).toHaveBeenCalled();
  });
});
