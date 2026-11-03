/**
 * GitHub-style diff of two flows as Metadata API XML, unified or side by
 * side. Clicking a line, or the element named in a hunk's header, selects the
 * element it belongs to (select { id }); setting focusId highlights an
 * element's lines and reveal(id) scrolls the diff to them.
 *
 * Unchanged stretches are folded; opening one opens only that stretch.
 */
import { LightningElement, api } from "lwc";
import { toXml } from "c/flowXml";
import { diffLines, toHunks, EQUAL, INSERT, DELETE } from "c/lineDiff";
import { visibleText } from "c/flowUtils";

const UNIFIED = "unified";
const SPLIT = "split";

const CONTEXT = 3;

// Ranges sorted by first line, to find the element a line belongs to.
function rangeIndex(ranges) {
  return [...ranges.entries()]
    .map(([id, range]) => ({ id, ...range }))
    .sort((p, q) => p.start - q.start);
}

function elementAt(index, line) {
  if (line === null || line === undefined) {
    return undefined;
  }
  let low = 0;
  let high = index.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = index[mid];
    if (line < range.start) {
      high = mid - 1;
    } else if (line > range.end) {
      low = mid + 1;
    } else {
      return range.id;
    }
  }
  return undefined;
}

const ROW_CLASS = {
  [EQUAL]: "row",
  [INSERT]: "row row-insert",
  [DELETE]: "row row-delete"
};

const SIGN = { [EQUAL]: " ", [INSERT]: "+", [DELETE]: "-" };

// Read out in place of the colour and the sign.
const CHANGE_TEXT = { [INSERT]: "Added line", [DELETE]: "Removed line" };

function unchangedText(count) {
  return `${count} unchanged line${count === 1 ? "" : "s"}`;
}

function within(ranges, line) {
  return ranges.some((range) => line >= range.from && line <= range.to);
}

export default class FlowTextDiff extends LightningElement {
  @api labels = {};
  showAll = false;
  focus;
  // Folded stretches opened one by one, as { from, to } lines of the first
  // flow (1-based); the last one opened fades in.
  openGaps = [];
  _fresh;
  _focusCode = false;
  _layout = UNIFIED;
  _before;
  _after;
  // Derived data, filled while rendering; not reactive.
  _cache = {};

  @api
  get layout() {
    return this._layout;
  }
  set layout(value) {
    this._layout = value === SPLIT ? SPLIT : UNIFIED;
  }

  /** Flow metadata for each side. */
  @api
  get before() {
    return this._before;
  }
  set before(value) {
    this._before = value;
    this.reset();
  }

  @api
  get after() {
    return this._after;
  }
  set after(value) {
    this._after = value;
    this.reset();
  }

  reset() {
    this._cache.computed = undefined;
    this.openGaps = [];
    this._fresh = undefined;
  }

  /** The element ("type:key") whose lines are highlighted. */
  @api
  get focusId() {
    return this.focus;
  }
  set focusId(value) {
    this.focus = value;
  }

  /**
   * Highlights an element's lines and scrolls the diff, and only the diff,
   * so they are in the middle of it.
   */
  @api
  reveal(id) {
    this.focus = id;
    // The rows render on the next cycle when the focus opened hidden lines.
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    requestAnimationFrame(() => {
      const row = [...this.template.querySelectorAll("[data-first]")].find(
        (candidate) => candidate.dataset.first === id
      );
      const code = this.refs && this.refs.code;
      if (!row || !code) {
        return;
      }
      if (code.scrollHeight > code.clientHeight) {
        const offset =
          row.getBoundingClientRect().top - code.getBoundingClientRect().top;
        const top = Math.max(
          0,
          code.scrollTop + offset - (code.clientHeight - row.offsetHeight) / 2
        );
        const still =
          window.matchMedia &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (code.scrollTo) {
          code.scrollTo({ top, behavior: still ? "auto" : "smooth" });
        } else {
          code.scrollTop = top;
        }
      } else if (row.scrollIntoView) {
        // The diff isn't a scroller of its own here: move the page no more
        // than needed.
        row.scrollIntoView({ block: "nearest" });
      }
    });
  }

  renderedCallback() {
    if (this._focusCode) {
      this._focusCode = false;
      const code = this.refs && this.refs.code;
      if (code) {
        code.focus({ preventScroll: true });
      }
    }
  }

  get computed() {
    if (!this._cache.computed && this._before && this._after) {
      const a = toXml(this._before);
      const b = toXml(this._after);
      const ops = diffLines(a.lines, b.lines, { a: a.ranges, b: b.ranges });
      this._cache.computed = {
        a,
        b,
        ops,
        aIndex: rangeIndex(a.ranges),
        bIndex: rangeIndex(b.ranges),
        changed: ops.some((op) => op.type !== EQUAL)
      };
    }
    return this._cache.computed;
  }

  get ready() {
    return Boolean(this.computed);
  }

  get identical() {
    return this.ready && !this.computed.changed;
  }

  get isSplit() {
    return this._layout === SPLIT;
  }

  get beforeLabel() {
    return (this.labels && this.labels.before) || "Before";
  }

  get afterLabel() {
    return (this.labels && this.labels.after) || "After";
  }

  get layoutOptions() {
    return [
      { label: "Unified", value: UNIFIED },
      { label: "Split", value: SPLIT }
    ];
  }

  /** Whether any unchanged lines are folded away. */
  get folded() {
    if (!this.ready || this.showAll) {
      return false;
    }
    const { hunks, skippedAfterText } = this.view;
    return Boolean(skippedAfterText) || hunks.some((hunk) => hunk.skipped);
  }

  get canCollapse() {
    return this.showAll || this.openGaps.length > 0;
  }

  // The element each side's line (1-based) belongs to.
  elementOf(row) {
    const { aIndex, bIndex } = this.computed;
    return (
      (row.b !== null && elementAt(bIndex, row.b - 1)) ||
      (row.a !== null && elementAt(aIndex, row.a - 1)) ||
      undefined
    );
  }

  // Lines of the focused element, so the element shows even when unchanged.
  focusLines() {
    if (!this.focus) {
      return undefined;
    }
    const { a, b } = this.computed;
    return {
      a: a.ranges.get(this.focus),
      b: b.ranges.get(this.focus)
    };
  }

  // The template reads the view several times a render: build it once for
  // the same inputs.
  get view() {
    const inputs = [
      this.computed,
      this.focus,
      this.showAll,
      this.openGaps,
      this._fresh,
      this._layout
    ];
    const memo = this._cache.view;
    if (!memo || memo.inputs.some((input, i) => input !== inputs[i])) {
      this._cache.view = { inputs, value: this.buildView() };
    }
    return this._cache.view.value;
  }

  buildView() {
    const { a, ops } = this.computed;
    const focus = this.focusLines();
    const context = this.showAll ? Infinity : CONTEXT;
    const opened = this.openGaps;
    let view = ops;
    if (!this.showAll && ((focus && (focus.a || focus.b)) || opened.length)) {
      // Keep the focused element's lines and the opened stretches by giving
      // toHunks a copy where they count as changes, then restore their type.
      const inFocus = (op) =>
        focus &&
        ((focus.b &&
          op.type !== DELETE &&
          op.b >= focus.b.start &&
          op.b <= focus.b.end) ||
          (focus.a &&
            op.type !== INSERT &&
            op.a >= focus.a.start &&
            op.a <= focus.a.end));
      view = ops.map((op) =>
        op.type === EQUAL && (inFocus(op) || within(opened, op.a + 1))
          ? { ...op, focus: true }
          : op
      );
    }
    const { hunks, skippedAfter } = toHunksWithFocus(view, context);
    const fresh = this._fresh ? [this._fresh] : [];
    const seen = new Set();
    // The last line of the first flow shown so far, to name folded stretches.
    let shown = 0;
    const out = hunks.map((hunk) => {
      const firstChange =
        hunk.rows.find((row) => row.type !== EQUAL) || hunk.rows[0];
      const element = this.elementOf(firstChange);
      const rows = hunk.rows.map((row) => {
        const id = this.elementOf(row);
        const first = id && !seen.has(id) ? id : undefined;
        if (first) {
          seen.add(first);
        }
        let className = ROW_CLASS[row.type];
        if (id && id === this.focus) {
          className += " focused";
        }
        if (row.type === EQUAL && within(fresh, row.a)) {
          className += " fresh";
        }
        return {
          // Line numbers, so rows keep their place as stretches open.
          key: `${row.a}-${row.b}`,
          type: row.type,
          a: row.a,
          b: row.b,
          text: row.text,
          parts: [{ key: 0, text: visibleText(row.text), className: "" }],
          sign: SIGN[row.type],
          changeText: CHANGE_TEXT[row.type],
          element: id,
          first,
          className
        };
      });
      const gap = { from: shown + 1, to: hunk.aStart - 1 };
      if (hunk.aLines) {
        shown = hunk.aStart + hunk.aLines - 1;
      }
      const top = rows[0];
      // Pairing also marks the changed span in each unified row.
      const pairs = pairRows(rows);
      return {
        key: `h${top.a}-${top.b}`,
        skipped: hunk.skippedBefore,
        skippedText: unchangedText(hunk.skippedBefore),
        gapFrom: gap.from,
        gapTo: gap.to,
        header: `@@ -${hunk.aStart},${hunk.aLines} +${hunk.bStart},${hunk.bLines} @@`,
        element,
        elementText: element ? element.replace(":", " › ") : "",
        inspectText: element
          ? `Select ${element.replace(":", " ")} on the canvas`
          : "",
        rows,
        pairs: this.isSplit ? pairs : []
      };
    });
    return {
      hunks: out,
      skippedAfterText: skippedAfter ? unchangedText(skippedAfter) : "",
      afterFrom: shown + 1,
      afterTo: a.lines.length
    };
  }

  get stats() {
    const { ops } = this.computed;
    const added = ops.filter((op) => op.type === INSERT).length;
    const removed = ops.filter((op) => op.type === DELETE).length;
    return { added: `+${added}`, removed: `−${removed}` };
  }

  handleLayout(event) {
    this._layout = event.detail.value;
    this.dispatchEvent(
      new CustomEvent("layoutchange", { detail: { layout: this._layout } })
    );
  }

  handleShowAll() {
    this.showAll = true;
    this._fresh = undefined;
  }

  handleCollapse() {
    this.showAll = false;
    this.openGaps = [];
    this._fresh = undefined;
  }

  // Opens the one folded stretch that was chosen.
  expand(event) {
    const from = Number(event.currentTarget.dataset.from);
    const to = Number(event.currentTarget.dataset.to);
    if (!(to >= from)) {
      return;
    }
    this._fresh = { from, to };
    this.openGaps = [...this.openGaps, this._fresh];
    // The button goes away with the stretch: keep focus in the diff.
    this._focusCode = true;
  }

  handleRowClick(event) {
    const { element } = event.currentTarget.dataset;
    if (element) {
      this.dispatchEvent(
        new CustomEvent("select", { detail: { id: element } })
      );
    }
  }
}

// toHunks keeps `context` lines around changes; focused equal lines are kept
// too by treating them as changes while grouping.
function toHunksWithFocus(ops, context) {
  if (!ops.some((op) => op.focus)) {
    return toHunks(ops, context);
  }
  const marked = ops.map((op) => (op.focus ? { ...op, type: "focus" } : op));
  const { hunks, skippedAfter } = toHunks(marked, context);
  for (const hunk of hunks) {
    hunk.rows = hunk.rows.map((row) =>
      row.type === "focus" ? { ...row, type: EQUAL, block: null } : row
    );
  }
  return { hunks, skippedAfter };
}

// Linear-time emphasis, not a second diff of potentially enormous strings.
// Only matching scalar XML tags in the same element can be an inline edit.
function emphasize(left, right) {
  if (!left || !right || left.element !== right.element) return;
  const tag = /^\s*<([A-Za-z][A-Za-z0-9_:]*)>[^<]*<\/\1>\s*$/;
  const aTag = tag.exec(left.text);
  const bTag = tag.exec(right.text);
  if (!aTag || !bTag || aTag[1] !== bTag[1]) return;
  const a = Array.from(left.text);
  const b = Array.from(right.text);
  let start = 0;
  let end = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  while (
    end < Math.min(a.length, b.length) - start &&
    a[a.length - end - 1] === b[b.length - end - 1]
  )
    end++;
  const parts = (text) =>
    [
      {
        key: 0,
        text: visibleText(text.slice(0, start).join("")),
        className: ""
      },
      {
        key: 1,
        text: visibleText(text.slice(start, text.length - end).join("")),
        className: "inline-change"
      },
      {
        key: 2,
        text: visibleText(text.slice(text.length - end).join("")),
        className: ""
      }
    ].filter((part) => part.text);
  left.parts = parts(a);
  right.parts = parts(b);
}

function focusedOf(row) {
  return row.className.includes("focused") ? " focused" : "";
}

// Side-by-side rows: equal lines on both sides, and within a change the
// deleted lines next to the inserted ones of the same element. Lines of
// different elements never share a row, so one doesn't read as edited into
// the other.
function pairRows(rows) {
  const pairs = [];
  let deletes = [];
  let inserts = [];
  const flush = () => {
    // Where each element's inserted lines end, so a deleted line can tell
    // whether its element is still to come without searching.
    const lastInsert = new Map();
    inserts.forEach((row, index) => lastInsert.set(row.element, index));
    let i = 0;
    let j = 0;
    while (i < deletes.length || j < inserts.length) {
      let left = deletes[i];
      let right = inserts[j];
      if (left && right && left.element !== right.element) {
        // The side whose element the other doesn't come to goes alone.
        const later = (lastInsert.get(left.element) ?? -1) >= j;
        if (later) {
          left = undefined;
        } else {
          right = undefined;
        }
      }
      if (left) {
        i++;
      }
      if (right) {
        j++;
      }
      emphasize(left, right);
      pairs.push({
        key: `${(left || right).key}p`,
        left: left
          ? {
              no: left.a,
              text: left.text,
              parts: left.parts,
              changeText: left.changeText,
              className: `cell cell-delete${focusedOf(left)}`,
              element: left.element,
              first: left.first
            }
          : { no: "", text: "", parts: [], className: "cell cell-empty" },
        right: right
          ? {
              no: right.b,
              text: right.text,
              parts: right.parts,
              changeText: right.changeText,
              className: `cell cell-insert${focusedOf(right)}`,
              element: right.element,
              first: right.first
            }
          : { no: "", text: "", parts: [], className: "cell cell-empty" }
      });
    }
    deletes = [];
    inserts = [];
  };
  for (const row of rows) {
    if (row.type === DELETE) {
      deletes.push(row);
    } else if (row.type === INSERT) {
      inserts.push(row);
    } else {
      flush();
      const focused = `${focusedOf(row)}${row.className.includes("fresh") ? " fresh" : ""}`;
      pairs.push({
        key: `${row.key}p`,
        left: {
          no: row.a,
          text: row.text,
          parts: row.parts,
          className: `cell${focused}`,
          element: row.element,
          first: row.first
        },
        right: {
          no: row.b,
          text: row.text,
          parts: row.parts,
          className: `cell${focused}`,
          element: row.element
        }
      });
    }
  }
  flush();
  return pairs;
}
