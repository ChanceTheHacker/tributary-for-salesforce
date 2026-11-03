import { createElement } from "lwc";
import FlowGovernance from "c/flowGovernance";
import { CurrentPageReference, navigate } from "lightning/navigation";
import getUserContext from "@salesforce/apex/FlowCompareController.getUserContext";
import listConnections from "@salesforce/apex/FlowCompareController.listConnections";
import listFlows from "@salesforce/apex/FlowCompareController.listFlows";
import listGoverned from "@salesforce/apex/FlowGovernanceController.listGoverned";
import saveGovernance from "@salesforce/apex/FlowGovernanceController.saveGovernance";
import removeGovernance from "@salesforce/apex/FlowGovernanceController.removeGovernance";
import listAuditEventsBefore from "@salesforce/apex/FlowGovernanceController.listAuditEventsBefore";
import runCheck from "@salesforce/apex/FlowGovernanceController.runCheck";
import getMonitor from "@salesforce/apex/FlowGovernanceController.getMonitor";
import { forgetGovernance } from "c/flowGovernanceCache";

jest.mock("lightning/navigation", () => {
  const {
    createTestWireAdapter
  } = require("@salesforce/wire-service-jest-util");
  const navigateSpy = jest.fn();
  const Navigate = Symbol("Navigate");
  const GenerateUrl = Symbol("GenerateUrl");
  const NavigationMixin = (Base) =>
    class extends Base {
      [Navigate](pageRef, replace) {
        navigateSpy(pageRef, replace);
      }
      [GenerateUrl](pageRef) {
        return Promise.resolve(`/lightning/n/${pageRef.attributes.apiName}`);
      }
    };
  NavigationMixin.Navigate = Navigate;
  NavigationMixin.GenerateUrl = GenerateUrl;
  return {
    CurrentPageReference: createTestWireAdapter(jest.fn()),
    NavigationMixin,
    navigate: navigateSpy
  };
});

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
  "@salesforce/apex/FlowGovernanceController.listGoverned",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.saveGovernance",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.removeGovernance",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.listAuditEventsBefore",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.runCheck",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.getMonitor",
  () => ({ default: jest.fn() }),
  { virtual: true }
);

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const ROUTING = {
  id: "a02A",
  label: "Case Email Routing",
  apiName: "Case_Email_Routing",
  connection: "local",
  ownerId: "005O",
  ownerName: "Jo Owner",
  mode: "Locked",
  approvedVersion: 4,
  activeVersion: 4,
  lastChecked: "2026-09-24T10:00:00.000Z",
  isOwner: false
};

const LEADS = {
  id: "a02B",
  label: "Lead Assignment",
  apiName: "Lead_Assignment",
  connection: "Staging",
  ownerId: "005M",
  ownerName: "Me",
  mode: "Watch",
  approvedVersion: 2,
  activeVersion: 3,
  isOwner: true
};

const EVENTS = [
  {
    id: "a03B",
    type: "Reverted",
    apiName: "Lead_Assignment",
    connection: "Staging",
    versionNumber: 2,
    previousVersion: 3,
    details: "Reverted version 3.",
    createdDate: "2026-09-24T11:00:00.000Z"
  },
  {
    id: "a03A",
    type: "Activated",
    apiName: "Case_Email_Routing",
    connection: "local",
    versionNumber: 4,
    previousVersion: 3,
    actor: "Jo Owner",
    createdDate: "2026-09-24T09:00:00.000Z"
  }
];

function mount(state) {
  const element = createElement("c-flow-governance", { is: FlowGovernance });
  document.body.appendChild(element);
  CurrentPageReference.emit({
    type: "standard__navItemPage",
    attributes: { apiName: "cllc__Governed_Flows" },
    state: state || {}
  });
  return element;
}

const $ = (element, selector) => element.shadowRoot.querySelector(selector);
const $$ = (element, selector) => [
  ...element.shadowRoot.querySelectorAll(selector)
];

// Picks an item from a row's menu of admin actions.
function pickFromMenu(element, index, value) {
  const menu = $$(element, "lightning-button-menu.row-menu")[index];
  menu.dispatchEvent(new CustomEvent("select", { detail: { value } }));
  return menu;
}

function toasts(element) {
  const seen = [];
  element.addEventListener("lightning__showtoast", (event) =>
    seen.push(event.detail)
  );
  return seen;
}

describe("c-flow-governance", () => {
  beforeEach(() => {
    getUserContext.mockResolvedValue({ userId: "005M", isAdmin: true });
    listConnections.mockResolvedValue([
      { name: "local", label: "This org", isLocal: true },
      { name: "Staging", label: "Staging" }
    ]);
    listGoverned.mockResolvedValue([ROUTING, LEADS]);
    listAuditEventsBefore.mockResolvedValue(EVENTS);
    getMonitor.mockResolvedValue({
      scheduled: true,
      running: false,
      intervalMinutes: 15,
      nextRun: "2026-09-24T12:15:00.000Z",
      lastStatus: "Completed",
      lastSuccess: "2026-09-24T12:00:00.000Z"
    });
    listFlows.mockResolvedValue([
      { apiName: "Case_Email_Routing", label: "Case Email Routing" },
      { apiName: "Opportunity_Close", label: "Opportunity Close" }
    ]);
  });

  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    jest.restoreAllMocks();
    jest.clearAllMocks();
    forgetGovernance();
  });

  it("lists governed flows with their owners, modes and versions", async () => {
    const element = mount();
    await flush();

    const rows = $$(element, "tbody tr");
    expect(rows).toHaveLength(2);
    const cells = (row) =>
      [...row.querySelectorAll("th, td")].map((cell) =>
        cell.textContent.trim()
      );
    expect(cells(rows[0]).slice(0, 6)).toEqual([
      "Case Email RoutingCase_Email_Routing",
      "This org",
      "Jo Owner",
      "Approval required",
      "Version 4",
      "Version 4"
    ]);
    expect(cells(rows[1]).slice(1, 6)).toEqual([
      "Staging",
      "Me (you)",
      "Owner only",
      "Version 2",
      "Version 3"
    ]);
    expect(rows[0].querySelector(".drift")).toBeNull();
    expect(rows[1].querySelector(".drift")).not.toBeNull();
    expect($(element, ".count").textContent).toBe("2 governed flows");
  });

  it("reads the governed list without waiting for the user and connections", async () => {
    let started;
    getUserContext.mockReturnValue(
      new Promise((resolve) => {
        started = resolve;
      })
    );
    const element = mount();
    await flush();
    expect(listGoverned).toHaveBeenCalled();
    expect(listAuditEventsBefore).toHaveBeenCalled();
    // The table names each flow's org, so it waits for the connections.
    expect($$(element, "tbody tr")).toHaveLength(0);
    started({ userId: "005M", isAdmin: true });
    await flush();
    expect($$(element, "tbody tr")).toHaveLength(2);
    // Every flow in the history is governed, so no labels are looked up.
    expect(listFlows).not.toHaveBeenCalled();
  });

  it("shows how each flow's last check went", async () => {
    listGoverned.mockResolvedValue([
      { ...ROUTING, lastCheckOutcome: "ok" },
      {
        ...LEADS,
        lastCheckOutcome: "error",
        lastCheckMessage: "Couldn't reach the org: Read timed out"
      }
    ]);
    const element = mount();
    await flush();

    const checked = $$(element, "td.checked");
    expect(checked[0].textContent).toContain("Active version is approved.");
    expect(checked[1].textContent).toBe(
      "Not yetCouldn't reach the org: Read timed out"
    );
    expect(checked[1].querySelector(".last-check").className).toContain(
      "check-error"
    );
  });

  it("moves focus into a dialog and back to what opened it", async () => {
    const focused = [];
    const spy = jest
      .spyOn(HTMLElement.prototype, "focus")
      .mockImplementation(function focus() {
        focused.push(this);
      });
    const element = mount();
    await flush();

    const edit = pickFromMenu(element, 0, "edit");
    await flush();
    const dialog = $(element, "section.editor");
    expect(focused.pop()).toBe($(element, ".editor-owner"));
    const [before, after] = $$(element, ".focus-guard");
    before.dispatchEvent(new CustomEvent("focus"));
    expect(focused.pop()).toBe(
      $(element, "section.editor footer lightning-button")
    );
    after.dispatchEvent(new CustomEvent("focus"));
    expect(focused.pop()).toBe($(element, "section.editor .close"));

    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    await flush();
    expect($(element, "section.editor")).toBeNull();
    expect(focused.pop()).toBe(edit);

    // A removed flow's row is gone; focus goes to "Govern a flow".
    removeGovernance.mockResolvedValue();
    listGoverned.mockResolvedValue([ROUTING]);
    pickFromMenu(element, 1, "remove");
    await flush();
    $(element, "lightning-button.remove-confirm").click();
    await flush();
    expect(focused.pop()).toBe($(element, "lightning-button.add"));
    spy.mockRestore();
  });

  it("says whether automatic checks enforce the modes", async () => {
    const element = mount();
    await flush();

    expect($(element, ".checks .slds-badge").textContent).toBe("Scheduled");
    expect($(element, ".checks-text").textContent).toContain(
      "Checked every 15 minutes."
    );
    expect($(element, ".checks-text").textContent).toContain(
      "Last successful check"
    );
    expect($$(element, "tbody .slds-badge")[0].className).toContain(
      "mode-approval"
    );
  });

  it("warns when automatic checks have stopped, with a way to start them", async () => {
    getMonitor.mockResolvedValue({ scheduled: false, running: false });
    const element = mount();
    await flush();

    const checks = $(element, ".checks");
    expect(checks.className).toContain("checks-off");
    expect(checks.querySelector(".slds-badge").textContent).toBe("Stopped");
    expect($(element, ".checks-text").textContent).toBe(
      "Automatic checks stopped — outside activations are checked only when you run a check."
    );
    const link = $(element, "a.checks-link");
    expect(link.getAttribute("href")).toBe(
      "/lightning/n/cllc__Flow_Compare_Setup"
    );
    link.click();
    expect(navigate).toHaveBeenCalledWith(
      {
        type: "standard__navItemPage",
        attributes: { apiName: "cllc__Flow_Compare_Setup" },
        state: { c__section: "monitor" }
      },
      undefined
    );
  });

  it("names a failed automatic check", async () => {
    getMonitor.mockResolvedValue({
      scheduled: true,
      running: false,
      intervalMinutes: 60,
      lastStatus: "Failed"
    });
    getUserContext.mockResolvedValue({ userId: "005M", isAdmin: false });
    const element = mount();
    await flush();

    expect($(element, ".checks .slds-badge").textContent).toBe("Check failed");
    expect($(element, ".checks-link")).toBeNull();
    expect($(element, "lightning-button-menu.row-menu")).toBeNull();
  });

  it("doesn't flag drift when enforcement is off", async () => {
    listGoverned.mockResolvedValue([{ ...LEADS, mode: "Off" }]);
    const element = mount();
    await flush();

    const rows = $$(element, "tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".drift")).toBeNull();
  });

  it("lays out receipts as lists and names old modes as they are now", async () => {
    listAuditEventsBefore.mockResolvedValue([
      {
        id: "a03C",
        type: "Governance Changed",
        apiName: "Lead_Assignment",
        connection: "Staging",
        details: "Now governed. Mode: Watch. Owner: Jo Owner.",
        createdDate: "2026-09-24T12:00:00.000Z"
      },
      {
        id: "a03D",
        type: "Version Saved",
        apiName: "Lead_Assignment",
        connection: "Staging",
        details:
          "Saved from Tributary as inactive version 9.\nFrom:\n- Version 7: v7\n- Version 8: v8\nDecided:\n- Description: Version 7",
        createdDate: "2026-09-24T11:30:00.000Z"
      }
    ]);
    const element = mount();
    await flush();
    const [governed, saved] = $$(element, ".event-details");
    expect(governed.textContent).toBe(
      "Now governed. Mode: Owner only. Owner: Jo Owner."
    );
    const blocks = saved.querySelectorAll(".detail-block");
    expect(blocks).toHaveLength(3);
    expect(blocks[1].querySelector("p").textContent).toBe("From:");
    expect(
      [...blocks[1].querySelectorAll("li")].map((item) => item.textContent)
    ).toEqual(["Version 7: v7", "Version 8: v8"]);
    expect(blocks[2].querySelectorAll("li")).toHaveLength(1);
  });

  it("shows recent activity and a flow's own history", async () => {
    const element = mount();
    await flush();

    expect(listAuditEventsBefore).toHaveBeenCalledWith({
      connection: null,
      apiName: null,
      beforeDate: null,
      beforeId: null,
      pageSize: 26
    });
    expect($(element, ".history-title").textContent).toBe("Recent activity");
    const items = $$(element, ".event");
    expect(items).toHaveLength(2);
    expect(items[0].className).toContain("event-warning");
    expect(items[0].textContent).toContain("Reverted");
    expect(items[0].querySelector(".event-flow").textContent).toBe(
      "Lead Assignment"
    );
    expect(items[0].textContent).toContain("version 2 (was version 3)");
    expect(items[1].textContent).toContain("by Jo Owner");

    // The list stays, marked busy, until the flow's own history arrives.
    let arrive;
    listAuditEventsBefore.mockReturnValueOnce(
      new Promise((resolve) => {
        arrive = resolve;
      })
    );
    $$(element, "lightning-button.history")[1].click();
    await flush();
    const panel = $(element, "section.history-panel");
    expect(panel.getAttribute("aria-busy")).toBe("true");
    expect($$(element, ".event")).toHaveLength(2);
    arrive(EVENTS.slice(0, 1));
    await flush();
    expect(panel.getAttribute("aria-busy")).toBe("false");
    expect($$(element, ".event")).toHaveLength(1);

    expect(listAuditEventsBefore).toHaveBeenLastCalledWith({
      connection: "Staging",
      apiName: "Lead_Assignment",
      beforeDate: null,
      beforeId: null,
      pageSize: 26
    });
    expect($(element, ".history-title").textContent).toBe(
      "History: Lead Assignment"
    );
    expect($$(element, "tbody tr")[1].className).toContain("row-selected");

    // Pressed again, it stays on the flow's history rather than closing it.
    const calls = listAuditEventsBefore.mock.calls.length;
    $$(element, "lightning-button.history")[1].click();
    await flush();
    expect(listAuditEventsBefore.mock.calls).toHaveLength(calls);
    expect($(element, ".history-title").textContent).toBe(
      "History: Lead Assignment"
    );
    expect(element.shadowRoot.activeElement).toBe($(element, ".history-title"));

    $(element, "lightning-button.all-history").click();
    await flush();
    expect($(element, ".history-title").textContent).toBe("Recent activity");
  });

  it("groups history by day and pages back through it", async () => {
    const now = Date.now();
    const event = (index, createdDate) => ({
      id: `e${index}`,
      type: "Activated",
      apiName: "Case_Email_Routing",
      connection: "local",
      versionNumber: 4,
      createdDate
    });
    const page = [
      event(0, new Date(now).toISOString()),
      event(1, new Date(now - 86400000).toISOString()),
      ...Array.from({ length: 24 }, (_, i) =>
        event(i + 2, "2025-03-02T12:00:00.000Z")
      )
    ];
    listAuditEventsBefore.mockResolvedValue(page);
    const element = mount();
    await flush();

    // 26 back says there's more: 25 shown, and a way to older ones.
    expect($$(element, ".event")).toHaveLength(25);
    const heads = $$(element, ".day-head").map((head) => head.textContent);
    expect(heads.slice(0, 2)).toEqual(["Today", "Yesterday"]);
    expect(heads[2]).toMatch(/2025/);
    expect(heads).toHaveLength(3);
    const time = $(element, ".event time");
    expect(time.getAttribute("datetime")).toBe(page[0].createdDate);
    expect(time.title).toMatch(/\d{4}/);

    // The next page starts after the last event shown, the 25th: only
    // what's older is read.
    listAuditEventsBefore.mockResolvedValue([
      page[24],
      ...Array.from({ length: 4 }, (_, i) =>
        event(i + 26, "2025-03-01T12:00:00.000Z")
      )
    ]);
    $(element, "lightning-button.older-history").click();
    await flush();
    await flush();
    expect(listAuditEventsBefore).toHaveBeenLastCalledWith({
      connection: null,
      apiName: null,
      beforeDate: page[24].createdDate,
      beforeId: "e24",
      pageSize: 26
    });
    // Added below, each event once, even one sent again.
    const shown = $$(element, ".event");
    expect(shown).toHaveLength(29);
    expect(shown[24].textContent).toContain("version 4");
    // The last page: the button goes, and focus stays in the history.
    expect($(element, "lightning-button.older-history")).toBeNull();
    expect(element.shadowRoot.activeElement).toBe($(element, ".history-title"));

    // Another flow's history starts from its newest page again.
    $$(element, "lightning-button.history")[0].click();
    await flush();
    expect(listAuditEventsBefore).toHaveBeenLastCalledWith({
      connection: "local",
      apiName: "Case_Email_Routing",
      beforeDate: null,
      beforeId: null,
      pageSize: 26
    });
  });

  it("reads the newest page again on Refresh, and drops a page still out for another flow", async () => {
    const event = (index) => ({
      id: `e${index}`,
      type: "Activated",
      apiName: "Case_Email_Routing",
      connection: "local",
      versionNumber: index,
      createdDate: "2025-03-02T12:00:00.000Z"
    });
    const newest = Array.from({ length: 26 }, (_, i) => event(i));
    listAuditEventsBefore.mockResolvedValue(newest);
    const element = mount();
    await flush();
    listAuditEventsBefore.mockResolvedValueOnce([event(30)]);
    $(element, "lightning-button.older-history").click();
    await flush();
    expect($$(element, ".event")).toHaveLength(26);

    // Refresh reads past the cache, from the top: the older page goes.
    listAuditEventsBefore.mockResolvedValue(newest.slice(1));
    const calls = listAuditEventsBefore.mock.calls.length;
    $(element, "lightning-button-icon[title='Refresh']").click();
    await flush();
    expect(listAuditEventsBefore.mock.calls).toHaveLength(calls + 1);
    expect(listAuditEventsBefore).toHaveBeenLastCalledWith({
      connection: null,
      apiName: null,
      beforeDate: null,
      beforeId: null,
      pageSize: 26
    });
    expect($$(element, ".event")).toHaveLength(25);
    expect($(element, "lightning-button.older-history")).toBeNull();

    // An older page that arrives after another flow is picked isn't added
    // to it. (A newer page, so the older one isn't the one already read.)
    listAuditEventsBefore.mockResolvedValue(
      Array.from({ length: 26 }, (_, i) => event(i + 100))
    );
    $(element, "lightning-button-icon[title='Refresh']").click();
    await flush();
    let late;
    listAuditEventsBefore.mockReturnValueOnce(
      new Promise((resolve) => {
        late = resolve;
      })
    );
    $(element, "lightning-button.older-history").click();
    await flush();
    listAuditEventsBefore.mockResolvedValueOnce([EVENTS[0]]);
    $$(element, "lightning-button.history")[1].click();
    await flush();
    late([event(40)]);
    await flush();
    expect(listAuditEventsBefore).toHaveBeenCalledWith(
      expect.objectContaining({ beforeId: "e124" })
    );
    expect($(element, ".history-title").textContent).toBe(
      "History: Lead Assignment"
    );
    expect($$(element, ".event")).toHaveLength(1);
  });

  it("reuses the last minute's reads when the page comes back, until something changes", async () => {
    saveGovernance.mockResolvedValue({ ...ROUTING, mode: "Watch" });
    let element = mount();
    await flush();
    document.body.removeChild(element);
    element = mount();
    await flush();
    expect(listGoverned).toHaveBeenCalledTimes(1);
    expect(listAuditEventsBefore).toHaveBeenCalledTimes(1);
    expect(getMonitor).toHaveBeenCalledTimes(1);
    expect($$(element, "tbody tr")).toHaveLength(2);

    // A change forgets them: this page and the next read again.
    pickFromMenu(element, 0, "edit");
    await flush();
    $(element, "lightning-radio-group.editor-mode").dispatchEvent(
      new CustomEvent("change", { detail: { value: "Watch" } })
    );
    await flush();
    $(element, "lightning-button.editor-save").click();
    await flush();
    expect(listGoverned).toHaveBeenCalledTimes(2);
    document.body.removeChild(element);
    mount();
    await flush();
    expect(getMonitor).toHaveBeenCalledTimes(2);

    // Refresh always reads.
    $(
      document.body.firstChild,
      "lightning-button-icon[title='Refresh']"
    ).click();
    await flush();
    expect(listGoverned).toHaveBeenCalledTimes(3);
    expect(getMonitor).toHaveBeenCalledTimes(3);
  });

  it("works out an event's text once, not on every render", async () => {
    const times = jest.spyOn(Date.prototype, "toLocaleTimeString");
    try {
      const element = mount();
      await flush();
      const rendered = times.mock.calls.length;
      expect(rendered).toBeGreaterThan(0);

      // Opening a dialog renders the page again; the history is unchanged.
      $(element, "lightning-button.add").click();
      await flush();
      expect($(element, "section.slds-modal")).not.toBeNull();
      expect(times.mock.calls).toHaveLength(rendered);
    } finally {
      times.mockRestore();
    }
  });

  it("moves Today to Yesterday at midnight", async () => {
    jest.useFakeTimers({ now: new Date(2026, 8, 29, 23, 59, 0) });
    try {
      listAuditEventsBefore.mockResolvedValue([
        {
          ...EVENTS[0],
          createdDate: new Date(2026, 8, 29, 23, 0, 0).toISOString()
        }
      ]);
      const element = mount();
      await jest.advanceTimersByTimeAsync(10);
      expect($(element, ".day-head").textContent).toBe("Today");
      await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect($(element, ".day-head").textContent).toBe("Yesterday");
    } finally {
      jest.useRealTimers();
    }
  });

  it("opens the history a notification links to", async () => {
    const element = mount({ c__flow: "Lead_Assignment", c__conn: "Staging" });
    await flush();

    expect(listAuditEventsBefore).toHaveBeenLastCalledWith({
      connection: "Staging",
      apiName: "Lead_Assignment",
      beforeDate: null,
      beforeId: null,
      pageSize: 26
    });
    expect($(element, ".history-title").textContent).toBe(
      "History: Lead Assignment"
    );
  });

  it("keeps the search and the open history in the URL", async () => {
    jest.useFakeTimers();
    try {
      const element = mount({ c__q: "lead" });
      await Promise.resolve();
      jest.runOnlyPendingTimers();
      await Promise.resolve();
      jest.runOnlyPendingTimers();
      await Promise.resolve();
      const search = $(element, "lightning-input.search");
      expect(search.value).toBe("lead");

      search.value = "routing";
      search.dispatchEvent(new CustomEvent("change"));
      expect(navigate).not.toHaveBeenCalled();
      jest.advanceTimersByTime(400);
      expect(navigate).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: { c__q: "routing" } }),
        true
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("names the flow whose history opens, and moves there", async () => {
    const element = mount();
    await flush();

    $$(element, "lightning-button.history")[1].click();
    await flush();
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: { c__flow: "Lead_Assignment", c__conn: "Staging" }
      }),
      true
    );
    $(element, "lightning-button.all-history").click();
    await flush();
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: {} }),
      true
    );

    const focus = jest.spyOn(HTMLElement.prototype, "focus");
    $$(element, ".event-flow")[1].click();
    await flush();
    expect(listAuditEventsBefore).toHaveBeenLastCalledWith({
      connection: "local",
      apiName: "Case_Email_Routing",
      beforeDate: null,
      beforeId: null,
      pageSize: 26
    });
    expect(focus.mock.contexts).toContain($(element, ".history-title"));
    focus.mockRestore();
    expect($$(element, "lightning-button.history")[0].ariaLabel).toBe(
      "History of Case Email Routing"
    );
  });

  it("finds the history of a flow no longer governed", async () => {
    listAuditEventsBefore.mockResolvedValue([
      ...EVENTS,
      {
        id: "a03C",
        type: "Removed",
        apiName: "Opportunity_Close",
        connection: "local",
        createdDate: "2026-09-24T08:00:00.000Z"
      }
    ]);
    const element = mount();
    await flush();

    const search = $(element, "lightning-input.search");
    search.value = "opportunity";
    search.dispatchEvent(new CustomEvent("change"));
    await flush();
    // Its label comes from the org, not the governed list.
    const flows = $$(element, ".event-flow");
    expect(flows.map((flow) => flow.textContent)).toEqual([
      "Opportunity Close"
    ]);
    flows[0].click();
    await flush();
    expect($(element, ".history-title").textContent).toBe(
      "History: Opportunity Close"
    );

    $(element, "lightning-button.all-history").click();
    await flush();
    search.value = "nothing like it";
    search.dispatchEvent(new CustomEvent("change"));
    await flush();
    expect($(element, ".history-empty").textContent).toBe(
      "No recent activity matches “nothing like it”."
    );
  });

  it("filters the table", async () => {
    const element = mount();
    await flush();

    const search = $(element, "lightning-input.search");
    search.value = "owner";
    search.dispatchEvent(new CustomEvent("change"));
    await flush();
    expect($$(element, "tbody tr")).toHaveLength(1);

    search.value = "nothing like it";
    search.dispatchEvent(new CustomEvent("change"));
    await flush();
    expect($(element, "table")).toBeNull();
    expect($(element, ".no-matches").textContent).toContain("nothing like it");
  });

  it("opens Tributary for a governed flow", async () => {
    const element = mount();
    await flush();

    $$(element, "lightning-button.compare")[1].click();

    expect(navigate).toHaveBeenCalledWith(
      {
        type: "standard__navItemPage",
        attributes: { apiName: "cllc__Flow_Compare" },
        state: { c__flow: "Lead_Assignment", c__conn: "Staging" }
      },
      undefined
    );
  });

  it("governs a new flow", async () => {
    saveGovernance.mockResolvedValue({
      ...ROUTING,
      id: "a02C",
      label: "Opportunity Close",
      apiName: "Opportunity_Close",
      mode: "Watch",
      approvedVersion: 1
    });
    const element = mount();
    await flush();
    const seen = toasts(element);

    $(element, "lightning-button.add").click();
    await flush();

    expect(listFlows).toHaveBeenCalledWith({ connection: "local" });
    const flow = $(element, "c-flow-picker.editor-flow");
    // Flows already governed in this org aren't offered.
    expect(flow.options).toEqual([
      {
        value: "Opportunity_Close",
        label: "Opportunity Close (Opportunity_Close)"
      }
    ]);
    expect($(element, "lightning-record-picker.editor-owner").value).toBe(
      "005M"
    );
    expect($(element, "lightning-radio-group.editor-mode").value).toBe("Watch");
    expect($(element, "lightning-button.editor-save").disabled).toBe(true);

    flow.dispatchEvent(
      new CustomEvent("change", { detail: { value: "Opportunity_Close" } })
    );
    $(element, "lightning-record-picker.editor-owner").dispatchEvent(
      new CustomEvent("change", { detail: { recordId: "005O" } })
    );
    $(element, "lightning-radio-group.editor-mode").dispatchEvent(
      new CustomEvent("change", { detail: { value: "Locked" } })
    );
    await flush();
    expect($(element, ".mode-description").textContent).toContain(
      "Every activation needs an approved request"
    );
    expect($(element, "lightning-button.editor-save").disabled).toBe(false);

    $(element, "lightning-button.editor-save").click();
    await flush();

    expect(saveGovernance).toHaveBeenCalledWith({
      id: null,
      connection: "local",
      apiName: "Opportunity_Close",
      label: "Opportunity Close",
      ownerId: "005O",
      mode: "Locked"
    });
    expect(seen[0].title).toBe("Flow governed");
    expect(seen[0].message).toContain("Version 1 is the approved version");
    expect($(element, "section.editor")).toBeNull();
    expect(listGoverned).toHaveBeenCalledTimes(2);
  });

  it("says no version is approved when none was active", async () => {
    saveGovernance.mockResolvedValue({
      ...ROUTING,
      id: "a02C",
      label: "Opportunity Close",
      apiName: "Opportunity_Close",
      mode: "Watch",
      approvedVersion: null
    });
    const element = mount();
    await flush();
    const seen = toasts(element);

    $(element, "lightning-button.add").click();
    await flush();
    $(element, "c-flow-picker.editor-flow").dispatchEvent(
      new CustomEvent("change", { detail: { value: "Opportunity_Close" } })
    );
    await flush();
    $(element, "lightning-button.editor-save").click();
    await flush();

    expect(seen[0].message).toContain(
      "No version is active, so none is approved yet."
    );
    expect(seen[0].message).not.toContain("Version null");
  });

  it("warns that a mode isn't enforced while automatic checks are stopped", async () => {
    getMonitor.mockResolvedValue({ scheduled: false, running: false });
    saveGovernance.mockResolvedValue({ ...ROUTING, mode: "Locked" });
    const element = mount();
    await flush();
    const seen = toasts(element);

    pickFromMenu(element, 0, "edit");
    await flush();
    expect($(element, ".checks-warning").textContent).toContain(
      "Automatic checks are stopped"
    );
    $(element, "lightning-radio-group.editor-mode").dispatchEvent(
      new CustomEvent("change", { detail: { value: "Off" } })
    );
    await flush();
    // Off enforces nothing, so there's nothing to warn about.
    expect($(element, ".checks-warning")).toBeNull();
    $(element, "lightning-radio-group.editor-mode").dispatchEvent(
      new CustomEvent("change", { detail: { value: "Locked" } })
    );
    await flush();
    expect($(element, "lightning-button.editor-save").disabled).toBe(true);
    $(element, "lightning-button.editor-save").click();
    expect(saveGovernance).not.toHaveBeenCalled();
    $(element, "lightning-record-picker.editor-owner").dispatchEvent(
      new CustomEvent("change", { detail: { recordId: "005M" } })
    );
    await flush();
    expect($(element, "lightning-button.editor-save").disabled).toBe(false);
    $(element, "lightning-button.editor-save").click();
    await flush();

    expect(seen[0].variant).toBe("warning");
    expect(seen[0].message).toContain("Automatic checks are stopped");
  });

  it("lists the other org's flows when the org changes", async () => {
    const element = mount();
    await flush();

    $(element, "lightning-button.add").click();
    await flush();
    $(element, "lightning-combobox.editor-connection").dispatchEvent(
      new CustomEvent("change", { detail: { value: "Staging" } })
    );
    await flush();

    expect(listFlows).toHaveBeenLastCalledWith({ connection: "Staging" });
    // Case_Email_Routing is governed here, not in Staging.
    expect(
      $(element, "c-flow-picker.editor-flow").options.map(
        (option) => option.value
      )
    ).toEqual(["Case_Email_Routing", "Opportunity_Close"]);
  });

  it("changes an existing flow's mode and shows save errors", async () => {
    saveGovernance.mockRejectedValue({ body: { message: "Pick an owner." } });
    const element = mount();
    await flush();

    pickFromMenu(element, 0, "edit");
    await flush();
    expect($(element, ".slds-modal__title").textContent).toBe(
      "Governance: Case Email Routing"
    );
    expect($(element, "c-flow-picker.editor-flow")).toBeNull();
    $(element, "lightning-radio-group.editor-mode").dispatchEvent(
      new CustomEvent("change", { detail: { value: "Off" } })
    );
    await flush();
    $(element, "lightning-button.editor-save").click();
    await flush();

    expect(saveGovernance).toHaveBeenCalledWith({
      id: "a02A",
      connection: "local",
      apiName: "Case_Email_Routing",
      label: "Case Email Routing",
      ownerId: "005O",
      mode: "Off"
    });
    expect($(element, "section.editor .error").textContent).toBe(
      "Pick an owner."
    );
  });

  it("keeps a saved mode when a refresh from before the save answers late", async () => {
    const off = { ...ROUTING, mode: "Off" };
    listGoverned.mockResolvedValue([off, LEADS]);
    const element = mount();
    await flush();
    // Refresh, and while it's out, save the flow as Approval required.
    let late;
    listGoverned.mockReturnValueOnce(
      new Promise((resolve) => {
        late = resolve;
      })
    );
    $(element, "lightning-button-icon[title='Refresh']").click();
    await flush();
    saveGovernance.mockResolvedValue(ROUTING);
    listGoverned.mockResolvedValue([ROUTING, LEADS]);
    pickFromMenu(element, 0, "edit");
    await flush();
    $(element, "lightning-radio-group.editor-mode").dispatchEvent(
      new CustomEvent("change", { detail: { value: "Locked" } })
    );
    await flush();
    $(element, "lightning-button.editor-save").click();
    await flush();
    const mode = () =>
      $$(element, "tbody tr")[0].querySelectorAll("td")[2].textContent.trim();
    expect(mode()).toBe("Approval required");

    // The refresh's list from before the save doesn't put Off back.
    late([off, LEADS]);
    await flush();
    expect(mode()).toBe("Approval required");
  });

  it("stops governing a flow", async () => {
    removeGovernance.mockResolvedValue();
    const element = mount();
    await flush();
    const seen = toasts(element);

    pickFromMenu(element, 1, "remove");
    await flush();
    expect($(element, ".remove-text").textContent).toBe(
      "Lead Assignment will no longer need approval to activate. Its history is kept: search Recent activity for it by name."
    );
    // The × closes it like Cancel.
    $(element, "section.remove-dialog .close").click();
    await flush();
    expect($(element, "section.remove-dialog")).toBeNull();
    expect(removeGovernance).not.toHaveBeenCalled();

    pickFromMenu(element, 1, "remove");
    await flush();
    $(element, "lightning-button.remove-confirm").click();
    await flush();

    expect(removeGovernance).toHaveBeenCalledWith({ id: "a02B" });
    expect(seen[0].title).toBe("Governance removed");
    expect($(element, "section.remove-dialog")).toBeNull();
  });

  it("runs the check and shows each outcome", async () => {
    runCheck.mockResolvedValue([
      {
        governanceId: "a02A",
        apiName: "Case_Email_Routing",
        connection: "local",
        outcome: "ok"
      },
      {
        governanceId: "a02B",
        apiName: "Lead_Assignment",
        connection: "Staging",
        outcome: "reverted",
        message: "Reverted version 3 to version 2."
      },
      {
        governanceId: "a02C",
        apiName: "Old_Flow",
        connection: "local",
        outcome: "off"
      },
      {
        governanceId: "a02D",
        apiName: "Busy_Flow",
        connection: "local",
        outcome: "skipped",
        message: "Changed during the check. The next check covers it."
      }
    ]);
    const element = mount();
    await flush();
    const seen = toasts(element);

    $(element, "lightning-button.run-check").click();
    await flush();

    const items = $$(element, ".check");
    expect(items.map((item) => item.textContent)).toEqual([
      "Case Email RoutingThis orgActive version is approved.",
      "Lead AssignmentStagingReverted version 3 to version 2.",
      "Old_FlowThis orgNot enforced. Tracked the active version.",
      "Busy_FlowThis orgChanged during the check. The next check covers it."
    ]);
    expect(items[1].className).toContain("check-warning");
    expect(items[3].className).toContain("check-info");
    expect(seen[0]).toEqual({
      title: "Check finished",
      message:
        "3 flows checked, 1 needing attention. 1 flow left for the next check.",
      variant: "warning"
    });
  });

  it("hides admin actions from other users", async () => {
    getUserContext.mockResolvedValue({ userId: "005X", isAdmin: false });
    const element = mount();
    await flush();

    expect($(element, "lightning-button.add")).toBeNull();
    expect($(element, "lightning-button.run-check")).toBeNull();
    expect($(element, "lightning-button-menu.row-menu")).toBeNull();
    expect($(element, ".checks-link")).toBeNull();
    expect($$(element, "lightning-button.history")).toHaveLength(2);
  });

  it("explains an empty list", async () => {
    listGoverned.mockResolvedValue([]);
    listAuditEventsBefore.mockResolvedValue([]);
    const element = mount();
    await flush();

    expect($(element, ".empty").textContent).toContain(
      "No flows are governed yet."
    );
    expect($(element, ".history-panel").textContent).toContain(
      "Nothing has happened yet."
    );
  });
});
