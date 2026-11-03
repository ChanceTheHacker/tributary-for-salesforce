import { createElement } from "lwc";
import FlowResourcesPanel from "c/flowResourcesPanel";
import { buildModel } from "c/flowModel";
import { diffFlows } from "c/flowDiff";
import { createMerge, resolveMerge } from "c/flowMerge";
import { resourceInfo, formatValue } from "c/flowElements";

// Counts how often resources and values are worked out for display.
jest.mock("c/flowElements", () => {
  const actual = jest.requireActual("c/flowElements");
  return {
    ...actual,
    resourceInfo: jest.fn(actual.resourceInfo),
    formatValue: jest.fn(actual.formatValue)
  };
});

const source = require("fixtures/flows/Case_Email_Routing/v4.json");
const before = buildModel(source);
const metadata = JSON.parse(JSON.stringify(source.Metadata));
metadata.variables.push({ name: "extra", dataType: "String", isInput: false });
metadata.description = "Now documented";
const after = buildModel(metadata);
const diff = diffFlows(before, after);

function mount(props) {
  const element = createElement("c-flow-resources-panel", {
    is: FlowResourcesPanel
  });
  Object.assign(element, props);
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
});

describe("c-flow-resources-panel", () => {
  it("lists changed resources and property changes", async () => {
    const element = mount({ diff, labels: { before: "A", after: "B" } });
    const handler = jest.fn();
    element.addEventListener("select", handler);
    await Promise.resolve();
    const rows = element.shadowRoot.querySelectorAll(".resource");
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".name").textContent).toBe("extra");
    rows[0].click();
    expect(handler.mock.calls[0][0].detail).toEqual({
      kind: "resource",
      id: "variables:extra"
    });
    const prop = element.shadowRoot.querySelector(".props tbody tr");
    expect(prop.querySelector(".after").textContent).toBe("Now documented");
  });

  it("shows every resource when asked", async () => {
    const element = mount({ diff });
    await Promise.resolve();
    const toggle = element.shadowRoot.querySelector("lightning-input");
    toggle.checked = false;
    toggle.dispatchEvent(new CustomEvent("change"));
    await Promise.resolve();
    expect(element.shadowRoot.querySelectorAll(".resource")).toHaveLength(
      diff.resources.length
    );
  });

  it("picks flow properties in a merge", async () => {
    const merge = createMerge({ before, after });
    const resolved = resolveMerge(merge, {});
    const element = mount({ diff, merge, resolved });
    const handler = jest.fn();
    element.addEventListener("pick", handler);
    await Promise.resolve();
    const radios = element.shadowRoot.querySelectorAll("input[type=radio]");
    expect(radios).toHaveLength(2);
    radios[1].dispatchEvent(new CustomEvent("change"));
    expect(handler.mock.calls[0][0].detail.picks).toEqual({
      "prop|description": "after"
    });
  });

  it("combines or edits description conflicts without changing the sources", async () => {
    const sides = {
      base: { ...metadata, description: "Original" },
      ours: { ...metadata, description: "First change" },
      theirs: { ...metadata, description: "Second change" }
    };
    const merge = createMerge(sides);
    const element = mount({
      diff: diffFlows(sides.ours, sides.theirs),
      merge,
      resolved: resolveMerge(merge)
    });
    element.addEventListener("pick", (event) => {
      element.resolved = resolveMerge(merge, event.detail.picks);
    });
    await Promise.resolve();
    const buttons = [
      ...element.shadowRoot.querySelectorAll("lightning-button")
    ];
    buttons.find((button) => button.label === "Combine both versions").click();
    await Promise.resolve();
    expect(element.resolved.metadata.description).toBe(
      "First change\nSecond change"
    );
    expect(element.resolved.conflicts).not.toContain("prop|description");
    expect(
      element.shadowRoot.querySelector(".custom-text").textContent
    ).toContain("First change");
    const editor = element.shadowRoot.querySelector("lightning-textarea");
    editor.value = "Reviewed together";
    editor.dispatchEvent(new CustomEvent("change"));
    await Promise.resolve();
    buttons.find((button) => button.label === "Use edited text").click();
    await Promise.resolve();
    expect(element.resolved.metadata.description).toBe("Reviewed together");
    expect(sides.ours.description).toBe("First change");
    element.shadowRoot
      .querySelector('input[data-side="theirs"]')
      .dispatchEvent(new CustomEvent("change"));
    await Promise.resolve();
    expect(element.resolved.metadata.description).toBe("Second change");
    expect(element.shadowRoot.querySelector(".custom-text")).toBeNull();
  });

  it("marks a selected resource without listing them all again", async () => {
    const element = mount({ diff });
    await Promise.resolve();
    const toggle = element.shadowRoot.querySelector("lightning-input");
    toggle.checked = false;
    toggle.dispatchEvent(new CustomEvent("change"));
    await Promise.resolve();
    resourceInfo.mockClear();
    formatValue.mockClear();
    element.selectedId = "variables:extra";
    await Promise.resolve();
    const selected = element.shadowRoot.querySelectorAll(".resource.selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.id).toBe("variables:extra");
    expect(resourceInfo).not.toHaveBeenCalled();
    expect(formatValue).not.toHaveBeenCalled();
  });
});
