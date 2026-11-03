import { createElement } from "lwc";
import FlowConnect from "c/flowConnect";
import { buildModel } from "c/flowModel";

const resolved = () => ({
  model: buildModel({
    FullName: "Case_Triage",
    Metadata: require("fixtures/flows/Case_Triage/v1.json").Metadata
  })
});

function mount(props) {
  const element = createElement("c-flow-connect", { is: FlowConnect });
  Object.assign(element, { resolved: resolved(), ...props });
  document.body.appendChild(element);
  return element;
}

const flush = () => Promise.resolve();
const $$ = (element, selector) => [
  ...element.shadowRoot.querySelectorAll(selector)
];

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
});

describe("c-flow-connect", () => {
  it("shows where each connector goes and sends it elsewhere", async () => {
    const element = mount({ nodeKey: "Check_Priority" });
    const handler = jest.fn();
    element.addEventListener("pick", handler);
    await flush();
    const pickers = $$(element, "c-flow-picker");
    expect(pickers.map((picker) => picker.label)).toEqual(["High", "Default"]);
    expect(pickers.map((picker) => picker.value)).toEqual(["Escalate", ""]);
    // Anywhere in the flow but the start, or nowhere.
    const values = pickers[1].options.map((option) => option.value);
    expect(values[0]).toBe("");
    expect(values).not.toContain("$Start");
    // Nor the element itself: a path straight back to it is a mistake.
    expect(values).not.toContain("Check_Priority");
    expect(values).toContain("Escalate");
    pickers[1].dispatchEvent(
      new CustomEvent("change", { detail: { value: "Escalate" } })
    );
    expect(handler.mock.calls[0][0].detail.picks).toEqual({
      "wire|Check_Priority|defaultConnector": "Escalate"
    });
  });

  it("offers to undo a rewired connector", async () => {
    const element = mount({
      nodeKey: "Check_Priority",
      picks: { "wire|Check_Priority|rules.High.connector": "" }
    });
    const handler = jest.fn();
    element.addEventListener("pick", handler);
    await flush();
    expect($$(element, ".tag")).toHaveLength(1);
    $$(element, "lightning-button.undo")[0].click();
    expect(handler.mock.calls[0][0].detail.picks).toEqual({
      "wire|Check_Priority|rules.High.connector": null
    });
  });

  it("keeps the target list while only the picks change", async () => {
    const element = mount({ nodeKey: "Check_Priority" });
    await flush();
    const options = $$(element, "c-flow-picker")[0].options;
    element.picks = { "wire|Check_Priority|rules.High.connector": "" };
    await flush();
    const pickers = $$(element, "c-flow-picker");
    expect($$(element, ".tag")).toHaveLength(1);
    // The same list, so a picker doesn't search it anew.
    expect(pickers[0].options).toBe(options);
    expect(pickers[1].options).toBe(options);
    // A different flow is a different list.
    element.resolved = resolved();
    await flush();
    expect($$(element, "c-flow-picker")[0].options).not.toBe(options);
  });
});
