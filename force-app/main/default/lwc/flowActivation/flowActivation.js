/**
 * Activation for one flow version under its governance: who owns the flow,
 * what's pending, and either "Activate now" (for the owner or an admin, or
 * in this org anyone with Manage Flow when the flow isn't governed) or
 * "Request activation". An admin who isn't the owner gets both: asking the
 * owner comes first, activating anyway is an override the owner hears about.
 *
 * Activating is recorded as a request decided at once, so it is audited the
 * same way either path. It asks for confirmation first: the change is live.
 *
 * Events: activated { request }, requested { request }.
 */
import { waitForOperation } from "c/flowOperation";
import { cachedRead, governanceChange } from "c/flowGovernanceCache";
import { LightningElement, api, wire } from "lwc";
import { CurrentPageReference, NavigationMixin } from "lightning/navigation";
import getFlowStatus from "@salesforce/apex/FlowGovernanceController.getFlowStatus";
import requestActivation from "@salesforce/apex/FlowGovernanceController.requestActivation";
import activateVersion from "@salesforce/apex/FlowGovernanceController.activateVersion";
import {
  errorText,
  checkStatus,
  modeBadge,
  modeLabel,
  monitorRef
} from "c/flowUtils";

// Cards for the same flow load together (a versions comparison shows two),
// so they share one read, and coming back to Activate reuses it for a
// minute. After an action a card asks afresh rather than take an answer
// read before it. What the card shows isn't what allows an action: the
// server checks that when it's asked.
function readStatus(connection, apiName, fresh) {
  return cachedRead(
    "getFlowStatus",
    getFlowStatus,
    { connection, apiName },
    fresh
  );
}

export default class FlowActivation extends NavigationMixin(LightningElement) {
  _connection = "local";
  _versionNumber;
  _loadToken = 0;
  _confirmation;

  @api
  get connection() {
    return this._connection;
  }
  set connection(value) {
    if (this._connection !== value) {
      this._connection = value;
      this.resetSelection();
    }
  }

  @api
  get versionNumber() {
    return this._versionNumber;
  }
  set versionNumber(value) {
    if (this._versionNumber !== value) {
      this._versionNumber = value;
      this.confirming = false;
      this.outcome = undefined;
    }
  }

  @api label;
  @api versionId;
  @api changeSummary;
  /** Checks captured with the saved merge, not recomputed from later edits. */
  @api reviewChecks = [];

  get reviewWarning() {
    return (this.reviewChecks || [])
      .filter((check) => check.status === "warned" || check.status === "failed")
      .map((check) =>
        [check.title, check.summary, ...(check.messages || [])].join(" ")
      )
      .join(" ");
  }

  /** The version of the same flow the change summary compares with. */
  @api comparedVersion;
  /**
   * When the version was saved from the merge the summary describes.
   * Activating it, now or when a request is approved, refuses a version
   * changed since.
   */
  @api reviewedAt;
  /** The org's name, for the confirmation. */
  @api orgLabel;
  /** A lesser action: the button isn't the page's main one. */
  @api secondary = false;
  @api compact = false;
  /** A second card for the same flow: the first explains its governance. */
  @api brief = false;

  status;
  error;
  busy = false;
  comments = "";
  outcome;
  confirming = false;
  _apiName;
  _activeVersion;
  // What this component activated, until the parent says otherwise.
  _activated;
  _focusConfirm = false;
  _focusActivate = false;

  pageRef;
  checksUrl;

  @wire(CurrentPageReference)
  setPageRef(pageRef) {
    this.pageRef = pageRef;
    if (pageRef && !this.checksUrl) {
      this[NavigationMixin.GenerateUrl](monitorRef(pageRef)).then(
        (url) => {
          this.checksUrl = url;
        },
        () => undefined
      );
    }
  }

  /**
   * The version that is active now (null for none), to say when this one
   * already is. Left undefined when it isn't known.
   */
  @api
  get activeVersion() {
    return this._activeVersion;
  }
  set activeVersion(value) {
    this._activeVersion = value;
    this._activated = undefined;
  }

  get currentActive() {
    return this._activated !== undefined
      ? this._activated
      : this._activeVersion;
  }

  @api
  get apiName() {
    return this._apiName;
  }
  set apiName(value) {
    if (this._apiName !== value) {
      this._apiName = value;
      this.resetSelection();
    }
  }

  resetSelection() {
    this._loadToken += 1;
    this.status = undefined;
    this.outcome = undefined;
    this.error = undefined;
    this.confirming = false;
    this._activated = undefined;
    if (this.isConnected) {
      this.load();
    }
  }

  connectedCallback() {
    this.load();
  }

  disconnectedCallback() {
    this._loadToken += 1;
  }

  /** Reloads governance and pending requests. */
  @api
  async load(fresh = false) {
    const token = ++this._loadToken;
    if (!this._apiName) {
      this.status = undefined;
      return;
    }
    const apiName = this._apiName;
    this.error = undefined;
    try {
      const status = await readStatus(this.connection, apiName, fresh);
      if (token === this._loadToken) {
        this.status = status;
      }
    } catch (e) {
      if (token === this._loadToken) {
        this.error = errorText(e);
      }
    }
  }

  get ready() {
    return Boolean(this.status);
  }

  get governance() {
    return this.status && this.status.governance;
  }

  get governed() {
    return Boolean(this.governance && this.governance.mode !== "Off");
  }

  get isRemote() {
    return Boolean(this.connection && this.connection !== "local");
  }

  // Governance is enforced by checks, so say what happens and when.
  get modeText() {
    switch (this.governance.mode) {
      case "Watch":
        return this.isRemote
          ? `An activation made ${this.where} can't be matched to the owner, so any activation outside Tributary is reverted at the next check`
          : "An activation by anyone but the owner is reverted at the next check";
      case "Locked":
        return "Activations need an approved request. Outside activations are reverted at the next check";
      case "Off":
        return "Not enforced";
      default:
        return this.governance.mode;
    }
  }

  get showGovernanceText() {
    return !this.brief;
  }

  get governanceText() {
    if (!this.governance) {
      return this.isRemote
        ? "Not governed: Tributary admins may activate here."
        : "Not governed: anyone who can manage flows here may activate.";
    }
    const owner = this.governance.ownerName
      ? `Owner: ${this.governance.ownerName}. `
      : "";
    return `${owner}${this.modeText}.`;
  }

  get ownerName() {
    return (this.governance && this.governance.ownerName) || "the owner";
  }

  /** An admin acting on a governed flow someone else owns. */
  get overrides() {
    return Boolean(
      this.governed &&
      this.canActivate &&
      this.governance.ownerId &&
      !this.governance.isOwner
    );
  }

  get overrideText() {
    return `You're not this flow's owner. Request activation to have ${this.ownerName} approve it, or activate now as an admin override: it's recorded in the flow's history and ${this.ownerName} is told.`;
  }

  get badgeClass() {
    return modeBadge(this.governance && this.governance.mode);
  }

  get badgeText() {
    return this.governance ? modeLabel(this.governance.mode) : "Ungoverned";
  }

  /** Whether the checks that enforce governance are running. */
  get checks() {
    return !this.brief && this.governed && this.status.monitor
      ? checkStatus(this.status.monitor)
      : undefined;
  }

  get checksClass() {
    return this.checks && this.checks.stopped ? "checks checks-off" : "checks";
  }

  get showChecksLink() {
    return Boolean(
      this.checks &&
      this.status.canGovern &&
      (this.checks.stopped || this.checks.state === "Check failed")
    );
  }

  handleOpenChecks(event) {
    event.preventDefault();
    this[NavigationMixin.Navigate](monitorRef(this.pageRef));
  }

  get isActive() {
    const active = this.currentActive;
    return (
      active !== undefined &&
      active !== null &&
      Number(active) === Number(this.versionNumber)
    );
  }

  get knowsActive() {
    return this.currentActive !== undefined;
  }

  get activeText() {
    return this.currentActive
      ? `Currently active: version ${this.currentActive}`
      : "No version is active";
  }

  get where() {
    if (!this.isRemote) {
      return "in this org";
    }
    return `in ${this.orgLabel || this.connection}`;
  }

  get confirmText() {
    const name = this.label || this._apiName;
    return `Make version ${this.versionNumber} the active version of ${name} ${this.where}?`;
  }

  get confirmDetail() {
    const active = this.currentActive;
    const effect = active
      ? `Version ${active} stops running and version ${this.versionNumber} runs from now on.`
      : `Version ${this.versionNumber} runs from now on.`;
    if (this.overrides) {
      return `${effect} This is recorded as an admin override and ${this.ownerName} is told.`;
    }
    return this.governed
      ? `${effect} Your approval is recorded in the flow's history.`
      : effect;
  }

  get buttonVariant() {
    return this.secondary ? "neutral" : "brand";
  }

  // Asking the owner is the main action; overriding them is the lesser one.
  get activateVariant() {
    return this.overrides ? "neutral" : this.buttonVariant;
  }

  get pending() {
    return ((this.status && this.status.pending) || []).map((request) => ({
      ...request,
      text: `Version ${request.versionNumber} requested by ${request.requestedBy}`
    }));
  }

  get hasPending() {
    return this.pending.length > 0;
  }

  get pendingForThis() {
    return this.pending.some(
      (request) => Number(request.versionNumber) === Number(this.versionNumber)
    );
  }

  get canActivate() {
    return Boolean(this.status && this.status.canActivate);
  }

  get canRequest() {
    return Boolean(
      this.status &&
      this.status.canRequest &&
      (!this.canActivate || this.overrides)
    );
  }

  get cannotAct() {
    return Boolean(
      this.status && !this.status.canActivate && !this.status.canRequest
    );
  }

  get noVersion() {
    return !this.versionNumber;
  }

  get activateDisabled() {
    return this.busy || this.noVersion || this.isActive || this.confirming;
  }

  get requestDisabled() {
    return this.busy || this.noVersion || this.isActive || this.pendingForThis;
  }

  get activateLabel() {
    if (this.overrides) {
      return "Activate now (admin override)";
    }
    if (
      this.versionNumber &&
      this.governance &&
      this.governance.mode === "Locked"
    ) {
      // The owner's activation here is recorded as their approval.
      return `Approve and activate version ${this.versionNumber}`;
    }
    return this.versionNumber
      ? `Activate version ${this.versionNumber}`
      : "Activate";
  }

  get confirmLabel() {
    return this.versionNumber
      ? `Activate version ${this.versionNumber}`
      : "Activate";
  }

  get requestLabel() {
    return this.versionNumber
      ? `Request activation of version ${this.versionNumber}`
      : "Request activation";
  }

  get outcomeClass() {
    return this.outcome && this.outcome.ok ? "outcome ok" : "outcome failed";
  }

  handleComments(event) {
    this.comments = event.target.value;
  }

  input() {
    return {
      connection: this.connection,
      apiName: this._apiName,
      label: this.label || this._apiName,
      versionNumber: Number(this.versionNumber),
      versionId: this.versionId,
      comments: this.comments,
      changeSummary: this.changeSummary,
      comparedVersion: this.comparedVersion
        ? Number(this.comparedVersion)
        : null,
      reviewedAt: this.reviewedAt || null,
      // What this page showed as active, so the server can refuse to undo a
      // version someone activated since. 0 is none; null is not known.
      replacesVersion:
        this.currentActive === undefined
          ? null
          : Number(this.currentActive) || 0
    };
  }

  get selectionKey() {
    return JSON.stringify([
      this.connection,
      this.apiName,
      this.versionNumber,
      this.versionId,
      this.reviewedAt
    ]);
  }

  // Asks first. Focus goes to Cancel, so a stray Enter doesn't go live.
  handleActivate() {
    this._confirmation = this.selectionKey;
    this.confirming = true;
    this.outcome = undefined;
    this._focusConfirm = true;
  }

  handleCancelConfirm() {
    this.confirming = false;
    this._focusActivate = true;
  }

  // Escape backs out of the confirmation only, not a dialog around it.
  handleConfirmKeyDown(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      this.handleCancelConfirm();
    }
  }

  renderedCallback() {
    const selector = this._focusConfirm
      ? ".confirm-cancel"
      : this._focusActivate && "lightning-button.activate";
    this._focusConfirm = false;
    this._focusActivate = false;
    const target = selector && this.template.querySelector(selector);
    if (target) {
      target.focus();
    }
  }

  async handleConfirm() {
    if (
      this.busy ||
      !this.confirming ||
      this._confirmation !== this.selectionKey
    ) {
      this.confirming = false;
      return;
    }
    const selection = this.selectionKey;
    this.confirming = false;
    await this.run(async () => {
      const decided = await waitForOperation(
        await activateVersion(this.input()),
        () => !this.isConnected
      );
      if (selection !== this.selectionKey) {
        return;
      }
      const ok = decided.status === "Activated";
      this.outcome = {
        ok,
        text: ok
          ? `Version ${decided.versionNumber} is now active.`
          : `Activation failed: ${decided.error}`
      };
      if (ok) {
        this._activated = decided.versionNumber || Number(this.versionNumber);
        this.dispatchEvent(
          new CustomEvent("activated", { detail: { request: decided } })
        );
      }
    });
  }

  async handleRequest() {
    if (this.busy) {
      return;
    }
    const selection = this.selectionKey;
    await this.run(async () => {
      const request = await requestActivation(this.input());
      if (selection !== this.selectionKey) {
        return;
      }
      this.outcome = {
        ok: true,
        text: request.approverName
          ? `Requested. It waits for ${request.approverName} to approve it on the Flow Approvals tab.`
          : "Requested. A Tributary admin can approve it on the Flow Approvals tab."
      };
      this.dispatchEvent(new CustomEvent("requested", { detail: { request } }));
    });
  }

  async run(action) {
    const selection = this.selectionKey;
    this.busy = true;
    this.error = undefined;
    try {
      await governanceChange(action);
      if (selection === this.selectionKey) {
        this.comments = "";
        await this.load(true);
      }
    } catch (e) {
      if (selection === this.selectionKey) {
        this.error = errorText(e);
      }
    } finally {
      this.busy = false;
    }
  }
}
