/**
 * Compares two flows: two versions of one flow, or two unrelated flows.
 *
 * Elements and resources are matched by API name and type, connectors by the
 * element and slot they leave from (a decision outcome, a loop's "for each"
 * path, a fault path...). Each entry carries both sides so the canvas can draw
 * the old and new state, plus a field-level change list for the property panel.
 *
 * Change paths are arrays of segments. Lists whose items all have a unique
 * `name` (or `pathName` or `field`) use that as the segment; other lists use the item's
 * index, in the after flow for added or changed items and in the before flow
 * for removed ones.
 */
import { buildModel, isModel, isPlainObject, ITEM_KEYS } from "c/flowModel";
import { matchLines } from "c/lineDiff";

export const ADDED = "added";
export const REMOVED = "removed";
export const CHANGED = "changed";
export const UNCHANGED = "unchanged";
// A connector whose slot exists on both sides but points somewhere else.
export const RETARGETED = "retargeted";
// A keyed list whose items are the same but in a different order.
export const REORDERED = "reordered";

// Values reaching here are normalized (sorted keys), so JSON equality is value equality.
function same(a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function listKey(items) {
  return ITEM_KEYS.find((key) => {
    const seen = new Set();
    return items.every((item) => {
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
  });
}

// Past this many cells, the table for the part of two lists that differs
// costs too much to fill; the line diff's bounded search aligns it instead.
const MAX_TABLE = 250000;

/** Index pairs of the longest common subsequence of two lists. */
function commonSubsequence(a, b) {
  const as = a.map((item) => JSON.stringify(item));
  const bs = b.map((item) => JSON.stringify(item));
  // Equal items at either end pair off without a table, so a small edit to
  // a long list costs a scan, not a square.
  const pairs = [];
  let start = 0;
  while (start < as.length && start < bs.length && as[start] === bs[start]) {
    pairs.push([start, start]);
    start++;
  }
  let aEnd = as.length;
  let bEnd = bs.length;
  while (aEnd > start && bEnd > start && as[aEnd - 1] === bs[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  const n = aEnd - start;
  const m = bEnd - start;
  if (n && m && n * m > MAX_TABLE) {
    for (const [i, j] of matchLines(
      as.slice(start, aEnd),
      bs.slice(start, bEnd)
    )) {
      pairs.push([start + i, start + j]);
    }
  } else if (n && m) {
    const lengths = Array.from({ length: n + 1 }, () =>
      new Array(m + 1).fill(0)
    );
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lengths[i][j] =
          as[start + i] === bs[start + j]
            ? lengths[i + 1][j + 1] + 1
            : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (as[start + i] === bs[start + j]) {
        pairs.push([start + i++, start + j++]);
      } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
        i++;
      } else {
        j++;
      }
    }
  }
  for (let k = 0; aEnd + k < as.length; k++) {
    pairs.push([aEnd + k, bEnd + k]);
  }
  return pairs;
}

function diffKeyedLists(before, after, key, path, out) {
  const beforeByKey = new Map(before.map((item) => [item[key], item]));
  const afterByKey = new Map(after.map((item) => [item[key], item]));

  const beforeOrder = before
    .map((item) => item[key])
    .filter((k) => afterByKey.has(k));
  const afterOrder = after
    .map((item) => item[key])
    .filter((k) => beforeByKey.has(k));
  if (!same(beforeOrder, afterOrder)) {
    out.push({
      path,
      status: REORDERED,
      before: beforeOrder,
      after: afterOrder
    });
  }
  for (const item of after) {
    diffValues(beforeByKey.get(item[key]), item, [...path, item[key]], out);
  }
  for (const item of before) {
    if (!afterByKey.has(item[key])) {
      out.push({ path: [...path, item[key]], status: REMOVED, before: item });
    }
  }
}

// Aligns unkeyed lists the way a line diff does: unchanged items are matched
// first, and the items left between two matches are paired off in order.
function diffUnkeyedLists(before, after, path, out) {
  const pairs = [
    ...commonSubsequence(before, after),
    [before.length, after.length]
  ];
  let i = 0;
  let j = 0;
  for (const [nextI, nextJ] of pairs) {
    while (i < nextI && j < nextJ) {
      diffValues(before[i++], after[j], [...path, j++], out);
    }
    while (i < nextI) {
      out.push({ path: [...path, i], status: REMOVED, before: before[i++] });
    }
    while (j < nextJ) {
      out.push({ path: [...path, j], status: ADDED, after: after[j++] });
    }
    i = nextI + 1;
    j = nextJ + 1;
  }
}

/** Appends the differences between two normalized values to `out`. */
export function diffValues(before, after, path = [], out = []) {
  if (same(before, after)) {
    return out;
  }
  if (before === undefined) {
    out.push({ path, status: ADDED, after });
  } else if (after === undefined) {
    out.push({ path, status: REMOVED, before });
  } else if (Array.isArray(before) && Array.isArray(after)) {
    const key =
      listKey(before) && listKey(before) === listKey(after)
        ? listKey(before)
        : undefined;
    if (key) {
      diffKeyedLists(before, after, key, path, out);
    } else {
      diffUnkeyedLists(before, after, path, out);
    }
  } else if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [
      ...new Set([...Object.keys(before), ...Object.keys(after)])
    ].sort();
    for (const key of keys) {
      diffValues(before[key], after[key], [...path, key], out);
    }
  } else {
    out.push({ path, status: CHANGED, before, after });
  }
  return out;
}

// Matches items by key and type. Items sharing a name but not a type are
// different things (possible between unrelated flows), so they come out as a
// removal plus an addition.
function diffItems(before, after, compare) {
  const entries = [];
  const entry = (a, b) => ({
    id: `${(a || b).type}:${(a || b).key}`,
    key: (a || b).key,
    type: (a || b).type,
    ...compare(a, b)
  });
  for (const item of after.values()) {
    const old = before.get(item.key);
    if (old && old.type === item.type) {
      entries.push(entry(old, item));
    } else {
      entries.push(entry(undefined, item));
    }
  }
  for (const old of before.values()) {
    const item = after.get(old.key);
    if (!item || item.type !== old.type) {
      entries.push(entry(old, undefined));
    }
  }
  return entries;
}

function compareElements(before, after) {
  if (!before) {
    return { status: ADDED, after, changes: [] };
  }
  if (!after) {
    return { status: REMOVED, before, changes: [] };
  }
  const changes = diffValues(before.fields, after.fields);
  const result = {
    status: changes.length ? CHANGED : UNCHANGED,
    before,
    after,
    changes
  };
  if ("x" in before || "x" in after) {
    result.moved = before.x !== after.x || before.y !== after.y;
  }
  return result;
}

function compareEdges(before, after) {
  if (!before) {
    return { status: ADDED, after };
  }
  if (!after) {
    return { status: REMOVED, before };
  }
  if (before.target !== after.target) {
    return { status: RETARGETED, before, after };
  }
  // Anything else a connector carries (metadata values, an explicit
  // isGoTo=false) is written back with it, and the merge compares it too.
  const changed =
    before.isGoTo !== after.isGoTo ||
    before.label !== after.label ||
    !same(before.extra, after.extra);
  return { status: changed ? CHANGED : UNCHANGED, before, after };
}

function edgeMap(model) {
  // Connectors are keyed by their source element's type too, so a
  // same-named element of another type never shares connectors.
  const types = new Map(
    [...model.nodes.values()].map((node) => [node.key, node.type])
  );
  return new Map(
    [...model.edges.values()].map((edge) => [
      edge.key,
      { ...edge, type: types.get(edge.source) }
    ])
  );
}

function count(entries) {
  const totals = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const entry of entries) {
    const status =
      entry.status === UNCHANGED ||
      entry.status === ADDED ||
      entry.status === REMOVED
        ? entry.status
        : CHANGED;
    totals[status]++;
    if (entry.moved) {
      totals.moved = (totals.moved || 0) + 1;
    }
  }
  return totals;
}

/**
 * Diffs two flows. Each side is a model from buildModel, a Tooling API Flow
 * record or a bare Flow metadata object.
 */
export function diffFlows(beforeInput, afterInput) {
  const before = isModel(beforeInput) ? beforeInput : buildModel(beforeInput);
  const after = isModel(afterInput) ? afterInput : buildModel(afterInput);

  const nodes = diffItems(before.nodes, after.nodes, compareElements);
  const edges = diffItems(edgeMap(before), edgeMap(after), compareEdges).map(
    ({ type, ...entry }) => {
      const edge = entry.after || entry.before;
      return {
        ...entry,
        source: edge.source,
        slot: edge.slot,
        kind: edge.kind,
        sourceType: type
      };
    }
  );
  const resources = diffItems(
    before.resources,
    after.resources,
    compareElements
  );
  const props = diffValues(before.props, after.props);

  const summary = {
    nodes: count(nodes),
    edges: count(edges),
    resources: count(resources),
    props: props.length
  };
  const logicChanged =
    props.length > 0 ||
    [nodes, edges, resources].some((entries) =>
      entries.some((e) => e.status !== UNCHANGED)
    );

  return {
    before,
    after,
    nodes,
    edges,
    resources,
    props,
    summary,
    // True when the flows differ only in where elements sit on the canvas.
    layoutOnly: !logicChanged && nodes.some((entry) => entry.moved),
    identical: !logicChanged && !nodes.some((entry) => entry.moved)
  };
}

/** Human-readable form of a change path, e.g. "rules › Match › conditions › 1 › operator". */
export function formatPath(path) {
  return path.join(" › ");
}
