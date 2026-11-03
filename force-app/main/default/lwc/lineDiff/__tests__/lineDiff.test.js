import {
  diffLines,
  changeBlocks,
  toHunks,
  mergeTwoWay,
  mergeThreeWay,
  planThreeWay,
  applyThreeWay,
  splitLines,
  EQUAL,
  INSERT,
  DELETE
} from "c/lineDiff";
import { toXml } from "c/flowXml";
import { normalize } from "c/flowModel";

const versions = [1, 2, 3, 4].map((v) =>
  require(`fixtures/flows/Case_Email_Routing/v${v}.json`)
);
const xmlLines = (record) => toXml(normalize(record.Metadata)).lines;

// Rebuilds both sides from the ops, which checks they are a complete diff.
function replay(ops) {
  return {
    a: ops.filter((op) => op.type !== INSERT).map((op) => op.text),
    b: ops.filter((op) => op.type !== DELETE).map((op) => op.text)
  };
}

function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("diffLines", () => {
  it("finds a minimal diff", () => {
    const ops = diffLines(
      ["a", "b", "c", "a", "b", "b", "a"],
      ["c", "b", "a", "b", "a", "c"]
    );
    expect(ops.filter((op) => op.type !== EQUAL)).toHaveLength(5);
    expect(replay(ops)).toEqual({
      a: ["a", "b", "c", "a", "b", "b", "a"],
      b: ["c", "b", "a", "b", "a", "c"]
    });
  });

  it("handles empty sides", () => {
    expect(diffLines([], [])).toEqual([]);
    expect(diffLines([], ["x"])).toEqual([
      { type: INSERT, a: 0, b: 0, text: "x" }
    ]);
    expect(diffLines(["x"], [])).toEqual([
      { type: DELETE, a: 0, b: 0, text: "x" }
    ]);
  });

  it("gives line numbers on both sides", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c"])).toEqual([
      { type: EQUAL, a: 0, b: 0, text: "a" },
      { type: DELETE, a: 1, b: 1, text: "b" },
      { type: INSERT, a: 2, b: 1, text: "x" },
      { type: EQUAL, a: 2, b: 2, text: "c" }
    ]);
  });

  it("round-trips random edits", () => {
    const random = seeded(7);
    for (let run = 0; run < 200; run++) {
      const a = Array.from({ length: Math.floor(random() * 30) }, () =>
        String(Math.floor(random() * 6))
      );
      const b = a.filter(() => random() > 0.2);
      for (let i = 0; i < 5; i++) {
        b.splice(Math.floor(random() * (b.length + 1)), 0, "n" + i);
      }
      expect(replay(diffLines(a, b))).toEqual({ a, b });
    }
  });

  it("falls back to unique-line anchors for very different large files", () => {
    const a = Array.from({ length: 4000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 4000 }, (_, i) =>
      i % 2 ? `a${i}` : `b${i}`
    );
    const ops = diffLines(a, b);
    expect(replay(ops)).toEqual({ a, b });
    expect(ops.filter((op) => op.type === EQUAL)).toHaveLength(2000);
  });

  it("finds the rewired connector between two flow versions", () => {
    const ops = diffLines(xmlLines(versions[2]), xmlLines(versions[3]));
    const changed = ops.filter((op) => op.type !== EQUAL);
    expect(changed.map((op) => [op.type, op.text.trim()])).toEqual([
      [DELETE, "<targetReference>Was_a_match_found</targetReference>"],
      [INSERT, "<targetReference>Should_Case_Be_Updated</targetReference>"]
    ]);
  });
});

describe("splitLines", () => {
  it("drops the final newline only", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("changeBlocks and toHunks", () => {
  const a = "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15".split(" ");
  const b = "1 2 x 4 5 6 7 8 9 10 11 12 13 y 15 16".split(" ");
  const ops = diffLines(a, b);

  it("groups runs of changes into blocks", () => {
    expect(changeBlocks(ops)).toEqual([
      { index: 0, aStart: 2, aEnd: 3, bStart: 2, bEnd: 3 },
      { index: 1, aStart: 13, aEnd: 14, bStart: 13, bEnd: 14 },
      { index: 2, aStart: 15, aEnd: 15, bStart: 15, bEnd: 16 }
    ]);
  });

  it("builds hunks with context and skipped counts", () => {
    const { hunks, skippedAfter } = toHunks(ops, 2);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({
      skippedBefore: 0,
      aStart: 1,
      bStart: 1,
      aLines: 5,
      bLines: 5
    });
    expect(hunks[0].rows.map((row) => [row.type, row.a, row.b])).toEqual([
      [EQUAL, 1, 1],
      [EQUAL, 2, 2],
      [DELETE, 3, null],
      [INSERT, null, 3],
      [EQUAL, 4, 4],
      [EQUAL, 5, 5]
    ]);
    expect(hunks[1].skippedBefore).toBe(6);
    expect(hunks[1].rows.filter((row) => row.block !== null)).toHaveLength(3);
    expect(skippedAfter).toBe(0);
  });
});

describe("mergeTwoWay", () => {
  const a = ["a", "b", "c", "d"];
  const b = ["a", "B", "c", "d", "e"];
  const ops = diffLines(a, b);

  it("keeps a by default", () => {
    expect(mergeTwoWay(a, b, ops)).toEqual(a);
  });

  it("takes picked blocks from b", () => {
    expect(mergeTwoWay(a, b, ops, { 0: "b" })).toEqual(["a", "B", "c", "d"]);
    expect(mergeTwoWay(a, b, ops, { 1: "b" })).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e"
    ]);
    expect(mergeTwoWay(a, b, ops, { 0: "both", 1: "b" })).toEqual([
      "a",
      "b",
      "B",
      "c",
      "d",
      "e"
    ]);
  });

  it("gives b when every block is picked", () => {
    const blocks = changeBlocks(ops);
    const picks = Object.fromEntries(blocks.map((block) => [block.index, "b"]));
    expect(mergeTwoWay(a, b, ops, picks)).toEqual(b);
  });
});

describe("diffLines with blocks", () => {
  const a = [
    "<Flow>",
    "  <x>",
    "    <n>A</n>",
    "    <v>5</v>",
    "  </x>",
    "</Flow>"
  ];
  const b = [
    "<Flow>",
    "  <x>",
    "    <n>B</n>",
    "    <v>5</v>",
    "  </x>",
    "</Flow>"
  ];
  const at = (id) => new Map([[id, { start: 1, end: 4 }]]);

  it("never diffs one block against another", () => {
    const ops = diffLines(a, b, { a: at("x:A"), b: at("x:B") });
    const lines = (type, side) =>
      ops.filter((op) => op.type === type).map((op) => op[side]);
    expect(lines("delete", "a")).toEqual([1, 2, 3, 4]);
    expect(lines("insert", "b")).toEqual([1, 2, 3, 4]);
    expect(mergeTwoWay(a, b, ops, { 0: "b" })).toEqual(b);
    // Line by line, the shared lines would line up.
    expect(diffLines(a, b).filter((op) => op.type !== EQUAL)).toHaveLength(2);
  });

  it("diffs a block against the one with its id", () => {
    const ops = diffLines(a, b, { a: at("x:A"), b: at("x:A") });
    expect(ops.filter((op) => op.type !== EQUAL).map((op) => op.text)).toEqual([
      "    <n>A</n>",
      "    <n>B</n>"
    ]);
  });

  it("lets a three-way merge keep two different added blocks", () => {
    const base = ["<Flow>", "</Flow>"];
    const ours = [
      "<Flow>",
      "  <x>",
      "    <n>A</n>",
      "    <v>5</v>",
      "  </x>",
      "</Flow>"
    ];
    const theirs = [
      "<Flow>",
      "  <x>",
      "    <n>B</n>",
      "    <v>5</v>",
      "  </x>",
      "</Flow>"
    ];
    const blocks = { base: new Map(), ours: at("x:A"), theirs: at("x:B") };
    const merged = mergeThreeWay(base, ours, theirs, { 0: "both" }, blocks);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0].ours).toEqual(ours.slice(1, 5));
    expect(merged.lines).toEqual([...ours.slice(0, 5), ...theirs.slice(1)]);
  });
});

describe("diffLines sliding", () => {
  it("starts an added element at its opening tag", () => {
    const before = ["<a>", "  <n>1</n>", "</a>", "<b/>"];
    const after = [
      "<a>",
      "  <n>1</n>",
      "</a>",
      "<a>",
      "  <n>2</n>",
      "</a>",
      "<b/>"
    ];
    const ops = diffLines(before, after);
    const added = ops.filter((op) => op.type === "insert").map((op) => op.text);
    expect(added).toEqual(["<a>", "  <n>2</n>", "</a>"]);
    expect(changeBlocks(ops)).toEqual([
      { index: 0, aStart: 3, aEnd: 3, bStart: 3, bEnd: 6 }
    ]);
    // Taking the change still gives exactly the second file.
    expect(mergeTwoWay(before, after, ops, { 0: "b" })).toEqual(after);
  });

  it("starts a removed element at its opening tag", () => {
    const before = ["<a>", "  <n>1</n>", "</a>", "<a>", "  <n>2</n>", "</a>"];
    const after = ["<a>", "  <n>1</n>", "</a>"];
    const ops = diffLines(before, after);
    const removed = ops.filter((op) => op.type === "delete").map((op) => op.a);
    expect(removed).toEqual([3, 4, 5]);
  });
});

describe("mergeThreeWay", () => {
  const base = ["a", "b", "c", "d", "e", "f", "g"];

  it("applies changes made on one side", () => {
    const ours = ["a", "B", "c", "d", "e", "f", "g"];
    const theirs = ["a", "b", "c", "d", "e", "F", "g", "h"];
    const merged = mergeThreeWay(base, ours, theirs);
    expect(merged.conflicts).toEqual([]);
    expect(merged.lines).toEqual(["a", "B", "c", "d", "e", "F", "g", "h"]);
    expect(merged.chunks.map((chunk) => chunk.type)).toEqual([
      "stable",
      "ours",
      "stable",
      "theirs",
      "stable",
      "theirs"
    ]);
  });

  it("settles differences that only minor lines make", () => {
    const minor = (a, b) => /^y/.test(a) && /^y/.test(b);
    const start = ["a", "y1", "b", "c"];
    // Both moved it: ours' place stands.
    let merged = mergeThreeWay(
      start,
      ["a", "y2", "b", "c"],
      ["a", "y3", "b", "c"],
      {},
      undefined,
      minor
    );
    expect(merged.conflicts).toEqual([]);
    expect(merged.lines).toEqual(["a", "y2", "b", "c"]);
    expect(merged.chunks.map((chunk) => chunk.type)).toContain("minor");
    // Theirs only moved what ours deleted: the deletion applies.
    merged = mergeThreeWay(
      start,
      ["a", "c"],
      ["a", "y3", "b", "c"],
      {},
      undefined,
      minor
    );
    expect(merged.conflicts).toEqual([]);
    expect(merged.lines).toEqual(["a", "c"]);
    // Ours only moved what theirs changed: theirs applies.
    merged = mergeThreeWay(
      start,
      ["a", "y2", "b", "c"],
      ["a", "y3", "B", "c"],
      {},
      undefined,
      minor
    );
    expect(merged.lines).toEqual(["a", "y3", "B", "c"]);
    // A real edit on both sides still stops.
    merged = mergeThreeWay(
      start,
      ["a", "y2", "X", "c"],
      ["a", "y3", "Z", "c"],
      {},
      undefined,
      minor
    );
    expect(merged.conflicts.length).toBe(1);
  });

  it("applies picks to a plan kept from one merge to the next", () => {
    const ours = ["a", "B", "c", "D", "e", "f", "g"];
    const theirs = ["a", "b2", "c", "d2", "e", "F", "g"];
    const plan = planThreeWay(base, ours, theirs);
    for (const picks of [{}, { 0: "theirs" }, { 0: "both", 1: "theirs" }]) {
      expect(applyThreeWay(plan, picks)).toEqual(
        mergeThreeWay(base, ours, theirs, picks)
      );
    }
    const merged = applyThreeWay(plan, { 1: "theirs" });
    expect(merged.lines).toEqual(["a", "B", "c", "d2", "e", "F", "g"]);
    expect(merged.conflicts.map((conflict) => conflict.pick)).toEqual([
      "ours",
      "theirs"
    ]);
    // Applying picks leaves the plan as it was.
    expect(applyThreeWay(plan).lines).toEqual([
      "a",
      "B",
      "c",
      "D",
      "e",
      "F",
      "g"
    ]);
  });

  it("takes identical changes once", () => {
    const side = ["a", "b", "X", "d", "e", "f", "g"];
    const merged = mergeThreeWay(base, side, side);
    expect(merged.conflicts).toEqual([]);
    expect(merged.lines).toEqual(side);
  });

  it("reports overlapping changes as conflicts, resolved by picks", () => {
    const ours = ["a", "b", "O", "d", "e", "f", "g"];
    const theirs = ["a", "b", "T", "T2", "e", "f", "g"];
    const merged = mergeThreeWay(base, ours, theirs);
    expect(merged.conflicts).toEqual([
      {
        index: 0,
        base: ["c", "d"],
        ours: ["O", "d"],
        theirs: ["T", "T2"],
        baseStart: 2,
        oursStart: 2,
        theirsStart: 2,
        pick: "ours"
      }
    ]);
    expect(merged.lines).toEqual(ours);
    // Where each side's lines start, even when earlier changes shift them.
    const oursShifted = ["x", ...ours];
    const theirsShifted = ["a", ...theirs.slice(2)];
    const [conflict] = mergeThreeWay(
      base,
      oursShifted,
      theirsShifted
    ).conflicts;
    expect(conflict.oursStart).toBeGreaterThan(conflict.theirsStart);
    expect(
      oursShifted.slice(
        conflict.oursStart,
        conflict.oursStart + conflict.ours.length
      )
    ).toEqual(conflict.ours);
    expect(
      theirsShifted.slice(
        conflict.theirsStart,
        conflict.theirsStart + conflict.theirs.length
      )
    ).toEqual(conflict.theirs);
    expect(mergeThreeWay(base, ours, theirs, { 0: "theirs" }).lines).toEqual(
      theirs
    );
    expect(mergeThreeWay(base, ours, theirs, { 0: "both" }).lines).toEqual([
      "a",
      "b",
      "O",
      "d",
      "T",
      "T2",
      "e",
      "f",
      "g"
    ]);
  });

  it("conflicts on insertions at the same point", () => {
    const merged = mergeThreeWay(
      base,
      ["a", "x", ...base.slice(1)],
      ["a", "y", ...base.slice(1)]
    );
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]).toMatchObject({
      base: [],
      ours: ["x"],
      theirs: ["y"]
    });
  });

  it("merges edits to different elements of a flow", () => {
    const edit = (label) => {
      const copy = JSON.parse(JSON.stringify(versions[3]));
      copy.Metadata.decisions[0].label = label;
      return copy;
    };
    const ours = edit("Ours");
    const theirs = JSON.parse(JSON.stringify(versions[3]));
    theirs.Metadata.recordLookups[0].label = "Theirs";
    const merged = mergeThreeWay(
      xmlLines(versions[3]),
      xmlLines(ours),
      xmlLines(theirs)
    );
    expect(merged.conflicts).toEqual([]);
    const both = JSON.parse(JSON.stringify(ours));
    both.Metadata.recordLookups[0].label = "Theirs";
    expect(merged.lines).toEqual(xmlLines(both));
  });

  it("merges edits to different lines of one text template", () => {
    const flow = (first, last) => {
      const copy = JSON.parse(JSON.stringify(versions[3]));
      copy.Metadata.textTemplates = [
        { name: "Note", text: `${first}\nThe middle\n${last}` }
      ];
      return toXml(normalize(copy.Metadata));
    };
    const original = flow("Hello", "Bye");
    const ours = flow("Hi", "Bye");
    const theirs = flow("Hello", "Goodbye");
    const merged = mergeThreeWay(
      original.lines,
      ours.lines,
      theirs.lines,
      {},
      {
        base: original.ranges,
        ours: ours.ranges,
        theirs: theirs.ranges
      }
    );
    expect(merged.conflicts).toEqual([]);
    expect(merged.lines.join("\n") + "\n").toBe(flow("Hi", "Goodbye").text);
  });
});
