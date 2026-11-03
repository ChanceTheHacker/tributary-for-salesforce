/**
 * Maps a different flow onto this one before merging them. Each name the
 * other flow's elements use (its triggering record, variables, Get Records
 * results) is mapped onto one of this flow's, with the closest suggested,
 * or brought in as a new variable; elements both flows name the same are
 * one element or both. Then the other flow's elements can be put on a path.
 * Each mapping shows why it was offered and what's wrong with it; one
 * offered only for its name waits for someone to keep it.
 *
 * Events: change { choices }, place { afterKey, slot }.
 */
import { LightningElement, api } from "lwc";
import { validName } from "c/flowMapping";
import { ERROR } from "c/flowMerge";
import { plural } from "c/flowUtils";

const CREATE = "create";
const TO = "to:";

const KIND_TEXT = {
  record: "The record that starts it",
  prior: "The record before the change",
  resource: "Resource",
  lookup: "Get Records result"
};

export default class FlowMappingPanel extends LightningElement {
  /** planMapping's result. */
  @api plan;
  /** The current choices, as translateFlow takes them. */
  @api choices;
  /** translateFlow's notes for the current choices. */
  @api notes;
  /** The merge's result, for putting the other flow's elements on a path. */
  @api resolved;
  /** The merge and picks so far, to show what putting it on a path does. */
  @api merge;
  @api picks;
  /** translateFlow's issues for the current choices. */
  @api issues;
  message = "";
  _focusKey;

  renderedCallback() {
    if (this._focusKey) {
      const key = this._focusKey;
      this._focusKey = undefined;
      this.focusRow(key);
    }
  }

  /** Scrolls to a mapping and focuses its choice. */
  @api
  focusRow(key) {
    const row = [...this.template.querySelectorAll(".root")].find(
      (item) => item.dataset.key === key
    );
    if (!row) {
      return;
    }
    if (row.scrollIntoView) {
      row.scrollIntoView({ block: "nearest" });
    }
    const pick = row.querySelector(".root-pick");
    if (pick) {
      pick.focus();
    }
  }

  get targetLabel() {
    return this.plan.target.label;
  }

  get sourceLabel() {
    return this.plan.source.label;
  }

  get intro() {
    return `${this.sourceLabel} is a different flow. Its elements are brought in beside ${this.targetLabel}'s, using ${this.targetLabel}'s variables and records where you map them, so they work in their new flow.`;
  }

  rootChoice(row) {
    const choice = ((this.choices && this.choices.roots) || {})[row.key];
    return choice || row.defaultChoice;
  }

  get rootRows() {
    const issues = this.issues || [];
    return this.plan.roots.map((row) => {
      const choice = this.rootChoice(row);
      const creating = choice.create !== undefined;
      const current =
        !creating &&
        row.options.find(
          (item) => item.to.toLowerCase() === String(choice.to).toLowerCase()
        );
      const options = row.options.map((option) => ({
        label: `${option.label}: ${option.typeLabel}${
          option.to === row.suggestion ? " (suggested)" : ""
        }`,
        value: `${TO}${option.to}`
      }));
      const createLabel =
        row.kind === "record" || row.kind === "prior"
          ? `A new ${row.typeLabel} variable`
          : `Bring it in as its own ${row.kind === "lookup" ? "element" : "resource"}`;
      options.push({ label: createLabel, value: CREATE });
      // A mapping to something no longer offered still shows.
      const value = creating ? CREATE : `${TO}${choice.to}`;
      if (!options.some((option) => option.value === value)) {
        options.unshift({ label: choice.to, value });
      }
      const name = creating ? choice.create : "";
      const nameValid = !creating || validName(name || row.createName);
      const uses = row.uses.length;
      const problems = issues
        .filter(
          (issue) =>
            issue.mappingKey === row.key &&
            (nameValid || issue.code !== "mappingName")
        )
        .map((issue, index) => ({
          key: `${index}`,
          text: issue.message,
          className: issue.severity === ERROR ? "root-error" : "root-warning"
        }));
      return {
        key: row.key,
        className: problems.some((item) => item.className === "root-error")
          ? "root root-bad"
          : "root",
        name: row.name,
        kind: KIND_TEXT[row.kind] || row.kind,
        typeLabel: row.typeLabel,
        usedBy: uses
          ? `Used by ${row.uses.slice(0, 3).join(", ")}${
              uses > 3 ? ` and ${uses - 3} more` : ""
            }`
          : "Not used by its elements",
        written: row.written,
        options,
        value,
        creating,
        createName: name || row.createName,
        nameError: nameValid
          ? undefined
          : "Use letters, numbers and single underscores, starting with a letter.",
        pickLabel: `Map ${row.name} to`,
        noMatch: !row.options.length,
        why: current ? `Why: ${current.basis}` : undefined,
        // Offered for its name alone: nothing says it holds the same.
        confirm: Boolean(current && current.byName && choice.suggested),
        confirmLabel: `Keep ${row.name} mapped to ${choice.to}`,
        problems
      };
    });
  }

  get hasRoots() {
    return this.plan.roots.length > 0;
  }

  get elementOptions() {
    return [
      { label: "One element", value: "one" },
      { label: "Keep both", value: "both" }
    ];
  }

  get elementRows() {
    const elements = (this.choices && this.choices.elements) || {};
    return this.plan.elements.map((row) => ({
      key: row.key,
      name: row.label,
      apiName: row.name,
      value:
        (elements[row.key] || row.defaultChoice) === "both" ? "both" : "one",
      detail: row.same
        ? "Does the same in both once mapped"
        : "Does something different in each: keeping one loses the other's",
      pickLabel: `${row.label} in both flows`
    }));
  }

  get hasElements() {
    return this.plan.elements.length > 0;
  }

  get noteLines() {
    const notes = this.notes;
    if (!notes) {
      return [];
    }
    const lines = [];
    const list = (items, text) =>
      items.length
        ? lines.push({ key: text, text: `${text}: ${items.join(", ")}` })
        : 0;
    list(
      notes.mapped.map((item) => `${item.from} → ${item.to}`),
      "Mapped"
    );
    list(
      notes.created.map((item) => `${item.name} (for ${item.from})`),
      "New variables"
    );
    list(
      notes.renamed.map((item) => `${item.from} → ${item.to}`),
      "Renamed to avoid a clash"
    );
    list(
      notes.dropped.map((item) => item.name),
      "Not brought in, as this flow has them"
    );
    lines.push({
      key: "added",
      text: `${plural(notes.added.length, "element")} to bring in`
    });
    return lines;
  }

  get startNote() {
    const start = this.notes && this.notes.sourceStart;
    if (!start) {
      return undefined;
    }
    const what = [start.object, start.recordTriggerType, start.triggerType]
      .filter(Boolean)
      .join(", ");
    return `${this.sourceLabel}'s start (${what}) isn't brought in: its elements run from ${this.targetLabel}'s start, wherever you put them.`;
  }

  get canPlace() {
    return Boolean(this.notes && this.notes.added.length && this.resolved);
  }

  get placeModel() {
    return this.resolved.model;
  }

  get placeExclude() {
    return this.notes.added;
  }

  get placeLabel() {
    return `Put ${this.sourceLabel} after`;
  }

  get placeHint() {
    const entry = this.notes.entry;
    return `Takes all ${plural(this.notes.added.length, "element")} and puts them between the element and what it leads to now${
      entry ? `, starting at ${entry}` : ""
    }. Before it goes in, it shows where each path will go, and asks where that's not clear.`;
  }

  change(roots, elements) {
    this.message = "";
    const choices = {
      roots: { ...((this.choices && this.choices.roots) || {}), ...roots },
      elements: {
        ...((this.choices && this.choices.elements) || {}),
        ...elements
      }
    };
    this.dispatchEvent(
      new CustomEvent("mappingchange", { detail: { choices } })
    );
  }

  handleRoot(event) {
    const { key } = event.target.dataset;
    const { value } = event.detail;
    const row = this.plan.roots.find((item) => item.key === key);
    this.change(
      {
        [key]:
          value === CREATE
            ? { create: row.createName }
            : { to: value.slice(TO.length) }
      },
      {}
    );
  }

  handleKeep(event) {
    const { key } = event.target.dataset;
    const row = this.plan.roots.find((item) => item.key === key);
    const to = this.rootChoice(row).to;
    this._focusKey = key;
    this.change({ [key]: { to } }, {});
    this.message = `Kept ${row.name} mapped to ${to}.`;
  }

  handleName(event) {
    const { key } = event.target.dataset;
    this.change({ [key]: { create: event.target.value } }, {});
  }

  handleElement(event) {
    const { key } = event.target.dataset;
    this.change({}, { [key]: event.detail.value });
  }

  handleReset() {
    this.message = "";
    this.dispatchEvent(
      new CustomEvent("mappingchange", { detail: { choices: undefined } })
    );
  }

  handlePlace(event) {
    this.dispatchEvent(new CustomEvent("place", { detail: event.detail }));
  }
}
