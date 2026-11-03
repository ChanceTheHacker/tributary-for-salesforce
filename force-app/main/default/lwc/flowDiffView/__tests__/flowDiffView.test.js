import { createElement } from "lwc";
import FlowDiffView from "c/flowDiffView";

const v3 = require("fixtures/flows/Case_Email_Routing/v3.json");
const v4 = require("fixtures/flows/Case_Email_Routing/v4.json");

function edited() {
  const flow = JSON.parse(JSON.stringify(v4.Metadata));
  flow.recordLookups[0].label = "Renamed lookup";
  return flow;
}

function mount(props) {
  const element = createElement("c-flow-diff-view", { is: FlowDiffView });
  Object.assign(element, props);
  document.body.appendChild(element);
  return element;
}

const flush = () => Promise.resolve();

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
});

describe("c-flow-diff-view", () => {
  it("shows both sides with a summary of the changes", async () => {
    const element = mount({
      before: v4.Metadata,
      after: edited(),
      labels: { before: "Version 4", after: "Edited" }
    });
    await flush();
    const canvases = element.shadowRoot.querySelectorAll("c-flow-canvas");
    expect(canvases).toHaveLength(2);
    const pills = [...element.shadowRoot.querySelectorAll(".pill")].map(
      (pill) => pill.textContent
    );
    expect(pills).toContain("1 changed");
    expect(
      element.shadowRoot.querySelector("c-flow-resources-panel")
    ).not.toBeNull();
  });

  it("toggles narrow resources without remounting and opens selected details", async () => {
    const element = mount({ before: v4.Metadata, after: edited() });
    await flush();
    const root = element.shadowRoot;
    const toggle = root.querySelector(".resources-toggle");
    const resources = root.querySelector("c-flow-resources-panel");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector(".side").classList).not.toContain("side-open");
    toggle.click();
    await flush();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector("c-flow-resources-panel")).toBe(resources);
    toggle.click();
    await flush();
    root.querySelector('lightning-button-icon[title="Next change"]').click();
    await flush();
    expect(root.querySelector(".side").classList).toContain("side-open");
    expect(root.querySelector("c-flow-element-panel")).not.toBeNull();
    toggle.click();
    await flush();
    expect(root.querySelector(".side").classList).not.toContain("side-open");
  });

  it("keeps its scenes while the canvas pans, and rebuilds them for moves", async () => {
    const element = mount({ before: v4.Metadata, after: edited() });
    await flush();
    const [left, right] = element.shadowRoot.querySelectorAll("c-flow-canvas");
    const scenes = [left.scene, right.scene];
    left.dispatchEvent(
      new CustomEvent("viewportchange", { detail: { x: 10, y: 20, zoom: 1 } })
    );
    await flush();
    expect(left.scene).toBe(scenes[0]);
    expect(right.scene).toBe(scenes[1]);

    const moved = [
      ...element.shadowRoot.querySelectorAll("lightning-input")
    ].find((input) => input.label === "Show moved");
    moved.checked = false;
    moved.dispatchEvent(new CustomEvent("change"));
    await flush();
    expect(left.scene).not.toBe(scenes[0]);
  });

  it("steps to the next change and shows its details", async () => {
    const element = mount({ before: v4.Metadata, after: edited() });
    await flush();
    const next = element.shadowRoot.querySelector(
      'lightning-button-icon[title="Next change"]'
    );
    next.click();
    await flush();
    const panel = element.shadowRoot.querySelector("c-flow-element-panel");
    expect(panel).not.toBeNull();
    expect(panel.entry.status).toBe("changed");
    expect(element.shadowRoot.querySelector(".position").textContent).toBe(
      "1 of 1"
    );
  });

  it("steps to an element whose only change is a connector", async () => {
    const element = mount({ before: v3.Metadata, after: v4.Metadata });
    await flush();
    const next = element.shadowRoot.querySelector(
      'lightning-button-icon[title="Next change"]'
    );
    expect(next.disabled).toBe(false);
    next.click();
    await flush();
    const panel = element.shadowRoot.querySelector("c-flow-element-panel");
    expect(panel.entry.key).toBe("loop_matching_templates");
  });

  it("steps on to resources and flow properties, saying where it is", async () => {
    const after = edited();
    after.variables[0].isInput = !after.variables[0].isInput;
    after.description = "Routes cases by region.";
    const element = mount({ before: v4.Metadata, after });
    await flush();
    const position = () =>
      element.shadowRoot.querySelector(".position").textContent;
    const announcement = () =>
      element.shadowRoot.querySelector('[role="status"]').textContent;
    const wrapNotice = () => element.shadowRoot.querySelector(".wrap-notice");
    const next = element.shadowRoot.querySelector(
      'lightning-button-icon[title="Next change"]'
    );
    const previous = element.shadowRoot.querySelector(
      'lightning-button-icon[title="Previous change"]'
    );
    expect(position()).toBe("3 to review");

    next.click();
    await flush();
    expect(announcement()).toBe("1 of 3: Renamed lookup");

    next.click();
    await flush();
    const panel = element.shadowRoot.querySelector("c-flow-element-panel");
    expect(panel.kind).toBe("resource");
    expect(panel.entry.key).toBe("matchFound");
    expect(announcement()).toBe("2 of 3: matchFound, resource");

    next.click();
    await flush();
    const resources = element.shadowRoot.querySelector(
      "c-flow-resources-panel"
    );
    expect(resources.selectedProp).toBe("0");
    expect(announcement()).toBe("3 of 3: Description, flow property");

    next.click();
    await flush();
    expect(announcement()).toBe("1 of 3: Renamed lookup, back to the start");
    expect(wrapNotice().textContent).toBe("Review wrapped, back to the start.");
    previous.click();
    await flush();
    expect(announcement()).toBe(
      "3 of 3: Description, flow property, back to the end"
    );
    expect(wrapNotice().textContent).toBe("Review wrapped, back to the end.");
    previous.click();
    await flush();
    expect(wrapNotice()).toBeNull();
    element.after = edited();
    await flush();
    expect(wrapNotice()).toBeNull();
  });

  it("switches to the XML view from an element", async () => {
    const element = mount({ before: v4.Metadata, after: edited() });
    await flush();
    const canvas = element.shadowRoot.querySelector("c-flow-canvas");
    const id = element.shadowRoot
      .querySelector("c-flow-canvas")
      .scene.nodes.find((node) => node.status === "changed").id;
    canvas.dispatchEvent(new CustomEvent("select", { detail: { id } }));
    await flush();
    const panel = element.shadowRoot.querySelector("c-flow-element-panel");
    panel.dispatchEvent(new CustomEvent("showtext", { detail: { id } }));
    await flush();
    const text = element.shadowRoot.querySelector("c-flow-text-diff");
    expect(text).not.toBeNull();
    expect(text.focusId).toBe(id);
  });

  it("restores linked view, XML layout and element without selecting an unknown id", async () => {
    const id = "recordLookups:Get_Routing";
    const element = mount({
      before: v4.Metadata,
      after: edited(),
      view: "text",
      xmlLayout: "split",
      selectedElement: id
    });
    await flush();
    await flush();
    expect(element.shadowRoot.querySelector("c-flow-text-diff").layout).toBe(
      "split"
    );
    expect(
      element.shadowRoot.querySelector("c-flow-element-panel").entry.id
    ).toBe(id);
    element.selectedElement = "unknown";
    await flush();
    expect(element.shadowRoot.querySelector("c-flow-element-panel")).toBeNull();
    element.selectedElement = id;
    await flush();
    expect(
      element.shadowRoot.querySelector("c-flow-element-panel").entry.id
    ).toBe(id);
  });

  it("publishes XML layout and selection changes for shareable links", async () => {
    const element = mount({
      before: v4.Metadata,
      after: edited(),
      view: "text"
    });
    const views = jest.fn();
    const selections = jest.fn();
    element.addEventListener("viewchange", views);
    element.addEventListener("selectionchange", selections);
    await flush();
    const text = element.shadowRoot.querySelector("c-flow-text-diff");
    text.dispatchEvent(
      new CustomEvent("layoutchange", { detail: { layout: "split" } })
    );
    text.dispatchEvent(
      new CustomEvent("select", { detail: { id: "recordLookups:Get_Routing" } })
    );
    await flush();
    expect(views.mock.calls[0][0].detail).toEqual({
      view: "text",
      layout: "split"
    });
    expect(selections.mock.calls[0][0].detail.id).toBe(
      "recordLookups:Get_Routing"
    );
    element.shadowRoot
      .querySelector("c-flow-element-panel")
      .dispatchEvent(new CustomEvent("close"));
    expect(selections.mock.calls.at(-1)[0].detail.id).toBeUndefined();
  });

  it("says when only the layout differs", async () => {
    const moved = JSON.parse(JSON.stringify(v4.Metadata));
    moved.recordLookups[0].locationX += 200;
    const element = mount({ before: v4.Metadata, after: moved });
    await flush();
    const notice = element.shadowRoot.querySelector(".notice");
    expect(notice && notice.textContent).toMatch(/positions/);
  });
});
