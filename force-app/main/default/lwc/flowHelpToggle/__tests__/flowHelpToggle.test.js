import { createElement } from "lwc";
import FlowHelpToggle from "c/flowHelpToggle";
import { helpShown, showHelp } from "c/flowUtils";

const flush = () => Promise.resolve();

function mount() {
  const element = createElement("c-flow-help-toggle", { is: FlowHelpToggle });
  document.body.appendChild(element);
  return element;
}

const toggle = (element) => element.shadowRoot.querySelector("lightning-input");

describe("c-flow-help-toggle", () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    window.localStorage.clear();
  });

  it("starts on", () => {
    expect(toggle(mount()).checked).toBe(true);
  });

  it("turns help videos off and on for every page", () => {
    const element = mount();
    toggle(element).dispatchEvent(
      new CustomEvent("change", { detail: { checked: false } })
    );
    expect(helpShown()).toBe(false);
    toggle(element).dispatchEvent(
      new CustomEvent("change", { detail: { checked: true } })
    );
    expect(helpShown()).toBe(true);
  });

  it("follows help being turned off elsewhere", async () => {
    const element = mount();
    showHelp(false);
    await flush();
    expect(toggle(element).checked).toBe(false);
  });
});
