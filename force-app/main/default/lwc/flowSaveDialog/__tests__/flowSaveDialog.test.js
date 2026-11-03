import { createElement } from "lwc";
import FlowSaveDialog from "c/flowSaveDialog";
import saveVersion from "@salesforce/apex/FlowCompareController.saveVersion";
import saveAsNewFlow from "@salesforce/apex/FlowCompareController.saveAsNewFlow";
import getFlowStatus from "@salesforce/apex/FlowGovernanceController.getFlowStatus";
import { CurrentPageReference, navigate } from "lightning/navigation";
import { sha256 } from "c/flowReceipt";

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
  () => ({ default: jest.fn(() => Promise.resolve({ pending: [] })) }),
  { virtual: true }
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Records which elements were focused; lightning-button stubs can't be.
function trackFocus() {
  const focused = [];
  jest
    .spyOn(HTMLElement.prototype, "focus")
    .mockImplementation(function focus() {
      focused.push(this);
    });
  return focused;
}

const connections = [
  { name: "local", label: "This org", canSave: true, isLocal: true },
  { name: "Prod", label: "Production", canSave: false, isProduction: true }
];

function mount(props) {
  const element = createElement("c-flow-save-dialog", { is: FlowSaveDialog });
  Object.assign(element, {
    connections,
    metadata: { label: "Demo", processType: "Flow" },
    ...props
  });
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe("c-flow-save-dialog", () => {
  it("saves the version with the description written for it", async () => {
    saveVersion.mockResolvedValue({
      apiName: "Demo",
      versionNumber: 5,
      versionId: "301"
    });
    const element = mount({
      metadata: { label: "Demo", processType: "Flow", description: "Old" },
      targets: [{ connection: "local", apiName: "Demo", label: "Demo" }]
    });
    element.open = true;
    await flush();
    const field = element.shadowRoot.querySelector(
      "lightning-textarea.description"
    );
    // It starts from the merged flow's own description.
    expect(field.value).toBe("Old");
    field.value = "  Adds the large-order path.  ";
    field.dispatchEvent(new CustomEvent("change"));
    element.shadowRoot.querySelector("lightning-button.save").click();
    await flush();
    expect(JSON.parse(saveVersion.mock.calls[0][0].metadataJson)).toEqual({
      label: "Demo",
      processType: "Flow",
      status: "Draft",
      description: "Adds the large-order path."
    });
    // The receipt doesn't claim the merge's pick went through unchanged.
    expect(JSON.parse(saveVersion.mock.calls[0][0].review).receipt).toContain(
      "- Description: written when saving, in place of the merge's."
    );
  });

  it("leaves the description out when it's cleared", async () => {
    saveVersion.mockResolvedValue({ apiName: "Demo", versionNumber: 5 });
    const element = mount({
      metadata: { label: "Demo", processType: "Flow", description: "Old" },
      targets: [{ connection: "local", apiName: "Demo", label: "Demo" }]
    });
    element.open = true;
    await flush();
    const field = element.shadowRoot.querySelector(
      "lightning-textarea.description"
    );
    field.value = " ";
    field.dispatchEvent(new CustomEvent("change"));
    element.shadowRoot.querySelector("lightning-button.save").click();
    await flush();
    expect(
      JSON.parse(saveVersion.mock.calls[0][0].metadataJson).description
    ).toBeUndefined();
  });

  const review = {
    sources: [
      {
        role: "before",
        label: "Version 3",
        connection: "local",
        connectionLabel: "This org",
        apiName: "Demo",
        versionNumber: 3,
        versionId: "301000000000003AAA",
        lastModifiedDate: "2026-09-02T11:30:00.000Z",
        lastModifiedBy: "Ada"
      }
    ],
    decisions: ["Merged Version 3 and Version 4: 2 differences."],
    checks: { errors: 0, warnings: 1, messages: ["Loop_1 has no path out."] }
  };

  it("saves a new version and offers activation", async () => {
    saveVersion.mockResolvedValue({
      apiName: "Demo",
      versionNumber: 5,
      versionId: "301",
      builderUrl: "/builder?flowId=301",
      lastModifiedDate: "2026-09-27T12:00:00.000Z",
      candidate: sha256(
        JSON.stringify({ label: "Demo", processType: "Flow", status: "Draft" })
      ),
      receipt: "Saved from Tributary as inactive version 5.",
      stale: []
    });
    const element = mount({
      changeSummary: "Merged Version 3 and Version 4: 2 differences.",
      review,
      saveKey: 7,
      targets: [
        {
          connection: "local",
          apiName: "Demo",
          label: "Demo flow",
          activeVersion: 4,
          latestVersion: 4
        }
      ]
    });
    const saved = jest.fn();
    element.addEventListener("saved", saved);
    element.open = true;
    await flush();
    // The receipt shows before saving.
    const card = element.shadowRoot.querySelector("c-flow-receipt-card");
    const metadataJson = JSON.stringify({
      label: "Demo",
      processType: "Flow",
      status: "Draft"
    });
    expect(card.receipt.candidate).toBe(sha256(metadataJson));
    expect(card.receipt.checks.map((check) => check.status)).toEqual([
      "warned",
      "notRun",
      "pending"
    ]);
    element.shadowRoot.querySelector("lightning-button.save").click();
    await flush();
    const call = saveVersion.mock.calls[0][0];
    expect(call).toEqual({
      connection: "local",
      apiName: "Demo",
      metadataJson,
      review: expect.any(String)
    });
    // The org is told exactly what was reviewed.
    const sent = JSON.parse(call.review);
    expect(sent.candidate).toBe(sha256(metadataJson));
    expect(sent.latestVersion).toBe(4);
    expect(sent.sources).toEqual([
      {
        connection: "local",
        versionId: "301000000000003AAA",
        lastModifiedDate: "2026-09-02T11:30:00.000Z",
        label: "Version 3"
      }
    ]);
    expect(sent.receipt.split("\n")).toEqual([
      "From:",
      "- Version 3: This org: Demo v3, last changed 2026-09-02 11:30 UTC by Ada, id 301000000000003AAA",
      "Decided:",
      "- Merged Version 3 and Version 4: 2 differences.",
      "Checked in Tributary: 1 warning found. Connectors, references and required parts, read from the metadata. The flow wasn't run.",
      "- Loop_1 has no path out.",
      "Apex tests: Not run by Tributary. Run the org's tests that cover this flow before it's activated, where the flow calls or is called by Apex."
    ]);
    expect(saved.mock.calls[0][0].detail.receipt).toBe(
      "Saved from Tributary as inactive version 5."
    );
    // Named, so the merge knows which of its states was saved.
    expect(saved.mock.calls[0][0].detail.saveKey).toBe(7);
    // By the name people know it by, not its API name.
    expect(element.shadowRoot.querySelector(".saved").textContent).toContain(
      "Saved version 5 of Demo flow (inactive)."
    );
    expect(saved.mock.calls[0][0].detail.label).toBe("Demo flow");
    expect(
      element.shadowRoot.querySelector("a.builder").getAttribute("href")
    ).toBe("/builder?flowId=301");
    const activation = element.shadowRoot.querySelector("c-flow-activation");
    expect(activation.versionNumber).toBe(5);
    expect(activation.activeVersion).toBe(4);
    // A request carries the receipt the org kept, and activating it later
    // refuses a version changed since it was saved.
    expect(activation.changeSummary).toBe(
      "Saved from Tributary as inactive version 5."
    );
    expect(activation.reviewedAt).toBe("2026-09-27T12:00:00.000Z");
    expect(activation.reviewChecks[0].messages).toEqual([
      "Loop_1 has no path out."
    ]);
    expect(saved.mock.calls[0][0].detail.checks[0]).toEqual(
      activation.reviewChecks[0]
    );
    const kept = element.shadowRoot.querySelector(
      ".saved-receipt c-flow-receipt-card"
    );
    expect(kept.saved).toBe(true);
    expect(kept.receipt.checks[2].summary).toBe(
      "Accepted as inactive version 5."
    );
    expect(getFlowStatus).toHaveBeenCalled();

    // Activating from here tells the page, so its lists catch up.
    const activated = jest.fn();
    element.addEventListener("activated", activated);
    activation.dispatchEvent(new CustomEvent("activated"));
    expect(activated.mock.calls[0][0].detail).toEqual({
      connection: "local",
      apiName: "Demo"
    });
    await flush();
    expect(
      element.shadowRoot.querySelector(".saved").textContent
    ).not.toContain("inactive");
  });

  it("keeps the submitted receipt when the parent's review changes during saving", async () => {
    const pending = deferred();
    saveVersion.mockReturnValue(pending.promise);
    const element = mount({
      review,
      targets: [{ connection: "local", apiName: "Demo", label: "Demo" }],
      open: true
    });
    await flush();
    const submitted = element.shadowRoot.querySelector(
      "c-flow-receipt-card"
    ).receipt;
    element.shadowRoot.querySelector("lightning-button.save").click();
    element.review = {
      sources: [],
      decisions: ["A different merge"],
      checks: { errors: 0, warnings: 0, messages: [] }
    };
    element.metadata = { label: "Different", processType: "Flow" };
    pending.resolve({ apiName: "Demo", versionNumber: 5, versionId: "301" });
    await flush();
    const receipt = element.shadowRoot.querySelector(
      ".saved-receipt c-flow-receipt-card"
    ).receipt;
    expect(receipt.candidate).toBe(submitted.candidate);
    expect(receipt.sources).toEqual(submitted.sources);
    expect(receipt.decisions).toEqual(submitted.decisions);
    expect(receipt.checks[0]).toEqual(submitted.checks[0]);
    expect(receipt.checks[2].summary).toBe("Accepted as inactive version 5.");
  });

  it("opens the saved version compared with what runs now", async () => {
    saveVersion.mockResolvedValue({
      apiName: "ns__Demo",
      versionNumber: 5,
      versionId: "301"
    });
    const element = mount({
      targets: [
        {
          connection: "local",
          apiName: "ns__Demo",
          label: "Demo",
          activeVersion: 2
        }
      ]
    });
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "ns__Flow_Compare" }
    });
    const close = jest.fn();
    element.addEventListener("close", close);
    element.open = true;
    await flush();
    element.shadowRoot.querySelector("lightning-button.save").click();
    await flush();
    const compare = element.shadowRoot.querySelector(".compare");
    expect(compare.textContent.trim()).toBe("Compare with version 2");
    compare.click();
    expect(navigate).toHaveBeenCalledWith(
      {
        type: "standard__navItemPage",
        attributes: { apiName: "ns__Flow_Compare" },
        state: { c__flow: "ns__Demo", c__vb: "5", c__va: "2" }
      },
      undefined
    );
    expect(close).toHaveBeenCalled();
  });

  it("saves nothing when what the merge was made from has changed", async () => {
    saveVersion.mockResolvedValue({
      candidate: "abc",
      stale: [
        "Version 3 was changed after it was compared, by Ada. Compare again to review what changed."
      ]
    });
    const element = mount({
      review,
      targets: [{ connection: "local", apiName: "Demo", label: "Demo" }]
    });
    const saved = jest.fn();
    const recompare = jest.fn();
    const close = jest.fn();
    element.addEventListener("saved", saved);
    element.addEventListener("recompare", recompare);
    element.addEventListener("close", close);
    element.open = true;
    await flush();
    element.shadowRoot.querySelector("lightning-button.save").click();
    await flush();
    expect(saved).not.toHaveBeenCalled();
    const alert = element.shadowRoot.querySelector(".stale");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("Nothing was saved.");
    expect(alert.textContent).toContain("by Ada");
    expect(
      element.shadowRoot.querySelector("lightning-button.save").disabled
    ).toBe(true);
    element.shadowRoot.querySelector("lightning-button.recompare").click();
    expect(recompare).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("says nothing was checked when there's no review", async () => {
    const element = mount({
      targets: [{ connection: "local", apiName: "Demo", label: "Demo" }]
    });
    element.open = true;
    await flush();
    const card = element.shadowRoot.querySelector("c-flow-receipt-card");
    expect(card.receipt.checks[0].summary).toBe("Not checked.");
  });

  it("creates a new flow with a valid API name", async () => {
    saveAsNewFlow.mockResolvedValue({
      apiName: "Demo_merged",
      versionNumber: 1
    });
    const element = mount({ targets: [] });
    element.open = true;
    await flush();
    const apiName = element.shadowRoot.querySelector(
      "lightning-input.api-name"
    );
    expect(apiName.value).toBe("Demo_merged");
    apiName.value = "1bad";
    apiName.dispatchEvent(new CustomEvent("change"));
    await flush();
    expect(
      element.shadowRoot.querySelector("lightning-button.save").disabled
    ).toBe(true);
    apiName.value = "Demo_Copy";
    apiName.dispatchEvent(new CustomEvent("change"));
    await flush();
    element.shadowRoot.querySelector("lightning-button.save").click();
    await flush();
    expect(saveAsNewFlow).toHaveBeenCalledWith(
      expect.objectContaining({ connection: "local", apiName: "Demo_Copy" })
    );
  });

  it("fingerprints the flow as it's saved, new label and all", async () => {
    saveAsNewFlow.mockResolvedValue({ apiName: "Demo_Copy", versionNumber: 1 });
    const element = mount({
      metadata: {
        fullName: "Demo",
        label: "Demo",
        processType: "Flow",
        status: "Active"
      },
      targets: [{ connection: "local", apiName: "Demo", label: "Demo" }]
    });
    element.open = true;
    await flush();
    const asVersion = element.shadowRoot.querySelector("c-flow-receipt-card")
      .receipt.candidate;
    // A new version keeps the merge's label; only the saved form changes.
    expect(asVersion).toBe(
      sha256(
        JSON.stringify({ label: "Demo", processType: "Flow", status: "Draft" })
      )
    );
    const kind = element.shadowRoot.querySelector("lightning-radio-group");
    kind.value = "flow";
    kind.dispatchEvent(
      new CustomEvent("change", { detail: { value: "flow" } })
    );
    await flush();
    const label = element.shadowRoot.querySelector(
      "lightning-input.flow-label"
    );
    label.value = "  Demo copy  ";
    label.dispatchEvent(new CustomEvent("change"));
    const apiName = element.shadowRoot.querySelector(
      "lightning-input.api-name"
    );
    apiName.value = "Demo_Copy";
    apiName.dispatchEvent(new CustomEvent("change"));
    await flush();
    const shown = element.shadowRoot.querySelector("c-flow-receipt-card")
      .receipt.candidate;
    element.shadowRoot.querySelector("lightning-button.save").click();
    await flush();
    const call = saveAsNewFlow.mock.calls[0][0];
    // What's hashed is what the org saves: the label inside it, a draft,
    // with no API name, so the org has nothing to change.
    expect(JSON.parse(call.metadataJson)).toEqual({
      label: "Demo copy",
      processType: "Flow",
      status: "Draft"
    });
    expect(call.label).toBe("Demo copy");
    const sent = JSON.parse(call.review);
    expect(sent.candidate).toBe(sha256(call.metadataJson));
    expect(shown).toBe(sent.candidate);
    expect(shown).not.toBe(asVersion);
    expect(sent.receipt).toContain(
      '- Label: "Demo copy", written when saving.'
    );
  });

  it.each(["Demo__Copy", "Demo_", "D".repeat(81)])(
    "rejects the invalid new-flow name %s before sending it",
    async (name) => {
      const element = mount({ targets: [], open: true });
      await flush();
      const apiName = element.shadowRoot.querySelector(
        "lightning-input.api-name"
      );
      apiName.value = name;
      apiName.dispatchEvent(new CustomEvent("change"));
      await flush();
      const save = element.shadowRoot.querySelector("lightning-button.save");
      expect(save.disabled).toBe(true);
      save.click();
      expect(saveAsNewFlow).not.toHaveBeenCalled();
    }
  );

  it.each([
    { targets: [] },
    { targets: [{ connection: "local", apiName: "Demo", label: "Demo" }] }
  ])("disables save when the destination disappears", async ({ targets }) => {
    const element = mount({ targets, open: true });
    await flush();
    element.connections = [];
    await flush();
    expect(
      element.shadowRoot.querySelector("lightning-button.save").disabled
    ).toBe(true);
    expect(
      element.shadowRoot.querySelector(".target-warning").textContent
    ).toContain("no longer available");
  });

  it("shows why saving failed", async () => {
    saveVersion.mockRejectedValue({ body: { message: "Field x is invalid" } });
    const element = mount({
      targets: [{ connection: "local", apiName: "Demo", label: "Demo" }]
    });
    element.open = true;
    await flush();
    element.shadowRoot.querySelector("lightning-button.save").click();
    await flush();
    expect(element.shadowRoot.querySelector(".error").textContent).toBe(
      "Field x is invalid"
    );
  });

  it("warns before saving a new flow to a production org", async () => {
    const element = mount({
      connections: [
        { name: "local", label: "This org", canSave: true },
        {
          name: "Prod",
          label: "Production",
          canSave: true,
          isProduction: true
        }
      ],
      targets: []
    });
    element.open = true;
    await flush();
    expect(element.shadowRoot.querySelector(".target-warning")).toBeNull();
    const org = element.shadowRoot.querySelector("lightning-combobox.field");
    org.dispatchEvent(new CustomEvent("change", { detail: { value: "Prod" } }));
    await flush();
    expect(
      element.shadowRoot.querySelector(".target-warning").textContent
    ).toContain("Production is a production org");
  });

  it("warns when the chosen flow's org can't be saved to", async () => {
    const element = mount({
      targets: [{ connection: "Prod", apiName: "Demo", label: "Demo" }]
    });
    element.open = true;
    await flush();
    expect(
      element.shadowRoot.querySelector(".target-warning").textContent
    ).toBe("You can't save flows to Production.");
    expect(
      element.shadowRoot.querySelector("lightning-button.save").disabled
    ).toBe(true);
  });

  it("keeps a save that finishes after the dialog reopened out of it", async () => {
    const pending = deferred();
    saveVersion.mockReturnValue(pending.promise);
    const saved = jest.fn();
    const element = mount({
      targets: [{ connection: "local", apiName: "Demo", label: "Demo" }]
    });
    element.addEventListener("saved", saved);
    element.open = true;
    await flush();
    element.shadowRoot.querySelector("lightning-button.save").click();
    await flush();
    element.open = false;
    await flush();
    element.open = true;
    await flush();
    // The earlier save is still running, so another can't start, and
    // closing doesn't claim to cancel it.
    const save = element.shadowRoot.querySelector("lightning-button.save");
    expect(save.disabled).toBe(true);
    expect(save.label).toBe("Saving…");
    expect(
      element.shadowRoot.querySelector("lightning-button.cancel").label
    ).toBe("Close");
    expect(
      element.shadowRoot.querySelector("lightning-radio-group").disabled
    ).toBe(true);
    expect(element.shadowRoot.querySelector(".saving").textContent).toContain(
      "Saving continues"
    );
    save.click();
    expect(saveVersion).toHaveBeenCalledTimes(1);

    pending.resolve({ apiName: "Demo", versionNumber: 6, versionId: "301" });
    await flush();
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved.mock.calls[0][0].detail.result.versionNumber).toBe(6);
    expect(element.shadowRoot.querySelector(".saved")).toBeNull();
    expect(
      element.shadowRoot.querySelector("lightning-button.save").disabled
    ).toBe(false);
  });

  it("reports a save that fails after the dialog closed as a toast", async () => {
    const pending = deferred();
    saveVersion.mockReturnValue(pending.promise);
    const toast = jest.fn();
    const element = mount({
      targets: [{ connection: "local", apiName: "Demo", label: "Demo" }]
    });
    element.addEventListener("lightning__showtoast", toast);
    element.open = true;
    await flush();
    element.shadowRoot.querySelector("lightning-button.save").click();
    await flush();
    element.open = false;
    await flush();
    pending.reject({ body: { message: "Field x is invalid" } });
    await flush();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].detail).toEqual(
      expect.objectContaining({
        title: "Save could not be confirmed",
        message: "Field x is invalid",
        variant: "error"
      })
    );
  });

  it("takes focus when it opens and keeps Tab inside", async () => {
    const focused = trackFocus();
    const element = mount({
      targets: [{ connection: "local", apiName: "Demo", label: "Demo" }]
    });
    element.open = true;
    await flush();
    // The first choice, not the dialog around it.
    expect(focused[0]).toBe(
      element.shadowRoot.querySelector("lightning-radio-group")
    );

    const [before, after] = element.shadowRoot.querySelectorAll(".focus-guard");
    after.dispatchEvent(new CustomEvent("focus"));
    expect(focused.pop()).toBe(element.shadowRoot.querySelector(".close"));
    before.dispatchEvent(new CustomEvent("focus"));
    expect(focused.pop()).toBe(
      element.shadowRoot.querySelector("lightning-button.save")
    );
  });

  it("closes on Escape", async () => {
    const close = jest.fn();
    const element = mount({ targets: [] });
    element.addEventListener("close", close);
    element.open = true;
    await flush();
    element.shadowRoot
      .querySelector("section")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
