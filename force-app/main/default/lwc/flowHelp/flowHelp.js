import { LightningElement, api } from "lwc";
import FlowHelpPlayer from "c/flowHelpPlayer";
import { HELP_EVENT, helpShown } from "c/flowUtils";
import TOPICS from "./helpTopics";

/**
 * A small button beside a feature that plays a short video of how to use
 * it. Topics and their videos are in helpTopics.js; a topic without a video
 * shows nothing, and neither does anything once help videos are turned off.
 * variant="link" shows the topic's title and length as a link instead.
 */
export default class FlowHelp extends LightningElement {
  @api topic;
  @api variant = "icon";
  on = helpShown();

  connectedCallback() {
    this.listener = (event) => {
      this.on = event.detail.on;
    };
    window.addEventListener(HELP_EVENT, this.listener);
  }

  disconnectedCallback() {
    window.removeEventListener(HELP_EVENT, this.listener);
  }

  get entry() {
    return TOPICS[this.topic];
  }

  get visible() {
    return this.on && Boolean(this.entry);
  }

  get isLink() {
    return this.variant === "link";
  }

  get altText() {
    return `Watch how to ${this.entry.action} (${this.length})`;
  }

  get linkLabel() {
    return `Watch how to ${this.entry.action} · ${this.length}`;
  }

  get length() {
    const seconds = Math.round(this.entry.duration);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  handleOpen() {
    FlowHelpPlayer.open({
      size: "large",
      label: this.entry.title,
      description: `A video, without sound, of how to ${this.entry.action}.`,
      topic: this.entry
    });
  }
}
