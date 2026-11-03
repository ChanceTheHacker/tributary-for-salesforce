/**
 * Merges flows on the canvas: two-way (keep one flow and take picked changes
 * from the other) or three-way (two edited copies of a shared base version).
 *
 * A merge is split into units the user can pick a side for:
 *   node|<element>                  an element added, removed or retyped
 *   field|<element>|<field>[|<item>] one field of an element on every side,
 *                                   or one item of a named list (an outcome,
 *                                   a screen field, a field assignment)
 *   order|<element>|<field>         the order of a named list's items
 *   pos|<element>                   where the element sits on the canvas
 *   edge|<connector key>            one connector
 *   resource|<name>                 one variable, formula, choice...
 *   prop|<field>                    one flow-level property
 *
 * Picks can also rewire a connector: wire|<element>|<slot> set to the
 * element it should lead to, or "" to leave that path unconnected. A wire
 * wins over whichever side the connector was picked from.
 *
 * resolveMerge applies the picks, pulls in resources the picked parts refer
 * to, and checks the result: connectors to missing elements, references to
 * missing resources and clashing names are errors, since Salesforce would
 * reject the version. The result is a model; toMetadata gives what to save.
 */
import {
  buildModel,
  isModel,
  isPlainObject,
  itemKey,
  itemAt,
  toMetadata,
  ITEM_KEYS,
  START
} from "c/flowModel";
import { TYPES } from "c/flowSchema";
import { clearSpot, spotIndex, usesAutoLayout } from "c/flowLayout";

export const TWO_WAY = "twoWay";
export const THREE_WAY = "threeWay";

// Unit statuses. Two-way units are SAME or DIFFERS; three-way units say which
// side changed them from the base.
export const SAME = "same";
export const DIFFERS = "differs";
export const OURS = "ours";
export const THEIRS = "theirs";
export const CONFLICT = "conflict";

export const ERROR = "error";
export const WARNING = "warning";

function asModel(input) {
  return isModel(input) ? input : buildModel(input);
}

function json(value) {
  return value === undefined ? "" : JSON.stringify(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Merges ordered key lists: the first list's order, with keys only found in
 * later lists inserted after the key that precedes them there (and after
 * keys an earlier list inserted at the same point).
 */
export function orderedUnion(lists) {
  const out = [...(lists[0] || [])];
  const seen = new Set(out);
  for (const list of lists.slice(1)) {
    const own = new Set(list);
    let position = 0;
    for (const key of list) {
      if (seen.has(key)) {
        position = out.indexOf(key) + 1;
        continue;
      }
      while (position < out.length && !own.has(out[position])) {
        position++;
      }
      out.splice(position++, 0, key);
      seen.add(key);
    }
  }
  return out;
}

// The key field shared by every present list, when each list's items are
// objects with unique values for it.
function sharedListKey(lists) {
  const present = lists.filter((list) => list !== undefined);
  if (!present.length || !present.every(Array.isArray)) {
    return undefined;
  }
  return ITEM_KEYS.find((key) =>
    present.every((list) => {
      const seen = new Set();
      return list.every((item) => {
        if (
          !isPlainObject(item) ||
          typeof item[key] !== "string" ||
          seen.has(item[key])
        ) {
          return false;
        }
        seen.add(item[key]);
        return true;
      });
    })
  );
}

function nodeShape(node) {
  return node ? `${node.type}:${node.synthetic === true}` : undefined;
}

function nodeValue(node) {
  return (
    node && {
      type: node.type,
      synthetic: node.synthetic === true,
      fields: node.fields,
      x: node.x,
      y: node.y
    }
  );
}

function edgeValue(edge) {
  return (
    edge && {
      target: edge.target,
      isGoTo: edge.isGoTo,
      extra: edge.extra
    }
  );
}

/**
 * Sets up a merge. Pass { before, after } for a two-way merge (the result
 * starts as `before`) or { base, ours, theirs } for a three-way merge. Each
 * side is a model, a Tooling API Flow record or bare metadata.
 *
 * options.defaultSide: the side two-way units start on ("before").
 */
export function createMerge(input, options = {}) {
  const mode = input.base ? THREE_WAY : TWO_WAY;
  const names =
    mode === THREE_WAY ? ["base", "ours", "theirs"] : ["before", "after"];
  const primary = mode === THREE_WAY ? "ours" : "before";
  // Key order follows the primary side, then the others.
  const ordered = [primary, ...names.filter((name) => name !== primary)];
  const sides = {};
  for (const name of names) {
    sides[name] = asModel(input[name]);
  }
  const defaultSide = options.defaultSide || "before";

  const units = new Map();
  const autoFor = (status) =>
    mode === THREE_WAY
      ? status === THEIRS
        ? "theirs"
        : "ours"
      : status === SAME
        ? "before"
        : defaultSide;
  const add = (unit, status = statusOf(mode, unit.values)) => {
    unit.status = status;
    unit.auto = autoFor(status);
    units.set(unit.id, unit);
    return unit;
  };
  const valuesBy = (read) =>
    Object.fromEntries(names.map((name) => [name, read(sides[name], name)]));

  const nodeKeys = orderedUnion(
    ordered.map((name) => [...sides[name].nodes.keys()])
  );
  const nodeInfo = new Map();
  for (const key of nodeKeys) {
    const present = names.map((name) => sides[name].nodes.get(key));
    const shapes = present.map(nodeShape);
    const split = shapes.every((shape) => shape && shape === shapes[0]);
    const info = { split, fields: [] };
    nodeInfo.set(key, info);
    const label = (present.find(Boolean) || {}).label || key;
    if (!split) {
      const unit = {
        id: `node|${key}`,
        kind: "node",
        nodeKey: key,
        label,
        values: valuesBy((model) => nodeValue(model.nodes.get(key)))
      };
      add(unit, wholeNodeStatus(mode, unit.values));
      continue;
    }
    const segs = [
      ...new Set(present.flatMap((node) => Object.keys(node.fields)))
    ].sort();
    for (const seg of segs) {
      const lists = present.map((node) => node.fields[seg]);
      const listKey = sharedListKey(lists);
      if (!listKey) {
        info.fields.push({ seg });
        add({
          id: `field|${key}|${seg}`,
          kind: "field",
          nodeKey: key,
          path: [seg],
          label: `${label} › ${seg}`,
          values: valuesBy((model) => model.nodes.get(key).fields[seg])
        });
        continue;
      }
      const items = orderedUnion(
        ordered.map((name) =>
          (sides[name].nodes.get(key).fields[seg] || []).map(
            (item) => item[listKey]
          )
        )
      );
      info.fields.push({ seg, listKey, items });
      // Outcome order decides which outcome wins, so the order of the items
      // the compared sides share is a unit of its own. In a three-way merge
      // that's the items both ours and theirs have, so an item both added
      // in different places is a conflict.
      const orderOf = (name) =>
        (sides[name].nodes.get(key).fields[seg] || []).map(
          (entry) => entry[listKey]
        );
      const compared = (mode === THREE_WAY ? ["ours", "theirs"] : names).map(
        (name) => new Set(orderOf(name))
      );
      const common = new Set(
        items.filter((item) => compared.every((list) => list.has(item)))
      );
      const order = {
        id: `order|${key}|${seg}`,
        kind: "order",
        nodeKey: key,
        path: [seg],
        label: `${label} › ${seg} › order`,
        values: valuesBy((model, name) =>
          common.size
            ? orderOf(name).filter((item) => common.has(item))
            : undefined
        )
      };
      if (mode === THREE_WAY && addedInSameGap(orderOf, items)) {
        add(order, CONFLICT);
      } else {
        add(order);
      }
      for (const item of items) {
        add({
          id: `field|${key}|${seg}|${item}`,
          kind: "field",
          nodeKey: key,
          path: [seg, item],
          label: `${label} › ${seg} › ${item}`,
          values: valuesBy((model) =>
            (model.nodes.get(key).fields[seg] || []).find(
              (entry) => entry[listKey] === item
            )
          )
        });
      }
    }
    const pos = {
      id: `pos|${key}`,
      kind: "pos",
      nodeKey: key,
      label: `${label} › position`,
      values: valuesBy((model) => {
        const node = model.nodes.get(key);
        return node.x === undefined && node.y === undefined
          ? undefined
          : { x: node.x, y: node.y };
      })
    };
    // Where both moved an element isn't worth stopping for: it doesn't
    // change what the flow does, so it stays where ours put it.
    const moved = statusOf(mode, pos.values);
    add(pos, moved === CONFLICT ? OURS : moved);
  }

  const edgeKeys = orderedUnion(
    ordered.map((name) => [...sides[name].edges.keys()])
  );
  for (const key of edgeKeys) {
    const any = names.map((name) => sides[name].edges.get(key)).find(Boolean);
    const unit = add({
      id: `edge|${key}`,
      kind: "edge",
      nodeKey: any.source,
      edgeKey: key,
      label: `${any.source === START ? "Start" : any.source} › ${any.label || any.slot}`,
      values: valuesBy((model) => edgeValue(model.edges.get(key)))
    });
    // A whole element's connectors come with it.
    if (!nodeInfo.get(any.source).split) {
      unit.follows = `node|${any.source}`;
    }
  }

  // Connectors that come with an element aren't shown on their own, so the
  // element counts as changed, or in conflict, when one of them is.
  const followers = new Map();
  for (const unit of units.values()) {
    if (unit.follows) {
      if (!followers.has(unit.follows)) {
        followers.set(unit.follows, []);
      }
      followers.get(unit.follows).push(unit.status);
    }
  }
  for (const [id, statuses] of followers) {
    const unit = units.get(id);
    unit.status = combinedStatus(mode, [unit.status, ...statuses]);
    unit.auto = autoFor(unit.status);
  }

  const resourceKeys = orderedUnion(
    ordered.map((name) => [...sides[name].resources.keys()])
  );
  for (const key of resourceKeys) {
    add({
      id: `resource|${key}`,
      kind: "resource",
      resourceKey: key,
      label: key,
      values: valuesBy((model) => {
        const resource = model.resources.get(key);
        return resource && { type: resource.type, fields: resource.fields };
      })
    });
  }

  const propKeys = orderedUnion(
    ordered.map((name) => Object.keys(sides[name].props).sort())
  );
  for (const key of propKeys) {
    add({
      id: `prop|${key}`,
      kind: "prop",
      label: key,
      path: [key],
      values: valuesBy((model) => model.props[key])
    });
  }

  return {
    mode,
    names,
    primary,
    sides,
    units,
    nodeKeys,
    nodeInfo,
    edgeKeys,
    resourceKeys,
    propKeys
  };
}

// A whole element's status, leaving out where it sits on the canvas: one
// side deleting it while the other only moved it is a deletion, not a
// conflict. Where only the positions differ, ours' position stands, as it
// does for an element both sides kept.
function wholeNodeStatus(mode, values) {
  const status = statusOf(mode, values);
  if (mode !== THREE_WAY || status !== CONFLICT) {
    return status;
  }
  const unplaced = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      value && { ...value, x: undefined, y: undefined }
    ])
  );
  const content = statusOf(mode, unplaced);
  return content === SAME ? OURS : content;
}

// Whether ours and theirs each added an item (one the other side and the base
// don't have) right after the same shared item, so which comes first is
// theirs to pick.
function addedInSameGap(orderOf, items) {
  const lists = {
    base: new Set(orderOf("base")),
    ours: new Set(orderOf("ours")),
    theirs: new Set(orderOf("theirs"))
  };
  const shared = new Set(
    items.filter((item) => Object.values(lists).every((list) => list.has(item)))
  );
  const gaps = (side, other) => {
    const out = new Set();
    let gap = "^";
    for (const item of orderOf(side)) {
      if (shared.has(item)) {
        gap = item;
      } else if (!lists.base.has(item) && !lists[other].has(item)) {
        out.add(gap);
      }
    }
    return out;
  };
  const theirs = gaps("theirs", "ours");
  return [...gaps("ours", "theirs")].some((gap) => theirs.has(gap));
}

// The status of units taken together: changed if any is, and in conflict
// if any is or ours and theirs both changed one.
function combinedStatus(mode, statuses) {
  const changed = new Set(statuses.filter((status) => status !== SAME));
  if (mode === TWO_WAY) {
    return changed.size ? DIFFERS : SAME;
  }
  if (changed.has(CONFLICT) || (changed.has(OURS) && changed.has(THEIRS))) {
    return CONFLICT;
  }
  return changed.size ? [...changed][0] : SAME;
}

function statusOf(mode, values) {
  if (mode === TWO_WAY) {
    return json(values.before) === json(values.after) ? SAME : DIFFERS;
  }
  const base = json(values.base);
  const ours = json(values.ours);
  const theirs = json(values.theirs);
  if (ours === theirs) {
    return SAME;
  }
  if (theirs === base) {
    return OURS;
  }
  if (ours === base) {
    return THEIRS;
  }
  return CONFLICT;
}

// Whether a connector's slot exists on an element: a list item it hangs off
// (an outcome, a wait event) has to be there.
function slotFits(node, slot) {
  if (node.synthetic) {
    return slot === "startElementReference";
  }
  const segments = slot.split(".");
  // A path its type has no room for, like an Assignment's fault path, left
  // by a wire made while the element was another type.
  if (segments.length === 1 && lacksConnector(node.type, slot)) {
    return false;
  }
  let current = node.fields;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (Array.isArray(current)) {
      current = itemAt(current, segment);
      if (!current) {
        return false;
      }
    } else if (isPlainObject(current) && current[segment] !== undefined) {
      current = current[segment];
    } else {
      // Objects and lists holding only connectors aren't kept in fields;
      // they're recreated when the connector is written back. Anything
      // deeper, like a missing outcome, leaves the connector nowhere to go.
      return i === segments.length - 2;
    }
  }
  return true;
}

// Kinds of connectors by the field that holds them, for connectors a wire
// makes that no version has.
const WIRE_KINDS = {
  connector: "next",
  startElementReference: "next",
  defaultConnector: "default",
  faultConnector: "fault",
  nextValueConnector: "loopNext",
  noMoreValuesConnector: "loopEnd"
};
const WIRE_LIST_KINDS = {
  rules: "outcome",
  scheduledPaths: "scheduledPath",
  waitEvents: "waitEvent",
  paths: "experimentPath",
  actionCallPaths: "actionCallPaths"
};

export const WIRE = "wire";

/** The pick id that rewires an element's connector at a slot. */
export function wireId(source, slot) {
  return `${WIRE}|${source}|${slot}`;
}

/** The wires among picks, as [{ id, source, slot, target }]. */
export function wiresOf(picks = {}) {
  const out = [];
  for (const [id, target] of Object.entries(picks)) {
    if (!id.startsWith(`${WIRE}|`) || typeof target !== "string") {
      continue;
    }
    const [, source, ...rest] = id.split("|");
    out.push({ id, source, slot: rest.join("|"), target });
  }
  return out;
}

function wiredEdge(node, slot, target, existing) {
  if (existing) {
    return { ...existing, target, isGoTo: false };
  }
  const segments = slot.split(".");
  const field = segments[segments.length - 1];
  let kind = WIRE_KINDS[field] || field;
  let label;
  if (segments.length === 3 && WIRE_LIST_KINDS[segments[0]]) {
    kind = WIRE_LIST_KINDS[segments[0]];
    const item = itemAt(node.fields[segments[0]] || [], segments[1]);
    label = item && item.label;
  } else if (field === "defaultConnector") {
    label = node.fields.defaultConnectorLabel;
  }
  return {
    key: `${node.key}.${slot}`,
    source: node.key,
    target,
    slot,
    kind,
    label,
    isGoTo: false
  };
}

const hasSpot = (node) =>
  typeof node.x === "number" && typeof node.y === "number";

/**
 * Positions picked from different sides' layouts can put two elements on one
 * spot. Where no side has the two there together, the element the primary
 * side doesn't have there moves to the nearest clear place, so the merged
 * flow opens and saves readable. Overlaps a side drew itself are left alone.
 */
function separate(nodes, sides, names, primary) {
  const from = new Map();
  for (const node of nodes.values()) {
    from.set(
      node,
      names.filter((name) => {
        const there = sides[name].nodes.get(node.key);
        return there && there.x === node.x && there.y === node.y;
      })
    );
  }
  const together = (a, b) =>
    from.get(a).some((name) => from.get(b).includes(name));
  const list = [...nodes.values()].filter(hasSpot);
  const stays = (node) => from.get(node).includes(primary);
  list.sort((a, b) => stays(b) - stays(a));
  const placed = spotIndex();
  for (const node of list) {
    const clash = placed.some(
      node,
      undefined,
      undefined,
      (other) => !together(node, other)
    );
    if (clash) {
      const spot = clearSpot(node, placed);
      node.x = spot.x;
      node.y = spot.y;
      from.set(node, []);
    }
    placed.add(node);
  }
}

function assemble(merge, choiceOf, wires = [], edits = {}) {
  const { sides, primary, units } = merge;
  const pick = (id) => {
    const unit = units.get(id);
    return choiceOf(unit) === "custom"
      ? edits[id].text
      : unit.values[choiceOf(unit)];
  };
  const raw = {
    nodes: new Map(),
    edges: new Map(),
    resources: new Map(),
    props: {}
  };
  const dropped = [];

  for (const key of merge.nodeKeys) {
    const info = merge.nodeInfo.get(key);
    if (!info.split) {
      const unit = units.get(`node|${key}`);
      const node = sides[choiceOf(unit)].nodes.get(key);
      if (node) {
        raw.nodes.set(key, clone(node));
      }
      continue;
    }
    const template = sides[primary].nodes.get(key);
    const fields = {};
    for (const field of info.fields) {
      if (!field.listKey) {
        const value = pick(`field|${key}|${field.seg}`);
        if (value !== undefined) {
          fields[field.seg] = clone(value);
        }
        continue;
      }
      // The picked side's order, with items only the other sides have
      // placed after the item they follow there.
      const orderSide = choiceOf(units.get(`order|${key}|${field.seg}`));
      const orderOf = (name) =>
        (sides[name].nodes.get(key).fields[field.seg] || []).map(
          (item) => item[field.listKey]
        );
      const others = [primary, ...merge.names].filter(
        (name, index, all) => name !== orderSide && all.indexOf(name) === index
      );
      const items = orderedUnion([orderSide, ...others].map(orderOf))
        .map((item) => pick(`field|${key}|${field.seg}|${item}`))
        .filter((item) => item !== undefined)
        .map(clone);
      if (items.length) {
        fields[field.seg] = items;
      }
    }
    const pos = pick(`pos|${key}`) || {};
    raw.nodes.set(key, {
      ...template,
      fields,
      label: fields.label,
      x: pos.x,
      y: pos.y
    });
  }

  for (const key of merge.edgeKeys) {
    const unit = units.get(`edge|${key}`);
    const edge = sides[choiceOf(unit)].edges.get(key);
    if (!edge) {
      continue;
    }
    const source = raw.nodes.get(edge.source);
    if (!source) {
      continue;
    }
    if (!slotFits(source, edge.slot)) {
      dropped.push(unit);
      continue;
    }
    raw.edges.set(key, clone(edge));
  }

  const wired = [];
  for (const wire of wires) {
    const source = raw.nodes.get(wire.source);
    if (!source || !slotFits(source, wire.slot)) {
      continue;
    }
    const key = `${wire.source}.${wire.slot}`;
    if (wire.target) {
      raw.edges.set(
        key,
        wiredEdge(source, wire.slot, wire.target, raw.edges.get(key))
      );
    } else {
      raw.edges.delete(key);
    }
    wired.push(wire.id);
  }

  for (const key of merge.resourceKeys) {
    const unit = units.get(`resource|${key}`);
    const resource = sides[choiceOf(unit)].resources.get(key);
    if (resource) {
      raw.resources.set(key, clone(resource));
    }
  }

  for (const key of merge.propKeys) {
    const value = pick(`prop|${key}`);
    if (value !== undefined) {
      raw.props[key] = clone(value);
    }
  }

  if (!usesAutoLayout(sides[primary])) {
    separate(raw.nodes, sides, merge.names, primary);
  }

  const metadata = toMetadata(raw);
  const model = buildModel({
    FullName: sides[primary].name,
    Metadata: metadata
  });
  return { model, metadata, dropped, wired };
}

const REFERENCE_FIELD = /References?$/;
const MERGE_FIELD = /\{!\s*([^}\s]+?)\s*\}/g;

/** The name a reference starts with: "Get_Case" in "Get_Case.Owner.Name". */
export function referenceRoot(reference) {
  return String(reference).split(/[.[]/)[0].trim();
}

function rootName(reference, globals) {
  const root = referenceRoot(reference);
  return root && root.startsWith("$") === globals ? root : undefined;
}

// Names a value refers to: *Reference fields and {!merge} fields in text.
// With `globals`, only the $ names instead ($Record, $User...).
function collectReferences(value, found, key, globals = false) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferences(item, found, key, globals);
    }
  } else if (isPlainObject(value)) {
    for (const [field, item] of Object.entries(value)) {
      collectReferences(item, found, field, globals);
    }
  } else if (typeof value === "string") {
    if (key && REFERENCE_FIELD.test(key)) {
      const root = rootName(value, globals);
      if (root) {
        found.add(root);
      }
    }
    for (const match of value.matchAll(MERGE_FIELD)) {
      const root = rootName(match[1], globals);
      if (root) {
        found.add(root);
      }
    }
  }
  return found;
}

/**
 * Where a flow uses $ globals: a Map from the lower-cased global
 * ("$record") to the keys of the elements and resources using it, with
 * "" for the flow's own properties.
 */
export function globalUses(model) {
  const uses = new Map();
  const note = (value, owner) => {
    for (const name of collectReferences(value, new Set(), undefined, true)) {
      const lower = name.toLowerCase();
      if (!uses.has(lower)) {
        uses.set(lower, []);
      }
      if (!uses.get(lower).includes(owner)) {
        uses.get(lower).push(owner);
      }
    }
  };
  for (const node of model.nodes.values()) {
    note(node.fields, node.key);
  }
  for (const resource of model.resources.values()) {
    note(resource.fields, resource.key);
  }
  note(model.props, "");
  return uses;
}

const RECORD_TRIGGERS = new Set(["RecordAfterSave", "RecordBeforeSave"]);

// Lists whose items are named after something else (an action's
// parameters, a start's inputs, builder metadata), so their names aren't
// names the flow defines.
export const NOT_DEFINED =
  /(Parameters|Assignments)$|^(inputs|outputConfigParams|processMetadataValues|capabilityTypes)$/;

function collectNames(value, found, key) {
  if (Array.isArray(value)) {
    if (!(key && NOT_DEFINED.test(key))) {
      for (const item of value) {
        collectNames(item, found);
      }
    }
  } else if (isPlainObject(value)) {
    if (typeof value.name === "string") {
      found.add(value.name.toLowerCase());
    }
    for (const [field, item] of Object.entries(value)) {
      collectNames(item, found, field);
    }
  }
  return found;
}

/** Every name a flow defines (elements, resources and the named items inside them), lower-cased. */
export function definedNames(model) {
  const names = new Set();
  for (const node of model.nodes.values()) {
    if (node.key !== START) {
      names.add(node.key.toLowerCase());
    }
    collectNames(node.fields, names);
  }
  for (const resource of model.resources.values()) {
    names.add(resource.key.toLowerCase());
    collectNames(resource.fields, names);
  }
  return names;
}

/** References that don't resolve, as [{ name, owner, ownerKind }]. */
export function unresolvedReferences(model) {
  const names = definedNames(model);
  const out = [];
  const check = (value, owner, ownerKind) => {
    for (const name of collectReferences(value, new Set())) {
      if (!names.has(name.toLowerCase())) {
        out.push({ name, owner, ownerKind });
      }
    }
  };
  for (const node of model.nodes.values()) {
    check(node.fields, node.key, "node");
  }
  for (const resource of model.resources.values()) {
    check(resource.fields, resource.key, "resource");
  }
  check(model.props, undefined, "flow");
  return out;
}

function reachable(model) {
  const seen = new Set();
  const stack = model.nodes.has(START) ? [START] : [];
  const next = new Map();
  for (const edge of model.edges.values()) {
    if (!next.has(edge.source)) {
      next.set(edge.source, []);
    }
    next.get(edge.source).push(edge.target);
  }
  while (stack.length) {
    const key = stack.pop();
    if (!seen.has(key)) {
      seen.add(key);
      stack.push(...(next.get(key) || []));
    }
  }
  return seen;
}

// Items inside elements that the whole flow refers to by name, so their
// names are the flow's API names too: screen fields (in sections as well),
// decision outcomes and wait events. Parameters, builder metadata and a
// screen's actions are named only within their element.
const ADDRESSABLE = {
  screens: "fields",
  decisions: "rules",
  waits: "waitEvents"
};

// Who claims each API name, lower-cased: [{ nodeKey or resourceKey, name,
// inside }], inside for an item inside an element.
function nameClaims(model) {
  const owners = new Map();
  const claim = (name, what) => {
    const lower = name.toLowerCase();
    if (!owners.has(lower)) {
      owners.set(lower, []);
    }
    owners.get(lower).push(what);
  };
  const claimInside = (node, items) => {
    for (const item of items || []) {
      if (isPlainObject(item) && typeof item.name === "string") {
        claim(item.name, { nodeKey: node.key, name: item.name, inside: true });
      }
      if (isPlainObject(item) && node.type === "screens") {
        claimInside(node, item.fields);
      }
    }
  };
  for (const node of model.nodes.values()) {
    if (node.key !== START) {
      claim(node.key, { nodeKey: node.key, name: node.key });
    }
    if (ADDRESSABLE[node.type]) {
      claimInside(node, node.fields[ADDRESSABLE[node.type]]);
    }
  }
  for (const resource of model.resources.values()) {
    claim(resource.key, { resourceKey: resource.key, name: resource.key });
  }
  return owners;
}

const displayName = (model, key) => {
  if (key === START) {
    return "Start";
  }
  const node = model.nodes.get(key);
  return node && node.label ? `${node.label} (${key})` : key;
};

// A resource that used to be referenced but no longer is stays in the flow:
// callers may still use input/output variables, and removal is a user's choice.
function unusedResourceIssues(model, sides) {
  const references = (flow) => {
    const found = collectReferences(flow.props, new Set());
    for (const item of [...flow.nodes.values(), ...flow.resources.values()]) {
      collectReferences(item.fields, found);
    }
    return new Set([...found].map((name) => name.toLowerCase()));
  };
  const used = references(model);
  const before = new Set(sides.flatMap((side) => [...references(side)]));
  return [...model.resources.values()]
    .filter((resource) => {
      const name = resource.key.toLowerCase();
      return (
        before.has(name) &&
        !used.has(name) &&
        !resource.fields.isInput &&
        !resource.fields.isOutput
      );
    })
    .map((resource) => ({
      severity: WARNING,
      code: "unusedResource",
      resourceKey: resource.key,
      name: resource.key,
      message: `Resource ${resource.key} was used in a compared version but has no references in this result. It was kept; review it in Resources before saving.`
    }));
}

/**
 * Checks a flow model. `sides` are the flows it came from: a reference that
 * doesn't resolve is only reported when it resolves in one of them, so names
 * Salesforce resolves itself (objects, fields, labels) aren't flagged.
 */
export function validateFlow(model, sides = []) {
  const issues = [];
  for (const edge of model.edges.values()) {
    if (!model.nodes.has(edge.target)) {
      issues.push({
        severity: ERROR,
        code: "danglingConnector",
        nodeKey: edge.source,
        edgeKey: edge.key,
        name: edge.target,
        message: `A connector from ${displayName(model, edge.source)} goes to ${edge.target}, which isn't in the flow.`
      });
    }
  }

  const known = sides.map(definedNames);
  const reported = new Set();
  for (const ref of unresolvedReferences(model)) {
    const lower = ref.name.toLowerCase();
    if (!known.some((names) => names.has(lower))) {
      continue;
    }
    const id = `${ref.ownerKind}:${ref.owner}:${lower}`;
    if (reported.has(id)) {
      continue;
    }
    reported.add(id);
    const where =
      ref.ownerKind === "node"
        ? displayName(model, ref.owner)
        : ref.ownerKind === "resource"
          ? `Resource ${ref.owner}`
          : "The flow's properties";
    issues.push({
      severity: ERROR,
      code: "missingReference",
      nodeKey: ref.ownerKind === "node" ? ref.owner : undefined,
      resourceKey: ref.ownerKind === "resource" ? ref.owner : undefined,
      name: ref.name,
      message: `${where} uses ${ref.name}, which isn't in the flow.`
    });
  }

  const owners = nameClaims(model);
  let sideClashes;
  for (const [lower, claims] of owners) {
    if (claims.length < 2) {
      continue;
    }
    // A clash inside elements that a version already has is one Salesforce
    // took, so it isn't one to stop for.
    if (claims.some((c) => c.inside)) {
      sideClashes = sideClashes || sides.map(nameClaims);
      if (sideClashes.some((side) => (side.get(lower) || []).length > 1)) {
        continue;
      }
    }
    issues.push({
      severity: ERROR,
      code: "nameClash",
      nodeKey: (claims.find((c) => c.nodeKey) || {}).nodeKey,
      resourceKey: (claims.find((c) => c.resourceKey) || {}).resourceKey,
      name: claims[0].name,
      message: `${claims.map((c) => (c.inside ? `${c.name} in ${displayName(model, c.nodeKey)}` : c.name)).join(" and ")} have the same API name.`
    });
  }

  // A name defined twice only reaches here from hand-edited XML: the model
  // kept one definition, but the text still has both.
  const repeats = new Map();
  for (const duplicate of model.duplicates || []) {
    if (!repeats.has(duplicate.name)) {
      repeats.set(duplicate.name, [duplicate.earlier]);
    }
    repeats.get(duplicate.name).push(duplicate.type);
  }
  for (const [name, types] of repeats) {
    issues.push({
      severity: ERROR,
      code: "duplicateName",
      nodeKey: model.nodes.has(name) ? name : undefined,
      resourceKey:
        !model.nodes.has(name) && model.resources.has(name) ? name : undefined,
      name,
      message: `${name} is defined ${types.length} times (${types.join(", ")}). Each element and resource needs its own API name.`
    });
  }

  issues.push(
    ...recordIssues(model),
    ...screenIssues(model),
    ...screenTriggerIssues(model, sides),
    ...unusedResourceIssues(model, sides)
  );

  if (model.nodes.size && !model.nodes.has(START)) {
    issues.push({
      severity: ERROR,
      code: "noStart",
      message: "The flow has no start element."
    });
  } else {
    const seen = reachable(model);
    for (const node of model.nodes.values()) {
      if (!seen.has(node.key)) {
        issues.push({
          severity: WARNING,
          code: "unreachable",
          nodeKey: node.key,
          message: `${displayName(model, node.key)} isn't connected to the start.`
        });
      }
    }
  }
  for (const keys of cycles(model)) {
    const names = keys.slice(0, 3).map((key) => displayName(model, key));
    issues.push({
      severity: WARNING,
      code: "cycle",
      nodeKey: keys[0],
      keys,
      message: `${names.join(", ")}${
        keys.length > 3 ? ` and ${keys.length - 3} more` : ""
      } lead back round to ${keys.length > 1 ? "each other" : "itself"} without a Loop element: make sure something ends it.`
    });
  }
  return issues;
}

/**
 * Paths that go round without a Loop element: each is the keys of
 * elements that all lead back to each other (or one that leads to
 * itself), in canvas order. A Loop's own round trip, through its "for
 * each item" path, isn't one; coming back to a Loop after it's done is.
 */
export function cycles(model) {
  const next = new Map();
  for (const edge of model.edges.values()) {
    if (model.nodes.has(edge.target) && edge.slot !== "nextValueConnector") {
      if (!next.has(edge.source)) {
        next.set(edge.source, []);
      }
      next.get(edge.source).push(edge.target);
    }
  }
  // Tarjan's strongly connected components, without recursion.
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const found = [];
  let counter = 0;
  for (const root of model.nodes.keys()) {
    if (index.has(root)) {
      continue;
    }
    const work = [[root, 0]];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const [key, at] = frame;
      const targets = next.get(key) || [];
      if (at < targets.length) {
        frame[1]++;
        const target = targets[at];
        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter++);
          stack.push(target);
          onStack.add(target);
          work.push([target, 0]);
        } else if (onStack.has(target)) {
          low.set(key, Math.min(low.get(key), index.get(target)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(key)));
      }
      if (low.get(key) === index.get(key)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== key);
        if (component.length > 1 || (next.get(key) || []).includes(key)) {
          found.push(component);
        }
      }
    }
  }
  const order = [...model.nodes.keys()];
  return found
    .map((keys) => keys.sort((a, b) => order.indexOf(a) - order.indexOf(b)))
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}

// $Record is only there when the flow starts from a record (a record
// change, a schedule over records or a platform event), and $Record__Prior
// only when a record update starts it.
function recordIssues(model) {
  const start = model.nodes.get(START);
  if (!start || start.synthetic) {
    return [];
  }
  const uses = globalUses(model);
  const { object, triggerType, recordTriggerType } = start.fields;
  const issues = [];
  const where = (owners) => {
    const named = owners.map((owner) =>
      owner === ""
        ? "The flow's properties"
        : model.nodes.has(owner)
          ? displayName(model, owner)
          : `Resource ${owner}`
    );
    return named.length > 1
      ? `${named[0]} and ${named.length - 1} more`
      : named[0];
  };
  const issue = (severity, code, global, owners, message) => {
    const first = owners[0];
    issues.push({
      severity,
      code,
      nodeKey: model.nodes.has(first) ? first : undefined,
      resourceKey: model.resources.has(first) ? first : undefined,
      name: global,
      owners,
      message: `${where(owners)} ${owners.length > 1 ? "use" : "uses"} ${global}, ${message}`
    });
  };
  const record = uses.get("$record");
  if (record && !object) {
    issue(
      ERROR,
      "recordWithoutTrigger",
      "$Record",
      record,
      "but the flow doesn't start from a record, so there's no $Record."
    );
  }
  const prior = uses.get("$record__prior");
  if (prior) {
    if (!object || !RECORD_TRIGGERS.has(triggerType)) {
      issue(
        ERROR,
        "priorWithoutUpdate",
        "$Record__Prior",
        prior,
        "which only a flow started by a record change has."
      );
    } else if (
      recordTriggerType === "Create" ||
      recordTriggerType === "Delete"
    ) {
      issue(
        WARNING,
        "priorWithoutUpdate",
        "$Record__Prior",
        prior,
        `but the flow starts when a record is ${recordTriggerType === "Create" ? "created" : "deleted"}, when there's no earlier version of it.`
      );
    }
  }
  return issues;
}

// Screens need someone to show them to. An autolaunched flow, and any flow a
// record change, a schedule or an event starts, has no one, so Salesforce
// refuses to save one with a screen in it.
function screenIssues(model) {
  const processType = (model.props || {}).processType || model.processType;
  const start = model.nodes.get(START);
  const trigger = start && !start.synthetic && start.fields.triggerType;
  if (processType !== "AutoLaunchedFlow" && !trigger) {
    return [];
  }
  const kind = RECORD_TRIGGERS.has(trigger)
    ? "a record-triggered flow"
    : trigger
      ? "a flow that starts on its own"
      : "an autolaunched flow";
  return [...model.nodes.values()]
    .filter((node) => node.type === "screens")
    .map((node) => ({
      severity: ERROR,
      code: "screenNotAllowed",
      nodeKey: node.key,
      name: node.key,
      message: `${displayName(model, node.key)} is a Screen, and ${kind} can't show screens. Leave it out, or merge into a screen flow.`
    }));
}

// The names a screen defines itself: its fields at any depth, its actions,
// and the screen.
function screenNames(node) {
  return collectNames(node.fields, new Set([node.key.toLowerCase()]));
}

// A screen's trigger runs one of that screen's own actions, named by
// screenActionName, and may listen to one of its components, named by
// eventSource: plain names, which the reference checks don't see. A source
// is only reported when the screen had it in a flow merged from, so a
// source the platform defines isn't flagged.
function screenTriggerIssues(model, sides) {
  const issues = [];
  const hadLocally = (key, lower) =>
    sides.some((side) => {
      const node = side.nodes.get(key);
      return node && node.type === "screens" && screenNames(node).has(lower);
    });
  for (const node of model.nodes.values()) {
    if (node.type !== "screens") {
      continue;
    }
    const actions = new Set(
      (node.fields.actions || [])
        .filter((action) => isPlainObject(action))
        .map((action) => String(action.name).toLowerCase())
    );
    let own;
    for (const trigger of node.fields.triggers || []) {
      const source = trigger && trigger.eventSource;
      if (typeof source === "string") {
        own = own || screenNames(node);
        const lower = source.toLowerCase();
        if (!own.has(lower) && hadLocally(node.key, lower)) {
          issues.push({
            severity: ERROR,
            code: "missingEventSource",
            nodeKey: node.key,
            name: source,
            message: `${displayName(model, node.key)} reacts to ${source}, which the screen doesn't have.`
          });
        }
      }
      for (const handler of (trigger && trigger.handlers) || []) {
        const name = handler && handler.screenActionName;
        if (typeof name === "string" && !actions.has(name.toLowerCase())) {
          issues.push({
            severity: ERROR,
            code: "missingScreenAction",
            nodeKey: node.key,
            name,
            message: `${displayName(model, node.key)} runs the screen action ${name}, which the screen doesn't have.`
          });
        }
      }
    }
  }
  return issues;
}

// Only free-form flow text can be edited this way, never executable settings,
// references, whole elements or enum-valued properties.
export function editableText(unit) {
  return Boolean(
    unit &&
    unit.kind === "prop" &&
    ["description", "label", "interviewLabel"].includes(unit.path[0])
  );
}

export function textPick(unit, pick) {
  return (
    editableText(unit) &&
    pick !== null &&
    typeof pick === "object" &&
    !Array.isArray(pick) &&
    typeof pick.text === "string"
  );
}

/**
 * Applies picks ({ unitId: side | { text } }) to a merge. Free-form flow
 * label, description and interview label support custom text; all other
 * units accept only a source side. Units without a valid pick take their
 * automatic side: the changed side in a three-way merge ("ours" for
 * conflicts), `defaultSide` in a two-way one.
 *
 * Returns { model, metadata, issues, choices, autoIncluded, conflicts,
 * wired }: choices are the sides actually used (or "custom"), autoIncluded
 * the resources pulled in because a picked part refers to them, conflicts
 * the three-way units changed differently on both sides with no valid pick,
 * and wired the wire picks that took effect.
 */
export function resolveMerge(merge, picks = {}) {
  const { units, names, sides } = merge;
  const chosen = new Map();
  for (const unit of units.values()) {
    const pick = picks[unit.id];
    chosen.set(
      unit.id,
      textPick(unit, pick) ? "custom" : names.includes(pick) ? pick : unit.auto
    );
  }
  const choiceOf = (unit) =>
    unit.follows ? choiceOf(units.get(unit.follows)) : chosen.get(unit.id);

  const byName = new Map(
    merge.resourceKeys.map((key) => [key.toLowerCase(), `resource|${key}`])
  );
  const preference =
    merge.mode === THREE_WAY ? ["ours", "theirs", "base"] : ["after", "before"];
  const sideModels = names.map((name) => sides[name]);
  const autoIncluded = [];

  const wires = wiresOf(picks);
  let result = assemble(merge, choiceOf, wires, picks);
  let issues = validateFlow(result.model, sideModels);
  // A resource a picked part uses comes too, from the first side that has
  // it, unless it's picked itself. What it brings can use more in turn:
  // those are followed here, a round at a time, in the order checking each
  // round's result would list them, and the result is put together and
  // checked once more at the end.
  const included = new Set();
  const bring = (name, added) => {
    const id = byName.get(name.toLowerCase());
    if (!id || picks[id] !== undefined || included.has(id)) {
      return;
    }
    const unit = units.get(id);
    const side = preference.find((each) => unit.values[each] !== undefined);
    if (side && chosen.get(id) !== side) {
      chosen.set(id, side);
      included.add(id);
      autoIncluded.push(id);
      added.push(sides[side].resources.get(unit.resourceKey));
    }
  };
  let added = [];
  for (const issue of issues) {
    if (issue.code === "missingReference") {
      bring(issue.name, added);
    }
  }
  if (added.length) {
    const defined = definedNames(result.model);
    const position = new Map(
      merge.resourceKeys.map((key, index) => [key, index])
    );
    while (added.length) {
      for (const resource of added) {
        defined.add(resource.key.toLowerCase());
        collectNames(resource.fields, defined);
      }
      // As the result lists them: by kind, then in the merge's order.
      added.sort((a, b) =>
        a.type === b.type
          ? position.get(a.key) - position.get(b.key)
          : a.type < b.type
            ? -1
            : 1
      );
      const next = [];
      for (const resource of added) {
        for (const name of collectReferences(resource.fields, new Set())) {
          if (!defined.has(name.toLowerCase())) {
            bring(name, next);
          }
        }
      }
      added = next;
    }
    result = assemble(merge, choiceOf, wires, picks);
    issues = validateFlow(result.model, sideModels);
  }

  for (const unit of result.dropped) {
    issues.push({
      severity: WARNING,
      code: "droppedConnector",
      nodeKey: unit.nodeKey,
      edgeKey: unit.edgeKey,
      unitId: unit.id,
      message: `${unit.label}: the connector was left out because its path isn't in the merged element.`
    });
  }

  const choices = {};
  for (const unit of units.values()) {
    choices[unit.id] = choiceOf(unit);
  }
  const conflicts = [...units.values()]
    .filter(
      (unit) =>
        unit.status === CONFLICT &&
        !unit.follows &&
        !names.includes(picks[unit.id]) &&
        !textPick(unit, picks[unit.id])
    )
    .map((unit) => unit.id);

  return {
    model: result.model,
    metadata: result.metadata,
    issues,
    errors: issues.filter((issue) => issue.severity === ERROR).length,
    choices,
    autoIncluded,
    conflicts,
    wired: result.wired
  };
}

/**
 * A way to reconnect an element the result has nothing leading to: a
 * connector into it that some version has, from an element the result
 * keeps. Returns { unitId, side, edgeUnit } to pick (unitId is the whole
 * element when its connectors come with it), or undefined.
 */
export function reconnectFix(merge, resolved, nodeKey) {
  for (const unit of merge.units.values()) {
    if (unit.kind !== "edge" || !resolved.model.nodes.has(unit.nodeKey)) {
      continue;
    }
    const current = unit.values[resolved.choices[unit.id]];
    if (current && current.target === nodeKey) {
      continue;
    }
    const side = merge.names.find(
      (name) => unit.values[name] && unit.values[name].target === nodeKey
    );
    if (side) {
      return { unitId: unit.follows || unit.id, side, edgeUnit: unit };
    }
  }
  return undefined;
}

/** Units that differ between the sides, i.e. the ones worth showing. */
export function changedUnits(merge) {
  return [...merge.units.values()].filter(
    (unit) => unit.status !== SAME && !unit.follows
  );
}

/**
 * Picks for a whole merge: a side name takes that side for every unit, and
 * "union" (two-way) keeps everything either flow has, preferring `before`
 * where both have something different.
 */
export function presetPicks(merge, preset) {
  const picks = {};
  for (const unit of changedUnits(merge)) {
    if (preset === "union") {
      picks[unit.id] =
        unit.values.before === undefined && unit.values.after !== undefined
          ? "after"
          : "before";
    } else if (merge.names.includes(preset)) {
      picks[unit.id] = preset;
    }
  }
  return picks;
}

// A merge's units by the element they belong to, filed once per merge:
// looking an element's up is otherwise a pass over every unit, for each
// element drawn or taken.
const unitsByNode = new WeakMap();

/** An element's units: the element or its fields and position, plus its connectors. */
export function unitsForNode(merge, nodeKey) {
  let index = unitsByNode.get(merge);
  if (!index) {
    index = new Map();
    for (const unit of merge.units.values()) {
      if (unit.nodeKey !== undefined && !unit.follows) {
        const list = index.get(unit.nodeKey);
        if (list) {
          list.push(unit);
        } else {
          index.set(unit.nodeKey, [unit]);
        }
      }
    }
    unitsByNode.set(merge, index);
  }
  return [...(index.get(nodeKey) || [])];
}

// Each side's connectors by the element they leave and the element they
// lead to, in the side's order, filed once per side: group operations
// otherwise pass over every connector for each element in the group.
// buildModel's models aren't changed once built.
const connectorsByModel = new WeakMap();
const NONE = Object.freeze([]);

function connectorsOf(model) {
  let index = connectorsByModel.get(model);
  if (!index) {
    index = { from: new Map(), to: new Map() };
    const file = (map, key, edge) => {
      const list = map.get(key);
      if (list) {
        list.push(edge);
      } else {
        map.set(key, [edge]);
      }
    };
    for (const edge of model.edges.values()) {
      file(index.from, edge.source, edge);
      file(index.to, edge.target, edge);
    }
    connectorsByModel.set(model, index);
  }
  return index;
}

const leaving = (model, key) => connectorsOf(model).from.get(key) || NONE;
const arriving = (model, key) => connectorsOf(model).to.get(key) || NONE;

/**
 * Picks that take an element from one side, with the connectors that lead
 * into it there, so accepting an added element also wires it in.
 */
export function picksForNode(merge, nodeKey, side) {
  const picks = {};
  for (const unit of unitsForNode(merge, nodeKey)) {
    picks[unit.id] = side;
  }
  for (const edge of arriving(merge.sides[side], nodeKey)) {
    const unit = merge.units.get(`edge|${edge.key}`);
    if (unit && !unit.follows) {
      picks[unit.id] = side;
    }
  }
  return picks;
}

/**
 * The unit a field change belongs to, from a flowDiff change path on an
 * element ("node") or resource ("resource").
 */
export function unitForChange(merge, kind, key, path = []) {
  const { units } = merge;
  if (kind === "resource") {
    return units.get(`resource|${key}`);
  }
  if (kind === "prop") {
    return units.get(`prop|${path[0]}`);
  }
  return (
    units.get(`field|${key}|${path[0]}|${path[1]}`) ||
    units.get(`field|${key}|${path[0]}`) ||
    units.get(`order|${key}|${path[0]}`) ||
    units.get(`node|${key}`)
  );
}

// Picks side by side with the automatic choice, as resolveMerge makes them.
function choiceFor(merge, picks, unit) {
  if (unit.follows) {
    return choiceFor(merge, picks, merge.units.get(unit.follows));
  }
  const pick = picks[unit.id];
  return merge.names.includes(pick) ? pick : unit.auto;
}

/**
 * Picks that take several elements from one side, as picksForNode does for
 * each. When that side leaves them out, connectors elsewhere that lead into
 * them go back to a version that doesn't, or on past them, and wires into
 * them are undone (set to null), so leaving a group out doesn't leave
 * connectors dangling.
 */
export function groupPicks(merge, nodeKeys, side, current = {}) {
  const group = new Set(nodeKeys);
  const picks = {};
  for (const key of nodeKeys) {
    Object.assign(picks, picksForNode(merge, key, side));
  }
  const gone = new Set(
    nodeKeys.filter((key) => !merge.sides[side].nodes.has(key))
  );
  if (!gone.size) {
    return picks;
  }
  const into = (value) => value && gone.has(value.target);
  const after = { ...current, ...picks };
  const present = (key) => {
    const unit = merge.units.get(`node|${key}`);
    return unit
      ? merge.sides[choiceFor(merge, after, unit)].nodes.has(key)
      : merge.names.every((name) => merge.sides[name].nodes.has(key));
  };
  // Past the group, along its main path on a side, to what's left.
  const around = (name, key) => {
    const model = merge.sides[name];
    for (let at = key, seen = new Set(); at && !seen.has(at);) {
      seen.add(at);
      if (!gone.has(at)) {
        return present(at) ? at : undefined;
      }
      const main = model.edges.get(`${at}.${wayOn(model.nodes.get(at))}`);
      at = main && main.target;
    }
    return undefined;
  };
  for (const unit of merge.units.values()) {
    if (unit.kind !== "edge" || group.has(unit.nodeKey)) {
      continue;
    }
    // A wire decides where the connector goes, so one that leads outside
    // the group (or ends the path) stands.
    const wired =
      after[wireId(unit.nodeKey, unit.edgeKey.slice(unit.nodeKey.length + 1))];
    const chosen = choiceFor(merge, after, unit);
    if (
      (typeof wired === "string" && !gone.has(wired)) ||
      !into(unit.values[chosen])
    ) {
      continue;
    }
    // Another version's connector, or none, if the connector is picked on
    // its own; otherwise it goes past the group to where its path went on,
    // or ends there, so nothing is left dangling.
    const other =
      !unit.follows &&
      ([side, ...merge.names].find(
        (name) => unit.values[name] !== undefined && !into(unit.values[name])
      ) ||
        merge.names.find((name) => unit.values[name] === undefined));
    if (other) {
      picks[unit.id] = other;
    } else {
      const past = around(chosen, unit.values[chosen].target);
      picks[wireId(unit.nodeKey, unit.edgeKey.slice(unit.nodeKey.length + 1))] =
        past && past !== unit.nodeKey ? past : "";
    }
  }
  // A wire into the group is undone, unless the loop above has just sent
  // it on past the group.
  for (const wire of wiresOf(current)) {
    if (
      (gone.has(wire.target) || gone.has(wire.source)) &&
      picks[wire.id] === undefined
    ) {
      picks[wire.id] = null;
    }
  }
  return picks;
}

const FLOW_FIELDS = new Map(
  TYPES.Flow.split(",").map((field) => {
    const [name, type] = field.split(":");
    return [name, type.replace("*", "")];
  })
);

function schemaFields(type) {
  return (TYPES[type] || "")
    .split(",")
    .filter(Boolean)
    .map((field) => {
      const [name, fieldType] = field.split(":");
      return {
        name,
        type: fieldType.replace("*", ""),
        many: fieldType.endsWith("*")
      };
    });
}

// Each element type's own connector fields ("connector", "faultConnector"),
// by the flow field that lists it, and every such field of any type.
const CONNECTOR_FIELDS = new Map(
  [...FLOW_FIELDS].map(([name, type]) => [
    name,
    new Set(
      schemaFields(type)
        .filter((field) => field.type === "FlowConnector" && !field.many)
        .map((field) => field.name)
    )
  ])
);
const KNOWN_CONNECTORS = new Set(
  [...CONNECTOR_FIELDS.values()].flatMap((fields) => [...fields])
);

// Whether an element type has no connector field of that name, though
// another type does. A field the schema doesn't list may be newer, so it
// isn't turned down.
function lacksConnector(type, field) {
  return (
    Boolean(TYPES[FLOW_FIELDS.get(type)]) &&
    KNOWN_CONNECTORS.has(field) &&
    !CONNECTOR_FIELDS.get(type).has(field)
  );
}

const SLOT_ORDER = [
  "startElementReference",
  "connector",
  "nextValueConnector",
  "*",
  "noMoreValuesConnector",
  "defaultConnector",
  "timeoutConnector",
  "faultConnector"
];

function slotRank(slot) {
  const index = SLOT_ORDER.indexOf(slot);
  return index >= 0 ? index : SLOT_ORDER.indexOf("*");
}

/**
 * The connector slots an element has room for, in canvas order: its own
 * paths ("connector", "faultConnector"...) and one per named outcome, wait
 * event or scheduled path ("rules.Approved.connector").
 */
export function connectorSlots(node) {
  if (!node) {
    return [];
  }
  if (node.synthetic) {
    return ["startElementReference"];
  }
  const slots = [];
  for (const field of schemaFields(FLOW_FIELDS.get(node.type))) {
    if (field.type === "FlowConnector" && !field.many) {
      slots.push(field.name);
    } else if (
      field.many &&
      schemaFields(field.type).some(
        (item) => item.name === "connector" && item.type === "FlowConnector"
      )
    ) {
      for (const item of node.fields[field.name] || []) {
        const key = itemKey(item);
        if (key !== undefined) {
          slots.push(`${field.name}.${key}.connector`);
        }
      }
    }
  }
  return slots
    .map((slot, index) => ({ slot, index }))
    .sort((a, b) => slotRank(a.slot) - slotRank(b.slot) || a.index - b.index)
    .map((entry) => entry.slot);
}

/** The path an element goes on by when nothing branches: its first slot that isn't a fault path. */
export function mainSlot(node) {
  const slots = connectorSlots(node);
  return [
    "startElementReference",
    "connector",
    "nextValueConnector",
    "defaultConnector"
  ].find((slot) => slots.includes(slot));
}

// The path an element goes on by once it's done: a Loop's is after its
// last item, anything else's its main path.
function wayOn(node) {
  return node && node.type === "loops"
    ? "noMoreValuesConnector"
    : mainSlot(node);
}

/**
 * Picks that put elements from one side into the result at a connector:
 * the connector at `slot` of `afterKey` leads to the first of them, and
 * their paths that lead to nothing in the result go on to where that
 * connector used to lead (or end, if it led nowhere), as does the path
 * the group left by on its side. `first` names the element the path goes
 * into; otherwise it's the one nothing in the group leads to. `routes`
 * decides the connectors placePlan leaves as a choice.
 */
export function insertPicks(
  merge,
  resolved,
  nodeKeys,
  side,
  afterKey,
  slot,
  first,
  routes
) {
  return placement(merge, resolved, nodeKeys, side, afterKey, slot, {
    first,
    routes
  }).picks;
}

/**
 * What putting elements from one side on a path would do, before it's
 * done (see insertPicks). Options: first, the element the path goes into;
 * routes, { wireId: target or "" to end } for connectors whose way on is
 * someone's choice; current, the picks so far, to check the result.
 *
 * Returns:
 *   entry     the element the path goes into; entries, every element in
 *             the group nothing else in it leads to (more than one is a
 *             choice, unless `first` says)
 *   next      where the connector led before, and the group now goes on to
 *   exits     each connector out of the group: { id, from, slot, kind,
 *             target (where it led on its side, or undefined for a path
 *             that ended), value (where it will lead: "" ends it), keep
 *             (it still leads where it did), choice (it's for someone to
 *             decide), options [{ value, label }] }
 *   incoming  connectors on its side into the group from elsewhere, which
 *             aren't brought: { source, slot, target }
 *   dependencies  resources the group brings in because it uses them
 *   detached  elements of the group the start won't reach
 *   stranded  elements already there that the start won't reach any more
 *   cycles    paths through the group that go round without a Loop
 *   open      choices not made yet; picks, the picks to apply.
 */
export function placePlan(
  merge,
  resolved,
  nodeKeys,
  side,
  afterKey,
  slot,
  options = {}
) {
  const { current = {} } = options;
  const group = new Set(nodeKeys);
  const model = merge.sides[side];
  const planned = placement(
    merge,
    resolved,
    nodeKeys,
    side,
    afterKey,
    slot,
    options
  );
  const incoming = [...model.edges.values()]
    .filter((edge) => group.has(edge.target) && !group.has(edge.source))
    .map((edge) => ({
      source: edge.source,
      slot: edge.slot,
      target: edge.target
    }));

  const result = resolveMerge(merge, { ...current, ...planned.picks });
  const had = new Set(
    [...resolved.model.resources.keys()].map((key) => key.toLowerCase())
  );
  const dependencies = [...result.model.resources.keys()].filter(
    (key) => !had.has(key.toLowerCase())
  );
  const unreached = (issues) =>
    issues
      .filter((issue) => issue.code === "unreachable")
      .map((issue) => issue.nodeKey);
  const detached = unreached(result.issues).filter((key) => group.has(key));
  // Elements the start reached before that it won't once the paths end.
  const already = new Set(unreached(resolved.issues));
  const stranded = unreached(result.issues).filter(
    (key) => !group.has(key) && !already.has(key)
  );
  const round = cycles(result.model).filter((keys) =>
    keys.some((key) => group.has(key))
  );
  return {
    entry: planned.entry,
    entries: planned.entries,
    next: planned.next,
    exits: planned.exits,
    incoming,
    dependencies,
    detached,
    stranded,
    cycles: round,
    open: planned.open,
    picks: planned.picks
  };
}

// The picks for placing a group, and the choices they leave open, without
// working out what the result would be: insertPicks needs only these.
function placement(merge, resolved, nodeKeys, side, afterKey, slot, options) {
  const { first, routes = {} } = options;
  const group = new Set(nodeKeys);
  const model = merge.sides[side];
  const picks = {};
  for (const key of nodeKeys) {
    for (const unit of unitsForNode(merge, key)) {
      picks[unit.id] = side;
    }
    // The group's paths are routed afresh: a wire from an earlier placement
    // is undone, so a path this one leaves as it was can't keep it.
    // So is one the result has now, which may be from another version of
    // the element, even of another type, and one it has cut.
    const slots = [
      ...connectorSlots(model.nodes.get(key)),
      ...leaving(model, key).map((edge) => edge.slot),
      ...connectorSlots(resolved.model.nodes.get(key)),
      ...leaving(resolved.model, key).map((edge) => edge.slot)
    ];
    for (const item of slots) {
      picks[wireId(key, item)] = null;
    }
  }
  const into = (key, from) =>
    arriving(model, key).some(
      (edge) => from(edge.source) && edge.source !== key
    );
  // What nothing else in the group leads to; in a group that goes round,
  // what the rest of its side led into, or else its Loops.
  let entries = nodeKeys.filter((key) => !into(key, (at) => group.has(at)));
  if (!entries.length) {
    entries = nodeKeys.filter((key) => into(key, (at) => !group.has(at)));
  }
  if (!entries.length) {
    entries = nodeKeys.filter((key) => model.nodes.get(key).type === "loops");
  }
  if (!entries.length) {
    entries = [...nodeKeys];
  }
  const entry =
    (nodeKeys.includes(first) && first) || entries[0] || nodeKeys[0];
  const before = resolved.model.edges.get(`${afterKey}.${slot}`);
  const next = before && !group.has(before.target) ? before.target : undefined;
  picks[wireId(afterKey, slot)] = entry;
  const kept = (key) => group.has(key) || resolved.model.nodes.has(key);
  // Where the group went on to on its side, following main paths from the
  // entry. Left there, it could loop back or skip what the connector led to.
  let exit;
  for (let key = entry, seen = new Set(); key && !seen.has(key);) {
    seen.add(key);
    const main = model.edges.get(`${key}.${wayOn(model.nodes.get(key))}`);
    if (main && !group.has(main.target)) exit = main.target;
    key = main && group.has(main.target) ? main.target : undefined;
  }
  // The group's elements reached other than by a fault path.
  const onPath = new Set();
  for (const stack = [entry, ...entries]; stack.length;) {
    const key = stack.pop();
    if (group.has(key) && !onPath.has(key)) {
      onPath.add(key);
      for (const edge of leaving(model, key)) {
        if (edge.kind !== "fault") {
          stack.push(edge.target);
        }
      }
    }
  }
  const onward = next || "";
  const ways = [
    { value: onward, label: next ? "Go on to the same place" : "End" }
  ];
  if (next) {
    ways.push({ value: "", label: "End" });
  }
  const exits = [];
  let open = 0;
  const route = (exitInfo) => {
    const chosen = routes[exitInfo.id];
    const decided =
      !exitInfo.choice ||
      exitInfo.options.some((option) => option.value === chosen);
    if (!decided) {
      open++;
    }
    const value = exitInfo.choice && decided ? chosen : exitInfo.value;
    exits.push({ ...exitInfo, value, decided });
    if (!exitInfo.keep) {
      picks[exitInfo.id] = value;
    }
  };
  for (const key of nodeKeys) {
    const out = leaving(model, key);
    for (const edge of out) {
      if (group.has(edge.target)) continue;
      const base = {
        id: wireId(key, edge.slot),
        from: key,
        slot: edge.slot,
        kind: edge.kind,
        target: edge.target
      };
      if (edge.kind === "fault") {
        // A fault path keeps its handler if the result has it; without it,
        // going on as if nothing failed is a choice, never a default.
        if (resolved.model.nodes.has(edge.target)) {
          route({ ...base, value: edge.target, keep: true, options: [] });
        } else {
          route({
            ...base,
            value: "",
            choice: Boolean(next),
            options: next
              ? [
                  { value: "", label: "Leave it unhandled" },
                  { value: next, label: "Go on to the same place" }
                ]
              : []
          });
        }
      } else if (edge.target === exit) {
        // The group's way out goes on to where the connector led; if what
        // it led to on its side is in the result too, that's a choice.
        const also = kept(edge.target) && edge.target !== onward;
        route({
          ...base,
          value: onward,
          choice: also,
          options: also
            ? [ways[0], { value: edge.target, label: "Go where it did" }]
            : []
        });
      } else if (kept(edge.target)) {
        route({ ...base, value: edge.target, keep: true, options: [] });
      } else {
        // A branch to something not brought in: rejoining the path or
        // ending there both make sense.
        route({ ...base, value: onward, choice: Boolean(next), options: ways });
      }
    }
    const node = model.nodes.get(key);
    const main = wayOn(node);
    // Its own paths, not counting the fault path or a Loop's round.
    const slots = connectorSlots(node).filter(
      (item) =>
        item !== "faultConnector" &&
        !(node.type === "loops" && item === "nextValueConnector")
    );
    const plain = !out.some((edge) => edge.kind !== "fault");
    for (const item of next ? slots : []) {
      if (model.edges.has(`${key}.${item}`)) continue;
      const base = {
        id: wireId(key, item),
        from: key,
        slot: item,
        kind: "next",
        target: undefined
      };
      const ended = [
        { value: "", label: "End, as it did" },
        { value: next, label: "Go on to the same place" }
      ];
      if (
        slots.length === 1 &&
        item === main &&
        (plain || node.type === "loops")
      ) {
        // Where a fault path ended, going on after the error is a choice.
        const handler = !onPath.has(key);
        route({
          ...base,
          value: handler ? "" : next,
          choice: handler,
          options: handler ? ended : []
        });
      } else if (slots.length > 1) {
        // An outcome that ended on its side: ending here, and skipping what
        // the connector led to, or going on, is someone's call.
        route({ ...base, value: "", choice: true, options: ended });
      }
    }
  }
  if (entries.length > 1 && !nodeKeys.includes(first)) {
    open++;
  }
  return { entry, entries, next, exits, open, picks };
}

/**
 * Changed elements that belong together: elements the versions differ on
 * (not just by position), grouped where a connector in any version joins
 * them, largest first. Each group is { keys, added, removed, changed }
 * with keys in canvas order and counts against where the merge starts
 * (before, or the base).
 */
export function changeGroups(merge) {
  const changed = new Set();
  for (const unit of changedUnits(merge)) {
    if (unit.nodeKey && unit.nodeKey !== START && unit.kind !== "pos") {
      changed.add(unit.nodeKey);
    }
  }
  const parent = new Map([...changed].map((key) => [key, key]));
  const find = (key) => {
    while (parent.get(key) !== key) {
      parent.set(key, parent.get(parent.get(key)));
      key = parent.get(key);
    }
    return key;
  };
  for (const name of merge.names) {
    for (const edge of merge.sides[name].edges.values()) {
      if (changed.has(edge.source) && changed.has(edge.target)) {
        parent.set(find(edge.source), find(edge.target));
      }
    }
  }
  const groups = new Map();
  for (const key of merge.nodeKeys) {
    if (changed.has(key)) {
      const root = find(key);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root).push(key);
    }
  }
  const start = merge.mode === THREE_WAY ? "base" : "before";
  return [...groups.values()]
    .filter((keys) => keys.length > 1)
    .map((keys) => {
      const counts = { added: 0, removed: 0, changed: 0 };
      for (const key of keys) {
        const has = (name) => merge.sides[name].nodes.has(key);
        if (!has(start)) {
          counts.added++;
        } else if (merge.names.some((name) => !has(name))) {
          counts.removed++;
        } else {
          counts.changed++;
        }
      }
      return { keys, ...counts };
    })
    .sort((a, b) => b.keys.length - a.keys.length);
}
