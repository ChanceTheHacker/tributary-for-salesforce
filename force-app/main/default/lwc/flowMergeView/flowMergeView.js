/**
 * Merges flows visually. The canvas shows the merged result against the
 * flow it started from: taken additions in green, dropped elements in red,
 * changed ones in amber, and elements the result leaves out faded so they
 * can be brought in. Picking a side for an element or any single part of it
 * redraws the result; conflicts and problems are badged on the elements.
 *
 * Sides: { before, after } (two-way: start from before, take changes from
 * after) or { base, ours, theirs } (three-way: combine two edits of a base).
 * Each is a flow's Metadata, or { FullName, Metadata }. When the two-way
 * sides are different flows, the other flow is first mapped onto this one
 * (its record and variables onto this flow's), and the merge is against
 * this flow with the other's elements added. The XML view merges the same
 * flows line by line instead.
 *
 * Several elements can be picked together (Shift- or Ctrl-click) and taken,
 * left out or put on a path in one step; the Groups tab lists the changes
 * that belong together.
 *
 * Events: saved { result, connection, receipt, summary } and activated
 * { connection, apiName }, passed on from the save dialog, and recompare
 * when saving was refused because what the merge was made from changed.
 */
import { LightningElement, api } from "lwc";
import {
  createMerge,
  resolveMerge,
  changedUnits,
  editableText,
  textPick,
  presetPicks,
  reconnectFix,
  changeGroups,
  groupPicks,
  insertPicks,
  unitsForNode,
  wiresOf,
  SAME,
  THREE_WAY,
  CONFLICT,
  ERROR
} from "c/flowMerge";
import {
  isCrossFlow,
  planMapping,
  suggestedChoices,
  translateFlow,
  withMappingIssues
} from "c/flowMapping";
import { mergeLayout, mergeScene, flowScene, EXCLUDED } from "c/flowScene";
import { nodeId } from "c/flowLayout";
import { START, buildModel, toMetadata } from "c/flowModel";
import {
  plural,
  humanize,
  unitTitle,
  fillWindow,
  DRAFTS,
  readDraft,
  writeDraft
} from "c/flowUtils";
import { formatValue } from "c/flowElements";
import { toXml } from "c/flowXml";

const CANVAS = "canvas";
const TEXT = "text";
const KIND_ICON = {
  node: "utility:layers",
  field: "utility:edit_form",
  order: "utility:sort",
  pos: "utility:move",
  edge: "utility:connected_apps",
  resource: "utility:variable",
  prop: "utility:settings"
};

const metadataOf = (side) => (side && side.Metadata ? side.Metadata : side);
const WIRE = "wire|";
// How many changes back undo reaches.
const HISTORY = 100;
// Differences listed at a time, so a merge with hundreds of them mounts
// one page of pickers.
const PAGE_SIZE = 50;

export default class FlowMergeView extends LightningElement {
  /** Names for each side. */
  @api labels = {};
  /** Connections and target flows, passed to the save dialog. */
  @api connections = [];
  @api targets = [];
  @api canSave = false;
  /**
   * The flow versions the merge was made from, for its receipt:
   * [{ role, label, connection, connectionLabel, apiName, versionNumber,
   * versionId, lastModifiedDate, lastModifiedBy }].
   */
  @api lineage = [];

  mode = CANVAS;
  picks = {};
  selection;
  resultOnly = false;
  onlyConflicts = false;
  // The page of differences shown, from 0.
  changePage = 0;
  // Moves are listed only when asked for: they change nothing the flow does.
  showMoves = false;
  panelTab = "changes";
  saveOpen = false;
  textResult;
  // The XML merge stays mounted once opened, so its picks and hand edits
  // survive switching back to the visual merge.
  textOpened = false;
  // A flow property being stepped to; it has no element to select.
  stepProp;
  // Read out after stepping: where the stepper is and what it's on.
  announcement = "";
  // Rows picked while only unresolved conflicts show; they stay until
  // focus leaves them, so arrowing through a row's choices works.
  keptRows = {};
  // The merge as last saved, so it isn't saved twice by mistake.
  savedAs;
  // Picks brought back from an earlier visit; cleared by a new pick.
  restoredCount = 0;
  // Keys of elements picked together on the canvas.
  marked = [];
  // How the other flow maps onto this one, when they're different flows;
  // undefined for the suggestions.
  mapping;
  // Earlier and undone states of the merge, { picks, mapping }: each
  // action (a pick, a group, a placement, a preset, a mapping) is one step.
  undoStack = [];
  redoStack = [];
  _sides;
  _draftKey;
  _draftFor;
  // Derived data, filled while rendering; not reactive.
  _cache = {};
  _saveCount = 0;
  _pendingReveal;
  // A page of differences was turned to, so its top comes into view.
  _pageTurned = false;
  // A mapping row to focus once the Mapping tab shows.
  _pendingMapping;

  @api
  get sides() {
    return this._sides;
  }
  set sides(value) {
    this._sides = value;
    this._cache = {};
    this.mapping = undefined;
    this.marked = [];
    this.picks = {};
    this.selection = undefined;
    this.stepProp = undefined;
    this.textResult = undefined;
    this.textOpened = this.mode === TEXT;
    this.keptRows = {};
    this.changePage = 0;
    this.savedAs = undefined;
    this.undoStack = [];
    this.redoStack = [];
    this.panelTab = value && this.crossFlow ? "mapping" : "changes";
    this.restoreDraft();
  }

  /**
   * Identifies the versions being merged, changing whenever they do; picks
   * are kept under it so they survive a page reload.
   */
  @api
  get draftKey() {
    return this._draftKey;
  }
  set draftKey(value) {
    this._draftKey = value;
    this.restoreDraft();
  }

  // Once per merge, brings back the picks made before a reload: only those
  // that still name a part of this merge and one of its sides.
  restoreDraft() {
    const key = this._draftKey;
    const draftFor = this._draftFor;
    // The key and the sides may arrive in either order.
    if (
      !key ||
      !this._sides ||
      (draftFor && draftFor.sides === this._sides && draftFor.key === key)
    ) {
      return;
    }
    this._draftFor = { sides: this._sides, key };
    if (this.crossFlow) {
      const mapping = readDraft(DRAFTS.mapping, key);
      this.mapping =
        mapping && mapping.roots && mapping.elements ? mapping : undefined;
      this.clearMerge();
    }
    const picks = this.keepPicks(readDraft(DRAFTS.picks, key) || {});
    this.picks = picks;
    this.restoredCount = Object.keys(picks).length;
    // Undo sets the restored picks aside, to start afresh.
    this.undoStack = this.restoredCount
      ? [{ picks: {}, mapping: this.mapping }]
      : [];
    this.redoStack = [];
  }

  // The picks that still name a part of this merge and one of its sides,
  // and connectors sent to an element or nowhere.
  keepPicks(saved) {
    const merge = this.merge;
    const picks = {};
    for (const [id, value] of Object.entries(saved)) {
      const keep = id.startsWith(WIRE)
        ? value === null ||
          value === "" ||
          (typeof value === "string" && merge.nodeKeys.includes(value))
        : merge.units.has(id) &&
          (merge.names.includes(value) || textPick(merge.units.get(id), value));
      if (keep) {
        picks[id] = value;
      }
    }
    return picks;
  }

  clearMerge() {
    const cache = this._cache;
    cache.merge = undefined;
    cache.resolved = undefined;
    cache.scene = undefined;
    cache.textSides = undefined;
    cache.translation = undefined;
  }

  // Every change of picks goes through here, so the draft keeps up.
  setPicks(picks) {
    this.picks = picks;
    this.restoredCount = 0;
    if (this._draftKey) {
      writeDraft(DRAFTS.picks, this._draftKey, picks);
    }
  }

  get merge() {
    const cache = this._cache;
    if (!cache.merge && this._sides) {
      cache.merge = createMerge(
        this.crossFlow
          ? { before: this.sideModels.before, after: this.translation.model }
          : this._sides
      );
    }
    return cache.merge;
  }

  // Mapping

  get sideModels() {
    const cache = this._cache;
    if (!cache.sideModels) {
      const { before, after } = this._sides;
      cache.sideModels = {
        before: before && buildModel(before),
        after: after && buildModel(after)
      };
    }
    return cache.sideModels;
  }

  // Whether the two-way sides are different flows, merged through a
  // mapping.
  get crossFlow() {
    const sides = this._sides;
    if (!sides || sides.base || !sides.before || !sides.after) {
      return false;
    }
    const { before, after } = this.sideModels;
    return isCrossFlow(before, after);
  }

  get plan() {
    const cache = this._cache;
    if (!cache.plan) {
      cache.plan = planMapping(this.sideModels.before, this.sideModels.after);
    }
    return cache.plan;
  }

  get mappingChoices() {
    return this.mapping || suggestedChoices(this.plan);
  }

  // The other flow in this flow's names, with this flow's elements.
  get translation() {
    const cache = this._cache;
    if (!cache.translation) {
      cache.translation = translateFlow(
        this.sideModels.before,
        this.sideModels.after,
        this.mappingChoices,
        this.plan
      );
    }
    return cache.translation;
  }

  get mappingNotes() {
    return this.translation.notes;
  }

  get mappingIssues() {
    return this.translation.issues;
  }

  // A new mapping is a new merge: picks for parts it no longer has go.
  handleMappingChange(event) {
    this.remember();
    this.setMapping(event.detail.choices);
    this.setPicks(this.keepPicks(this.picks));
  }

  setMapping(choices) {
    this.mapping = choices;
    if (this._draftKey) {
      writeDraft(DRAFTS.mapping, this._draftKey, choices || {});
    }
    this.clearMerge();
    this.marked = this.marked.filter((key) =>
      this.merge.nodeKeys.includes(key)
    );
    this.selection = undefined;
  }

  // Undo and redo

  // Every edit comes through here, so a message about an earlier one
  // (undone, redone, stepped to) goes, rather than standing as the status.
  remember() {
    this.undoStack = [
      ...this.undoStack.slice(1 - HISTORY),
      { picks: this.picks, mapping: this.mapping }
    ];
    this.redoStack = [];
    this.announcement = "";
  }

  get cannotUndo() {
    return !this.undoStack.length;
  }

  get cannotRedo() {
    return !this.redoStack.length;
  }

  // Moves one step from one stack to the other, putting the merge back as
  // it was then.
  travel(from, to, done) {
    const state = this[from][this[from].length - 1];
    if (!state) {
      return;
    }
    this[from] = this[from].slice(0, -1);
    this[to] = [...this[to], { picks: this.picks, mapping: this.mapping }];
    if (state.mapping !== this.mapping) {
      this.setMapping(state.mapping);
    }
    this.setPicks(state.picks);
    this.announcement = done;
  }

  handleUndo() {
    this.travel("undoStack", "redoStack", "Undid the last change");
  }

  handleRedo() {
    this.travel("redoStack", "undoStack", "Redid the change");
  }

  // Ctrl+Z (Cmd+Z) undoes, Ctrl+Shift+Z or Ctrl+Y redoes, except while
  // typing, where they're the field's own.
  handleViewKey(event) {
    if (!this.isCanvas || !(event.ctrlKey || event.metaKey) || event.altKey) {
      return;
    }
    const key = (event.key || "").toLowerCase();
    const undo = key === "z" && !event.shiftKey;
    const redo =
      (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
    const origin = event.composedPath ? event.composedPath()[0] : event.target;
    const typing =
      origin &&
      (origin.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(origin.tagName || ""));
    if ((!undo && !redo) || typing) {
      return;
    }
    event.preventDefault();
    if (undo) {
      this.handleUndo();
    } else {
      this.handleRedo();
    }
  }

  // Puts every element the other flow brings on a path, from its first.
  handleMappingPlace(event) {
    const { afterKey, slot, first, routes } = event.detail;
    const { added, entry } = this.mappingNotes;
    this.applyPicks(
      insertPicks(
        this.merge,
        this.resolved,
        added,
        "after",
        afterKey,
        slot,
        first || entry,
        routes
      )
    );
  }

  get resolved() {
    const cache = this._cache;
    if (cache.resolvedFor !== this.picks || !cache.resolved) {
      // A different flow's mapping problems count with the merge's own.
      cache.resolved = withMappingIssues(
        resolveMerge(this.merge, this.picks),
        this.crossFlow ? this.translation : undefined
      );
      cache.resolvedFor = this.picks;
      cache.layout = mergeLayout(this.merge, cache.resolved);
      cache.scene = undefined;
    }
    return cache.resolved;
  }

  get ready() {
    return Boolean(this.merge);
  }

  get threeWay() {
    return this.merge.mode === THREE_WAY;
  }

  // A derived list kept until one of its inputs changes: the sidebar reads
  // its rows several times a render, and the tabs count them.
  memo(name, inputs, build) {
    const entry = this._cache[name];
    if (entry && entry.inputs.every((input, i) => input === inputs[i])) {
      return entry.value;
    }
    const value = build();
    this._cache[name] = { inputs, value };
    return value;
  }

  // The conflicts no side has been picked for yet, to look up by unit.
  get openConflicts() {
    const { resolved } = this;
    return this.memo(
      "openConflicts",
      [resolved],
      () => new Set(resolved.conflicts)
    );
  }

  label(side) {
    if (side === "custom") return "edited text";
    return (this.labels && this.labels[side]) || side;
  }

  // Labels for the panels, whose diff compares the starting side with the
  // result; in a three-way merge that's ours.
  get panelLabels() {
    if (this.threeWay) {
      return {
        ...this.labels,
        before: this.label("ours"),
        after: "Merged result"
      };
    }
    return this.labels;
  }

  get sideLabels() {
    const labels = {};
    for (const name of this.merge.names) {
      labels[name] = this.label(name);
    }
    return labels;
  }

  // The scene and its diff, rebuilt when the picks change.
  get sceneAndDiff() {
    const resolved = this.resolved;
    const cache = this._cache;
    if (!cache.scene) {
      cache.scene = mergeScene(this.merge, resolved, {
        layout: cache.layout,
        sideLabels: this.sideLabels
      });
    }
    return cache.scene;
  }

  get scene() {
    if (this.resultOnly) {
      const { resolved } = this;
      return this.memo("resultScene", [resolved], () =>
        flowScene(resolved.model, this._cache.layout)
      );
    }
    return this.sceneAndDiff.scene;
  }

  get sceneDiff() {
    return this.sceneAndDiff.diff;
  }

  // The diff plus resources that only other sides have, so they can be
  // listed and picked.
  get panelDiff() {
    return this.memo("panelDiff", [this.sceneAndDiff, this.merge], () =>
      this.buildPanelDiff()
    );
  }

  buildPanelDiff() {
    const diff = this.sceneDiff;
    const listed = new Set(diff.resources.map((entry) => entry.key));
    const extra = [];
    for (const name of this.merge.names) {
      for (const resource of this.merge.sides[name].resources.values()) {
        if (!listed.has(resource.key)) {
          listed.add(resource.key);
          extra.push({
            id: `${resource.type}:${resource.key}`,
            key: resource.key,
            type: resource.type,
            status: EXCLUDED,
            after: resource,
            availableFrom: name,
            changes: []
          });
        }
      }
    }
    return extra.length
      ? { ...diff, resources: [...diff.resources, ...extra] }
      : diff;
  }

  // Mode

  get isCanvas() {
    return this.mode === CANVAS;
  }

  get isText() {
    return this.mode === TEXT;
  }

  get modeOptions() {
    return [
      { label: "Visual merge", value: CANVAS },
      { label: "XML merge", value: TEXT }
    ];
  }

  handleMode(event) {
    this.mode = event.detail.value;
    if (this.isText) {
      this.textOpened = true;
    }
  }

  get canvasClass() {
    return this.isCanvas ? "canvas-mode" : "canvas-mode slds-hide";
  }

  get textClass() {
    return this.isText ? "text-mode" : "text-mode slds-hide";
  }

  // Status

  get conflictCount() {
    return this.resolved.conflicts.length;
  }

  get errorCount() {
    return this.resolved.errors;
  }

  get warningCount() {
    return this.resolved.issues.length - this.resolved.errors;
  }

  get statusItems() {
    const items = [];
    if (this.threeWay) {
      items.push({
        key: "conflicts",
        text: this.conflictCount
          ? `${plural(this.conflictCount, "conflict")} to resolve`
          : "No unresolved conflicts",
        className: this.conflictCount ? "chip chip-error" : "chip chip-ok"
      });
    }
    // Green only when nothing is left to look at: open conflicts or
    // warnings next to a "passed" chip read as ready to save.
    const clean = !this.conflictCount && !this.warningCount;
    items.push({
      key: "errors",
      text: this.errorCount
        ? `${plural(this.errorCount, "error")}: Salesforce would reject this flow`
        : clean
          ? "Local checks passed"
          : "No errors",
      className: this.errorCount
        ? "chip chip-error"
        : clean
          ? "chip chip-ok"
          : "chip"
    });
    if (this.warningCount) {
      items.push({
        key: "warnings",
        text: plural(this.warningCount, "warning"),
        className: "chip chip-warning"
      });
    }
    if (this.restoredCount) {
      items.push({
        key: "restored",
        text: `${plural(this.restoredCount, "earlier pick")} restored: Undo starts afresh`,
        className: "chip"
      });
    }
    if (this.resolved.autoIncluded.length) {
      items.push({
        key: "auto",
        text: `${plural(this.resolved.autoIncluded.length, "resource")} brought in because picked parts use them`,
        className: "chip"
      });
    }
    return items;
  }

  get textStatus() {
    const result = this.textResult;
    if (!result) {
      return [];
    }
    // Leftover conflict markers are why the XML won't read, so they come
    // first.
    if (result.unresolved) {
      return [
        {
          key: "conflicts",
          text: `${plural(result.unresolved, "conflict")} to resolve`,
          className: "chip chip-error"
        }
      ];
    }
    if (result.error) {
      return [
        {
          key: "error",
          text: "The XML isn't a valid flow",
          className: "chip chip-error"
        }
      ];
    }
    // The mapping's problems count with the XML's own.
    const mapping = this.textMappingIssues;
    const mappingErrors = this.textMappingErrors;
    const errors = (result.problems || []).length + mappingErrors;
    const warnings =
      (result.warnings || []).length + mapping.length - mappingErrors;
    if (errors) {
      return [
        {
          key: "problems",
          text: plural(errors, "error"),
          className: "chip chip-error"
        }
      ];
    }
    if (warnings) {
      return [
        { key: "errors", text: "No errors", className: "chip" },
        {
          key: "warnings",
          text: plural(warnings, "warning"),
          className: "chip chip-warning"
        }
      ];
    }
    return [
      { key: "ok", text: "Local checks passed", className: "chip chip-ok" }
    ];
  }

  get statusChips() {
    return this.isText ? this.textStatus : this.statusItems;
  }

  get resultMetadata() {
    if (this.isText) {
      return this.textResult && this.textResult.metadata;
    }
    return this.resolved.metadata;
  }

  get saveBlockedReason() {
    if (this.savedNow) {
      return `Saved as version ${this.savedAs.version}. Change the merge to save again.`;
    }
    return this.mergeBlockedReason;
  }

  // Why the merge isn't a whole flow yet.
  get mergeBlockedReason() {
    if (this.isText) {
      if (!this.textResult) {
        return "The XML merge is still loading.";
      }
      if (this.textResult.pending) {
        return "Checking your edit.";
      }
      if (this.textResult.unresolved) {
        return "Resolve every conflict first.";
      }
      if (this.textResult.error) {
        return "Fix the XML first.";
      }
      if (this.textMappingErrors) {
        return "Fix the mapping first: the XML merge uses it too.";
      }
      return this.textResult.problems && this.textResult.problems.length
        ? "Fix the errors first."
        : undefined;
    }
    if (this.conflictCount) {
      return "Resolve every conflict first.";
    }
    if (this.errorCount) {
      return "Fix the errors first.";
    }
    return undefined;
  }

  // Whether the merge is unchanged since it was saved.
  // Names the merge as it stands, for the save dialog to hand back when its
  // save finishes. A number, since objects reach the dialog as proxies.
  get saveKey() {
    return this.memo(
      "saveKey",
      [this.mode, this.picks, this.textResult],
      () => ++this._saveCount
    );
  }

  get savedNow() {
    const saved = this.savedAs;
    if (!saved || saved.mode !== this.mode) {
      return false;
    }
    return this.isText
      ? saved.text === this.textResult
      : saved.picks === this.picks;
  }

  get saveDisabled() {
    return !this.canSave || Boolean(this.saveBlockedReason);
  }

  get saveSource() {
    return this.isText ? "XML merge" : "visual merge";
  }

  get saveLabel() {
    return `Save ${this.saveSource}`;
  }

  get saveTitle() {
    return this.saveNote || "Save the merged flow as an inactive version";
  }

  // Why saving is off, shown beside the button rather than only on hover.
  get saveNote() {
    if (!this.canSave) {
      return "Saving needs the Tributary Save permission.";
    }
    return this.saveBlockedReason;
  }

  // Draft download

  get downloadDisabled() {
    return !this.resultMetadata || Boolean(this.mergeBlockedReason);
  }

  get downloadTitle() {
    return (
      this.mergeBlockedReason ||
      "Download the merged flow as a .flow-meta.xml file, as a draft. Nothing is saved to the org."
    );
  }

  get draftFileName() {
    const sides = this._sides || {};
    const named = ["before", "ours", "base", "after", "theirs"]
      .map((name) => sides[name] && sides[name].FullName)
      .find(Boolean);
    const target = this.targets && this.targets[0];
    return `${named || (target && target.apiName) || "Merged_Flow"}.flow-meta.xml`;
  }

  // The merged flow as XML, always a draft: for review or version control,
  // without anything going to the org.
  handleDownload() {
    const metadata = this.resultMetadata;
    if (!metadata || this.mergeBlockedReason) {
      return;
    }
    const { text } = toXml({ ...metadata, status: "Draft" });
    const link = document.createElement("a");
    link.href = `data:application/xml;charset=utf-8,${encodeURIComponent(text)}`;
    link.download = this.draftFileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    this.announcement = `Downloaded ${this.draftFileName}`;
  }

  // Presets

  get presetLabel() {
    return this.threeWay ? "Resolve all conflicts" : "Pick for all";
  }

  get presets() {
    if (this.threeWay) {
      return [
        {
          value: "ours",
          label: `Resolve all conflicts using ${this.label("ours")}`
        },
        {
          value: "theirs",
          label: `Resolve all conflicts using ${this.label("theirs")}`
        },
        { value: "reset", label: "Reset to automatic merge" }
      ];
    }
    return [
      { value: "before", label: `Keep ${this.label("before")} as is` },
      { value: "after", label: `Take everything from ${this.label("after")}` },
      // Where both have a part but differ, the first version's is kept.
      {
        value: "union",
        label: `Add ${this.label("after")}'s new parts to ${this.label("before")}`
      },
      { value: "reset", label: "Reset" }
    ];
  }

  handlePreset(event) {
    const preset = event.detail.value;
    this.remember();
    if (preset === "reset") {
      this.setPicks({});
      return;
    }
    if (this.threeWay) {
      // Only conflicts: one-sided changes keep merging automatically.
      const picks = { ...this.picks };
      for (const unit of this.merge.units.values()) {
        if (unit.status === CONFLICT) {
          picks[unit.id] = preset;
        }
      }
      this.setPicks(picks);
      return;
    }
    this.setPicks(presetPicks(this.merge, preset));
  }

  applyPicks(picks) {
    this.remember();
    this.setPicks({ ...this.picks, ...picks });
  }

  handlePick(event) {
    this.applyPicks(event.detail.picks);
  }

  // Canvas and selection

  get selectedId() {
    return this.selection && this.selection.id;
  }

  get selectedEntry() {
    const { selection } = this;
    if (!selection) {
      return undefined;
    }
    if (selection.kind === "resource") {
      return this.panelDiff.resources.find(
        (entry) => entry.id === selection.id
      );
    }
    const entry = this.sceneDiff.nodes.find((item) => item.id === selection.id);
    if (entry) {
      return entry;
    }
    const ghost = this.sceneAndDiff.scene.nodes.find(
      (node) => node.id === selection.id && node.status === EXCLUDED
    );
    if (!ghost) {
      return undefined;
    }
    return {
      id: ghost.id,
      key: ghost.key,
      type: ghost.type,
      status: EXCLUDED,
      after: this.merge.sides[ghost.availableFrom].nodes.get(ghost.key),
      availableFrom: ghost.availableFrom,
      changes: []
    };
  }

  get selectedKind() {
    return this.selection ? this.selection.kind : undefined;
  }

  get hasSelection() {
    return Boolean(this.selectedEntry);
  }

  get noSelection() {
    return !this.hasSelection;
  }

  // Shift- or Ctrl-click adds an element to those picked together, or
  // takes it out; a plain click picks just the one.
  handleCanvasSelect(event) {
    const { id, additive } = event.detail;
    this.stepProp = undefined;
    const key = id && this.keyForId(id);
    if (additive && key) {
      let marked = [...this.marked];
      const selected =
        this.selection &&
        this.selection.kind === "node" &&
        this.keyForId(this.selection.id);
      if (!marked.length && selected && selected !== key) {
        marked.push(selected);
      }
      marked = marked.includes(key)
        ? marked.filter((item) => item !== key)
        : [...marked, key];
      this.setMarked(marked);
      return;
    }
    this.marked = [];
    this.selection = id ? { kind: "node", id } : undefined;
  }

  // One element left picked is just selected.
  setMarked(keys) {
    if (keys.length === 1) {
      this.marked = [];
      this.selectNodeKey(keys[0]);
      return;
    }
    this.marked = keys;
    this.selection = undefined;
  }

  keyForId(id) {
    const node = this.sceneAndDiff.scene.nodes.find((item) => item.id === id);
    return node && node.key !== START ? node.key : undefined;
  }

  // The same list until the marks or the merge change, so the canvas
  // doesn't restyle every element on each render.
  get markedIds() {
    const { marked, merge } = this;
    return this.memo("markedIds", [marked, merge], () =>
      marked.map((key) => this.nodeIdFor(key)).filter(Boolean)
    );
  }

  get showGroup() {
    return this.marked.length > 1;
  }

  handleGroupOpen(event) {
    this.marked = [];
    this.selectNodeKey(event.detail.key);
  }

  handleGroupUnmark(event) {
    const { key } = event.detail;
    this.setMarked(this.marked.filter((item) => item !== key));
  }

  handleGroupClear() {
    this.marked = [];
  }

  handleResourceSelect(event) {
    this.selection = { kind: "resource", id: event.detail.id };
    this.stepProp = undefined;
  }

  handleClose() {
    this.selection = undefined;
    this.marked = [];
  }

  handleResultOnly(event) {
    this.resultOnly = event.target.checked;
  }

  connectedCallback() {
    this._onResize = () => this.fitHeight();
    window.addEventListener("resize", this._onResize);
  }

  disconnectedCallback() {
    window.removeEventListener("resize", this._onResize);
  }

  // The canvas runs to the bottom of the window, so the page needn't scroll.
  fitHeight() {
    fillWindow(this.refs.body);
  }

  renderedCallback() {
    this.fitHeight();
    // Where the stepper was, for when that item leaves the list.
    const index = this.stepIndex;
    if (index >= 0) {
      this._stepAt = index;
    }
    // Focusing what was stepped to also scrolls it into view.
    if (this._pendingFocus) {
      this._pendingFocus = false;
      const panel = this.template.querySelector("c-flow-element-panel");
      const row = this.template.querySelector(".row-current .row-pick");
      if (this.selection && panel) {
        panel.focusChoice();
      } else if (row) {
        row.focus();
      }
    }
    // A new page starts at its top.
    if (this._pageTurned) {
      this._pageTurned = false;
      const first = this.template.querySelector(".changes-list .row");
      if (first && first.scrollIntoView) {
        first.scrollIntoView({ block: "nearest" });
      }
    }
    if (this._pendingMapping) {
      const key = this._pendingMapping;
      this._pendingMapping = undefined;
      const panel = this.template.querySelector("c-flow-mapping-panel");
      if (panel) {
        panel.focusRow(key);
      }
    }
    if (this._pendingReveal) {
      const id = this._pendingReveal;
      this._pendingReveal = undefined;
      const canvas = this.template.querySelector("c-flow-canvas");
      if (canvas) {
        canvas.reveal(id);
      }
    }
  }

  nodeIdFor(key) {
    for (const name of this.merge.names) {
      const node = this.merge.sides[name].nodes.get(key);
      if (node) {
        return nodeId(node);
      }
    }
    return undefined;
  }

  selectNodeKey(key) {
    const id = this.nodeIdFor(key);
    if (id) {
      this.selection = { kind: "node", id };
      this._pendingReveal = id;
    }
  }

  // What the stepper walks through, top to bottom on the canvas: while
  // conflicts are open, every one of them, including resources and flow
  // properties that aren't on the canvas; otherwise every element the
  // sides differ on or that has a problem.
  get steps() {
    return this.memo(
      "steps",
      [this.sceneAndDiff, this.resolved, this.reviewedUnits, this.panelDiff],
      () => this.buildSteps()
    );
  }

  buildSteps() {
    const scene = this.sceneAndDiff.scene;
    const steps = [];
    if (this.conflictCount) {
      const open = new Set(this.resolved.conflicts);
      const nodeKeys = new Set();
      for (const unit of this.merge.units.values()) {
        if (open.has(unit.id) && unit.nodeKey) {
          nodeKeys.add(unit.nodeKey);
        }
      }
      for (const node of this.sortedNodes(scene)) {
        if (node.conflict || nodeKeys.has(node.key)) {
          steps.push({ key: `node:${node.id}`, kind: "node", id: node.id });
        }
      }
      steps.push(
        ...this.otherSteps(
          [...this.merge.units.values()].filter((unit) => open.has(unit.id))
        )
      );
      return steps;
    }
    const changed = this.reviewedUnits;
    const differing = new Set(
      changed.filter((unit) => unit.nodeKey).map((unit) => unit.nodeKey)
    );
    for (const node of this.sortedNodes(scene)) {
      if (differing.has(node.key) || node.errors || node.warnings) {
        steps.push({ key: `node:${node.id}`, kind: "node", id: node.id });
      }
    }
    steps.push(...this.otherSteps(changed));
    return steps;
  }

  // Resources and flow properties among the units, which aren't on the
  // canvas.
  otherSteps(units) {
    const steps = [];
    for (const unit of units) {
      if (unit.kind === "resource") {
        const entry = this.panelDiff.resources.find(
          (item) => item.key === unit.resourceKey
        );
        if (entry) {
          steps.push({
            key: `resource:${entry.id}`,
            kind: "resource",
            id: entry.id
          });
        }
      } else if (unit.kind === "prop") {
        steps.push({ key: `prop:${unit.id}`, kind: "prop", id: unit.id });
      }
    }
    return steps;
  }

  sortedNodes(scene) {
    return [...scene.nodes].sort((p, q) => p.y - q.y || p.x - q.x);
  }

  get stepLabel() {
    return this.conflictCount ? "conflict" : "change";
  }

  get noSteps() {
    return this.steps.length === 0;
  }

  get currentStep() {
    if (this.stepProp) {
      return `prop:${this.stepProp}`;
    }
    return this.selection
      ? `${this.selection.kind}:${this.selection.id}`
      : undefined;
  }

  get stepIndex() {
    const current = this.currentStep;
    return current ? this.steps.findIndex((step) => step.key === current) : -1;
  }

  // Counts are always of what's left to step through: open conflicts
  // while there are any, then the changed items (elements, resources and
  // flow properties), each of which may hold several differences. An
  // element with more than one conflict is one step, so the steps are
  // then counted as places, not conflicts, to agree with the status.
  countSteps(count) {
    return count === this.conflictCount
      ? plural(count, "open conflict")
      : plural(
          count,
          "place with open conflicts",
          "places with open conflicts"
        );
  }

  positionAt(index, count) {
    if (!this.conflictCount) {
      return `Changed item ${index + 1} of ${count}`;
    }
    return `${index + 1} of ${this.countSteps(count)}`;
  }

  get position() {
    const count = this.steps.length;
    const index = this.stepIndex;
    if (index >= 0) {
      return this.positionAt(index, count);
    }
    return this.conflictCount
      ? this.countSteps(count)
      : `${plural(count, "changed item")} to review`;
  }

  get panelNextLabel() {
    return this.noSteps ? undefined : this.nextTitle;
  }

  stepName(step) {
    if (step.kind === "prop") {
      const unit = this.merge.units.get(step.id);
      return `${humanize(unit.label)}, flow property`;
    }
    if (step.kind === "resource") {
      const entry = this.panelDiff.resources.find(
        (item) => item.id === step.id
      );
      return entry ? `${entry.key}, resource` : step.id;
    }
    const node = this.sceneAndDiff.scene.nodes.find(
      (item) => item.id === step.id
    );
    return node ? this.nodeName(node.key) : step.id;
  }

  get previousTitle() {
    return `Previous ${this.stepLabel}`;
  }

  get nextTitle() {
    return `Next ${this.stepLabel}`;
  }

  step(delta) {
    const { steps } = this;
    if (!steps.length) {
      return;
    }
    const count = steps.length;
    const index = this.stepIndex;
    let next;
    if (index >= 0) {
      next = index + delta;
    } else if (this.currentStep && this._stepAt !== undefined) {
      // The item just left the list, picked: the one after it has taken
      // its place.
      next = delta > 0 ? this._stepAt : this._stepAt - 1;
    } else {
      next = delta > 0 ? 0 : count - 1;
    }
    const wrap =
      (next >= count && ", back to the start") ||
      (next < 0 && ", back to the end") ||
      "";
    next = (next + count) % count;
    const target = steps[next];
    this.announcement = `${this.positionAt(next, count)}: ${this.stepName(target)}${wrap}`;
    this._pendingFocus = true;
    if (target.kind === "prop") {
      // Flow properties are only in the change list: show it, with the row
      // marked and scrolled to.
      this.selection = undefined;
      this.stepProp = target.id;
      this.panelTab = "changes";
      this.showPageOf(target.id);
      return;
    }
    this.stepProp = undefined;
    this.selection = { kind: target.kind, id: target.id };
    if (target.kind === "node") {
      this._pendingReveal = target.id;
    }
  }

  handlePrevious() {
    this.step(-1);
  }

  handleNext() {
    this.step(1);
  }

  // Side panel lists

  get tabs() {
    const problems = this.resolved.issues.length;
    const groups = this.groupRows.length;
    return [
      this.crossFlow && { value: "mapping", label: "Mapping" },
      { value: "changes", label: `Differences (${this.changeRows.length})` },
      groups && { value: "groups", label: `Groups (${groups})` },
      { value: "problems", label: `Problems (${problems})` },
      { value: "resources", label: "Resources" }
    ]
      .filter(Boolean)
      .map((tab) => {
        const selected = tab.value === this.panelTab;
        return {
          ...tab,
          id: `merge-tab-${tab.value}`,
          className: selected ? "tab tab-active" : "tab",
          selected: selected ? "true" : "false",
          tabIndex: selected ? "0" : "-1"
        };
      });
  }

  get tabPanelLabel() {
    return `merge-tab-${this.currentTab}`;
  }

  handleTab(event) {
    this.panelTab = event.currentTarget.dataset.tab;
  }

  // Arrow keys, Home and End move between tabs, as in any tab list.
  handleTabKey(event) {
    const order = this.tabs.map((tab) => tab.value);
    const index = order.indexOf(this.currentTab);
    const moves = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: order.length - 1
    };
    if (!(event.key in moves)) {
      return;
    }
    event.preventDefault();
    const next = (moves[event.key] + order.length) % order.length;
    this.panelTab = order[next];
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    requestAnimationFrame(() => {
      const tab = this.template.querySelector(`[data-tab="${order[next]}"]`);
      if (tab) {
        tab.focus();
      }
    });
  }

  // A tab that's gone (no groups left) falls back to the differences.
  get currentTab() {
    return this.tabs.some((tab) => tab.value === this.panelTab)
      ? this.panelTab
      : "changes";
  }

  get showChanges() {
    return this.currentTab === "changes";
  }

  get showMapping() {
    return this.currentTab === "mapping";
  }

  get showGroups() {
    return this.currentTab === "groups";
  }

  get showProblems() {
    return this.panelTab === "problems";
  }

  get showResources() {
    return this.panelTab === "resources";
  }

  get sideOptions() {
    return this.merge.names.map((name) => ({
      label: this.label(name),
      value: name
    }));
  }

  nodeName(key) {
    if (key === START) {
      return "Start";
    }
    for (const name of this.merge.names) {
      const node = this.merge.sides[name].nodes.get(key);
      if (node) {
        return node.label || key;
      }
    }
    return key;
  }

  // What a row is about, in words: the element or resource, then the part.
  unitHeading(unit) {
    if (unit.kind === "prop") {
      return { title: humanize(unit.label), detail: "Flow property" };
    }
    if (unit.kind === "resource") {
      return { title: unit.label, detail: "Whole resource" };
    }
    const title = this.nodeName(unit.nodeKey);
    const target = unit.kind === "edge" && this.edgeTarget(unit);
    return {
      title,
      detail: target ? `${unitTitle(unit)} → ${target}` : unitTitle(unit)
    };
  }

  // Where a connector leads, when every version that has it agrees.
  edgeTarget(unit) {
    const targets = new Set(
      Object.values(unit.values)
        .filter(Boolean)
        .map((value) => value.target)
    );
    return targets.size === 1 ? this.nodeName([...targets][0]) : undefined;
  }

  // Whether a side added, removed or changed a part, against where it
  // started: the base, or before in a two-way merge.
  changeVerb(unit, side) {
    const start = unit.values[this.threeWay ? "base" : "before"];
    if (start === undefined) {
      return "Added";
    }
    return unit.values[side] === undefined ? "Removed" : "Changed";
  }

  statusText(unit, open) {
    if (this.resolved.choices[unit.id] === "custom") return "Using edited text";
    if (open) {
      return "Conflict";
    }
    switch (unit.status) {
      case "ours":
      case "theirs":
        return `${this.changeVerb(unit, unit.status)} in ${this.label(unit.status)}`;
      case CONFLICT:
        return "Resolved";
      default:
        return this.threeWay
          ? "Differs"
          : `${this.changeVerb(unit, "after")} in ${this.label("after")}`;
    }
  }

  // A flow property's value on each side, since it has no details panel;
  // a connector's target on each side, when they differ.
  rowValues(unit) {
    if (unit.kind === "edge" && !this.edgeTarget(unit)) {
      return this.merge.names.map((name) => ({
        key: name,
        label: this.label(name),
        text: unit.values[name]
          ? `→ ${this.nodeName(unit.values[name].target)}`
          : "Not connected"
      }));
    }
    if (unit.kind !== "prop") {
      return undefined;
    }
    return this.merge.names.map((name) => ({
      key: name,
      label: this.label(name),
      text:
        unit.values[name] === undefined || unit.values[name] === ""
          ? "Not set"
          : formatValue(unit.values[name])
    }));
  }

  // What the sides differ on, for the change list and the stepper. Only
  // moving an element changes nothing it does, so moves are left out unless
  // asked for.
  // Everything the sides differ on, once per merge.
  get changedUnits() {
    const { merge } = this;
    return this.memo("changedUnits", [merge], () => changedUnits(merge));
  }

  get reviewedUnits() {
    return this.memo("reviewedUnits", [this.merge, this.showMoves], () =>
      this.changedUnits.filter((unit) => this.showMoves || unit.kind !== "pos")
    );
  }

  // An open conflict has no side picked yet, even though the result
  // previews one.
  get changeRows() {
    return this.memo(
      "changeRows",
      [
        this.reviewedUnits,
        this.resolved,
        this.onlyConflicts,
        this.keptRows,
        this.stepProp,
        this.labels
      ],
      () => this.buildChangeRows()
    );
  }

  buildChangeRows() {
    const { resolved } = this;
    const open = this.openConflicts;
    const current = this.stepProp;
    return this.reviewedUnits
      .filter(
        (unit) =>
          !this.onlyConflicts ||
          this.keptRows[unit.id] ||
          (unit.status === CONFLICT && open.has(unit.id))
      )
      .map((unit) => {
        const isOpen = unit.status === CONFLICT && open.has(unit.id);
        const { title, detail } = this.unitHeading(unit);
        return {
          id: unit.id,
          label: title,
          detail,
          rawLabel: unit.label,
          pickLabel: `Version to use for ${title}: ${detail}`,
          icon: KIND_ICON[unit.kind] || "utility:record",
          statusText: this.statusText(unit, isOpen),
          values: this.rowValues(unit),
          options: this.merge.names.map((name) => ({
            value: name,
            label:
              ["node", "resource", "edge"].includes(unit.kind) &&
              this.merge.names.some((side) => unit.values[side] === undefined)
                ? `${unit.values[name] === undefined ? "Leave it out" : "Keep it"} · ${this.label(name)}`
                : this.label(name)
          })),
          openable: unit.kind !== "prop" || editableText(unit),
          rowClass: `row${isOpen ? " row-conflict" : ""}${unit.id === current ? " row-current" : ""}`,
          value: isOpen ? "" : resolved.choices[unit.id],
          target: unit.nodeKey || unit.id.split("|")[1],
          kind: unit.kind
        };
      });
  }

  get hasChangeRows() {
    return this.changeRows.length > 0;
  }

  get pageCount() {
    return Math.max(1, Math.ceil(this.changeRows.length / PAGE_SIZE));
  }

  // A page past the end, its rows picked away, shows the last one.
  get pageIndex() {
    return Math.min(this.changePage, this.pageCount - 1);
  }

  get pagedRows() {
    const rows = this.changeRows;
    const page = this.pageIndex;
    return this.memo("pagedRows", [rows, page], () =>
      rows.length > PAGE_SIZE
        ? rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
        : rows
    );
  }

  get hasPages() {
    return this.changeRows.length > PAGE_SIZE;
  }

  get pageText() {
    const count = this.changeRows.length;
    const first = this.pageIndex * PAGE_SIZE + 1;
    const last = Math.min(count, first + PAGE_SIZE - 1);
    return `Differences ${first}–${last} of ${count}`;
  }

  get cannotPagePrevious() {
    return this.pageIndex === 0;
  }

  get cannotPageNext() {
    return this.pageIndex >= this.pageCount - 1;
  }

  handlePagePrevious() {
    this.changePage = this.pageIndex - 1;
    this._pageTurned = true;
  }

  handlePageNext() {
    this.changePage = this.pageIndex + 1;
    this._pageTurned = true;
  }

  // Turns to the page a row is on, when it's listed.
  showPageOf(id) {
    const index = this.changeRows.findIndex((row) => row.id === id);
    if (index >= 0) {
      this.changePage = Math.floor(index / PAGE_SIZE);
    }
  }

  get noChangesText() {
    if (this.onlyConflicts) {
      return "Every conflict has a side picked.";
    }
    return this.moveCount
      ? "Only where elements sit on the canvas differs."
      : "The flows are the same; there's nothing to merge.";
  }

  get moveCount() {
    return this.memo(
      "moveCount",
      [this.merge],
      () => this.changedUnits.filter((unit) => unit.kind === "pos").length
    );
  }

  get hasMoves() {
    return this.moveCount > 0;
  }

  get movesLabel() {
    return `Show moved elements (${this.moveCount})`;
  }

  handleShowMoves(event) {
    this.showMoves = event.target.checked;
    this.changePage = 0;
  }

  handleOnlyConflicts(event) {
    this.onlyConflicts = event.target.checked;
    this.keptRows = {};
    this.changePage = 0;
  }

  handleRowPick(event) {
    const unit = event.target.dataset.unit;
    if (this.onlyConflicts) {
      this.keptRows = { ...this.keptRows, [unit]: true };
    }
    this.applyPicks({ [unit]: event.detail.value });
  }

  // A picked row stays listed until focus moves out of it.
  handleRowFocusOut(event) {
    const row = event.currentTarget;
    const { unit } = row.dataset;
    if (!this.keptRows[unit] || row.contains(event.relatedTarget)) {
      return;
    }
    const kept = { ...this.keptRows };
    delete kept[unit];
    this.keptRows = kept;
  }

  handleRowOpen(event) {
    const { kind, target } = event.currentTarget.dataset;
    if (kind === "resource") {
      const entry = this.panelDiff.resources.find(
        (item) => item.key === target
      );
      if (entry) {
        this.selection = { kind: "resource", id: entry.id };
      }
    } else if (kind === "prop") {
      this.selection = undefined;
      this.stepProp = `prop|${target}`;
      this.panelTab = "resources";
    } else {
      this.selectNodeKey(target);
    }
  }

  get problemsEmptyText() {
    return "Local checks found no problems. Salesforce runs its own checks when you save.";
  }

  // An element nothing leads to can often be connected as one version has
  // it: offered alongside the problem.
  get problemRows() {
    return this.memo(
      "problemRows",
      [this.merge, this.resolved, this.labels],
      () => this.buildProblemRows()
    );
  }

  buildProblemRows() {
    return this.resolved.issues.map((issue, index) => {
      const fix =
        issue.code === "unreachable" &&
        reconnectFix(this.merge, this.resolved, issue.nodeKey);
      return {
        id: `${index}`,
        message: issue.message,
        icon: issue.severity === ERROR ? "utility:error" : "utility:warning",
        variant: issue.severity === ERROR ? "error" : "warning",
        nodeKey: issue.nodeKey || "",
        name: issue.name || "",
        mapping: issue.mappingKey || "",
        fix: fix
          ? {
              unit: fix.unitId,
              side: fix.side,
              label: `Connect it as in ${this.label(fix.side)}`,
              title: `Use ${this.label(fix.side)}'s ${unitTitle(fix.edgeUnit)} from ${this.nodeName(fix.edgeUnit.nodeKey)}`
            }
          : undefined
      };
    });
  }

  handleProblemFix(event) {
    const { unit, side } = event.currentTarget.dataset;
    this.applyPicks({ [unit]: side });
  }

  get hasProblems() {
    return this.problemRows.length > 0;
  }

  handleProblemOpen(event) {
    const { node, name, mapping } = event.currentTarget.dataset;
    if (mapping) {
      this.openMapping(mapping);
      return;
    }
    if (node) {
      this.selectNodeKey(node);
      return;
    }
    const entry =
      name && this.panelDiff.resources.find((item) => item.key === name);
    if (entry) {
      this.selection = { kind: "resource", id: entry.id };
    }
  }

  // Groups

  // Changes that belong together, with the version all their parts come
  // from when they agree.
  get groupRows() {
    return this.memo(
      "groupRows",
      [this.merge, this.resolved, this.labels],
      () => this.buildGroupRows()
    );
  }

  buildGroupRows() {
    const { merge, resolved } = this;
    return changeGroups(merge).map((group) => {
      const sides = new Set();
      for (const key of group.keys) {
        for (const unit of unitsForNode(merge, key)) {
          if (unit.status !== SAME) {
            sides.add(resolved.choices[unit.id]);
          }
        }
      }
      const names = group.keys.map((key) => this.nodeName(key));
      const counts = [
        group.added && `${group.added} added`,
        group.removed && `${group.removed} removed`,
        group.changed && `${group.changed} changed`
      ].filter(Boolean);
      const id = group.keys.join(",");
      return {
        id,
        keys: group.keys,
        title: plural(group.keys.length, "element"),
        detail: counts.join(", "),
        names:
          names.length > 4
            ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more`
            : names.join(", "),
        value: sides.size === 1 ? [...sides][0] : "",
        mixed: sides.size > 1,
        pickLabel: `Version to use for ${names.length} elements: ${names.join(", ")}`,
        selectLabel: `Select these ${group.keys.length} elements`
      };
    });
  }

  get hasGroupRows() {
    return this.groupRows.length > 0;
  }

  handleGroupPick(event) {
    const row = this.groupRows.find(
      (item) => item.id === event.target.dataset.group
    );
    if (row) {
      this.applyPicks(
        groupPicks(this.merge, row.keys, event.detail.value, this.picks)
      );
    }
  }

  handleGroupSelect(event) {
    const row = this.groupRows.find(
      (item) => item.id === event.currentTarget.dataset.group
    );
    if (row) {
      this.setMarked(row.keys);
      this._pendingReveal = this.nodeIdFor(row.keys[0]);
    }
  }

  // Text merge

  // Kept between renders: new sides would reset the XML merge's picks.
  get textSides() {
    if (!this._cache.textSides) {
      const sides = {};
      for (const name of this.merge.names) {
        sides[name] = metadataOf(this._sides[name]);
      }
      // The other flow, mapped, so the lines compare like for like.
      if (this.crossFlow) {
        sides.after = toMetadata(this.translation.model);
      }
      this._cache.textSides = sides;
    }
    return this._cache.textSides;
  }

  // A different flow's XML is that flow mapped as the Mapping tab says, so
  // the mapping's problems hold for it too. Checking the XML can't find
  // them: a name that couldn't be used has already been swapped for one
  // that can. Its errors block saving until the mapping is fixed.
  get textMappingIssues() {
    return this.crossFlow ? this.mappingIssues : [];
  }

  get textMappingErrors() {
    return this.textMappingIssues.filter((issue) => issue.severity === ERROR)
      .length;
  }

  get textMappingRows() {
    const issues = this.textMappingIssues;
    return this.memo("textMappingRows", [issues], () =>
      [
        ...issues.filter((issue) => issue.severity === ERROR),
        ...issues.filter((issue) => issue.severity !== ERROR)
      ].map((issue, index) => ({
        key: `${index}`,
        message: issue.message,
        icon: issue.severity === ERROR ? "utility:error" : "utility:warning",
        variant: issue.severity === ERROR ? "error" : "warning",
        mapping: issue.mappingKey || ""
      }))
    );
  }

  get hasTextMappingIssues() {
    return this.textMappingIssues.length > 0;
  }

  // The mapping is chosen in the visual merge.
  handleTextMappingOpen(event) {
    this.mode = CANVAS;
    this.openMapping(event.currentTarget.dataset.mapping);
  }

  // A mapping problem is fixed where the mapping is chosen: the Mapping
  // tab, which shows only once no element is selected or marked.
  openMapping(key) {
    this.handleClose();
    this.panelTab = "mapping";
    this._pendingMapping = key || undefined;
  }

  // The XML result's flow, for what the receipt says it holds.
  get textModel() {
    const metadata = this.textResult && this.textResult.metadata;
    return this.memo("textModel", [metadata], () =>
      metadata ? buildModel(metadata) : undefined
    );
  }

  // Typing in the XML keeps the last check on show until it's checked again.
  handleTextChange(event) {
    this.textResult = event.detail.pending
      ? { ...this.textResult, pending: true }
      : event.detail;
  }

  // Saving

  // Where the merge came from, in a line: the history's summary when there's
  // no receipt, and what the page shows for the saved version.
  get changeSummary() {
    const rewired = this.rewiredCount
      ? ` ${plural(this.rewiredCount, "connector")} rewired.`
      : "";
    return this.isText
      ? `${this.mergedLine}${this.handEditLine ? ` ${this.handEditLine}` : ""}${this.mappingSummary}`
      : `${this.mergedLine}${rewired}${this.mappingSummary}${this.newResourceSummary}`;
  }

  // Hand edits to the XML aren't from either version, so the receipt says so.
  get handEditLine() {
    const edits = this.isText && this.textResult && this.textResult.handEdits;
    if (!edits) {
      return "";
    }
    return `Edited by hand after picking: ${plural(edits.added, "line")} added, ${plural(edits.removed, "line")} removed.`;
  }

  // "Merged Version 3 and Version 4 from Version 2: 6 differences, 4 from
  // Version 3, 2 from Version 4."
  get mergedLine() {
    const [first, second] = this.threeWay
      ? ["ours", "theirs"]
      : ["before", "after"];
    const sources = `${this.label(first)} and ${this.label(second)}${
      this.threeWay ? ` from ${this.label("base")}` : ""
    }`;
    if (this.isText) {
      return `Merged ${sources} as XML.`;
    }
    const counts = {};
    const changed = this.changedUnits;
    for (const unit of changed) {
      const side = this.resolved.choices[unit.id];
      counts[side] = (counts[side] || 0) + 1;
    }
    const parts = Object.entries(counts).map(
      ([side, count]) => `${count} from ${this.label(side)}`
    );
    return `Merged ${sources}: ${plural(changed.length, "difference")}${parts.length ? `, ${parts.join(", ")}` : ""}.`;
  }

  get rewiredCount() {
    return Object.keys(this.picks).filter(
      (id) => id.startsWith(WIRE) && this.picks[id] !== null
    ).length;
  }

  // Variables and other resources the flow didn't have before, by name:
  // what a reviewer has to find in Flow Builder once it's saved.
  get newResources() {
    const start = this.merge.sides[this.threeWay ? "base" : "before"];
    const had = new Set(
      [...start.resources.keys()].map((key) => key.toLowerCase())
    );
    return [...this.resolved.model.resources.values()]
      .filter((resource) => !had.has(resource.key.toLowerCase()))
      .map(
        (resource) =>
          `${resource.key} (${humanize(resource.type).toLowerCase().replace(/s$/, "")})`
      );
  }

  get newResourceSummary() {
    const fresh = this.newResources;
    return fresh.length ? ` New: ${fresh.join(", ")}.` : "";
  }

  // What the other flow's names became, when it's a different flow: mapped
  // onto this flow's or created, and renamed so as not to clash where the
  // result has them.
  get mappingParts() {
    if (!this.crossFlow) {
      return { mapped: [], renamed: [] };
    }
    const { mapped, created, renamed } = this.mappingNotes;
    const model = this.isText ? this.textModel : this.resolved.model;
    return {
      mapped: [
        ...mapped.map((item) => `${item.from} → ${item.to}`),
        ...created.map((item) => `${item.from} → new ${item.name}`)
      ],
      renamed: renamed
        .filter(
          (item) =>
            item.kind !== "name" &&
            model &&
            (model.nodes.has(item.to) || model.resources.has(item.to))
        )
        .map((item) => `${item.from} → ${item.to}`)
    };
  }

  get mappingSummary() {
    const { mapped, renamed } = this.mappingParts;
    return `${mapped.length ? ` Mapped ${mapped.join(", ")}.` : ""}${
      renamed.length ? ` Renamed ${renamed.join(", ")}.` : ""
    }`;
  }

  // What was decided, a line each, for the receipt: the merge's counts,
  // conflicts settled and which side each took, connectors rewired, the
  // other flow's names mapped and renamed, and resources the flow didn't
  // have.
  get decisionLines() {
    const lines = [this.mergedLine];
    const listed = (items, limit = 20) =>
      `${items.slice(0, limit).join("; ")}${
        items.length > limit ? `; and ${items.length - limit} more` : ""
      }.`;
    const mapping = [];
    const { mapped, renamed } = this.mappingParts;
    if (mapped.length) {
      mapping.push(`Mapped from the other flow: ${listed(mapped, 40)}`);
    }
    if (renamed.length) {
      mapping.push(`Renamed so as not to clash: ${listed(renamed, 40)}`);
    }
    if (this.isText) {
      return [
        ...lines,
        ...(this.handEditLine ? [this.handEditLine] : []),
        ...mapping
      ];
    }
    const edited = Object.entries(this.picks)
      .filter(([id, pick]) => textPick(this.merge.units.get(id), pick))
      .map(([id]) => humanize(this.merge.units.get(id).label));
    if (edited.length)
      lines.push(`Text combined or edited by hand: ${listed(edited)}`);
    if (this.threeWay) {
      const settled = this.changedUnits
        .filter(
          (unit) => unit.status === CONFLICT && !this.openConflicts.has(unit.id)
        )
        .map(
          (unit) =>
            `${unit.label}: ${this.label(this.resolved.choices[unit.id])}`
        );
      if (settled.length) {
        lines.push(
          `${plural(settled.length, "conflict")} settled: ${listed(settled)}`
        );
      }
    }
    const wires = wiresOf(this.picks).map(
      (wire) => `${wire.source} (${wire.slot}) → ${wire.target || "End"}`
    );
    if (wires.length) {
      lines.push(`Connectors rewired: ${listed(wires)}`);
    }
    lines.push(...mapping);
    const fresh = this.newResources;
    if (fresh.length) {
      lines.push(`New resources: ${listed(fresh, 40)}`);
    }
    return lines;
  }

  // What the checks here found, errors first.
  get reviewChecks() {
    if (this.isText) {
      const result = this.textResult || {};
      // The mapping's problems, then the XML's.
      const mapping = (errors) =>
        this.textMappingIssues
          .filter((issue) => (issue.severity === ERROR) === errors)
          .map((issue) => issue.message);
      const problems = [...mapping(true), ...(result.problems || [])];
      const warnings = [...mapping(false), ...(result.warnings || [])];
      return {
        errors: problems.length,
        warnings: warnings.length,
        messages: [...problems, ...warnings]
      };
    }
    const { issues, errors } = this.resolved;
    return {
      errors,
      warnings: issues.length - errors,
      messages: [
        ...issues.filter((issue) => issue.severity === ERROR),
        ...issues.filter((issue) => issue.severity !== ERROR)
      ].map((issue) => issue.message)
    };
  }

  // The review the save dialog shows and keeps with the saved version: what
  // the merge was made from, what was decided and what was checked. Worked
  // out only while the dialog is open.
  get saveReview() {
    if (!this.saveOpen || !this.ready) {
      return undefined;
    }
    return {
      sources: this.lineage || [],
      decisions: this.decisionLines,
      checks: this.reviewChecks
    };
  }

  handleSave() {
    this.saveOpen = true;
    this.dispatchEvent(
      new CustomEvent("save", {
        detail: {
          metadata: this.resultMetadata,
          changeSummary: this.changeSummary
        }
      })
    );
  }

  handleSaveClose() {
    this.saveOpen = false;
    // Back to the button that opened the dialog.
    const save = this.template.querySelector("lightning-button.save");
    if (save) {
      save.focus();
    }
  }

  handleSaved(event) {
    const { result, saveKey } = event.detail || {};
    // A save can finish after its dialog was closed and the merge changed.
    // Only the merge that was sent counts as saved; later work keeps its
    // draft.
    if (saveKey === this.saveKey) {
      this.savedAs = {
        mode: this.mode,
        picks: this.picks,
        text: this.textResult,
        version: result && result.versionNumber
      };
      // Saved, its draft needn't outlive a reload. The other mode's draft
      // wasn't saved, so it stays.
      if (!this.isText) {
        this.restoredCount = 0;
        if (this._draftKey) {
          writeDraft(DRAFTS.picks, this._draftKey, {});
        }
      } else if (this._draftKey) {
        // XML edits set aside for another mapping weren't saved: they stay.
        const text = readDraft(DRAFTS.text, this._draftKey);
        writeDraft(
          DRAFTS.text,
          this._draftKey,
          text && text.aside ? { aside: text.aside } : {}
        );
      }
    }
    // The receipt goes with the version to any request to activate it.
    this.dispatchEvent(
      new CustomEvent("saved", {
        detail: {
          ...event.detail,
          summary: (event.detail && event.detail.receipt) || this.changeSummary
        }
      })
    );
  }

  handleRecompare() {
    this.dispatchEvent(new CustomEvent("recompare"));
  }

  handleSavedActivated(event) {
    this.dispatchEvent(new CustomEvent("activated", { detail: event.detail }));
  }
}
