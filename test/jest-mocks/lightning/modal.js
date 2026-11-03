// sfdx-lwc-jest has no lightning/modal stub. open() is a mock each test can
// inspect; close() reports what the modal was closed with.
import { LightningElement, api } from "lwc";

export default class LightningModal extends LightningElement {
  static open = jest.fn(() => Promise.resolve());
  @api label;
  @api size;
  @api description;
  @api disableClose;

  close(result) {
    this.dispatchEvent(new CustomEvent("close", { detail: result }));
  }
}
