import { createElement } from "lwc";
import FlowActivation from "c/flowActivation";
import getFlowStatus from "@salesforce/apex/FlowGovernanceController.getFlowStatus";
import requestActivation from "@salesforce/apex/FlowGovernanceController.requestActivation";
import activateVersion from "@salesforce/apex/FlowGovernanceController.activateVersion";
import { CurrentPageReference, navigate } from "lightning/navigation";
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
  "@salesforce/apex/FlowGovernanceController.getFlowStatus",
  () => ({ default: jest.fn() }),
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(props) {
  const element = createElement("c-flow-activation", { is: FlowActivation });
  Object.assign(element, props);
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
  jest.clearAllMocks();
  forgetGovernance();
});

describe("c-flow-activation", () => {
  it("loads the final org regardless of public property assignment order", async () => {
    getFlowStatus.mockResolvedValue({
      governance: null,
      canActivate: false,
      pending: []
    });
    mount({ apiName: "Demo", connection: "Production", versionNumber: 2 });
    await flush();
    expect(getFlowStatus).toHaveBeenCalledTimes(1);
    expect(getFlowStatus).toHaveBeenCalledWith({
      connection: "Production",
      apiName: "Demo"
    });
  });

  it("shares one status read between cards for the same flow", async () => {
    getFlowStatus.mockResolvedValue({
      governance: null,
      canActivate: false,
      pending: []
    });
    mount({ apiName: "Shared", versionNumber: 2 });
    mount({ apiName: "Shared", versionNumber: 3, brief: true });
    await flush();
    expect(getFlowStatus).toHaveBeenCalledTimes(1);
  });

  it("reuses a recent status when Activate opens again, but not after a change", async () => {
    getFlowStatus.mockResolvedValue({
      governance: { mode: "Watch", ownerName: "Ada" },
      canActivate: false,
      canRequest: true,
      pending: []
    });
    requestActivation.mockResolvedValue({ id: "a02", approverName: "Ada" });
    const first = mount({ apiName: "Demo", versionNumber: 5 });
    await flush();
    document.body.removeChild(first);
    const again = mount({ apiName: "Demo", versionNumber: 5 });
    await flush();
    expect(getFlowStatus).toHaveBeenCalledTimes(1);
    expect(again.shadowRoot.querySelector(".governance-text")).not.toBeNull();

    // Requesting reads the card's status again, and forgets every other
    // flow's: a change can move what they show too.
    const other = mount({ apiName: "Other", versionNumber: 1 });
    await flush();
    expect(getFlowStatus).toHaveBeenCalledTimes(2);
    again.shadowRoot.querySelector("lightning-button").click();
    await flush();
    expect(getFlowStatus).toHaveBeenCalledTimes(3);
    document.body.removeChild(other);
    mount({ apiName: "Other", versionNumber: 1 });
    await flush();
    expect(getFlowStatus).toHaveBeenCalledTimes(4);
  });

  it("ignores stale status and errors when the same flow name moves to another org", async () => {
    let rejectLocal;
    getFlowStatus.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          rejectLocal = reject;
        })
    );
    const element = mount({ apiName: "Demo", versionNumber: 2 });
    getFlowStatus.mockResolvedValue({
      governance: null,
      canActivate: false,
      canRequest: true,
      pending: []
    });
    element.connection = "Production";
    await flush();
    rejectLocal(new Error("Old org error"));
    await flush();
    expect(element.shadowRoot.querySelector(".error")).toBeNull();
    expect(element.shadowRoot.querySelector(".activate")).toBeNull();
    expect(getFlowStatus).toHaveBeenLastCalledWith({
      connection: "Production",
      apiName: "Demo"
    });
  });

  it("cancels confirmation when its version changes", async () => {
    getFlowStatus.mockResolvedValue({
      governance: null,
      canActivate: true,
      pending: []
    });
    const element = mount({ apiName: "Demo", versionNumber: 2 });
    await flush();
    element.shadowRoot.querySelector("lightning-button.activate").click();
    await flush();
    const confirm = element.shadowRoot.querySelector(".confirm-activate");
    element.versionNumber = 3;
    confirm.click();
    await flush();
    expect(activateVersion).not.toHaveBeenCalled();
    expect(element.shadowRoot.querySelector(".confirm")).toBeNull();
  });

  it("does not report an old operation as activation of the newly selected version", async () => {
    getFlowStatus.mockResolvedValue({
      governance: null,
      canActivate: true,
      pending: []
    });
    let finish;
    activateVersion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const element = mount({ apiName: "Demo", versionNumber: 2 });
    const activated = jest.fn();
    element.addEventListener("activated", activated);
    await flush();
    element.shadowRoot.querySelector("lightning-button.activate").click();
    await flush();
    element.shadowRoot.querySelector(".confirm-activate").click();
    element.versionNumber = 3;
    finish({ status: "Activated", versionNumber: 2 });
    await flush();
    expect(activated).not.toHaveBeenCalled();
    expect(element.shadowRoot.querySelector(".outcome")).toBeNull();
  });
  it("activates at once for the owner", async () => {
    getFlowStatus.mockResolvedValue({
      governance: {
        mode: "Locked",
        ownerId: "005A",
        ownerName: "Ada",
        isOwner: true
      },
      canActivate: true,
      canRequest: true,
      pending: []
    });
    activateVersion.mockResolvedValue({
      id: "a01",
      status: "Activated",
      versionNumber: 4
    });
    const element = mount({
      apiName: "Demo",
      label: "Demo flow",
      versionNumber: 4,
      versionId: "301",
      activeVersion: 3,
      comparedVersion: 3,
      reviewedAt: "2026-09-27T12:00:00.000Z"
    });
    const activated = jest.fn();
    element.addEventListener("activated", activated);
    await flush();
    expect(
      element.shadowRoot.querySelector(".governance-text").textContent
    ).toContain("Ada");
    expect(element.shadowRoot.querySelector(".current").textContent).toBe(
      "Currently active: version 3"
    );
    const button = element.shadowRoot.querySelector("lightning-button");
    expect(button.label).toBe("Approve and activate version 4");
    button.click();
    await flush();
    // Nothing goes live until it's confirmed.
    expect(activateVersion).not.toHaveBeenCalled();
    expect(element.shadowRoot.querySelector(".confirm-text").textContent).toBe(
      "Make version 4 the active version of Demo flow in this org?"
    );
    expect(
      element.shadowRoot.querySelector(".confirm-detail").textContent
    ).toContain("Version 3 stops running");
    element.shadowRoot.querySelector(".confirm-activate").click();
    await flush();
    expect(activateVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        apiName: "Demo",
        versionNumber: 4,
        versionId: "301",
        comments: "",
        comparedVersion: 3,
        reviewedAt: "2026-09-27T12:00:00.000Z",
        replacesVersion: 3
      })
    );
    expect(requestActivation).not.toHaveBeenCalled();
    expect(activated).toHaveBeenCalled();
    expect(element.shadowRoot.querySelector(".outcome").textContent).toContain(
      "now active"
    );
    // It says so at once, without waiting for the parent to refresh.
    expect(element.shadowRoot.querySelector(".current-this")).not.toBeNull();
  });

  it("says when the checks that enforce governance have stopped", async () => {
    getFlowStatus.mockResolvedValue({
      governance: { mode: "Watch", ownerName: "Ada" },
      monitor: { scheduled: false, running: false },
      canActivate: true,
      canGovern: true,
      canRequest: true,
      pending: []
    });
    const element = mount({ apiName: "Demo", versionNumber: 4 });
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "cllc__Flow_Compare" }
    });
    await flush();
    const checks = element.shadowRoot.querySelector(".checks");
    expect(checks.className).toContain("checks-off");
    expect(checks.querySelector(".slds-badge").textContent).toBe("Stopped");
    expect(
      element.shadowRoot.querySelector(".governance-text").textContent
    ).toContain("An activation by anyone but the owner is reverted");
    const link = element.shadowRoot.querySelector("a.checks-link");
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

  it("names the org when outside activations can't be matched", async () => {
    getFlowStatus.mockResolvedValue({
      governance: { mode: "Watch", ownerName: "Ada" },
      monitor: { scheduled: true, running: false, intervalMinutes: 15 },
      canActivate: false,
      canGovern: false,
      canRequest: true,
      pending: []
    });
    const element = mount({
      apiName: "Demo",
      versionNumber: 4,
      connection: "Staging",
      orgLabel: "Staging"
    });
    await flush();
    expect(
      element.shadowRoot.querySelector(".governance-text").textContent
    ).toContain("An activation made in Staging can't be matched to the owner");
    const checks = element.shadowRoot.querySelector(".checks");
    expect(checks.className).not.toContain("checks-off");
    expect(checks.textContent).toContain("Checked every 15 minutes");
    expect(element.shadowRoot.querySelector(".checks-link")).toBeNull();
  });

  it("leaves governance to the first card when it's the second", async () => {
    getFlowStatus.mockResolvedValue({
      governance: { mode: "Locked", ownerName: "Ada" },
      monitor: { scheduled: false, running: false },
      canActivate: true,
      canGovern: true,
      canRequest: true,
      pending: []
    });
    const element = mount({ apiName: "Demo", versionNumber: 3, brief: true });
    await flush();
    const root = element.shadowRoot;
    expect(root.querySelector(".governance .slds-badge").textContent).toBe(
      "Approval required"
    );
    expect(root.querySelector(".governance-text")).toBeNull();
    expect(root.querySelector(".checks")).toBeNull();
  });

  it("keeps saved merge warnings visible before and during confirmation", async () => {
    getFlowStatus.mockResolvedValue({
      governance: null,
      canActivate: true,
      pending: []
    });
    const element = mount({
      apiName: "Demo",
      versionNumber: 4,
      reviewChecks: [
        {
          title: "Checked in Tributary",
          status: "warned",
          summary: "1 warning found.",
          messages: ["Round Discount isn't connected to the start."]
        }
      ]
    });
    await flush();
    expect(
      element.shadowRoot.querySelector(".review-warning").textContent
    ).toContain("Round Discount isn't connected");
    element.shadowRoot.querySelector("lightning-button.activate").click();
    await flush();
    expect(
      element.shadowRoot.querySelector(".confirm .review-warning").textContent
    ).toContain("1 warning found");
    expect(activateVersion).not.toHaveBeenCalled();
  });

  it("can back out of activating", async () => {
    getFlowStatus.mockResolvedValue({
      governance: null,
      canActivate: true,
      canRequest: true,
      pending: []
    });
    const element = mount({ apiName: "Demo", versionNumber: 2 });
    await flush();
    element.shadowRoot.querySelector("lightning-button.activate").click();
    await flush();
    const cancel = [
      ...element.shadowRoot.querySelectorAll(".confirm lightning-button")
    ].find((button) => button.label === "Cancel");
    cancel.click();
    await flush();
    expect(element.shadowRoot.querySelector(".confirm")).toBeNull();
    expect(activateVersion).not.toHaveBeenCalled();
    // An unknown active version isn't reported as none.
    expect(element.shadowRoot.querySelector(".current")).toBeNull();
  });

  it("lets an admin ask the owner first, or override them", async () => {
    getFlowStatus.mockResolvedValue({
      governance: {
        mode: "Locked",
        ownerId: "005A",
        ownerName: "Ada",
        isOwner: false
      },
      canActivate: true,
      canRequest: true,
      pending: []
    });
    const element = mount({ apiName: "Demo", versionNumber: 4 });
    await flush();
    expect(
      element.shadowRoot.querySelector(".override-note").textContent
    ).toContain("Request activation to have Ada approve it");
    const buttons = [
      ...element.shadowRoot.querySelectorAll(".actions lightning-button")
    ];
    expect(buttons.map((button) => [button.label, button.variant])).toEqual([
      ["Request activation of version 4", "brand"],
      ["Activate now (admin override)", "neutral"]
    ]);
    buttons[1].click();
    await flush();
    expect(
      element.shadowRoot.querySelector(".confirm-detail").textContent
    ).toContain("recorded as an admin override and Ada is told");
    expect(element.shadowRoot.querySelector(".confirm-activate").label).toBe(
      "Activate version 4"
    );
  });

  it("backs out of the confirmation alone on Escape", async () => {
    getFlowStatus.mockResolvedValue({
      governance: null,
      canActivate: true,
      canRequest: true,
      pending: []
    });
    const element = mount({ apiName: "Demo", versionNumber: 2 });
    const outer = jest.fn();
    document.body.addEventListener("keydown", outer);
    await flush();
    // Nobody to ask: activating is the one action.
    expect(element.shadowRoot.querySelector(".request")).toBeNull();
    element.shadowRoot.querySelector("lightning-button.activate").click();
    await flush();
    element.shadowRoot.querySelector(".confirm-cancel").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        composed: true
      })
    );
    await flush();
    document.body.removeEventListener("keydown", outer);
    expect(element.shadowRoot.querySelector(".confirm")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it("asks the owner when the user can't activate", async () => {
    getFlowStatus.mockResolvedValue({
      governance: { mode: "Watch", ownerName: "Ada" },
      canActivate: false,
      canRequest: true,
      pending: []
    });
    requestActivation.mockResolvedValue({ id: "a02", approverName: "Ada" });
    const element = mount({ apiName: "Demo", versionNumber: 5 });
    await flush();
    const button = element.shadowRoot.querySelector("lightning-button");
    expect(button.label).toBe("Request activation of version 5");
    button.click();
    await flush();
    expect(activateVersion).not.toHaveBeenCalled();
    expect(element.shadowRoot.querySelector(".outcome").textContent).toContain(
      "Ada"
    );
  });

  it("says a failed activation failed", async () => {
    getFlowStatus.mockResolvedValue({
      governance: null,
      canActivate: true,
      canRequest: true,
      pending: []
    });
    activateVersion.mockResolvedValue({
      id: "a03",
      status: "Failed",
      error: "Not allowed"
    });
    const element = mount({ apiName: "Demo", versionNumber: 2 });
    const activated = jest.fn();
    element.addEventListener("activated", activated);
    await flush();
    expect(
      element.shadowRoot.querySelector(".governance-text").textContent
    ).toContain("anyone who can manage flows");
    element.shadowRoot.querySelector("lightning-button").click();
    await flush();
    element.shadowRoot.querySelector(".confirm-activate").click();
    await flush();
    expect(activated).not.toHaveBeenCalled();
    expect(element.shadowRoot.querySelector(".outcome").textContent).toBe(
      "Activation failed: Not allowed"
    );
  });

  it("points ungoverned requests at the approvals tab", async () => {
    getFlowStatus.mockResolvedValue({
      governance: null,
      canActivate: false,
      canRequest: true,
      pending: []
    });
    requestActivation.mockResolvedValue({ id: "a04" });
    const element = mount({
      apiName: "Demo",
      versionNumber: 2,
      connection: "Production"
    });
    await flush();
    expect(
      element.shadowRoot.querySelector(".governance-text").textContent
    ).toContain("Tributary admins");
    element.shadowRoot.querySelector("lightning-button").click();
    await flush();
    expect(element.shadowRoot.querySelector(".outcome").textContent).toContain(
      "Flow Approvals tab"
    );
  });

  it("shows errors from the server", async () => {
    getFlowStatus.mockRejectedValue({ body: { message: "No access" } });
    const element = mount({ apiName: "Demo", versionNumber: 1 });
    await flush();
    expect(element.shadowRoot.querySelector(".error").textContent).toBe(
      "No access"
    );
  });
});
