/**
 * The receipt for saving a merge: what it was made from, what was decided,
 * and what was checked, with each check saying only what it covers. Checks
 * in Tributary read the metadata; they don't run the flow, so passing them
 * isn't proof the flow does what was intended.
 *
 * The candidate is the SHA-256 of the exact metadata sent, which is what's
 * saved: a draft, with its label and description. The org computes it
 * again when saving and refuses anything that doesn't match, or that it
 * would have to change to save, so the history names the flow that was
 * reviewed.
 */
import { plural } from "c/flowUtils";

// SHA-256 (FIPS 180-4), in plain JavaScript so it gives the same answer in
// Lightning, in tests and in Apex's Crypto.generateDigest.
const K = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19
];

// The text as UTF-8, the encoding Apex's Blob.valueOf uses. A lone
// surrogate becomes U+FFFD; JSON.stringify never leaves one.
function utf8(text) {
  const bytes = new Uint8Array(text.length * 3);
  let length = 0;
  for (let index = 0; index < text.length; index++) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdfff) {
      const next = text.charCodeAt(index + 1);
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index++;
      } else {
        code = 0xfffd;
      }
    }
    if (code < 0x80) {
      bytes[length++] = code;
    } else if (code < 0x800) {
      bytes[length++] = 0xc0 | (code >> 6);
      bytes[length++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      bytes[length++] = 0xe0 | (code >> 12);
      bytes[length++] = 0x80 | ((code >> 6) & 0x3f);
      bytes[length++] = 0x80 | (code & 0x3f);
    } else {
      bytes[length++] = 0xf0 | (code >> 18);
      bytes[length++] = 0x80 | ((code >> 12) & 0x3f);
      bytes[length++] = 0x80 | ((code >> 6) & 0x3f);
      bytes[length++] = 0x80 | (code & 0x3f);
    }
  }
  return bytes.subarray(0, length);
}

const rotate = (x, n) => (x >>> n) | (x << (32 - n));

/** The SHA-256 of a string's UTF-8 bytes, as 64 lowercase hex digits. */
export function sha256(text) {
  const input = utf8(String(text));
  const size = input.length;
  // The message, a 1 bit, zeros, and its length in bits: whole 64-byte blocks.
  const total = Math.ceil((size + 9) / 64) * 64;
  const data = new Uint8Array(total);
  data.set(input);
  data[size] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(total - 8, Math.floor(size / 0x20000000));
  view.setUint32(total - 4, (size * 8) >>> 0);

  const hash = Int32Array.from(H0);
  const w = new Int32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getInt32(offset + t * 4);
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15];
      const y = w[t - 2];
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let t = 0; t < 64; t++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + K[t] + w[t]) | 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    hash[0] += a;
    hash[1] += b;
    hash[2] += c;
    hash[3] += d;
    hash[4] += e;
    hash[5] += f;
    hash[6] += g;
    hash[7] += h;
  }
  return [...hash]
    .map((word) => (word >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/** A fingerprint short enough to read out: the first 12 hex digits. */
export function shortFingerprint(candidate) {
  return candidate ? candidate.slice(0, 12) : "";
}

// A date and time the same for every reader of the history: UTC, to the
// minute.
export function utcText(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return "";
  }
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export const PASSED = "passed";
export const WARNED = "warned";
export const FAILED = "failed";
export const NOT_RUN = "notRun";
export const PENDING = "pending";

/**
 * One source of the merge, in a line: what it is, where it lives and when
 * it last changed.
 */
export function sourceText(source) {
  const parts = [];
  const where = [source.connectionLabel, source.apiName]
    .filter(Boolean)
    .join(": ");
  if (where) {
    parts.push(
      source.versionNumber ? `${where} v${source.versionNumber}` : where
    );
  }
  const changed = utcText(source.lastModifiedDate);
  if (changed) {
    parts.push(
      `last changed ${changed}${source.lastModifiedBy ? ` by ${source.lastModifiedBy}` : ""}`
    );
  }
  if (source.versionId) {
    parts.push(`id ${source.versionId}`);
  }
  return parts.join(", ");
}

/**
 * The three checks, kept apart: what Tributary read in the metadata,
 * Apex tests (never run here), and whether the org accepted the version.
 * checks: { errors, warnings, messages }, or nothing when none were made;
 * saved: { versionNumber } once the org has taken it.
 */
export function receiptChecks(checks, saved) {
  const errors = (checks && checks.errors) || 0;
  const warnings = (checks && checks.warnings) || 0;
  const found = [
    errors ? plural(errors, "error") : "",
    warnings ? plural(warnings, "warning") : ""
  ].filter(Boolean);
  const detail =
    "Connectors, references and required parts, read from the metadata. The flow wasn't run.";
  const model = checks
    ? {
        key: "model",
        title: "Checked in Tributary",
        status: errors ? FAILED : warnings ? WARNED : PASSED,
        summary: found.length
          ? `${found.join(" and ")} found.`
          : "No errors or warnings found.",
        detail,
        messages: (checks.messages || []).slice(0, 5)
      }
    : {
        key: "model",
        title: "Checked in Tributary",
        status: NOT_RUN,
        summary: "Not checked.",
        detail,
        messages: []
      };
  const apex = {
    key: "apex",
    title: "Apex tests",
    status: NOT_RUN,
    summary: "Not run by Tributary.",
    detail:
      "Run the org's tests that cover this flow before it's activated, where the flow calls or is called by Apex."
  };
  const org = saved
    ? {
        key: "org",
        title: "Checked by the org",
        status: PASSED,
        summary: `Accepted as inactive version ${saved.versionNumber}.`,
        detail:
          "The org found the metadata valid. That isn't proof the flow does what was intended."
      }
    : {
        key: "org",
        title: "Checked by the org",
        status: PENDING,
        summary: "Not yet. The org checks the metadata when it's saved.",
        detail:
          "Saving adds an inactive version. Nothing changes for users until a version is activated."
      };
  return [model, apex, org];
}

/**
 * The receipt as the dialog shows it and the history keeps it.
 * sources: [{ role, label, connectionLabel, apiName, versionNumber,
 * versionId, lastModifiedDate, lastModifiedBy }]; decisions: lines.
 */
export function buildReceipt({
  candidate,
  sources = [],
  decisions = [],
  checks,
  saved
}) {
  return {
    candidate,
    short: shortFingerprint(candidate),
    sources: sources.map((source) => ({
      ...source,
      key: `${source.role}|${source.versionId || source.label}`,
      text: sourceText(source)
    })),
    decisions: decisions.filter(Boolean),
    checks: receiptChecks(checks, saved)
  };
}

/**
 * The receipt as text for the flow's history and for activation requests:
 * sources, decisions and the checks made before saving. The org adds what
 * it verified itself (the candidate, unchanged sources and the version it
 * accepted), so those aren't here.
 */
export function receiptText(receipt) {
  const lines = [];
  if (receipt.sources.length) {
    lines.push("From:");
    for (const source of receipt.sources) {
      lines.push(`- ${source.label}: ${source.text}`);
    }
  }
  if (receipt.decisions.length) {
    lines.push("Decided:");
    for (const decision of receipt.decisions) {
      lines.push(`- ${decision}`);
    }
  }
  for (const check of receipt.checks.filter((item) => item.key !== "org")) {
    lines.push(`${check.title}: ${check.summary} ${check.detail}`);
    for (const message of check.messages || []) {
      lines.push(`- ${message}`);
    }
  }
  return lines.join("\n");
}
