/**
 * A diff's resources (variables, formulas, …) and flow properties. Picking a
 * resource sends select { kind: "resource", id }; in a merge the flow
 * properties that differ can be picked here too (pick { picks }).
 * selectedProp marks one flow property change and scrolls it into view.
 */
import { LightningElement, api } from "lwc";
import { resourceInfo, formatValue } from "c/flowElements";
import { formatPath, UNCHANGED } from "c/flowDiff";
import { changedUnits, CONFLICT, editableText } from "c/flowMerge";
import { humanize, humanPath, visibleText } from "c/flowUtils";

const STATUS_LABELS = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  unchanged: "",
  reordered: "Reordered"
};

export default class FlowResourcesPanel extends LightningElement {
  @api diff;
  @api labels = {};
  @api selectedId;
  @api merge;
  @api resolved;

  onlyChanges = true;
  textDrafts = {};
  _selectedProp;
  _scrollToProp = false;
  // Derived data, filled while rendering; not reactive.
  _cache = {};

  @api
  get selectedProp() {
    return this._selectedProp;
  }
  set selectedProp(value) {
    this._selectedProp = value;
    this._scrollToProp = value !== undefined;
  }

  renderedCallback() {
    if (this._scrollToProp) {
      this._scrollToProp = false;
      const row = this.template.querySelector(
        ".props .selected, .unit.selected"
      );
      if (row && row.scrollIntoView) {
        row.scrollIntoView({ block: "nearest" });
      }
    }
  }

  // A derived list kept until one of its inputs changes: selecting or
  // picking re-renders the panel, and the template reads each list twice.
  memo(name, inputs, build) {
    const entry = this._cache[name];
    if (entry && entry.inputs.every((input, i) => input === inputs[i])) {
      return entry.value;
    }
    const value = build();
    this._cache[name] = { inputs, value };
    return value;
  }

  label(side) {
    return visibleText((this.labels && this.labels[side]) || side);
  }

  get hasDiff() {
    return Boolean(this.diff);
  }

  get changeCount() {
    const { resources } = this.diff;
    return this.memo(
      "changeCount",
      [resources],
      () => resources.filter((entry) => entry.status !== UNCHANGED).length
    );
  }

  get toggleLabel() {
    return `Only changes (${this.changeCount})`;
  }

  // The listed resources in order, without the selection.
  get resourceList() {
    const { onlyChanges } = this;
    const { resources } = this.diff;
    return this.memo("resourceList", [resources, onlyChanges], () =>
      resources
        .filter((entry) => !onlyChanges || entry.status !== UNCHANGED)
        .map((entry) => {
          const info = resourceInfo(entry.after || entry.before);
          return {
            id: entry.id,
            name: visibleText(entry.key),
            icon: info.icon,
            typeLabel: info.label,
            statusLabel: STATUS_LABELS[entry.status],
            baseClass: `resource status-${entry.status}`
          };
        })
        .sort(
          (a, b) =>
            a.typeLabel.localeCompare(b.typeLabel) ||
            a.name.localeCompare(b.name)
        )
    );
  }

  get resources() {
    const { resourceList, selectedId } = this;
    return this.memo("resources", [resourceList, selectedId], () =>
      resourceList.map((row) => ({
        ...row,
        rowClass:
          row.id === selectedId ? `${row.baseClass} selected` : row.baseClass
      }))
    );
  }

  get hasResources() {
    return this.onlyChanges
      ? this.changeCount > 0
      : this.diff.resources.length > 0;
  }

  get noResourcesText() {
    return this.onlyChanges ? "No resources changed." : "No resources.";
  }

  get isMerge() {
    return Boolean(this.merge && this.resolved);
  }

  get propChanges() {
    if (this.isMerge) {
      return [];
    }
    const { props } = this.diff;
    const selected = this._selectedProp;
    return this.memo("propChanges", [props, selected], () =>
      props.map((change, index) => ({
        id: `${index}`,
        rowClass: `${index}` === selected ? "selected" : "",
        path: humanPath(change.path),
        rawPath: visibleText(formatPath(change.path)),
        before: visibleText(formatValue(change.before)),
        after: visibleText(formatValue(change.after))
      }))
    );
  }

  get hasPropChanges() {
    return !this.isMerge && this.diff.props.length > 0;
  }

  get propUnits() {
    if (!this.isMerge) {
      return [];
    }
    const { merge, resolved, labels } = this;
    return this.memo(
      "propUnits",
      [merge, resolved, labels, this.textDrafts, this._selectedProp],
      () => this.propRows(merge, resolved)
    );
  }

  propRows(merge, resolved) {
    const open = new Set(resolved.conflicts);
    return changedUnits(merge)
      .filter((unit) => unit.kind === "prop")
      .map((unit) => {
        const chosen = resolved.choices[unit.id];
        const conflict = unit.status === CONFLICT && open.has(unit.id);
        // An open conflict has no side picked yet.
        const picked = (name) => !conflict && chosen === name;
        return {
          id: unit.id,
          label: humanize(unit.label),
          rawLabel: unit.label,
          conflict,
          editable: editableText(unit),
          editLabel: `Edit ${humanize(unit.label).toLowerCase()}`,
          editValue:
            this.textDrafts[unit.id] ??
            resolved.model.props[unit.path[0]] ??
            "",
          custom: chosen === "custom",
          customText: visibleText(resolved.model.props[unit.path[0]]),
          resolvedConflict: unit.status === CONFLICT && !conflict,
          rowClass: `unit${conflict ? " unit-conflict" : ""}${unit.id === this._selectedProp ? " selected" : ""}`,
          cells: merge.names.map((name) => ({
            key: name,
            side: name,
            label: this.label(name),
            text:
              unit.values[name] === undefined
                ? "Not set"
                : visibleText(formatValue(unit.values[name])),
            checked: picked(name),
            cellClass: picked(name) ? "cell chosen" : "cell"
          }))
        };
      });
  }

  get hasPropUnits() {
    return this.propUnits.length > 0;
  }

  get noProps() {
    return !this.hasPropChanges && !this.hasPropUnits;
  }

  handleToggle(event) {
    this.onlyChanges = event.target.checked;
  }

  handleSelect(event) {
    this.dispatchEvent(
      new CustomEvent("select", {
        detail: { kind: "resource", id: event.currentTarget.dataset.id }
      })
    );
  }

  handleTextChange(event) {
    this.textDrafts = {
      ...this.textDrafts,
      [event.target.dataset.unit]: event.target.value
    };
  }

  handleTextApply(event) {
    const id = event.currentTarget.dataset.unit;
    const unit = this.merge.units.get(id);
    if (!editableText(unit)) return;
    const text =
      this.textDrafts[id] ?? this.resolved.model.props[unit.path[0]] ?? "";
    this.applyText(id, text);
  }

  handleTextCombine(event) {
    const id = event.currentTarget.dataset.unit;
    const unit = this.merge.units.get(id);
    if (!editableText(unit)) return;
    const values = this.merge.names
      .filter((name) => name !== "base")
      .map((name) => unit.values[name])
      .filter((value) => typeof value === "string" && value.length);
    this.applyText(
      id,
      [...new Set(values)].join(unit.path[0] === "description" ? "\n" : " / ")
    );
  }

  applyText(id, text) {
    const drafts = { ...this.textDrafts };
    delete drafts[id];
    this.textDrafts = drafts;
    this.dispatchEvent(
      new CustomEvent("pick", { detail: { picks: { [id]: { text } } } })
    );
  }

  handleRadio(event) {
    const { unit, side } = event.target.dataset;
    const drafts = { ...this.textDrafts };
    delete drafts[unit];
    this.textDrafts = drafts;
    this.dispatchEvent(
      new CustomEvent("pick", { detail: { picks: { [unit]: side } } })
    );
  }
}
