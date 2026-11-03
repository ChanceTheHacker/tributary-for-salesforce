/**
 * Where each connector of an element in the merged flow goes, and a way to
 * send it elsewhere: to any element in the result, or nowhere. Changes fire
 * pick { picks } with wire picks, as the merge takes them; "Undo" takes the
 * wire back out so the connector is as the picked version has it.
 */
import { LightningElement, api } from "lwc";
import { connectorSlots, wireId } from "c/flowMerge";
import { slotLabel } from "c/flowElements";
import { START } from "c/flowModel";

const NOWHERE = "";
const NO_ROWS = Object.freeze([]);

export default class FlowConnect extends LightningElement {
  @api resolved;
  @api picks = {};
  @api nodeKey;

  // Derived values, kept while their inputs are the same objects: rows is
  // read twice a render, and a new options list makes each picker search
  // it anew.
  _cache = {};

  memo(name, inputs, build) {
    const entry = this._cache[name];
    if (entry && entry.inputs.every((input, i) => input === inputs[i])) {
      return entry.value;
    }
    const value = build();
    this._cache[name] = { inputs, value };
    return value;
  }

  get model() {
    return this.resolved && this.resolved.model;
  }

  get node() {
    return this.model && this.model.nodes.get(this.nodeKey);
  }

  // Every element but the start and, unless a connector already goes
  // there, this one: a path straight back to itself is a mistake.
  targetOptions(node) {
    const { model } = this;
    const selfLoop = connectorSlots(node).some((slot) => {
      const edge = model.edges.get(`${node.key}.${slot}`);
      return edge && edge.target === node.key;
    });
    return this.memo("targets", [model, node.key, selfLoop], () => {
      const options = [...model.nodes.values()]
        .filter(
          (other) => other.key !== START && (other.key !== node.key || selfLoop)
        )
        .sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0))
        .map((other) => ({
          label: `${other.label || other.key} (${other.key})`,
          value: other.key
        }));
      return [{ label: "Nothing: the path ends", value: NOWHERE }, ...options];
    });
  }

  get rows() {
    const node = this.node;
    if (!node) {
      return NO_ROWS;
    }
    return this.memo("rows", [this.model, node, this.picks], () =>
      this.buildRows(node)
    );
  }

  buildRows(node) {
    const options = this.targetOptions(node);
    const picks = this.picks || {};
    return connectorSlots(node).map((slot) => {
      const id = wireId(node.key, slot);
      const edge = this.model.edges.get(`${node.key}.${slot}`);
      const rewired = typeof picks[id] === "string";
      return {
        id,
        slot,
        label: slotLabel(node, slot),
        value: edge ? edge.target : NOWHERE,
        options,
        rewired,
        rowClass: rewired ? "row row-rewired" : "row"
      };
    });
  }

  get hasRows() {
    return this.rows.length > 0;
  }

  handleTarget(event) {
    const { id } = event.target.dataset;
    this.dispatchEvent(
      new CustomEvent("pick", {
        detail: { picks: { [id]: event.detail.value } }
      })
    );
  }

  handleUndo(event) {
    const { id } = event.currentTarget.dataset;
    this.dispatchEvent(
      new CustomEvent("pick", { detail: { picks: { [id]: null } } })
    );
  }
}
