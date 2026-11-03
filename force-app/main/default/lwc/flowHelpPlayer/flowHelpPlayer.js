import { api } from "lwc";
import LightningModal from "lightning/modal";
import { showHelp } from "c/flowUtils";

const clock = (seconds) => {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/**
 * Plays a help topic's video with its steps: the current step's text over
 * the video, and every step in a list that jumps the video to it and
 * doubles as a transcript.
 */
export default class FlowHelpPlayer extends LightningModal {
  // { title, action, video, duration, steps: [{ at, text }] }
  @api topic;
  current = 0;

  // The muted attribute only mutes a video it was parsed with; set after
  // the element exists, as a template does, it doesn't, and the browser
  // then won't start the video by itself.
  renderedCallback() {
    if (!this.started) {
      this.started = true;
      this.refs.video.muted = true;
    }
  }

  get title() {
    return this.topic.title;
  }

  get caption() {
    return this.topic.steps[this.current]?.text || "";
  }

  get stepLabel() {
    return `Step ${this.current + 1} of ${this.topic.steps.length}`;
  }

  get steps() {
    return this.topic.steps.map((step, index) => ({
      key: String(index),
      index,
      number: index + 1,
      text: step.text,
      time: clock(step.at),
      current: index === this.current ? "step" : undefined,
      className: index === this.current ? "step step-current" : "step"
    }));
  }

  handleTime(event) {
    const time = event.target.currentTime;
    const steps = this.topic.steps;
    let index = 0;
    while (index + 1 < steps.length && steps[index + 1].at <= time) {
      index += 1;
    }
    this.current = index;
  }

  handleStep(event) {
    const index = Number(event.currentTarget.dataset.index);
    const video = this.refs.video;
    this.current = index;
    video.currentTime = this.topic.steps[index].at;
    video.play()?.catch(() => {
      // Playing can be refused; the video still shows the step.
    });
  }

  handleTurnOff() {
    showHelp(false);
    this.close("off");
  }

  handleClose() {
    this.close();
  }
}
