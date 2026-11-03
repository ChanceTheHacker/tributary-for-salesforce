/**
 * Where each element sits on the canvas and how connectors are drawn.
 *
 * Free-form flows keep the positions stored in their metadata (locationX and
 * locationY: the top-left corner of the element's icon). Auto-layout flows,
 * and flows with no usable positions, are laid out here in layers: the start
 * element at the top, each element below everything that leads into it,
 * elements ordered within a layer to keep connectors from crossing, and
 * branches centred under the element they leave from.
 *
 * Diffs and merges lay out the union of their flows, so the same element sits
 * at the same place on every side.
 */
import { START } from "c/flowModel";

// Element geometry: an icon tile with up to two lines of label below it.
export const TILE = 48;
export const LABEL_GAP = 6;
export const LABEL_WIDTH = 140;
export const LABEL_LINE = 16;
export const NODE_WIDTH = LABEL_WIDTH + 16;
export const NODE_HEIGHT = TILE + LABEL_GAP + 2 * LABEL_LINE;

const ROW = NODE_HEIGHT + 72;
const DUMMY_WIDTH = 28;
const MARGIN = 40;
const EXIT_SPACING = 22;
const BACK_OFFSET = 56;
// Where along its first curve a connector's label goes, first choice first.
// Branches fan out further down, so a label that collides moves down.
const LABEL_ALONG = [0.4, 0.5, 0.6, 0.7, 0.3, 0.8, 0.2, 0.9];
const LABEL_ALONG_VIA = [0.5, 0.65, 0.8, 0.35, 0.2];

export const AUTO_LAYOUT = "AUTO_LAYOUT_CANVAS";

/** The id a node has on the canvas: its type and key, as in flowDiff entries. */
export function nodeId(node) {
  return `${node.type}:${node.key}`;
}

function hasPosition(node) {
  return typeof node.x === "number" && typeof node.y === "number";
}

/**
 * True when a flow is drawn with the layered layout: auto-layout flows, and
 * flows where no element has a position other than 0,0.
 */
export function usesAutoLayout(model) {
  if (model.canvasMode === AUTO_LAYOUT) {
    return true;
  }
  return ![...model.nodes.values()].some(
    (node) => !node.synthetic && hasPosition(node) && (node.x || node.y)
  );
}

/** Lays out one flow. */
export function layoutFlow(model) {
  return layoutFlows([model]);
}

/**
 * Lays out several flows on one set of positions: each node id gets a single
 * place. Free-form positions come from the last flow that has the element.
 */
export function layoutFlows(models) {
  const list = models.filter(Boolean);
  if (list.some(usesAutoLayout)) {
    return layered(list);
  }
  const nodes = new Map();
  for (const model of list) {
    for (const node of model.nodes.values()) {
      if (hasPosition(node)) {
        nodes.set(nodeId(node), { x: node.x, y: node.y });
      }
    }
  }
  if (list.length > 1) {
    separateFlows(list, nodes);
  }
  placeMissing(list, nodes);
  return { auto: false, nodes, via: new Map(), bounds: boundsOf(nodes) };
}

/**
 * Lays out the sides of a merge around its result. Auto-layout flows get the
 * sides' layout whatever is picked, so picks don't move elements. Free-form
 * elements the result has sit where it will save them; the others where
 * their side has them, moved clear of the result's.
 */
export function layoutAround(models, result) {
  const layout = layoutFlows(models);
  if (layout.auto || !result || usesAutoLayout(result)) {
    return layout;
  }
  const nodes = layoutFlows([result]).nodes;
  const placed = spotIndex([...nodes.values()]);
  for (const [id, position] of layout.nodes) {
    if (!nodes.has(id)) {
      const spot = placed.some(position)
        ? clearSpot(position, placed)
        : position;
      nodes.set(id, spot);
      placed.add(spot);
    }
  }
  return { auto: false, nodes, via: new Map(), bounds: boundsOf(nodes) };
}

/** True when two free-form positions put one element's icon over the other's. */
export function overlaps(a, b, width = TILE, height = TILE) {
  return Math.abs(a.x - b.x) < width && Math.abs(a.y - b.y) < height;
}

/**
 * Positions filed by the square of a grid they're in, so those near a spot
 * are found without looking at every one: some(position, width, height,
 * test) is placed.some((other) => overlaps(position, other, width, height)
 * && test(other)) over all of them.
 */
export function spotIndex(positions = []) {
  const cells = new Map();
  const cellOf = (value) => Math.floor(value / TILE);
  const index = {
    add(position) {
      const key = `${cellOf(position.x)},${cellOf(position.y)}`;
      const list = cells.get(key);
      if (list) {
        list.push(position);
      } else {
        cells.set(key, [position]);
      }
    },
    some(position, width = TILE, height = TILE, test) {
      const across = Math.ceil(width / TILE);
      const down = Math.ceil(height / TILE);
      const x = cellOf(position.x);
      const y = cellOf(position.y);
      for (let cx = x - across; cx <= x + across; cx++) {
        for (let cy = y - down; cy <= y + down; cy++) {
          for (const other of cells.get(`${cx},${cy}`) || []) {
            if (
              overlaps(position, other, width, height) &&
              (!test || test(other))
            ) {
              return true;
            }
          }
        }
      }
      return false;
    }
  };
  for (const position of positions) {
    index.add(position);
  }
  return index;
}

/**
 * The nearest place to a position, stepping an element at a time right,
 * down, left then up, where an element and its label clear all placed ones
 * (a list, or a spotIndex of them). It stays on the canvas's positive side,
 * or no further out than the position already is: stepping right always
 * gets clear in the end.
 */
export function clearSpot(position, placed) {
  const near = Array.isArray(placed) ? spotIndex(placed) : placed;
  const across = NODE_WIDTH + TILE / 2;
  const down = NODE_HEIGHT + TILE / 2;
  const left = Math.min(0, position.x);
  const top = Math.min(0, position.y);
  const clear = (place) =>
    place.x >= left &&
    place.y >= top &&
    !near.some(place, NODE_WIDTH, NODE_HEIGHT);
  for (let step = 1; ; step++) {
    const spot = [
      { x: position.x + step * across, y: position.y },
      { x: position.x, y: position.y + step * down },
      { x: position.x - step * across, y: position.y },
      { x: position.x, y: position.y - step * down }
    ].find(clear);
    if (spot) {
      return spot;
    }
  }
}

/**
 * Different elements of different flows can share a spot: an element
 * retyped between versions keeps its place, a new one takes a deleted one's,
 * and unrelated flows reuse coordinates. Drawn together, one would hide the
 * other, or its label, so where no flow has the two there together, the one the later
 * flows don't have there moves to the nearest clear place. One element in
 * several flows keeps one place, overlaps a flow drew itself are left
 * alone, and nothing saved changes.
 */
function separateFlows(models, nodes) {
  // The flows that have each element where it's drawn, and the last of them.
  const from = new Map();
  models.forEach((model, index) => {
    for (const node of model.nodes.values()) {
      const id = nodeId(node);
      const at = nodes.get(id);
      if (at && node.x === at.x && node.y === at.y) {
        if (from.has(id)) {
          from.get(id).push(index);
        } else {
          from.set(id, [index]);
        }
      }
    }
  });
  const last = (id) => from.get(id)[from.get(id).length - 1];
  const together = (a, b) =>
    from.get(a).some((index) => from.get(b).includes(index));
  const ids = [...nodes.keys()].sort((a, b) => last(b) - last(a));
  const placed = spotIndex();
  for (const id of ids) {
    let position = nodes.get(id);
    // Labels count: an icon clear of another can still sit under its label,
    // and a click there picks the wrong one.
    const hidden = (other) => !together(id, other.id);
    if (placed.some(position, NODE_WIDTH, NODE_HEIGHT, hidden)) {
      position = clearSpot(position, placed);
      nodes.set(id, position);
      // Moved, it's where no flow has it.
      from.set(id, []);
    }
    placed.add({ ...position, id });
  }
}

/**
 * Gives elements without a position one near an element that leads into them
 * (or, for a start element, above the element it leads to).
 */
function placeMissing(models, nodes) {
  const pending = [];
  for (const model of models) {
    for (const node of model.nodes.values()) {
      if (!nodes.has(nodeId(node))) {
        pending.push({ model, node });
      }
    }
  }
  const taken = new Set([...nodes.values()].map((p) => `${p.x},${p.y}`));
  const place = (id, x, y) => {
    let px = x;
    while (taken.has(`${px},${y}`)) {
      px += NODE_WIDTH;
    }
    taken.add(`${px},${y}`);
    nodes.set(id, { x: px, y });
  };
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      const { model, node } = pending[i];
      const id = nodeId(node);
      if (nodes.has(id)) {
        pending.splice(i--, 1);
        continue;
      }
      const anchor = anchorFor(model, node, nodes);
      if (anchor) {
        place(id, anchor.x, anchor.y);
        pending.splice(i--, 1);
        progress = true;
      }
    }
  }
  // Nothing placed leads to or from these: line them up below everything.
  const bounds = boundsOf(nodes);
  let x = bounds.minX;
  for (const { node } of pending) {
    if (!nodes.has(nodeId(node))) {
      place(nodeId(node), x, bounds.maxY + ROW);
      x += NODE_WIDTH;
    }
  }
}

function anchorFor(model, node, nodes) {
  const idOf = (key) => {
    const other = model.nodes.get(key);
    return other && nodeId(other);
  };
  for (const edge of model.edges.values()) {
    if (edge.target === node.key && nodes.has(idOf(edge.source))) {
      const from = nodes.get(idOf(edge.source));
      return { x: from.x, y: from.y + ROW };
    }
  }
  for (const edge of model.edges.values()) {
    if (edge.source === node.key && nodes.has(idOf(edge.target))) {
      const to = nodes.get(idOf(edge.target));
      return { x: to.x, y: to.y - ROW };
    }
  }
  return undefined;
}

export function boundsOf(positions) {
  const points = [...positions.values()];
  if (!points.length) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  const halfLabel = (NODE_WIDTH - TILE) / 2;
  return {
    minX: Math.min(...points.map((p) => p.x)) - halfLabel,
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)) + TILE + halfLabel,
    maxY: Math.max(...points.map((p) => p.y)) + NODE_HEIGHT
  };
}

/** The union of the flows' graphs, by node id. */
function unionGraph(models) {
  const order = [];
  const vertices = new Map();
  const edges = new Map();
  for (const model of models) {
    for (const node of model.nodes.values()) {
      const id = nodeId(node);
      if (!vertices.has(id)) {
        vertices.set(id, { id, start: node.key === START });
        order.push(id);
      }
    }
    // Edges in canvas order, so branches keep the order they're drawn in.
    for (const edge of model.edges.values()) {
      const source = model.nodes.get(edge.source);
      const target = model.nodes.get(edge.target);
      if (!source || !target) {
        continue;
      }
      const key = `${nodeId(source)}>${nodeId(target)}`;
      const existing = edges.get(key);
      edges.set(key, {
        source: nodeId(source),
        target: nodeId(target),
        // A Go To in any version doesn't constrain the layers.
        goTo: edge.isGoTo || (existing ? existing.goTo : false),
        kind: existing ? existing.kind : edge.kind
      });
    }
  }
  // A loop's "after last item" path goes below the loop's body: every body
  // element that returns to the loop leads (invisibly) to it.
  const byKind = [...edges.values()];
  for (const exit of byKind.filter((e) => e.kind === "loopEnd")) {
    for (const back of byKind) {
      if (back.target === exit.source && back.source !== exit.source) {
        const key = `${back.source}>${exit.target}`;
        if (!edges.has(key) && back.source !== exit.target) {
          edges.set(key, {
            source: back.source,
            target: exit.target,
            kind: "layout",
            hidden: true
          });
        }
      }
    }
  }
  return { order, vertices, edges: [...edges.values()] };
}

/** Edges that close a cycle, found by depth-first search from the start. */
function backEdges(order, vertices, edges) {
  const out = new Map(order.map((id) => [id, []]));
  for (const edge of edges) {
    if (!edge.goTo) {
      out.get(edge.source).push(edge);
    }
  }
  const state = new Map();
  const back = new Set();
  const discovered = [];
  const visit = (root) => {
    const stack = [{ id: root, next: 0 }];
    state.set(root, 1);
    discovered.push(root);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const list = out.get(frame.id);
      if (frame.next >= list.length) {
        state.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const edge = list[frame.next++];
      const seen = state.get(edge.target);
      if (seen === 1) {
        back.add(edge);
      } else if (!seen) {
        state.set(edge.target, 1);
        discovered.push(edge.target);
        stack.push({ id: edge.target, next: 0 });
      }
    }
  };
  const roots = [
    ...order.filter((id) => vertices.get(id).start),
    // Then elements nothing leads into, then anything left (cycles).
    ...order.filter(
      (id) => !edges.some((e) => e.target === id && !e.goTo && e.source !== id)
    ),
    ...order
  ];
  for (const id of roots) {
    if (!state.has(id)) {
      visit(id);
    }
  }
  return { back, discovered };
}

/** The layered layout. */
function layered(models) {
  const { order, vertices, edges } = unionGraph(models);
  const { back, discovered } = backEdges(order, vertices, edges);
  const forward = edges.filter(
    (e) => !e.goTo && !back.has(e) && e.source !== e.target
  );

  // Longest path from the roots gives each element its layer.
  const layer = new Map(order.map((id) => [id, 0]));
  const incoming = new Map(order.map((id) => [id, []]));
  for (const edge of forward) {
    incoming.get(edge.target).push(edge);
  }
  const done = new Set();
  const layerOf = (root) => {
    const stack = [root];
    while (stack.length) {
      const id = stack[stack.length - 1];
      if (done.has(id)) {
        stack.pop();
        continue;
      }
      const pending = incoming.get(id).filter((edge) => !done.has(edge.source));
      if (pending.length) {
        stack.push(...pending.map((edge) => edge.source));
        continue;
      }
      layer.set(
        id,
        Math.max(0, ...incoming.get(id).map((e) => layer.get(e.source) + 1))
      );
      done.add(id);
      stack.pop();
    }
  };
  for (const id of order) {
    layerOf(id);
  }

  // Split connectors that span several layers into chains of dummy points so
  // they take part in ordering and route around elements.
  const rank = new Map(discovered.map((id, index) => [id, index]));
  const verts = new Map(
    order.map((id) => [
      id,
      { id, layer: layer.get(id), rank: rank.get(id), width: NODE_WIDTH }
    ])
  );
  const links = [];
  const chains = new Map();
  for (const edge of forward) {
    const from = layer.get(edge.source);
    const to = layer.get(edge.target);
    let previous = edge.source;
    const chain = [];
    for (let l = from + 1; l < to; l++) {
      const id = `~${edge.source}>${edge.target}#${l}`;
      verts.set(id, {
        id,
        layer: l,
        rank: rank.get(edge.source) + (l - from) / (to - from + 1),
        width: DUMMY_WIDTH,
        dummy: true
      });
      links.push({ source: previous, target: id });
      chain.push(id);
      previous = id;
    }
    links.push({ source: previous, target: edge.target });
    if (!edge.hidden) {
      chains.set(`${edge.source}>${edge.target}`, chain);
    }
  }

  const layers = [];
  for (const vert of verts.values()) {
    (layers[vert.layer] = layers[vert.layer] || []).push(vert.id);
  }
  for (let l = 0; l < layers.length; l++) {
    layers[l] = (layers[l] || []).sort(
      (a, b) => verts.get(a).rank - verts.get(b).rank
    );
  }
  const up = new Map([...verts.keys()].map((id) => [id, []]));
  const down = new Map([...verts.keys()].map((id) => [id, []]));
  for (const link of links) {
    down.get(link.source).push(link.target);
    up.get(link.target).push(link.source);
  }

  orderLayers(layers, up, down);
  const x = placeColumns(layers, verts, up, down);

  const nodes = new Map();
  const minX = Math.min(...order.map((id) => x.get(id) - NODE_WIDTH / 2));
  const shift = MARGIN - (Number.isFinite(minX) ? minX : 0);
  for (const id of order) {
    nodes.set(id, {
      x: Math.round(x.get(id) + shift - TILE / 2),
      y: MARGIN + layer.get(id) * ROW
    });
  }
  const via = new Map();
  for (const [key, chain] of chains) {
    via.set(
      key,
      chain.map((id) => ({
        x: Math.round(x.get(id) + shift),
        y: MARGIN + verts.get(id).layer * ROW + NODE_HEIGHT / 2
      }))
    );
  }
  return { auto: true, nodes, via, bounds: boundsOf(nodes) };
}

/**
 * How many connectors between two layers cross: pairs whose ends are in
 * opposite orders on the two layers. Pairs sharing an end don't cross.
 * Counted as inversions of the lower ends, taken in upper order, with a
 * Fenwick tree: k log k rather than every pair.
 */
export function crossings(upper, lower, down) {
  const position = new Map(lower.map((id, index) => [id, index]));
  const ends = [];
  for (const id of upper) {
    const own = [];
    for (const target of down.get(id)) {
      if (position.has(target)) {
        own.push(position.get(target));
      }
    }
    // Ascending, so connectors from one element never count each other.
    own.sort((a, b) => a - b);
    ends.push(...own);
  }
  const tree = new Int32Array(lower.length + 1);
  let count = 0;
  ends.forEach((end, seen) => {
    // Earlier ends further along the lower layer are crossings.
    let atMost = 0;
    for (let i = end + 1; i > 0; i -= i & -i) {
      atMost += tree[i];
    }
    count += seen - atMost;
    for (let i = end + 1; i <= lower.length; i += i & -i) {
      tree[i]++;
    }
  });
  return count;
}

function totalCrossings(layers, down) {
  let total = 0;
  for (let l = 0; l + 1 < layers.length; l++) {
    total += crossings(layers[l], layers[l + 1], down);
  }
  return total;
}

/** Barycentre sweeps to reduce crossings; keeps the best order seen. */
function orderLayers(layers, up, down) {
  let best = layers.map((list) => [...list]);
  let bestCount = totalCrossings(layers, down);
  const sweep = (l, neighbours, reference) => {
    const position = new Map(reference.map((id, index) => [id, index]));
    const current = layers[l];
    const key = new Map(
      current.map((id, index) => {
        const linked = neighbours
          .get(id)
          .filter((other) => position.has(other));
        return [
          id,
          linked.length
            ? linked.reduce((sum, other) => sum + position.get(other), 0) /
              linked.length
            : index * (reference.length / Math.max(1, current.length))
        ];
      })
    );
    const index = new Map(current.map((id, i) => [id, i]));
    current.sort(
      (a, b) => key.get(a) - key.get(b) || index.get(a) - index.get(b)
    );
  };
  for (let round = 0; round < 8 && bestCount > 0; round++) {
    if (round % 2 === 0) {
      for (let l = 1; l < layers.length; l++) {
        sweep(l, up, layers[l - 1]);
      }
    } else {
      for (let l = layers.length - 2; l >= 0; l--) {
        sweep(l, down, layers[l + 1]);
      }
    }
    const count = totalCrossings(layers, down);
    if (count < bestCount) {
      bestCount = count;
      best = layers.map((list) => [...list]);
    }
  }
  best.forEach((list, l) => {
    layers[l] = list;
  });
}

/**
 * Horizontal centres: each pass pulls every vertex toward the average of its
 * neighbours in the layer above (or below), then the layer is spread out as
 * little as possible to keep the minimum gaps (isotonic regression).
 */
function placeColumns(layers, verts, up, down) {
  const x = new Map();
  for (const list of layers) {
    let cursor = 0;
    list.forEach((id, index) => {
      if (index > 0) {
        cursor += gap(verts.get(list[index - 1]), verts.get(id));
      }
      x.set(id, cursor);
    });
  }
  const weight = (a, b) =>
    verts.get(a).dummy && verts.get(b).dummy
      ? 8
      : verts.get(a).dummy || verts.get(b).dummy
        ? 2
        : 1;
  const pass = (list, neighbours) => {
    const desired = list.map((id) => {
      const linked = neighbours.get(id);
      if (!linked.length) {
        return { value: x.get(id), weight: 0.5 };
      }
      let sum = 0;
      let total = 0;
      for (const other of linked) {
        const w = weight(id, other);
        sum += x.get(other) * w;
        total += w;
      }
      return { value: sum / total, weight: total };
    });
    const placed = spread(
      desired,
      list.map((id, index) =>
        index ? gap(verts.get(list[index - 1]), verts.get(id)) : 0
      )
    );
    list.forEach((id, index) => x.set(id, placed[index]));
  };
  for (let round = 0; round < 12; round++) {
    if (round % 2 === 0) {
      for (let l = 1; l < layers.length; l++) {
        pass(layers[l], up);
      }
    } else {
      for (let l = layers.length - 2; l >= 0; l--) {
        pass(layers[l], down);
      }
    }
  }
  for (let l = 1; l < layers.length; l++) {
    pass(layers[l], up);
  }
  return x;
}

function gap(a, b) {
  return (a.width + b.width) / 2 + (a.dummy || b.dummy ? 12 : 24);
}

/**
 * Positions closest (weighted least squares) to the desired ones that keep
 * each consecutive pair at least gaps[i] apart, via pool-adjacent-violators.
 */
export function spread(desired, gaps) {
  const offsets = [];
  let total = 0;
  desired.forEach((_, index) => {
    total += index ? gaps[index] : 0;
    offsets.push(total);
  });
  const blocks = [];
  desired.forEach((item, index) => {
    const w = Math.max(item.weight, 1e-6);
    blocks.push({
      sum: (item.value - offsets[index]) * w,
      weight: w,
      count: 1
    });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.sum / prev.weight <= last.sum / last.weight) {
        break;
      }
      blocks.pop();
      prev.sum += last.sum;
      prev.weight += last.weight;
      prev.count += last.count;
    }
  });
  const out = [];
  for (const block of blocks) {
    const value = block.sum / block.weight;
    for (let i = 0; i < block.count; i++) {
      out.push(value + offsets[out.length]);
    }
  }
  return out;
}

/** Where connectors leave and enter an element placed at `p`. */
export function ports(p) {
  return {
    top: { x: p.x + TILE / 2, y: p.y },
    bottom: { x: p.x + TILE / 2, y: p.y + NODE_HEIGHT },
    right: { x: p.x + TILE, y: p.y + TILE / 2 },
    left: { x: p.x, y: p.y + TILE / 2 }
  };
}

function cubicPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
const pt = (p) => `${round1(p.x)} ${round1(p.y)}`;

/**
 * SVG path for a connector between elements placed at `from` and `to`.
 *
 * options: exitIndex and exitCount spread an element's paths along its
 * bottom edge; kind "fault" leaves from the right side; via is a list of
 * points from the layered layout to pass through. Returns { d, label, back,
 * labels } where label is the point to draw the connector's label at, and
 * labels are further points along the connector it can move to when another
 * label is in the way.
 */
export function routeEdge(from, to, options = {}) {
  const { exitIndex = 0, exitCount = 1, kind, via = [] } = options;
  const source = ports(from);
  const target = ports(to);
  let start;
  if (kind === "fault") {
    start = source.right;
  } else {
    const span = Math.min(EXIT_SPACING * (exitCount - 1), LABEL_WIDTH - 20);
    const offset =
      exitCount > 1 ? -span / 2 + (span * exitIndex) / (exitCount - 1) : 0;
    start = { x: source.bottom.x + offset, y: source.bottom.y };
  }
  const end = target.top;

  if (from === to || (end.y < start.y + 16 && !via.length)) {
    return backRoute(start, from, to, kind);
  }

  const points = [start, ...via, end];
  const segments = [];
  let labels;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const first = i === 0 && kind === "fault";
    const bend = Math.max(24, Math.abs(b.y - a.y) / 2);
    const c1 = first ? { x: a.x + bend, y: a.y } : { x: a.x, y: a.y + bend };
    const c2 = { x: b.x, y: b.y - bend };
    segments.push(`C ${pt(c1)} ${pt(c2)} ${pt(b)}`);
    if (i === 0) {
      const along = points.length > 2 ? LABEL_ALONG_VIA : LABEL_ALONG;
      labels = along.map((t) => {
        const p = cubicPoint(a, c1, c2, b, t);
        return { x: round1(p.x), y: round1(p.y) };
      });
    }
  }
  return {
    d: `M ${pt(start)} ${segments.join(" ")}`,
    label: labels[0],
    labels,
    back: false
  };
}

// A connector to an element above (or to itself) goes down, out to the
// right of both elements, up, and into the target's right side.
function backRoute(start, from, to, kind) {
  const end = ports(to).right;
  const side =
    Math.max(start.x, end.x, from.x + NODE_WIDTH / 2 + TILE / 2) + BACK_OFFSET;
  const r = 12;
  const drop = kind === "fault" ? 0 : 24;
  const turnY = start.y + drop;
  const path = [
    `M ${pt(start)}`,
    drop
      ? `C ${pt({ x: start.x, y: turnY })} ${pt({ x: start.x, y: turnY })} ${pt({ x: start.x + r, y: turnY })}`
      : "",
    `L ${pt({ x: side - r, y: turnY })}`,
    `Q ${pt({ x: side, y: turnY })} ${pt({ x: side, y: turnY - r })}`,
    `L ${pt({ x: side, y: end.y + r })}`,
    `Q ${pt({ x: side, y: end.y })} ${pt({ x: side - r, y: end.y })}`,
    `L ${pt(end)}`
  ]
    .filter(Boolean)
    .join(" ");
  const labels = [0.5, 0.65, 0.8, 0.35, 0.2].map((along) => ({
    x: round1(side),
    y: round1(turnY + (end.y - turnY) * along)
  }));
  return { d: path, label: labels[0], labels, back: true };
}
