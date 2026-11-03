import { createElement } from "lwc";
import FlowHelp from "c/flowHelp";
import FlowHelpPlayer from "c/flowHelpPlayer";
import { showHelp } from "c/flowUtils";

jest.mock("../helpTopics", () => ({
  __esModule: true,
  default: {
    merge: {
      title: "Merge two versions",
      action: "merge two versions into one",
      video: "/resource/Help_Merge",
      duration: 74.4,
      steps: [{ at: 0, text: "Pick a side." }]
    }
  }
}));

const flush = () => Promise.resolve();

function mount(props) {
  const element = createElement("c-flow-help", { is: FlowHelp });
  Object.assign(element, props);
  document.body.appendChild(element);
  return element;
}

describe("c-flow-help", () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    window.localStorage.clear();
    FlowHelpPlayer.open.mockClear();
  });

  it("offers the topic's video, saying what it shows and how long it is", () => {
    const element = mount({ topic: "merge" });
    const button = element.shadowRoot.querySelector(
      "lightning-button-icon.help"
    );
    expect(button.tooltip).toBe("Click to watch how to use this");
    expect(button.alternativeText).toBe(
      "Watch how to merge two versions into one (1:14)"
    );
  });

  it("shows a link with the title and length when asked", () => {
    const element = mount({ topic: "merge", variant: "link" });
    const link = element.shadowRoot.querySelector("lightning-button.help-link");
    expect(link.label).toBe("Watch how to merge two versions into one · 1:14");
  });

  it("shows nothing for a topic without a video", () => {
    const element = mount({ topic: "nothing" });
    expect(
      element.shadowRoot.querySelector("lightning-button-icon")
    ).toBeNull();
  });

  it("plays the video in the help player", () => {
    const element = mount({ topic: "merge" });
    element.shadowRoot.querySelector("lightning-button-icon.help").click();
    expect(FlowHelpPlayer.open).toHaveBeenCalledWith(
      expect.objectContaining({
        size: "large",
        label: "Merge two versions",
        topic: expect.objectContaining({ video: "/resource/Help_Merge" })
      })
    );
  });

  it("hides and comes back as help is turned off and on", async () => {
    const element = mount({ topic: "merge" });
    showHelp(false);
    await flush();
    expect(
      element.shadowRoot.querySelector("lightning-button-icon")
    ).toBeNull();
    showHelp(true);
    await flush();
    expect(
      element.shadowRoot.querySelector("lightning-button-icon")
    ).not.toBeNull();
  });

  it("stays hidden on pages opened after help was turned off", () => {
    showHelp(false);
    const element = mount({ topic: "merge" });
    expect(
      element.shadowRoot.querySelector("lightning-button-icon")
    ).toBeNull();
  });
});
