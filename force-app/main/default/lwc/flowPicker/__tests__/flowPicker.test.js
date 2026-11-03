import { createElement } from "lwc";
import FlowPicker from "c/flowPicker";

const options = [
  {
    label: "Case Email Routing (Case_Email_Routing)",
    value: "Case_Email_Routing"
  },
  {
    label: "Opportunity Close (Opportunity_Close)",
    value: "Opportunity_Close"
  },
  { label: "Lead_Assign", value: "Lead_Assign" }
];

function mount(props = {}) {
  const element = createElement("c-flow-picker", { is: FlowPicker });
  Object.assign(element, { label: "Flow", options, ...props });
  document.body.appendChild(element);
  return element;
}

const flush = () => Promise.resolve();

function type(input, text) {
  input.value = text;
  input.dispatchEvent(new CustomEvent("input"));
}

function key(input, name) {
  const event = new KeyboardEvent("keydown", {
    key: name,
    bubbles: true,
    cancelable: true,
    composed: true
  });
  input.dispatchEvent(event);
  return event;
}

const shown = (element) =>
  [...element.shadowRoot.querySelectorAll(".option-label")].map(
    (label) => label.textContent
  );

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
});

describe("c-flow-picker", () => {
  it("shows the chosen flow and lists every flow when opened", async () => {
    const element = mount({ value: "Opportunity_Close" });
    await flush();
    const input = element.shadowRoot.querySelector("input");
    expect(input.value).toBe("Opportunity Close (Opportunity_Close)");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    input.click();
    await flush();
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(shown(element)).toHaveLength(3);
    // The current flow is where the list starts.
    const active = element.shadowRoot.querySelector(".option-active");
    expect(active.textContent).toContain("Opportunity Close");
    expect(active.getAttribute("aria-selected")).toBe("true");
  });

  it("narrows the list to flows matching every word typed", async () => {
    const element = mount();
    await flush();
    const input = element.shadowRoot.querySelector("input");
    type(input, "email case");
    await flush();
    expect(shown(element)).toEqual(["Case Email Routing (Case_Email_Routing)"]);
    // API names match with spaces for underscores.
    type(input, "lead assign");
    await flush();
    expect(shown(element)).toEqual(["Lead_Assign"]);
    type(input, "nothing like it");
    await flush();
    expect(element.shadowRoot.querySelector(".empty").textContent).toBe(
      "No flows match “nothing like it”"
    );
  });

  it("ranks the whole name ahead of scattered words before Enter selects", async () => {
    const element = mount({
      options: [
        { label: "Case follow up", value: "Case_Follow_Up" },
        { label: "New follow up case", value: "New_Follow_Up_Case" },
        { label: "Follow Up Case", value: "Follow_Up_Case" }
      ]
    });
    const handler = jest.fn();
    element.addEventListener("change", handler);
    const input = element.shadowRoot.querySelector("input");
    type(input, " follow   up case ");
    await flush();
    expect(shown(element)).toEqual([
      "Follow Up Case",
      "New follow up case",
      "Case follow up"
    ]);
    key(input, "Enter");
    expect(handler.mock.calls[0][0].detail.value).toBe("Follow_Up_Case");
  });

  it("picks with the keyboard and fires change from the host", async () => {
    const element = mount();
    const handler = jest.fn();
    element.addEventListener("change", handler);
    await flush();
    const input = element.shadowRoot.querySelector("input");
    type(input, "o");
    await flush();
    // "o" is in all three; ArrowDown moves to the second.
    key(input, "ArrowDown");
    await flush();
    key(input, "Enter");
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.detail.value).toBe("Opportunity_Close");
    expect(event.target).toBe(element);
    expect(input.value).toBe("Opportunity Close (Opportunity_Close)");
    expect(element.shadowRoot.querySelector(".menu")).toBeNull();
  });

  it("keeps keyboard selection valid when options change while open", async () => {
    const element = mount({ noun: "elements" });
    const handler = jest.fn();
    element.addEventListener("change", handler);
    const input = element.shadowRoot.querySelector("input");
    type(input, "");
    key(input, "ArrowUp");
    await flush();
    element.options = [options[2], options[0]];
    await flush();
    expect(
      element.shadowRoot.querySelector(".option-active").textContent
    ).toContain("Lead_Assign");
    element.options = [options[0]];
    await flush();
    expect(element.shadowRoot.textContent).toContain("Matching elements: 1");
    key(input, "Enter");
    expect(handler.mock.calls[0][0].detail.value).toBe("Case_Email_Routing");
    input.click();
    element.options = [];
    await flush();
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("picks with a click and keeps focus through it", async () => {
    const element = mount();
    const handler = jest.fn();
    element.addEventListener("change", handler);
    await flush();
    element.shadowRoot.querySelector("input").click();
    await flush();
    const down = new CustomEvent("mousedown", {
      bubbles: true,
      cancelable: true
    });
    const option = element.shadowRoot.querySelectorAll(".option")[2];
    option.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    option.click();
    expect(handler.mock.calls[0][0].detail.value).toBe("Lead_Assign");
  });

  it("closes on Escape without letting a dialog see the key", async () => {
    const element = mount({ value: "Lead_Assign" });
    const outside = jest.fn();
    document.body.addEventListener("keydown", outside);
    await flush();
    const input = element.shadowRoot.querySelector("input");
    type(input, "case");
    await flush();
    key(input, "Escape");
    await flush();
    expect(element.shadowRoot.querySelector(".menu")).toBeNull();
    expect(input.value).toBe("Lead_Assign");
    expect(outside).not.toHaveBeenCalled();
    // Closed, Escape passes through.
    key(input, "Escape");
    expect(outside).toHaveBeenCalledTimes(1);
    document.body.removeEventListener("keydown", outside);
  });

  it("searches each option's text once, not on every key", async () => {
    let reads = 0;
    const many = Array.from({ length: 200 }, (_, index) => ({
      get label() {
        reads += 1;
        return `Element ${index}`;
      },
      value: `Element_${index}`
    }));
    const element = mount({ options: many, noun: "elements" });
    await flush();
    const input = element.shadowRoot.querySelector("input");
    type(input, "element 1");
    await flush();
    reads = 0;
    for (let i = 0; i < 5; i++) {
      key(input, "ArrowDown");
      // eslint-disable-next-line no-await-in-loop
      await flush();
    }
    expect(element.shadowRoot.querySelector(".option-active").textContent).toBe(
      "Element 14"
    );
    // Only the options moved onto are made again.
    expect(reads).toBeLessThan(20);
  });

  it("lists a long menu a page at a time, keeping every option in reach", async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      label: `Element ${index}`,
      value: `Element_${index}`
    }));
    const element = mount({ options: many, noun: "elements" });
    await flush();
    const input = element.shadowRoot.querySelector("input");
    input.click();
    await flush();
    const listed = () => element.shadowRoot.querySelectorAll(".option");
    expect(listed()).toHaveLength(50);
    // Each option says where it is in the whole list, and the end says more.
    expect(listed()[0].getAttribute("aria-setsize")).toBe("120");
    expect(listed()[49].getAttribute("aria-posinset")).toBe("50");
    expect(element.shadowRoot.querySelector(".more").textContent).toContain(
      "Showing 1–50 of 120"
    );
    // The keyboard reaches the last option, listed with its page to be named.
    key(input, "ArrowUp");
    await flush();
    const active = element.shadowRoot.querySelector(".option-active");
    expect(active.textContent).toBe("Element 119");
    expect(input.getAttribute("aria-activedescendant")).toBe(active.id);
    expect(listed()).toHaveLength(20);
    expect(element.shadowRoot.querySelector(".earlier").textContent).toContain(
      "100 before these"
    );
    // Typing starts again from the top of what matches.
    type(input, "element");
    await flush();
    expect(listed()).toHaveLength(50);
    // Scrolling near the end, or clicking the note, shows more.
    element.shadowRoot
      .querySelector(".menu")
      .dispatchEvent(new CustomEvent("scroll"));
    await flush();
    expect(listed()).toHaveLength(100);
    element.shadowRoot.querySelector(".more").click();
    await flush();
    expect(listed()).toHaveLength(120);
    expect(element.shadowRoot.querySelector(".more")).toBeNull();
  });

  it("opens a long menu at the chosen option, however far down", async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      label: `Element ${index}`,
      value: `Element_${index}`
    }));
    const element = mount({ options: many, value: "Element_80" });
    await flush();
    const input = element.shadowRoot.querySelector("input");
    input.click();
    await flush();
    const active = element.shadowRoot.querySelector(".option-active");
    expect(active.textContent).toBe("Element 80");
    expect(input.getAttribute("aria-activedescendant")).toBe(active.id);
    // Its page is listed, not every option before it; those are a scroll away.
    const listed = () => element.shadowRoot.querySelectorAll(".option");
    expect(listed()).toHaveLength(50);
    expect(listed()[0].getAttribute("aria-posinset")).toBe("51");
    element.shadowRoot.querySelector(".earlier").click();
    await flush();
    expect(listed()).toHaveLength(100);
    expect(element.shadowRoot.querySelector(".earlier")).toBeNull();
  });

  it("never lists more than a few pages of a very long menu", async () => {
    const many = Array.from({ length: 1000 }, (_, index) => ({
      label: `Element ${index}`,
      value: `Element_${index}`
    }));
    const element = mount({ options: many, value: "Element_999" });
    await flush();
    const input = element.shadowRoot.querySelector("input");
    input.click();
    await flush();
    const listed = () => element.shadowRoot.querySelectorAll(".option");
    expect(listed()).toHaveLength(50);
    // Round to the top, then scroll all the way down.
    key(input, "ArrowDown");
    await flush();
    expect(listed()[0].textContent).toBe("Element 0");
    expect(listed()).toHaveLength(50);
    const menu = element.shadowRoot.querySelector(".menu");
    for (let page = 1; page < 20; page++) {
      menu.dispatchEvent(new CustomEvent("scroll"));
      // eslint-disable-next-line no-await-in-loop
      await flush();
      expect(listed().length).toBeLessThanOrEqual(150);
    }
    expect(listed()[listed().length - 1].textContent).toBe("Element 999");
  });

  it("stays shut when disabled", async () => {
    const element = mount({ disabled: true });
    await flush();
    const input = element.shadowRoot.querySelector("input");
    expect(input.disabled).toBe(true);
    key(input, "ArrowDown");
    await flush();
    expect(element.shadowRoot.querySelector(".menu")).toBeNull();
  });
});
