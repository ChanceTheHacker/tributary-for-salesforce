import { createElement } from "lwc";
import FlowCompareApp from "c/flowCompareApp";
import { CurrentPageReference, navigate } from "lightning/navigation";

jest.mock("lightning/navigation", () => {
  const actual = jest.requireActual("lightning/navigation");
  const mockNavigate = jest.fn();
  const NavigationMixin = (Base) =>
    class extends actual.NavigationMixin(Base) {
      [actual.NavigationMixin.Navigate](...args) {
        mockNavigate(...args);
      }
    };
  Object.assign(NavigationMixin, actual.NavigationMixin);
  return { ...actual, NavigationMixin, navigate: mockNavigate };
});
import getUserContext from "@salesforce/apex/FlowCompareController.getUserContext";
import listConnections from "@salesforce/apex/FlowCompareController.listConnections";
import listFlows from "@salesforce/apex/FlowCompareController.listFlows";
import listVersions from "@salesforce/apex/FlowCompareController.listVersions";
import getVersion from "@salesforce/apex/FlowCompareController.getVersion";
import getVersionByName from "@salesforce/apex/FlowCompareController.getVersionByName";

jest.mock(
  "@salesforce/apex/FlowCompareController.getUserContext",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareController.listConnections",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareController.listFlows",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareController.listVersions",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareController.getVersion",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareController.getVersionByName",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareController.saveVersion",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareController.saveAsNewFlow",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.getFlowStatus",
  () => ({
    default: jest.fn(() =>
      Promise.resolve({ canActivate: true, canRequest: true, pending: [] })
    )
  }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.requestActivation",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.activateVersion",
  () => ({ default: jest.fn() }),
  { virtual: true }
);

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const FLOW = {
  definitionId: "300A",
  apiName: "Case_Email_Routing",
  label: "Case Email Routing",
  activeVersion: 4,
  latestVersion: 4,
  managed: false,
  governanceMode: "Locked",
  ownerName: "Jo Owner"
};

const VERSIONS = [1, 2, 3, 4].map((number) => ({
  id: `301V${number}`,
  versionNumber: number,
  status: number === 4 ? "Active" : "Obsolete",
  lastModifiedBy: "Sam"
}));

const record = (number) =>
  JSON.stringify(require(`fixtures/flows/Case_Email_Routing/v${number}.json`));

const $ = (element, selector) => element.shadowRoot.querySelector(selector);

function mount() {
  const element = createElement("c-flow-compare-app", { is: FlowCompareApp });
  document.body.appendChild(element);
  return element;
}

beforeEach(() => {
  getUserContext.mockResolvedValue({
    userName: "Admin",
    isAdmin: true,
    canSave: true,
    canRequest: true
  });
  listConnections.mockResolvedValue([
    { name: "local", label: "This org", isLocal: true, canSave: true },
    { name: "Staging", label: "Staging", canSave: true }
  ]);
  listFlows.mockResolvedValue([FLOW]);
  listVersions.mockResolvedValue(VERSIONS);
  getVersion.mockImplementation(({ versionId }) =>
    Promise.resolve(record(versionId.replace("301V", "")))
  );
  getVersionByName.mockResolvedValue(null);
});

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
  jest.clearAllMocks();
});

describe("c-flow-compare-app", () => {
  it("compares the active version with the one before it when a flow is picked", async () => {
    const element = mount();
    await flush();
    expect(listFlows).toHaveBeenCalledWith({ connection: "local" });
    $(element, ".flow-a").dispatchEvent(
      new CustomEvent("change", { detail: { value: "Case_Email_Routing" } })
    );
    await flush();
    expect($(element, ".version-a").value).toBe("3");
    expect($(element, ".version-b").value).toBe("4");
    const diff = $(element, "c-flow-diff-view");
    expect(diff).not.toBeNull();
    expect(diff.labels.before).toBe("Version 3");
    expect(diff.labels.after).toBe("Version 4 (active)");
    expect(diff.before.processType).toBeDefined();
    expect($(element, ".details").textContent).toMatch(
      /Approval required, owned by Jo Owner/
    );
  });

  it("swaps A and B with a labelled button, and says what Obsolete means", async () => {
    const element = mount();
    await flush();
    $(element, ".flow-a").dispatchEvent(
      new CustomEvent("change", { detail: { value: "Case_Email_Routing" } })
    );
    await flush();
    const labels = $(element, ".version-a").options.map((o) => o.label);
    expect(labels).toContainEqual(
      expect.stringMatching(/^Version 1 · Obsolete \(was active\)/)
    );
    expect(labels).toContainEqual(expect.stringMatching(/^Version 4 · Active/));

    const swap = $(element, ".swap-button");
    expect(swap.getAttribute("aria-label")).toBe("Swap A and B");
    expect(swap.textContent).toContain("Swap");
    swap.click();
    await flush();
    expect($(element, ".version-a").value).toBe("4");
    expect($(element, ".version-b").value).toBe("3");
  });

  it("asks once for each list a link needs, and for each version as last saved", async () => {
    listVersions.mockResolvedValue(
      VERSIONS.map((version) => ({
        ...version,
        lastModifiedDate: `2026-09-0${version.versionNumber}T10:00:00.000Z`
      }))
    );
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: { c__flow: "Case_Email_Routing", c__va: "1", c__vb: "2" }
    });
    await flush();
    expect($(element, "c-flow-diff-view")).not.toBeNull();
    expect(listFlows).toHaveBeenCalledTimes(1);
    expect(listVersions).toHaveBeenCalledTimes(1);
    expect(getVersion).toHaveBeenCalledWith({
      connection: "local",
      versionId: "301V1",
      modified: "2026-09-01T10:00:00.000Z"
    });
  });

  it("opens a link again when trying again after it failed", async () => {
    listVersions.mockRejectedValueOnce({ body: { message: "Read timed out" } });
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: { c__flow: "Case_Email_Routing", c__va: "1", c__vb: "2" }
    });
    await flush();
    expect($(element, ".error-text").textContent).toBe("Read timed out");
    $(element, ".error lightning-button").click();
    await flush();
    expect($(element, ".error")).toBeNull();
    expect($(element, ".version-a").value).toBe("1");
    expect($(element, ".version-b").value).toBe("2");
  });

  it("restores and updates shareable comparison view state", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: {
        c__flow: "Case_Email_Routing",
        c__va: "3",
        c__vb: "4",
        c__view: "text",
        c__layout: "split",
        c__selected: "recordLookups:Get_Routing"
      }
    });
    await flush();
    const view = $(element, "c-flow-diff-view");
    expect(view.view).toBe("text");
    expect(view.xmlLayout).toBe("split");
    expect(view.selectedElement).toBe("recordLookups:Get_Routing");
    view.dispatchEvent(
      new CustomEvent("viewchange", {
        detail: { view: "unified", layout: "unified" }
      })
    );
    view.dispatchEvent(
      new CustomEvent("selectionchange", { detail: { id: undefined } })
    );
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: {
          c__flow: "Case_Email_Routing",
          c__va: "3",
          c__vb: "4",
          c__view: "unified"
        }
      }),
      true
    );
  });

  it("keeps the request linked only to the loaded comparison", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: {
        c__flow: FLOW.apiName,
        c__va: "3",
        c__vb: "4",
        c__request: "a01Review"
      }
    });
    await flush();
    const approval = $(element, "c-flow-approvals");
    expect(approval.embedded).toBe(true);
    expect(approval.requestId).toBe("a01Review");
    expect(approval.comparison.a.apiName).toBe(FLOW.apiName);
    expect(approval.comparison.versionA.versionNumber).toBe(3);
    expect(approval.comparison.versionB.versionNumber).toBe(4);
    $(element, "c-flow-diff-view").dispatchEvent(
      new CustomEvent("viewchange", {
        detail: { view: "text", layout: "split" }
      })
    );
    expect(navigate.mock.calls.at(-1)[0].state.c__request).toBe("a01Review");
    $(element, 'button[data-tab="merge"]').click();
    await flush();
    expect(navigate.mock.calls.at(-1)[0].state.c__request).toBe("a01Review");
    $(element, ".version-b").dispatchEvent(
      new CustomEvent("change", { detail: { value: "2" } })
    );
    await flush();
    expect($(element, "c-flow-approvals")).toBeNull();
    expect(navigate.mock.calls.at(-1)[0].state.c__request).toBeUndefined();
  });

  it("doesn't bind an approval to a substituted version from an invalid link", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: {
        c__flow: FLOW.apiName,
        c__va: "99",
        c__vb: "4",
        c__request: "a01Review"
      }
    });
    await flush();
    expect($(element, ".error-text")).not.toBeNull();
    expect($(element, "c-flow-approvals").comparison).toBeUndefined();
  });

  it("collapses narrow comparison fields without remounting the merge or pickers", async () => {
    const previous = window.matchMedia;
    window.matchMedia = jest.fn(() => ({ matches: true }));
    try {
      const element = mount();
      await flush();
      expect($(element, ".pickers").hidden).toBe(false);
      $(element, ".flow-a").dispatchEvent(
        new CustomEvent("change", { detail: { value: FLOW.apiName } })
      );
      await flush();
      expect($(element, ".pickers").hidden).toBe(true);
      $(element, 'button[data-tab="merge"]').click();
      await flush();
      const merge = $(element, "c-flow-merge-view");
      const picker = $(element, ".version-b");
      const toggle = $(element, ".picker-toggle");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      toggle.click();
      await flush();
      expect($(element, ".pickers").hidden).toBe(false);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect($(element, "c-flow-merge-view")).toBe(merge);
      expect($(element, ".version-b")).toBe(picker);
      expect(picker.value).toBe("4");
    } finally {
      window.matchMedia = previous;
    }
  });

  it("shows version authors and descriptions without hiding direction controls", async () => {
    listVersions.mockResolvedValue(
      VERSIONS.map((version) => ({
        ...version,
        createdBy: "Builder",
        description: "Review‮text"
      }))
    );
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: { c__flow: FLOW.apiName }
    });
    await flush();
    expect($(element, ".version-a").options[0].description).toBe(
      "Builder · Review⟦U+202E⟧text"
    );
    expect($(element, ".details").textContent).toContain("Review⟦U+202E⟧text");
  });

  it("opens the comparison a link describes", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "ns__Flow_Compare" },
      state: {
        c__flow: "Case_Email_Routing",
        c__va: "1",
        c__vb: "2",
        c__base: "1",
        c__tab: "merge"
      }
    });
    await flush();
    const merge = $(element, "c-flow-merge-view");
    expect(merge).not.toBeNull();
    expect(Object.keys(merge.sides).sort()).toEqual(["base", "ours", "theirs"]);
    expect(merge.labels.base).toBe("Version 1 (base)");
    expect(merge.canSave).toBe(true);
    expect(merge.targets).toEqual([
      {
        connection: "local",
        apiName: "Case_Email_Routing",
        label: "Case Email Routing",
        activeVersion: 4,
        latestVersion: 4
      }
    ]);
    // What the merge was made from, for its receipt.
    expect(
      merge.lineage.map((source) => [source.role, source.versionId])
    ).toEqual([
      ["base", "301V1"],
      ["ours", "301V1"],
      ["theirs", "301V2"]
    ]);
    expect(merge.lineage[2]).toEqual(
      expect.objectContaining({
        label: "Version 2",
        connection: "local",
        connectionLabel: "This org",
        apiName: "Case_Email_Routing",
        versionNumber: 2,
        lastModifiedBy: "Sam"
      })
    );
  });

  it("compares again when saving was refused, with the newest versions", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: {
        c__flow: "Case_Email_Routing",
        c__va: "3",
        c__vb: "4",
        c__tab: "merge"
      }
    });
    await flush();
    // Someone saved version 5 meanwhile.
    listFlows.mockResolvedValue([{ ...FLOW, latestVersion: 5 }]);
    listVersions.mockResolvedValue([
      ...VERSIONS,
      { id: "301V5", versionNumber: 5, status: "Draft", lastModifiedBy: "Ada" }
    ]);
    getVersion.mockImplementation(({ versionId }) =>
      Promise.resolve(
        record(versionId === "301V5" ? 4 : versionId.replace("301V", ""))
      )
    );
    const calls = listVersions.mock.calls.length;
    $(element, "c-flow-merge-view").dispatchEvent(new CustomEvent("recompare"));
    await flush();
    expect(listVersions.mock.calls.length).toBeGreaterThan(calls);
    expect($(element, "c-flow-merge-view").targets[0].latestVersion).toBe(5);
    expect($(element, ".version-b").value).toBe("5");
    expect($(element, "c-flow-merge-view").lineage[1].versionId).toBe("301V5");
  });

  it("points to mapping when two different flows are to be picked", async () => {
    const element = mount();
    await flush();
    expect($(element, ".empty-text").textContent).not.toMatch(/Mapping/);
    $(element, ".modes").dispatchEvent(
      new CustomEvent("change", { detail: { value: "flows" } })
    );
    await flush();
    expect($(element, ".empty-title").textContent).toBe(
      "Pick a flow on each side"
    );
    expect($(element, ".empty-text").textContent).toMatch(
      /open Merge: its Mapping tab matches what B uses/
    );
  });

  it("compares a flow across two orgs", async () => {
    const element = mount();
    await flush();
    $(element, ".modes").dispatchEvent(
      new CustomEvent("change", { detail: { value: "orgs" } })
    );
    await flush();
    $(element, ".flow-a").dispatchEvent(
      new CustomEvent("change", { detail: { value: "Case_Email_Routing" } })
    );
    await flush();
    expect($(element, ".connection-b").value).toBe("Staging");
    expect($(element, ".flow-b").value).toBe("Case_Email_Routing");
    expect(listFlows).toHaveBeenCalledWith({ connection: "Staging" });
    // The flow is the same, so each side is named by its org.
    const diff = $(element, "c-flow-diff-view");
    expect(diff.labels.before).toBe("This org v4");
    expect(diff.labels.after).toBe("Staging v4");
  });

  it("pairs a flow across orgs that each put their own namespace on it", async () => {
    listFlows.mockImplementation(({ connection }) =>
      Promise.resolve([
        {
          ...FLOW,
          apiName: `${connection === "Staging" ? "cllc" : "trib"}__Case_Email_Routing`
        }
      ])
    );
    const element = mount();
    await flush();
    $(element, ".modes").dispatchEvent(
      new CustomEvent("change", { detail: { value: "orgs" } })
    );
    await flush();
    $(element, ".flow-a").dispatchEvent(
      new CustomEvent("change", {
        detail: { value: "trib__Case_Email_Routing" }
      })
    );
    await flush();
    expect($(element, ".flow-b").value).toBe("cllc__Case_Email_Routing");
    expect($(element, "c-flow-diff-view").labels.after).toBe("Staging v4");
  });

  it("merges one flow across two namespaced orgs as one flow", async () => {
    listFlows.mockImplementation(({ connection }) =>
      Promise.resolve([
        {
          ...FLOW,
          apiName: `${connection === "Staging" ? "cllc" : "trib"}__Case_Email_Routing`
        }
      ])
    );
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "trib__Flow_Compare" },
      state: {
        c__mode: "orgs",
        c__connB: "Staging",
        c__flow: "Case_Email_Routing",
        c__va: "3",
        c__vb: "4",
        c__tab: "merge"
      }
    });
    await flush();
    const sides = $(element, "c-flow-merge-view").sides;
    expect(sides.before.FullName).toBe("Case_Email_Routing");
    expect(sides.after.FullName).toBe("Case_Email_Routing");
  });

  it("doesn't pair a flow with a packaged flow of the same name", async () => {
    listFlows.mockImplementation(({ connection }) =>
      Promise.resolve([
        connection === "Staging"
          ? { ...FLOW, apiName: "pkg__Case_Email_Routing", managed: true }
          : FLOW
      ])
    );
    const element = mount();
    await flush();
    $(element, ".modes").dispatchEvent(
      new CustomEvent("change", { detail: { value: "orgs" } })
    );
    await flush();
    $(element, ".flow-a").dispatchEvent(
      new CustomEvent("change", { detail: { value: "Case_Email_Routing" } })
    );
    await flush();
    expect($(element, ".flow-b").value).toBeFalsy();
  });

  it("offers activation of both sides", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: {
        c__flow: "Case_Email_Routing",
        c__va: "3",
        c__vb: "4",
        c__tab: "activate"
      }
    });
    await flush();
    const panels = element.shadowRoot.querySelectorAll("c-flow-activation");
    expect(panels.length).toBe(2);
    expect(panels[0].versionNumber).toBe(4);
    expect(panels[0].changeSummary).toBe(
      "Compared with Version 3: 1 connector changed."
    );
    // Approvers open the comparison the summary describes.
    expect(panels[0].comparedVersion).toBe(3);
    expect(panels[1].versionNumber).toBe(3);
    expect(panels[1].comparedVersion).toBeNull();
  });

  it("offers the merge's saved version for activation", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: {
        c__flow: "Case_Email_Routing",
        c__va: "3",
        c__vb: "4",
        c__tab: "merge"
      }
    });
    await flush();
    listVersions.mockResolvedValue([
      ...VERSIONS,
      { id: "301V5", versionNumber: 5, status: "Draft", lastModifiedBy: "Sam" }
    ]);
    $(element, "c-flow-merge-view").dispatchEvent(
      new CustomEvent("saved", {
        detail: {
          result: {
            apiName: "Case_Email_Routing",
            versionNumber: 5,
            lastModifiedDate: "2026-09-27T12:00:00.000Z"
          },
          connection: "local",
          label: "Case Email Routing",
          summary: "Merged Version 3 and Version 4: 1 difference."
        }
      })
    );
    await flush();
    $(element, 'button[data-tab="activate"]').click();
    await flush();
    const panels = [
      ...element.shadowRoot.querySelectorAll("c-flow-activation")
    ];
    expect(panels.map((panel) => panel.versionNumber)).toEqual([5, 4, 3]);
    expect(panels[0].changeSummary).toBe(
      "Merged Version 3 and Version 4: 1 difference."
    );
    expect(panels[0].reviewedAt).toBe("2026-09-27T12:00:00.000Z");
    // Saving the same merge again doesn't count its own version as one it
    // left out.
    expect($(element, "c-flow-merge-view").targets[0].latestVersion).toBe(5);
    expect(panels[0].secondary).toBe(false);
    // Every card explains the same governance state consistently.
    expect(panels[1].secondary).toBe(true);
    expect(panels[1].brief).toBe(false);
  });

  it("keeps the merge on screen while a save refreshes the lists", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: {
        c__flow: "Case_Email_Routing",
        c__va: "3",
        c__vb: "4",
        c__tab: "merge"
      }
    });
    await flush();
    const view = $(element, "c-flow-merge-view");
    let finish;
    listFlows.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    view.dispatchEvent(
      new CustomEvent("saved", {
        detail: {
          result: { apiName: "Case_Email_Routing", versionNumber: 5 },
          connection: "local",
          label: "Case Email Routing"
        }
      })
    );
    await flush();
    // The same merge view, with its picks and open save dialog, not a
    // skeleton that remounts it.
    expect($(element, "c-flow-merge-view")).toBe(view);
    expect($(element, ".busy-bar")).not.toBeNull();
    expect($(element, ".skeleton-bar")).toBeNull();
    finish([FLOW]);
    await flush();
    expect($(element, "c-flow-merge-view")).toBe(view);
  });

  it("doesn't offer another flow's baseline for activation", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: {
        c__mode: "flows",
        c__flow: "Case_Email_Routing",
        c__flowB: "Case_Email_Routing",
        c__va: "3",
        c__vb: "4",
        c__tab: "activate"
      }
    });
    await flush();
    const panels = element.shadowRoot.querySelectorAll("c-flow-activation");
    expect(panels.length).toBe(1);
    expect(panels[0].versionNumber).toBe(4);
    expect(panels[0].comparedVersion).toBeNull();
  });

  it("finds a namespaced flow a link names without its prefix", async () => {
    listFlows.mockResolvedValue([
      { ...FLOW, apiName: "ns__Case_Email_Routing" }
    ]);
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "ns__Flow_Compare" },
      state: { c__flow: "Case_Email_Routing", c__va: "3", c__vb: "4" }
    });
    await flush();
    const diff = $(element, "c-flow-diff-view");
    expect(diff).not.toBeNull();
    expect(diff.labels.before).toBe("Version 3");
    expect($(element, ".error-text")).toBeNull();
  });

  it("says when a link names a flow that doesn't exist", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "ns__Flow_Compare" },
      state: { c__flow: "Gone_Flow" }
    });
    await flush();
    expect($(element, ".error-text").textContent).toBe(
      "There's no flow named Gone_Flow in this org. Choose one from the Flow list."
    );
    expect($(element, ".swap-button").disabled).toBe(true);
  });

  it("says when a link names an org connection that doesn't exist", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "ns__Flow_Compare" },
      state: {
        c__mode: "orgs",
        c__connB: "Gone_Org",
        c__flow: "Case_Email_Routing",
        c__va: "3",
        c__vb: "4"
      }
    });
    await flush();
    expect($(element, ".error-text").textContent).toBe(
      "There's no org connection named Gone_Org."
    );
    expect($(element, "c-flow-diff-view")).not.toBeNull();
  });

  it("says when a link names a version the flow doesn't have", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "ns__Flow_Compare" },
      state: { c__flow: "Case_Email_Routing", c__va: "99", c__vb: "4" }
    });
    await flush();
    expect($(element, ".error-text").textContent).toBe(
      "Case Email Routing has no version 99, so this shows version 3."
    );
    // The comparison still shows.
    expect($(element, "c-flow-diff-view")).not.toBeNull();

    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "ns__Flow_Compare" },
      state: {
        c__flow: "Case_Email_Routing",
        c__va: "3",
        c__vb: "4",
        c__base: "99"
      }
    });
    await flush();
    expect($(element, ".error-text").textContent).toBe(
      "Case Email Routing has no version 99 to use as the base. Choose the base from the list."
    );
  });

  it("compares a linked version with the one it would replace", async () => {
    const element = mount();
    const open = async (version) => {
      CurrentPageReference.emit({
        type: "standard__navItemPage",
        attributes: { apiName: "ns__Flow_Compare" },
        state: { c__flow: "Case_Email_Routing", c__vb: version }
      });
      await flush();
      return [
        $(element, ".version-a").value,
        $(element, ".version-b").value
      ].map(String);
    };
    // Version 4 is active: an older version is compared with it, and the
    // active version with the one before.
    expect(await open("2")).toEqual(["4", "2"]);
    expect(await open("4")).toEqual(["3", "4"]);
  });

  it("saves to another org without permission to save in this one", async () => {
    getUserContext.mockResolvedValue({ userName: "Builder", canSave: false });
    listConnections.mockResolvedValue([
      { name: "local", label: "This org", isLocal: true, canSave: false },
      { name: "Staging", label: "Staging", canSave: true }
    ]);
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: { c__flow: "Case_Email_Routing", c__tab: "merge" }
    });
    await flush();
    expect($(element, "c-flow-merge-view").canSave).toBe(true);
  });

  it("can't save anywhere without a connection that allows it", async () => {
    listConnections.mockResolvedValue([
      { name: "local", label: "This org", isLocal: true, canSave: false }
    ]);
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: { c__flow: "Case_Email_Routing", c__tab: "merge" }
    });
    await flush();
    expect($(element, "c-flow-merge-view").canSave).toBe(false);
  });

  it("keeps the latest choice when an earlier one answers late", async () => {
    let release;
    listFlows.mockImplementation(({ connection }) =>
      connection === "Staging"
        ? new Promise((resolve) => {
            release = () => resolve([FLOW]);
          })
        : Promise.resolve([FLOW])
    );
    const element = mount();
    await flush();
    const picker = $(element, ".connection-a");
    picker.dispatchEvent(
      new CustomEvent("change", { detail: { value: "Staging" } })
    );
    await flush();
    picker.dispatchEvent(
      new CustomEvent("change", { detail: { value: "local" } })
    );
    await flush();
    $(element, ".flow-a").dispatchEvent(
      new CustomEvent("change", { detail: { value: "Case_Email_Routing" } })
    );
    await flush();
    release();
    await flush();
    expect($(element, ".connection-a").value).toBe("local");
    expect($(element, ".flow-a").value).toBe("Case_Email_Routing");
    expect($(element, "c-flow-diff-view")).not.toBeNull();
  });

  it("doesn't let an older version list overwrite a newer selection", async () => {
    const element = mount();
    await flush();
    let finishOlder;
    listVersions.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOlder = resolve;
      })
    );
    const pick = () =>
      $(element, ".flow-a").dispatchEvent(
        new CustomEvent("change", { detail: { value: FLOW.apiName } })
      );
    pick();
    await flush();
    listVersions.mockResolvedValue([
      ...VERSIONS,
      { id: "301V5", versionNumber: 5, status: "Draft" }
    ]);
    getVersion.mockImplementation(({ versionId }) =>
      Promise.resolve(
        record(versionId === "301V5" ? 4 : versionId.replace("301V", ""))
      )
    );
    pick();
    await flush();
    expect($(element, ".version-b").value).toBe("5");
    finishOlder(VERSIONS);
    await flush();
    expect(
      $(element, ".version-b").options.map((option) => option.value)
    ).toContain("5");
    expect($(element, ".panel").hasAttribute("inert")).toBe(false);
  });

  it("doesn't let a delayed flow refresh undo a later activation refresh", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: {
        c__flow: FLOW.apiName,
        c__va: "3",
        c__vb: "4",
        c__tab: "activate"
      }
    });
    await flush();
    let finishOlder;
    listFlows.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOlder = resolve;
      })
    );
    $(element, "c-flow-activation").dispatchEvent(new CustomEvent("activated"));
    await flush();
    listFlows.mockResolvedValue([{ ...FLOW, activeVersion: 3 }]);
    $(element, "c-flow-activation").dispatchEvent(new CustomEvent("activated"));
    await flush();
    expect($(element, "c-flow-activation").activeVersion).toBe(3);
    finishOlder([FLOW]);
    await flush();
    expect($(element, "c-flow-activation").activeVersion).toBe(3);
  });

  it("reloads a version someone saved over since it was compared", async () => {
    const element = mount();
    await flush();
    const pick = () =>
      $(element, ".flow-a").dispatchEvent(
        new CustomEvent("change", { detail: { value: "Case_Email_Routing" } })
      );
    pick();
    await flush();
    const fetches = () =>
      getVersion.mock.calls.filter(([args]) => args.versionId === "301V4")
        .length;
    expect(fetches()).toBe(1);
    pick();
    await flush();
    expect(fetches()).toBe(1);
    listVersions.mockResolvedValue(
      VERSIONS.map((version) =>
        version.versionNumber === 4
          ? { ...version, lastModifiedDate: "2026-09-26T10:00:00.000Z" }
          : version
      )
    );
    pick();
    await flush();
    expect(fetches()).toBe(2);
  });

  it("asks for a base instead of merging two ways when there isn't one", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: {
        c__flow: "Case_Email_Routing",
        c__va: "1",
        c__vb: "2",
        c__base: "9",
        c__tab: "merge"
      }
    });
    await flush();
    expect($(element, "c-flow-merge-view")).toBeNull();
    expect($(element, ".base-needed")).not.toBeNull();
    $(element, ".base-version").dispatchEvent(
      new CustomEvent("change", { detail: { value: "1" } })
    );
    await flush();
    const merge = $(element, "c-flow-merge-view");
    expect(Object.keys(merge.sides).sort()).toEqual(["base", "ours", "theirs"]);
  });

  it("keeps a default base in step with the versions until one is chosen", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: { c__flow: "Case_Email_Routing", c__va: "3", c__vb: "4" }
    });
    await flush();
    const toggle = $(element, ".base lightning-input");
    toggle.checked = true;
    toggle.dispatchEvent(new CustomEvent("change"));
    await flush();
    expect($(element, ".base-version").value).toBe("2");
    const pickVersion = (selector, value) =>
      $(element, selector).dispatchEvent(
        new CustomEvent("change", { detail: { value } })
      );

    pickVersion(".version-a", "2");
    await flush();
    expect($(element, ".base-version").value).toBe("1");
    expect($(element, ".base-warning")).toBeNull();

    // Chosen, it stays put, and says when it can't be where an edit began.
    pickVersion(".base-version", "3");
    await flush();
    expect($(element, ".base-warning").textContent).toBe(
      "Version 3 isn't older than version 2, so it can't be where that edit started. Version 1 is the newest one older than both."
    );
    pickVersion(".version-a", "1");
    await flush();
    expect($(element, ".base-version").value).toBe("3");
  });

  it("shows errors with a way to setup for admins", async () => {
    listFlows.mockRejectedValue({ body: { message: "Unauthorized endpoint" } });
    const element = mount();
    await flush();
    expect($(element, ".error-text").textContent).toBe("Unauthorized endpoint");
    const labels = [
      ...element.shadowRoot.querySelectorAll(".error lightning-button")
    ].map((button) => button.label);
    expect(labels).toEqual(["Try again", "Open Tributary Setup"]);
  });

  it("tries a failed request again, and only offers setup for connections", async () => {
    listFlows.mockRejectedValueOnce({ body: { message: "Read timed out" } });
    const element = mount();
    await flush();
    const buttons = element.shadowRoot.querySelectorAll(
      ".error lightning-button"
    );
    expect([...buttons].map((button) => button.label)).toEqual(["Try again"]);
    buttons[0].click();
    await flush();
    expect($(element, ".error")).toBeNull();
    expect(listFlows).toHaveBeenCalledTimes(2);
    expect($(element, ".flow-a").options.length).toBeGreaterThan(0);
  });

  it("keeps each tab's work across tab switches", async () => {
    const element = mount();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "Flow_Compare" },
      state: { c__flow: "Case_Email_Routing", c__tab: "merge" }
    });
    await flush();
    const merge = $(element, "c-flow-merge-view");
    const tabs = () => [...element.shadowRoot.querySelectorAll('[role="tab"]')];
    expect(tabs().map((tab) => tab.getAttribute("tabindex"))).toEqual([
      "-1",
      "0",
      "-1"
    ]);

    tabs()[0].click();
    await flush();
    expect($(element, "c-flow-merge-view")).toBe(merge);
    expect(merge.parentElement.classList).toContain("slds-hide");
    expect($(element, "c-flow-diff-view")).not.toBeNull();

    $(element, '[role="tablist"]').dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight" })
    );
    await flush();
    expect($(element, "c-flow-merge-view")).toBe(merge);
    expect(merge.parentElement.classList).not.toContain("slds-hide");
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");

    $(element, '[role="tablist"]').dispatchEvent(
      new KeyboardEvent("keydown", { key: "End" })
    );
    await flush();
    expect(
      element.shadowRoot.querySelectorAll("c-flow-activation").length
    ).toBe(2);
  });
});

// A response belongs to the whole selection, not just the last fetch started.
it("does not revive a comparison after its selection was cleared", async () => {
  const releases = [];
  getVersion.mockImplementation(
    () =>
      new Promise((resolve) => {
        releases.push(() => resolve(record(4)));
      })
  );
  const element = mount();
  await flush();
  $(element, ".flow-a").dispatchEvent(
    new CustomEvent("change", {
      detail: { value: FLOW.apiName }
    })
  );
  await flush();
  $(element, ".flow-a").dispatchEvent(
    new CustomEvent("change", {
      detail: { value: undefined }
    })
  );
  await flush();
  releases.forEach((release) => release());
  await flush();
  expect($(element, "c-flow-diff-view")).toBeNull();
  expect($(element, ".skeleton")).toBeNull();
  expect($(element, ".empty-title")).not.toBeNull();
});

it("does not resolve an unqualified link to an installed package's flow", async () => {
  listFlows.mockResolvedValue([
    { ...FLOW, apiName: "pkg__OnlyInPackage", managed: true }
  ]);
  const element = mount();
  CurrentPageReference.emit({
    type: "standard__navItemPage",
    attributes: { apiName: "Flow_Compare" },
    state: { c__flow: "OnlyInPackage" }
  });
  await flush();
  expect($(element, "c-flow-diff-view")).toBeNull();
  expect($(element, ".error-text").textContent).toContain(
    "no flow named OnlyInPackage"
  );
});

it("pins the compared version's timestamp when offering activation", async () => {
  listVersions.mockResolvedValue(
    VERSIONS.map((version) => ({
      ...version,
      lastModifiedDate: "2026-09-27T10:00:00.123Z"
    }))
  );
  const element = mount();
  CurrentPageReference.emit({
    type: "standard__navItemPage",
    attributes: { apiName: "Flow_Compare" },
    state: { c__flow: FLOW.apiName, c__tab: "activate" }
  });
  await flush();
  expect($(element, "c-flow-activation").reviewedAt).toBe(
    "2026-09-27T10:00:00.123Z"
  );
});

it("keeps the compared timestamp when a refresh finds the version changed", async () => {
  const stamped = (stamp) =>
    VERSIONS.map((version) => ({ ...version, lastModifiedDate: stamp }));
  listVersions.mockResolvedValue(stamped("2026-09-27T10:00:00.000Z"));
  const element = mount();
  CurrentPageReference.emit({
    type: "standard__navItemPage",
    attributes: { apiName: "Flow_Compare" },
    state: { c__flow: FLOW.apiName, c__va: "3", c__vb: "4", c__tab: "merge" }
  });
  await flush();
  // Someone edits version 4 before this merge is saved as version 5.
  listVersions.mockResolvedValue(stamped("2026-09-28T09:00:00.000Z"));
  $(element, "c-flow-merge-view").dispatchEvent(
    new CustomEvent("saved", {
      detail: {
        result: { apiName: FLOW.apiName, versionNumber: 5 },
        connection: "local",
        label: FLOW.label
      }
    })
  );
  await flush();
  $(element, 'button[role="tab"][data-tab="activate"]').click();
  await flush();
  const cards = [...element.shadowRoot.querySelectorAll("c-flow-activation")];
  const compared = cards.find((card) => card.versionNumber === 4);
  expect(compared.reviewedAt).toBe("2026-09-27T10:00:00.000Z");
});

describe("a link's versions read ahead", () => {
  // The app remembers which versions it has read for as long as the page is
  // open, so each test's versions are saved at a time of their own.
  let STAMP;
  let saves = 0;
  const LINK = {
    type: "standard__navItemPage",
    attributes: { apiName: "Flow_Compare" },
    state: { c__flow: FLOW.apiName, c__va: "1", c__vb: "2", c__tab: "activate" }
  };
  const byName = (overrides = {}) =>
    getVersionByName.mockImplementation(({ versionNumber }) =>
      Promise.resolve({
        id: `301V${versionNumber}`,
        versionNumber,
        lastModifiedDate: STAMP,
        record: record(versionNumber),
        ...overrides
      })
    );
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  // In the org the first reads take far longer than a tick, so the reads
  // ahead are out before the flows arrive.
  const open = async (flows = [FLOW]) => {
    let flowsArrive;
    listFlows.mockReturnValue(
      new Promise((resolve) => {
        flowsArrive = () => resolve(flows);
      })
    );
    const element = mount();
    CurrentPageReference.emit(LINK);
    await tick();
    await tick();
    expect(getVersionByName).toHaveBeenCalledTimes(2);
    flowsArrive();
    await flush();
    return element;
  };

  beforeEach(() => {
    saves += 1;
    STAMP = `2026-09-27T10:${String(saves).padStart(2, "0")}:00.000Z`;
    listVersions.mockResolvedValue(
      VERSIONS.map((version) => ({ ...version, lastModifiedDate: STAMP }))
    );
  });

  it("reads them by name alongside the first reads, each on its own", async () => {
    byName();
    let flowsArrive;
    listFlows.mockReturnValue(
      new Promise((resolve) => {
        flowsArrive = () => resolve([FLOW]);
      })
    );
    const element = mount();
    CurrentPageReference.emit(LINK);
    // Actions made in one tick go as one request, run one after another,
    // so each read waits for a tick of its own.
    expect(getVersionByName).not.toHaveBeenCalled();
    await tick();
    expect(getVersionByName).toHaveBeenCalledTimes(1);
    await tick();
    expect(getVersionByName).toHaveBeenCalledTimes(2);
    expect(getVersionByName.mock.calls.map(([args]) => args)).toEqual([
      { connection: "local", apiName: FLOW.apiName, versionNumber: 1 },
      { connection: "local", apiName: FLOW.apiName, versionNumber: 2 }
    ]);
    // Neither waited for the flow list.
    expect(listVersions).not.toHaveBeenCalled();
    flowsArrive();
    await flush();
    expect(getVersion).not.toHaveBeenCalled();
    const diff = element.shadowRoot.querySelectorAll("c-flow-activation");
    expect([...diff].map((card) => card.versionNumber)).toEqual([2, 1]);
    // The review time is still the version list's.
    expect(diff[0].reviewedAt).toBe(STAMP);
  });

  it("reads a version again when it was saved over since", async () => {
    byName({ lastModifiedDate: "2026-09-26T10:00:00.000Z" });
    const element = await open();
    expect(getVersion).toHaveBeenCalledWith({
      connection: "local",
      versionId: "301V2",
      modified: STAMP
    });
    expect($(element, "c-flow-activation").reviewedAt).toBe(STAMP);
  });

  it("reads a version again when the name found another record", async () => {
    byName({ id: "301OTHER" });
    const element = await open();
    expect(getVersion).toHaveBeenCalledTimes(2);
    expect($(element, "c-flow-activation")).not.toBeNull();
  });

  it("falls back quietly when reading ahead fails", async () => {
    getVersionByName.mockRejectedValue({ body: { message: "Read timed out" } });
    const element = await open();
    expect(getVersion).toHaveBeenCalledTimes(2);
    expect($(element, ".error")).toBeNull();
    expect($(element, "c-flow-activation")).not.toBeNull();
  });

  it("doesn't wait on reading ahead for a version already read", async () => {
    getVersionByName.mockRejectedValue({ body: { message: "Read timed out" } });
    await open();
    expect(getVersion).toHaveBeenCalledTimes(2);
    document.body.removeChild(document.body.firstChild);
    jest.clearAllMocks();
    // The browser keeps getVersion's answers, so the same versions come
    // back at once, while this time the reads ahead never answer.
    getVersionByName.mockReturnValue(new Promise(() => {}));
    const element = await open();
    expect(getVersion).toHaveBeenCalledTimes(2);
    expect($(element, "c-flow-activation")).not.toBeNull();
  });

  it("uses a read ahead for the flow its unprefixed name finds", async () => {
    byName();
    const element = await open([
      { ...FLOW, apiName: "cllc__Case_Email_Routing" }
    ]);
    expect(getVersionByName).toHaveBeenCalledWith({
      connection: "local",
      apiName: FLOW.apiName,
      versionNumber: 1
    });
    expect(getVersion).not.toHaveBeenCalled();
    expect($(element, "c-flow-activation").apiName).toBe(
      "cllc__Case_Email_Routing"
    );
  });

  it("isn't used once the page has opened", async () => {
    byName();
    const element = mount();
    await flush();
    CurrentPageReference.emit(LINK);
    await flush();
    expect(getVersionByName).not.toHaveBeenCalled();
    expect($(element, "c-flow-activation")).not.toBeNull();
  });
});

describe("while another comparison loads", () => {
  const LINK = {
    type: "standard__navItemPage",
    attributes: { apiName: "Flow_Compare" },
    state: { c__flow: FLOW.apiName, c__va: "3", c__vb: "4" }
  };
  const held = () => {
    const releases = [];
    return {
      releases,
      hold: (value) =>
        new Promise((resolve) => {
          releases.push(() => resolve(value));
        })
    };
  };

  it("shows a newer comparison without waiting for a request it replaced", async () => {
    const slow = held();
    listFlows.mockImplementation(({ connection }) =>
      connection === "Staging" ? slow.hold([FLOW]) : Promise.resolve([FLOW])
    );
    const element = mount();
    CurrentPageReference.emit(LINK);
    await flush();
    const picker = $(element, ".connection-a");
    picker.dispatchEvent(
      new CustomEvent("change", { detail: { value: "Staging" } })
    );
    await flush();
    picker.dispatchEvent(
      new CustomEvent("change", { detail: { value: "local" } })
    );
    await flush();
    $(element, ".flow-a").dispatchEvent(
      new CustomEvent("change", { detail: { value: FLOW.apiName } })
    );
    await flush();
    // Staging's flows are still on their way, but nothing waits for them.
    expect(slow.releases.length).toBe(1);
    expect($(element, "c-flow-diff-view")).not.toBeNull();
    expect($(element, ".panel").hasAttribute("inert")).toBe(false);
    expect($(element, ".busy-bar")).toBeNull();
  });

  it("keeps the comparison, out of use, and keeps its views when it comes back", async () => {
    const element = mount();
    CurrentPageReference.emit(LINK);
    await flush();
    const view = $(element, "c-flow-diff-view");
    const slow = held();
    listVersions.mockImplementationOnce(() => slow.hold(VERSIONS));
    // Picking the flow again reads its versions again.
    $(element, ".flow-a").dispatchEvent(
      new CustomEvent("change", { detail: { value: FLOW.apiName } })
    );
    await flush();
    expect($(element, "c-flow-diff-view")).toBe(view);
    expect($(element, ".panel").hasAttribute("inert")).toBe(true);
    expect($(element, ".panel").getAttribute("aria-busy")).toBe("true");
    expect($(element, ".skeleton-bar")).toBeNull();
    slow.releases.forEach((release) => release());
    await flush();
    // The same versions: the same views, back in use.
    expect($(element, "c-flow-diff-view")).toBe(view);
    expect($(element, ".panel").hasAttribute("inert")).toBe(false);
  });

  it("keeps the comparison out of use while a failed choice is picked", async () => {
    const OTHER = {
      ...FLOW,
      definitionId: "300B",
      apiName: "Order_Routing",
      label: "Order Routing"
    };
    listFlows.mockResolvedValue([FLOW, OTHER]);
    const element = mount();
    CurrentPageReference.emit(LINK);
    await flush();
    const view = $(element, "c-flow-diff-view");
    // The other flow's versions can't be read.
    listVersions.mockImplementation(({ definitionId }) =>
      definitionId === OTHER.definitionId
        ? Promise.reject({ body: { message: "Read timed out" } })
        : Promise.resolve(VERSIONS)
    );
    $(element, ".flow-a").dispatchEvent(
      new CustomEvent("change", { detail: { value: OTHER.apiName } })
    );
    await flush();
    expect(element.shadowRoot.textContent).toMatch(/Read timed out/);
    // The pickers name the other flow, so its comparison can't be used.
    expect($(element, "c-flow-diff-view")).toBe(view);
    expect($(element, ".panel").hasAttribute("inert")).toBe(true);

    // Picking it again brings it back into use.
    $(element, ".flow-a").dispatchEvent(
      new CustomEvent("change", { detail: { value: FLOW.apiName } })
    );
    await flush();
    $(element, ".version-a").dispatchEvent(
      new CustomEvent("change", { detail: { value: "3" } })
    );
    await flush();
    expect($(element, "c-flow-diff-view")).toBe(view);
    expect($(element, ".panel").hasAttribute("inert")).toBe(false);
  });

  it("keeps the comparison in use when a refresh fails", async () => {
    const element = mount();
    CurrentPageReference.emit({
      ...LINK,
      state: { ...LINK.state, c__tab: "merge" }
    });
    await flush();
    listVersions.mockRejectedValue({ body: { message: "Read timed out" } });
    $(element, "c-flow-merge-view").dispatchEvent(
      new CustomEvent("saved", {
        detail: {
          result: { apiName: FLOW.apiName, versionNumber: 5 },
          connection: "local",
          label: FLOW.label
        }
      })
    );
    await flush();
    expect(element.shadowRoot.textContent).toMatch(/Read timed out/);
    expect($(element, ".panel").hasAttribute("inert")).toBe(false);
  });

  it("offers only what it compared for activation until the next one is in", async () => {
    const element = mount();
    CurrentPageReference.emit({
      ...LINK,
      state: { ...LINK.state, c__tab: "activate" }
    });
    await flush();
    const slow = held();
    getVersion.mockImplementation(({ versionId }) =>
      slow.hold(record(versionId.replace("301V", "")))
    );
    $(element, ".version-b").dispatchEvent(
      new CustomEvent("change", { detail: { value: "2" } })
    );
    await flush();
    const numbers = () =>
      [...element.shadowRoot.querySelectorAll("c-flow-activation")].map(
        (card) => card.versionNumber
      );
    expect(numbers()).toEqual([4, 3]);
    expect($(element, ".panel").hasAttribute("inert")).toBe(true);
    slow.releases.forEach((release) => release());
    await flush();
    expect(numbers()).toEqual([2, 3]);
    expect($(element, ".panel").hasAttribute("inert")).toBe(false);
  });

  it("makes the views afresh for a different comparison", async () => {
    const element = mount();
    CurrentPageReference.emit(LINK);
    await flush();
    const view = $(element, "c-flow-diff-view");
    $(element, ".version-b").dispatchEvent(
      new CustomEvent("change", { detail: { value: "2" } })
    );
    await flush();
    expect($(element, "c-flow-diff-view")).not.toBe(view);
    expect($(element, "c-flow-diff-view").labels.after).toBe("Version 2");
  });
});

it("hands the pickers the same options until their lists change", async () => {
  const element = mount();
  CurrentPageReference.emit({
    type: "standard__navItemPage",
    attributes: { apiName: "Flow_Compare" },
    state: { c__flow: FLOW.apiName, c__va: "3", c__vb: "4", c__base: "2" }
  });
  await flush();
  const flows = $(element, ".flow-a").options;
  const versions = $(element, ".version-a").options;
  // The base picks from A's versions: the same list.
  expect($(element, ".base-version").options).toBe(versions);
  $(element, 'button[role="tab"][data-tab="merge"]').click();
  await flush();
  expect($(element, ".flow-a").options).toBe(flows);
  expect($(element, ".version-a").options).toBe(versions);
  expect($(element, ".base-version").options).toBe(versions);
});
