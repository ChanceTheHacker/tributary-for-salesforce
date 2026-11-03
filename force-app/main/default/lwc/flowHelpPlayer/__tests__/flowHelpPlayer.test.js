import { createElement } from "lwc";
import FlowHelpPlayer from "c/flowHelpPlayer";
import { helpShown } from "c/flowUtils";

const TOPIC = {
  title: "Merge two versions",
  action: "merge two versions into one",
  video: "/resource/Help_Merge",
  duration: 20,
  steps: [
    { at: 0, text: "Open Merge." },
    { at: 4.2, text: "Click a conflict." },
    { at: 71, text: "Save." }
  ]
};

const flush = () => Promise.resolve();

function mount() {
  const element = createElement("c-flow-help-player", { is: FlowHelpPlayer });
  element.topic = TOPIC;
  document.body.appendChild(element);
  return element;
}

const video = (element) => element.shadowRoot.querySelector("video");
const caption = (element) =>
  element.shadowRoot.querySelector(".caption").textContent;
const steps = (element) => [
  ...element.shadowRoot.querySelectorAll("ol.steps button")
];

// jsdom has no media playback.
function playable(element) {
  const media = video(element);
  let time = 0;
  Object.defineProperty(media, "currentTime", {
    get: () => time,
    set: (value) => {
      time = value;
    }
  });
  media.play = jest.fn(() => Promise.resolve());
  return media;
}

describe("c-flow-help-player", () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    window.localStorage.clear();
  });

  it("plays the video muted, with the first step over it", () => {
    const element = mount();
    expect(video(element).getAttribute("src")).toBe("/resource/Help_Merge");
    expect(video(element).muted).toBe(true);
    expect(caption(element)).toContain("Step 1 of 3");
    expect(caption(element)).toContain("Open Merge.");
  });

  it("lists every step with when it starts", () => {
    const element = mount();
    expect(steps(element).map((step) => step.textContent)).toEqual([
      "1Open Merge.0:00",
      "2Click a conflict.0:04",
      "3Save.1:11"
    ]);
    expect(steps(element)[0].getAttribute("aria-current")).toBe("step");
  });

  it("follows the video from step to step", async () => {
    const element = mount();
    const media = playable(element);
    media.currentTime = 5;
    media.dispatchEvent(new CustomEvent("timeupdate"));
    await flush();
    expect(caption(element)).toContain("Step 2 of 3");
    expect(caption(element)).toContain("Click a conflict.");
    expect(steps(element)[1].getAttribute("aria-current")).toBe("step");
    expect(steps(element)[0].getAttribute("aria-current")).toBeNull();
  });

  it("jumps to a step that's clicked", async () => {
    const element = mount();
    const media = playable(element);
    steps(element)[2].click();
    await flush();
    expect(media.currentTime).toBe(71);
    expect(media.play).toHaveBeenCalled();
    expect(caption(element)).toContain("Save.");
  });

  it("turns help videos off and closes", () => {
    const element = mount();
    const closed = jest.fn();
    element.addEventListener("close", closed);
    element.shadowRoot.querySelector("lightning-button.turn-off").click();
    expect(helpShown()).toBe(false);
    expect(closed.mock.calls[0][0].detail).toBe("off");
  });

  it("closes", () => {
    const element = mount();
    const closed = jest.fn();
    element.addEventListener("close", closed);
    element.shadowRoot.querySelector("lightning-button.close").click();
    expect(closed).toHaveBeenCalled();
    expect(helpShown()).toBe(true);
  });
});
