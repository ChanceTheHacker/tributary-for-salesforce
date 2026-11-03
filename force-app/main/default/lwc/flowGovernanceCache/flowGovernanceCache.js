/**
 * A short memory of governance reads, so coming back to a governance page, or
 * a second activation card for the same flow, doesn't ask the server again.
 * It keeps only what pages show, never anything a change is allowed by: the
 * server checks that afresh on every write, and operations are never cached.
 *
 * Any change made here forgets everything; a page's Refresh reads afresh.
 * Someone else's change is seen once a read is a minute old.
 */

// Long enough to go to a comparison and back; short enough that other
// people's changes show soon without a Refresh.
const KEEP_MS = 60000;
// Enough for a few pages and their histories; the oldest go first.
const MOST_KEPT = 50;
// Oldest first: a read made again moves to the end.
const reads = new Map();

// Lets go of reads older than a minute, and the oldest beyond MOST_KEPT.
function prune(now) {
  for (const [key, entry] of reads) {
    if (now - entry.at < KEEP_MS && reads.size <= MOST_KEPT) {
      break;
    }
    reads.delete(key);
  }
}

/**
 * What read(params) answers, shared with the same read if it's still out or
 * was made in the last minute. fresh reads again, and keeps the new answer.
 * Answers are shared, so callers must not change them.
 */
export function cachedRead(name, read, params, fresh = false) {
  const key = `${name}:${JSON.stringify(params || {})}`;
  const now = Date.now();
  const kept = reads.get(key);
  if (!fresh && kept && now - kept.at < KEEP_MS) {
    return kept.answer;
  }
  const entry = { at: now, answer: Promise.resolve(read(params)) };
  reads.delete(key);
  reads.set(key, entry);
  prune(now);
  // A failure isn't kept: the next read tries again.
  entry.answer.catch(() => {
    if (reads.get(key) === entry) {
      reads.delete(key);
    }
  });
  return entry.answer;
}

/** Forgets every read, after anything that changes governance, requests or history. */
export function forgetGovernance() {
  reads.clear();
}

/**
 * Runs a change, forgetting reads before it and after it, so nothing read
 * while it was under way outlives it. The change's answer or error is passed on.
 */
export async function governanceChange(change) {
  forgetGovernance();
  try {
    return await change();
  } finally {
    forgetGovernance();
  }
}
