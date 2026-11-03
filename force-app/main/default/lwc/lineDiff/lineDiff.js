/**
 * Line diff and merge for the text view: a Myers diff with a patience-style
 * fallback for large, very different files, hunks with context for display,
 * and two- and three-way merges driven by per-block picks.
 */

export const EQUAL = "equal";
export const INSERT = "insert";
export const DELETE = "delete";

// Beyond this edit distance Myers' trace gets too large to keep; the
// remaining region is split on unique common lines instead.
const MAX_EDIT_DISTANCE = 1500;

/** Myers' O(ND) diff over two arrays of ids. Returns ops or null past maxD. */
function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, offset, n, m, d);
      }
    }
  }
  return null;
}

function backtrack(trace, offset, n, m, depth) {
  const ops = [];
  let x = n;
  let y = m;
  for (let d = depth; d > 0; d--) {
    // trace[d] holds the furthest points reached with d - 1 edits.
    const prev = trace[d];
    const k = x - y;
    const down =
      k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push([EQUAL, --x, --y]);
    }
    if (down) {
      ops.push([INSERT, x, --y]);
    } else {
      ops.push([DELETE, --x, y]);
    }
  }
  while (x > 0 && y > 0) {
    ops.push([EQUAL, --x, --y]);
  }
  return ops.reverse();
}

// Longest increasing subsequence of pairs by their second item.
function longestIncreasing(pairs) {
  const tails = [];
  const prev = new Array(pairs.length);
  for (let i = 0; i < pairs.length; i++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (pairs[tails[mid]][1] < pairs[i][1]) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    prev[i] = low > 0 ? tails[low - 1] : -1;
    tails[low] = i;
  }
  const out = [];
  for (
    let i = tails.length ? tails[tails.length - 1] : -1;
    i >= 0;
    i = prev[i]
  ) {
    out.push(pairs[i]);
  }
  return out.reverse();
}

function uniqueAnchors(a, aStart, aEnd, b, bStart, bEnd) {
  const count = new Map();
  for (let i = aStart; i < aEnd; i++) {
    const c = count.get(a[i]) || { a: 0, b: 0, ai: i, bi: -1 };
    c.a++;
    c.ai = i;
    count.set(a[i], c);
  }
  for (let j = bStart; j < bEnd; j++) {
    const c = count.get(b[j]);
    if (c) {
      c.b++;
      c.bi = j;
    }
  }
  const pairs = [];
  for (const c of count.values()) {
    if (c.a === 1 && c.b === 1) {
      pairs.push([c.ai, c.bi]);
    }
  }
  pairs.sort((p, q) => p[0] - q[0]);
  return longestIncreasing(pairs);
}

function diffRange(a, aStart, aEnd, b, bStart, bEnd, out) {
  // Common prefix and suffix.
  while (aStart < aEnd && bStart < bEnd && a[aStart] === b[bStart]) {
    out.push([EQUAL, aStart++, bStart++]);
  }
  const tail = [];
  while (aStart < aEnd && bStart < bEnd && a[aEnd - 1] === b[bEnd - 1]) {
    tail.push([EQUAL, --aEnd, --bEnd]);
  }
  // One side empty is a plain insert or delete, and a length gap wider than
  // the edit limit can't be bridged within it, so neither needs a search.
  const ops =
    aStart === aEnd ||
    bStart === bEnd ||
    Math.abs(aEnd - aStart - (bEnd - bStart)) > MAX_EDIT_DISTANCE
      ? null
      : myers(a.slice(aStart, aEnd), b.slice(bStart, bEnd), MAX_EDIT_DISTANCE);
  if (ops) {
    for (const [type, i, j] of ops) {
      out.push([type, i + aStart, j + bStart]);
    }
  } else {
    const anchors =
      aStart === aEnd || bStart === bEnd
        ? []
        : uniqueAnchors(a, aStart, aEnd, b, bStart, bEnd);
    if (anchors.length) {
      let i = aStart;
      let j = bStart;
      for (const [ai, bj] of anchors) {
        diffRange(a, i, ai, b, j, bj, out);
        out.push([EQUAL, ai, bj]);
        i = ai + 1;
        j = bj + 1;
      }
      diffRange(a, i, aEnd, b, j, bEnd, out);
    } else {
      for (let i = aStart; i < aEnd; i++) {
        out.push([DELETE, i, bStart]);
      }
      for (let j = bStart; j < bEnd; j++) {
        out.push([INSERT, aEnd, j]);
      }
    }
  }
  out.push(...tail.reverse());
  return out;
}

function toIds(aLines, bLines) {
  const ids = new Map();
  const id = (line) => {
    if (!ids.has(line)) {
      ids.set(line, ids.size);
    }
    return ids.get(line);
  };
  return [aLines.map(id), bLines.map(id)];
}

/**
 * Index pairs of the items two lists of strings share, aligned as the line
 * diff aligns lines.
 */
export function matchLines(aLines, bLines) {
  const [a, b] = toIds(aLines, bLines);
  return diffRange(a, 0, a.length, b, 0, b.length, [])
    .filter(([type]) => type === EQUAL)
    .map(([, i, j]) => [i, j]);
}

export function splitLines(text) {
  if (!text) {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

const CLOSING = /^\s*<\//;

// A run of added or removed lines can sit anywhere its repeated edges allow.
// Myers puts it as early as it can, so an added element starts with the
// previous element's closing tag; slide such runs down a line at a time so
// they start where the element does.
function slide(ops) {
  for (let start = 0; start < ops.length; start++) {
    const { type } = ops[start];
    if (type === EQUAL) {
      continue;
    }
    let end = start;
    while (end < ops.length && ops[end].type === type) {
      end++;
    }
    while (
      end < ops.length &&
      ops[end].type === EQUAL &&
      ops[end].text === ops[start].text &&
      CLOSING.test(ops[start].text)
    ) {
      const first = ops[start];
      const equal = ops[end];
      const inserting = type === INSERT;
      const shifted = ops
        .slice(start + 1, end)
        .map((op) =>
          inserting ? { ...op, a: op.a + 1 } : { ...op, b: op.b + 1 }
        );
      ops.splice(
        start,
        end - start + 1,
        inserting
          ? { type: EQUAL, a: equal.a, b: first.b, text: first.text }
          : { type: EQUAL, a: first.a, b: equal.b, text: first.text },
        ...shifted,
        inserting
          ? { type, a: equal.a + 1, b: equal.b, text: equal.text }
          : { type, a: equal.a, b: equal.b + 1, text: equal.text }
      );
      start++;
      end++;
    }
    start = end - 1;
  }
  return ops;
}

function lineOps(aLines, bLines) {
  const [a, b] = toIds(aLines, bLines);
  return slide(
    diffRange(a, 0, a.length, b, 0, b.length, []).map(([type, i, j]) => ({
      type,
      a: i,
      b: j,
      text: type === INSERT ? bLines[j] : aLines[i]
    }))
  );
}

// Lines as pieces to diff: each named block whole, and every other line alone.
function pieces(lines, blocks) {
  const starts = new Map();
  for (const [id, range] of blocks || []) {
    starts.set(range.start, { id, end: range.end });
  }
  const out = [];
  for (let line = 0; line < lines.length;) {
    const block = starts.get(line);
    const end = block && block.end >= line ? block.end + 1 : line + 1;
    // A NUL can't be in a line, so a block never matches a line.
    out.push({
      key: block ? `\u0000${block.id}` : lines[line],
      start: line,
      end
    });
    line = end;
  }
  return out;
}

/**
 * Diffs two arrays of lines. Each op is { type, a, b, text }: a and b are
 * 0-based line numbers (the position in the other file for inserts and
 * deletes).
 *
 * Given blocks ({ a, b }: maps of id to { start, end } lines, inclusive),
 * blocks are matched by id before lines are: a block is only diffed against
 * the block with its id, so one element removed and another added never read
 * as one edited into the other.
 */
export function diffLines(aLines, bLines, blocks) {
  if (!blocks) {
    return lineOps(aLines, bLines);
  }
  const a = pieces(aLines, blocks.a);
  const b = pieces(bLines, blocks.b);
  const [aIds, bIds] = toIds(
    a.map((piece) => piece.key),
    b.map((piece) => piece.key)
  );
  const at = (list, index, total) =>
    index < list.length ? list[index].start : total;
  const out = [];
  for (const [type, i, j] of diffRange(
    aIds,
    0,
    aIds.length,
    bIds,
    0,
    bIds.length,
    []
  )) {
    if (type === EQUAL) {
      const x = a[i];
      const y = b[j];
      for (const op of lineOps(
        aLines.slice(x.start, x.end),
        bLines.slice(y.start, y.end)
      )) {
        out.push({ ...op, a: op.a + x.start, b: op.b + y.start });
      }
    } else if (type === DELETE) {
      const b0 = at(b, j, bLines.length);
      for (let line = a[i].start; line < a[i].end; line++) {
        out.push({ type, a: line, b: b0, text: aLines[line] });
      }
    } else {
      const a0 = at(a, i, aLines.length);
      for (let line = b[j].start; line < b[j].end; line++) {
        out.push({ type, a: a0, b: line, text: bLines[line] });
      }
    }
  }
  return out;
}

/**
 * Groups ops into change blocks: runs of deletes and inserts between equal
 * lines. Each block is { index, aStart, aEnd, bStart, bEnd } (end exclusive).
 */
export function changeBlocks(ops) {
  const blocks = [];
  let current = null;
  for (const op of ops) {
    if (op.type === EQUAL) {
      current = null;
      continue;
    }
    if (!current) {
      current = {
        index: blocks.length,
        aStart: op.a,
        aEnd: op.a,
        bStart: op.b,
        bEnd: op.b
      };
      blocks.push(current);
    }
    if (op.type === DELETE) {
      current.aEnd = op.a + 1;
    } else {
      current.bEnd = op.b + 1;
    }
  }
  return blocks;
}

/**
 * Display hunks with `context` equal lines around each change. Rows are
 * { type, a, b, text, block } with 1-based line numbers (null where a side
 * has no line). Equal lines between hunks are reported as `skipped` counts.
 * A context of Infinity keeps every line, even when nothing changed.
 */
export function toHunks(ops, context = 3) {
  const blocks = changeBlocks(ops);
  const blockOf = new Map();
  let blockIndex = -1;
  let inChange = false;
  ops.forEach((op, index) => {
    if (op.type === EQUAL) {
      inChange = false;
    } else {
      if (!inChange) {
        blockIndex++;
      }
      inChange = true;
      blockOf.set(index, blockIndex);
    }
  });

  // Each change keeps the lines around it. The windows only move forward, so
  // each line is marked once, even when the context is every line.
  const keep = new Array(ops.length).fill(context === Infinity);
  let marked = context === Infinity ? ops.length - 1 : -1;
  ops.forEach((op, index) => {
    if (op.type !== EQUAL) {
      const last = Math.min(ops.length - 1, index + context);
      for (let i = Math.max(marked + 1, index - context); i <= last; i++) {
        keep[i] = true;
      }
      marked = Math.max(marked, last);
    }
  });

  const hunks = [];
  let hunk = null;
  let skipped = 0;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      skipped++;
      hunk = null;
      return;
    }
    if (!hunk) {
      hunk = { skippedBefore: skipped, rows: [] };
      hunks.push(hunk);
      skipped = 0;
    }
    hunk.rows.push({
      type: op.type,
      a: op.type === INSERT ? null : op.a + 1,
      b: op.type === DELETE ? null : op.b + 1,
      text: op.text,
      block: blockOf.has(index) ? blockOf.get(index) : null
    });
  });
  for (const h of hunks) {
    const first = h.rows[0];
    const aRow = h.rows.find((row) => row.a !== null);
    const bRow = h.rows.find((row) => row.b !== null);
    h.aStart = aRow ? aRow.a : first.a;
    h.bStart = bRow ? bRow.b : first.b;
    h.aLines = h.rows.filter((row) => row.a !== null).length;
    h.bLines = h.rows.filter((row) => row.b !== null).length;
  }
  return { hunks, skippedAfter: skipped, blocks };
}

/**
 * Two-way merge: starts from `a` and, for each change block, keeps a's
 * lines ("a", the default), takes b's ("b"), or keeps both ("both", a first).
 */
export function mergeTwoWay(aLines, bLines, ops, picks = {}) {
  const blocks = changeBlocks(ops);
  const out = [];
  let i = 0;
  for (const block of blocks) {
    while (i < block.aStart) {
      out.push(aLines[i++]);
    }
    const pick = picks[block.index] || "a";
    if (pick === "a" || pick === "both") {
      out.push(...aLines.slice(block.aStart, block.aEnd));
    }
    if (pick === "b" || pick === "both") {
      out.push(...bLines.slice(block.bStart, block.bEnd));
    }
    i = block.aEnd;
  }
  while (i < aLines.length) {
    out.push(aLines[i++]);
  }
  return out;
}

/**
 * Three-way merge of two edited copies of a base, diff3 style. A change made
 * on one side only is applied. Changes on both sides that overlap or touch in
 * the base are a conflict unless they are identical; `picks[conflictIndex]`
 * resolves each as "ours" (the default), "theirs" or "both".
 *
 * Blocks ({ base, ours, theirs }: maps of id to line range) are matched by
 * id first, as in diffLines.
 *
 * `minor(a, b)` says whether two lines differ in a way that doesn't matter.
 * Where one side's change is only minor, the other side's applies; where the
 * two sides differ only in minor ways, ours applies. Either way it is a
 * "minor" chunk, not a conflict.
 *
 * Returns { lines, conflicts, chunks }. Chunks cover the result in order:
 * { type: "stable" | "ours" | "theirs" | "both" | "minor" | "conflict",
 * lines }. Each conflict says where its lines start in the base and in each
 * side.
 */
export function mergeThreeWay(
  baseLines,
  ours,
  theirs,
  picks = {},
  blocks,
  minor
) {
  return applyThreeWay(
    planThreeWay(baseLines, ours, theirs, blocks, minor),
    picks
  );
}

/**
 * The part of mergeThreeWay that doesn't depend on picks: both sides diffed
 * against the base, and the result as a list of chunks, each conflict with
 * its base, ours and theirs lines and no pick yet. Diffing is the slow part,
 * so a caller that keeps the plan can apply picks to it again and again.
 */
export function planThreeWay(baseLines, ours, theirs, blocks, minor) {
  const onlyMinor = (x, y) =>
    Boolean(minor) &&
    x.length === y.length &&
    x.every((line, i) => line === y[i] || minor(line, y[i]));
  const pair = (side) => blocks && { a: blocks.base, b: blocks[side] };
  const hunks = [
    ...changeBlocks(diffLines(baseLines, ours, pair("ours"))).map((block) => ({
      side: "ours",
      ...block
    })),
    ...changeBlocks(diffLines(baseLines, theirs, pair("theirs"))).map(
      (block) => ({
        side: "theirs",
        ...block
      })
    )
  ].sort((p, q) => p.aStart - q.aStart || p.aEnd - q.aEnd);

  const groups = [];
  for (const hunk of hunks) {
    const last = groups[groups.length - 1];
    if (last && hunk.aStart <= last.end) {
      last.end = Math.max(last.end, hunk.aEnd);
      last.hunks.push(hunk);
    } else {
      groups.push({ start: hunk.aStart, end: hunk.aEnd, hunks: [hunk] });
    }
  }

  // A side's lines in place of base[start, end). Outside its own hunks the
  // side matches the base, so its range extends from the first and last hunk.
  const sideStart = (group, side) => {
    const first = group.hunks.find((hunk) => hunk.side === side);
    return first ? first.bStart - (first.aStart - group.start) : group.start;
  };
  const sideText = (group, side, lines) => {
    const own = group.hunks.filter((hunk) => hunk.side === side);
    if (!own.length) {
      return baseLines.slice(group.start, group.end);
    }
    const last = own[own.length - 1];
    return lines.slice(
      sideStart(group, side),
      last.bEnd + (group.end - last.aEnd)
    );
  };

  const plan = [];
  let conflicts = 0;
  let pos = 0;
  for (const group of groups) {
    if (pos < group.start) {
      plan.push({ type: "stable", lines: baseLines.slice(pos, group.start) });
    }
    const sides = new Set(group.hunks.map((hunk) => hunk.side));
    const oursText = sideText(group, "ours", ours);
    const theirsText = sideText(group, "theirs", theirs);
    if (sides.size === 1) {
      const side = [...sides][0];
      plan.push({ type: side, lines: side === "ours" ? oursText : theirsText });
    } else if (oursText.join("\n") === theirsText.join("\n")) {
      plan.push({ type: "both", lines: oursText });
    } else if (
      onlyMinor(oursText, theirsText) ||
      onlyMinor(baseLines.slice(group.start, group.end), theirsText)
    ) {
      plan.push({ type: "minor", lines: oursText });
    } else if (onlyMinor(baseLines.slice(group.start, group.end), oursText)) {
      plan.push({ type: "minor", lines: theirsText });
    } else {
      plan.push({
        type: "conflict",
        index: conflicts++,
        base: baseLines.slice(group.start, group.end),
        ours: oursText,
        theirs: theirsText,
        baseStart: group.start,
        oursStart: sideStart(group, "ours"),
        theirsStart: sideStart(group, "theirs")
      });
    }
    pos = group.end;
  }
  if (pos < baseLines.length) {
    plan.push({ type: "stable", lines: baseLines.slice(pos) });
  }
  return plan;
}

/**
 * A plan from planThreeWay with `picks[conflictIndex]` applied, as
 * mergeThreeWay returns it. Chunks without a pick are the plan's own, so
 * neither they nor their lines may be changed.
 */
export function applyThreeWay(plan, picks = {}) {
  const lines = [];
  const conflicts = [];
  const chunks = [];
  for (const step of plan) {
    let chunk = step;
    if (step.type === "conflict") {
      const pick = picks[step.index] || "ours";
      const { type, ...conflict } = step;
      conflicts.push({ ...conflict, pick });
      chunk = {
        type,
        index: step.index,
        pick,
        lines:
          pick === "theirs"
            ? step.theirs
            : pick === "both"
              ? [...step.ours, ...step.theirs]
              : step.ours
      };
    }
    lines.push(...chunk.lines);
    chunks.push(chunk);
  }
  return { lines, conflicts, chunks };
}
