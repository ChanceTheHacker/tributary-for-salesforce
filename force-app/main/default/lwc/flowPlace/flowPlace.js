/**
 * Picks a place on the merged flow's paths: an element, then one of its
 * connectors ("Next", an outcome, the fault path). Given the merge, the
 * elements being placed and their side, it shows what placing them there
 * would do (see placePlan) and asks where each path goes when that's
 * someone's call. Fires place { afterKey, slot, routes, first } when the
 * button is pressed.
 */
import { LightningElement, api } from "lwc";
import { connectorSlots, mainSlot, placePlan } from "c/flowMerge";
import { slotLabel } from "c/flowElements";
import { START } from "c/flowModel";

const END = "-";
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export default class FlowPlace extends LightningElement {
  /** The flow the place is on: the merge's result. */
  @api model;
  /** Keys of elements that can't be the place, e.g. those being placed. */
  @api exclude = [];
  @api label = "After";
  @api buttonLabel = "Put them here";
  @api hint;
  /** For the preview: the merge, its result, the picks so far... */
  @api merge;
  @api resolved;
  @api picks;
  /** ...the elements being placed, the side they come from... */
  @api keys;
  @api side;
  /** ...and the element their path goes into, unless someone says. */
  @api first;

  afterKey;
  slot;
  // Where each path someone decides goes: { wireId: target or "" }.
  routes = {};
  entryChoice;
  _plan = {};

  get excluded() {
    return new Set(this.exclude || []);
  }

  get nodes() {
    if (!this.model) {
      return [];
    }
    const excluded = this.excluded;
    return [...this.model.nodes.values()]
      .filter(
        (node) => !excluded.has(node.key) && connectorSlots(node).length > 0
      )
      .sort(
        (a, b) =>
          (a.key === START ? -1 : 0) - (b.key === START ? -1 : 0) ||
          (a.y || 0) - (b.y || 0) ||
          (a.x || 0) - (b.x || 0)
      );
  }

  get elementOptions() {
    return this.nodes.map((node) => ({
      label:
        node.key === START
          ? "Start"
          : `${node.label || node.key} (${node.key})`,
      value: node.key
    }));
  }

  get node() {
    return this.afterKey && this.model
      ? this.model.nodes.get(this.afterKey)
      : undefined;
  }

  // Each connector of the element, with where it leads now.
  get slotOptions() {
    const node = this.node;
    if (!node) {
      return [];
    }
    return connectorSlots(node).map((slot) => {
      const edge = this.model.edges.get(`${node.key}.${slot}`);
      const target = edge && this.model.nodes.get(edge.target);
      const now = edge
        ? `, now to ${target ? target.label || target.key : edge.target}`
        : ", not connected";
      return { label: `${slotLabel(node, slot)}${now}`, value: slot };
    });
  }

  get noSlots() {
    return !this.node;
  }

  get placeDisabled() {
    const plan = this.plan;
    return !this.node || !this.slot || Boolean(plan && plan.open);
  }

  // Preview

  get plan() {
    if (!this.merge || !this.resolved || !this.side || !this.node) {
      return undefined;
    }
    const keys = this.keys || [];
    if (!keys.length || !this.slot) {
      return undefined;
    }
    const first = this.entryChoice || this.first;
    const cache = this._plan;
    const input = [
      this.merge,
      this.resolved,
      this.picks,
      this.keys,
      this.side,
      this.afterKey,
      this.slot,
      first,
      this.routes
    ];
    if (
      !cache.input ||
      cache.input.some((value, index) => value !== input[index])
    ) {
      cache.input = input;
      cache.plan = placePlan(
        this.merge,
        this.resolved,
        keys,
        this.side,
        this.afterKey,
        this.slot,
        { first, routes: this.routes, current: this.picks || {} }
      );
    }
    return cache.plan;
  }

  get hasPlan() {
    return Boolean(this.plan);
  }

  nodeOf(key) {
    return (
      (this.merge.sides[this.side] &&
        this.merge.sides[this.side].nodes.get(key)) ||
      this.resolved.model.nodes.get(key)
    );
  }

  nameOf(key) {
    if (key === START) {
      return "Start";
    }
    const node = this.nodeOf(key);
    return (node && node.label) || key;
  }

  get entryText() {
    const plan = this.plan;
    const then = plan.next
      ? `then on to ${this.nameOf(plan.next)}`
      : "then the path ends";
    return `Goes into ${this.nameOf(plan.entry)}, ${then}.`;
  }

  get chooseEntry() {
    return this.plan.entries.length > 1;
  }

  get entryOptions() {
    return this.plan.entries.map((key) => ({
      label: this.nameOf(key),
      value: key
    }));
  }

  get entryValue() {
    const plan = this.plan;
    return plan.entries.includes(this.entryChoice || this.first)
      ? plan.entry
      : undefined;
  }

  // Each path out of the elements, and where it will go.
  get exitRows() {
    return this.plan.exits.map((exit) => {
      const from = this.nodeOf(exit.from);
      const path = `${this.nameOf(exit.from)}: ${slotLabel(from, exit.slot)}`;
      const where = (value) => (value ? this.nameOf(value) : "");
      let text;
      if (exit.keep) {
        text = `still goes to ${where(exit.value)}`;
      } else if (exit.value) {
        text = `goes on to ${where(exit.value)}`;
      } else if (exit.kind === "fault") {
        text = "left unhandled";
      } else {
        text = "ends";
      }
      if (exit.target && !exit.keep) {
        text += ` (went to ${where(exit.target)})`;
      }
      return {
        id: exit.id,
        path,
        text,
        choice: exit.choice,
        className: exit.choice && !exit.decided ? "exit exit-open" : "exit",
        value: exit.decided && exit.choice ? exit.value : undefined,
        options: exit.options.map((option) => ({
          label: option.value
            ? `${option.label}: ${where(option.value)}`
            : option.label,
          // A combobox can't hold "": "End" is kept as a marker.
          value: option.value || END
        }))
      };
    });
  }

  get notes() {
    const plan = this.plan;
    const notes = [];
    if (plan.dependencies.length) {
      notes.push({
        key: "brings",
        className: "note",
        text: `Brings in ${plural(plan.dependencies.length, "resource")} they use: ${plan.dependencies.join(", ")}.`
      });
    }
    if (plan.incoming.length) {
      notes.push({
        key: "incoming",
        className: "note",
        text: `Not brought: ${plan.incoming
          .map(
            (edge) =>
              `${this.nameOf(edge.source)} → ${this.nameOf(edge.target)}`
          )
          .join(", ")}.`
      });
    }
    if (plan.detached.length) {
      notes.push({
        key: "detached",
        className: "note note-warning",
        text: `The start won't reach ${plan.detached
          .map((key) => this.nameOf(key))
          .join(", ")}.`
      });
    }
    if (plan.stranded.length) {
      notes.push({
        key: "stranded",
        className: "note note-warning",
        text: `Nothing will lead to ${plan.stranded
          .map((key) => this.nameOf(key))
          .join(", ")} any more.`
      });
    }
    for (const [index, keys] of plan.cycles.entries()) {
      notes.push({
        key: `cycle-${index}`,
        className: "note note-warning",
        text: `${[...keys, keys[0]]
          .map((key) => this.nameOf(key))
          .join(" → ")} goes round without a Loop.`
      });
    }
    return notes;
  }

  get openText() {
    const open = this.plan.open;
    return open
      ? `Choose where ${open === 1 ? "the marked path goes" : `the ${open} marked paths go`} first.`
      : "";
  }

  handleEntry(event) {
    this.entryChoice = event.detail.value;
  }

  handleRoute(event) {
    const { id } = event.target.dataset;
    const { value } = event.detail;
    this.routes = { ...this.routes, [id]: value === END ? "" : value };
  }

  // The path taken when nothing branches: putting elements after one
  // most often means between it and what came next.
  handleElement(event) {
    this.afterKey = event.detail.value;
    const node = this.node;
    this.slot = node ? mainSlot(node) || connectorSlots(node)[0] : undefined;
    this.routes = {};
  }

  handleSlot(event) {
    this.slot = event.detail.value;
    this.routes = {};
  }

  handlePlace() {
    const detail = { afterKey: this.afterKey, slot: this.slot };
    if (this.plan) {
      detail.routes = { ...this.routes };
      detail.first = this.plan.entry;
    }
    this.dispatchEvent(new CustomEvent("place", { detail }));
    this.routes = {};
  }
}
