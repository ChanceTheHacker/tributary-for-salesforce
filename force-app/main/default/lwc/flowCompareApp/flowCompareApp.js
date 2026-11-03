/**
 * The Tributary page. Pick two versions of a flow, two different flows,
 * or a flow in two orgs; then compare them on the canvas or as XML, merge
 * them (optionally against a common base) and activate either version.
 *
 * The selection is kept in the URL so a comparison can be linked to:
 *   c__mode   versions | flows | orgs
 *   c__conn   connection of side A (default "local"), c__connB for side B
 *   c__flow   API name of A's flow, c__flowB for B's
 *   c__va     A's version number, c__vb for B's
 *   c__base   version number of A's flow to use as a merge base
 *   c__tab    compare | merge | activate
 */
import { LightningElement, wire } from "lwc";
import { CurrentPageReference, NavigationMixin } from "lightning/navigation";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import getUserContext from "@salesforce/apex/FlowCompareController.getUserContext";
import listConnections from "@salesforce/apex/FlowCompareController.listConnections";
import listFlows from "@salesforce/apex/FlowCompareController.listFlows";
import listVersions from "@salesforce/apex/FlowCompareController.listVersions";
import getVersion from "@salesforce/apex/FlowCompareController.getVersion";
import getVersionByName from "@salesforce/apex/FlowCompareController.getVersionByName";
import { diffFlows } from "c/flowDiff";
import { diffCounts } from "c/flowScene";
import {
  errorText,
  plural,
  formatDateTime,
  tabApiName,
  modeLabel,
  visibleText
} from "c/flowUtils";

const VERSIONS = "versions";
const FLOWS = "flows";
const ORGS = "orgs";
const MODES = [VERSIONS, FLOWS, ORGS];

const COMPARE = "compare";
const MERGE = "merge";
const ACTIVATE = "activate";
const TABS = [COMPARE, MERGE, ACTIVATE];
const MODE_OPTIONS = [
  { label: "Versions of a flow", value: VERSIONS },
  { label: "Two flows", value: FLOWS },
  { label: "Two orgs", value: ORGS }
];
const SETUP_ERROR =
  /connection|credential|set up|setup|unauthori[sz]ed|invalid_grant|invalid_session|HTTP 40[13]|remote site/i;

const LOCAL = "local";

// Salesforce's version statuses, said plainly; the raw word stays in view.
const VERSION_STATUS = {
  Obsolete: "Obsolete (was active)",
  InvalidDraft: "Draft with errors"
};

// What a list reads as before it arrives, the same every time so options
// built from it are too.
const NONE = Object.freeze([]);
// Versions getVersion has answered for, as connection|id|modified. The
// browser keeps those answers across pages of the app, so one is likely
// quicker to ask for again than to wait on a read ahead for.
const answered = new Set();
// Enough for any afternoon's comparisons; past it, the oldest go.
const MOST_ANSWERED = 500;

const emptySide = (connection = LOCAL) => ({
  connection,
  apiName: undefined,
  version: undefined
});

const metadataOf = (record) =>
  record && record.Metadata ? record.Metadata : record;

// A flow's name without its own org's namespace. An org with a namespace puts
// it on every flow it holds, so trib__Order and cllc__Order are the same flow
// in two orgs. A flow's own name can't contain "__", so the prefix is
// everything up to the first one. A packaged flow keeps its package's prefix.
const homeName = (flow) =>
  flow.managed ? flow.apiName : flow.apiName.replace(/^[A-Za-z0-9]+__/, "");

// The record from whichever of a read and a read ahead answers first. A
// read ahead that finds nothing leaves it to the read, and a read that fails
// to the read ahead; when both fail, the read's error is the one given.
const firstOf = (read, ahead) =>
  Promise.any([
    read,
    ahead.then((record) => record || Promise.reject(new Error("Not found")))
  ]).catch((failure) => Promise.reject(failure.errors[0]));

export default class FlowCompareApp extends NavigationMixin(LightningElement) {
  compareMode = VERSIONS;
  tab = COMPARE;
  user;
  connections = [];
  flows = {};
  versions = {};
  a = emptySide();
  b = emptySide();
  useBase = false;
  baseVersion;
  loaded;
  loading = false;
  // Reading the user and connections, before anything can be chosen.
  starting = false;
  // The latest change of selection is still being read. An earlier one
  // still out doesn't count: its answer will be dropped.
  selecting = false;
  refreshing = 0;
  diffView = "split";
  diffLayout = "unified";
  diffSelection;
  requestId;
  pickersCollapsed = false;
  error;
  // Whether trying again could help: a failed request, not a missing flow.
  retryable = false;
  // A tab's view stays mounted once opened, so switching tabs keeps a
  // half-done merge and where the canvas was.
  compareOpened = false;
  mergeOpened = false;
  started = false;
  swaps = 0;
  // The version last saved from this comparison's merge, offered on the
  // Activate tab until the comparison changes.
  lastSaved;

  _pageRef;
  _writtenState;
  _pendingState;
  _records = {};
  // Flow and version lists on their way, so everything that asks for one
  // list while it's coming shares one request.
  _lists = {};
  // A refreshed list supersedes an earlier read even after the refresh ends.
  _listTokens = {};
  // A link that couldn't be shown yet, which Retry shows again.
  _retryState;
  _loadToken = 0;
  // Bumped by every change of selection, so a slow answer to an earlier
  // change can't overwrite a later one.
  _generation = 0;
  // Derived values, kept while their inputs are the same objects.
  _cache = {};
  // Versions the link the page opened with names, read by name while the
  // lists are read: each { connection, apiName, versionNumber, read }.
  _prefetch = [];
  _linkState;
  _prefetchedState;
  _prefetchTimer;
  // Set once the link is shown: later reads don't wait on the lists.
  _prefetchClosed = false;
  // start() has sent its first reads, so a read sent now goes on its own.
  _startSent = false;

  // Setup

  connectedCallback() {
    this.pickersCollapsed = Boolean(
      window.matchMedia && window.matchMedia("(max-width: 68.75em)").matches
    );
    this.start();
  }

  get pickersHidden() {
    return this.showView && this.pickersCollapsed && !this.error;
  }

  get pickersExpanded() {
    return String(!this.pickersHidden);
  }

  get pickerToggleLabel() {
    return this.pickersHidden ? "Edit comparison" : "Hide comparison fields";
  }

  get comparisonTitle() {
    if (!this.loaded) return "";
    const { compared, labels } = this.loaded;
    const name = this.flowOf(compared.a);
    return visibleText(
      `${name ? name.label : compared.a.apiName} · ${labels.before} ↔ ${labels.after}`
    );
  }

  handleTogglePickers() {
    this.pickersCollapsed = !this.pickersCollapsed;
  }

  async start() {
    this.starting = true;
    // This org's flows are what most pages show first, so they're asked for
    // alongside who the user is. A link waits for its own; without one, a
    // failure is reported below.
    const localFlows = this.ensureFlows(LOCAL);
    localFlows.catch(() => {});
    const context = Promise.all([getUserContext(), listConnections()]);
    this._startSent = true;
    this.schedulePrefetch();
    try {
      const [user, connections] = await context;
      this.user = user;
      this.connections = connections || [];
      this.started = true;
      if (this._pendingState) {
        const state = this._pendingState;
        this._pendingState = undefined;
        await this.applyState(state);
      } else {
        await localFlows;
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.starting = false;
    }
  }

  // A link that names its versions has their metadata read by flow name and
  // number now, alongside the first reads, instead of after the flow and
  // version lists that give each version's id: a round trip and a Tooling
  // read sooner. Aura sends the actions made in one tick as one request,
  // which the server runs one action after another, so each read is sent
  // from a timer of its own: after start()'s reads have gone, and after the
  // read before it. A read that fails or finds nothing is simply not used.
  schedulePrefetch() {
    if (!this._startSent || this._prefetchTimer || this._prefetchClosed) {
      return;
    }
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    this._prefetchTimer = setTimeout(() => {
      this._prefetchTimer = undefined;
      this.prefetch(this.linkedVersions(this._linkState));
    }, 0);
  }

  prefetch([next, ...rest]) {
    if (!next || this._prefetchClosed) {
      return;
    }
    const [connection, apiName, versionNumber] = next;
    this._prefetch.push({
      connection,
      apiName,
      versionNumber,
      read: getVersionByName({ connection, apiName, versionNumber }).catch(
        () => null
      )
    });
    if (rest.length) {
      // eslint-disable-next-line @lwc/lwc/no-async-operation
      setTimeout(() => this.prefetch(rest), 0);
    }
  }

  // The versions a link names, as [connection, flow name, version number],
  // read the way applyState reads the link.
  linkedVersions(state) {
    if (!state || !state.c__flow || state === this._prefetchedState) {
      return [];
    }
    this._prefetchedState = state;
    const mode = MODES.includes(state.c__mode) ? state.c__mode : VERSIONS;
    const connectionA = state.c__conn || LOCAL;
    const connectionB =
      mode === ORGS && state.c__connB ? state.c__connB : connectionA;
    const flowB =
      mode === VERSIONS ? state.c__flow : state.c__flowB || state.c__flow;
    const wanted = [];
    for (const [connection, apiName, number] of [
      [connectionA, state.c__flow, state.c__va],
      [connectionB, flowB, state.c__vb],
      [connectionA, state.c__flow, state.c__base]
    ]) {
      const versionNumber = Number(number);
      if (
        Number.isInteger(versionNumber) &&
        versionNumber > 0 &&
        !wanted.some(
          (item) =>
            item[0] === connection &&
            item[1] === apiName &&
            item[2] === versionNumber
        )
      ) {
        wanted.push([connection, apiName, versionNumber]);
      }
    }
    return wanted;
  }

  // Takes the reads prefetch() sent for the versions now chosen, when each
  // is the record the version list names, as last saved when the list was
  // read. Anything else is read as usual, so the time a version was
  // reviewed at stays the list's, pinned to what was compared.
  adoptPrefetched() {
    const reads = this._prefetch;
    this._prefetch = [];
    const selection = reads.length ? this.selection : undefined;
    if (!selection) {
      return;
    }
    for (const [side, version] of [
      [this.a, selection.versionA],
      [this.b, selection.versionB],
      [this.a, selection.base]
    ]) {
      const prefetched =
        version &&
        reads.find(
          (item) =>
            item.connection === side.connection &&
            item.versionNumber === version.versionNumber &&
            this.resolveFlowName(side.connection, item.apiName) === side.apiName
        );
      const key = prefetched && this.recordKey(side.connection, version);
      if (key && !this._records[key]) {
        const ahead = prefetched.read.then((found) =>
          found &&
          found.record &&
          found.id === version.id &&
          found.lastModifiedDate &&
          found.lastModifiedDate === version.lastModifiedDate
            ? JSON.parse(found.record)
            : null
        );
        // A version read before is asked for again too, and whichever
        // answers first is used.
        this.keepRecord(
          key,
          answered.has(key)
            ? firstOf(this.readRecord(side.connection, version), ahead)
            : ahead.then(
                (record) => record || this.readRecord(side.connection, version)
              )
        );
      }
    }
  }

  @wire(CurrentPageReference)
  setPageRef(pageRef) {
    this._pageRef = pageRef;
    const state = this.stateFrom(pageRef);
    const key = JSON.stringify(state);
    if (key === this._writtenState) {
      return;
    }
    this._writtenState = key;
    if (!state.c__flow && !state.c__mode) {
      return;
    }
    if (this.started) {
      this.applyState(state);
    } else {
      this._pendingState = state;
      this._linkState = state;
      this.schedulePrefetch();
    }
  }

  stateFrom(pageRef) {
    const state = (pageRef && pageRef.state) || {};
    const out = {};
    for (const key of Object.keys(state).sort()) {
      if (
        key.startsWith("c__") &&
        state[key] !== undefined &&
        state[key] !== ""
      ) {
        out[key] = String(state[key]);
      }
    }
    return out;
  }

  // Brings the page to a URL state: a link from an approval request, say.
  async applyState(state) {
    const stale = this.nextGeneration();
    this._retryState = state;
    // What went wrong with the last link doesn't apply to this one.
    this.error = undefined;
    try {
      const mode = MODES.includes(state.c__mode) ? state.c__mode : VERSIONS;
      const known = (name) =>
        this.connections.some((connection) => connection.name === name);
      const connectionA = known(state.c__conn) ? state.c__conn : LOCAL;
      const connectionB =
        mode === ORGS && known(state.c__connB) ? state.c__connB : connectionA;
      // A link to a connection that's gone shows another org, so say so.
      const unknown = [state.c__conn, mode === ORGS && state.c__connB].find(
        (name) => name && !known(name)
      );
      this.compareMode = mode;
      this.tab = TABS.includes(state.c__tab) ? state.c__tab : COMPARE;
      this.diffView = ["split", "unified", "text"].includes(state.c__view)
        ? state.c__view
        : "split";
      this.diffLayout = state.c__layout === "split" ? "split" : "unified";
      this.diffSelection = state.c__selected;
      this.requestId = state.c__request;
      await Promise.all([
        this.ensureFlows(connectionA),
        this.ensureFlows(connectionB)
      ]);
      if (stale()) {
        return;
      }
      const a = {
        connection: connectionA,
        apiName: this.resolveFlowName(connectionA, state.c__flow)
      };
      const b = {
        connection: connectionB,
        apiName: this.resolveFlowName(
          connectionB,
          mode === VERSIONS ? state.c__flow : state.c__flowB || state.c__flow
        )
      };
      const missing = [a, b].find((side) => side.apiName && !this.flowOf(side));
      await Promise.all([this.ensureVersions(a), this.ensureVersions(b)]);
      if (stale()) {
        return;
      }
      if (missing) {
        this.retryable = false;
        const where =
          missing.connection === LOCAL
            ? "this org"
            : this.connectionLabel(missing.connection);
        this.error = `There's no flow named ${missing.apiName} in ${where}. Choose one from the Flow list.`;
      }
      const defaults = this.defaultVersions(a, b, state.c__vb);
      a.version = this.versionOrDefault(a, state.c__va, defaults.a);
      b.version = this.versionOrDefault(b, state.c__vb, defaults.b);
      this.a = a;
      this.b = b;
      // A base that isn't a version of A's flow leaves the choice to the user.
      this.baseVersion = this.versionOrDefault(a, state.c__base, undefined);
      this.useBase = Boolean(state.c__base);
      // A link to a version that's gone shows another, so say so.
      const lost = missing
        ? undefined
        : [
            [a, state.c__va, "version"],
            [b, state.c__vb, "version"],
            [a, state.c__base, "base"]
          ].find(
            ([side, wanted, use]) =>
              this.versionLost(side, wanted) &&
              (use === "base" || side.version !== undefined)
          );
      this.adoptPrefetched();
      await this.load();
      if (stale() || this.error) {
        return;
      }
      if (unknown) {
        this.retryable = false;
        this.error = `There's no org connection named ${unknown}.`;
      } else if (lost) {
        const [side, wanted, use] = lost;
        const flow = this.flowOf(side);
        this.retryable = false;
        this.error =
          use === "base"
            ? `${flow.label} has no version ${wanted} to use as the base. Choose the base from the list.`
            : `${flow.label} has no version ${wanted}, so this shows version ${side.version}.`;
      }
    } catch (error) {
      if (!stale()) {
        this.fail(error);
      }
    } finally {
      if (!stale()) {
        this.selecting = false;
        if (!this.error) {
          this._retryState = undefined;
        }
      }
      // Only the link the page opened with is read ahead.
      this._prefetch = [];
      this._prefetchClosed = true;
    }
  }

  // Whether a link asks for a version the flow doesn't have.
  versionLost(side, wanted) {
    return (
      wanted !== undefined &&
      wanted !== "" &&
      this.flowOf(side) !== undefined &&
      this.versionOrDefault(side, wanted, null) === null
    );
  }

  versionOrDefault(side, wanted, fallback) {
    const number = Number(wanted);
    return this.versionList(side).some(
      (version) => version.versionNumber === number
    )
      ? number
      : fallback;
  }

  writeState() {
    const a = this.a;
    const b = this.b;
    const state = {
      c__mode: this.compareMode === VERSIONS ? undefined : this.compareMode,
      c__conn: a.connection === LOCAL ? undefined : a.connection,
      c__connB: this.compareMode === ORGS ? b.connection : undefined,
      c__flow: a.apiName,
      c__flowB: this.compareMode === VERSIONS ? undefined : b.apiName,
      c__va: a.version,
      c__vb: b.version,
      c__base: this.useBase ? this.baseVersion : undefined,
      c__tab: this.tab === COMPARE ? undefined : this.tab,
      c__view: this.diffView === "split" ? undefined : this.diffView,
      c__layout: this.diffLayout === "unified" ? undefined : this.diffLayout,
      c__selected: this.diffSelection,
      c__request: this.requestId
    };
    const clean = {};
    for (const key of Object.keys(state).sort()) {
      if (state[key] !== undefined && state[key] !== null) {
        clean[key] = String(state[key]);
      }
    }
    const key = JSON.stringify(clean);
    if (key === this._writtenState || !this._pageRef) {
      return;
    }
    this._writtenState = key;
    this[NavigationMixin.Navigate](
      {
        type: this._pageRef.type,
        attributes: this._pageRef.attributes,
        state: clean
      },
      true
    );
  }

  // Data

  async ensureFlows(connection) {
    if (!connection || this.flows[connection]) {
      return;
    }
    await this.fetchFlows(connection, false);
  }

  async fetchFlows(connection, refresh = true) {
    await this.shared(
      `flows|${connection}`,
      async (current) => {
        const result = await listFlows({ connection });
        if (!current()) {
          return;
        }
        const sorted = [...(result || [])].sort((p, q) =>
          (p.label || p.apiName).localeCompare(q.label || q.apiName)
        );
        this.flows = { ...this.flows, [connection]: sorted };
      },
      refresh
    );
  }

  async ensureVersions(side, refresh = false) {
    const flow = this.flowOf(side);
    if (!flow) {
      return;
    }
    const key = `${side.connection}|${flow.definitionId}`;
    if (this.versions[key] && !refresh) {
      return;
    }
    const fetch = async (current) => {
      const result = await listVersions({
        connection: side.connection,
        definitionId: flow.definitionId
      });
      if (!current()) {
        return;
      }
      const sorted = [...(result || [])].sort(
        (p, q) => q.versionNumber - p.versionNumber
      );
      this.versions = { ...this.versions, [key]: sorted };
    };
    // A refresh wants what's there now, not an answer already on its way.
    await this.shared(`versions|${key}`, fetch, refresh);
  }

  // One request for a list, however many ask for it before it arrives.
  // Only its latest read may change the list or report a failure.
  shared(key, fetch, refresh = false) {
    if (!this._lists[key] || refresh) {
      const token = (this._listTokens[key] || 0) + 1;
      this._listTokens[key] = token;
      const current = () => this._listTokens[key] === token;
      this._lists[key] = fetch(current)
        .catch((error) => {
          if (current()) {
            throw error;
          }
        })
        .finally(() => {
          if (current()) {
            delete this._lists[key];
          }
        });
    }
    return this._lists[key];
  }

  flowList(connection) {
    return this.flows[connection] || NONE;
  }

  // A link may name a namespaced flow without its prefix.
  resolveFlowName(connection, name) {
    const flows = this.flowList(connection);
    if (!name || flows.some((flow) => flow.apiName === name)) {
      return name;
    }
    const match = flows.find(
      (flow) => !flow.managed && homeName(flow) === name
    );
    return match ? match.apiName : name;
  }

  flowOf(side) {
    return this.flowList(side.connection).find(
      (flow) => flow.apiName === side.apiName
    );
  }

  // What side's flow is called in connection's org, when that org has it.
  sameFlowIn(connection, side) {
    const flows = this.flowList(connection);
    if (flows.some((flow) => flow.apiName === side.apiName)) {
      return side.apiName;
    }
    const flow = this.flowOf(side);
    const match =
      flow && flows.find((other) => homeName(other) === homeName(flow));
    return match ? match.apiName : undefined;
  }

  // A side's flow name as its source file would have it.
  homeNameOf(side) {
    const flow = this.flowOf(side);
    return flow ? homeName(flow) : side.apiName;
  }

  versionList(side) {
    const flow = this.flowOf(side);
    return (
      (flow && this.versions[`${side.connection}|${flow.definitionId}`]) || NONE
    );
  }

  versionOf(side) {
    return this.versionList(side).find(
      (version) => version.versionNumber === side.version
    );
  }

  // Sensible starting versions: for one flow, the active version against the
  // newest (or the two newest); otherwise each flow's active or newest.
  // With B named, A is what B would replace: the active version, or the
  // one before B.
  defaultVersions(a, b, wantedB) {
    const pick = (side) => {
      const flow = this.flowOf(side);
      const list = this.versionList(side);
      if (!flow || !list.length) {
        return undefined;
      }
      return flow.activeVersion || list[0].versionNumber;
    };
    if (this.compareMode !== VERSIONS) {
      return { a: pick(a), b: pick(b) };
    }
    const list = this.versionList(a);
    const flow = this.flowOf(a);
    if (!list.length) {
      return {};
    }
    const newest = list[0].versionNumber;
    const active = flow && flow.activeVersion;
    const named = this.versionOrDefault(a, wantedB, null);
    if (named !== null) {
      const earlier = list.find((version) => version.versionNumber < named);
      return {
        a:
          active && active !== named
            ? active
            : (earlier || list[0]).versionNumber,
        b: named
      };
    }
    if (active && active !== newest) {
      return { a: active, b: newest };
    }
    return {
      a: list.length > 1 ? list[1].versionNumber : newest,
      b: newest
    };
  }

  // A draft can be saved over in Flow Builder, so a version's content is
  // cached only as long as its modification time stays the same.
  async fetchRecord(connection, version) {
    const key = this.recordKey(connection, version);
    if (!this._records[key]) {
      this.keepRecord(key, this.readRecord(connection, version));
    }
    return this._records[key];
  }

  recordKey(connection, version) {
    return `${connection}|${version.id}|${version.lastModifiedDate || ""}`;
  }

  keepRecord(key, read) {
    this._records[key] = read;
    // A failed fetch can be retried.
    read.catch(() => {
      delete this._records[key];
    });
  }

  readRecord(connection, version) {
    // The modification time is part of the request too, so the browser's
    // own cache of the answer is kept no longer than this one.
    return getVersion({
      connection,
      versionId: version.id,
      modified: version.lastModifiedDate || ""
    }).then((text) => {
      const key = this.recordKey(connection, version);
      answered.delete(key);
      answered.add(key);
      if (answered.size > MOST_ANSWERED) {
        answered.delete(answered.values().next().value);
      }
      return JSON.parse(text);
    });
  }

  get selection() {
    const versionA = this.versionOf(this.a);
    const versionB = this.versionOf(this.b);
    if (!versionA || !versionB) {
      return undefined;
    }
    const base =
      this.useBase && this.baseVersion
        ? this.versionList(this.a).find(
            (version) => version.versionNumber === this.baseVersion
          )
        : undefined;
    return { versionA, versionB, base };
  }

  // Three-way merge is on, but there's no base to merge against yet.
  get needsBase() {
    const selection = this.selection;
    return Boolean(this.useBase && selection && !selection.base);
  }

  // The version records a selection names. A comparison is of these, so one
  // left on screen by a failed read can tell it isn't the one picked.
  selectedIds(selection) {
    if (!selection) {
      return undefined;
    }
    const { versionA, versionB, base } = selection;
    return [
      this.a.connection,
      versionA.id,
      this.b.connection,
      versionB.id,
      base ? base.id : ""
    ].join("|");
  }

  // Loads the chosen versions; everything the views need is built here once
  // so they get the same objects on every render.
  async load() {
    this.writeState();
    const selection = this.selection;
    if (!selection) {
      this.loaded = undefined;
      return;
    }
    const { versionA, versionB, base } = selection;
    const key = [
      this.a.connection,
      versionA.id,
      versionA.lastModifiedDate,
      this.b.connection,
      versionB.id,
      versionB.lastModifiedDate,
      base ? `${base.id}|${base.lastModifiedDate}` : ""
    ].join("|");
    if (this.loaded && this.loaded.key === key) {
      return;
    }
    const token = ++this._loadToken;
    this.loading = true;
    this.error = undefined;
    try {
      const [recordA, recordB, recordBase] = await Promise.all([
        this.fetchRecord(this.a.connection, versionA),
        this.fetchRecord(this.b.connection, versionB),
        base ? this.fetchRecord(this.a.connection, base) : undefined
      ]);
      if (token !== this._loadToken) {
        return;
      }
      const before = metadataOf(recordA);
      const after = metadataOf(recordB);
      const labels = this.labelsFor(versionA, versionB, base);
      const counts = diffCounts(diffFlows(before, after));
      this.loaded = {
        key,
        ids: this.selectedIds(selection),
        before,
        after,
        labels,
        counts,
        // Named, so merging two different flows maps one onto the other.
        // Each org's own namespace is left off, or one flow in two orgs
        // would look like two flows.
        mergeSides: base
          ? { base: metadataOf(recordBase), ours: before, theirs: after }
          : {
              before: { FullName: this.homeNameOf(this.a), Metadata: before },
              after: { FullName: this.homeNameOf(this.b), Metadata: after }
            },
        targets: this.mergeTargets(),
        lineage: this.lineageFor(labels, versionA, versionB, base),
        // When each side was last changed as compared. Activation is refused
        // for a version changed since, even after the lists are refreshed.
        reviewedAt: {
          a: versionA.lastModifiedDate || null,
          b: versionB.lastModifiedDate || null
        },
        // What was compared, so the view kept on screen while another
        // comparison loads still describes and activates its own versions.
        compared: {
          a: this.a,
          b: this.b,
          versionA,
          versionB,
          versions: this.isVersions
        },
        saveConnections: this.connections
      };
      this.compareOpened = false;
      this.mergeOpened = false;
    } catch (error) {
      if (token === this._loadToken) {
        this.fail(error);
        this.loaded = undefined;
      }
    } finally {
      if (token === this._loadToken) {
        this.loading = false;
      }
    }
  }

  connectionLabel(name) {
    const connection = this.connections.find((item) => item.name === name);
    return connection ? connection.label : name;
  }

  labelsFor(versionA, versionB, base) {
    // One flow in two orgs is told apart by its org alone.
    const sameFlow = this.homeNameOf(this.a) === this.homeNameOf(this.b);
    const name = (side, version) => {
      const flow = this.flowOf(side);
      const active = flow && flow.activeVersion === version.versionNumber;
      const number = `Version ${version.versionNumber}${active ? " (active)" : ""}`;
      if (this.compareMode === VERSIONS) {
        return number;
      }
      if (this.compareMode === FLOWS) {
        return `${flow.label} v${version.versionNumber}`;
      }
      const org = this.connectionLabel(side.connection);
      return sameFlow
        ? `${org} v${version.versionNumber}`
        : `${org}: ${flow.label} v${version.versionNumber}`;
    };
    const before = name(this.a, versionA);
    let after = name(this.b, versionB);
    if (after === before) {
      after = `${after} (B)`;
    }
    const labels = { before, after, ours: before, theirs: after };
    if (base) {
      labels.base = `Version ${base.versionNumber} (base)`;
    }
    return labels;
  }

  // The versions a merge is made from, for its receipt. Saving checks each
  // is still as it was when compared.
  lineageFor(labels, versionA, versionB, base) {
    const entry = (role, side, version) => ({
      role,
      label: labels[role],
      connection: side.connection,
      connectionLabel: this.connectionLabel(side.connection),
      apiName: side.apiName,
      versionNumber: version.versionNumber,
      versionId: version.id,
      lastModifiedDate: version.lastModifiedDate || null,
      lastModifiedBy: version.lastModifiedBy || null
    });
    return base
      ? [
          entry("base", this.a, base),
          entry("ours", this.a, versionA),
          entry("theirs", this.b, versionB)
        ]
      : [entry("before", this.a, versionA), entry("after", this.b, versionB)];
  }

  mergeTargets() {
    const targets = [];
    for (const side of [this.a, this.b]) {
      const flow = this.flowOf(side);
      if (
        flow &&
        !flow.managed &&
        !targets.some(
          (target) =>
            target.connection === side.connection &&
            target.apiName === flow.apiName
        )
      ) {
        targets.push({
          connection: side.connection,
          apiName: flow.apiName,
          label: `${flow.label}${this.compareMode === ORGS ? ` (${this.connectionLabel(side.connection)})` : ""}`,
          activeVersion: flow.activeVersion || null,
          // Saving refuses a version added since, which the merge left out.
          latestVersion: flow.latestVersion || null
        });
      }
    }
    return targets;
  }

  // Pickers

  // A getter runs on every render. Its value is built again only when its
  // inputs change, so a picker isn't handed a new list it would search anew.
  memo(name, inputs, build) {
    const entry = this._cache[name];
    if (entry && entry.inputs.every((input, i) => input === inputs[i])) {
      return entry.value;
    }
    const value = build();
    this._cache[name] = { inputs, value };
    return value;
  }

  get modeOptions() {
    return MODE_OPTIONS;
  }

  get connectionOptions() {
    const { connections } = this;
    return this.memo("connectionOptions", [connections], () =>
      connections.map((connection) => ({
        label: connection.isProduction
          ? `${connection.label} (production)`
          : connection.label,
        value: connection.name
      }))
    );
  }

  get hasManyConnections() {
    return this.connections.length > 1;
  }

  get isVersions() {
    return this.compareMode === VERSIONS;
  }

  get isOrgs() {
    return this.compareMode === ORGS;
  }

  get showConnectionA() {
    return this.hasManyConnections;
  }

  get showConnectionB() {
    return this.isOrgs;
  }

  get showFlowB() {
    return !this.isVersions;
  }

  get orgsUnavailable() {
    return this.isOrgs && !this.hasManyConnections;
  }

  flowOptions(name, connection) {
    const flows = this.flowList(connection);
    return this.memo(name, [flows], () =>
      flows.map((flow) => ({
        label:
          flow.label === flow.apiName
            ? flow.label
            : `${flow.label} (${flow.apiName})`,
        value: flow.apiName
      }))
    );
  }

  get flowOptionsA() {
    return this.flowOptions("flowOptionsA", this.a.connection);
  }

  get flowOptionsB() {
    return this.flowOptions("flowOptionsB", this.b.connection);
  }

  versionOptions(name, side) {
    const flow = this.flowOf(side);
    const list = this.versionList(side);
    const active = flow && flow.activeVersion;
    return this.memo(name, [list, active], () =>
      list.map((version) => {
        // Activating a version touches its LastModifiedDate, so date it by creation.
        const when = formatDateTime(
          version.createdDate || version.lastModifiedDate
        );
        return {
          label: `Version ${version.versionNumber}${active === version.versionNumber ? " · Active" : ` · ${VERSION_STATUS[version.status] || version.status}`}${when ? ` · ${when}` : ""}`,
          description: visibleText(
            [version.createdBy || version.lastModifiedBy, version.description]
              .filter(Boolean)
              .join(" · ")
              .slice(0, 180)
          ),
          value: String(version.versionNumber)
        };
      })
    );
  }

  get versionOptionsA() {
    return this.versionOptions("versionOptionsA", this.a);
  }

  get versionOptionsB() {
    return this.versionOptions("versionOptionsB", this.b);
  }

  // The base is a version of A's flow, so it picks from A's list.
  get baseOptions() {
    return this.versionOptionsA;
  }

  get valueVersionA() {
    return this.a.version ? String(this.a.version) : undefined;
  }

  get valueVersionB() {
    return this.b.version ? String(this.b.version) : undefined;
  }

  get valueBase() {
    return this.baseVersion ? String(this.baseVersion) : undefined;
  }

  get noFlowA() {
    return !this.flowOf(this.a);
  }

  get noFlowB() {
    return !this.flowOf(this.b);
  }

  get pickersClass() {
    return this.isVersions ? "pickers pickers-versions" : "pickers";
  }

  // Every picker names its side, so screen readers can tell them apart. With
  // versions of one flow, there's only the one flow.
  get flowLabelA() {
    return this.isVersions ? "Flow" : "Flow A";
  }

  // With versions of one flow, B's line leaves out what A's already says
  // about the flow.
  detailsFor(side, versionOnly = false) {
    const flow = this.flowOf(side);
    const version = this.versionOf(side);
    if (!flow) {
      return undefined;
    }
    const parts = [];
    if (version) {
      const when = formatDateTime(
        version.createdDate || version.lastModifiedDate
      );
      const by = version.createdBy || version.lastModifiedBy;
      if (by || when) {
        parts.push(`Created ${when}${by ? ` by ${by}` : ""}`);
      }
      if (version.description) parts.push(version.description);
    }
    if (versionOnly) {
      return visibleText(parts.join(" · "));
    }
    parts.push(
      flow.activeVersion
        ? `Active: version ${flow.activeVersion}`
        : "No active version"
    );
    if (flow.governanceMode && flow.governanceMode !== "Off") {
      parts.push(
        `${modeLabel(flow.governanceMode)}${flow.ownerName ? `, owned by ${flow.ownerName}` : ""}`
      );
    }
    if (flow.managed) {
      parts.push("Managed: can't be saved over");
    }
    return visibleText(parts.join(" · "));
  }

  get detailsA() {
    return this.detailsFor(this.a);
  }

  get detailsB() {
    return this.detailsFor(this.b, this.isVersions);
  }

  // Returns a check that says whether a later change has superseded this one.
  nextGeneration() {
    // Invalidate reads at selection time, including a selection with nothing
    // to load. A prior response must not revive its comparison or spinner.
    this._loadToken += 1;
    this.loading = false;
    this.selecting = true;
    const generation = ++this._generation;
    return () => generation !== this._generation;
  }

  // Runs a change of selection. The update is passed that check, and must
  // stop without changing anything once it's true after any await.
  async change(update) {
    const stale = this.nextGeneration();
    this.diffSelection = undefined;
    this.requestId = undefined;
    this.error = undefined;
    // A choice made here replaces any link still waiting to be shown.
    this._retryState = undefined;
    try {
      await update(stale);
      if (!stale() && !this.error) {
        await this.load();
      }
    } catch (error) {
      if (!stale()) {
        this.fail(error);
      }
    } finally {
      if (!stale()) {
        this.selecting = false;
      }
    }
  }

  handleCompareMode(event) {
    const mode = event.detail.value;
    this.change(async (stale) => {
      this.compareMode = mode;
      const a = { ...this.a };
      let b = { ...this.b };
      if (mode === VERSIONS) {
        b = { ...a, version: undefined };
      } else if (mode === FLOWS) {
        b = { ...b, connection: a.connection };
        if (
          !this.flowList(a.connection).some(
            (flow) => flow.apiName === b.apiName
          )
        ) {
          b.apiName = undefined;
          b.version = undefined;
        }
      } else {
        const other = this.connections.find(
          (connection) => connection.name !== a.connection
        );
        const connection = other ? other.name : a.connection;
        await this.ensureFlows(connection);
        b = { connection, apiName: this.sameFlowIn(connection, a) };
        await this.ensureVersions(b);
        if (stale()) {
          return;
        }
      }
      this.b = b;
      this.fillDefaults();
    });
  }

  fillDefaults() {
    const defaults = this.defaultVersions(this.a, this.b);
    if (!this.versionOf(this.a)) {
      this.a = { ...this.a, version: defaults.a };
    }
    if (!this.versionOf(this.b)) {
      this.b = { ...this.b, version: defaults.b };
    }
  }

  handleConnection(event) {
    const which = event.target.dataset.side;
    const connection = event.detail.value;
    this.change(async (stale) => {
      await this.ensureFlows(connection);
      if (stale()) {
        return;
      }
      if (which === "a") {
        this.a = { connection, apiName: this.sameFlowIn(connection, this.a) };
        if (!this.isOrgs) {
          this.b = { connection, apiName: this.sameFlowIn(connection, this.b) };
        }
      } else {
        // The same flow in the other org, when it has it.
        this.b = { connection, apiName: this.sameFlowIn(connection, this.a) };
      }
      await Promise.all([
        this.ensureVersions(this.a),
        this.ensureVersions(this.b)
      ]);
      if (!stale()) {
        this.fillDefaults();
      }
    });
  }

  handleFlow(event) {
    const which = event.target.dataset.side;
    const apiName = event.detail.value;
    this.change(async (stale) => {
      if (which === "a") {
        this.a = { connection: this.a.connection, apiName };
        if (this.isVersions) {
          this.b = { connection: this.a.connection, apiName };
        } else if (this.isOrgs && !this.b.apiName) {
          const same = this.sameFlowIn(this.b.connection, this.a);
          if (same) {
            this.b = { connection: this.b.connection, apiName: same };
          }
        }
        this.baseVersion = undefined;
      } else {
        this.b = { connection: this.b.connection, apiName };
      }
      // Picking a flow reloads its versions: someone may have saved since.
      const picked = which === "a" ? this.a : this.b;
      const other = which === "a" ? this.b : this.a;
      await this.ensureVersions(picked, true);
      await this.ensureVersions(other);
      if (!stale()) {
        this.fillDefaults();
      }
    });
  }

  handleVersion(event) {
    const which = event.target.dataset.side;
    const version = Number(event.detail.value);
    this.change(async () => {
      // A base nobody chose follows the versions it was the default for.
      const followed =
        this.useBase &&
        (!this.baseVersion || this.baseVersion === this.defaultBase());
      this[which] = { ...this[which], version };
      if (followed) {
        this.baseVersion = this.defaultBase();
      }
    });
  }

  // The newest version older than both sides: the likely common ancestor.
  defaultBase() {
    const lowest = Math.min(this.a.version || 0, this.b.version || 0);
    const older = this.versionList(this.a).find(
      (version) => version.versionNumber < lowest
    );
    return older ? older.versionNumber : undefined;
  }

  // A base should come before both edits; one that doesn't is likely a slip.
  get baseWarning() {
    if (!this.useBase || !this.baseVersion || !this.isVersions) {
      return undefined;
    }
    const later = [this.a.version, this.b.version].filter(
      (version) => version && version <= this.baseVersion
    );
    if (!later.length) {
      return undefined;
    }
    const suggested = this.defaultBase();
    return `Version ${this.baseVersion} isn't older than version ${later[0]}, so it can't be where that edit started.${suggested ? ` Version ${suggested} is the newest one older than both.` : ""}`;
  }

  // The icon turns half a circle on each swap.
  get swapStyle() {
    return `transform: rotate(${this.swaps * 180}deg);`;
  }

  handleSwap() {
    this.swaps += 1;
    this.change(async () => {
      const a = this.a;
      this.a = this.b;
      this.b = a;
      this.baseVersion = undefined;
      this.useBase = false;
    });
  }

  handleUseBase(event) {
    const checked = event.target.checked;
    this.change(async () => {
      this.useBase = checked;
      if (checked && !this.baseVersion) {
        this.baseVersion = this.defaultBase();
      }
    });
  }

  handleBase(event) {
    const version = Number(event.detail.value);
    this.change(async () => {
      this.baseVersion = version;
    });
  }

  get canSwap() {
    return Boolean(this.flowOf(this.a) && this.flowOf(this.b) && !this.isBusy);
  }

  get swapDisabled() {
    return !this.canSwap;
  }

  get baseHelp() {
    return this.isVersions
      ? "Merge two edits of a common earlier version: changes only one side made are taken automatically, and you pick where both changed."
      : "The version of Flow A both flows started from.";
  }

  // Views

  get isBusy() {
    return (
      this.starting || this.selecting || this.loading || this.refreshing > 0
    );
  }

  // A comparison stays on screen while the next one loads, and while a
  // background refresh after a save or activation runs, so its merge picks
  // and open save dialog survive.
  get showView() {
    return Boolean(this.loaded);
  }

  // Whether the comparison on screen is the one chosen. While another
  // loads it can be seen but not used: the pickers already say otherwise.
  // So too after a choice whose lists couldn't be read, until the pickers
  // name its versions again. A refresh that fails leaves them as they were.
  get ready() {
    return (
      Boolean(this.loaded) &&
      !this.loading &&
      !this.selecting &&
      this.loaded.ids === this.selectedIds(this.selection)
    );
  }

  get approvalComparison() {
    return this.ready && !this.error ? this.loaded.compared : undefined;
  }

  renderedCallback() {
    // inert isn't yet recognized by the LWC template compiler.
    const panel = this.template.querySelector(".panel");
    if (panel) panel.toggleAttribute("inert", !this.ready);
  }

  get panelBusy() {
    return this.ready ? "false" : "true";
  }

  get panelClass() {
    return this.ready ? "panel" : "panel panel-waiting";
  }

  // One entry, keyed by the comparison, so its views are made afresh for a
  // different comparison and kept when a change comes back to the same one.
  get views() {
    const key = this.loaded && this.loaded.key;
    return this.memo("views", [key], () =>
      key
        ? [
            {
              key,
              compareId: "tab-panel-compare",
              mergeId: "tab-panel-merge",
              activateId: "tab-panel-activate"
            }
          ]
        : []
    );
  }

  // The skeleton stands in for a comparison still to come; over one that's
  // showing, a thin bar says something is on its way instead.
  get showSkeleton() {
    return this.isBusy && !this.showView;
  }

  get showBusyBar() {
    return this.isBusy && this.showView;
  }

  get loadingText() {
    const selection = this.loading && this.selection;
    if (selection) {
      const { before, after } = this.labelsFor(
        selection.versionA,
        selection.versionB,
        selection.base
      );
      return `Loading ${before} and ${after}…`;
    }
    return this.started ? "Loading versions…" : "Loading flows…";
  }

  get emptyTitle() {
    if (!this.started) {
      return "";
    }
    if (this.orgsUnavailable) {
      return "Connect a second org";
    }
    if (!this.flowList(this.a.connection).length) {
      return "No flows yet";
    }
    return this.isVersions
      ? "Pick two versions to compare"
      : "Pick a flow on each side";
  }

  get emptyText() {
    if (!this.started) {
      return "";
    }
    if (this.orgsUnavailable) {
      return "Comparing orgs needs a second connection. An admin can add one on the Tributary Setup tab.";
    }
    if (!this.flowList(this.a.connection).length) {
      return "No flows found in this org.";
    }
    return this.isVersions
      ? "Pick a flow and two of its versions. Added elements show in green, removed in red and changed in amber."
      : "Pick a flow and version on each side. Added elements show in green, removed in red and changed in amber. To bring B's elements into A, open Merge: its Mapping tab matches what B uses to A's variables and records.";
  }

  get showEmpty() {
    return !this.showView && !this.isBusy && !this.error;
  }

  get tabs() {
    const current = this.tab;
    return this.memo("tabs", [current], () =>
      [
        { value: COMPARE, label: "Compare" },
        { value: MERGE, label: "Merge" },
        { value: ACTIVATE, label: "Activate" }
      ].map((tab) => {
        const selected = tab.value === current;
        return {
          ...tab,
          id: `tab-${tab.value}`,
          panelId: `tab-panel-${tab.value}`,
          className: selected ? "tab tab-active" : "tab",
          selected: selected ? "true" : "false",
          tabIndex: selected ? "0" : "-1"
        };
      })
    );
  }

  // The help video for the open tab.
  get tabHelp() {
    return this.isCompare ? "views" : this.isMerge ? "merge" : "activate";
  }

  selectTab(value) {
    this.compareOpened = this.compareOpened || this.isCompare;
    this.mergeOpened = this.mergeOpened || this.isMerge;
    this.tab = value;
    this.writeState();
  }

  handleTab(event) {
    this.selectTab(event.currentTarget.dataset.tab);
  }

  // Arrow keys, Home and End move between tabs, as in any tab list.
  handleTabKey(event) {
    const index = TABS.indexOf(this.tab);
    const moves = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: TABS.length - 1
    };
    if (!(event.key in moves)) {
      return;
    }
    event.preventDefault();
    const next = TABS[(moves[event.key] + TABS.length) % TABS.length];
    this.selectTab(next);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    requestAnimationFrame(() => {
      const tab = this.template.querySelector(`[data-tab="${next}"]`);
      if (tab) {
        tab.focus();
      }
    });
  }

  get isCompare() {
    return this.tab === COMPARE;
  }

  get isMerge() {
    return this.tab === MERGE;
  }

  get isActivate() {
    return this.tab === ACTIVATE;
  }

  get mountCompare() {
    return this.isCompare || this.compareOpened;
  }

  get mountMerge() {
    return this.isMerge || this.mergeOpened;
  }

  get compareClass() {
    return this.isCompare ? "tab-panel" : "tab-panel slds-hide";
  }

  get mergeClass() {
    return this.isMerge ? "tab-panel" : "tab-panel slds-hide";
  }

  // Each connection says whether this user may save to it; saving to another
  // org doesn't need permission to save in this one.
  get canSave() {
    return this.connections.some((connection) => connection.canSave);
  }

  get summaryText() {
    if (!this.loaded) {
      return "";
    }
    const { counts } = this.loaded;
    const parts = [];
    if (counts.added) {
      parts.push(`${counts.added} added`);
    }
    if (counts.removed) {
      parts.push(`${counts.removed} removed`);
    }
    if (counts.changed) {
      parts.push(`${counts.changed} changed`);
    }
    if (counts.connectors) {
      parts.push(plural(counts.connectors, "connector") + " changed");
    }
    if (counts.moved) {
      parts.push(`${counts.moved} moved`);
    }
    if (counts.resources) {
      parts.push(plural(counts.resources, "resource") + " changed");
    }
    if (counts.properties) {
      parts.push(
        plural(counts.properties, "flow property", "flow properties") +
          " changed"
      );
    }
    // A request keeps this, so which version was active is dated.
    const before = this.loaded.labels.before.replace(
      " (active)",
      " (active at the time)"
    );
    return parts.length
      ? `Compared with ${before}: ${parts.join(", ")}.`
      : `Same as ${before}.`;
  }

  activationFor(side, version) {
    const flow = this.flowOf(side);
    if (!flow || !version) {
      return undefined;
    }
    return {
      key: `${side.connection}|${flow.apiName}|${version.versionNumber}`,
      connection: side.connection,
      connectionLabel: this.connectionLabel(side.connection),
      apiName: flow.apiName,
      label: flow.label,
      versionNumber: version.versionNumber,
      versionId: version.id,
      activeVersion: flow.activeVersion || null,
      managed: flow.managed
    };
  }

  get activations() {
    if (!this.loaded) {
      return [];
    }
    const { labels, compared } = this.loaded;
    const after = this.activationFor(compared.b, compared.versionB);
    const before = this.activationFor(compared.a, compared.versionA);
    const saved = this.savedActivation();
    const list = [];
    if (saved) {
      list.push({
        ...saved,
        title: `Version ${saved.versionNumber} (saved merge)`,
        summary: this.lastSaved.summary || "",
        checks: this.lastSaved.checks,
        comparedVersion: null,
        reviewedAt: this.lastSaved.reviewedAt || null,
        mark: "M",
        markClass: "side-mark side-mark-saved",
        role: "saved from the merge",
        secondary: false
      });
    }
    if (after && !(saved && saved.key === after.key)) {
      list.push({
        ...after,
        title: labels.after,
        summary: this.summaryText,
        reviewedAt: this.loaded.reviewedAt.b,
        // So a reviewer can open the comparison the summary describes.
        comparedVersion: compared.versions
          ? compared.versionA.versionNumber
          : null,
        mark: "B",
        markClass: "side-mark side-mark-b",
        role: compared.versions ? "compared version" : "compared flow",
        secondary: Boolean(saved)
      });
    }
    // Versions of one flow: the baseline can be activated too. Another flow
    // or org's baseline isn't offered: comparing with it isn't a reason to
    // change what runs there.
    if (
      compared.versions &&
      before &&
      !list.some((item) => item.key === before.key)
    ) {
      const active = before.activeVersion;
      list.push({
        ...before,
        title: labels.before,
        summary: "",
        comparedVersion: null,
        reviewedAt: this.loaded.reviewedAt.a,
        mark: "A",
        markClass: "side-mark side-mark-a",
        role:
          active && before.versionNumber < active
            ? "Version A, older than the active one"
            : "Version A",
        secondary: list.length > 0
      });
    }
    return list;
  }

  // The merge's saved version, once the version list has it.
  savedActivation() {
    const saved = this.lastSaved;
    if (!saved || !this.loaded || saved.key !== this.loaded.key) {
      return undefined;
    }
    const side = { connection: saved.connection, apiName: saved.apiName };
    const version = this.versionList(side).find(
      (item) => item.versionNumber === saved.versionNumber
    );
    return this.activationFor(side, version);
  }

  handleDiffView(event) {
    this.diffView = event.detail.view;
    if (event.detail.layout) this.diffLayout = event.detail.layout;
    this.writeState();
  }

  handleDiffSelection(event) {
    this.diffSelection = event.detail.id;
    this.writeState();
  }

  // Something was saved or activated: refresh the lists it changed.
  async refresh(connection, apiName) {
    this.refreshing += 1;
    try {
      await this.fetchFlows(connection);
      const side = { connection, apiName };
      await this.ensureVersions(side, true);
    } catch (error) {
      this.fail(error);
    } finally {
      this.refreshing -= 1;
    }
  }

  handleSaved(event) {
    const { result, connection, label, summary, checks } = event.detail;
    this.lastSaved = {
      key: this.loaded && this.loaded.key,
      connection,
      apiName: result.apiName,
      versionNumber: result.versionNumber,
      summary,
      checks,
      // Activating it refuses a version changed after it was saved.
      reviewedAt: result.lastModifiedDate || null
    };
    // The version just saved is this merge's own, so saving the merge again
    // doesn't count it as one the merge left out.
    if (this.loaded) {
      this.loaded = {
        ...this.loaded,
        targets: this.loaded.targets.map((target) =>
          target.connection === connection &&
          target.apiName === result.apiName &&
          (target.latestVersion || 0) < result.versionNumber
            ? { ...target, latestVersion: result.versionNumber }
            : target
        )
      };
    }
    this.dispatchEvent(
      new ShowToastEvent({
        title: "Saved",
        message: `Saved version ${result.versionNumber} of ${label || result.apiName}.`,
        variant: "success"
      })
    );
    this.refresh(connection, result.apiName);
  }

  // Saving was refused because a source changed or a newer version was
  // saved: read the lists again and load what they now hold.
  async handleRecompare() {
    await this.change(async (stale) => {
      const targets = this.loaded ? this.loaded.targets : [];
      const sides = [this.a, this.b].filter(
        (side, index, all) =>
          side.connection &&
          side.apiName &&
          all.findIndex(
            (other) =>
              other.connection === side.connection &&
              other.apiName === side.apiName
          ) === index
      );
      await Promise.all(
        sides.map((side) => this.refresh(side.connection, side.apiName))
      );
      if (stale() || this.error) {
        return;
      }
      // Advancing the save checkpoint without reading the new version would
      // bypass the stale-save refusal and silently leave its changes out.
      for (const which of this.isVersions ? ["b"] : ["a", "b"]) {
        const side = this[which];
        const flow = this.flowOf(side);
        const target = targets.find(
          (item) =>
            item.connection === side.connection && item.apiName === side.apiName
        );
        if (
          flow &&
          target &&
          flow.latestVersion > (target.latestVersion || 0)
        ) {
          this[which] = { ...side, version: flow.latestVersion };
        }
      }
      // Even unchanged metadata can have refreshed targets or source details.
      this.loaded = undefined;
    });
  }

  handleActivated(event) {
    const item = event.currentTarget.dataset;
    this.afterActivation(item.connection, item.apiName);
  }

  // A merged flow saved and then activated from the save dialog.
  handleMergeActivated(event) {
    const { connection, apiName } = event.detail;
    this.afterActivation(connection, apiName);
  }

  afterActivation(connection, apiName) {
    this.refresh(connection, apiName).then(() => {
      // The labels say which version is active.
      const selection = this.selection;
      if (this.loaded && selection) {
        this.loaded = {
          ...this.loaded,
          labels: this.labelsFor(
            selection.versionA,
            selection.versionB,
            selection.base
          )
        };
      }
    });
  }

  handleDismissError() {
    this.error = undefined;
  }

  fail(error) {
    this.error = errorText(error);
    this.retryable = true;
  }

  get showRetry() {
    return Boolean(this.error && this.retryable);
  }

  // Asks again for whatever failed: the org connections, a link being
  // opened, the flow and version lists, or the versions themselves.
  handleRetry() {
    this.error = undefined;
    if (!this.started) {
      this.start();
      return;
    }
    if (this._retryState) {
      this.applyState(this._retryState);
      return;
    }
    this.change(async () => {
      const connections = new Set([this.a.connection, this.b.connection]);
      await Promise.all(
        [...connections].map((connection) => this.ensureFlows(connection))
      );
      await Promise.all([
        this.ensureVersions(this.a),
        this.ensureVersions(this.b)
      ]);
    });
  }

  // Only a connection problem is something Setup can fix.
  get showSetupLink() {
    return Boolean(
      this.user &&
      this.user.isAdmin &&
      this.error &&
      SETUP_ERROR.test(this.error)
    );
  }

  handleOpenSetup() {
    this[NavigationMixin.Navigate]({
      type: "standard__navItemPage",
      attributes: { apiName: tabApiName(this._pageRef, "Flow_Compare_Setup") }
    });
  }
}
