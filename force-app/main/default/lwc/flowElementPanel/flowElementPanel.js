/**
 * Details of one element or resource from a diff: what changed, its
 * connectors and its properties. Given a merge, it also lets the user pick
 * which side each changed part comes from.
 *
 * Events:
 *   pick      { picks: { unitId: side } } to apply to the merge
 *   showtext  { id } to show the element in the XML view
 *   next      to go on to the next item, when nextLabel is set
 *   close
 */
import { LightningElement, api } from "lwc";
import {
  elementInfo,
  resourceInfo,
  connectorLabel,
  formatValue,
  phraseContext,
  slotLabel
} from "c/flowElements";
import {
  formatPath,
  REMOVED,
  ADDED,
  CHANGED,
  UNCHANGED,
  REORDERED
} from "c/flowDiff";
import { unitsForNode, picksForNode, SAME, CONFLICT, ERROR } from "c/flowMerge";
import { ITEM_KEYS, START, outgoing } from "c/flowModel";
import {
  humanize,
  humanPath,
  unitTitle,
  plural,
  visibleText
} from "c/flowUtils";

const STATUS_LABELS = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  unchanged: "Unchanged",
  retargeted: "Reconnected",
  reordered: "Reordered",
  excluded: "Not in result",
  conflict: "Conflict",
  resolved: "Resolved",
  ours: "Changed in ours",
  theirs: "Changed in theirs",
  differs: "Differs"
};

// Long values show only the lines the versions disagree on, until opened.
const COMPACT_LINES = 6;

function display(value, key) {
  const text = visibleText(formatValue(value, key));
  return { text, multiline: text.includes("\n") };
}

// A whole element's connectors come with it, so its choices show where each
// version's paths lead: versions alike but for a connector are told apart.
function wholeNodeValue(merge, unit, name) {
  const value = unit.values[name];
  if (unit.kind !== "node" || value === undefined) {
    return value;
  }
  const model = merge.sides[name];
  const node = model.nodes.get(unit.nodeKey);
  const paths = {};
  for (const edge of outgoing(model, unit.nodeKey)) {
    let label = slotLabel(node, edge.slot);
    if (label in paths) {
      label = `${label} (${edge.slot})`;
    }
    paths[label] =
      edge.isGoTo || edge.extra
        ? { target: edge.target, isGoTo: edge.isGoTo, ...edge.extra }
        : edge.target;
  }
  const shown = { type: elementInfo(node).label, ...value.fields };
  return Object.keys(paths).length ? { ...shown, connectors: paths } : shown;
}

// A copy of value with the part at path set, or removed when undefined.
function withPart(value, path, part) {
  if (!path.length) {
    return part;
  }
  const [segment, ...rest] = path;
  const copy = Array.isArray(value) ? [...value] : { ...value };
  let index = segment;
  if (Array.isArray(copy) && typeof segment !== "number") {
    index = copy.findIndex(
      (item) => item && ITEM_KEYS.some((key) => item[key] === segment)
    );
  }
  const next = withPart(copy[index] || {}, rest, part);
  if (next === undefined && !Array.isArray(copy)) {
    delete copy[index];
  } else {
    copy[index] = next;
  }
  return copy;
}

// The field a changed value is shown as: a record by the list it's in, so
// a parameter reads as one, and a plain value by its own field.
function fieldOf(change) {
  const value = change.after === undefined ? change.before : change.after;
  const { path } = change;
  return value && typeof value === "object" && path.length > 1
    ? path[path.length - 2]
    : path[path.length - 1];
}

// Changes inside one condition, assignment or the like come together as
// that part's sentence before and after, e.g. "Amount is greater than
// 10000" → "… 15000", rather than as the bare values that changed. Paths
// inside a changed element are numbered as its later version has them.
function plainChanges(changes, entry) {
  const groups = [];
  const byPath = new Map();
  const fields = (entry.after && entry.after.fields) || {};
  for (const change of changes) {
    const context =
      change.status === REORDERED
        ? undefined
        : phraseContext(fields, change.path);
    if (!context || context.path.length >= change.path.length) {
      groups.push({ change, key: fieldOf(change) });
      continue;
    }
    const id = JSON.stringify(context.path);
    let group = byPath.get(id);
    if (!group) {
      group = { context, parts: [] };
      byPath.set(id, group);
      groups.push(group);
    }
    group.parts.push(change);
  }
  return groups.map((group) => {
    if (group.change) {
      return group;
    }
    // The part as it was: the later one with each change undone.
    const { context, parts } = group;
    let before = context.value;
    for (const part of parts) {
      before = withPart(
        before,
        part.path.slice(context.path.length),
        part.before
      );
    }
    return {
      key: context.key,
      change: {
        path: context.path,
        status: CHANGED,
        before,
        after: context.value
      }
    };
  });
}

// Each value's lines, marking the ones not every value has, so the
// difference stands out in a long value. Absent values don't count.
function markLines(texts) {
  const present = texts.filter((text) => text !== undefined);
  const sets = present.map((text) => new Set(text.split("\n")));
  const multiline = present.some((text) => text.includes("\n"));
  return texts.map((text) => {
    if (text === undefined) {
      return [];
    }
    return text.split("\n").map((line, index) => {
      const differs = multiline && sets.some((set) => !set.has(line));
      return {
        key: `${index}`,
        text: line,
        differs,
        className: differs ? "vline vline-diff" : "vline"
      };
    });
  });
}

// What a screen reader hears after a side's name: the lines that differ,
// or the value itself when it's short.
function spoken(lines) {
  const differing = lines.filter((line) => line.differs);
  const chosen = differing.length ? differing : lines.slice(0, 3);
  const text = chosen.map((line) => line.text.trim()).join("; ");
  return lines.length > chosen.length && !differing.length
    ? `${text}; …`
    : text;
}

export default class FlowElementPanel extends LightningElement {
  /** A flowDiff node or resource entry. */
  @api entry;
  /** "node" or "resource". */
  @api kind = "node";
  /** The diff the entry is from, for connectors. */
  @api diff;
  /** Names for each side, e.g. { before: "Version 3", after: "Version 4" }. */
  @api labels = {};
  /** A flowMerge merge and its resolveMerge result, to pick sides. */
  @api merge;
  @api resolved;
  /** The merge's picks, for connectors sent somewhere else. */
  @api picks = {};
  @api hideText = false;
  /** Offers a button to the next item, e.g. "Next conflict", when set. */
  @api nextLabel;

  // Properties are only laid out while their section is open.
  propertiesOpen = false;
  // Derived data, filled while rendering; not reactive.
  _cache = {};

  // A derived list kept until one of its inputs changes: a pick or a
  // selection elsewhere re-renders the panel, and the template reads most
  // of these more than once.
  memo(name, inputs, build) {
    const entry = this._cache[name];
    if (entry && entry.inputs.every((input, i) => input === inputs[i])) {
      return entry.value;
    }
    const value = build();
    this._cache[name] = { inputs, value };
    return value;
  }

  get hasEntry() {
    return Boolean(this.entry);
  }

  get node() {
    return this.entry.after || this.entry.before;
  }

  get isNode() {
    return this.kind !== "resource";
  }

  get info() {
    return this.isNode ? elementInfo(this.node) : resourceInfo(this.node);
  }

  get icon() {
    return this.info.icon;
  }

  get typeLabel() {
    if (this.isNode && this.entry.key === START) {
      return "Start";
    }
    return this.info.label;
  }

  get title() {
    if (this.isNode && this.entry.key === START) {
      return "Start";
    }
    return visibleText(
      (this.node.fields && this.node.fields.label) ||
        this.node.label ||
        this.entry.key
    );
  }

  get apiName() {
    return this.entry.key === START ? "" : this.entry.key;
  }

  // In a merge, an open conflict outranks how the result compares. An
  // element whose settings match but whose connectors changed reads as
  // reconnected, not unchanged.
  get status() {
    if (this.openConflicts.length) {
      return "conflict";
    }
    if (this.settledConflicts.length) {
      return "resolved";
    }
    return this.reconnected ? "retargeted" : this.entry.status;
  }

  get reconnected() {
    return (
      this.isDiff &&
      this.isNode &&
      this.entry.status === UNCHANGED &&
      this.connectors.some((connector) => connector.showStatus)
    );
  }

  get statusLabel() {
    return STATUS_LABELS[this.status] || this.status;
  }

  get statusClass() {
    const status = this.status === "retargeted" ? CHANGED : this.status;
    return `status status-${status}`;
  }

  label(side) {
    return visibleText((this.labels && this.labels[side]) || side);
  }

  get beforeLabel() {
    return this.label("before");
  }

  get afterLabel() {
    return this.label("after");
  }

  get isMerge() {
    return Boolean(this.merge && this.resolved);
  }

  get isDiff() {
    return !this.isMerge;
  }

  get summary() {
    const { status } = this.entry;
    if (this.isMerge) {
      const open = this.openConflicts;
      if (open.length) {
        const preview = this.label(this.resolved.choices[open[0].id]);
        return `${plural(open.length, "conflict")} to resolve: the versions changed this in different ways. Until you pick, the result uses ${preview}.`;
      }
      const settled = this.settledConflicts;
      if (settled.length) {
        const sides = [
          ...new Set(settled.map((unit) => this.resolved.choices[unit.id]))
        ];
        return sides.length === 1
          ? `Resolved: the result uses ${this.label(sides[0])} here.`
          : `Resolved: you picked a version for each of ${settled.length} conflicts here.`;
      }
      if (status === UNCHANGED) {
        return this.hasUnits
          ? `The result matches ${this.beforeLabel} here.`
          : undefined;
      }
      if (status === ADDED) {
        return `The result adds this; ${this.beforeLabel} doesn't have it.`;
      }
      if (status === REMOVED) {
        return `The result leaves this out; ${this.beforeLabel} has it.`;
      }
    }
    if (status === ADDED) {
      return `Only in ${this.afterLabel}.`;
    }
    if (status === REMOVED) {
      return `Only in ${this.beforeLabel}.`;
    }
    if (status === "excluded") {
      return `Only in ${this.label(this.entry.availableFrom)}; the merged flow leaves it out.`;
    }
    if (this.reconnected) {
      return "Only its connectors changed.";
    }
    if (status === UNCHANGED) {
      return this.entry.moved
        ? "Moved on the canvas; nothing else changed."
        : "No changes.";
    }
    return undefined;
  }

  get changes() {
    const { entry } = this;
    return this.memo("changes", [entry], () =>
      this.changeRows(plainChanges(entry.changes || [], entry))
    );
  }

  changeRows(groups) {
    return groups.map(({ change, key }, index) => {
      const hasBefore = change.status !== ADDED;
      const hasAfter = change.status !== REMOVED;
      const before = display(change.before, key);
      const after = display(change.after, key);
      const [beforeLines, afterLines] = markLines([
        hasBefore ? before.text : undefined,
        hasAfter ? after.text : undefined
      ]);
      return {
        id: `${index}`,
        path: humanPath(change.path) || "Whole value",
        rawPath: formatPath(change.path),
        statusLabel: STATUS_LABELS[change.status] || change.status,
        rowClass: `change change-${change.status}`,
        hasBefore,
        hasAfter,
        before: { ...before, lines: beforeLines },
        after: { ...after, lines: afterLines }
      };
    });
  }

  // Every change makes a row, so there are rows when there are changes.
  get hasChanges() {
    return Boolean(this.entry.changes && this.entry.changes.length);
  }

  get fields() {
    return (this.node && this.node.fields) || {};
  }

  get properties() {
    const { fields } = this;
    return this.memo("properties", [fields], () =>
      Object.keys(fields)
        .filter((key) => fields[key] !== undefined && key !== "name")
        .sort()
        .map((key) => ({
          key,
          label: humanize(key),
          ...display(fields[key], key)
        }))
    );
  }

  get hasProperties() {
    const { fields } = this;
    return Object.keys(fields).some(
      (key) => fields[key] !== undefined && key !== "name"
    );
  }

  handlePropertiesToggle(event) {
    this.propertiesOpen = event.target.open;
  }

  // An element's label, from the side the connector is on first: a name can
  // mean different elements before and after.
  nodeLabel(key, side = "after") {
    if (key === START) {
      return "Start";
    }
    const diff = this.diff;
    const models = !diff
      ? []
      : side === "before"
        ? [diff.before, diff.after]
        : [diff.after, diff.before];
    for (const model of models) {
      const node = model && model.nodes.get(key);
      if (node) {
        return visibleText(node.label || key);
      }
    }
    return key;
  }

  get connectors() {
    if (!this.isNode || !this.diff) {
      return [];
    }
    const { diff, entry } = this;
    return this.memo("connectors", [diff, entry, this.isDiff], () =>
      this.connectorRows(diff, entry)
    );
  }

  connectorRows(diff, { key, type, status }) {
    // A same-named element of another type has connectors of its own.
    return diff.edges
      .filter(
        (edge) =>
          edge.source === key &&
          (!type || !edge.sourceType || edge.sourceType === type)
      )
      .map((edge) => {
        const current = edge.after || edge.before;
        const retargeted = edge.status === "retargeted";
        return {
          id: edge.id,
          label: visibleText(connectorLabel(current) || "Next"),
          target: this.nodeLabel(
            current.target,
            edge.after ? "after" : "before"
          ),
          oldTarget: retargeted
            ? this.nodeLabel(edge.before.target, "before")
            : undefined,
          statusLabel: STATUS_LABELS[edge.status] || edge.status,
          rowClass: `connector connector-${edge.status}`,
          showStatus: edge.status !== UNCHANGED,
          showBadge:
            edge.status !== UNCHANGED &&
            !(this.isDiff && status === UNCHANGED && retargeted)
        };
      });
  }

  get hasConnectors() {
    return this.connectors.length > 0;
  }

  // An element in the merged flow can have its connectors sent elsewhere.
  get canRewire() {
    return (
      this.isMerge &&
      this.isNode &&
      Boolean(this.resolved) &&
      this.resolved.model.nodes.has(this.entry.key)
    );
  }

  // Merge

  get units() {
    if (!this.isMerge) {
      return [];
    }
    const { merge, entry, isNode } = this;
    return this.memo("units", [merge, entry.key, isNode], () => {
      if (!isNode) {
        const unit = merge.units.get(`resource|${entry.key}`);
        return unit && unit.status !== SAME ? [unit] : [];
      }
      return unitsForNode(merge, entry.key).filter(
        (unit) => unit.status !== SAME
      );
    });
  }

  // The conflicts here no side has been picked for yet.
  get openIds() {
    const { units, resolved } = this;
    return this.memo("openIds", [units, resolved], () => {
      const open = new Set(resolved.conflicts);
      return new Set(
        units
          .filter((unit) => unit.status === CONFLICT && open.has(unit.id))
          .map((unit) => unit.id)
      );
    });
  }

  get openConflicts() {
    if (!this.isMerge) {
      return [];
    }
    const open = this.openIds;
    return this.units.filter((unit) => open.has(unit.id));
  }

  // Conflicts here that have been picked.
  get settledConflicts() {
    if (!this.isMerge) {
      return [];
    }
    const open = this.openIds;
    return this.units.filter(
      (unit) => unit.status === CONFLICT && !open.has(unit.id)
    );
  }

  // Long values that only differ in a few lines show just those lines
  // until the row is opened out.
  expanded = {};

  // An open conflict has no side checked, so clicking the one the result
  // previews still counts as picking it. Each radio is named by its side,
  // with the lines that differ as its description.
  get unitRows() {
    const { merge, resolved, units, openIds, labels, expanded } = this;
    return this.memo(
      "unitRows",
      [merge, resolved, units, openIds, labels, expanded],
      () => this.buildUnitRows(merge, resolved, units, openIds)
    );
  }

  buildUnitRows(merge, resolved, units, openIds) {
    return units.map((unit, row) => {
      const chosen = resolved.choices[unit.id];
      const conflict = openIds.has(unit.id);
      const texts = merge.names.map((name) =>
        unit.values[name] === undefined
          ? undefined
          : display(
              wholeNodeValue(merge, unit, name),
              unit.path && unit.path[0]
            ).text
      );
      const lines = markLines(texts);
      const long = lines.some((list) => list.length > COMPACT_LINES);
      const compactable =
        long &&
        lines.every(
          (list, index) =>
            texts[index] === undefined || list.some((line) => line.differs)
        );
      const open = Boolean(this.expanded[unit.id]);
      const compact = compactable && !open;
      // A whole element, resource or connector that only some versions
      // have: the choice is to keep it or leave it out. The versions that
      // have it alike needn't repeat it; the details above show it.
      const present = texts.filter((text) => text !== undefined);
      const keepOrLeave =
        unit.kind !== "field" &&
        unit.kind !== "prop" &&
        present.length > 0 &&
        present.length < texts.length;
      const alike = present.every((text) => text === present[0]);
      return {
        id: unit.id,
        label: unitTitle(unit),
        rawLabel: unit.label,
        rowClass: conflict ? "unit unit-conflict" : "unit",
        conflict,
        resolvedConflict: unit.status === CONFLICT && !conflict,
        compactable,
        expandLabel: open ? "Show only what differs" : "Show whole values",
        expandedText: open ? "true" : "false",
        cells: merge.names.map((name, index) => {
          const absent = texts[index] === undefined;
          const label = this.label(name);
          let shown = lines[index];
          if (absent) {
            shown = [
              {
                key: "0",
                text: keepOrLeave ? `Not in ${label}` : "Not present",
                className: "vline"
              }
            ];
          } else if (keepOrLeave && alike) {
            shown = [];
          } else if (compact) {
            shown = lines[index]
              .filter((line) => line.differs)
              .map((line) => ({ ...line, text: line.text.trim() }));
          }
          const action = keepOrLeave
            ? absent
              ? "Leave it out"
              : "Keep it"
            : undefined;
          const picked = !conflict && chosen === name;
          return {
            key: name,
            side: name,
            label,
            action,
            ariaLabel: action ? `${label}: ${action.toLowerCase()}` : label,
            lines: shown,
            summary: absent
              ? shown[0].text
              : shown.length
                ? spoken(lines[index])
                : `Keeps it as ${label} has it`,
            summaryId: `unit-${row}-${index}`,
            checked: picked,
            preview: conflict && chosen === name,
            cellClass: `cell${picked ? " chosen" : ""}${absent ? " absent" : ""}${compact ? " compact" : ""}`,
            radioName: unit.id
          };
        })
      };
    });
  }

  handleExpand(event) {
    const { unit } = event.currentTarget.dataset;
    this.expanded = { ...this.expanded, [unit]: !this.expanded[unit] };
  }

  /**
   * Moves focus to the first choice, of an open conflict if there is one,
   * or to the panel's title. Focusing scrolls it into view.
   */
  @api
  focusChoice() {
    const radio =
      this.template.querySelector(".unit-conflict input") ||
      this.template.querySelector(".unit input");
    const target = radio || this.template.querySelector(".title");
    if (target) {
      target.focus();
    }
  }

  // One row per unit.
  get hasUnits() {
    return this.units.length > 0;
  }

  get sideButtons() {
    if (!this.isMerge || !this.isNode) {
      return [];
    }
    return this.merge.names.map((name) => {
      const present = this.merge.sides[name].nodes.has(this.entry.key);
      return {
        key: name,
        side: name,
        label: present
          ? this.label(name)
          : `${this.label(name)} (leaves it out)`,
        title: present
          ? `Use every part of this element from ${this.label(name)}`
          : `Leave this element out, as ${this.label(name)} does`
      };
    });
  }

  get hasSideButtons() {
    return this.sideButtons.length > 0;
  }

  get issues() {
    if (!this.isMerge) {
      return [];
    }
    const { resolved, entry, isNode } = this;
    return this.memo("issues", [resolved, entry.key, isNode], () =>
      resolved.issues
        // An issue shows on the panel of what it's about, and of each
        // element or resource that has it.
        .filter(
          (issue) =>
            (isNode
              ? issue.nodeKey === entry.key
              : issue.resourceKey === entry.key || issue.name === entry.key) ||
            (issue.owners || []).includes(entry.key)
        )
        .map((issue, index) => ({
          id: `${index}`,
          message: issue.message,
          icon: issue.severity === ERROR ? "utility:error" : "utility:warning",
          variant: issue.severity === ERROR ? "error" : "warning"
        }))
    );
  }

  get hasIssues() {
    return this.issues.length > 0;
  }

  get showText() {
    return !this.hideText;
  }

  handleRadio(event) {
    const { unit, side } = event.target.dataset;
    this.dispatchEvent(
      new CustomEvent("pick", { detail: { picks: { [unit]: side } } })
    );
  }

  handleTakeAll(event) {
    const { side } = event.target.dataset;
    const picks = this.isNode
      ? picksForNode(this.merge, this.entry.key, side)
      : { [`resource|${this.entry.key}`]: side };
    this.dispatchEvent(new CustomEvent("pick", { detail: { picks } }));
  }

  handleConnect(event) {
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("pick", { detail: { picks: event.detail.picks } })
    );
  }

  handleNext() {
    this.dispatchEvent(new CustomEvent("next"));
  }

  handleShowText() {
    this.dispatchEvent(
      new CustomEvent("showtext", { detail: { id: this.entry.id } })
    );
  }

  handleClose() {
    this.dispatchEvent(new CustomEvent("close"));
  }
}
