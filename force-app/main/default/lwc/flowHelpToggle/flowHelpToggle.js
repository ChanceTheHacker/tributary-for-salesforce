import { LightningElement } from "lwc";
import { HELP_EVENT, helpShown, showHelp } from "c/flowUtils";

/** Turns the help videos' buttons on or off on every Tributary page. */
export default class FlowHelpToggle extends LightningElement {
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

  handleChange(event) {
    showHelp(event.detail.checked);
  }
}
