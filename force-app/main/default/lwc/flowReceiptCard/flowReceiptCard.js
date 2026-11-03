/**
 * Shows a save's receipt (from buildReceipt in c/flowReceipt): the
 * candidate's fingerprint, the versions the merge was made from, what was
 * decided and the checks, each saying only what it covers.
 */
import { LightningElement, api } from "lwc";
import { PASSED, WARNED, FAILED, NOT_RUN } from "c/flowReceipt";

const LOOKS = {
  [PASSED]: { icon: "utility:success", variant: "success", text: "Passed" },
  [WARNED]: { icon: "utility:warning", variant: "warning", text: "Warnings" },
  [FAILED]: { icon: "utility:error", variant: "error", text: "Errors" },
  [NOT_RUN]: { icon: "utility:dash", variant: undefined, text: "Not run" }
};
const WAITING = { icon: "utility:clock", variant: undefined, text: "Not yet" };

export default class FlowReceiptCard extends LightningElement {
  /** The receipt; saved once the org has accepted the version. */
  @api receipt;
  @api saved = false;

  get hasSources() {
    return Boolean(this.receipt && this.receipt.sources.length);
  }

  get hasDecisions() {
    return Boolean(this.receipt && this.receipt.decisions.length);
  }

  get decisions() {
    return this.receipt.decisions.map((text, index) => ({
      key: String(index),
      text
    }));
  }

  get checks() {
    return this.receipt.checks.map((check) => {
      const look = LOOKS[check.status] || WAITING;
      return {
        ...check,
        iconName: look.icon,
        variant: look.variant,
        statusText: look.text,
        hasMessages: Boolean(check.messages && check.messages.length),
        messageList: (check.messages || []).map((text, index) => ({
          key: String(index),
          text
        })),
        rowClass: `check check_${check.status}`
      };
    });
  }

  get fingerprintNote() {
    return this.saved
      ? "Checked by the org before saving."
      : "The org works this out again from what's sent and saves only if it matches.";
  }
}
