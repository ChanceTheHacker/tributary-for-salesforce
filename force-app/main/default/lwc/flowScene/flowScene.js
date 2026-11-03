/**
 * Turns flows, diffs and merges into what the canvas draws: placed elements
 * and routed connectors, each with a status that decides its colour.
 *
 *   flowScene(model)                      one flow, nothing highlighted
 *   diffScene(diff, "before" | "after")   one side of a diff, marked with what
 *                                         changed on that side
 *   diffScene(diff, "unified")            both sides on one canvas: removed
 *                                         parts in red, added in green
 *   mergeScene(merge, resolved)           a merge result against the side it
 *                                         started from, with conflicts,
 *                                         problems and left-out elements
 *
 * Views of one diff share a layout (pass it in, or let diffLayout make it),
 * so an element sits at the same place in every view.
 */
import { START } from "c/flowModel";
import { visibleText } from "c/flowUtils";
import {
  diffFlows,
  ADDED,
  REMOVED,
  CHANGED,
  UNCHANGED,
  RETARGETED
} from "c/flowDiff";
import { SAME, ERROR, unitsForNode } from "c/flowMerge";
import {
  layoutAround,
  layoutFlows,
  routeEdge,
  nodeId,
  TILE,
  NODE_WIDTH,
  NODE_HEIGHT
} from "c/flowLayout";
import {
  elementInfo,
  connectorLabel,
  startSummary,
  flowTypeLabel
} from "c/flowElements";

export const BEFORE = "before";
export const AFTER = "after";
export const UNIFIED = "unified";
/** An element one of the merged flows has that the result leaves out. */
export const EXCLUDED = "excluded";

const PADDING = 60;
const ARROW = 6;

/** One layout for every view of a diff. */
export function diffLayout(diff) {
  return layoutFlows([diff.before, diff.after]);
}

function nodeEntry(model, node, status, extra = {}) {
  const info = elementInfo(node);
  const isStart = node.key === START;
  return {
    id: nodeId(node),
    key: node.key,
    type: node.type,
    label: isStart ? "Start" : node.label || node.key,
    apiName: isStart ? "" : node.key,
    typeLabel: isStart
      ? startSummary(model) || flowTypeLabel(model)
      : info.label,
    icon: info.icon,
    status,
    moved: false,
    ...extra
  };
}

function edgeEntry(model, edge, status) {
  const source = model.nodes.get(edge.source);
  const target = model.nodes.get(edge.target);
  if (!source || !target) {
    return undefined;
  }
  return {
    key: edge.key,
    sourceId: nodeId(source),
    targetId: nodeId(target),
    kind: edge.kind,
    label: connectorLabel(edge),
    isGoTo: edge.isGoTo,
    status
  };
}

// The triangle at a connector's end: pointing down into the top of an
// element, or left into its right side for connectors that loop back up.
function arrowAt(route, to) {
  if (route.back) {
    const x = to.x + TILE;
    const y = to.y + TILE / 2;
    return `${x},${y} ${x + ARROW * 1.6},${y - ARROW} ${x + ARROW * 1.6},${y + ARROW}`;
  }
  const x = to.x + TILE / 2;
  const y = to.y;
  return `${x},${y} ${x - ARROW},${y - ARROW * 1.6} ${x + ARROW},${y - ARROW * 1.6}`;
}

/**
 * Places nodes and routes edges. Edges leaving one element are spread along
 * its bottom in the order given; fault paths leave from the right side.
 */
export function placeScene(layout, nodes, edges) {
  const placed = [];
  const byId = new Map();
  for (const node of nodes) {
    const position = layout.nodes.get(node.id);
    if (!position) {
      continue;
    }
    const entry = { ...node, x: position.x, y: position.y };
    placed.push(entry);
    byId.set(node.id, entry);
  }

  const exits = new Map();
  for (const edge of edges) {
    if (edge && edge.kind !== "fault" && byId.has(edge.sourceId)) {
      const list = exits.get(edge.sourceId) || [];
      // A connector drawn twice (old and new target) leaves from one point.
      if (!list.includes(edge.key)) {
        list.push(edge.key);
      }
      exits.set(edge.sourceId, list);
    }
  }

  const routed = [];
  for (const edge of edges) {
    if (!edge) {
      continue;
    }
    const from = byId.get(edge.sourceId);
    const to = byId.get(edge.targetId);
    if (!from || !to) {
      continue;
    }
    const list = exits.get(edge.sourceId) || [];
    const route = routeEdge(from, to, {
      kind: edge.kind,
      exitIndex: Math.max(0, list.indexOf(edge.key)),
      exitCount: Math.max(1, list.length),
      via: edge.isGoTo
        ? []
        : layout.via.get(`${edge.sourceId}>${edge.targetId}`) || []
    });
    routed.push({
      ...edge,
      // The source's type is part of the id: an element retyped between
      // the flows has its old and new connectors drawn side by side.
      id: `${edge.sourceId}>${edge.key}>${edge.targetId}`,
      d: route.d,
      arrow: arrowAt(route, to),
      labelX: route.label.x,
      labelY: route.label.y,
      labels: route.labels,
      back: route.back
    });
  }
  spreadLabels(routed, placed);
  for (const edge of routed) {
    delete edge.labels;
  }

  return { nodes: placed, edges: routed, bounds: boundsFor(placed, routed) };
}

// Connector labels as the canvas draws them: 11px text in a pill with 8px of
// padding a side, cut off at 140px.
const PILL_HEIGHT = 22;
const PILL_MAX = 140;
const CHAR_WIDTH = 6.2;
const PILL_GAP = 4;

function pillBox(text, point) {
  const width =
    Math.min(PILL_MAX, 18 + CHAR_WIDTH * visibleText(text).length) + PILL_GAP;
  const height = PILL_HEIGHT + PILL_GAP;
  return {
    left: point.x - width / 2,
    right: point.x + width / 2,
    top: point.y - height / 2,
    bottom: point.y + height / 2
  };
}

function overlap(a, b) {
  const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return x > 0 && y > 0 ? x * y : 0;
}

/**
 * Moves connector labels along their connectors until none covers another
 * label or an element. Labels on the straightest connectors are placed first
 * and keep their spot; branches that fan out sideways move down, where they
 * are further apart. When every spot is taken, the least covered one wins.
 */
function spreadLabels(edges, nodes) {
  const taken = boxGrid();
  for (const node of nodes) {
    taken.add({
      left: node.x - (NODE_WIDTH - TILE) / 2,
      right: node.x + TILE + (NODE_WIDTH - TILE) / 2,
      top: node.y,
      bottom: node.y + NODE_HEIGHT + (node.pickLabel ? 16 : 0)
    });
  }
  const slant = (edge) => {
    const xs = edge.labels.map((point) => point.x);
    return Math.max(...xs) - Math.min(...xs);
  };
  const labelled = edges
    .filter((edge) => edge.label && edge.labels)
    .sort((a, b) => slant(a) - slant(b));
  for (const edge of labelled) {
    let best;
    for (const point of edge.labels) {
      const box = pillBox(edge.label, point);
      const covered = taken.covered(box);
      if (!best || covered < best.covered) {
        best = { point, box, covered };
      }
      if (!covered) {
        break;
      }
    }
    edge.labelX = best.point.x;
    edge.labelY = best.point.y;
    taken.add(best.box);
  }
}

// Boxes filed by the squares of a grid they touch, so what covers a spot is
// found among those near it rather than all of them: placing labels on a
// flow of hundreds of elements is otherwise the slowest part of drawing it.
const CELL = 240;

function boxGrid() {
  const cells = new Map();
  let count = 0;
  const each = (box, visit) => {
    const right = Math.floor(box.right / CELL);
    const bottom = Math.floor(box.bottom / CELL);
    for (let x = Math.floor(box.left / CELL); x <= right; x++) {
      for (let y = Math.floor(box.top / CELL); y <= bottom; y++) {
        visit(`${x},${y}`);
      }
    }
  };
  return {
    add(box) {
      const entry = { box, order: count++ };
      each(box, (key) => {
        const list = cells.get(key);
        if (list) {
          list.push(entry);
        } else {
          cells.set(key, [entry]);
        }
      });
    },
    // How much of a box the others cover, added up in the order they were
    // filed, as a plain sum over all of them would.
    covered(box) {
      const near = new Set();
      each(box, (key) => {
        for (const entry of cells.get(key) || []) {
          near.add(entry);
        }
      });
      return [...near]
        .sort((a, b) => a.order - b.order)
        .reduce((sum, entry) => sum + overlap(box, entry.box), 0);
    }
  };
}

function boundsFor(nodes, edges) {
  if (!nodes.length) {
    return { x: 0, y: 0, width: 400, height: 300 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x - (NODE_WIDTH - TILE) / 2);
    maxX = Math.max(maxX, node.x + TILE + (NODE_WIDTH - TILE) / 2);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y + NODE_HEIGHT + (node.pickLabel ? 16 : 0));
  }
  // Connectors that loop back run out to the right of the elements.
  for (const edge of edges) {
    if (edge.back) {
      maxX = Math.max(maxX, edge.labelX + 20);
    }
    if (edge.label) {
      const box = pillBox(edge.label, { x: edge.labelX, y: edge.labelY });
      minX = Math.min(minX, box.left);
      minY = Math.min(minY, box.top);
      maxX = Math.max(maxX, box.right);
      maxY = Math.max(maxY, box.bottom);
    }
  }
  return {
    x: minX - PADDING,
    y: minY - PADDING,
    width: maxX - minX + 2 * PADDING,
    height: maxY - minY + 2 * PADDING
  };
}

/** One flow on its own. */
export function flowScene(model, layout = layoutFlows([model])) {
  const nodes = [...model.nodes.values()].map((node) =>
    nodeEntry(model, node, UNCHANGED)
  );
  const edges = [...model.edges.values()].map((edge) =>
    edgeEntry(model, edge, UNCHANGED)
  );
  return placeScene(layout, nodes, edges);
}

// Edge statuses as seen from one side of a diff. A retargeted connector is
// removed on the before side (its old target) and added on the after side.
function edgeStatusOn(side, status) {
  if (status === RETARGETED) {
    return side === BEFORE ? REMOVED : ADDED;
  }
  return status;
}

/**
 * One view of a diff. options.showMoved marks elements that only moved;
 * options.markers maps node ids to extra fields (issues, conflicts, picks)
 * copied onto the scene nodes.
 */
export function diffScene(diff, view, options = {}) {
  const layout = options.layout || diffLayout(diff);
  const { nodes, edges } = diffParts(diff, view, options);
  return placeScene(layout, nodes, edges);
}

function diffParts(diff, view, options) {
  const showMoved = options.showMoved !== false;
  const markers = options.markers || new Map();
  const nodes = [];
  for (const entry of diff.nodes) {
    const onBefore = entry.before && view !== AFTER;
    const onAfter = entry.after && view !== BEFORE;
    if (!onBefore && !onAfter) {
      continue;
    }
    const node = view === BEFORE ? entry.before : entry.after || entry.before;
    const model = node === entry.before ? diff.before : diff.after;
    const status = entry.status;
    if (status === ADDED && view === BEFORE) {
      continue;
    }
    if (status === REMOVED && view === AFTER) {
      continue;
    }
    nodes.push(
      nodeEntry(model, node, status, {
        moved: showMoved && Boolean(entry.moved),
        changeCount: entry.changes ? entry.changes.length : 0,
        ...(markers.get(entry.id) || {})
      })
    );
  }

  const edges = [];
  for (const entry of diff.edges) {
    if (view === UNIFIED) {
      if (entry.status === RETARGETED) {
        edges.push(edgeEntry(diff.before, entry.before, REMOVED));
        edges.push(edgeEntry(diff.after, entry.after, ADDED));
      } else if (entry.after) {
        edges.push(edgeEntry(diff.after, entry.after, entry.status));
      } else {
        edges.push(edgeEntry(diff.before, entry.before, REMOVED));
      }
      continue;
    }
    const edge = view === BEFORE ? entry.before : entry.after;
    if (!edge) {
      continue;
    }
    edges.push(
      edgeEntry(
        view === BEFORE ? diff.before : diff.after,
        edge,
        edgeStatusOn(view, entry.status)
      )
    );
  }
  return { nodes, edges };
}

/**
 * One layout for every side of a merge, drawn around the result when given
 * one: see layoutAround.
 */
export function mergeLayout(merge, resolved) {
  return layoutAround(
    merge.names.map((name) => merge.sides[name]),
    resolved && resolved.model
  );
}

// The side an element's parts were taken from: a side name, "mixed", or
// undefined when every side agrees.
function pickedSide(merge, resolved, nodeKey) {
  const sides = new Set();
  for (const unit of unitsForNode(merge, nodeKey)) {
    if (unit.status !== SAME) {
      sides.add(resolved.choices[unit.id]);
    }
  }
  if (sides.size > 1) {
    return "mixed";
  }
  return sides.values().next().value;
}

/**
 * The merge result drawn against the side it started from (before, or ours
 * in a three-way merge). Elements that only other sides have are drawn faded
 * so they can be picked. options.sideLabels names each side for its badge.
 *
 * Returns { scene, diff }; diff compares the starting side with the result.
 */
export function mergeScene(merge, resolved, options = {}) {
  const layout = options.layout || mergeLayout(merge, resolved);
  const labels = options.sideLabels || {};
  const primary = merge.sides[merge.primary];
  const diff = diffFlows(primary, resolved.model);
  const conflicted = new Set(
    resolved.conflicts.map((id) => merge.units.get(id).nodeKey)
  );
  const problems = new Map();
  for (const issue of resolved.issues) {
    if (issue.nodeKey) {
      const entry = problems.get(issue.nodeKey) || { errors: 0, warnings: 0 };
      entry[issue.severity === ERROR ? "errors" : "warnings"] += 1;
      problems.set(issue.nodeKey, entry);
    }
  }
  const markers = new Map();
  for (const entry of diff.nodes) {
    const side = pickedSide(merge, resolved, entry.key);
    const problem = problems.get(entry.key) || { errors: 0, warnings: 0 };
    markers.set(entry.id, {
      conflict: conflicted.has(entry.key),
      errors: problem.errors,
      warnings: problem.warnings,
      picked: side,
      pickLabel:
        side === "mixed" ? "Mixed" : side ? labels[side] || side : undefined
    });
  }
  const { nodes, edges } = diffParts(diff, UNIFIED, {
    ...options,
    markers
  });

  const shown = new Set(nodes.map((node) => node.id));
  for (const name of merge.names) {
    const model = merge.sides[name];
    for (const node of model.nodes.values()) {
      const id = nodeId(node);
      if (shown.has(id)) {
        continue;
      }
      shown.add(id);
      nodes.push(
        nodeEntry(model, node, EXCLUDED, {
          conflict: conflicted.has(node.key),
          availableFrom: name,
          pickLabel: labels[name] || name
        })
      );
    }
  }
  return { scene: placeScene(layout, nodes, edges), diff };
}

/** Counts for a diff's summary bar. */
export function diffCounts(diff) {
  const count = (entries, status) =>
    entries.filter((entry) => entry.status === status).length;
  const changedEdges = diff.edges.filter(
    (entry) => entry.status !== UNCHANGED
  ).length;
  return {
    added: count(diff.nodes, ADDED),
    removed: count(diff.nodes, REMOVED),
    changed: count(diff.nodes, CHANGED),
    moved: diff.nodes.filter((entry) => entry.moved).length,
    connectors: changedEdges,
    resources: diff.resources.filter((entry) => entry.status !== UNCHANGED)
      .length,
    properties: diff.props.length
  };
}
