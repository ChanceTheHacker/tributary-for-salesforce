/**
 * Saves merged flow metadata as a new version of an existing flow or as a
 * new flow, in any connected org the user may save to, then offers to open
 * it in Flow Builder, to compare it and to activate it (or request
 * activation).
 *
 * Before saving it shows the receipt: the fingerprint of the exact flow to
 * be saved, what the merge was made from, what was decided and what was
 * checked. The org saves only that flow, and nothing at all if a source has
 * changed or a newer version was saved since the merge was compared; then
 * the dialog says why and offers to compare again.
 *
 * Events: saved { result, connection, label, receipt }, activated
 * { connection, apiName }, recompare, close. A save still running when the
 * dialog closes finishes in the background: it still sends saved, and a
 * failure shows as a toast.
 */
import { LightningElement, api, wire } from "lwc";
import { CurrentPageReference, NavigationMixin } from "lightning/navigation";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import saveVersion from "@salesforce/apex/FlowCompareController.saveVersion";
import saveAsNewFlow from "@salesforce/apex/FlowCompareController.saveAsNewFlow";
import { errorText, focusModalEnd, compareRef } from "c/flowUtils";
import {
  sha256,
  buildReceipt,
  receiptChecks,
  receiptText
} from "c/flowReceipt";
import { governanceChange } from "c/flowGovernanceCache";

const NEW_VERSION = "version";
const NEW_FLOW = "flow";
const API_NAME = /^(?!.*__)[A-Za-z](?:[A-Za-z0-9_]{0,78}[A-Za-z0-9])?$/;

// The last fingerprint worked out: the receipt is drawn on every render,
// the flow it describes changes far less often.
let digested = { text: undefined, hash: undefined };
function fingerprint(text) {
  if (digested.text !== text) {
    digested = { text, hash: sha256(text) };
  }
  return digested.hash;
}

export default class FlowSaveDialog extends NavigationMixin(LightningElement) {
  /** Connections from listConnections. */
  @api connections = [];
  /** Flow metadata to save. */
  @api metadata;
  /**
   * One-line description of the merge, for activation requests when the
   * org doesn't send back the receipt it kept.
   */
  @api changeSummary;
  /**
   * What was reviewed: { sources, decisions, checks } for buildReceipt in
   * c/flowReceipt. Sources with a version id and its last-modified time are
   * checked unchanged when saving.
   */
  @api review;
  /**
   * Flows the version can be added to:
   * [{ connection, apiName, label, activeVersion, latestVersion }].
   * latestVersion is the newest version when the merge was compared: saving
   * refuses to add one after a newer version the merge left out.
   */
  @api targets = [];
  /** What's being saved, for the heading: "visual merge" or "XML merge". */
  @api source;
  /**
   * Names the metadata being saved. The saved event hands it back, so the
   * merge can tell whether it has changed since.
   */
  @api saveKey;

  target = NEW_VERSION;
  targetIndex = "0";
  connection;
  newApiName = "";
  newLabel = "";
  // Saved as the version's own description.
  description = "";
  busy = false;
  error;
  // Why the org refused to save: what changed since the merge was compared.
  stale;
  result;
  // The receipt as it was when the version was saved.
  savedReceipt;
  savedConnection;
  savedApiName;
  savedLabel;
  savedActiveVersion;
  // Whether the saved version was activated from here.
  savedActivated = false;
  _open = false;
  // Bumped whenever the dialog opens or a save starts: a save finishing
  // after either belongs to an earlier dialog and doesn't show here.
  _operation = 0;
  // Saves still running; the dialog can't start another until they finish.
  _inFlight = 0;
  _focusOnRender = false;

  @wire(CurrentPageReference)
  pageRef;

  @api
  get open() {
    return this._open;
  }
  set open(value) {
    const opening = Boolean(value) && !this._open;
    this._open = Boolean(value);
    if (opening) {
      this.reset();
      this._focusOnRender = true;
    }
  }

  // On opening, the first choice; once saved, the dialog itself, whose
  // status line is read out.
  renderedCallback() {
    if (this._focusOnRender) {
      this._focusOnRender = false;
      const dialog = this.template.querySelector("section");
      const first =
        this.notSaved &&
        this.template.querySelector(".slds-modal__content .first");
      if (first) {
        first.focus();
      }
      // Focus stays in the dialog even if the field doesn't take it.
      if (dialog && !this.template.activeElement) {
        dialog.focus();
      }
    }
  }

  reset() {
    this._operation += 1;
    this.result = undefined;
    this.savedReceipt = undefined;
    this.savedActivated = false;
    this.error = undefined;
    this.stale = undefined;
    this.busy = this._inFlight > 0;
    this.targetIndex = "0";
    this.target = this.targetOptions.length ? NEW_VERSION : NEW_FLOW;
    const saveable = (this.connections || []).filter((c) => c.canSave);
    this.connection = saveable.length ? saveable[0].name : undefined;
    const label = this.metadata && this.metadata.label;
    this.description = (this.metadata && this.metadata.description) || "";
    this.newLabel = label ? `${label} (merged)` : "";
    this.newApiName = this.newLabel
      ? this.newLabel.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
      : "";
    if (this.newApiName && !/^[A-Za-z]/.test(this.newApiName)) {
      this.newApiName = `Flow_${this.newApiName}`;
    }
    this.newApiName = this.newApiName.slice(0, 80).replace(/_+$/, "");
  }

  get targetOptions() {
    return (this.targets || []).map((target, index) => ({
      label: `New version of ${target.label || target.apiName} (${this.connectionLabel(target.connection)})`,
      value: String(index)
    }));
  }

  get kindOptions() {
    const options = [];
    if (this.targetOptions.length) {
      options.push({ label: "New version of a flow", value: NEW_VERSION });
    }
    options.push({ label: "New flow", value: NEW_FLOW });
    return options;
  }

  get connectionOptions() {
    return (this.connections || [])
      .filter((connection) => connection.canSave)
      .map((connection) => ({
        label: connection.label,
        value: connection.name
      }));
  }

  connectionLabel(name) {
    const found = (this.connections || []).find((c) => c.name === name);
    return found ? found.label : name;
  }

  get isNewVersion() {
    return this.target === NEW_VERSION;
  }

  get isNewFlow() {
    return this.target === NEW_FLOW;
  }

  get chosenTarget() {
    return (this.targets || [])[Number(this.targetIndex)];
  }

  // The org Save writes to: the chosen flow's, or the one picked for a new flow.
  get destination() {
    const name = this.isNewVersion
      ? this.chosenTarget && this.chosenTarget.connection
      : this.connection;
    return (this.connections || []).find((c) => c.name === name);
  }

  get targetWarning() {
    const connection = this.destination;
    if (!connection) {
      return "The destination org is no longer available. Refresh the connections before saving.";
    }
    if (!connection.canSave) {
      return `You can't save flows to ${connection.label}.`;
    }
    if (connection && connection.isProduction) {
      return `${connection.label} is a production org. Review the merged flow before anyone activates it.`;
    }
    return undefined;
  }

  get saveDisabled() {
    if (
      this.busy ||
      this.stale ||
      !this.destination ||
      !this.destination.canSave
    ) {
      return true;
    }
    if (this.isNewVersion) {
      return !this.chosenTarget;
    }
    return !API_NAME.test(this.newApiName || "");
  }

  get apiNameError() {
    return this.newApiName && !API_NAME.test(this.newApiName)
      ? "Use up to 80 letters, numbers and single underscores, starting with a letter and not ending with an underscore."
      : undefined;
  }

  get heading() {
    return this.source ? `Save ${this.source}` : "Save merged flow";
  }

  get saveLabel() {
    return this.busy ? "Saving…" : "Save";
  }

  // Closing doesn't stop a save, so the button doesn't say it does.
  get cancelLabel() {
    return this.busy ? "Close" : "Cancel";
  }

  get savedOrgLabel() {
    return this.connectionLabel(this.savedConnection);
  }

  get saved() {
    return Boolean(this.result);
  }

  get notSaved() {
    return !this.result;
  }

  get resultText() {
    const { result } = this;
    const name = this.savedLabel || result.apiName;
    const state = this.savedActivated ? "" : " (inactive)";
    return result.versionNumber === 1
      ? `Created ${name} as a new flow (version 1${this.savedActivated ? "" : ", inactive"}).`
      : `Saved version ${result.versionNumber} of ${name}${state}.`;
  }

  /** What to compare the saved version with: what runs now, or the one before. */
  get compareWith() {
    const { result } = this;
    if (!result || result.versionNumber <= 1) {
      return undefined;
    }
    const active = this.savedActiveVersion;
    return active && active !== result.versionNumber
      ? active
      : result.versionNumber - 1;
  }

  get compareLabel() {
    return `Compare with version ${this.compareWith}`;
  }

  handleCompare() {
    this[NavigationMixin.Navigate](
      compareRef(this.pageRef, {
        connection: this.savedConnection,
        apiName: this.savedApiName,
        versionNumber: this.result.versionNumber,
        comparedVersion: this.compareWith
      })
    );
    this.handleClose();
  }

  get builderUrl() {
    return this.result && this.result.builderUrl;
  }

  get remoteNote() {
    return this.result && !this.result.builderUrl
      ? `Open ${this.connectionLabel(this.savedConnection)} to edit it in Flow Builder.`
      : undefined;
  }

  // The flow exactly as the org will save it, so its fingerprint covers
  // all of it: the merge with the description written here and a new
  // flow's label, as a draft with no API name inside. The org refuses
  // anything else rather than change it.
  get candidateJson() {
    if (!this.metadata || typeof this.metadata !== "object") {
      return undefined;
    }
    const metadata = { ...this.metadata, status: "Draft" };
    delete metadata.fullName;
    const description = (this.description || "").trim();
    if (description) {
      metadata.description = description;
    } else {
      delete metadata.description;
    }
    if (this.isNewFlow && this.newFlowLabel) {
      metadata.label = this.newFlowLabel;
    }
    return JSON.stringify(metadata);
  }

  // A new flow's label as saved; left blank, the merge's own.
  get newFlowLabel() {
    return (this.newLabel || "").trim();
  }

  get receipt() {
    if (this.savedReceipt) {
      return this.savedReceipt;
    }
    const json = this.candidateJson;
    return json === undefined ? undefined : this.receiptFor(json);
  }

  // The description written here, when it isn't the one the merge made.
  get descriptionEdited() {
    const merged = ((this.metadata && this.metadata.description) || "").trim();
    return (this.description || "").trim() !== merged;
  }

  // A new flow's label written here, when it isn't the merge's.
  get labelEdited() {
    return (
      this.isNewFlow &&
      Boolean(this.newFlowLabel) &&
      this.newFlowLabel !== (this.metadata && this.metadata.label)
    );
  }

  receiptFor(json, saved) {
    const review = this.review || {};
    const decisions = [...(review.decisions || [])];
    if (this.descriptionEdited) {
      decisions.push(
        "Description: written when saving, in place of the merge's."
      );
    }
    if (this.labelEdited) {
      decisions.push(`Label: "${this.newFlowLabel}", written when saving.`);
    }
    return buildReceipt({
      candidate: (saved && saved.candidate) || fingerprint(json),
      sources: review.sources || [],
      decisions,
      checks: review.checks,
      saved
    });
  }

  get activationSummary() {
    return (this.result && this.result.receipt) || this.changeSummary;
  }

  get staleList() {
    return (this.stale || []).map((text, index) => ({
      key: String(index),
      text
    }));
  }

  handleKind(event) {
    this.target = event.detail.value;
    this.stale = undefined;
  }

  handleTarget(event) {
    this.targetIndex = event.detail.value;
    this.stale = undefined;
  }

  handleConnection(event) {
    this.connection = event.detail.value;
    this.stale = undefined;
  }

  handleRecompare() {
    this.dispatchEvent(new CustomEvent("recompare"));
    this.handleClose();
  }

  handleApiName(event) {
    this.newApiName = event.target.value.trim();
  }

  handleLabel(event) {
    this.newLabel = event.target.value;
  }

  handleDescription(event) {
    this.description = event.target.value;
  }

  async handleSave() {
    if (this.saveDisabled) {
      return;
    }
    // A merge that couldn't be read back has nothing to send.
    const metadataJson = this.candidateJson;
    // The merge being saved, so the saved event names it even if the merge
    // has changed by the time the save finishes.
    const saveKey = this.saveKey;
    if (metadataJson === undefined) {
      this.error =
        "The merged flow couldn't be read, so there's nothing to save. Fix the merge and try again.";
      return;
    }
    const operation = ++this._operation;
    const current = () => operation === this._operation && this._open;
    this._inFlight += 1;
    this.busy = true;
    this.error = undefined;
    const receipt = this.receiptFor(metadataJson);
    const target = this.isNewVersion ? this.chosenTarget : undefined;
    // What was reviewed goes with the flow: the org saves it only if it's
    // the flow sent and what it was made from is as it was compared.
    const review = JSON.stringify({
      candidate: receipt.candidate,
      latestVersion: (target && target.latestVersion) || null,
      sources: receipt.sources.map((source) => ({
        connection: source.connection || null,
        versionId: source.versionId || null,
        lastModifiedDate: source.lastModifiedDate || null,
        label: source.label || null
      })),
      receipt: receiptText(receipt)
    });
    try {
      let result;
      let connection;
      let label;
      // A new flow has no active version; an existing one's may be unknown.
      let activeVersion = null;
      if (target) {
        connection = target.connection;
        label = target.label;
        activeVersion = target.activeVersion;
        // A save goes in the flow's history, so governance reads go stale.
        result = await governanceChange(() =>
          saveVersion({
            connection,
            apiName: target.apiName,
            metadataJson,
            review
          })
        );
      } else {
        connection = this.connection;
        label = this.newFlowLabel || this.newApiName;
        result = await governanceChange(() =>
          saveAsNewFlow({
            connection,
            apiName: this.newApiName,
            label: this.newFlowLabel,
            metadataJson,
            review
          })
        );
      }
      if (result && result.stale && result.stale.length) {
        if (current()) {
          this.stale = result.stale;
        } else {
          this.dispatchEvent(
            new ShowToastEvent({
              title: "The merged flow wasn't saved",
              message: result.stale.join(" "),
              variant: "error",
              mode: "sticky"
            })
          );
        }
        return;
      }
      if (current()) {
        this.result = result;
        const orgCheck = receiptChecks(undefined, result).find(
          (check) => check.key === "org"
        );
        this.savedReceipt = {
          ...receipt,
          checks: receipt.checks.map((check) =>
            check.key === "org" ? orgCheck : check
          )
        };
        this.savedConnection = connection;
        this.savedApiName = result.apiName;
        this.savedLabel = label;
        this.savedActiveVersion = activeVersion;
        // The Save button is gone; keep focus in the dialog.
        this._focusOnRender = true;
      }
      this.dispatchEvent(
        new CustomEvent("saved", {
          detail: {
            result,
            connection,
            label,
            receipt: result.receipt,
            checks: receipt.checks,
            saveKey
          }
        })
      );
    } catch (e) {
      if (current()) {
        this.error = errorText(e);
      } else {
        this.dispatchEvent(
          new ShowToastEvent({
            title: "Save could not be confirmed",
            message: errorText(e),
            variant: "error",
            mode: "sticky"
          })
        );
      }
    } finally {
      this._inFlight -= 1;
      this.busy = this._inFlight > 0;
    }
  }

  handleActivated() {
    this.savedActivated = true;
    this.dispatchEvent(
      new CustomEvent("activated", {
        detail: { connection: this.savedConnection, apiName: this.savedApiName }
      })
    );
  }

  handleClose() {
    this._open = false;
    this.dispatchEvent(new CustomEvent("close"));
  }

  handleKeyDown(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      this.handleClose();
    }
  }

  handleFocusFirst() {
    focusModalEnd(this.template.querySelector("section"), false);
  }

  handleFocusLast() {
    focusModalEnd(this.template.querySelector("section"), true);
  }
}
