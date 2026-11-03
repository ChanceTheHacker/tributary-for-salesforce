import { createElement } from "lwc";
import FlowPlace from "c/flowPlace";
import { buildModel } from "c/flowModel";
import { createMerge, resolveMerge } from "c/flowMerge";
import { small, branchy } from "fixtures/synthetic";

const model = () =>
  buildModel({
    FullName: "Case_Triage",
    Metadata: require("fixtures/flows/Case_Triage/v1.json").Metadata
  });

function mount(props) {
  const element = createElement("c-flow-place", { is: FlowPlace });
  Object.assign(element, { model: model(), ...props });
  document.body.appendChild(element);
  return element;
}

const flush = () => Promise.resolve();
const $ = (element, selector) => element.shadowRoot.querySelector(selector);

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
});

describe("c-flow-place", () => {
  it("lists elements with paths, Start first, leaving out those excluded", async () => {
    const element = mount({ exclude: ["Escalate"] });
    await flush();
    const values = $(element, "c-flow-picker").options.map(
      (option) => option.value
    );
    expect(values[0]).toBe("$Start");
    expect(values).toContain("Check_Priority");
    expect(values).not.toContain("Escalate");
    expect($(element, "lightning-button").disabled).toBe(true);
  });

  it("defaults to the element's main path and fires place", async () => {
    const element = mount();
    const handler = jest.fn();
    element.addEventListener("place", handler);
    await flush();
    $(element, "c-flow-picker").dispatchEvent(
      new CustomEvent("change", { detail: { value: "Check_Priority" } })
    );
    await flush();
    const slot = $(element, "lightning-combobox");
    expect(slot.value).toBe("defaultConnector");
    const labels = slot.options.map((option) => option.label);
    expect(labels).toContain("High, now to Escalate");
    expect(labels).toContain("Default, not connected");
    slot.dispatchEvent(
      new CustomEvent("change", { detail: { value: "rules.High.connector" } })
    );
    await flush();
    $(element, "lightning-button").click();
    expect(handler.mock.calls[0][0].detail).toEqual({
      afterKey: "Check_Priority",
      slot: "rules.High.connector"
    });
  });

  describe("with a preview", () => {
    const merge = createMerge({ before: small(), after: branchy() });
    const resolved = resolveMerge(merge);
    const preview = (keys, props) =>
      mount({
        model: resolved.model,
        merge,
        resolved,
        picks: {},
        keys,
        side: "after",
        exclude: keys,
        ...props
      });
    const choose = async (element, value) => {
      $(element, "c-flow-picker").dispatchEvent(
        new CustomEvent("change", { detail: { value } })
      );
      await flush();
    };
    const all = (element, selector) => [
      ...element.shadowRoot.querySelectorAll(selector)
    ];

    it("says what placing the group does, and waits for a fault path to be decided", async () => {
      const element = preview(["D", "P1", "P2", "Q1"]);
      const handler = jest.fn();
      element.addEventListener("place", handler);
      await flush();
      expect($(element, ".preview")).toBeNull();
      await choose(element, "A");

      expect($(element, ".entry").textContent).toBe(
        "Goes into D, then on to B."
      );
      const rows = all(element, ".exit");
      const fault = rows.find(
        (row) => row.dataset.id === "wire|P1|faultConnector"
      );
      expect(fault.className).toBe("exit exit-open");
      const pick = fault.querySelector(".exit-pick");
      expect(pick.options.map((option) => option.label)).toEqual([
        "Leave it unhandled",
        "Go on to the same place: B"
      ]);
      const texts = all(element, ".exit-text").map((node) => node.textContent);
      expect(texts).toContain("goes on to B");
      expect(all(element, ".note").map((node) => node.textContent)).toEqual([
        "Brings in 1 resource they use: Rec.",
        "Choose where the marked path goes first."
      ]);
      expect($(element, ".place-button").disabled).toBe(true);

      pick.dispatchEvent(new CustomEvent("change", { detail: { value: "-" } }));
      await flush();
      expect($(element, ".note-open")).toBeNull();
      expect($(element, ".place-button").disabled).toBe(false);
      $(element, ".place-button").click();
      expect(handler.mock.calls[0][0].detail).toEqual({
        afterKey: "A",
        slot: "connector",
        routes: { "wire|P1|faultConnector": "" },
        first: "D"
      });
    });

    it("asks where the path goes in when there's more than one way", async () => {
      const element = preview(["E1", "E2", "M"]);
      await flush();
      await choose(element, "A");
      const entry = $(element, ".entry-pick");
      expect(entry.options.map((option) => option.value)).toEqual(["E1", "E2"]);
      expect(entry.value).toBeUndefined();
      expect($(element, ".note-warning").textContent).toBe(
        "The start won't reach E2."
      );
      expect($(element, ".place-button").disabled).toBe(true);
      entry.dispatchEvent(
        new CustomEvent("change", { detail: { value: "E2" } })
      );
      await flush();
      expect($(element, ".note-warning").textContent).toBe(
        "The start won't reach E1."
      );
      expect($(element, ".place-button").disabled).toBe(false);
    });

    it("warns of a path that would go round", async () => {
      const element = preview(["R"]);
      await flush();
      await choose(element, "B");
      const pick = $(element, ".exit-pick");
      pick.dispatchEvent(new CustomEvent("change", { detail: { value: "A" } }));
      await flush();
      expect($(element, ".note-warning").textContent).toBe(
        "A → B → R → A goes round without a Loop."
      );
    });

    it("names connectors into the group it doesn't bring", async () => {
      const element = preview(["M"]);
      await flush();
      await choose(element, "A");
      expect(all(element, ".note").map((node) => node.textContent)).toContain(
        "Not brought: E1 → M, E2 → M."
      );
    });
  });
});
