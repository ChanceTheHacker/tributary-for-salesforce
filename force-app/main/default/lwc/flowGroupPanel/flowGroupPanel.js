/**
 * Several elements picked together on the merge canvas: what each is, and
 * ways to deal with them in one step: take all of them from a version (or
 * leave them all out), or put them on a path in the merged flow.
 *
 * Events: pick { picks }, open { key } for one element, unmark { key } to
 * drop one from the group, clear to drop them all.
 */
import { LightningElement, api } from "lwc";
import {
  groupPicks,
  insertPicks,
  unitsForNode,
  SAME,
  THREE_WAY
} from "c/flowMerge";
import { elementInfo } from "c/flowElements";
import { plural } from "c/flowUtils";

export default class FlowGroupPanel extends LightningElement {
  @api merge;
  @api resolved;
  @api picks = {};
  /** Keys of the elements in the group. */
  @api keys = [];
  /** Names for each side. */
  @api labels = {};

  label(side) {
    return (this.labels && this.labels[side]) || side;
  }

  get threeWay() {
    return this.merge.mode === THREE_WAY;
  }

  get title() {
    return `${plural(this.keys.length, "element")} selected`;
  }

  nodeOf(key) {
    for (const name of this.merge.names) {
      const node = this.merge.sides[name].nodes.get(key);
      if (node) {
        return node;
      }
    }
    return undefined;
  }

  // Where each element is from and whether the merge has it now.
  get rows() {
    const { merge, resolved } = this;
    return this.keys
      .map((key) => ({ key, node: this.nodeOf(key) }))
      .filter((row) => row.node)
      .map(({ key, node }) => {
        const has = merge.names.filter((name) =>
          merge.sides[name].nodes.has(key)
        );
        const differs = unitsForNode(merge, key).some(
          (unit) => unit.status !== SAME && unit.kind !== "pos"
        );
        let origin;
        if (has.length === 1) {
          origin = `Only in ${this.label(has[0])}`;
        } else if (has.length < merge.names.length) {
          origin = `Not in ${merge.names
            .filter((name) => !has.includes(name))
            .map((name) => this.label(name))
            .join(" or ")}`;
        } else {
          origin = differs ? "Changed" : "Same in each";
        }
        const inResult = resolved.model.nodes.has(key);
        const info = elementInfo(node);
        return {
          key,
          name: node.label || key,
          type: info.label,
          icon: info.icon,
          origin,
          inResult,
          resultText: inResult ? "In the merge" : "Left out",
          resultClass: inResult ? "state state-in" : "state state-out",
          openLabel: `Open ${node.label || key}`,
          unmarkLabel: `Take ${node.label || key} out of the selection`
        };
      });
  }

  get mixed() {
    const sides = new Set();
    for (const key of this.keys) {
      for (const unit of unitsForNode(this.merge, key)) {
        if (unit.status !== SAME) sides.add(this.resolved.choices[unit.id]);
      }
    }
    return sides.size > 1;
  }

  // Every version, for taking the whole group from one; a version without
  // the elements leaves them out.
  get sideButtons() {
    return this.merge.names
      .filter((name) => name !== "base")
      .map((name) => {
        const count = this.keys.filter((key) =>
          this.merge.sides[name].nodes.has(key)
        ).length;
        return {
          side: name,
          label: count ? `Use ${this.label(name)}'s` : `Leave out`,
          title: count
            ? `Take ${plural(count, "element")} as ${this.label(name)} has them`
            : `${this.label(name)} has none of them: leave them all out`
        };
      });
  }

  // The version the elements are put in from: the other version, or the
  // one that has most of them.
  get placeSide() {
    const names = [...this.merge.names].reverse();
    let best;
    let most = 0;
    for (const name of names) {
      const count = this.keys.filter((key) =>
        this.merge.sides[name].nodes.has(key)
      ).length;
      if (count > most) {
        best = name;
        most = count;
      }
    }
    return best;
  }

  get placeKeys() {
    const side = this.placeSide;
    return side
      ? this.keys.filter((key) => this.merge.sides[side].nodes.has(key))
      : [];
  }

  get model() {
    return this.resolved.model;
  }

  get placeHint() {
    const count = this.placeKeys.length;
    if (!count) {
      return undefined;
    }
    return `Takes ${plural(count, "element")} from ${this.label(this.placeSide)} and puts them between the element and what it leads to now. Before they go in, it shows where each of their paths will go, and asks where that's not clear.`;
  }

  get canPlace() {
    return this.placeKeys.length > 0;
  }

  handleSide(event) {
    const { side } = event.currentTarget.dataset;
    this.fire(groupPicks(this.merge, this.keys, side, this.picks));
  }

  handlePlace(event) {
    const { afterKey, slot, first, routes } = event.detail;
    this.fire(
      insertPicks(
        this.merge,
        this.resolved,
        this.placeKeys,
        this.placeSide,
        afterKey,
        slot,
        first,
        routes
      )
    );
  }

  fire(picks) {
    this.dispatchEvent(new CustomEvent("pick", { detail: { picks } }));
  }

  handleOpen(event) {
    this.dispatchEvent(
      new CustomEvent("open", {
        detail: { key: event.currentTarget.dataset.key }
      })
    );
  }

  handleUnmark(event) {
    this.dispatchEvent(
      new CustomEvent("unmark", {
        detail: { key: event.currentTarget.dataset.key }
      })
    );
  }

  handleClear() {
    this.dispatchEvent(new CustomEvent("clear"));
  }
}
