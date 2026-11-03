import { createElement } from "lwc";
import FlowApprovals from "c/flowApprovals";
import { CurrentPageReference, navigate } from "lightning/navigation";
import listRequestPage from "@salesforce/apex/FlowGovernanceController.listRequestPage";
import getRequest from "@salesforce/apex/FlowGovernanceController.getRequest";
import { forgetGovernance } from "c/flowGovernanceCache";
import approveRequest from "@salesforce/apex/FlowGovernanceController.approveRequest";
import rejectRequest from "@salesforce/apex/FlowGovernanceController.rejectRequest";
import cancelRequest from "@salesforce/apex/FlowGovernanceController.cancelRequest";

jest.mock("lightning/navigation", () => {
  const {
    createTestWireAdapter
  } = require("@salesforce/wire-service-jest-util");
  const navigateSpy = jest.fn();
  const Navigate = Symbol("Navigate");
  const NavigationMixin = (Base) =>
    class extends Base {
      [Navigate](pageRef, replace) {
        navigateSpy(pageRef, replace);
      }
    };
  NavigationMixin.Navigate = Navigate;
  return {
    CurrentPageReference: createTestWireAdapter(jest.fn()),
    NavigationMixin,
    navigate: navigateSpy
  };
});
jest.mock(
  "@salesforce/apex/FlowGovernanceController.listRequestPage",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.getRequest",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.approveRequest",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.rejectRequest",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.cancelRequest",
  () => ({ default: jest.fn() }),
  { virtual: true }
);

const flush = async () => {
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const PENDING = {
  id: "a01A",
  apiName: "Case_Email_Routing",
  label: "Case Email Routing",
  connection: "local",
  versionNumber: 5,
  versionId: "301E",
  status: "Pending",
  requestedBy: "Sam Builder",
  requestedAt: "2026-09-20T15:00:00.000Z",
  approverName: "Jo Owner",
  comments: "Adds the escalation path.",
  changeSummary: "Compared with Version 4: 1 added.",
  comparedVersion: 4,
  canDecide: true,
  canCancel: false
};

const MINE = {
  ...PENDING,
  id: "a01B",
  apiName: "Lead_Assignment",
  label: "Lead Assignment",
  connection: "Staging",
  versionNumber: 2,
  requestedBy: "Me",
  canDecide: false,
  canCancel: true
};

// A last page of requests.
const page = (requests) => ({ requests });

// The first page's read for a tab and status.
const first = (scope, status) => ({
  scope,
  status,
  beforeDate: null,
  beforeId: null,
  pageSize: 25
});

function mount(state, props = {}) {
  const element = createElement("c-flow-approvals", { is: FlowApprovals });
  Object.assign(element, props);
  document.body.appendChild(element);
  CurrentPageReference.emit({
    type: "standard__navItemPage",
    attributes: { apiName: "cllc__Flow_Approvals" },
    state: state || {}
  });
  return element;
}

const $ = (element, selector) => element.shadowRoot.querySelector(selector);
const $$ = (element, selector) => [
  ...element.shadowRoot.querySelectorAll(selector)
];

describe("c-flow-approvals", () => {
  beforeEach(() => {
    listRequestPage.mockImplementation(({ scope }) =>
      Promise.resolve(page(scope === "submitted" ? [MINE] : [PENDING]))
    );
  });

  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    jest.clearAllMocks();
    forgetGovernance();
  });

  it("lists the pending requests waiting for the user", async () => {
    const element = mount();
    await flush();

    expect(listRequestPage).toHaveBeenCalledWith(first("mine", "Pending"));
    const cards = $$(element, ".request");
    expect(cards).toHaveLength(1);
    expect($(element, ".request-title").textContent).toBe(
      "Case Email Routing · version 5"
    );
    expect($(element, ".request .slds-badge").textContent).toBe("Pending");
    expect(cards[0].textContent).toContain("Requested by Sam Builder");
    expect(cards[0].textContent).toContain("Waiting for Jo Owner");
    expect($(element, ".comments").textContent).toBe(
      "Adds the escalation path."
    );
    expect($(element, ".change").textContent).toBe(
      "Compared with Version 4: 1 added."
    );
    expect($(element, "lightning-button.approve")).not.toBeNull();
    expect($(element, "lightning-button.reject")).not.toBeNull();
    expect($(element, "lightning-button.cancel")).toBeNull();
  });

  it("navigates request tabs with arrow, Home and End keys", async () => {
    const element = mount();
    await flush();
    const tab = (scope) =>
      $$(element, ".tab").find((item) => item.dataset.scope === scope);
    for (const [from, key, to] of [
      ["mine", "ArrowRight", "submitted"],
      ["submitted", "End", "all"],
      ["all", "ArrowRight", "mine"],
      ["mine", "ArrowLeft", "all"],
      ["all", "Home", "mine"]
    ]) {
      // Each tab reads its list, rather than reuse the last minute's.
      forgetGovernance();
      tab(from).dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true })
      );
      // eslint-disable-next-line no-await-in-loop
      await flush();
      expect(listRequestPage).toHaveBeenLastCalledWith(first(to, "Pending"));
      expect(tab(to).getAttribute("aria-selected")).toBe("true");
      expect(tab(to).tabIndex).toBe(0);
      expect(
        $$(element, ".tab").filter((item) => item.tabIndex === 0)
      ).toHaveLength(1);
      expect(
        $(element, '[role="tabpanel"]').getAttribute("aria-labelledby")
      ).toBe(tab(to).id);
      expect(element.shadowRoot.activeElement).toBe(tab(to));
    }
  });

  it("opens the comparison for a request", async () => {
    const element = mount();
    await flush();

    $(element, "lightning-button.compare").click();

    expect(navigate).toHaveBeenCalledWith(
      {
        type: "standard__navItemPage",
        attributes: { apiName: "cllc__Flow_Compare" },
        // The same comparison the summary describes.
        state: {
          c__flow: "Case_Email_Routing",
          c__va: "4",
          c__vb: "5",
          c__request: "a01A"
        }
      },
      undefined
    );
  });

  it("approves with comments, reports the activation and reloads", async () => {
    approveRequest.mockResolvedValue({ ...PENDING, status: "Activated" });
    const element = mount();
    await flush();
    const toasts = [];
    element.addEventListener("lightning__showtoast", (event) =>
      toasts.push(event.detail)
    );

    $(element, "lightning-button.approve").click();
    await flush();
    expect($(element, ".dialog-text").textContent).toBe(
      "Case Email Routing version 5 goes live for everyone who runs the flow. Keep this page open until it says it's done."
    );
    const comments = $(element, "lightning-textarea.dialog-comments");
    comments.value = "Looks good";
    comments.dispatchEvent(new CustomEvent("change"));
    listRequestPage.mockResolvedValue(page([]));
    $(element, "lightning-button.confirm").click();
    await flush();

    expect(approveRequest).toHaveBeenCalledWith({
      requestId: "a01A",
      comments: "Looks good"
    });
    expect(toasts).toEqual([
      {
        title: "Activated",
        message: "Case Email Routing version 5 is now active.",
        variant: "success"
      }
    ]);
    expect($(element, ".decision-result").textContent).toContain(
      "Case Email Routing version 5 is now active."
    );
    expect($(element, "section.slds-modal")).toBeNull();
    expect(listRequestPage).toHaveBeenCalledTimes(2);
    expect($(element, ".empty").textContent).toContain(
      "Nothing is waiting for your approval."
    );
  });

  it("marks an admin override and the version an approval replaces", async () => {
    listRequestPage.mockResolvedValue(
      page([
        { ...PENDING, overrides: true, replacesVersion: 1, comparedVersion: 3 }
      ])
    );
    const element = mount();
    await flush();

    const approve = $(element, "lightning-button.approve");
    expect(approve.label).toBe("Approve as admin");
    expect(approve.variant).toBe("neutral");
    expect($(element, ".replaces").textContent).toBe(
      "Replaces version 1, the active version when this was requested."
    );

    $(element, "lightning-button.compare-replaced").click();
    expect(navigate).toHaveBeenCalledWith(
      {
        type: "standard__navItemPage",
        attributes: { apiName: "cllc__Flow_Compare" },
        state: {
          c__flow: "Case_Email_Routing",
          c__va: "1",
          c__vb: "5",
          c__request: "a01A"
        }
      },
      undefined
    );

    approve.click();
    await flush();
    expect($(element, ".dialog-text").textContent).toContain(
      "in place of version 1"
    );
  });

  it("moves focus into the decision dialog and back out", async () => {
    const focused = [];
    const spy = jest
      .spyOn(HTMLElement.prototype, "focus")
      .mockImplementation(function focus() {
        focused.push(this);
      });
    const element = mount();
    await flush();

    $(element, "lightning-button.reject").click();
    await flush();
    const dialog = $(element, "section.slds-modal");
    expect(focused.pop()).toBe(dialog);
    const [before, after] = $$(element, ".focus-guard");
    before.dispatchEvent(new CustomEvent("focus"));
    expect(focused.pop()).toBe($(element, "lightning-button.confirm"));
    after.dispatchEvent(new CustomEvent("focus"));
    expect(focused.pop()).toBe(
      $(element, "lightning-textarea.dialog-comments")
    );

    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    expect($(element, "section.slds-modal")).toBeNull();
    expect(focused.pop()).toBe($(element, "lightning-button.reject"));
    spy.mockRestore();
  });

  it("focuses the filters when the decided request leaves the list", async () => {
    approveRequest.mockResolvedValue({ ...PENDING, status: "Activated" });
    const focused = [];
    const spy = jest
      .spyOn(HTMLElement.prototype, "focus")
      .mockImplementation(function focus() {
        focused.push(this);
      });
    const element = mount();
    await flush();
    $(element, "lightning-button.approve").click();
    await flush();
    listRequestPage.mockResolvedValue(page([]));
    $(element, "lightning-button.confirm").click();
    await flush();
    expect(focused.pop()).toBe($(element, "lightning-combobox.status"));
    spy.mockRestore();
  });

  it("fades a decided request out before it leaves the list", async () => {
    approveRequest.mockResolvedValue({ ...PENDING, status: "Activated" });
    window.matchMedia = jest.fn(() => ({ matches: false }));
    const focused = [];
    const spy = jest
      .spyOn(HTMLElement.prototype, "focus")
      .mockImplementation(function focus() {
        focused.push(this);
      });
    try {
      const element = mount();
      await flush();
      $(element, "lightning-button.approve").click();
      await flush();
      listRequestPage.mockResolvedValue(page([]));
      $(element, "lightning-button.confirm").click();
      await flush();
      await flush();
      // Still there, fading, and hidden from assistive tech meanwhile.
      const leaving = $(element, "li.request");
      expect(leaving.className).toContain("request-leaving");
      expect(leaving.getAttribute("aria-hidden")).toBe("true");
      expect(focused).not.toContain($(element, "lightning-combobox.status"));
      await new Promise((resolve) => {
        setTimeout(resolve, 400);
      });
      await flush();
      expect($(element, "li.request")).toBeNull();
      expect(focused.pop()).toBe($(element, "lightning-combobox.status"));
    } finally {
      spy.mockRestore();
      delete window.matchMedia;
    }
  });

  it("keeps a page shown while a decided request fades out", async () => {
    approveRequest.mockResolvedValue({ ...PENDING, status: "Activated" });
    window.matchMedia = jest.fn(() => ({ matches: false }));
    const OTHER = { ...PENDING, id: "a01B" };
    const more = {
      nextBefore: "2026-09-19T15:00:00.000Z",
      nextBeforeId: "a01B"
    };
    try {
      listRequestPage.mockResolvedValue({
        requests: [PENDING, OTHER],
        ...more
      });
      const element = mount();
      await flush();
      $(element, "lightning-button.approve").click();
      await flush();
      listRequestPage
        .mockResolvedValueOnce({ requests: [OTHER], ...more })
        .mockResolvedValueOnce(page([{ ...PENDING, id: "a01C" }]));
      $(element, "lightning-button.confirm").click();
      await flush();
      // The next page arrives during the fade, and is still there after it.
      $(element, "lightning-button.show-more").click();
      await flush();
      await new Promise((resolve) => {
        setTimeout(resolve, 400);
      });
      await flush();
      expect($$(element, ".request")).toHaveLength(2);
      expect($(element, ".request-leaving")).toBeNull();
    } finally {
      delete window.matchMedia;
    }
  });

  it("reports an approval whose activation failed", async () => {
    approveRequest.mockResolvedValue({
      ...PENDING,
      status: "Failed",
      error: "The flow has errors."
    });
    const element = mount();
    await flush();
    const toasts = [];
    element.addEventListener("lightning__showtoast", (event) =>
      toasts.push(event.detail)
    );

    $(element, "lightning-button.approve").click();
    await flush();
    $(element, "lightning-button.confirm").click();
    await flush();

    expect(toasts[0]).toEqual({
      title: "Approved, but activation failed",
      message: "The flow has errors.",
      variant: "error"
    });
  });

  it("keeps the dialog open with the error when a decision fails", async () => {
    rejectRequest.mockRejectedValue({
      body: { message: "Only the owner can decide." }
    });
    const element = mount();
    await flush();

    $(element, "lightning-button.reject").click();
    await flush();
    expect($(element, ".slds-modal__title").textContent).toBe("Reject request");
    $(element, "lightning-button.confirm").click();
    await flush();

    expect(rejectRequest).toHaveBeenCalledWith({
      requestId: "a01A",
      comments: ""
    });
    expect($(element, "section.slds-modal .error").textContent).toBe(
      "Only the owner can decide."
    );
  });

  it("shows the user's own requests and lets them withdraw one", async () => {
    cancelRequest.mockResolvedValue({ ...MINE, status: "Cancelled" });
    const element = mount();
    await flush();

    $$(element, ".tab")
      .find((tab) => tab.dataset.scope === "submitted")
      .click();
    await flush();

    expect(listRequestPage).toHaveBeenLastCalledWith(
      first("submitted", "Pending")
    );
    const card = $(element, ".request");
    expect(card.textContent).toContain("Org: Staging");
    expect($(element, "lightning-button.approve")).toBeNull();

    $(element, "lightning-button.cancel").click();
    await flush();
    expect($(element, "lightning-textarea.dialog-comments")).toBeNull();
    $(element, "lightning-button.confirm").click();
    await flush();

    expect(cancelRequest).toHaveBeenCalledWith({ requestId: "a01B" });
  });

  it("filters by status and keeps the filters in the address", async () => {
    const element = mount();
    await flush();

    const status = $(element, "lightning-combobox.status");
    status.dispatchEvent(new CustomEvent("change", { detail: { value: "" } }));
    await flush();

    expect(listRequestPage).toHaveBeenLastCalledWith(first("mine", ""));
    expect(navigate).toHaveBeenLastCalledWith(
      {
        type: "standard__navItemPage",
        attributes: { apiName: "cllc__Flow_Approvals" },
        state: { c__scope: "mine", c__status: "any" }
      },
      true
    );
  });

  it("comes back to the filters it was left with", async () => {
    mount({ c__scope: "all", c__status: "Rejected" });
    await flush();

    expect(listRequestPage).toHaveBeenLastCalledWith(first("all", "Rejected"));
  });

  it("says what a filtered empty list leaves out", async () => {
    listRequestPage.mockResolvedValue(page([]));
    const element = mount({ c__scope: "all" });
    await flush();

    expect($(element, ".empty-text").textContent).toBe(
      "No pending requests across all flows."
    );
    expect($(element, ".empty-icon").iconName).toBe("utility:filterList");
    $(element, "lightning-button.show-all").click();
    await flush();
    expect(listRequestPage).toHaveBeenLastCalledWith(first("all", ""));
    expect($(element, ".empty-text").textContent).toBe(
      "Nobody has requested an activation yet."
    );
    expect($(element, "lightning-button.show-all")).toBeNull();
  });

  it("points someone with no requests at Tributary", async () => {
    listRequestPage.mockResolvedValue(page([]));
    const element = mount({ c__scope: "submitted", c__status: "any" });
    await flush();

    expect($(element, ".empty-text").textContent).toContain(
      "You haven't requested an activation yet."
    );
    $(element, "lightning-button.open-compare").click();
    expect(navigate).toHaveBeenLastCalledWith(
      {
        type: "standard__navItemPage",
        attributes: { apiName: "cllc__Flow_Compare" }
      },
      undefined
    );
  });

  it("keeps the list in place, marked busy, while it reloads", async () => {
    const element = mount();
    await flush();
    let answer;
    listRequestPage.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    $(element, "lightning-button-icon").click();
    await flush();
    const results = $(element, ".results");
    expect(results.getAttribute("aria-busy")).toBe("true");
    expect($$(element, ".request")).toHaveLength(1);
    answer(page([]));
    await flush();
    expect(results.getAttribute("aria-busy")).toBe("false");
    expect($(element, ".empty-done")).not.toBeNull();
  });

  it("shows the request a notification links to, whatever its status", async () => {
    // Decided since, and not in the queue the link names.
    getRequest.mockResolvedValue({
      ...PENDING,
      status: "Activated",
      decidedBy: "Jo Owner",
      canDecide: false
    });
    listRequestPage.mockResolvedValue(page([PENDING, MINE]));
    const element = mount({ c__scope: "mine", c__request: "a01A" });
    await flush();

    expect(getRequest).toHaveBeenCalledWith({ requestId: "a01A" });
    // The list keeps its filters; the linked request is read on its own.
    expect(listRequestPage).toHaveBeenLastCalledWith(first("mine", "Pending"));
    const cards = $$(element, ".request");
    expect(cards).toHaveLength(2);
    expect(cards[0].className).toContain("request-highlight");
    expect(cards[0].textContent).toContain(
      "The request your notification links to."
    );
    expect(cards[0].textContent).toContain("Decided by Jo Owner");
    expect(cards[0].querySelector(".slds-badge").textContent).toBe("Activated");
    // A decided request has no decision to make.
    expect(cards[0].querySelector("lightning-button.approve")).toBeNull();
    expect(cards[0].querySelector("lightning-button.reject")).toBeNull();
    expect(cards[1].className).not.toContain("request-highlight");
    expect(cards[1].querySelector(".request-title").textContent).toBe(
      "Lead Assignment · version 2"
    );
  });

  it("shows a linked request above an empty queue", async () => {
    getRequest.mockResolvedValue(PENDING);
    listRequestPage.mockResolvedValue(page([]));
    const element = mount({ c__request: "a01A" });
    await flush();

    expect($$(element, ".request")).toHaveLength(1);
    expect($(element, "lightning-button.approve")).not.toBeNull();
    expect($(element, ".empty-text").textContent).toBe(
      "Nothing is waiting for your approval."
    );
  });

  it("says when a linked request can't be shown", async () => {
    getRequest.mockRejectedValue({
      body: { message: "You don't have access to it." }
    });
    const element = mount({ c__request: "a01Z" });
    await flush();

    expect($(element, ".linked-error").textContent).toBe(
      "The request you followed a link to can't be shown. You don't have access to it."
    );
    expect($$(element, ".request")).toHaveLength(1);
  });

  it("reads the linked request again after deciding on it", async () => {
    getRequest.mockResolvedValueOnce(PENDING).mockResolvedValueOnce({
      ...PENDING,
      status: "Rejected",
      decidedBy: "Jo Owner",
      canDecide: false
    });
    rejectRequest.mockResolvedValue({ ...PENDING, status: "Rejected" });
    listRequestPage.mockResolvedValue(page([]));
    const element = mount({ c__request: "a01A" });
    await flush();

    $(element, "lightning-button.reject").click();
    await flush();
    $(element, "lightning-button.confirm").click();
    await flush();

    expect(getRequest).toHaveBeenCalledTimes(2);
    expect($(element, ".request .slds-badge").textContent).toBe("Rejected");
    expect($(element, "lightning-button.reject")).toBeNull();
  });

  it("shows a long request's full text when asked", async () => {
    listRequestPage.mockResolvedValue(
      page([{ ...PENDING, comments: "Adds the esc...", truncated: true }])
    );
    getRequest.mockResolvedValue(PENDING);
    const element = mount();
    await flush();

    expect($(element, ".comments").textContent).toBe("Adds the esc...");
    $(element, "lightning-button.show-full").click();
    await flush();

    expect(getRequest).toHaveBeenCalledWith({ requestId: "a01A" });
    expect($(element, ".comments").textContent).toBe(
      "Adds the escalation path."
    );
    expect($(element, "lightning-button.show-full")).toBeNull();
  });

  it("adds the next page after the last request read", async () => {
    listRequestPage
      .mockResolvedValueOnce({
        requests: [PENDING],
        nextBefore: "2026-09-20T15:00:00.000Z",
        nextBeforeId: "a01A"
      })
      .mockResolvedValueOnce(page([{ ...PENDING, id: "a01C" }]));
    const element = mount();
    await flush();

    const more = $(element, "lightning-button.show-more");
    expect(more.label).toBe("Show more requests");
    more.click();
    await flush();

    expect(listRequestPage).toHaveBeenLastCalledWith({
      scope: "mine",
      status: "Pending",
      beforeDate: "2026-09-20T15:00:00.000Z",
      beforeId: "a01A",
      pageSize: 25
    });
    expect($$(element, ".request")).toHaveLength(2);
    expect($(element, "lightning-button.show-more")).toBeNull();
  });

  it("reuses a recent list when the page comes back, and Refresh reads it again", async () => {
    let element = mount();
    await flush();
    document.body.removeChild(element);
    element = mount();
    await flush();

    expect(listRequestPage).toHaveBeenCalledTimes(1);
    expect($$(element, ".request")).toHaveLength(1);

    listRequestPage.mockResolvedValue(page([]));
    $(element, "lightning-button-icon").click();
    await flush();
    expect(listRequestPage).toHaveBeenCalledTimes(2);
    expect($(element, ".empty-done")).not.toBeNull();
  });

  it("decides beside the exact replacement comparison without fetching a queue", async () => {
    const request = { ...PENDING, replacesVersion: 1 };
    getRequest.mockResolvedValue(request);
    const comparison = {
      versions: true,
      a: { connection: "local", apiName: request.apiName },
      b: { connection: "local", apiName: request.apiName },
      versionA: { versionNumber: 1 },
      versionB: { versionNumber: 5 }
    };
    const element = mount(
      {},
      { embedded: true, requestId: request.id, comparison }
    );
    await flush();
    expect(listRequestPage).not.toHaveBeenCalled();
    expect($(element, ".tabs")).toBeNull();
    expect($(element, '[role="region"]')).not.toBeNull();
    const decided = jest.fn();
    element.addEventListener("decided", decided);
    $(element, "lightning-button.approve").click();
    await flush();
    const activated = { ...request, status: "Activated", canDecide: false };
    approveRequest.mockResolvedValue(activated);
    getRequest.mockResolvedValue(activated);
    $(element, "lightning-button.confirm").click();
    await flush();
    expect(approveRequest).toHaveBeenCalledWith({
      requestId: request.id,
      comments: ""
    });
    expect(decided.mock.calls[0][0].detail).toEqual({
      connection: "local",
      apiName: request.apiName
    });
    expect($(element, ".decision-result").textContent).toContain(
      "is now active"
    );
    expect($(element, "lightning-button.approve")).toBeNull();
    expect(getRequest).toHaveBeenCalledTimes(2);
    expect(listRequestPage).not.toHaveBeenCalled();
  });

  it("withholds embedded decisions for other flows, orgs, versions or an unready comparison", async () => {
    const request = { ...PENDING, replacesVersion: 1 };
    getRequest.mockResolvedValue(request);
    const comparison = {
      versions: true,
      a: { connection: "local", apiName: request.apiName },
      b: { connection: "local", apiName: request.apiName },
      versionA: { versionNumber: 1 },
      versionB: { versionNumber: 5 }
    };
    const element = mount({}, { embedded: true, requestId: request.id });
    for (const wrong of [
      undefined,
      { versions: true },
      { ...comparison, a: undefined },
      { ...comparison, versionB: undefined },
      { ...comparison, versions: false },
      { ...comparison, versionA: { versionNumber: 4 } },
      { ...comparison, versionB: { versionNumber: 6 } },
      { ...comparison, b: { ...comparison.b, connection: "Staging" } },
      { ...comparison, b: { ...comparison.b, apiName: "Other_Flow" } }
    ]) {
      element.comparison = wrong;
      // eslint-disable-next-line no-await-in-loop
      await flush();
      expect($(element, "lightning-button.approve")).toBeNull();
    }
    element.comparison = comparison;
    await flush();
    $(element, "lightning-button.approve").click();
    await flush();
    element.comparison = undefined;
    await flush();
    $(element, "lightning-button.confirm").click();
    await flush();
    expect(approveRequest).not.toHaveBeenCalled();
    expect($(element, ".dialog-text").textContent).toContain(
      "in place of version 1"
    );
    expect($(element, ".slds-modal .error").textContent).toContain(
      "comparison changed"
    );
  });

  it("ignores old embedded reads after switching or clearing a request", async () => {
    let firstRead;
    let secondRead;
    getRequest
      .mockReturnValueOnce(
        new Promise((resolve) => {
          firstRead = resolve;
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          secondRead = resolve;
        })
      );
    const element = mount({}, { embedded: true, requestId: PENDING.id });
    await flush();
    element.requestId = MINE.id;
    await flush();
    firstRead(PENDING);
    await flush();
    expect($(element, ".request")).toBeNull();
    expect($(element, ".results").getAttribute("aria-busy")).toBe("true");
    element.requestId = undefined;
    await flush();
    expect($(element, ".results").getAttribute("aria-busy")).toBe("false");
    secondRead(MINE);
    await flush();
    expect($(element, ".request")).toBeNull();
    expect(listRequestPage).not.toHaveBeenCalled();
  });

  it("drops an in-flight notification link when navigation removes it", async () => {
    let answer;
    getRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    listRequestPage.mockResolvedValue(page([]));
    const element = mount({ c__request: PENDING.id });
    await flush();
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "cllc__Flow_Approvals" },
      state: {}
    });
    answer(PENDING);
    await flush();
    expect($(element, ".request")).toBeNull();
  });

  it("makes direction controls visible in comments without changing the submitted text", async () => {
    const comments = "Review‮secret‬";
    listRequestPage.mockResolvedValue(page([{ ...PENDING, comments }]));
    const element = mount();
    await flush();
    expect($(element, ".comments").textContent).toBe(
      "Review⟦U+202E⟧secret⟦U+202C⟧"
    );
    $(element, "lightning-button.approve").click();
    await flush();
    const input = $(element, "lightning-textarea.dialog-comments");
    input.value = comments;
    input.dispatchEvent(new CustomEvent("change"));
    approveRequest.mockResolvedValue({ ...PENDING, status: "Activated" });
    $(element, "lightning-button.confirm").click();
    await flush();
    expect(approveRequest).toHaveBeenCalledWith({
      requestId: PENDING.id,
      comments
    });
  });

  it("shows a load error", async () => {
    listRequestPage.mockRejectedValue({ body: { message: "No access." } });
    const element = mount();
    await flush();

    expect($(element, ".error").textContent).toBe("No access.");
    expect($(element, ".empty")).toBeNull();
  });
});
