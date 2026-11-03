import { createElement } from "lwc";
import FlowMappingPanel from "c/flowMappingPanel";
import { planMapping, suggestedChoices, translateFlow } from "c/flowMapping";
import { buildModel } from "c/flowModel";

const flow = (name) =>
  buildModel(
    JSON.parse(JSON.stringify(require(`fixtures/flows/${name}/v1.json`)))
  );

function setup(choices) {
  const target = flow("Case_Triage");
  const source = flow("Case_Helper");
  const plan = planMapping(target, source);
  const chosen = choices || suggestedChoices(plan);
  const { model, notes, issues } = translateFlow(target, source, chosen, plan);
  return { plan, choices: chosen, notes, issues, resolved: { model } };
}

function mount(props) {
  const element = createElement("c-flow-mapping-panel", {
    is: FlowMappingPanel
  });
  Object.assign(element, setup(), props);
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

describe("c-flow-mapping-panel", () => {
  it("lists what the other flow uses with the suggested mapping", async () => {
    const element = mount();
    await flush();
    expect($(element, ".intro").textContent).toMatch(
      /Case Helper is a different flow/
    );
    const names = $$(element, ".root-name").map((name) => name.textContent);
    expect(names).toEqual(expect.arrayContaining(["recordId", "Get_Case"]));
    const picks = $$(element, ".root-pick");
    const recordId = picks.find((pick) => pick.dataset.key === "recordid");
    expect(recordId.value).toBe("to:$Record.Id");
    expect(
      recordId.options.some((option) => /\(suggested\)/.test(option.label))
    ).toBe(true);
    expect(recordId.options.at(-1).value).toBe("create");
    // Escalate is in both flows, doing more in the other: keep both.
    expect($(element, ".element-pick").value).toBe("both");
    expect($(element, ".element-text .root-detail").textContent).toMatch(
      /different in each/
    );
    expect(
      $$(element, ".notes li").map((line) => line.textContent)
    ).toContainEqual(
      expect.stringMatching(/^Mapped: .*recordId → \$Record\.Id/)
    );
  });

  it("brings a name in as a new variable, checking the name", async () => {
    const element = mount();
    const handler = jest.fn();
    element.addEventListener("mappingchange", handler);
    await flush();
    const pick = $$(element, ".root-pick").find(
      (item) => item.dataset.key === "recordid"
    );
    pick.dispatchEvent(
      new CustomEvent("change", { detail: { value: "create" } })
    );
    const choices = handler.mock.calls[0][0].detail.choices;
    expect(choices.roots.recordid).toEqual({ create: "recordId" });
    expect(choices.elements.escalate).toBe("both");

    element.choices = {
      ...choices,
      roots: { ...choices.roots, recordid: { create: "2bad" } }
    };
    await flush();
    const input = $(element, ".root-name-input");
    expect(input.value).toBe("2bad");
    expect($(element, ".root-error").textContent).toMatch(
      /starting with a letter/
    );
    input.value = "caseId";
    input.dispatchEvent(new CustomEvent("change"));
    expect(handler.mock.calls[1][0].detail.choices.roots.recordid).toEqual({
      create: "caseId"
    });
  });

  it("makes an element one, resets and places", async () => {
    const element = mount();
    const change = jest.fn();
    const place = jest.fn();
    element.addEventListener("mappingchange", change);
    element.addEventListener("place", place);
    await flush();
    $(element, ".element-pick").dispatchEvent(
      new CustomEvent("change", { detail: { value: "one" } })
    );
    expect(change.mock.calls[0][0].detail.choices.elements.escalate).toBe(
      "one"
    );
    $(element, "lightning-button.reset").click();
    expect(change.mock.calls[1][0].detail.choices).toBeUndefined();

    const placer = $(element, "c-flow-place");
    expect(placer.label).toBe("Put Case Helper after");
    expect(placer.hint).toMatch(/starting at Route/);
    placer.dispatchEvent(
      new CustomEvent("place", {
        detail: { afterKey: "Check_Priority", slot: "defaultConnector" }
      })
    );
    expect(place.mock.calls[0][0].detail).toEqual({
      afterKey: "Check_Priority",
      slot: "defaultConnector"
    });
  });

  it("says why a mapping was offered and waits for one offered by name", async () => {
    const element = mount();
    const handler = jest.fn();
    element.addEventListener("mappingchange", handler);
    await flush();
    const row = (key) =>
      $$(element, ".root").find((item) => item.dataset.key === key);
    // The lookup is taken to be the triggering case by what it gets.
    expect(row("get_case").querySelector(".root-why").textContent).toMatch(
      /^Why: .*taken to be the one this flow starts from/
    );
    expect(row("get_case").querySelector(".root-keep")).toBeNull();
    // recordId is only named like the case's ID.
    const recordId = row("recordid");
    expect(recordId.querySelector(".root-why").textContent).toMatch(
      /named like a record ID/
    );
    expect(recordId.querySelector(".root-warning").textContent).toMatch(
      /only because of its name/
    );
    const pick = recordId.querySelector(".root-pick");
    pick.focus = jest.fn();
    recordId.querySelector(".root-keep").click();
    const choices = handler.mock.calls[0][0].detail.choices;
    expect(choices.roots.recordid).toEqual({ to: "$Record.Id" });

    Object.assign(element, setup(choices));
    await flush();
    expect(row("recordid").querySelector(".root-keep")).toBeNull();
    expect(row("recordid").querySelector(".root-warning")).toBeNull();
    expect(row("recordid").className).toBe("root");
    expect(pick.focus).toHaveBeenCalled();
    expect($(element, '[role="status"]').textContent).toContain(
      "Kept recordId mapped to $Record.Id"
    );
  });

  it("marks a mapping that can't work and focuses it on request", async () => {
    const base = setup();
    const choices = {
      ...base.choices,
      roots: { ...base.choices.roots, recordid: { to: "No_Such" } }
    };
    const element = mount(setup(choices));
    await flush();
    const recordId = $$(element, ".root").find(
      (item) => item.dataset.key === "recordid"
    );
    expect(recordId.className).toBe("root root-bad");
    expect(recordId.querySelector(".root-error").textContent).toMatch(
      /No_Such, which Case Triage doesn't have/
    );
    const pick = recordId.querySelector(".root-pick");
    pick.focus = jest.fn();
    element.focusRow("recordid");
    expect(pick.focus).toHaveBeenCalled();
    element.focusRow("gone");
  });
});
