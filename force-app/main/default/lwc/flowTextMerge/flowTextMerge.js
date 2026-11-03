/**
 * Merges flows as Metadata API XML, line by line. Two-way: each change keeps
 * the first side's lines, takes the second's, or keeps both. Three-way:
 * changes made on one side apply by themselves and overlapping changes are
 * conflicts to pick. The result can also be edited by hand: conflicts not
 * yet picked come into the editor between git-style markers, and count as
 * unresolved until the markers are gone. Picks and hand edits are kept under
 * draftKey so they survive a page reload, with a fingerprint of the XML
 * they were made against: edits made against other XML (another mapping,
 * or flows changed since) are set aside rather than applied.
 *
 * Sends resultchange { metadata, error, problems, warnings, unresolved, text }
 * whenever the result changes; metadata is undefined while the XML doesn't
 * parse, problems lists what Salesforce would reject in XML that does, and
 * warnings what it would accept but is likely a mistake. It isn't
 * called change because the pickers' own change events bubble out of here.
 */
import { LightningElement, api } from "lwc";
import { toXml, fromXml } from "c/flowXml";
import { buildModel } from "c/flowModel";
import { validateFlow, ERROR } from "c/flowMerge";
import {
  diffLines,
  changeBlocks,
  INSERT,
  DELETE,
  mergeTwoWay,
  planThreeWay,
  applyThreeWay
} from "c/lineDiff";
import { plural, DRAFTS, readDraft, writeDraft } from "c/flowUtils";

const MARKER = /^<{7}(?: |$)/;
const LOCATION = /^\s*<location[XY]>[^<]*<\/location[XY]>\s*$/;

// Lines that only say where an element sits on the canvas.
const movedOnly = (a, b) => LOCATION.test(a) && LOCATION.test(b);
// How long typing pauses before a hand edit is checked and kept as a draft.
const EDIT_PAUSE = 250;
// Drafts carry this, and one with another number is set aside. Raise it
// when the same XML would number its changes differently (how changes are
// found or counted); how lines are split is in the fingerprint already.
const DRAFT_FORMAT = 1;
// Drafts for other XML kept at most, newest first.
const ASIDE_KEPT = 3;
// Changes longer than this, both sides together, start folded.
const FOLD_LINES = 40;
// Changes listed at first, and added each time more are asked for. Each has
// its own picker, so a flow with hundreds of small edits lists a page at a time.
const CHANGE_PAGE = 50;

// A short fingerprint of the lines being merged, line breaks included. It
// only has to tell one comparison's XML from another's, not resist forgery.
function fingerprint(sides) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const mix = (code) => {
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  };
  for (const lines of sides) {
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        mix(line.charCodeAt(i));
      }
      // Past any character code, so it can't be mistaken for one.
      mix(0x10000);
    }
    mix(0x10001);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Whether a kept draft has anything in it.
const hasWork = (draft) =>
  Boolean(
    draft &&
    typeof draft === "object" &&
    (typeof draft.text === "string" ||
      (draft.picks && Object.keys(draft.picks).length))
  );

function elementAt(ranges, line) {
  for (const [id, range] of ranges) {
    if (line >= range.start && line <= range.end) {
      return id.replace(":", " › ");
    }
  }
  return undefined;
}

const sameSides = (a, b) =>
  Boolean(a && b) &&
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every((name) => a[name] === b[name]);

// What a change touches: the elements it's in on each side, or else the
// flow property its first line sets.
function whereIs(spots) {
  const names = [];
  for (const { ranges, lines, start } of spots) {
    if (!lines.length) {
      continue;
    }
    const name =
      elementAt(ranges, start) || (/^\s*<(\w+)/.exec(lines[0]) || [])[1];
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }
  return names.join(" and ") || undefined;
}

// Both columns lose the indentation they share, so deep XML stays readable.
function indentOf(columns) {
  let least = Infinity;
  for (const lines of columns) {
    for (const text of lines) {
      if (text.trim()) {
        least = Math.min(least, /^\s*/.exec(text)[0].length);
      }
    }
  }
  return least === Infinity ? 0 : least;
}

const numbered = (lines, start, className, indent = 0) =>
  lines.map((text, index) => ({
    key: `${className}${start + index}`,
    no: start + index + 1,
    text: text.slice(indent),
    className: `line ${className}`
  }));

export default class FlowTextMerge extends LightningElement {
  @api labels = {};
  picks = {};
  editing = false;
  manualText;
  // What the editor started with, to tell whether anything was edited.
  editStart;
  // Picks or edits brought back from before a reload; cleared by a new one.
  restored = false;
  // Brought back on returning to a mapping, rather than after a reload.
  restoredAgain = false;
  // Drafts made against other XML: kept, not applied, newest first.
  aside = [];
  // Keys of long changes opened out.
  expanded = {};
  // How many changes are listed.
  shownChanges = CHANGE_PAGE;
  _sides;
  _draftKey;
  _draftFor;
  _connected = false;
  // Typing that hasn't paused yet, so isn't checked.
  checking = false;
  _editTimer;
  // Derived data, filled while rendering; not reactive.
  _cache = {};

  /** { before, after } or { base, ours, theirs }: flow metadata. */
  @api
  get sides() {
    return this._sides;
  }
  set sides(value) {
    // The same flows again (a parent re-rendering) keep the picks made so far.
    if (sameSides(this._sides, value)) {
      return;
    }
    // Typing that hadn't paused is kept, against the XML it was typed in.
    this.settleEdit(false);
    this._sides = value;
    this._cache = {};
    this.expanded = {};
    this.shownChanges = CHANGE_PAGE;
    this.picks = {};
    this.editing = false;
    this.manualText = undefined;
    this.editStart = undefined;
    this.restored = false;
    this.restoreDraft();
    this.notifyLater();
  }

  /** Identifies the versions being merged, as for the visual merge. */
  @api
  get draftKey() {
    return this._draftKey;
  }
  set draftKey(value) {
    this._draftKey = value;
    this.restoreDraft();
    this.notifyLater();
  }

  connectedCallback() {
    this._connected = true;
    this.notify();
  }

  disconnectedCallback() {
    this._connected = false;
    // Typing right before leaving is still kept.
    if (this._editTimer) {
      clearTimeout(this._editTimer);
      this._editTimer = undefined;
      this.saveDraft();
    }
  }

  renderedCallback() {
    this.syncGutter();
  }

  // Once per merge, brings back the picks and hand edits made before a
  // reload; picks only where they still name a change and a side.
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
    // Picks and edits from another merge never carry over, even when there's
    // no draft for this one.
    if (draftFor) {
      clearTimeout(this._editTimer);
      this._editTimer = undefined;
      this.checking = false;
      this.picks = {};
      this.editing = false;
      this.manualText = undefined;
      this.editStart = undefined;
      this.restored = false;
    }
    this.aside = [];
    // The same merge seen again is a mapping chosen again.
    this.restoredAgain = Boolean(draftFor && draftFor.key === key);
    this._draftFor = { sides: this._sides, key };
    const saved = readDraft(DRAFTS.text, key);
    if (!saved) {
      return;
    }
    // Only a draft made against this very XML applies; the others wait.
    const source = this.source;
    const drafts = [saved, ...(Array.isArray(saved.aside) ? saved.aside : [])]
      .filter(hasWork)
      .map(({ format, source: from, picks, text }) => ({
        format,
        source: from,
        picks,
        text
      }));
    const fits = drafts.find(
      (draft) => draft.format === DRAFT_FORMAT && draft.source === source
    );
    this.aside = drafts.filter((draft) => draft !== fits).slice(0, ASIDE_KEPT);
    if (fits) {
      this.applyDraft(fits);
    }
    // Kept as now arranged, so a save that clears this merge's draft
    // leaves the ones set aside.
    this.keepDraft();
  }

  // Picks only where they still name a change and a side.
  applyDraft(fits) {
    const indexes = new Set(
      this.threeWay
        ? this.merged.conflicts.map((conflict) => conflict.index)
        : this.xml.blocks.map((block) => block.index)
    );
    const sides = new Set(this.options.map((option) => option.value));
    const picks = {};
    for (const [index, side] of Object.entries(fits.picks || {})) {
      if (indexes.has(Number(index)) && sides.has(side)) {
        picks[index] = side;
      }
    }
    this.picks = picks;
    if (typeof fits.text === "string") {
      this.editStart = this.markedText;
      this.manualText = fits.text;
      this.editing = true;
    }
    this.restored = this.editing || Object.keys(picks).length > 0;
  }

  // Every pick and edit goes through here, so the draft keeps up.
  saveDraft() {
    this.restored = false;
    this.keepDraft();
  }

  keepDraft() {
    if (!this._draftKey) {
      return;
    }
    const value = {};
    if (Object.keys(this.picks).length) {
      value.picks = this.picks;
    }
    if (this.edited) {
      value.text = this.manualText;
    }
    if (hasWork(value)) {
      value.format = DRAFT_FORMAT;
      value.source = this.source;
    }
    if (this.aside.length) {
      value.aside = this.aside;
    }
    // Work set aside is the first to go when storage is full, oldest
    // first: this merge's own picks and edits matter more.
    while (!writeDraft(DRAFTS.text, this._draftKey, value) && value.aside) {
      this.aside = this.aside.slice(0, -1);
      if (this.aside.length) {
        value.aside = this.aside;
      } else {
        delete value.aside;
      }
    }
  }

  // The XML this merge is of, as a draft names it.
  get source() {
    const cache = this._cache;
    if (!cache.source && this.xml) {
      const names = this.threeWay
        ? ["base", "ours", "theirs"]
        : ["before", "after"];
      cache.source = fingerprint([
        names,
        ...names.map((name) => this.xml[name].lines)
      ]);
    }
    return cache.source;
  }

  get hasAside() {
    return this.aside.length > 0;
  }

  get asideText() {
    const what = this.asideEdited ? "picks and hand edits" : "picks";
    if (this.aside.some((draft) => draft.format !== DRAFT_FORMAT)) {
      return `Your earlier XML ${what} were made with an earlier version of Tributary, so they aren't applied to this XML.`;
    }
    return `Your earlier XML ${what} were made against different XML (another mapping, or these flows before they changed), so they aren't applied here. Choosing that mapping again brings them back.`;
  }

  // The newest hand-edited XML set aside, to copy from.
  get asideEdited() {
    const draft = this.aside.find((item) => typeof item.text === "string");
    return draft && draft.text;
  }

  handleDiscardAside() {
    this.aside = [];
    this.keepDraft();
  }

  get restoredText() {
    const what = this.editing ? "hand edits" : "picks";
    return this.restoredAgain
      ? `Your ${what} for this mapping are back.`
      : `Your ${what} from before the page reloaded are back.`;
  }

  // New flows after the first render: the parent hears once it's done
  // rendering, not in the middle.
  notifyLater() {
    if (this._connected) {
      Promise.resolve().then(() => this.notify());
    }
  }

  label(side) {
    return (this.labels && this.labels[side]) || side;
  }

  get threeWay() {
    return Boolean(this._sides && this._sides.base);
  }

  get xml() {
    if (!this._cache.xml && this._sides) {
      const names = this.threeWay
        ? ["base", "ours", "theirs"]
        : ["before", "after"];
      const xml = {};
      for (const name of names) {
        xml[name] = toXml(this._sides[name]);
      }
      if (this.threeWay) {
        // Diffing both sides is the slow part of a merge and doesn't depend
        // on picks, so it's done once for the sides.
        xml.plan = planThreeWay(
          xml.base.lines,
          xml.ours.lines,
          xml.theirs.lines,
          {
            base: xml.base.ranges,
            ours: xml.ours.ranges,
            theirs: xml.theirs.ranges
          },
          movedOnly
        );
      } else {
        xml.ops = diffLines(xml.before.lines, xml.after.lines, {
          a: xml.before.ranges,
          b: xml.after.ranges
        });
        xml.blocks = changeBlocks(xml.ops);
      }
      this._cache.xml = xml;
    }
    return this._cache.xml;
  }

  get ready() {
    return Boolean(this.xml);
  }

  // Many getters read the merge on each render, so it's worked out once per
  // set of sides and picks.
  get merged() {
    const { xml, picks } = this;
    const cache = this._cache;
    if (
      cache.merged &&
      cache.mergedXml === xml &&
      cache.mergedPicks === picks
    ) {
      return cache.merged;
    }
    cache.merged = this.mergeOf(xml, picks);
    cache.mergedXml = xml;
    cache.mergedPicks = picks;
    return cache.merged;
  }

  mergeOf(xml, picks) {
    if (this.threeWay) {
      return applyThreeWay(xml.plan, picks);
    }
    return {
      lines: mergeTwoWay(xml.before.lines, xml.after.lines, xml.ops, picks),
      conflicts: []
    };
  }

  get resultText() {
    return this.editing && this.manualText !== undefined
      ? this.manualText
      : this.merged.lines.join("\n") + "\n";
  }

  // The result with every conflict still to pick written out in full,
  // between markers, for editing by hand.
  get markedText() {
    if (!this.threeWay) {
      return this.resultText;
    }
    const { chunks, conflicts } = this.merged;
    const lines = [];
    for (const chunk of chunks) {
      if (chunk.type === "conflict" && this.picks[chunk.index] === undefined) {
        const conflict = conflicts[chunk.index];
        lines.push(
          `<<<<<<< ${this.label("ours")}`,
          ...conflict.ours,
          "=======",
          ...conflict.theirs,
          `>>>>>>> ${this.label("theirs")}`
        );
      } else {
        lines.push(...chunk.lines);
      }
    }
    return lines.join("\n") + "\n";
  }

  get sideModels() {
    if (!this._cache.models) {
      this._cache.models = Object.values(this._sides).map((side) =>
        buildModel(side)
      );
    }
    return this._cache.models;
  }

  // The result read back, and the errors Salesforce would reject it for.
  get parsed() {
    const text = this.resultText;
    const cache = this._cache;
    // While typing, the last check stands until the typing pauses.
    if (cache.parsed && this.checking) {
      return cache.parsed;
    }
    if (!cache.parsed || cache.parsedText !== text) {
      try {
        const metadata = fromXml(text);
        const issues = validateFlow(buildModel(metadata), this.sideModels);
        const problems = issues
          .filter((issue) => issue.severity === ERROR)
          .map((issue) => issue.message);
        const warnings = issues
          .filter((issue) => issue.severity !== ERROR)
          .map((issue) => issue.message);
        cache.parsed = { metadata, problems, warnings };
      } catch (e) {
        cache.parsed = {
          error: e.message,
          errorLine: e.line,
          problems: [],
          warnings: []
        };
      }
      cache.parsedText = text;
    }
    return cache.parsed;
  }

  get unresolved() {
    if (this.editing) {
      return (this.manualText || "")
        .split("\n")
        .filter((line) => MARKER.test(line)).length;
    }
    if (!this.threeWay) {
      return 0;
    }
    return this.merged.conflicts.filter(
      (conflict) => this.picks[conflict.index] === undefined
    ).length;
  }

  notify() {
    if (!this.ready) {
      return;
    }
    const parsed = this.parsed;
    this.dispatchEvent(
      new CustomEvent("resultchange", {
        detail: {
          metadata: parsed.metadata,
          error: parsed.error,
          problems: parsed.problems,
          warnings: parsed.warnings,
          unresolved: this.unresolved,
          text: this.resultText,
          handEdits: this.handEdits
        }
      })
    );
  }

  get options() {
    if (this.threeWay) {
      return [
        { label: this.label("ours"), value: "ours" },
        { label: this.label("theirs"), value: "theirs" },
        { label: "Both", value: "both" }
      ];
    }
    return [
      { label: `Keep ${this.label("before")}`, value: "a" },
      { label: `Take ${this.label("after")}`, value: "b" },
      { label: "Both", value: "both" }
    ];
  }

  // What each change is, once per merge: its lines and where they are.
  // Picks don't change which changes there are, only which side is used.
  get shapes() {
    const cache = this._cache;
    if (!cache.shapes) {
      cache.shapes = this.threeWay ? this.conflictShapes() : this.blockShapes();
    }
    return cache.shapes;
  }

  conflictShapes() {
    const { xml } = this;
    return this.merged.conflicts.map((conflict) => ({
      key: `c${conflict.index}`,
      index: conflict.index,
      title: `Conflict ${conflict.index + 1}`,
      element: whereIs(
        ["ours", "theirs"].map((side) => ({
          ranges: xml[side].ranges,
          lines: conflict[side],
          start: conflict[`${side}Start`]
        }))
      ),
      // Both sides adding at the same spot is the usual case for Both.
      hint: conflict.base.length
        ? undefined
        : "Both sides added lines here. Both keeps them all.",
      // Two copies of one changed line (a single tag) isn't valid XML.
      noBoth:
        conflict.base.length > 0 &&
        conflict.ours.length === 1 &&
        conflict.theirs.length === 1,
      indent: indentOf([conflict.ours, conflict.theirs]),
      columns: [
        {
          key: "ours",
          lines: conflict.ours,
          start: conflict.oursStart,
          className: "side-ours"
        },
        {
          key: "theirs",
          lines: conflict.theirs,
          start: conflict.theirsStart,
          className: "side-theirs"
        }
      ]
    }));
  }

  blockShapes() {
    const { xml } = this;
    return xml.blocks.map((block) => {
      const before = xml.before.lines.slice(block.aStart, block.aEnd);
      const after = xml.after.lines.slice(block.bStart, block.bEnd);
      return {
        key: `b${block.index}`,
        index: block.index,
        title: `Change ${block.index + 1}`,
        element: whereIs([
          { ranges: xml.after.ranges, lines: after, start: block.bStart },
          { ranges: xml.before.ranges, lines: before, start: block.aStart }
        ]),
        noBoth: false,
        indent: indentOf([before, after]),
        columns: [
          {
            key: "before",
            lines: before,
            start: block.aStart,
            className: "del"
          },
          { key: "after", lines: after, start: block.bStart, className: "ins" }
        ]
      };
    });
  }

  // The changes as listed, the first shownChanges of them. The template
  // reads them on each render, so they're worked out once per set of picks,
  // labels, changes opened out and changes shown.
  get changes() {
    const { shapes, picks, labels, expanded, shownChanges } = this;
    const cache = this._cache;
    const inputs = [shapes, picks, labels, expanded, shownChanges];
    if (
      !cache.changes ||
      !cache.changesFor.every((input, index) => input === inputs[index])
    ) {
      cache.changes = this.listChanges(shapes.slice(0, shownChanges), picks);
      cache.changesFor = inputs;
    }
    return cache.changes;
  }

  // The button that lists more changes, while some aren't listed.
  get moreChangesText() {
    const rest = this.shapes.length - this.shownChanges;
    if (rest <= 0) {
      return undefined;
    }
    const word = this.threeWay ? "conflict" : "change";
    return `Show the next ${plural(Math.min(rest, CHANGE_PAGE), word)} (${rest} not shown)`;
  }

  handleMoreChanges() {
    this.shownChanges += CHANGE_PAGE;
  }

  listChanges(shapes, picks) {
    const { threeWay } = this;
    const options = this.options;
    const withoutBoth = options.filter((option) => option.value !== "both");
    return shapes.map((shape) => {
      const picked = picks[shape.index];
      const count = shape.columns.reduce(
        (sum, column) => sum + column.lines.length,
        0
      );
      // A long change starts folded, its lines laid out once opened.
      const foldable = count > FOLD_LINES;
      const open = !foldable || Boolean(this.expanded[shape.key]);
      return {
        key: shape.key,
        index: shape.index,
        title: shape.title,
        element: shape.element,
        hint: shape.hint,
        className:
          threeWay && picked === undefined ? "change unresolved" : "change",
        options: shape.noBoth ? withoutBoth : options,
        value: threeWay ? picked || "" : picked || "a",
        foldable,
        open,
        foldLabel: open ? "Fold these lines" : `Show all ${count} lines`,
        expandedText: open ? "true" : "false",
        columns: open
          ? shape.columns.map((column) => ({
              key: column.key,
              label: this.label(column.key),
              lines: this.linesOf(shape, column)
            }))
          : []
      };
    });
  }

  // A change's numbered lines, laid out once.
  linesOf(shape, column) {
    const cache = this._cache;
    if (!cache.lines) {
      cache.lines = new Map();
    }
    const id = `${shape.key}:${column.key}`;
    if (!cache.lines.has(id)) {
      cache.lines.set(
        id,
        numbered(column.lines, column.start, column.className, shape.indent)
      );
    }
    return cache.lines.get(id);
  }

  handleFold(event) {
    const { key } = event.currentTarget.dataset;
    this.expanded = { ...this.expanded, [key]: !this.expanded[key] };
  }

  get hasChanges() {
    return this.shapes.length > 0;
  }

  get noChangesText() {
    return this.threeWay
      ? "No conflicts: every change was made on one side only and applies by itself."
      : "The two flows produce identical XML.";
  }

  get autoSummary() {
    if (!this.threeWay) {
      return undefined;
    }
    const chunks = this.merged.chunks;
    const count = (type) => chunks.filter((c) => c.type === type).length;
    const same = count("both");
    const moved = count("minor");
    return `${plural(count("ours"), "change")} from ${this.label("ours")} and ${count("theirs")} from ${this.label("theirs")} apply by themselves${same ? `; ${same} made the same way on both sides` : ""}.${moved ? ` ${plural(moved, "place")} where the versions differ only in where elements sit on the canvas ${moved === 1 ? "isn't a conflict" : "aren't conflicts"}: the other change applies, or ${this.label("ours")}'s positions.` : ""}`;
  }

  get countText() {
    const total = this.shapes.length;
    if (this.threeWay) {
      return `${plural(total, "conflict")}, ${this.unresolved} unresolved`;
    }
    return plural(total, "change");
  }

  // Conflicts first: leftover markers are also why hand-edited XML won't
  // read.
  get status() {
    const parsed = this.parsed;
    const { unresolved } = this;
    if (unresolved) {
      return {
        className: "status status-warning",
        text: this.editing
          ? `Resolve ${plural(unresolved, "conflict")}: keep the lines you want between the <<<<<<< and >>>>>>> markers, then delete the markers.`
          : `Pick a side for ${plural(unresolved, "conflict")}.`
      };
    }
    if (parsed.error) {
      return {
        className: "status status-error",
        text: `Not valid flow XML. ${parsed.error}`
      };
    }
    if (parsed.problems.length) {
      const more = parsed.problems.length - 1;
      return {
        className: "status status-error",
        text: `The XML reads as a flow, but Salesforce would reject it. ${parsed.problems[0]}${more ? ` And ${more} more error${more === 1 ? "" : "s"}.` : ""}`
      };
    }
    return {
      className: "status status-ok",
      text: "The merged XML reads as a flow and passes local checks."
    };
  }

  get edited() {
    return this.editing && this.manualText !== this.editStart;
  }

  // Lines added and removed by hand since editing began, so the receipt can
  // say the result isn't only what was picked.
  get handEdits() {
    if (!this.edited) {
      return null;
    }
    const cache = this._cache;
    if (
      cache.editsTo !== this.manualText ||
      cache.editsFrom !== this.editStart
    ) {
      const edits = { added: 0, removed: 0 };
      for (const op of diffLines(
        this.editStart.split("\n"),
        this.manualText.split("\n")
      )) {
        if (op.type === INSERT) {
          edits.added += 1;
        } else if (op.type === DELETE) {
          edits.removed += 1;
        }
      }
      cache.edits = edits;
      cache.editsTo = this.manualText;
      cache.editsFrom = this.editStart;
    }
    return cache.edits;
  }

  get editLabel() {
    if (!this.editing) {
      return "Edit the result by hand";
    }
    return this.edited ? "Discard hand edits" : "Back to picking changes";
  }

  get editIcon() {
    return this.edited
      ? "utility:undo"
      : this.editing
        ? "utility:back"
        : "utility:edit";
  }

  get presets() {
    if (this.threeWay) {
      return [
        { key: "ours", label: `Use ${this.label("ours")} for all` },
        { key: "theirs", label: `Use ${this.label("theirs")} for all` }
      ];
    }
    return [
      { key: "a", label: `Keep all of ${this.label("before")}` },
      { key: "b", label: `Take all of ${this.label("after")}` }
    ];
  }

  get notEditing() {
    return !this.editing;
  }

  get gutterText() {
    const count = (this.resultText || "").split("\n").length;
    return Array.from({ length: count }, (_, index) => index + 1).join("\n");
  }

  // Where the editor can take you: the next conflict left, or the line the
  // XML stops reading at.
  get jump() {
    if (!this.editing) {
      return undefined;
    }
    if (this.unresolved) {
      return { label: "Go to the next conflict", marker: true };
    }
    const line = this.parsed.errorLine;
    return line ? { label: `Go to line ${line}`, line } : undefined;
  }

  syncGutter() {
    const area = this.template.querySelector(".manual");
    const gutter = this.template.querySelector(".gutter");
    if (area && gutter) {
      gutter.scrollTop = area.scrollTop;
    }
  }

  handleScroll() {
    this.syncGutter();
  }

  handleJump() {
    const area = this.template.querySelector(".manual");
    const jump = this.jump;
    if (!area || !jump) {
      return;
    }
    const lines = area.value.split("\n");
    let target = jump.line;
    if (jump.marker) {
      // The first marker below the caret, else the first of all.
      const caret = area.value.slice(0, area.selectionStart).split("\n").length;
      const markers = lines
        .map((text, index) => (MARKER.test(text) ? index + 1 : 0))
        .filter(Boolean);
      target = markers.find((line) => line > caret) || markers[0];
    }
    if (!target || target > lines.length) {
      return;
    }
    const start = lines
      .slice(0, target - 1)
      .reduce((sum, text) => sum + text.length + 1, 0);
    area.focus();
    area.setSelectionRange(start, start + lines[target - 1].length);
    const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 20;
    area.scrollTop = Math.max(0, (target - 3) * lineHeight);
    this.syncGutter();
  }

  handlePick(event) {
    const index = Number(event.target.dataset.index);
    this.picks = { ...this.picks, [index]: event.detail.value };
    this.saveDraft();
    this.notify();
  }

  handlePreset(event) {
    const side = event.target.dataset.side;
    const picks = {};
    for (const shape of this.shapes) {
      picks[shape.index] = side;
    }
    this.picks = picks;
    this.saveDraft();
    this.notify();
  }

  // Leaving the editor drops what was typed and goes back to the picks.
  toggleEdit() {
    this.settleEdit(false);
    if (this.editing) {
      this.editing = false;
      this.manualText = undefined;
      this.editStart = undefined;
    } else {
      this.manualText = this.markedText;
      this.editStart = this.manualText;
      this.editing = true;
    }
    this.saveDraft();
    this.notify();
  }

  // Each keystroke only updates the text. Parsing, checking and keeping the
  // draft wait for a pause, and the merge can't be saved in between.
  handleEdit(event) {
    this.manualText = event.target.value;
    clearTimeout(this._editTimer);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    this._editTimer = setTimeout(() => this.settleEdit(), EDIT_PAUSE);
    if (!this.checking) {
      this.checking = true;
      this.dispatchEvent(
        new CustomEvent("resultchange", { detail: { pending: true } })
      );
    }
  }

  settleEdit(notify = true) {
    if (!this._editTimer) {
      return;
    }
    clearTimeout(this._editTimer);
    this._editTimer = undefined;
    this.checking = false;
    this.saveDraft();
    if (notify) {
      this.notify();
    }
  }
}
