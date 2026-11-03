import { createElement } from "lwc";
import FlowCanvas from "c/flowCanvas";
import { flowScene, diffScene, UNIFIED } from "c/flowScene";
import { buildModel } from "c/flowModel";
import { diffFlows } from "c/flowDiff";
import { TILE, NODE_WIDTH, NODE_HEIGHT } from "c/flowLayout";

const model = buildModel(require("fixtures/flows/Case_Email_Routing/v4.json"));

function mount(props = {}) {
  const element = createElement("c-flow-canvas", { is: FlowCanvas });
  Object.assign(element, props);
  document.body.appendChild(element);
  return element;
}

const flush = () => Promise.resolve();

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
});

describe("c-flow-canvas", () => {
  it("draws every element and connector", async () => {
    const scene = flowScene(model);
    const element = mount({ scene });
    await flush();
    const root = element.shadowRoot;
    expect(root.querySelectorAll(".node")).toHaveLength(scene.nodes.length);
    expect(root.querySelectorAll("path.edge-line")).toHaveLength(
      scene.edges.length
    );
    expect(root.querySelectorAll(".edge-label")).toHaveLength(
      scene.edges.filter((edge) => edge.label).length
    );
  });

  it("says how to pick elements together only where it can", async () => {
    const plain = mount({ scene: flowScene(model) });
    const merging = mount({ scene: flowScene(model), markedIds: [] });
    await flush();
    const label = (element) =>
      element.shadowRoot
        .querySelector("[role=application]")
        .getAttribute("aria-label");
    expect(label(plain)).not.toMatch(/Shift\+Enter/);
    expect(label(merging)).toMatch(/Shift\+Enter or Shift-click adds/);
  });

  it("tabs through elements from the start down the flow", async () => {
    const scene = flowScene(model);
    const element = mount({ scene });
    await flush();
    const tiles = [...element.shadowRoot.querySelectorAll(".node")];
    const positions = tiles.map((tile) => {
      const node = scene.nodes.find((item) => item.id === tile.dataset.id);
      return [node.y, node.x];
    });
    const sorted = [...positions].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(positions).toEqual(sorted);
    expect(tiles[0].getAttribute("aria-label")).toMatch(/Start/);
  });

  it("keeps only one element in the Tab order and follows arrow-key focus", async () => {
    const element = mount({ scene: flowScene(model) });
    await flush();
    const root = element.shadowRoot;
    const entry = () => root.querySelectorAll('.node[tabindex="0"]');
    expect(entry()).toHaveLength(1);
    entry()[0].focus();
    entry()[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown" })
    );
    await flush();
    expect(entry()).toHaveLength(1);
    expect(entry()[0]).toBe(root.activeElement);
    expect(entry()[0].dataset.id).toBe("recordLookups:Get_Routing");
    const scene = flowScene(model);
    element.scene = {
      ...scene,
      nodes: scene.nodes.filter((node) => node.id === "start:$Start"),
      edges: []
    };
    await flush();
    expect(entry()).toHaveLength(1);
    expect(entry()[0].dataset.id).toBe("start:$Start");
  });

  it("includes moved state in the element's accessible name", async () => {
    const scene = flowScene(model);
    const element = mount({
      scene: {
        ...scene,
        nodes: scene.nodes.map((node) => ({ ...node, moved: true }))
      }
    });
    await flush();
    expect(
      element.shadowRoot.querySelector(".node").getAttribute("aria-label")
    ).toContain("moved");
  });

  it("reveals invisible controls in node labels without changing flow metadata", async () => {
    const scene = flowScene(model);
    const label = "Add‮Promo‬​";
    const element = mount({
      scene: { ...scene, nodes: [{ ...scene.nodes[0], label }], edges: [] }
    });
    await flush();
    const node = element.shadowRoot.querySelector(".node");
    expect(node.textContent).toContain("Add⟦U+202E⟧Promo⟦U+202C⟧⟦U+200B⟧");
    expect(node.getAttribute("aria-label")).toContain("⟦U+202E⟧");
    expect(element.scene.nodes[0].label).toBe(label);
  });

  it("returns focus to the found element when Find closes", async () => {
    const element = mount({ scene: flowScene(model) });
    await flush();
    const root = element.shadowRoot;
    root.querySelector(".find-open").click();
    await flush();
    const input = root.querySelector(".find-input");
    input.value = "Get_Routing";
    input.dispatchEvent(new CustomEvent("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    expect(root.activeElement.dataset.id).toBe("recordLookups:Get_Routing");
    expect(root.activeElement.tabIndex).toBe(0);
  });

  it("styles elements by status and marks the selection", async () => {
    const edited = JSON.parse(
      JSON.stringify(require("fixtures/flows/Case_Email_Routing/v4.json"))
    );
    edited.Metadata.recordLookups[0].label = "Renamed";
    const diff = diffFlows(model, buildModel(edited));
    const scene = diffScene(diff, UNIFIED);
    const changed = scene.nodes.find((node) => node.status === "changed");
    const element = mount({ scene, selectedId: changed.id });
    await flush();
    const tile = element.shadowRoot.querySelector(`[data-id="${changed.id}"]`);
    expect(tile.className).toContain("status-changed");
    expect(tile.className).toContain("selected");
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    expect(tile.querySelector(".state-glyph").textContent).toBe("~");
    expect(tile.querySelector(".state-glyph").getAttribute("aria-hidden")).toBe(
      "true"
    );
    expect(tile.querySelector(".badge-changed").textContent).toBe(
      String(changed.changeCount)
    );
  });

  it("reports clicks on elements and on empty canvas", async () => {
    const scene = flowScene(model);
    const element = mount({ scene });
    const handler = jest.fn();
    element.addEventListener("select", handler);
    await flush();
    const node = element.shadowRoot.querySelector(".node");
    node.click();
    expect(handler.mock.calls[0][0].detail.id).toBe(node.dataset.id);
    node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(handler).toHaveBeenCalledTimes(2);

    const viewport = element.shadowRoot.querySelector(".viewport");
    const pointer = (type, x) => {
      const event = new MouseEvent(type, { clientX: x, clientY: 0, button: 0 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      viewport.dispatchEvent(event);
    };
    pointer("pointerdown", 0);
    pointer("pointerup", 0);
    expect(handler.mock.calls[2][0].detail.id).toBeNull();
  });

  it("pans on drag and follows a viewport it is given", async () => {
    const element = mount({ scene: flowScene(model) });
    const moves = jest.fn();
    element.addEventListener("viewportchange", moves);
    await flush();
    const viewport = element.shadowRoot.querySelector(".viewport");
    const pointer = (type, x) => {
      const event = new MouseEvent(type, { clientX: x, clientY: 0, button: 0 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      viewport.dispatchEvent(event);
    };
    pointer("pointerdown", 0);
    pointer("pointermove", 50);
    pointer("pointerup", 50);
    expect(moves.mock.calls.at(-1)[0].detail).toEqual({ x: 50, y: 0, zoom: 1 });

    element.viewport = { x: 10, y: 20, zoom: 0.5 };
    await flush();
    expect(element.shadowRoot.querySelector(".world").style.transform).toBe(
      "translate(10px, 20px) scale(0.5)"
    );
    expect(moves).toHaveBeenCalledTimes(1);
  });

  it("moves once a frame while dragging or wheeling, and lands where let go", async () => {
    jest.useFakeTimers();
    try {
      const element = mount({ scene: flowScene(model) });
      const moves = jest.fn();
      element.addEventListener("viewportchange", moves);
      await flush();
      const viewport = element.shadowRoot.querySelector(".viewport");
      const pointer = (type, x) => {
        const event = new MouseEvent(type, {
          clientX: x,
          clientY: 0,
          button: 0
        });
        Object.defineProperty(event, "pointerId", { value: 1 });
        viewport.dispatchEvent(event);
      };
      pointer("pointerdown", 0);
      pointer("pointermove", 20);
      pointer("pointermove", 40);
      expect(moves).not.toHaveBeenCalled();
      jest.runOnlyPendingTimers();
      expect(moves).toHaveBeenCalledTimes(1);
      expect(moves.mock.calls[0][0].detail).toEqual({ x: 40, y: 0, zoom: 1 });
      // Letting go before the next frame still lands on the last move.
      pointer("pointermove", 70);
      pointer("pointerup", 70);
      expect(moves).toHaveBeenCalledTimes(2);
      expect(moves.mock.calls[1][0].detail).toEqual({ x: 70, y: 0, zoom: 1 });
      jest.runOnlyPendingTimers();
      expect(moves).toHaveBeenCalledTimes(2);

      // Wheel steps between frames add up.
      const wheel = (deltaY) =>
        viewport.dispatchEvent(
          new WheelEvent("wheel", { deltaY, cancelable: true })
        );
      wheel(10);
      wheel(15);
      jest.runOnlyPendingTimers();
      expect(moves).toHaveBeenCalledTimes(3);
      expect(moves.mock.calls[2][0].detail).toEqual({
        x: 70,
        y: -25,
        zoom: 1
      });
      await flush();
      expect(element.shadowRoot.querySelector(".world").style.transform).toBe(
        "translate(70px, -25px) scale(1)"
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("doesn't rebuild the elements while panning, even while finding", async () => {
    const scene = flowScene(model);
    let reads = 0;
    // Counts each time the canvas works an element over from the scene.
    const nodes = scene.nodes.map((node) => {
      const { label, ...rest } = node;
      return Object.defineProperty(rest, "label", {
        enumerable: true,
        get() {
          reads += 1;
          return label;
        }
      });
    });
    const element = mount({ scene: { ...scene, nodes } });
    await flush();
    const root = element.shadowRoot;
    root.querySelector(".find-open").click();
    await flush();
    const input = root.querySelector(".find-input");
    input.value = "case";
    input.dispatchEvent(new CustomEvent("input"));
    await flush();
    const matches = root.querySelectorAll(".node.match").length;
    expect(matches).toBeGreaterThan(0);
    expect(root.querySelector(".find-count").textContent).toMatch(/^1 of \d+$/);

    reads = 0;
    for (let x = 1; x <= 5; x++) {
      element.viewport = { x, y: 0, zoom: 1 };
      // eslint-disable-next-line no-await-in-loop
      await flush();
    }
    expect(root.querySelector(".world").style.transform).toBe(
      "translate(5px, 0px) scale(1)"
    );
    expect(reads).toBe(0);
    expect(root.querySelectorAll(".node.match")).toHaveLength(matches);

    // Selecting still marks the element, without working the rest over.
    element.selectedId = nodes[0].id;
    await flush();
    expect(reads).toBe(0);
    expect(root.querySelector(".node.selected").dataset.id).toBe(nodes[0].id);
  });

  it("zooms from the toolbar and the keyboard", async () => {
    const element = mount({ scene: flowScene(model) });
    await flush();
    const buttons = element.shadowRoot.querySelectorAll(
      "lightning-button-group lightning-button-icon"
    );
    buttons[1].click();
    await flush();
    expect(element.shadowRoot.querySelector(".zoom").textContent).toBe("120%");
    const viewport = element.shadowRoot.querySelector(".viewport");
    viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "-" }));
    await flush();
    expect(element.shadowRoot.querySelector(".zoom").textContent).toBe("100%");
  });

  it("steps between elements with the arrow keys", async () => {
    const element = mount({ scene: flowScene(model) });
    const moves = jest.fn();
    element.addEventListener("viewportchange", moves);
    await flush();
    const root = element.shadowRoot;
    const tile = (id) =>
      [...root.querySelectorAll(".node")].find(
        (node) => node.dataset.id === id
      );
    const press = (key) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true
      });
      root.activeElement.dispatchEvent(event);
      return event;
    };
    const focused = () => root.activeElement.dataset.id;
    tile("start:$Start").focus();
    // Down follows connectors, taking the one most nearly straight ahead.
    expect(press("ArrowDown").defaultPrevented).toBe(true);
    expect(focused()).toBe("recordLookups:Get_Routing");
    press("ArrowDown");
    press("ArrowDown");
    expect(focused()).toBe("decisions:Should_Case_Be_Updated");
    press("ArrowDown");
    expect(focused()).toBe("recordUpdates:Update_Case_Record");
    // Across to the other outcome, then back up its connector.
    press("ArrowRight");
    expect(focused()).toBe("recordUpdates:Unhandled_Case_Update");
    press("ArrowUp");
    expect(focused()).toBe("decisions:Should_Case_Be_Updated");
    press("Home");
    expect(focused()).toBe("start:$Start");
    // Nothing further up: focus stays put.
    press("ArrowUp");
    expect(focused()).toBe("start:$Start");
    press("End");
    expect(focused()).toBe("recordUpdates:Unhandled_Case_Update");
    // Stepping neither pans the canvas nor selects anything.
    expect(moves).not.toHaveBeenCalled();
  });

  it("finds elements by name or type and steps through them", async () => {
    const element = mount({ scene: flowScene(model) });
    const selected = jest.fn();
    element.addEventListener("select", selected);
    await flush();
    const root = element.shadowRoot;
    expect(root.querySelector(".find")).toBeNull();
    root.querySelector(".viewport").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "/",
        bubbles: true,
        cancelable: true
      })
    );
    await flush();
    const input = root.querySelector(".find-input");
    expect(root.activeElement).toBe(input);
    input.value = "update";
    input.dispatchEvent(new CustomEvent("input"));
    await flush();
    const count = () => root.querySelector(".find-count").textContent;
    // By name, API name and type, in the order Tab takes.
    expect(count()).toBe("1 of 3");
    expect(root.querySelector(".frame").classList).toContain("finding");
    const matched = [...root.querySelectorAll(".node.match")].map(
      (node) => node.dataset.id
    );
    expect(matched).toEqual([
      "decisions:Should_Case_Be_Updated",
      "recordUpdates:Update_Case_Record",
      "recordUpdates:Unhandled_Case_Update"
    ]);
    expect(root.querySelector(".match-current").dataset.id).toBe(
      "decisions:Should_Case_Be_Updated"
    );
    const key = (name, shiftKey = false) =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, shiftKey, cancelable: true })
      );
    // Enter selects the match shown, then goes on to the next.
    key("Enter");
    await flush();
    expect(count()).toBe("1 of 3");
    expect(selected.mock.calls[0][0].detail.id).toBe(
      "decisions:Should_Case_Be_Updated"
    );
    key("Enter");
    await flush();
    expect(count()).toBe("2 of 3");
    expect(selected.mock.calls[1][0].detail.id).toBe(
      "recordUpdates:Update_Case_Record"
    );
    key("Enter", true);
    key("Enter", true);
    await flush();
    expect(count()).toBe("3 of 3");

    input.value = "nothing here";
    input.dispatchEvent(new CustomEvent("input"));
    await flush();
    expect(count()).toBe("No matches");
    expect(root.querySelector(".find-next").disabled).toBe(true);

    key("Escape");
    await flush();
    expect(root.querySelector(".find")).toBeNull();
    expect(root.querySelector(".frame").classList).not.toContain("finding");
    expect(root.activeElement).toBe(root.querySelector(".viewport"));
  });

  describe("with a size", () => {
    beforeEach(() => {
      jest
        .spyOn(HTMLElement.prototype, "clientWidth", "get")
        .mockReturnValue(800);
      jest
        .spyOn(HTMLElement.prototype, "clientHeight", "get")
        .mockReturnValue(500);
    });
    afterEach(() => jest.restoreAllMocks());
    const transform = (element) =>
      element.shadowRoot.querySelector(".world").style.transform;

    it("fits again when a fitted flow changes shape, not when moved", async () => {
      const element = mount({ scene: flowScene(model) });
      await flush();
      const first = transform(element);
      const other = buildModel(require("fixtures/flows/Analyze_Flows/v1.json"));
      element.scene = flowScene(other);
      await flush();
      await flush();
      expect(transform(element)).not.toBe(first);

      element.viewport = { x: 5, y: 5, zoom: 1 };
      element.scene = flowScene(model);
      await flush();
      await flush();
      expect(transform(element)).toBe("translate(5px, 5px) scale(1)");
    });

    it("starts a flow too tall to read whole at its top", async () => {
      const scene = flowScene(model);
      const tall = {
        ...scene,
        bounds: { x: 0, y: 0, width: 400, height: 5000 }
      };
      const element = mount({ scene: tall });
      await flush();
      await flush();
      expect(transform(element)).toBe("translate(270px, 0px) scale(0.65)");
      // Asked to, it still shows the whole flow.
      element.fit(false);
      await flush();
      expect(transform(element)).toBe("translate(370px, 0px) scale(0.15)");
    });

    it("frames both changed destinations with their source while they remain readable", async () => {
      const scene = flowScene(model);
      const nodes = scene.nodes.slice(0, 3).map((node, index) => ({
        ...node,
        x: index * 200,
        y: index ? 280 : 0
      }));
      const edges = nodes.slice(1).map((node, index) => ({
        ...scene.edges[0],
        id: `path${index}`,
        sourceId: nodes[0].id,
        targetId: node.id,
        status: index ? "added" : "removed"
      }));
      const element = mount({ scene: { ...scene, nodes, edges } });
      await flush();
      element.viewport = { x: -2000, y: -2000, zoom: 1 };
      expect(element.reveal(nodes[0].id)).toBe(true);
      const { x, y, zoom } = element.viewport;
      expect(zoom).toBeGreaterThanOrEqual(0.65);
      for (const node of nodes) {
        expect(
          x + (node.x - (NODE_WIDTH - TILE) / 2) * zoom
        ).toBeGreaterThanOrEqual(47.9);
        expect(
          x + (node.x + (NODE_WIDTH + TILE) / 2) * zoom
        ).toBeLessThanOrEqual(752.1);
        expect(y + node.y * zoom).toBeGreaterThanOrEqual(47.9);
        expect(y + (node.y + NODE_HEIGHT) * zoom).toBeLessThanOrEqual(404.1);
      }
      element.scene = {
        ...scene,
        nodes: nodes.map((node, i) => ({ ...node, y: i ? 5000 : 0 })),
        edges
      };
      element.viewport = { x: -2000, y: -2000, zoom: 0.8 };
      element.reveal(nodes[0].id);
      expect(element.viewport.zoom).toBe(0.8);
      expect(element.viewport.y).toBeCloseTo(166.7);
    });

    it("only moves to reveal an element that's out of sight", async () => {
      const scene = flowScene(model);
      const element = mount({ scene });
      await flush();
      const moves = jest.fn();
      element.addEventListener("viewportchange", moves);
      const [node] = scene.nodes;
      element.viewport = {
        x: 400 - (node.x + 24) * 0.8,
        y: 100 - node.y * 0.8,
        zoom: 0.8
      };
      element.reveal(node.id);
      expect(moves).not.toHaveBeenCalled();
      element.viewport = { x: -5000, y: 0, zoom: 0.8 };
      element.reveal(node.id);
      expect(moves).toHaveBeenCalledTimes(1);
      expect(moves.mock.calls[0][0].detail.zoom).toBe(0.8);
    });
  });

  it("says when there is nothing to draw", async () => {
    const element = mount({ emptyMessage: "Pick a flow" });
    await flush();
    expect(element.shadowRoot.querySelector(".empty").textContent).toBe(
      "Pick a flow"
    );
  });
});
