/**
 * Governed flows: who owns each one, how strictly its activations are
 * controlled, and what has happened to it. Admins add, change and remove
 * governance and can run the activation check straight away.
 *
 * URL state: c__flow (and c__conn for another org) the flow whose history
 * is shown, c__q the search.
 *
 * Governance reads are kept for a minute (c/flowGovernanceCache), so coming
 * back to the page doesn't wait for them; Refresh reads them again.
 */
import { waitForCheck } from "c/flowOperation";
import { cachedRead, governanceChange } from "c/flowGovernanceCache";
import { LightningElement, wire } from "lwc";
import { CurrentPageReference, NavigationMixin } from "lightning/navigation";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import getUserContext from "@salesforce/apex/FlowCompareController.getUserContext";
import listConnections from "@salesforce/apex/FlowCompareController.listConnections";
import listFlows from "@salesforce/apex/FlowCompareController.listFlows";
import listGoverned from "@salesforce/apex/FlowGovernanceController.listGoverned";
import saveGovernance from "@salesforce/apex/FlowGovernanceController.saveGovernance";
import removeGovernance from "@salesforce/apex/FlowGovernanceController.removeGovernance";
import listAuditEventsBefore from "@salesforce/apex/FlowGovernanceController.listAuditEventsBefore";
import runCheck from "@salesforce/apex/FlowGovernanceController.runCheck";
import getMonitor from "@salesforce/apex/FlowGovernanceController.getMonitor";
import {
  errorText,
  formatDateTime,
  formatTime,
  dayOf,
  plural,
  compareRef,
  focusModalEnd,
  checkStatus,
  modeBadge,
  modeLabel,
  checkSummary,
  monitorRef,
  visibleText
} from "c/flowUtils";

const LOCAL = "local";
// History comes a page at a time, newest first, each page after the last
// event shown.
const HISTORY_PAGE = 25;
const SEARCH_DELAY = 400;

const CHECKS_STOPPED =
  "Automatic checks are stopped, so activations made outside Tributary aren't reverted until someone runs a check. Turn them on in Automatic check settings.";

const MODES = [
  {
    value: "Off",
    label: "Off",
    description:
      "Nothing is enforced. The owner is recorded and activation requests still go to them."
  },
  {
    value: "Watch",
    label: modeLabel("Watch"),
    description:
      "Only the owner may activate. Anyone else's activation is reverted to the approved version at the next check, and the owner is told. In another org, activations can't be matched to the owner, so any made outside Tributary are reverted."
  },
  {
    value: "Locked",
    label: modeLabel("Locked"),
    description:
      "Every activation needs an approved request. The owner's own activation in Tributary counts as approved and is recorded. Any activation made elsewhere, even the owner's in Flow Builder, is reverted at the next check."
  }
];

const EVENT_TONE = {
  Requested: "info",
  Approved: "success",
  Activated: "success",
  "Owner Activation Accepted": "success",
  "Baseline Recorded": "info",
  Rejected: "neutral",
  Cancelled: "neutral",
  "Activation Failed": "error",
  "Unapproved Activation": "error",
  Reverted: "warning",
  "Revert Failed": "error",
  "Version Saved": "info",
  "Flow Created": "info",
  "Governance Changed": "info"
};

// Audit event types as the history reads them.
const EVENT_TEXT = {
  "Owner Activation Accepted": "Owner's activation accepted",
  "Baseline Recorded": "Approved version recorded",
  "Activation Failed": "Activation failed",
  "Unapproved Activation": "Activated without approval",
  "Revert Failed": "Couldn't revert",
  "Version Saved": "Version saved",
  "Flow Created": "Flow created",
  "Governance Changed": "Governance changed"
};

const EVENT_ICON = {
  success: "utility:success",
  info: "utility:info",
  neutral: "utility:close",
  warning: "utility:undo",
  error: "utility:error"
};

const OUTCOMES = {
  ok: { text: "Active version is approved.", tone: "success" },
  baseline: { text: "Recorded the active version as approved.", tone: "info" },
  off: { text: "Not enforced. Tracked the active version.", tone: "info" },
  accepted: { tone: "success" },
  reverted: { tone: "warning" },
  revertFailed: { prefix: "Couldn't revert: ", tone: "error" },
  missing: { text: "The flow wasn't found.", tone: "error" },
  skipped: { tone: "info" },
  error: { tone: "error" }
};

// What a check did to a flow, and how it reads: success, info, warning, error.
function describeOutcome(outcome, message) {
  const known = OUTCOMES[outcome] || { tone: "info" };
  return {
    text: known.text || `${known.prefix || ""}${message || outcome}`,
    tone: known.tone
  };
}

const flowKey = (connection, apiName) => `${connection || LOCAL}:${apiName}`;

// An event's details as blocks: each line a paragraph, with the "- " lines
// under it as a list, as a save receipt writes them. Entries written before
// the modes were renamed read with today's names.
function detailBlocks(details) {
  if (!details) {
    return undefined;
  }
  const text = visibleText(details).replace(
    /\bMode: (Watch|Locked)\b/g,
    (match, mode) => `Mode: ${modeLabel(mode)}`
  );
  const blocks = [];
  text.split("\n").forEach((line, index) => {
    const item = /^\s*- (.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (item && last) {
      last.items.push({ key: `i${index}`, text: item[1] });
      last.hasItems = true;
    } else if (line.trim()) {
      blocks.push({ key: `b${index}`, text: line, items: [], hasItems: false });
    }
  });
  return blocks;
}

// What an event shows that stays the same while it's shown, worked out once
// when it arrives. Its flow's label and its day's heading can change, so
// they're added as the history is shown.
function present(event) {
  const tone = EVENT_TONE[event.type] || "info";
  let version = "";
  if (event.versionNumber !== undefined && event.versionNumber !== null) {
    version =
      event.versionNumber === 0
        ? "no active version"
        : `version ${event.versionNumber}`;
    if (
      event.previousVersion !== undefined &&
      event.previousVersion !== null &&
      event.previousVersion !== event.versionNumber
    ) {
      version += ` (was ${event.previousVersion === 0 ? "inactive" : `version ${event.previousVersion}`})`;
    }
  }
  return {
    id: event.id,
    connection: event.connection,
    apiName: event.apiName,
    createdDate: event.createdDate,
    type: EVENT_TEXT[event.type] || event.type,
    icon: EVENT_ICON[tone],
    itemClass: `event event-${tone}`,
    flowKey: flowKey(event.connection, event.apiName),
    version,
    actor: event.actor ? `by ${visibleText(event.actor)}` : "",
    details: detailBlocks(event.details),
    when: formatTime(event.createdDate),
    whenFull: formatDateTime(event.createdDate),
    datetime: event.createdDate
  };
}

export default class FlowGovernance extends NavigationMixin(LightningElement) {
  governed = [];
  connections = [];
  user;
  loading = false;
  error;
  search = "";
  // The flow whose history is shown, as "connection:apiName"; none = all.
  selectedKey;
  // The history shown, as present() gives it; "Show older activity" adds
  // the page after the last one.
  events = [];
  hasOlder = false;
  eventsLoading = false;
  eventsError;
  checking = false;
  checkResults;
  // Whether scheduled checks run; undefined until known.
  monitor;
  editor;
  editorFlows = [];
  editorFlowsLoading = false;
  editorError;
  saving = false;
  removing;
  removeError;
  _pageRef;
  _started = false;
  _eventsToken = 0;
  _flowsToken = 0;
  _governedToken = 0;
  _focusDialog = false;
  // The button that opened a dialog, to focus again once it closes.
  _returnFocus;
  _focusHistory = false;
  // Today, so the history's Today and Yesterday move on at midnight.
  _today;
  _midnight;
  // Derived data, filled while rendering; not reactive.
  _cache = {};
  // Labels of flows no longer governed, by API name, for their history.
  flowLabels = {};
  _labelsLoaded = false;
  // The governed list being read, and the same list by flow key.
  _governedLoad;
  _index = {};
  _searchTimer;
  checksUrl;

  @wire(CurrentPageReference)
  setPageRef(pageRef) {
    const first = !this._pageRef;
    this._pageRef = pageRef;
    const state = (pageRef && pageRef.state) || {};
    if (first) {
      this.search = state.c__q || "";
      if (pageRef) {
        this[NavigationMixin.GenerateUrl](monitorRef(pageRef)).then(
          (url) => {
            this.checksUrl = url;
          },
          () => undefined
        );
      }
    }
    const key = state.c__flow
      ? flowKey(state.c__conn, state.c__flow)
      : undefined;
    if (key !== this.selectedKey) {
      this.selectedKey = key;
      if (this._started) {
        this.loadEvents();
      }
    }
  }

  // Keeps the search and the flow whose history is open in the URL, so a
  // reload or a shared link comes back to them.
  syncUrl() {
    if (!this._pageRef) {
      return;
    }
    const state = { ...this._pageRef.state };
    const set = (name, value) => {
      if (value) {
        state[name] = value;
      } else {
        delete state[name];
      }
    };
    const [connection, ...rest] = (this.selectedKey || "").split(":");
    set("c__q", this.search.trim());
    set("c__flow", this.selectedKey ? rest.join(":") : "");
    set("c__conn", this.selectedKey && connection !== LOCAL ? connection : "");
    this[NavigationMixin.Navigate]({ ...this._pageRef, state }, true);
  }

  disconnectedCallback() {
    clearTimeout(this._searchTimer);
    clearTimeout(this._midnight);
  }

  connectedCallback() {
    this._started = true;
    this.watchMidnight();
    this.start();
  }

  // Nothing else may change at midnight, so a timer moves the day on.
  watchMidnight() {
    const now = new Date();
    const midnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1
    );
    this._today = now.toDateString();
    clearTimeout(this._midnight);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    this._midnight = setTimeout(
      () => this.watchMidnight(),
      midnight.getTime() - now.getTime() + 1000
    );
  }

  // Nothing here needs another's answer, so it's all asked for at once. The
  // table still waits for the connections, which name its orgs.
  async start() {
    this.loading = true;
    const ready = Promise.all([getUserContext(), listConnections()]).then(
      ([user, connections]) => {
        this.user = user;
        this.connections = connections;
      },
      (error) => {
        this.error = errorText(error);
      }
    );
    await Promise.all([
      this.loadGoverned(ready),
      this.loadEvents(),
      this.loadMonitor()
    ]);
  }

  // Only a note beside the table, so a failure just leaves it out.
  async loadMonitor(fresh = false) {
    this.monitor = await cachedRead("getMonitor", getMonitor, {}, fresh).catch(
      () => undefined
    );
  }

  loadGoverned(ready, fresh = false) {
    this._governedLoad = this.readGoverned(ready, fresh);
    return this._governedLoad;
  }

  async readGoverned(ready, fresh) {
    // The latest read wins: a refresh still out when a save reads the list
    // again would otherwise put back the policy from before the save.
    const token = ++this._governedToken;
    this.loading = true;
    try {
      const governed = await cachedRead(
        "listGoverned",
        listGoverned,
        {},
        fresh
      );
      await ready;
      if (token === this._governedToken) {
        this.governed = governed;
      }
    } catch (error) {
      if (token === this._governedToken) {
        this.error = errorText(error);
        this.governed = [];
      }
    } finally {
      if (token === this._governedToken) {
        this.loading = false;
      }
    }
  }

  /**
   * The newest page of history, for the flow selected or all of them. It
   * replaces what was shown, so paging starts again from the top. fresh
   * reads past the cache, as Refresh does.
   */
  async loadEvents({ fresh = false } = {}) {
    // A later load (another flow, a refresh) wins, and an older page still
    // out for what was shown before is dropped.
    const token = ++this._eventsToken;
    this.eventsLoading = true;
    this.eventsError = undefined;
    try {
      const page = await this.readEvents(undefined, fresh);
      if (token === this._eventsToken) {
        this.showEvents([], page);
      }
    } catch (error) {
      if (token === this._eventsToken) {
        this.eventsError = errorText(error);
        this.events = [];
        this.hasOlder = false;
      }
    } finally {
      if (token === this._eventsToken) {
        this.eventsLoading = false;
      }
    }
  }

  // The page of history before an event, or the newest; one more than a
  // page says whether there's an older one.
  readEvents(after, fresh) {
    const [connection, ...rest] = (this.selectedKey || "").split(":");
    return cachedRead(
      "listAuditEventsBefore",
      listAuditEventsBefore,
      {
        connection: this.selectedKey ? connection : null,
        apiName: this.selectedKey ? rest.join(":") : null,
        beforeDate: after ? after.createdDate : null,
        beforeId: after ? after.id : null,
        pageSize: HISTORY_PAGE + 1
      },
      fresh
    );
  }

  showEvents(shown, page) {
    const ids = new Set(shown.map((event) => event.id));
    this.hasOlder = page.length > HISTORY_PAGE;
    this.events = [
      ...shown,
      ...page
        .slice(0, HISTORY_PAGE)
        .filter((event) => !ids.has(event.id))
        .map(present)
    ];
    this.loadFlowLabels(this.events);
  }

  // History outlives governance: name flows that are no longer governed by
  // their labels too, not their API names. Only this org's are looked up.
  async loadFlowLabels(events) {
    // Whether a flow is governed is known once the governed list is in.
    await this._governedLoad;
    const unknown = events.some(
      (event) =>
        (event.connection || LOCAL) === LOCAL &&
        !this.governedRecord(event.connection, event.apiName)
    );
    if (!unknown || this._labelsLoaded) {
      return;
    }
    this._labelsLoaded = true;
    // If they can't be listed, API names stand in.
    const flows = await listFlows({ connection: LOCAL }).catch(() => []);
    const labels = {};
    for (const flow of flows) {
      labels[flow.apiName] = flow.label;
    }
    this.flowLabels = labels;
  }

  governedRecord(connection, apiName) {
    return this.governedByKey().get(flowKey(connection, apiName));
  }

  // Rebuilt only when the list is, so finding a flow doesn't search it.
  governedByKey() {
    const index = this._index;
    if (index.list !== this.governed) {
      index.list = this.governed;
      index.byKey = new Map(
        this.governed.map((record) => [
          flowKey(record.connection, record.apiName),
          record
        ])
      );
    }
    return index.byKey;
  }

  // A flow's label, governed or not, falling back to its API name.
  labelFor(connection, apiName) {
    const record = this.governedRecord(connection, apiName);
    if (record) {
      return record.label;
    }
    return (
      ((connection || LOCAL) === LOCAL && this.flowLabels[apiName]) || apiName
    );
  }

  get isAdmin() {
    return Boolean(this.user && this.user.isAdmin);
  }

  connectionLabel(name) {
    const connection = this.connections.find(
      (candidate) => candidate.name === (name || LOCAL)
    );
    return connection ? connection.label : name || "This org";
  }

  get selected() {
    return this.governedByKey().get(this.selectedKey);
  }

  // Table

  // A derived list kept until one of its inputs changes: the table and the
  // history are read several times a render.
  memo(name, inputs, build) {
    const entry = this._cache[name];
    if (entry && entry.inputs.every((input, i) => input === inputs[i])) {
      return entry.value;
    }
    const value = build();
    this._cache[name] = { inputs, value };
    return value;
  }

  get rows() {
    return this.memo(
      "rows",
      [this.governed, this.search, this.selectedKey, this.connections],
      () => this.buildRows()
    );
  }

  buildRows() {
    const search = this.search.trim().toLowerCase();
    return this.governed
      .filter(
        (record) =>
          !search ||
          [
            record.label,
            record.apiName,
            record.ownerName,
            this.connectionLabel(record.connection)
          ]
            .filter(Boolean)
            .some((text) => text.toLowerCase().includes(search))
      )
      .map((record) => {
        const key = flowKey(record.connection, record.apiName);
        const name = record.label || record.apiName;
        const drift =
          record.mode !== "Off" &&
          record.activeVersion !== undefined &&
          record.activeVersion !== null &&
          record.approvedVersion !== undefined &&
          record.approvedVersion !== null &&
          record.activeVersion !== record.approvedVersion;
        return {
          ...record,
          label: visibleText(record.label),
          key,
          connectionLabel: visibleText(this.connectionLabel(record.connection)),
          ownerText: record.ownerName
            ? `${visibleText(record.ownerName)}${record.isOwner ? " (you)" : ""}`
            : "No owner",
          modeClass: modeBadge(record.mode),
          modeText: modeLabel(record.mode),
          compareText: `Compare ${name}`,
          historyText: `History of ${name}`,
          approvedText: versionText(record.approvedVersion),
          activeText: versionText(record.activeVersion),
          drift,
          checkedText: record.lastChecked
            ? formatDateTime(record.lastChecked)
            : "Not yet",
          ...this.lastCheck(record),
          menuText: `More actions for ${name}`,
          rowClass: key === this.selectedKey ? "row row-selected" : "row",
          selected: key === this.selectedKey ? "true" : "false"
        };
      });
  }

  get hasGoverned() {
    return this.governed.length > 0;
  }

  get hasRows() {
    return this.rows.length > 0;
  }

  get showEmpty() {
    return !this.loading && !this.error && !this.hasGoverned;
  }

  get noMatches() {
    return this.hasGoverned && !this.hasRows;
  }

  get countText() {
    return plural(this.governed.length, "governed flow");
  }

  handleSearch(event) {
    this.search = event.target.value || "";
    clearTimeout(this._searchTimer);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    this._searchTimer = setTimeout(() => this.syncUrl(), SEARCH_DELAY);
  }

  // Reads everything again, past the cache, and history from its newest page.
  handleRefresh() {
    this.loadGoverned(undefined, true);
    this.loadEvents({ fresh: true });
    this.loadMonitor(true);
  }

  // Automatic checks

  get checks() {
    return this.hasGoverned ? checkStatus(this.monitor) : undefined;
  }

  get checksClass() {
    return this.checks && this.checks.stopped ? "checks checks-off" : "checks";
  }

  handleOpenChecks(event) {
    event.preventDefault();
    this[NavigationMixin.Navigate](monitorRef(this._pageRef));
  }

  findRecord(id) {
    return this.governed.find((record) => record.id === id);
  }

  // Always opens the flow's history, even when it's already the one shown
  // (as from a link): "All flows" in the history goes back to everything.
  handleHistory(event) {
    const record = this.findRecord(event.currentTarget.dataset.id);
    const key = flowKey(record.connection, record.apiName);
    if (this.selectedKey !== key) {
      this.showHistory(key);
      this._focusHistory = true;
      return;
    }
    const title = this.template.querySelector(".history-title");
    if (title) {
      title.focus();
    }
  }

  handleAllHistory() {
    this.showHistory(undefined);
  }

  // A flow named in Recent activity, governed or not any more.
  handleEventFlow(event) {
    this.showHistory(event.currentTarget.dataset.key);
    this._focusHistory = true;
  }

  showHistory(key) {
    this.selectedKey = key;
    this.loadEvents();
    this.syncUrl();
  }

  handleCompare(event) {
    const record = this.findRecord(event.currentTarget.dataset.id);
    this[NavigationMixin.Navigate](
      compareRef(this._pageRef, {
        connection: record.connection,
        apiName: record.apiName
      })
    );
  }

  // History

  get historyTitle() {
    if (!this.selectedKey) {
      return "Recent activity";
    }
    const [connection, ...rest] = this.selectedKey.split(":");
    return `History: ${this.labelFor(connection, rest.join(":"))}`;
  }

  // Recent activity follows the search too, so a flow no longer governed
  // can still be found by name.
  get shownEvents() {
    return this.memo(
      "shownEvents",
      [
        this.events,
        this.search,
        this.selectedKey,
        this.governed,
        this.flowLabels,
        this.connections
      ],
      () => this.findEvents()
    );
  }

  findEvents() {
    const search = this.search.trim().toLowerCase();
    if (this.selectedKey || !search) {
      return this.events;
    }
    return this.events.filter((event) =>
      [
        this.labelFor(event.connection, event.apiName),
        event.apiName,
        this.connectionLabel(event.connection)
      ]
        .filter(Boolean)
        .some((text) => text.toLowerCase().includes(search))
    );
  }

  // Adds the page after the last event shown, rather than read them all again.
  async handleOlder() {
    const shown = this.events;
    if (this.eventsLoading || !shown.length) {
      return;
    }
    const token = ++this._eventsToken;
    this.eventsLoading = true;
    this.eventsError = undefined;
    try {
      const page = await this.readEvents(shown[shown.length - 1], false);
      if (token === this._eventsToken) {
        this.showEvents(shown, page);
        // The button goes with the last page; keep focus in the history.
        if (!this.hasOlder) {
          this._focusHistory = true;
        }
      }
    } catch (error) {
      if (token === this._eventsToken) {
        this.eventsError = errorText(error);
      }
    } finally {
      if (token === this._eventsToken) {
        this.eventsLoading = false;
      }
    }
  }

  get olderLabel() {
    return this.eventsLoading ? "Loading…" : "Show older activity";
  }

  // The events shown, with what can change while they're shown: their
  // flow's label and their day's heading.
  get historyItems() {
    return this.memo(
      "historyItems",
      [
        this.shownEvents,
        this.selectedKey,
        this.governed,
        this.flowLabels,
        this._today
      ],
      () => {
        const now = new Date();
        return this.shownEvents.map((event) => ({
          ...event,
          flowText: this.selectedKey
            ? ""
            : visibleText(this.labelFor(event.connection, event.apiName)),
          day: dayOf(event.createdDate, now)
        }));
      }
    );
  }

  /** History by day, newest first, as the events arrive. */
  get historyGroups() {
    return this.memo("historyGroups", [this.historyItems], () =>
      this.groupHistory()
    );
  }

  groupHistory() {
    const groups = [];
    for (const item of this.historyItems) {
      const last = groups[groups.length - 1];
      if (last && last.key === item.day.key) {
        last.items.push(item);
      } else {
        groups.push({
          key: item.day.key,
          label: item.day.label,
          items: [item]
        });
      }
    }
    return groups;
  }

  get historyClass() {
    return this.eventsLoading ? "history-panel busy" : "history-panel";
  }

  get historyBusy() {
    return this.eventsLoading ? "true" : "false";
  }

  get hasHistory() {
    return this.historyItems.length > 0;
  }

  get showHistoryEmpty() {
    return !this.eventsLoading && !this.eventsError && !this.hasHistory;
  }

  get historyEmptyText() {
    return this.events.length
      ? `No recent activity matches “${this.search.trim()}”.`
      : "Nothing has happened yet.";
  }

  get showAllHistory() {
    return Boolean(this.selectedKey);
  }

  // Check

  async handleRunCheck() {
    this.checking = true;
    this.checkResults = undefined;
    try {
      const check = await governanceChange(async () =>
        waitForCheck(await runCheck(), () => !this.isConnected)
      );
      this.checkResults = check.results;
      this.dispatchEvent(
        new ShowToastEvent({
          title: "Check finished",
          ...checkSummary(check.results, check)
        })
      );
      await Promise.all([
        this.loadGoverned(),
        this.loadEvents(),
        this.loadMonitor()
      ]);
    } catch (error) {
      this.dispatchEvent(
        new ShowToastEvent({
          title: "Check outcome unavailable",
          message: errorText(error),
          variant: "error"
        })
      );
    } finally {
      this.checking = false;
    }
  }

  // The outcome of the flow's last check, shown under when it was checked.
  lastCheck(record) {
    if (!record.lastCheckOutcome) {
      return { lastCheckText: undefined, lastCheckClass: undefined };
    }
    const outcome = describeOutcome(
      record.lastCheckOutcome,
      record.lastCheckMessage
    );
    return {
      lastCheckText: outcome.text,
      lastCheckClass: `meta last-check check-${outcome.tone}`
    };
  }

  get checkItems() {
    return (this.checkResults || []).map((result, index) => {
      const outcome = describeOutcome(result.outcome, result.message);
      const record = this.governed.find(
        (candidate) => candidate.id === result.governanceId
      );
      return {
        key: result.governanceId || `${index}`,
        name: record ? record.label : result.apiName,
        connectionLabel: this.connectionLabel(result.connection),
        text: outcome.text,
        itemClass: `check check-${outcome.tone}`,
        icon: EVENT_ICON[outcome.tone]
      };
    });
  }

  get hasCheckResults() {
    return Boolean(this.checkResults);
  }

  get checkEmpty() {
    return this.hasCheckResults && this.checkResults.length === 0;
  }

  handleCloseCheck() {
    this.checkResults = undefined;
  }

  // Add / edit

  get modeOptions() {
    return MODES.map(({ value, label }) => ({ value, label }));
  }

  get connectionOptions() {
    return this.connections.map((connection) => ({
      value: connection.name,
      label: connection.label
    }));
  }

  // Focus

  get dialogOpen() {
    return this.editorOpen || this.removeOpen;
  }

  openDialog(returnFocus) {
    this._focusDialog = true;
    this._returnFocus = returnFocus;
  }

  handleFocusFirst() {
    focusModalEnd(this.template.querySelector("section.slds-modal"), false);
  }

  handleFocusLast() {
    focusModalEnd(this.template.querySelector("section.slds-modal"), true);
  }

  renderedCallback() {
    if (this._focusHistory) {
      this._focusHistory = false;
      const title = this.template.querySelector(".history-title");
      if (title) {
        title.focus();
      }
    }
    if (this._focusDialog && this.dialogOpen) {
      this._focusDialog = false;
      const field = this.editorOpen
        ? this.template.querySelector(
            this.editor.isNew ? ".editor-connection" : ".editor-owner"
          )
        : undefined;
      (field || this.template.querySelector("section.slds-modal")).focus();
    }
    // Once the dialog has closed and the table has reloaded, back to the
    // button that opened it, or to "Govern a flow" when its row has gone.
    if (this._returnFocus && !this.dialogOpen && !this.loading) {
      const target =
        this.template.querySelector(this._returnFocus) ||
        this.template.querySelector("lightning-button.add");
      this._returnFocus = undefined;
      if (target) {
        target.focus();
      }
    }
  }

  handleAdd() {
    this.openDialog("lightning-button.add");
    const connection = LOCAL;
    this.editor = {
      id: null,
      isNew: true,
      connection,
      apiName: undefined,
      label: undefined,
      ownerId: this.user && this.user.userId,
      mode: "Watch"
    };
    this.editorError = undefined;
    this.loadEditorFlows(connection);
  }

  // Editing and stopping sit in each row's menu.
  handleRowMenu(event) {
    const id = event.currentTarget.dataset.id;
    if (event.detail.value === "edit") {
      this.edit(id);
    } else if (event.detail.value === "remove") {
      this.remove(id);
    }
  }

  edit(id) {
    this.openDialog(`lightning-button-menu.row-menu[data-id="${id}"]`);
    const record = this.findRecord(id);
    this.editor = {
      id: record.id,
      isNew: false,
      connection: record.connection || LOCAL,
      apiName: record.apiName,
      label: record.label,
      ownerId: record.ownerId,
      mode: record.mode
    };
    this.editorError = undefined;
  }

  async loadEditorFlows(connection) {
    const token = ++this._flowsToken;
    this.editorFlows = [];
    this.editorFlowsLoading = true;
    try {
      const flows = await listFlows({ connection });
      if (token === this._flowsToken) {
        this.editorFlows = flows;
      }
    } catch (error) {
      if (token === this._flowsToken) {
        this.editorError = errorText(error);
      }
    } finally {
      if (token === this._flowsToken) {
        this.editorFlowsLoading = false;
      }
    }
  }

  get editorOpen() {
    return Boolean(this.editor);
  }

  get editorTitle() {
    return this.editor && this.editor.isNew
      ? "Govern a flow"
      : `Governance: ${this.editor.label}`;
  }

  get editorFlowOptions() {
    if (!this.editor) {
      return [];
    }
    const taken = new Set(
      this.governed.map((record) => flowKey(record.connection, record.apiName))
    );
    return this.editorFlows
      .filter(
        (flow) => !taken.has(flowKey(this.editor.connection, flow.apiName))
      )
      .map((flow) => ({
        value: flow.apiName,
        label:
          flow.label && flow.label !== flow.apiName
            ? `${flow.label} (${flow.apiName})`
            : flow.apiName
      }))
      .sort((p, q) => p.label.localeCompare(q.label));
  }

  get editorFlowPlaceholder() {
    if (this.editorFlowsLoading) {
      return "Loading flows…";
    }
    return this.editorFlowOptions.length
      ? "Pick a flow"
      : "No flows left to govern";
  }

  get editorFlowDisabled() {
    return this.editorFlowsLoading || !this.editorFlowOptions.length;
  }

  get editorModeDescription() {
    const mode =
      this.editor &&
      MODES.find((candidate) => candidate.value === this.editor.mode);
    return mode ? mode.description : "";
  }

  /** Enforcement waits on the scheduled checks; say so while they're off. */
  get editorChecksWarning() {
    const checks = checkStatus(this.monitor);
    return this.editor && this.editor.mode !== "Off" && checks && checks.stopped
      ? CHECKS_STOPPED
      : "";
  }

  get ownerFilter() {
    return {
      // People who can sign in and approve, not system users.
      criteria: [
        { fieldPath: "IsActive", operator: "eq", value: true },
        { fieldPath: "UserType", operator: "eq", value: "Standard" }
      ]
    };
  }

  get editorChanged() {
    if (!this.editor || this.editor.isNew) return true;
    const original = this.findRecord(this.editor.id);
    return (
      !original ||
      ["ownerId", "mode", "label"].some(
        (key) => this.editor[key] !== original[key]
      )
    );
  }

  get saveDisabled() {
    return (
      this.saving ||
      !this.editorChanged ||
      !this.editor ||
      !this.editor.apiName ||
      !this.editor.ownerId ||
      !this.editor.mode
    );
  }

  get ownerHint() {
    return this.editor && this.editor.mode !== "Off" && !this.editor.ownerId
      ? "Pick who approves this flow's activations."
      : "";
  }

  handleEditorConnection(event) {
    const connection = event.detail.value;
    this.editor = {
      ...this.editor,
      connection,
      apiName: undefined,
      label: undefined
    };
    this.loadEditorFlows(connection);
  }

  handleEditorFlow(event) {
    const apiName = event.detail.value;
    const flow = this.editorFlows.find(
      (candidate) => candidate.apiName === apiName
    );
    this.editor = {
      ...this.editor,
      apiName,
      label: flow ? flow.label || apiName : apiName
    };
  }

  handleEditorOwner(event) {
    this.editor = {
      ...this.editor,
      ownerId: event.detail.recordId || undefined
    };
  }

  handleEditorMode(event) {
    this.editor = { ...this.editor, mode: event.detail.value };
  }

  handleEditorClose() {
    if (!this.saving) {
      this.editor = undefined;
    }
  }

  handleModalKey(event) {
    if (event.key === "Escape") {
      this.handleEditorClose();
      this.handleRemoveClose();
    }
  }

  async handleEditorSave() {
    if (this.saveDisabled) return;
    const { id, connection, apiName, label, ownerId, mode, isNew } =
      this.editor;
    this.saving = true;
    this.editorError = undefined;
    try {
      const saved = await governanceChange(() =>
        saveGovernance({ id, connection, apiName, label, ownerId, mode })
      );
      const unenforced = saved.mode !== "Off" && this.editorChecksWarning;
      this.editor = undefined;
      const message = isNew
        ? `${saved.label} is governed (${modeLabel(saved.mode)}). ${
            saved.approvedVersion
              ? `Version ${saved.approvedVersion} is the approved version.`
              : "No version is active, so none is approved yet."
          }`
        : `${saved.label}: ${modeLabel(saved.mode)}, owned by ${saved.ownerName}.`;
      this.dispatchEvent(
        new ShowToastEvent({
          title: isNew ? "Flow governed" : "Governance saved",
          message: unenforced ? `${message} ${unenforced}` : message,
          variant: unenforced ? "warning" : "success"
        })
      );
      this.selectedKey = flowKey(saved.connection, saved.apiName);
      this.syncUrl();
      await Promise.all([this.loadGoverned(), this.loadEvents()]);
    } catch (error) {
      this.editorError = errorText(error);
    } finally {
      this.saving = false;
    }
  }

  // Remove

  remove(id) {
    this.openDialog(`lightning-button-menu.row-menu[data-id="${id}"]`);
    this.removing = this.findRecord(id);
    this.removeError = undefined;
  }

  get removeOpen() {
    return Boolean(this.removing);
  }

  get removeText() {
    return this.removing
      ? `${this.removing.label} will no longer need approval to activate. Its history is kept: search Recent activity for it by name.`
      : "";
  }

  handleRemoveClose() {
    if (!this.saving) {
      this.removing = undefined;
    }
  }

  async handleRemoveConfirm() {
    const record = this.removing;
    this.saving = true;
    try {
      await governanceChange(() => removeGovernance({ id: record.id }));
      this.removing = undefined;
      this.dispatchEvent(
        new ShowToastEvent({
          title: "Governance removed",
          message: `${record.label} is no longer governed.`,
          variant: "success"
        })
      );
      await Promise.all([this.loadGoverned(), this.loadEvents()]);
    } catch (error) {
      this.removeError = errorText(error);
    } finally {
      this.saving = false;
    }
  }

  handleDismissError() {
    this.error = undefined;
  }
}

function versionText(version) {
  if (version === undefined || version === null) {
    return "—";
  }
  return version === 0 ? "None active" : `Version ${version}`;
}
