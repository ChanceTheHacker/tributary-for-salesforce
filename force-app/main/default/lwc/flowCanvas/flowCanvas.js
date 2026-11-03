/**
 * Draws a scene from flowScene: elements as icon tiles with their labels,
 * connectors as curves underneath. Drag to pan, Ctrl/⌘ + wheel to zoom,
 * wheel to scroll; arrow keys, + and - and 0 do the same from the keyboard.
 * On a focused element the arrow keys step to the next one instead: down and
 * up along its connectors, left and right to its neighbours; Home and End go
 * to the first and last. / or Ctrl/⌘ + F finds elements by name or type.
 *
 * Events:
 *   select          { id, key, type } for a clicked element, { id: null }
 *                   for a click on empty canvas
 *   viewportchange  { x, y, zoom } after the user pans or zooms, so another
 *                   canvas can follow (set its viewport property). Moves the
 *                   canvas makes itself (fit, reveal, the zoom buttons) also
 *                   carry animate: true, and glide rather than jump;
 *                   fitting also carries fit: true.
 *
 * A fitted canvas fits again when it's resized; one the user has moved keeps
 * its centre where it was.
 */
import { LightningElement, api } from "lwc";
import { TILE, NODE_WIDTH, NODE_HEIGHT } from "c/flowLayout";
import { visibleText } from "c/flowUtils";

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2;
const STEP = 1.2;
// Below this, element labels are too small to read, so reveal zooms in.
const READABLE_ZOOM = 0.65;
const PAN_STEP = 60;
const GRID = 24;
// Room kept along the bottom when fitting, so the zoom controls and a legend
// sit below the flow rather than over it.
const CONTROLS_HEIGHT = 48;

const STATUS_TEXT = {
  added: "added",
  removed: "removed",
  changed: "changed",
  excluded: "not in the result"
};

const STATUS_GLYPH = { added: "+", removed: "−", changed: "~", excluded: "×" };

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// Unit steps for the arrow keys on an element.
const STEPS = {
  ArrowDown: [0, 1],
  ArrowUp: [0, -1],
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0]
};

// The words a find matches: name, API name (also with spaces for
// underscores) and type.
function findText(node) {
  return [
    node.label,
    node.apiName,
    (node.apiName || "").replace(/_/g, " "),
    node.typeLabel
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function sameBounds(a, b) {
  return Boolean(
    a &&
    b &&
    ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) < 1)
  );
}

export default class FlowCanvas extends LightningElement {
  @api selectedId;
  /** Ids of elements picked together (shift- or ctrl-click), shown selected. */
  @api markedIds;
  @api dimUnchanged = false;
  @api label = "Flow canvas";
  @api emptyMessage = "Nothing to show.";

  view = { x: 0, y: 0, zoom: 1 };
  _scene;
  _fitted = false;
  _pendingView;
  _drag;
  _wheelBound;
  _glide = false;
  _rendered = false;
  _flash;
  _flashCount = 0;
  // The view is a fit, so a resize fits again.
  _fitView = false;
  _observer;
  _lastSize;
  finding = false;
  findText = "";
  _findId;
  // Whether the current match has been selected, or only shown.
  _findPicked = false;
  _focusFind = false;
  _focusId;
  // A pointer or wheel move waiting for the next frame, and that frame.
  _queued;
  _frame;
  // Derived data, filled while rendering; not reactive.
  _cache = {};

  @api
  get scene() {
    return this._scene;
  }
  set scene(value) {
    const before = this._scene && this._scene.bounds;
    this._scene = value;
    if (!value || !value.nodes || !value.nodes.length) {
      return;
    }
    // A fitted view fits again when the flow changes shape (a swap, another
    // flow); a view the user moved stays where they put it.
    if (!this._fitted || (this._fitView && !sameBounds(before, value.bounds))) {
      this._needsFit = true;
    }
  }

  /**
   * The current { x, y, zoom }. Setting it moves the canvas without an event;
   * animate: true makes it glide there.
   */
  @api
  get viewport() {
    return this.view;
  }
  set viewport(value) {
    if (!value) {
      return;
    }
    this._glide = Boolean(value.animate) && this._rendered;
    this._fitView = Boolean(value.fit);
    const next = {
      x: Number(value.x) || 0,
      y: Number(value.y) || 0,
      zoom: clamp(Number(value.zoom) || 1, MIN_ZOOM, MAX_ZOOM)
    };
    if (
      next.x !== this.view.x ||
      next.y !== this.view.y ||
      next.zoom !== this.view.zoom
    ) {
      // Being moved somewhere else wins over a move still waiting.
      this.dropQueued();
      this.view = next;
    }
    this._fitted = true;
    this._needsFit = false;
  }

  /**
   * Zooms and pans so the whole flow fits. `placing` is the canvas placing
   * a flow itself: one too tall to read whole then starts at its top, as
   * wide as fits but no smaller than it can be read.
   */
  @api
  fit(animate = this._fitted, placing = false) {
    const size = this.size();
    const bounds = this._scene && this._scene.bounds;
    if (!bounds || !size.width || !size.height) {
      return false;
    }
    const height = Math.max(size.height - CONTROLS_HEIGHT, size.height / 2);
    const across = Math.min(size.width / bounds.width, 1);
    let zoom = clamp(
      Math.min(across, height / bounds.height),
      MIN_ZOOM,
      MAX_ZOOM
    );
    const start = placing && zoom < Math.min(across, READABLE_ZOOM);
    if (start) {
      zoom = Math.min(across, READABLE_ZOOM);
    }
    const x = (size.width - bounds.width * zoom) / 2 - bounds.x * zoom;
    const y =
      bounds.height * zoom < height
        ? Math.max(0, (height - bounds.height * zoom) / 3) - bounds.y * zoom
        : -bounds.y * zoom;
    // The first fit places the flow; later ones are the user asking.
    this.setView({ x, y, zoom }, true, animate, true);
    this._placed = placing;
    this._fitted = true;
    return true;
  }

  /**
   * Flashes an element and frames its changed outgoing destinations when
   * they fit at a readable zoom; otherwise reveals just the element.
   */
  @api
  reveal(id) {
    if (!this.bringIntoView(id, true)) {
      return false;
    }
    // Alternating the class restarts the animation for a repeat reveal.
    this._flashCount += 1;
    this._flash = { id, className: `flash-${this._flashCount % 2}` };
    return true;
  }

  bringIntoView(id, includeConnections = false) {
    const node = this._scene && this._scene.nodes.find((n) => n.id === id);
    const size = this.size();
    if (!node || !size.width) {
      return false;
    }
    const { x, y, zoom: current } = this.view;
    const left = x + (node.x - (NODE_WIDTH - TILE) / 2) * current;
    const top = y + node.y * current;
    const margin = Math.min(48, size.width / 8, size.height / 8);
    if (includeConnections) {
      const targets = new Set(
        (this._scene.edges || [])
          .filter(
            (edge) =>
              edge.sourceId === id &&
              ["added", "removed", "changed"].includes(edge.status)
          )
          .map((edge) => edge.targetId)
      );
      const context = this._scene.nodes.filter(
        (item) => item.id === id || targets.has(item.id)
      );
      if (context.length > 1) {
        const minX =
          Math.min(...context.map((item) => item.x)) - (NODE_WIDTH - TILE) / 2;
        const maxX =
          Math.max(...context.map((item) => item.x)) + (NODE_WIDTH + TILE) / 2;
        const minY = Math.min(...context.map((item) => item.y));
        const maxY = Math.max(
          ...context.map(
            (item) => item.y + NODE_HEIGHT + (item.pickLabel ? 16 : 0)
          )
        );
        const width = size.width - 2 * margin;
        const height = size.height - CONTROLS_HEIGHT - 2 * margin;
        const fit = Math.min(width / (maxX - minX), height / (maxY - minY));
        // Show the changed path's endpoints together when still readable.
        // A distant destination mustn't make the selected element microscopic.
        if (fit >= READABLE_ZOOM) {
          const zoom = Math.min(fit, current < READABLE_ZOOM ? 0.8 : current);
          const visible =
            current >= READABLE_ZOOM &&
            x + minX * current >= margin &&
            x + maxX * current <= size.width - margin &&
            y + minY * current >= margin &&
            y + maxY * current <= size.height - CONTROLS_HEIGHT - margin;
          if (!visible)
            this.setView(
              {
                x: size.width / 2 - ((minX + maxX) / 2) * zoom,
                y:
                  (size.height - CONTROLS_HEIGHT) / 2 -
                  ((minY + maxY) / 2) * zoom,
                zoom
              },
              true,
              true
            );
          return true;
        }
      }
    }
    const inSight =
      left >= margin &&
      top >= margin &&
      left + NODE_WIDTH * current <= size.width - margin &&
      top + NODE_HEIGHT * current <= size.height - CONTROLS_HEIGHT - margin;
    if (!inSight || current < READABLE_ZOOM) {
      const zoom = current < READABLE_ZOOM ? 0.8 : current;
      this.setView(
        {
          x: size.width / 2 - (node.x + TILE / 2) * zoom,
          y: size.height / 3 - node.y * zoom,
          zoom
        },
        true,
        true
      );
    }
    return true;
  }

  renderedCallback() {
    this._rendered = true;
    const viewport = this.refs.viewport;
    if (viewport && !this._wheelBound) {
      this._wheelBound = (event) => this.handleWheel(event);
      viewport.addEventListener("wheel", this._wheelBound, { passive: false });
    }
    if (viewport && !this._observer && typeof ResizeObserver === "function") {
      this._observer = new ResizeObserver(() => this.handleResize());
      this._observer.observe(viewport);
    }
    if (this._needsFit && this.fit(this._fitted, true)) {
      this._needsFit = false;
    }
    if (this._focusFind && this.refs.find) {
      this._focusFind = false;
      this.refs.find.focus();
      this.refs.find.select();
    }
  }

  disconnectedCallback() {
    this.dropQueued();
    if (this._wheelBound && this.refs.viewport) {
      this.refs.viewport.removeEventListener("wheel", this._wheelBound);
    }
    this._wheelBound = undefined;
    if (this._observer) {
      this._observer.disconnect();
      this._observer = undefined;
    }
  }

  // Also runs when a hidden canvas is shown, which is when a canvas that
  // mounted hidden gets its first fit.
  handleResize() {
    const size = this.size();
    const last = this._lastSize;
    this._lastSize = size;
    if (!size.width || !size.height) {
      return;
    }
    if (this._needsFit) {
      if (this.fit(this._fitted, true)) {
        this._needsFit = false;
      }
      return;
    }
    if (!this._fitted || !last || !last.width || !last.height) {
      return;
    }
    if (size.width === last.width && size.height === last.height) {
      return;
    }
    if (this._fitView) {
      this.fit(false, this._placed);
      return;
    }
    // Without an event: a canvas beside this one moves by the same amount.
    this.setView(
      {
        x: this.view.x + (size.width - last.width) / 2,
        y: this.view.y + (size.height - last.height) / 2,
        zoom: this.view.zoom
      },
      false
    );
  }

  size() {
    const viewport = this.refs.viewport;
    return viewport
      ? { width: viewport.clientWidth, height: viewport.clientHeight }
      : { width: 0, height: 0 };
  }

  setView(view, notify, animate = false, fitting = false) {
    this.dropQueued();
    this._glide = animate;
    this._fitView = fitting;
    this.view = {
      x: Math.round(view.x * 10) / 10,
      y: Math.round(view.y * 10) / 10,
      zoom: clamp(view.zoom, MIN_ZOOM, MAX_ZOOM)
    };
    if (notify) {
      const detail = { ...this.view };
      if (animate) {
        detail.animate = true;
      }
      if (fitting) {
        detail.fit = true;
      }
      this.dispatchEvent(new CustomEvent("viewportchange", { detail }));
    }
  }

  // Pointer and wheel moves come faster than frames. Each one replaces the
  // last, and the canvas moves (and tells a canvas beside it) once a frame.
  queueView(view) {
    this._queued = view;
    if (typeof requestAnimationFrame !== "function") {
      this.flushView();
      return;
    }
    if (!this._frame) {
      // eslint-disable-next-line @lwc/lwc/no-async-operation
      this._frame = requestAnimationFrame(() => {
        this._frame = undefined;
        this.flushView();
      });
    }
  }

  flushView() {
    const view = this._queued;
    if (view) {
      this.setView(view, true);
    }
  }

  dropQueued() {
    this._queued = undefined;
    if (this._frame) {
      cancelAnimationFrame(this._frame);
      this._frame = undefined;
    }
  }

  // Where the canvas is going: a queued move counts, so a second wheel
  // step before the frame adds to the first.
  get nextView() {
    return this._queued || this.view;
  }

  handleGlideEnd(event) {
    if (event.target === event.currentTarget) {
      this._glide = false;
    }
  }

  zoomAround(factor, point, animate = false) {
    const size = this.size();
    const at = point || { x: size.width / 2, y: size.height / 2 };
    const from = this.nextView;
    const zoom = clamp(from.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const scale = zoom / from.zoom;
    const view = {
      x: at.x - (at.x - from.x) * scale,
      y: at.y - (at.y - from.y) * scale,
      zoom
    };
    // The wheel zooms by many small steps; the buttons glide by one.
    if (animate) {
      this.setView(view, true, true);
    } else {
      this.queueView(view);
    }
  }

  zoomIn() {
    this.zoomAround(STEP, undefined, true);
  }

  zoomOut() {
    this.zoomAround(1 / STEP, undefined, true);
  }

  handleFit() {
    this.fit();
  }

  handleWheel(event) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const box = this.refs.viewport.getBoundingClientRect();
      this.zoomAround(Math.exp(-event.deltaY * 0.002), {
        x: event.clientX - box.left,
        y: event.clientY - box.top
      });
      return;
    }
    const scale = event.deltaMode === 1 ? 16 : 1;
    const from = this.nextView;
    this.queueView({
      x: from.x - event.deltaX * scale,
      y: from.y - event.deltaY * scale,
      zoom: from.zoom
    });
  }

  handlePointerDown(event) {
    if (event.button !== 0 || event.target.closest(".node")) {
      return;
    }
    this._drag = {
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      view: { ...this.view },
      moved: false
    };
    if (event.currentTarget.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  handlePointerMove(event) {
    const drag = this._drag;
    if (!drag || drag.pointer !== event.pointerId) {
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) {
      return;
    }
    drag.moved = true;
    this.queueView({
      x: drag.view.x + dx,
      y: drag.view.y + dy,
      zoom: drag.view.zoom
    });
  }

  handlePointerUp(event) {
    const drag = this._drag;
    if (!drag || drag.pointer !== event.pointerId) {
      return;
    }
    this._drag = undefined;
    // Letting go lands exactly where the pointer was.
    this.flushView();
    if (!drag.moved && event.type === "pointerup") {
      this.dispatchEvent(new CustomEvent("select", { detail: { id: null } }));
    }
  }

  handleKeyDown(event) {
    if (event.target !== event.currentTarget) {
      return;
    }
    const moves = {
      ArrowLeft: [PAN_STEP, 0],
      ArrowRight: [-PAN_STEP, 0],
      ArrowUp: [0, PAN_STEP],
      ArrowDown: [0, -PAN_STEP]
    };
    if (moves[event.key]) {
      const [dx, dy] = moves[event.key];
      this.setView(
        { x: this.view.x + dx, y: this.view.y + dy, zoom: this.view.zoom },
        true,
        true
      );
    } else if (event.key === "+" || event.key === "=") {
      this.zoomIn();
    } else if (event.key === "-") {
      this.zoomOut();
    } else if (event.key === "0") {
      this.fit();
    } else {
      return;
    }
    event.preventDefault();
  }

  handleNodeFocus(event) {
    this._focusId = event.currentTarget.dataset.id;
  }

  handleNodeClick(event) {
    this.selectNode(event.currentTarget.dataset.id, event);
  }

  handleNodeKey(event) {
    const id = event.currentTarget.dataset.id;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.selectNode(id, event);
      return;
    }
    let next;
    if (STEPS[event.key]) {
      next = this.neighbour(id, STEPS[event.key]);
    } else if (event.key === "Home" || event.key === "End") {
      const ordered = this.ordered();
      next = ordered[event.key === "Home" ? 0 : ordered.length - 1].id;
    } else {
      return;
    }
    event.preventDefault();
    if (next && next !== id) {
      this.focusNode(next);
    }
  }

  /**
   * The element an arrow key steps to. Down and up follow connectors first,
   * taking the one most nearly straight ahead, so a path reads in order;
   * otherwise it's the nearest element that way, favouring ones in line.
   */
  neighbour(id, [dx, dy]) {
    const nodes = this._scene.nodes;
    const from = nodes.find((node) => node.id === id);
    if (!from) {
      return undefined;
    }
    const ahead = (node) => (node.x - from.x) * dx + (node.y - from.y) * dy;
    const aside = (node) =>
      Math.abs((node.x - from.x) * dy) + Math.abs((node.y - from.y) * dx);
    const nearest = (candidates, weight) => {
      let best;
      let bestScore = Infinity;
      for (const node of candidates) {
        const score = ahead(node) + aside(node) * weight;
        if (ahead(node) > 0 && score < bestScore) {
          best = node;
          bestScore = score;
        }
      }
      return best && best.id;
    };
    if (dy) {
      const linked = new Set(
        (this._scene.edges || [])
          .filter((edge) =>
            dy > 0 ? edge.sourceId === id : edge.targetId === id
          )
          .map((edge) => (dy > 0 ? edge.targetId : edge.sourceId))
      );
      const along = nearest(
        nodes.filter((node) => linked.has(node.id)),
        1
      );
      if (along) {
        return along;
      }
    }
    return nearest(nodes, 3);
  }

  focusNode(id) {
    const tile = [...this.template.querySelectorAll(".node")].find(
      (candidate) => candidate.dataset.id === id
    );
    if (tile) {
      this.bringIntoView(id);
      tile.focus({ preventScroll: true });
    }
  }

  // Find

  handleFrameKey(event) {
    const find =
      event.key === "/" ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f");
    if (!find || event.target === this.refs.find || this.isEmpty) {
      return;
    }
    event.preventDefault();
    this.openFind();
  }

  openFind() {
    this.finding = true;
    this._focusFind = true;
  }

  closeFind() {
    const found = this._findPicked && this._findId;
    this.finding = false;
    this.findText = "";
    this._findId = undefined;
    this._findPicked = false;
    if (found) {
      this.focusNode(found);
    } else if (this.refs.viewport) {
      this.refs.viewport.focus();
    }
  }

  handleFindInput(event) {
    this.findText = event.target.value;
    const [first] = this.matchIds;
    if (first !== this._findId) {
      this._findId = first;
      this._findPicked = false;
      if (first) {
        this.reveal(first);
      }
    }
  }

  handleFindKey(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      this.stepMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      // Closes the find, not a dialog around the canvas.
      event.preventDefault();
      event.stopPropagation();
      this.closeFind();
    }
  }

  findNext() {
    this.stepMatch(1);
  }

  findPrevious() {
    this.stepMatch(-1);
  }

  /**
   * Moves to the next or previous match, and selects it. The match typing
   * went to is only shown, so going forward selects it first: the panel
   * never lags behind the count.
   */
  stepMatch(delta) {
    const ids = this.matchIds;
    if (!ids.length) {
      return;
    }
    const at = ids.indexOf(this._findId);
    if (at >= 0 && delta > 0 && !this._findPicked) {
      this._findPicked = true;
      this.reveal(this._findId);
      this.selectNode(this._findId);
      return;
    }
    this._findPicked = true;
    const index =
      at < 0
        ? delta > 0
          ? 0
          : ids.length - 1
        : (at + delta + ids.length) % ids.length;
    this._findId = ids[index];
    this.reveal(this._findId);
    this.selectNode(this._findId);
  }

  get findWords() {
    return this.findText.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  // A derived value kept until one of its inputs changes: panning renders
  // every frame, and only moves the view.
  memo(name, inputs, build) {
    const entry = this._cache[name];
    if (entry && entry.inputs.every((input, i) => input === inputs[i])) {
      return entry.value;
    }
    const value = build();
    this._cache[name] = { inputs, value };
    return value;
  }

  // Each element's words to find by, in the order Tab takes.
  get findTexts() {
    const ordered = this.ordered();
    return this.memo("findTexts", [ordered], () =>
      ordered.map((node) => ({ id: node.id, text: findText(node) }))
    );
  }

  /** Matching elements, in the order Tab takes. */
  get matchIds() {
    if (this.isEmpty) {
      return [];
    }
    const texts = this.findTexts;
    const find = this.findText.trim().toLowerCase();
    return this.memo("matchIds", [texts, find], () => {
      const words = find.split(/\s+/).filter(Boolean);
      if (!words.length) {
        return [];
      }
      return texts
        .filter(({ text }) => words.every((word) => text.includes(word)))
        .map(({ id }) => id);
    });
  }

  get noMatches() {
    return !this.matchIds.length;
  }

  get findCount() {
    if (!this.findWords.length) {
      return "";
    }
    const ids = this.matchIds;
    if (!ids.length) {
      return "No matches";
    }
    const at = ids.indexOf(this._findId);
    return at < 0
      ? `${ids.length} match${ids.length === 1 ? "" : "es"}`
      : `${at + 1} of ${ids.length}`;
  }

  // Top to bottom, then left to right: Tab follows the flow, not the data.
  ordered() {
    const nodes = this._scene.nodes;
    return this.memo("ordered", [nodes], () =>
      [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)
    );
  }

  // With shift, ctrl or cmd held, the element is added to (or taken out
  // of) what's picked rather than replacing it.
  selectNode(id, event) {
    const node = this._scene.nodes.find((candidate) => candidate.id === id);
    if (node) {
      const additive = Boolean(
        event && (event.shiftKey || event.ctrlKey || event.metaKey)
      );
      this.dispatchEvent(
        new CustomEvent("select", {
          detail: { id, key: node.key, type: node.type, additive }
        })
      );
    }
  }

  get isEmpty() {
    return !this._scene || !this._scene.nodes || !this._scene.nodes.length;
  }

  get frameClass() {
    return [
      "frame",
      this.dimUnchanged ? "dim-unchanged" : "",
      this.findWords.length ? "finding" : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  get viewportClass() {
    return this._glide ? "viewport glide" : "viewport";
  }

  get worldClass() {
    return this._glide ? "world glide" : "world";
  }

  get ariaLabel() {
    // Where elements can be picked together (a merge marks them), say how.
    const together = this.markedIds
      ? " Shift+Enter or Shift-click adds an element to those picked together."
      : "";
    return `${this.label}. Drag or use the arrow keys to move, plus and minus to zoom, 0 to fit, slash to find. On an element, the arrow keys step between elements.${together}`;
  }

  get zoomText() {
    return `${Math.round(this.view.zoom * 100)}%`;
  }

  get worldStyle() {
    const { x, y, zoom } = this.view;
    return `transform: translate(${x}px, ${y}px) scale(${zoom});`;
  }

  get viewportStyle() {
    const { x, y, zoom } = this.view;
    const size = GRID * zoom;
    return `background-size: ${size}px ${size}px; background-position: ${x}px ${y}px;`;
  }

  get bounds() {
    return (
      (this._scene && this._scene.bounds) || {
        x: 0,
        y: 0,
        width: 1,
        height: 1
      }
    );
  }

  get svgStyle() {
    const { x, y } = this.bounds;
    return `left: ${x}px; top: ${y}px;`;
  }

  get svgWidth() {
    return Math.ceil(this.bounds.width);
  }

  get svgHeight() {
    return Math.ceil(this.bounds.height);
  }

  get svgTransform() {
    const { x, y } = this.bounds;
    return `translate(${-x} ${-y})`;
  }

  get edges() {
    if (this.isEmpty) {
      return [];
    }
    const edges = this._scene.edges;
    return this.memo("edges", [edges], () =>
      edges.map((edge) => ({
        ...edge,
        className: [
          "edge",
          `edge-${edge.status}`,
          `kind-${edge.kind}`,
          edge.isGoTo ? "goto" : ""
        ]
          .filter(Boolean)
          .join(" ")
      }))
    );
  }

  get edgeLabels() {
    if (this.isEmpty) {
      return [];
    }
    const edges = this._scene.edges;
    return this.memo("edgeLabels", [edges], () =>
      edges
        .filter((edge) => edge.label)
        .map((edge) => ({
          id: edge.id,
          label: visibleText(edge.label),
          labelClass: `edge-label edge-label-${edge.status} kind-${edge.kind}`,
          labelStyle: `left: ${edge.labelX}px; top: ${edge.labelY}px;`
        }))
    );
  }

  // What each element shows that only the scene decides: kept while the
  // selection, find and view change.
  get nodeRecords() {
    const ordered = this.ordered();
    return this.memo("nodeRecords", [ordered], () =>
      ordered.map((node) => {
        const badges = [];
        if (node.conflict) {
          badges.push({
            key: "conflict",
            text: "!",
            className: "badge badge-conflict",
            title: "Changed differently on both sides; pick one"
          });
        }
        if (node.errors) {
          badges.push({
            key: "errors",
            text: String(node.errors),
            className: "badge badge-error",
            title: `${node.errors} problem${node.errors === 1 ? "" : "s"} to fix before saving`
          });
        }
        if (node.warnings && !node.errors) {
          badges.push({
            key: "warnings",
            text: String(node.warnings),
            className: "badge badge-warning",
            title: `${node.warnings} warning${node.warnings === 1 ? "" : "s"}`
          });
        }
        if (node.status === "changed" && node.changeCount) {
          badges.push({
            key: "changes",
            text: String(node.changeCount),
            className: "badge badge-changed",
            title: `${node.changeCount} field${node.changeCount === 1 ? "" : "s"} changed`
          });
        }
        const status = STATUS_TEXT[node.status];
        return {
          ...node,
          label: visibleText(node.label),
          badges,
          statusGlyph: STATUS_GLYPH[node.status],
          statusTitle: status,
          baseClass: [
            "node",
            `status-${node.status}`,
            node.conflict ? "has-conflict" : ""
          ]
            .filter(Boolean)
            .join(" "),
          style: `left: ${node.x - (NODE_WIDTH - TILE) / 2}px; top: ${node.y}px; width: ${NODE_WIDTH}px;`,
          pickTitle: node.availableFrom
            ? `Only in ${node.pickLabel}; open it to add it`
            : `Taken from ${node.pickLabel}`,
          ariaLabel: [
            node.typeLabel,
            visibleText(node.label),
            status,
            node.moved ? "moved" : "",
            node.conflict ? "conflict" : "",
            ...badges
              .filter(
                (badge) => badge.key === "errors" || badge.key === "warnings"
              )
              .map((badge) => badge.title)
          ]
            .filter(Boolean)
            .join(", ")
        };
      })
    );
  }

  get nodes() {
    if (this.isEmpty) {
      return [];
    }
    const records = this.nodeRecords;
    const matchIds = this.matchIds;
    const {
      selectedId,
      markedIds,
      _flash: flash,
      _findId: findId,
      _focusId: focusId
    } = this;
    return this.memo(
      "nodes",
      [records, matchIds, selectedId, markedIds, flash, findId, focusId],
      () => {
        const entry = [focusId, selectedId, records[0].id].find((id) =>
          records.some((record) => record.id === id)
        );
        const matches = new Set(matchIds);
        const finding = this.findWords.length > 0;
        const marked = new Set(markedIds || []);
        return records.map((record) => {
          const selected = record.id === selectedId || marked.has(record.id);
          return {
            ...record,
            tabIndex: record.id === entry ? 0 : -1,
            pressed: selected ? "true" : "false",
            className: [
              record.baseClass,
              selected ? "selected" : "",
              flash && flash.id === record.id ? flash.className : "",
              finding && matches.has(record.id) ? "match" : "",
              finding && record.id === findId ? "match-current" : ""
            ]
              .filter(Boolean)
              .join(" ")
          };
        });
      }
    );
  }
}
