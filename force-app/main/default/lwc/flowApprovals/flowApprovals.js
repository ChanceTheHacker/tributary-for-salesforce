/**
 * Flow activation requests: the ones waiting for the user's decision, the
 * ones they made, and (for admins) all of them. Approving queues activation;
 * each request links to the comparison of its version with the active one.
 *
 * The tab and status filter are kept in the page's state, so coming back
 * from a comparison shows the same list. Requests come a page at a time,
 * with long text cut short until it's asked for. A notification's link
 * (c__request) shows its request first, read on its own, whatever the filters.
 */
import { waitForOperation } from "c/flowOperation";
import { cachedRead, governanceChange } from "c/flowGovernanceCache";
import { LightningElement, api, wire } from "lwc";
import { CurrentPageReference, NavigationMixin } from "lightning/navigation";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import listRequestPage from "@salesforce/apex/FlowGovernanceController.listRequestPage";
import getRequest from "@salesforce/apex/FlowGovernanceController.getRequest";
import approveRequest from "@salesforce/apex/FlowGovernanceController.approveRequest";
import rejectRequest from "@salesforce/apex/FlowGovernanceController.rejectRequest";
import cancelRequest from "@salesforce/apex/FlowGovernanceController.cancelRequest";
import {
  errorText,
  formatDateTime,
  compareRef,
  statusClass,
  focusModalEnd,
  tabApiName,
  visibleText
} from "c/flowUtils";

const SCOPES = [
  { value: "mine", label: "Waiting for me" },
  { value: "submitted", label: "My requests" },
  { value: "all", label: "All requests" }
];

const STATUSES = [
  { label: "Pending", value: "Pending" },
  { label: "Activated", value: "Activated" },
  { label: "Failed", value: "Failed" },
  { label: "Rejected", value: "Rejected" },
  { label: "Withdrawn", value: "Cancelled" },
  { label: "Any status", value: "" }
];

// "Any status" in the page's state, where an empty value would be dropped.
const ANY = "any";

// Requests per page; a reload after a decision reads up to MAX_PAGE, to
// keep what was shown.
const PAGE = 25;
const MAX_PAGE = 100;

const ACTIONS = {
  approve: {
    title: "Approve and activate",
    button: "Approve and activate",
    variant: "brand",
    comments: "Comments for the requester (optional)"
  },
  reject: {
    title: "Reject request",
    button: "Reject",
    variant: "destructive",
    comments: "Why is it rejected? (optional)"
  },
  cancel: {
    title: "Withdraw request",
    button: "Withdraw request",
    variant: "destructive",
    comments: undefined
  }
};

// How long a decided request takes to fade out of the list.
const LEAVE_MS = 360;

// Motion only when it's wanted, and known to be: tests have no matchMedia.
const animating = () =>
  typeof window.matchMedia === "function" &&
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// "Replaces version 1, the active version when this was requested", for a
// pending request whose summary compared with some other version.
function replacedText(request) {
  const replaces = request.replacesVersion;
  if (
    request.status !== "Pending" ||
    !replaces ||
    replaces === request.comparedVersion ||
    replaces === request.versionNumber
  ) {
    return "";
  }
  return `Replaces version ${replaces}, the active version when this was requested.`;
}

export default class FlowApprovals extends NavigationMixin(LightningElement) {
  @api embedded = false;
  @api comparison;
  _requestId;

  @api
  get requestId() {
    return this._requestId;
  }

  set requestId(value) {
    if (value === this._requestId) return;
    this._requestId = value;
    this.highlight = value;
    this.linked = undefined;
    this.linkedError = undefined;
    this.lastDecision = undefined;
    this.dialog = undefined;
    this._linkedToken += 1;
    if (this.embedded) this.loading = false;
    if (this._started && value) this.loadLinked();
  }

  get fullPage() {
    return !this.embedded;
  }

  get pageClass() {
    return this.embedded ? "page embedded" : "page";
  }

  get resultsRole() {
    return this.embedded ? "region" : "tabpanel";
  }

  // This is a presentation guard; Apex independently rechecks permission,
  // the requested version's timestamp and what is currently active.
  matchesComparison(request) {
    if (!this.embedded) return true;
    const context = this.comparison;
    return Boolean(
      context &&
      request &&
      context.versions &&
      context.a &&
      context.b &&
      context.versionA &&
      context.versionB &&
      context.a.connection === (request.connection || "local") &&
      context.b.connection === context.a.connection &&
      context.a.apiName === request.apiName &&
      context.b.apiName === request.apiName &&
      context.versionB.versionNumber === request.versionNumber &&
      (!request.replacesVersion ||
        context.versionA.versionNumber === request.replacesVersion)
    );
  }

  get comparisonWarning() {
    return this.embedded && this.linked && !this.matchesComparison(this.linked)
      ? "To decide on this request, compare the requested version with the version it replaces. Use Compare with version below, or Compare if no version was active."
      : "";
  }

  scope = "mine";
  status = "Pending";
  requests = [];
  // Where the next page starts, when there is one.
  _next;
  loadingMore = false;
  loading = false;
  error;
  lastDecision;
  // The request a notification linked to, shown first and highlighted.
  highlight;
  linked;
  linkedError;
  dialog;
  // Requests are fading out of the list; focus waits for them to go.
  _leaving = false;
  dialogComments = "";
  dialogError;
  working = false;
  _pageRef;
  _started = false;
  _loadToken = 0;
  _linkedToken = 0;
  _focusDialog = false;
  // Derived data, filled while rendering; not reactive.
  _cache = {};
  // The button that opened the dialog, to focus again once it closes.
  _returnFocus;

  @wire(CurrentPageReference)
  setPageRef(pageRef) {
    this._pageRef = pageRef;
    if (this.embedded) return;
    const state = (pageRef && pageRef.state) || {};
    let changed = false;
    if (
      SCOPES.some((scope) => scope.value === state.c__scope) &&
      state.c__scope !== this.scope
    ) {
      this.scope = state.c__scope;
      changed = true;
    }
    const linkedId = state.c__request || undefined;
    if (linkedId !== this.highlight) {
      // Navigation away also invalidates a linked read still in flight.
      this._linkedToken += 1;
      this.highlight = linkedId;
      this.linked = undefined;
      this.linkedError = undefined;
      if (linkedId) this.loadLinked();
    }
    const status = state.c__status === ANY ? "" : state.c__status;
    if (
      STATUSES.some((option) => option.value === status) &&
      status !== this.status
    ) {
      this.status = status;
      changed = true;
    }
    if (changed && this._started) {
      this.load();
    }
  }

  // Keeps the filters in the address, replacing rather than adding history.
  rememberFilters() {
    if (!this._pageRef) {
      return;
    }
    const state = {
      ...this._pageRef.state,
      c__scope: this.scope,
      c__status: this.status || ANY
    };
    delete state.c__request;
    this[NavigationMixin.Navigate]({ ...this._pageRef, state }, true);
  }

  connectedCallback() {
    this._started = true;
    if (this.embedded) {
      if (this.requestId) this.loadLinked();
    } else {
      this.load();
    }
  }

  /**
   * Reloads the list from its first page. After a decision, leave: true
   * fades out the requests that have left it where they were, rather than
   * dropping them at once. fresh reads past the cache, as Refresh does.
   */
  async load({ leave = false, fresh = false } = {}) {
    // A later load (the page state arriving, a quick filter change) wins.
    const token = ++this._loadToken;
    this.loading = true;
    this.loadingMore = false;
    this.error = undefined;
    // After a decision, as many as were shown, so the list stays put.
    const pageSize = leave
      ? Math.min(MAX_PAGE, Math.max(PAGE, this.requests.length))
      : PAGE;
    try {
      const page = await this.readPage(undefined, pageSize, fresh);
      if (token === this._loadToken) {
        this._next = page.nextBeforeId ? page : undefined;
        this.show(
          page.requests || [],
          leave && animating() ? token : undefined
        );
      }
    } catch (error) {
      if (token === this._loadToken) {
        this.error = errorText(error);
        this.requests = [];
        this._next = undefined;
      }
    } finally {
      if (token === this._loadToken) {
        this.loading = false;
      }
    }
  }

  readPage(after, pageSize, fresh) {
    return cachedRead(
      "listRequestPage",
      listRequestPage,
      {
        scope: this.scope,
        status: this.status,
        beforeDate: after ? after.nextBefore : null,
        beforeId: after ? after.nextBeforeId : null,
        pageSize
      },
      fresh
    );
  }

  get hasMore() {
    return Boolean(this._next) && !this.loading;
  }

  get moreLabel() {
    return this.loadingMore ? "Loading…" : "Show more requests";
  }

  // The next page, after the last one read; a reload in between wins.
  async handleMore() {
    if (!this._next || this.loadingMore || this.loading) {
      return;
    }
    const token = this._loadToken;
    this.loadingMore = true;
    try {
      const page = await this.readPage(this._next, PAGE, false);
      if (token === this._loadToken) {
        const shown = new Set(this.requests.map((request) => request.id));
        this.requests = [
          ...this.requests,
          ...(page.requests || []).filter((request) => !shown.has(request.id))
        ];
        this._next = page.nextBeforeId ? page : undefined;
      }
    } catch (error) {
      if (token === this._loadToken) {
        this.error = errorText(error);
      }
    } finally {
      if (token === this._loadToken) {
        this.loadingMore = false;
      }
    }
  }

  // The linked request, read on its own and in full, so neither its status,
  // its age nor the filters can hide it. Never cached: it's read once.
  async loadLinked() {
    const token = ++this._linkedToken;
    const requestId = this.highlight;
    this.linkedError = undefined;
    if (this.embedded) this.loading = true;
    try {
      const request = await getRequest({ requestId });
      if (token === this._linkedToken) {
        this.linked = request;
      }
    } catch (error) {
      if (token === this._linkedToken) {
        this.linked = undefined;
        this.linkedError = `The request you followed a link to can't be shown. ${errorText(error)}`;
      }
    } finally {
      if (this.embedded && token === this._linkedToken) this.loading = false;
    }
  }

  // All of a request's text, when the list cut it short.
  async handleShowFull(event) {
    const id = event.currentTarget.dataset.id;
    try {
      const full = await getRequest({ requestId: id });
      this.requests = this.requests.map((request) =>
        request.id === id ? full : request
      );
    } catch (error) {
      this.error = errorText(error);
    }
  }

  show(requests, token) {
    const ids = new Set(requests.map((request) => request.id));
    const gone = (this.requests || [])
      .map((request, index) => ({ request, index }))
      .filter(({ request }) => !ids.has(request.id));
    if (token === undefined || !gone.length) {
      this.requests = requests;
      return;
    }
    const shown = [...requests];
    for (const { request, index } of gone) {
      shown.splice(Math.min(index, shown.length), 0, {
        ...request,
        leaving: true
      });
    }
    this.requests = shown;
    this._leaving = true;
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    setTimeout(() => {
      this._leaving = false;
      // Takes out only the leaving rows: a page shown meanwhile stays.
      if (token === this._loadToken) {
        this.requests = this.requests.filter((request) => !request.leaving);
      }
    }, LEAVE_MS);
  }

  get scopes() {
    return SCOPES.map((scope) => ({
      ...scope,
      className: scope.value === this.scope ? "tab tab-active" : "tab",
      selected: scope.value === this.scope ? "true" : "false",
      tabIndex: scope.value === this.scope ? 0 : -1,
      id: `scope-${scope.value}`
    }));
  }

  get statusOptions() {
    return STATUSES;
  }

  handleScope(event) {
    this.scope = event.currentTarget.dataset.scope;
    this.rememberFilters();
    this.load();
  }

  get selectedTabId() {
    return this.embedded ? undefined : `scope-${this.scope}`;
  }

  handleScopeKey(event) {
    const index = SCOPES.findIndex(
      (scope) => scope.value === event.currentTarget.dataset.scope
    );
    const next = {
      ArrowRight: (index + 1) % SCOPES.length,
      ArrowLeft: (index + SCOPES.length - 1) % SCOPES.length,
      Home: 0,
      End: SCOPES.length - 1
    }[event.key];
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    this.scope = SCOPES[next].value;
    this.template.querySelector(`[data-scope="${this.scope}"]`).focus();
    this.rememberFilters();
    this.load();
  }

  handleStatus(event) {
    this.status = event.detail.value;
    this.rememberFilters();
    this.load();
  }

  handleShowAll() {
    this.status = "";
    this.rememberFilters();
    this.load();
  }

  handleOpenCompare() {
    this[NavigationMixin.Navigate]({
      type: "standard__navItemPage",
      attributes: { apiName: tabApiName(this._pageRef, "Flow_Compare") }
    });
  }

  handleRefresh() {
    if (!this.embedded) this.load({ fresh: true });
    if (this.highlight) {
      this.loadLinked();
    }
  }

  // A derived list kept until one of its inputs changes.
  memo(name, inputs, build) {
    const entry = this._cache[name];
    if (entry && entry.inputs.every((input, i) => input === inputs[i])) {
      return entry.value;
    }
    const value = build();
    this._cache[name] = { inputs, value };
    return value;
  }

  // The linked request first, then the list without it.
  get shownRequests() {
    const { linked, requests } = this;
    return this.memo("shownRequests", [linked, requests], () =>
      linked
        ? [
            { ...linked, linked: true },
            ...(requests || []).filter((request) => request.id !== linked.id)
          ]
        : requests || []
    );
  }

  get rows() {
    return this.memo(
      "rows",
      [this.shownRequests, this.highlight, this.comparison, this.embedded],
      () => this.buildRows()
    );
  }

  buildRows() {
    return this.shownRequests.map((original) => {
      const request = Object.fromEntries(
        Object.entries(original).map(([key, value]) => [
          key,
          visibleText(value)
        ])
      );
      const decided = request.decidedBy
        ? `${request.status === "Rejected" ? "Rejected" : "Decided"} by ${request.decidedBy}${request.decidedAt ? ` on ${formatDateTime(request.decidedAt)}` : ""}`
        : "";
      return {
        ...request,
        canDecide: request.canDecide && this.matchesComparison(original),
        canCancel: request.canCancel && this.matchesComparison(original),
        title: `${request.label || request.apiName} · version ${request.versionNumber}`,
        compareText: `Compare ${request.label || request.apiName} version ${request.versionNumber}`,
        compareTitle:
          request.comparedVersion === undefined ||
          request.comparedVersion === null
            ? "Compare this version with the one before it"
            : `Compare this version with version ${request.comparedVersion}, as the request did`,
        statusText:
          request.status === "Cancelled" ? "Withdrawn" : request.status,
        badgeClass: statusClass(request.status),
        requestedText: `Requested by ${request.requestedBy || "someone"} on ${formatDateTime(request.requestedAt)}`,
        approverText:
          request.status === "Pending" && request.approverName
            ? `Waiting for ${request.approverName}${request.overrides ? ". You can decide in their place as a Tributary admin" : ""}`
            : "",
        // An admin deciding for someone else's flow is an override, so it
        // isn't the page's main action.
        approveLabel: request.overrides
          ? "Approve as admin"
          : "Approve and activate",
        approveVariant: request.overrides ? "neutral" : "brand",
        // What approving replaces, when the summary compared with another
        // version, so the approver can see everything that would go live.
        replacesText: replacedText(request),
        compareReplacedText:
          replacedText(request) || (this.embedded && request.replacesVersion)
            ? `Compare with version ${request.replacesVersion}`
            : "",
        connectionText:
          request.connection && request.connection !== "local"
            ? `Org: ${request.connection}`
            : "",
        decided,
        linkedText: request.linked
          ? this.embedded
            ? "Review this activation request against the comparison below."
            : "The request your notification links to."
          : "",
        className: [
          "request",
          request.id === this.highlight ? "request-highlight" : "",
          request.leaving ? "request-leaving" : ""
        ]
          .filter(Boolean)
          .join(" "),
        hidden: request.leaving ? "true" : undefined
      };
    });
  }

  get hasRows() {
    return this.rows.length > 0;
  }

  // The list is empty even when a linked request is shown above it.
  get listEmpty() {
    return !(this.requests || []).length;
  }

  get statusWord() {
    const option = STATUSES.find((item) => item.value === this.status);
    return option ? option.label.toLowerCase() : this.status;
  }

  // Only an empty approval queue is good news; other empty lists say what
  // was filtered out, and how to see more.
  get empty() {
    const filtered = Boolean(this.status);
    const empty = {
      icon: "utility:filterList",
      iconClass: "empty-icon",
      showAll: filtered,
      openCompare: false
    };
    if (this.scope === "mine") {
      if (this.status === "Pending") {
        return {
          ...empty,
          icon: "utility:check",
          iconClass: "empty-icon empty-done",
          text: "Nothing is waiting for your approval.",
          showAll: false
        };
      }
      return {
        ...empty,
        text: filtered
          ? `No ${this.statusWord} requests you decide on.`
          : "No requests have come to you yet."
      };
    }
    if (this.scope === "submitted") {
      return filtered
        ? { ...empty, text: `None of your requests are ${this.statusWord}.` }
        : {
            ...empty,
            icon: "utility:record_create",
            text: "You haven't requested an activation yet. Compare a flow's versions to request one.",
            openCompare: true
          };
    }
    return {
      ...empty,
      text: filtered
        ? `No ${this.statusWord} requests across all flows.`
        : "Nobody has requested an activation yet."
    };
  }

  get showEmpty() {
    return !this.embedded && !this.loading && !this.error && this.listEmpty;
  }

  // The list stays while it reloads, faded, so nothing jumps.
  get resultsClass() {
    return this.loading ? "results busy" : "results";
  }

  get resultsBusy() {
    return this.loading ? "true" : "false";
  }

  findRequest(id) {
    return this.shownRequests.find((request) => request.id === id);
  }

  handleCompare(event) {
    const request = this.findRequest(event.currentTarget.dataset.id);
    this[NavigationMixin.Navigate](
      compareRef(this._pageRef, { ...request, requestId: request.id })
    );
  }

  handleCompareReplaced(event) {
    const request = this.findRequest(event.currentTarget.dataset.id);
    this[NavigationMixin.Navigate](
      compareRef(this._pageRef, {
        ...request,
        requestId: request.id,
        comparedVersion: request.replacesVersion
      })
    );
  }

  handleAction(event) {
    const { id, action } = event.currentTarget.dataset;
    if (!this.matchesComparison(this.findRequest(id))) return;
    this._focusDialog = true;
    this._returnFocus = `lightning-button[data-id="${id}"][data-action="${action}"]`;
    this.dialog = { action, request: this.findRequest(id), ...ACTIONS[action] };
    this.dialogComments = "";
    this.dialogError = undefined;
  }

  get dialogOpen() {
    return Boolean(this.dialog);
  }

  get dialogText() {
    if (!this.dialog) {
      return "";
    }
    const { request, action } = this.dialog;
    const name = `${visibleText(request.label || request.apiName)} version ${request.versionNumber}`;
    if (action === "approve") {
      const replaces = request.replacesVersion
        ? ` in place of version ${request.replacesVersion}`
        : "";
      const override = request.overrides
        ? ` You're deciding in place of ${request.approverName || "the flow's owner"}, and the history records it as an admin override.`
        : "";
      return `${name} goes live${replaces} for everyone who runs the flow.${override} Keep this page open until it says it's done.`;
    }
    if (action === "reject") {
      return `${request.requestedBy || "The requester"} is told that ${name} won't be activated.`;
    }
    return `Withdraw your request to activate ${name}?`;
  }

  get dialogHasComments() {
    return Boolean(this.dialog && this.dialog.comments);
  }

  handleComments(event) {
    this.dialogComments = event.target.value;
  }

  handleDialogClose() {
    if (!this.working) {
      this.dialog = undefined;
    }
  }

  handleDialogKey(event) {
    if (event.key === "Escape") {
      this.handleDialogClose();
    }
  }

  handleFocusFirst() {
    focusModalEnd(this.template.querySelector("section.slds-modal"), false);
  }

  handleFocusLast() {
    focusModalEnd(this.template.querySelector("section.slds-modal"), true);
  }

  renderedCallback() {
    if (this._focusDialog && this.dialogOpen) {
      this._focusDialog = false;
      this.template.querySelector("section.slds-modal").focus();
    }
    // Once the dialog has closed and the list has reloaded, back to the
    // button that opened it, or to the filters when its request has left.
    if (
      this._returnFocus &&
      !this.dialogOpen &&
      !this.loading &&
      !this._leaving
    ) {
      const target =
        this.template.querySelector(this._returnFocus) ||
        this.template.querySelector("lightning-combobox.status") ||
        this.template.querySelector(".results");
      this._returnFocus = undefined;
      if (target) {
        target.focus();
      }
    }
  }

  async handleConfirm() {
    if (this.working || !this.dialog) {
      return;
    }
    const { action, request } = this.dialog;
    if (!this.matchesComparison(request)) {
      this.dialogError =
        "The comparison changed. Close this dialog and review the requested versions again.";
      return;
    }
    this.working = true;
    this.dialogError = undefined;
    try {
      const comments = this.dialogComments;
      const result = await governanceChange(async () => {
        if (action === "approve") {
          return waitForOperation(
            await approveRequest({ requestId: request.id, comments }),
            () => !this.isConnected
          );
        }
        if (action === "reject") {
          return rejectRequest({ requestId: request.id, comments });
        }
        return cancelRequest({ requestId: request.id });
      });
      this.dialog = undefined;
      this.toast(action, result || request);
      if (this.embedded) {
        if (action === "approve") {
          this.dispatchEvent(
            new CustomEvent("decided", {
              detail: {
                connection: request.connection || "local",
                apiName: request.apiName
              }
            })
          );
        }
        await this.loadLinked();
      } else {
        await Promise.all([
          this.load({ leave: true }),
          request.linked ? this.loadLinked() : undefined
        ]);
      }
    } catch (error) {
      this.dialogError = errorText(error);
    } finally {
      this.working = false;
    }
  }

  toast(action, request) {
    const name = `${visibleText(request.label || request.apiName)} version ${request.versionNumber}`;
    let event;
    if (action === "approve" && request.status === "Failed") {
      event = {
        title: "Approved, but activation failed",
        message: request.error || `${name} couldn't be activated.`,
        variant: "error"
      };
    } else if (action === "approve") {
      event = {
        title: "Activated",
        message: `${name} is now active.`,
        variant: "success"
      };
    } else if (action === "reject") {
      event = {
        title: "Rejected",
        message: `${name} won't be activated.`,
        variant: "info"
      };
    } else {
      event = {
        title: "Withdrawn",
        message: `Request for ${name} withdrawn.`,
        variant: "info"
      };
    }
    // The pending card may disappear, but its outcome must outlast the toast.
    this.lastDecision = event;
    this.dispatchEvent(new ShowToastEvent(event));
  }
}
