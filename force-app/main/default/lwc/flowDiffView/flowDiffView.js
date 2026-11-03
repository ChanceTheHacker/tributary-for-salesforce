/**
 * The visual diff of two flows: both canvases side by side (panning
 * together), one combined canvas, or the XML. Selecting an element shows
 * what changed in it; with nothing selected the side panel lists resources
 * and flow properties.
 */
import { LightningElement, api } from "lwc";
import { diffFlows, UNCHANGED } from "c/flowDiff";
import { resourceInfo } from "c/flowElements";
import { fillWindow, humanPath } from "c/flowUtils";
import {
  diffLayout,
  diffScene,
  diffCounts,
  BEFORE,
  AFTER,
  UNIFIED
} from "c/flowScene";

const SPLIT = "split";
const TEXT = "text";

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

export default class FlowDiffView extends LightningElement {
  /** Names for each side, e.g. { before: "Version 3", after: "Version 4" }. */
  @api labels = {};

  mode = SPLIT;
  textLayout = "unified";
  dimUnchanged = false;
  showMoved = true;
  resourcesOpen = false;
  selection;
  // What Previous/Next reached, for screen readers.
  announcement = "";
  wrapNotice = "";
  viewport;
  _before;
  _after;
  // Derived data, filled while rendering; not reactive.
  _cache = {};
  _pendingReveal;

  /** Flow metadata (or Tooling Flow records) for each side. */
  @api
  get before() {
    return this._before;
  }
  set before(value) {
    this._before = value;
    this.reset();
  }

  @api
  get after() {
    return this._after;
  }
  set after(value) {
    this._after = value;
    this.reset();
  }

  /** "split", "unified" or "text". */
  @api
  get view() {
    return this.mode;
  }
  set view(value) {
    this.mode = [SPLIT, UNIFIED, TEXT].includes(value) ? value : SPLIT;
  }

  /** Review position carried by a shareable comparison link. */
  @api
  get selectedElement() {
    return this.selectedId;
  }
  set selectedElement(value) {
    if (value === this.selectedId) return;
    if (this.diff) this.restoreSelection(value);
    else this._linkedId = value || null;
  }

  restoreSelection(id) {
    this.wrapNotice = "";
    const kind = this.diff.nodes.some((entry) => entry.id === id)
      ? "node"
      : this.diff.resources.some((entry) => entry.id === id)
        ? "resource"
        : undefined;
    this.selection = kind ? { kind, id } : undefined;
    if (kind) this._pendingReveal = id;
  }

  @api
  get xmlLayout() {
    return this.textLayout;
  }
  set xmlLayout(value) {
    this.textLayout = value === SPLIT ? SPLIT : UNIFIED;
  }

  reset() {
    this._cache.diff = undefined;
    this.selection = undefined;
    this.wrapNotice = "";
    this.viewport = undefined;
  }

  get diff() {
    const cache = this._cache;
    if (!cache.diff && this._before && this._after) {
      cache.diff = diffFlows(this._before, this._after);
      cache.layout = diffLayout(cache.diff);
    }
    return cache.diff;
  }

  get ready() {
    return Boolean(this.diff);
  }

  label(side) {
    return (this.labels && this.labels[side]) || side;
  }

  get beforeLabel() {
    return this.label(BEFORE);
  }

  get afterLabel() {
    return this.label(AFTER);
  }

  get beforeMetadata() {
    return this.diff.before.metadata || this._before.Metadata || this._before;
  }

  get afterMetadata() {
    return this.diff.after.metadata || this._after.Metadata || this._after;
  }

  // A scene routes every connector, so each view's is built once for its
  // diff and moved setting; panning and selecting re-render without it.
  scene(view) {
    const cache = this._cache;
    const inputs = [this.diff, this.showMoved];
    if (!cache.scenes || cache.scenes.inputs.some((v, i) => v !== inputs[i])) {
      cache.scenes = { inputs, byView: {} };
    }
    const byView = cache.scenes.byView;
    if (!byView[view]) {
      byView[view] = diffScene(this.diff, view, {
        layout: cache.layout,
        showMoved: this.showMoved
      });
    }
    return byView[view];
  }

  get beforeScene() {
    return this.scene(BEFORE);
  }

  get afterScene() {
    return this.scene(AFTER);
  }

  get unifiedScene() {
    return this.scene(UNIFIED);
  }

  get isSplit() {
    return this.mode === SPLIT;
  }

  get isUnified() {
    return this.mode === UNIFIED;
  }

  get isText() {
    return this.mode === TEXT;
  }

  get notText() {
    return this.mode !== TEXT;
  }

  get modeOptions() {
    return [
      { label: "Side by side", value: SPLIT },
      { label: "Combined", value: UNIFIED },
      { label: "XML", value: TEXT }
    ];
  }

  get counts() {
    return diffCounts(this.diff);
  }

  get pills() {
    const counts = this.counts;
    return [
      { key: "added", text: `${counts.added} added`, count: counts.added },
      {
        key: "removed",
        text: `${counts.removed} removed`,
        count: counts.removed
      },
      {
        key: "changed",
        text: `${counts.changed} changed`,
        count: counts.changed
      },
      {
        key: "moved",
        text: `${counts.moved} moved`,
        count: this.showMoved ? counts.moved : 0
      },
      {
        key: "connectors",
        text: plural(counts.connectors, "connector change"),
        count: counts.connectors
      },
      {
        key: "resources",
        text: plural(counts.resources, "resource change"),
        count: counts.resources
      },
      {
        key: "properties",
        text: plural(counts.properties, "flow property change"),
        count: counts.properties
      }
    ]
      .filter((pill) => pill.count > 0)
      .map((pill) => ({ ...pill, className: `pill pill-${pill.key}` }));
  }

  get notice() {
    if (this.diff.identical) {
      return "These flows are identical.";
    }
    if (this.diff.layoutOnly) {
      return "Only the positions of elements on the canvas differ; the logic is the same.";
    }
    return undefined;
  }

  // Everything Previous/Next steps through: changed elements in reading
  // order, then changed resources as the side panel lists them, then flow
  // properties. An element whose connectors changed counts too, so a
  // reconnection can be stepped to.
  get steps() {
    const scene = this.unifiedScene;
    const memo = this._cache.steps;
    if (!memo || memo.scene !== scene) {
      this._cache.steps = { scene, value: this.buildSteps(scene) };
    }
    return this._cache.steps.value;
  }

  buildSteps(scene) {
    const changed = new Set(
      this.diff.nodes
        .filter(
          (entry) =>
            entry.status !== UNCHANGED || (this.showMoved && entry.moved)
        )
        .map((entry) => entry.id)
    );
    const reconnected = new Set(
      this.diff.edges
        .filter((edge) => edge.status !== UNCHANGED)
        .map((edge) => edge.source)
    );
    const nodes = scene.nodes
      .filter((node) => changed.has(node.id) || reconnected.has(node.key))
      .sort((p, q) => p.y - q.y || p.x - q.x)
      .map((node) => ({ kind: "node", id: node.id, name: node.label }));
    const resources = this.diff.resources
      .filter((entry) => entry.status !== UNCHANGED)
      .map((entry) => ({
        kind: "resource",
        id: entry.id,
        name: `${entry.key}, resource`,
        type: resourceInfo(entry.after || entry.before).label
      }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
    const props = this.diff.props.map((change, index) => ({
      kind: "prop",
      id: `${index}`,
      name: `${humanPath(change.path)}, flow property`
    }));
    return [...nodes, ...resources, ...props];
  }

  get stepIndex() {
    const { selection } = this;
    return selection
      ? this.steps.findIndex(
          (step) => step.kind === selection.kind && step.id === selection.id
        )
      : -1;
  }

  get noChanges() {
    return this.steps.length === 0;
  }

  get position() {
    const count = this.steps.length;
    const index = this.stepIndex;
    return index < 0 ? `${count} to review` : `${index + 1} of ${count}`;
  }

  get selectedId() {
    return this.selection && this.selection.kind !== "prop"
      ? this.selection.id
      : undefined;
  }

  get selectedProp() {
    return this.selection && this.selection.kind === "prop"
      ? this.selection.id
      : undefined;
  }

  get selectedEntry() {
    if (!this.selection) {
      return undefined;
    }
    const list =
      this.selection.kind === "resource"
        ? this.diff.resources
        : this.diff.nodes;
    return list.find((entry) => entry.id === this.selection.id);
  }

  get selectedKind() {
    return this.selection && this.selection.kind;
  }

  get hasSelection() {
    return Boolean(this.selectedEntry);
  }

  get sideOpen() {
    return this.resourcesOpen || Boolean(this.selection);
  }

  get sideClass() {
    return this.sideOpen ? "side side-open" : "side";
  }

  get resourcesLabel() {
    return this.sideOpen ? "Hide details" : "Resources and properties";
  }

  handleResources() {
    const open = !this.sideOpen;
    if (!open) this.select(undefined, undefined, false);
    this.resourcesOpen = open;
  }

  get beforeCanvasLabel() {
    return `${this.beforeLabel} flow canvas`;
  }

  get afterCanvasLabel() {
    return `${this.afterLabel} flow canvas`;
  }

  connectedCallback() {
    this._onResize = () => this.fitHeight();
    window.addEventListener("resize", this._onResize);
  }

  disconnectedCallback() {
    window.removeEventListener("resize", this._onResize);
  }

  // The canvases run to the bottom of the window, so the page needn't scroll.
  fitHeight() {
    fillWindow(this.refs.body);
  }

  renderedCallback() {
    this.fitHeight();
    if (this.diff && this._linkedId !== undefined) {
      const id = this._linkedId;
      this._linkedId = undefined;
      this.restoreSelection(id);
    }
    if (this.diff && this._initialDiff !== this.diff) {
      this._initialDiff = this.diff;
      const changed = this.diff.nodes.find((node) => node.status !== UNCHANGED);
      const edge = this.diff.edges.find((item) => item.status !== UNCHANGED);
      const first =
        changed ||
        (edge && this.diff.nodes.find((node) => node.key === edge.source));
      if (first && !this.selection) this._pendingReveal = first.id;
    }
    if (this._pendingReveal) {
      const id = this._pendingReveal;
      this._pendingReveal = undefined;
      this.reveal(id);
    }
  }

  reveal(id) {
    if (this.isText) {
      const text = this.template.querySelector("c-flow-text-diff");
      if (text) {
        text.reveal(id);
      }
      return;
    }
    for (const canvas of this.template.querySelectorAll("c-flow-canvas")) {
      canvas.reveal(id);
    }
  }

  select(kind, id, reveal) {
    this.wrapNotice = "";
    this.selection = id ? { kind, id } : undefined;
    if (id && reveal) {
      this._pendingReveal = id;
    }
    this.dispatchEvent(
      new CustomEvent("selectionchange", { detail: { id: this.selectedId } })
    );
  }

  handleMode(event) {
    this.mode = event.detail.value;
    // The combined canvas is a different shape: fit it afresh.
    this.viewport = undefined;
    if (this.selection && this.selection.kind === "node") {
      this._pendingReveal = this.selection.id;
    }
    this.notifyView();
  }

  notifyView() {
    this.dispatchEvent(
      new CustomEvent("viewchange", {
        detail: { view: this.mode, layout: this.textLayout }
      })
    );
  }

  handleDim(event) {
    this.dimUnchanged = event.target.checked;
  }

  handleMoved(event) {
    this.wrapNotice = "";
    this.showMoved = event.target.checked;
  }

  handleCanvasSelect(event) {
    this.select("node", event.detail.id, false);
  }

  handleViewport(event) {
    this.viewport = event.detail;
  }

  handleResourceSelect(event) {
    this.select("resource", event.detail.id, false);
  }

  handleTextSelect(event) {
    const id = event.detail.id;
    const isResource = this.diff.resources.some((entry) => entry.id === id);
    const isNode = this.diff.nodes.some((entry) => entry.id === id);
    if (isResource || isNode) {
      this.select(isResource ? "resource" : "node", id, false);
    }
  }

  handleTextLayout(event) {
    this.textLayout = event.detail.layout;
    this.notifyView();
  }

  handleShowText(event) {
    this.mode = TEXT;
    this._pendingReveal = event.detail.id;
    this.notifyView();
  }

  handleClose() {
    this.select(undefined, undefined, false);
  }

  step(delta) {
    const { steps } = this;
    if (!steps.length) {
      return;
    }
    const count = steps.length;
    const index = this.stepIndex;
    let next = index < 0 ? (delta > 0 ? 0 : count - 1) : index + delta;
    const wrap =
      (next >= count && ", back to the start") ||
      (next < 0 && ", back to the end") ||
      "";
    next = (next + count) % count;
    const target = steps[next];
    this.announcement = `${next + 1} of ${count}: ${target.name}${wrap}`;
    this.select(target.kind, target.id, target.kind !== "prop");
    this.wrapNotice = wrap ? `Review wrapped${wrap}.` : "";
  }

  handlePrevious() {
    this.step(-1);
  }

  handleNext() {
    this.step(1);
  }
}
