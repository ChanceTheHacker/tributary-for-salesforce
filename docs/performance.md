# Large flows: what was measured and what changed

Tributary has to stay usable on flows of several hundred elements. This page records how it was measured, what was slow, what was fixed and what's left. Every flow measured is made up by `large()` and `revise()` in `test/fixtures/synthetic.js`. No org's metadata was used.

## How it's measured

- **The flows.** `large(size)` builds a flow of exactly `size` elements from repeating blocks:
  - a step;
  - a decision whose three outcomes meet again at a join;
  - a Loop with a step inside;
  - an Update Records whose fault path has its own handler.

  That gives it outcome, default, loop and fault connectors, not just a line. `revise()` makes a copy that changes every tenth assignment's label and value and can move every element sideways.

- **The merges.** A three-way merge takes `large(size)` as base. Ours changes assignments 0, 10, 20… and moves everything 40 px. Theirs changes 5, 15, 25… and moves everything 80 px. The sides never change the same thing, but both move every element.
- **The model tests.** `flowMerge/__tests__/flowMergeScale.test.js` covers 100, 300 and 600 elements. It takes the median of three runs after one warm-up. It fails if anything at 600 elements takes over 500 ms, a limit meant to catch work that grows with the square of the flow's size rather than a slow machine.
- **The view tests.** `flowMergeView/__tests__/flowMergeViewLarge.test.js` mounts the merge view on a 300-element three-way merge. It drives it the way a reviewer would: the change list, the stepper, arrow keys, Enter, find, and picking a side, then undo and redo. Each step's time includes one render.
- **Printing the timings.** `PERF=1 npx jest force-app/main/default/lwc/flowMerge/__tests__/flowMergeScale.test.js force-app/main/default/lwc/flowMergeView/__tests__/flowMergeViewLarge.test.js` prints them.

The numbers below are from Node 24 on a 32-thread workstation, 2026-09-27. The view runs in jsdom, which has no layout or paint. Its times are useful for comparing before with after, not as what a browser will show.

## Sizes

| Elements                | 100       | 300       | 600       |
| ----------------------- | --------- | --------- | --------- |
| Nodes / edges           | 101 / 139 | 301 / 419 | 601 / 839 |
| Resources               | 13        | 33        | 63        |
| Merge units (three-way) | 496       | 1,476     | 2,946     |
| Changed items to review | 14        | 42        | 84        |

A node count includes the start element. A merge unit is one thing a side can differ on: a field, a connector, a position, a resource.

## Model timings (ms, median of 3)

| Step                                              | 100  | 300  | 600  |
| ------------------------------------------------- | ---- | ---- | ---- |
| `createMerge`, three-way                          | 4.7  | 9.6  | 20.9 |
| `resolveMerge`, three-way                         | 2.5  | 6.9  | 13.5 |
| `mergeScene`, three-way                           | 1.2  | 3.0  | 5.5  |
| `diffFlows`                                       | 2.3  | 4.8  | 9.8  |
| `diffFlows`, every element moved and nothing else | 2.1  | 4.8  | 9.6  |
| `diffScene`                                       | 0.7  | 1.7  | 3.2  |
| `unitsForNode`, every element                     | <0.1 | <0.1 | <0.1 |
| `placePlan`, previewing a group of 20 elements    | 2.9  | 7.6  | 14.8 |
| `planMapping`, a flow a third the size            | 3.4  | 10.2 | 20.8 |
| `translateFlow`, the same                         | 3.1  | 9.0  | 20.0 |

Everything grows about in line with the flow's size.

## View timings, 300 elements (ms, jsdom)

| Step                           | Time    |
| ------------------------------ | ------- |
| Mount the three-way merge      | 133–220 |
| Open a change from the list    | 49      |
| Step to the next change        | 27      |
| Arrow down to the next element | 3       |
| Select it with Enter           | 21      |
| Open find, type                | 16, 15  |
| Next or previous match         | 21–24   |
| Close the element panel        | 34      |
| Pick a side for one change     | 35      |
| Undo, redo                     | 32, 36  |

## What was slow, and what changed

Measured at 600 elements before and after:

| Step                        | Before     | After   |
| --------------------------- | ---------- | ------- |
| `mergeScene`, three-way     | 65 ms      | 5.5 ms  |
| `diffScene`                 | 56 ms      | 3.2 ms  |
| `resolveMerge`, three-way   | 28 ms      | 13.5 ms |
| Merge view mount (jsdom)    | 331–447 ms | 269 ms  |
| Taking a side, undo (jsdom) | ~124 ms    | ~60 ms  |

Three things were comparing every element with every other:

- **Placing connector labels** (`flowScene`, `spreadLabels`) checked each label against every placed box. It now looks only at boxes in the same 240 px cells of a grid.
- **Separating overlapping elements** (`flowMerge`, `separate`) and **finding a clear spot** (`flowLayout`, `layoutAround`, `clearSpot`) checked each spot against every element. Both use `spotIndex` in `flowLayout`, which buckets positions by tile. A test checks it against looking at every position, with 400 random spots and four box sizes.
- **Finding an element's merge units** (`unitsForNode`) filtered every unit for each element that was drawn, picked or shown in the panel. It's now indexed once per merge and returns a copy.

## Keeping everything in step

The view tests found two places where what the reviewer sees disagreed. Both are fixed:

- **The stepper counted moves as changes.** In a merge where every element had moved, "Changed item N of M" counted every moved element, 300 of them, where the change list showed 42. Now both count only what changes what the flow does, unless **Show moved elements** is on. The diff view already did this.
- **Find's Enter skipped the first match.** Typing shows the first match without selecting it. With several matches, Enter went straight to the second, so the panel never showed the first. Enter now selects the match that's shown, then goes on to the next.

The view test checks that the canvas's selection and the element panel agree after each of these:

- a row in the change list;
- the stepper;
- arrow keys and Enter;
- each find match, forward and back;
- closing the panel.

The model tests check that a flow where only positions change diffs as layout-only, with no changed elements, and that its merge offers the moves to take without calling any of them a difference.

## What's left

- **Canvas redraws.** Sol's D-P4 is done: panning keeps the canvas's node, edge and label lists, and pointer and wheel moves land once a frame. A pan at 601 elements went from 17.8 ms to 5.7 ms in jsdom. What's left is LWC walking the canvas's template on each pan. Moving the scene into a child component would save that, at the cost of clicks, focus and keyboard stepping crossing a shadow boundary.
- **Auto-layout of skip-heavy flows.** Crossings are now counted in O(k log k), and a 300-step flow with long skip connectors lays out in 0.69 s rather than 1.06 s. A decision wired to every step of a long chain still makes work that grows with the square of the chain (Sol's V-D-3).
- **In the org.** `test/e2e/perf.js` times opening each page in tributary-dev, and `test/e2e/perf-interact.js` times clicks on the large three-way merge. Both run in a headless browser. Clicks take about 30 ms, the two frames the measurement takes. Opening a page takes 0.9–2.1 s at best, and most of that is the Lightning shell and Tooling API reads.
- **Metadata size.** The Tooling API returns a whole flow version in one response. A flow's size in the org, and callout limits on reading several versions, weren't measured here.
