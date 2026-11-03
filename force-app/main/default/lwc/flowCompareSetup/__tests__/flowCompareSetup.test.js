import { createElement } from "lwc";
import FlowCompareSetup from "c/flowCompareSetup";
import { CurrentPageReference, navigate } from "lightning/navigation";
import getStatus from "@salesforce/apex/FlowCompareSetupController.getStatus";
import testConnection from "@salesforce/apexContinuation/FlowCompareSetupController.testConnection";
import connectionUser from "@salesforce/apex/FlowCompareSetupController.connectionUser";
import pointToThisOrg from "@salesforce/apex/FlowCompareSetupController.pointToThisOrg";
import saveClientCredentials from "@salesforce/apex/FlowCompareSetupController.saveClientCredentials";
import grantPrincipalAccess from "@salesforce/apex/FlowCompareSetupController.grantPrincipalAccess";
import startMonitor from "@salesforce/apex/FlowCompareSetupController.startMonitor";
import stopMonitor from "@salesforce/apex/FlowCompareSetupController.stopMonitor";
import runCheck from "@salesforce/apex/FlowGovernanceController.runCheck";

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
  "@salesforce/apex/FlowCompareSetupController.getStatus",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apexContinuation/FlowCompareSetupController.testConnection",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareSetupController.connectionUser",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareSetupController.pointToThisOrg",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareSetupController.saveClientCredentials",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareSetupController.grantPrincipalAccess",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareSetupController.startMonitor",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowCompareSetupController.stopMonitor",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/FlowGovernanceController.runCheck",
  () => ({ default: jest.fn() }),
  { virtual: true }
);

const flush = async () => {
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const GOOD = {
  isAdmin: true,
  orgDomainUrl: "https://acme.my.salesforce.com",
  calloutUrl: "https://acme.my.salesforce.com",
  urlMatches: true,
  tokenUrl: "https://acme.my.salesforce.com/services/oauth2/token",
  tokenUrlMatches: true,
  calloutsEnabled: true,
  credentialStatus: "Configured",
  permissionSets: [
    {
      id: "0PS1",
      name: "Flow_Compare_User",
      label: "Tributary User",
      assigned: 3,
      hasPrincipalAccess: true
    },
    {
      id: "0PS2",
      name: "Flow_Compare_Admin",
      label: "Tributary Admin",
      assigned: 1,
      hasPrincipalAccess: true
    }
  ],
  notificationType: true,
  monitor: {
    scheduled: true,
    intervalMinutes: 15,
    nextRun: "2026-09-25T15:15:00.000Z",
    lastRun: "2026-09-25T15:00:00.000Z",
    lastStatus: "Completed",
    lastSuccess: "2026-09-25T15:00:00.000Z",
    runningAs: "Jo Admin"
  },
  connections: [
    { name: "local", label: "This org", isLocal: true, isProduction: false },
    {
      name: "Prod",
      label: "Acme Prod",
      description: "Live org",
      isLocal: false,
      isProduction: true
    }
  ],
  governedCount: 4,
  pendingCount: 1
};

const STOPPED = { ...GOOD, monitor: { scheduled: false } };

const BROKEN = {
  ...GOOD,
  calloutUrl: "https://other.my.salesforce.com",
  urlMatches: false,
  credentialStatus: "NotConfigured",
  permissionSets: [
    { ...GOOD.permissionSets[0], hasPrincipalAccess: false },
    GOOD.permissionSets[1]
  ]
};

const HEALTHY = {
  connection: "local",
  ok: true,
  orgId: "00D1",
  orgName: "Acme",
  isSandbox: false,
  flowAccess: true,
  auditAccess: true
};

let element;

async function mount(status) {
  getStatus.mockResolvedValue(status);
  element = createElement("c-flow-compare-setup", { is: FlowCompareSetup });
  document.body.appendChild(element);
  await flush();
  return element;
}

const $ = (selector) => element.shadowRoot.querySelector(selector);
const $$ = (selector) => [...element.shadowRoot.querySelectorAll(selector)];
const step = (key) => $(`li[data-step="${key}"]`);
const fixButton = (key) => step(key).querySelector("lightning-button.fix");

function toasts() {
  const seen = [];
  element.addEventListener("lightning__showtoast", (event) =>
    seen.push(event.detail)
  );
  return seen;
}

function type(selector, value) {
  const input = $(selector);
  input.value = value;
  input.dispatchEvent(new CustomEvent("change"));
}

beforeEach(() => {
  testConnection.mockResolvedValue(HEALTHY);
  connectionUser.mockResolvedValue("integration@acme.com");
});

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
  jest.clearAllMocks();
});

describe("c-flow-compare-setup", () => {
  it("shows every step as done when the setup is complete", async () => {
    await mount(GOOD);
    expect(testConnection).toHaveBeenCalledWith({ connection: "local" });
    expect($$("li.step").map((item) => item.dataset.step)).toEqual([
      "url",
      "token",
      "credentials",
      "access",
      "callouts",
      "test",
      "notifications"
    ]);
    expect($$("li.step-ok")).toHaveLength(7);
    expect($(".summary").textContent).toBe("Tributary is set up.");
    expect(step("test").querySelector(".step-detail").textContent).toBe(
      "Signed in to Acme as integration@acme.com."
    );
    expect(fixButton("url")).toBeNull();
    expect(fixButton("credentials").label).toBe("Replace");
  });

  it("doesn't call the setup done until the connection is verified", async () => {
    let answer;
    testConnection.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    await mount(GOOD);
    expect($(".summary").textContent).toBe(
      "Verifying the connection to this org…"
    );
    expect($(".summary").className).toContain("summary-pending");
    expect(step("test").className).toContain("step-pending");
    expect(step("test").querySelector(".step-detail").textContent).toBe(
      "Testing the connection…"
    );
    expect(fixButton("test").label).toBe("Testing…");
    expect(fixButton("test").disabled).toBe(true);
    expect($("lightning-button.open-compare")).toBeNull();

    answer(HEALTHY);
    await flush();
    expect($(".summary").textContent).toBe("Tributary is set up.");
    expect(fixButton("test").label).toBe("Test");
    expect($("lightning-button.open-compare")).not.toBeNull();
  });

  it("shows the checks without waiting for the user's name", async () => {
    let name;
    connectionUser.mockReturnValue(
      new Promise((resolve) => {
        name = resolve;
      })
    );
    await mount(GOOD);
    expect(connectionUser).toHaveBeenCalledWith({ connection: "local" });
    const detail = () => step("test").querySelector(".step-detail").textContent;
    expect($(".summary").textContent).toBe("Tributary is set up.");
    expect(detail()).toBe("Signed in to Acme.");
    name("integration@acme.com");
    await flush();
    expect(detail()).toBe("Signed in to Acme as integration@acme.com.");
  });

  it("leaves the user's name out when it can't be found", async () => {
    connectionUser.mockRejectedValue(new Error("No userinfo"));
    await mount(GOOD);
    expect(step("test").querySelector(".step-detail").textContent).toBe(
      "Signed in to Acme."
    );
  });

  it("doesn't ask who a failed connection signs in as", async () => {
    testConnection.mockResolvedValue({
      connection: "local",
      ok: false,
      message: "It can't read flows."
    });
    await mount(GOOD);
    expect(connectionUser).not.toHaveBeenCalled();
  });

  it("leads on to Tributary once it works", async () => {
    getStatus.mockResolvedValue(GOOD);
    element = createElement("c-flow-compare-setup", { is: FlowCompareSetup });
    document.body.appendChild(element);
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "cllc__Flow_Compare_Setup" }
    });
    await flush();
    $("lightning-button.open-compare").click();
    expect(navigate).toHaveBeenCalledWith(
      {
        type: "standard__navItemPage",
        attributes: { apiName: "cllc__Flow_Compare" }
      },
      undefined
    );
  });

  it("names each warning, including governed flows nobody checks", async () => {
    await mount({ ...STOPPED, notificationType: false });
    expect($(".summary").textContent).toBe(
      "Tributary works. 2 things need a look:"
    );
    expect($(".summary").className).toContain("summary-warning");
    expect($('[data-section="monitor"]').className).toContain("card-warning");
    const links = $$(".warning-link");
    expect(links.map((link) => link.textContent.trim())).toEqual([
      "Owners can be notified",
      "Automatic checks are stopped: 4 governed flows aren't enforced"
    ]);

    // Each one leads to its part of the page.
    const scrolled = jest.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    try {
      links[1].click();
      await flush();
      const section = $('[data-section="monitor"]');
      expect(scrolled.mock.contexts[0]).toBe(section);
      expect(element.shadowRoot.activeElement).toBe(
        section.querySelector("h2")
      );
      links[0].click();
      expect(element.shadowRoot.activeElement).toBe(
        step("notifications").querySelector(".step-title")
      );
    } finally {
      delete HTMLElement.prototype.scrollIntoView;
    }
  });

  it("lists problems and fixes them one at a time", async () => {
    await mount(BROKEN);
    expect(testConnection).not.toHaveBeenCalled();
    expect($(".summary").textContent).toBe(
      "3 things need fixing before Tributary can read and change flows."
    );
    expect(step("url").className).toContain("step-problem");
    // The test waits for the steps before it, and can't be run yet.
    expect(step("test").className).toContain("step-pending");
    expect(step("test").querySelector(".step-detail").textContent).toBe(
      "Fix the steps above, then test the connection."
    );
    expect(fixButton("test")).toBeNull();
    expect(step("access").querySelector(".step-detail").textContent).toContain(
      "Tributary User can't use"
    );
    const seen = toasts();

    pointToThisOrg.mockResolvedValue({
      ...BROKEN,
      urlMatches: true,
      calloutUrl: GOOD.calloutUrl
    });
    fixButton("url").click();
    await flush();
    expect(pointToThisOrg).toHaveBeenCalled();
    expect(step("url").className).toContain("step-ok");
    expect(seen[0]).toMatchObject({ title: "Done", variant: "success" });

    grantPrincipalAccess.mockRejectedValue({
      body: { message: "Insufficient access" }
    });
    fixButton("access").click();
    await flush();
    expect(seen[1]).toMatchObject({
      title: "That didn't work",
      message: "Insufficient access",
      variant: "error"
    });
    expect(step("access").className).toContain("step-problem");
  });

  it("reports a token URL elsewhere as its own problem", async () => {
    await mount({
      ...GOOD,
      tokenUrl: "https://login.salesforce.com/services/oauth2/token",
      tokenUrlMatches: false
    });
    // The secret would go there, so nothing is tested.
    expect(testConnection).not.toHaveBeenCalled();
    expect(step("url").className).toContain("step-ok");
    expect(step("token").className).toContain("step-problem");
    expect(step("token").querySelector(".step-detail").textContent).toBe(
      "It signs in at https://login.salesforce.com/services/oauth2/token, not https://acme.my.salesforce.com/services/oauth2/token, so the consumer key and secret can't be stored or sent."
    );
    expect($(".summary").textContent).toBe(
      "1 thing needs fixing before Tributary can read and change flows."
    );
    pointToThisOrg.mockResolvedValue(GOOD);
    fixButton("token").click();
    await flush();
    expect(pointToThisOrg).toHaveBeenCalled();
    expect(step("token").className).toContain("step-ok");
  });

  it("asks an admin to turn callouts back on, and doesn't test until then", async () => {
    await mount({ ...GOOD, calloutsEnabled: false });
    expect(testConnection).not.toHaveBeenCalled();
    expect(step("callouts").className).toContain("step-problem");
    expect(
      step("callouts").querySelector(".step-detail").textContent
    ).toContain(
      "Setup > Named Credentials > Flow Tooling API > Edit > Enabled for Callouts"
    );
    expect(fixButton("test")).toBeNull();
    fixButton("callouts").click();
    expect(navigate).toHaveBeenCalledWith(
      {
        type: "standard__webPage",
        attributes: { url: "/lightning/setup/NamedCredential/home" }
      },
      undefined
    );

    // Turned on in Setup, then checked again here.
    getStatus.mockResolvedValue(GOOD);
    $("lightning-button-icon").click();
    await flush();
    expect(step("callouts").className).toContain("step-ok");
    expect(testConnection).toHaveBeenCalledWith({ connection: "local" });
  });

  it("says callouts are off once the credential has been pointed here", async () => {
    await mount(BROKEN);
    const seen = toasts();
    pointToThisOrg.mockResolvedValue({
      ...BROKEN,
      urlMatches: true,
      calloutUrl: GOOD.calloutUrl,
      calloutsEnabled: false
    });
    fixButton("url").click();
    await flush();
    expect(seen[0].message).toBe(
      "The credential now points at this org. Salesforce turned its callouts off: turn on Enabled for Callouts next."
    );
    expect(step("callouts").className).toContain("step-problem");
  });

  it("shows only the latest test of a connection", async () => {
    const answers = [];
    testConnection.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          answers.push({ resolve, reject });
        })
    );
    await mount(GOOD);
    const detail = () => step("test").querySelector(".step-detail").textContent;
    // The first test is the one on load; then the credentials change.
    fixButton("test").click();
    await flush();
    expect(answers).toHaveLength(2);
    answers[1].resolve({
      connection: "local",
      ok: false,
      message: "invalid_client"
    });
    await flush();
    expect(detail()).toBe("invalid_client");
    // The older test, which worked, ends last and is set aside.
    answers[0].resolve(HEALTHY);
    await flush();
    expect(detail()).toBe("invalid_client");
    expect($(".summary").textContent).toContain("1 thing needs fixing");
    expect(connectionUser).not.toHaveBeenCalled();

    // An older failure can't overwrite a newer success, nor end its test early.
    fixButton("test").click();
    fixButton("test").click();
    await flush();
    expect(answers).toHaveLength(4);
    answers[2].reject({ body: { message: "Timed out" } });
    await flush();
    expect(detail()).toBe("Testing the connection…");
    answers[3].resolve(HEALTHY);
    await flush();
    answers[2].reject({ body: { message: "Timed out" } });
    await flush();
    expect(detail()).toBe("Signed in to Acme as integration@acme.com.");
    expect($(".summary").textContent).toBe("Tributary is set up.");
  });

  it("saves client credentials without keeping the secret", async () => {
    await mount(BROKEN);
    const seen = toasts();
    fixButton("credentials").click();
    await flush();
    const save = $("lightning-button.save-credentials");
    expect(save.disabled).toBe(true);
    type("lightning-input.client-id", "3MVG9key");
    type("lightning-input.client-secret", "s3cret");
    await flush();
    expect(save.disabled).toBe(false);
    expect($("lightning-input.client-secret").type).toBe("password");

    saveClientCredentials.mockResolvedValue({
      ...BROKEN,
      urlMatches: true,
      calloutUrl: GOOD.calloutUrl,
      credentialStatus: "Configured"
    });
    save.click();
    await flush();
    expect(saveClientCredentials).toHaveBeenCalledWith({
      clientId: "3MVG9key",
      clientSecret: "s3cret"
    });
    expect($(".credential-form")).toBeNull();
    expect(seen[0]).toMatchObject({ title: "Credentials saved" });
    expect(testConnection).toHaveBeenCalledWith({ connection: "local" });
    expect(step("credentials").className).toContain("step-ok");
    expect(element.shadowRoot.textContent).not.toContain("s3cret");
  });

  it("keeps the form open and clears the secret when saving fails", async () => {
    await mount(BROKEN);
    fixButton("credentials").click();
    await flush();
    type("lightning-input.client-id", "3MVG9key");
    type("lightning-input.client-secret", "wrong");
    saveClientCredentials.mockRejectedValue({
      body: { message: "Invalid client" }
    });
    $("lightning-button.save-credentials").click();
    await flush();
    expect($(".credential-form .error").textContent).toBe("Invalid client");
    expect($("lightning-input.client-id").value).toBe("3MVG9key");
    expect($("lightning-input.client-secret").value).toBe("");
    expect($("lightning-button.save-credentials").disabled).toBe(true);
  });

  it("tests each connection and shows failures", async () => {
    await mount(GOOD);
    testConnection.mockImplementation(({ connection }) => {
      if (connection === "Prod") {
        return Promise.resolve({
          connection,
          ok: false,
          message: "Unauthorized endpoint"
        });
      }
      return Promise.resolve(HEALTHY);
    });
    $("lightning-button.test-all").click();
    await flush();
    const rows = $$("li.connection");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".connection-state").className).toContain(
      "state-ok"
    );
    expect(rows[1].querySelector(".connection-state").textContent).toBe(
      "Can't connect"
    );
    expect(rows[1].querySelector(".connection-message").textContent).toBe(
      "Unauthorized endpoint"
    );
    expect(rows[1].textContent).toContain("Acme Prod");
    expect(rows[1].textContent).toContain("Production");
    expect(rows[0].textContent.match(/This org/g)).toHaveLength(1);
    expect(rows[1].textContent).toContain("Live org");
  });

  it("warns when the app can connect but can't read the audit trail", async () => {
    testConnection.mockResolvedValue({
      ...HEALTHY,
      auditAccess: false,
      message: "No audit trail access."
    });
    await mount(GOOD);
    expect(step("test").className).toContain("step-warning");
    expect(step("test").querySelector(".step-detail").textContent).toContain(
      "No audit trail access."
    );
    expect($(".summary").textContent).toBe(
      "Tributary works. One thing needs a look:"
    );
  });

  it("starts, reschedules and stops the automatic checks", async () => {
    await mount(STOPPED);
    const badge = () => $('[data-section="monitor"] .slds-badge');
    expect(badge().textContent).toBe("Stopped");
    expect($(".monitor-text").textContent).toBe(
      "Automatic checks stopped — outside activations are checked only when you run a check."
    );
    expect($("lightning-button.start-monitor").label).toBe("Start checks");
    expect($(".stop-monitor")).toBeNull();
    const combobox = $("lightning-combobox.interval");
    expect(combobox.value).toBe("15");
    combobox.dispatchEvent(
      new CustomEvent("change", { detail: { value: "30" } })
    );

    const running = {
      ...GOOD,
      monitor: {
        scheduled: true,
        intervalMinutes: 30,
        nextRun: "2026-09-25T15:30:00.000Z",
        lastRun: "2026-09-25T15:00:00.000Z",
        lastStatus: "Failed",
        lastError: "Unauthorized",
        lastSuccess: "2026-09-25T14:00:00.000Z",
        runningAs: "Jo Admin"
      }
    };
    startMonitor.mockResolvedValue(running);
    $("lightning-button.start-monitor").click();
    await flush();
    expect(startMonitor).toHaveBeenCalledWith({ intervalMinutes: 30 });
    expect(badge().textContent).toBe("Check failed");
    expect($(".monitor-text").textContent).toContain(
      "The last automatic check didn't finish."
    );
    expect($(".monitor-text").textContent).toContain("Checks run as Jo Admin.");
    expect($(".last-run").textContent).toContain(": failed.");
    expect($("lightning-button.start-monitor").label).toBe("Change interval");

    // Stopping is confirmed first, and can be backed out of.
    const focused = [];
    const focus = jest
      .spyOn(HTMLElement.prototype, "focus")
      .mockImplementation(function record() {
        focused.push(this);
      });
    try {
      stopMonitor.mockResolvedValue(STOPPED);
      $("lightning-button.stop-monitor").click();
      await flush();
      expect(stopMonitor).not.toHaveBeenCalled();
      expect(focused.pop()).toBe($(".stop-cancel"));
      $("lightning-button.stop-cancel").click();
      await flush();
      expect($(".stop-confirm")).toBeNull();
      expect(focused.pop()).toBe($(".stop-monitor"));

      $("lightning-button.stop-monitor").click();
      await flush();
      $("lightning-button.stop-confirm-button").click();
      await flush();
      expect(stopMonitor).toHaveBeenCalled();
      expect(badge().textContent).toBe("Stopped");
      expect($(".stop-confirm")).toBeNull();
      expect(focused.pop()).toBe($(".start-monitor"));
    } finally {
      focus.mockRestore();
    }
  });

  it.each(["success", "failure"])(
    "doesn't let an earlier status %s undo stopping the checks",
    async (outcome) => {
      await mount(GOOD);
      let resolve;
      let reject;
      getStatus.mockReturnValueOnce(
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        })
      );
      $("lightning-button-icon").click();
      await flush();
      stopMonitor.mockResolvedValue(STOPPED);
      $("lightning-button.stop-monitor").click();
      await flush();
      $("lightning-button.stop-confirm-button").click();
      await flush();
      expect($('[data-section="monitor"] .slds-badge').textContent).toBe(
        "Stopped"
      );
      if (outcome === "success") {
        resolve(GOOD);
      } else {
        reject(new Error("Old status read failed"));
      }
      await flush();
      expect($('[data-section="monitor"] .slds-badge').textContent).toBe(
        "Stopped"
      );
      expect($(".error")).toBeNull();
    }
  );

  it("keeps the latest setup refresh when an older one finishes last", async () => {
    await mount(GOOD);
    let resolve;
    getStatus.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    $("lightning-button-icon").click();
    getStatus.mockResolvedValueOnce(STOPPED);
    $("lightning-button-icon").click();
    await flush();
    expect($('[data-section="monitor"] .slds-badge').textContent).toBe(
      "Stopped"
    );
    resolve(GOOD);
    await flush();
    expect($('[data-section="monitor"] .slds-badge').textContent).toBe(
      "Stopped"
    );
  });

  it("runs a check now and says how it went", async () => {
    await mount(GOOD);
    const seen = toasts();
    runCheck.mockResolvedValue([
      { outcome: "ok" },
      { outcome: "reverted" },
      { outcome: "skipped" }
    ]);
    $("lightning-button.run-check").click();
    await flush();
    expect(runCheck).toHaveBeenCalled();
    expect(seen[0]).toMatchObject({
      title: "Check finished",
      message:
        "2 flows checked, 1 needing attention. 1 flow left for the next check.",
      variant: "warning"
    });
    // The status is read again for the latest check.
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("names a working schedule the way the other tabs do", async () => {
    await mount(GOOD);
    expect($('[data-section="monitor"] .slds-badge').textContent).toBe(
      "Scheduled"
    );
    expect($(".monitor-text").textContent).toContain(
      "Checked every 15 minutes."
    );
    expect($(".last-run")).toBeNull();
  });

  it("opens at the automatic checks when a link asks for them", async () => {
    const scrolled = jest.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    getStatus.mockResolvedValue(STOPPED);
    element = createElement("c-flow-compare-setup", { is: FlowCompareSetup });
    document.body.appendChild(element);
    CurrentPageReference.emit({
      type: "standard__navItemPage",
      attributes: { apiName: "cllc__Flow_Compare_Setup" },
      state: { c__section: "monitor" }
    });
    await flush();
    const section = $('[data-section="monitor"]');
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(section);
    expect(section.className).toContain("arrived");
    expect(element.shadowRoot.activeElement).toBe(section.querySelector("h2"));
    delete HTMLElement.prototype.scrollIntoView;
  });

  it("opens a permission set's assignments", async () => {
    await mount(GOOD);
    const rows = $$("li.permission-set");
    expect(rows[0].textContent).toContain("3 users");
    expect(rows[0].textContent).toContain("Can use the credential");
    rows[0].querySelector("lightning-button").click();
    expect(navigate).toHaveBeenCalledWith(
      {
        type: "standard__webPage",
        attributes: {
          url: "/lightning/setup/PermSets/page?address=%2F0PS1%3Fs%3DUserAssignments"
        }
      },
      undefined
    );
  });

  it("shows the checks but no fixes to non-admins", async () => {
    await mount({ ...BROKEN, isAdmin: false });
    expect($(".notice")).not.toBeNull();
    expect($$("lightning-button.fix")).toHaveLength(0);
    expect($(".monitor-actions")).toBeNull();
    expect($(".guide-open")).toBeNull();
  });

  it("shows an error when the status can't be read", async () => {
    getStatus.mockRejectedValue({ body: { message: "No access" } });
    element = createElement("c-flow-compare-setup", { is: FlowCompareSetup });
    document.body.appendChild(element);
    await flush();
    expect($(".error").textContent).toBe("No access");
    expect($("li.step")).toBeNull();
  });
  describe("guided setup", () => {
    let focused;
    let focus;
    const guideTitle = () => $(".guide-title").textContent;
    const next = () => $("lightning-button.guide-next");
    const navItems = () => $$(".guide-nav-item");

    beforeEach(() => {
      focused = [];
      focus = jest
        .spyOn(HTMLElement.prototype, "focus")
        .mockImplementation(function record() {
          focused.push(this);
        });
    });

    afterEach(() => {
      focus.mockRestore();
    });

    it("walks an admin through the connection from nothing", async () => {
      await mount({ ...BROKEN, monitor: { scheduled: false } });
      $("lightning-button.guide-open").click();
      await flush();
      // The guide stands in for the list, starting at the first undone step.
      expect($("ol.steps")).toBeNull();
      expect($(".guide-open")).toBeNull();
      expect(navItems()).toHaveLength(7);
      expect(guideTitle()).toBe("Create an external client app");
      expect($(".guide-count").textContent).toBe("Step 1 of 7");
      expect(focused.pop()).toBe($(".guide-title"));
      const link = $("a.app-manager");
      expect(link.getAttribute("href")).toBe(
        "/lightning/setup/NavigationMenus/home"
      );
      expect(link.target).toBe("_blank");
      expect($(".guide-nav-current button").getAttribute("aria-current")).toBe(
        "step"
      );
      expect($("lightning-button.guide-back").disabled).toBe(true);
      expect(next().label).toBe("Next");

      next().click();
      await flush();
      expect(guideTitle()).toBe("Point the credential at this org");
      expect($(".guide-state").className).toContain("guide-state-problem");
      expect(next().label).toBe("Skip for now");
      // As Salesforce leaves it: pointed here, with callouts off.
      pointToThisOrg.mockResolvedValue({
        ...BROKEN,
        urlMatches: true,
        calloutUrl: GOOD.calloutUrl,
        calloutsEnabled: false
      });
      const fix = $("lightning-button.guide-fix");
      expect(fix.label).toBe("Point it at this org");
      fix.click();
      await flush();
      expect(pointToThisOrg).toHaveBeenCalled();
      expect($(".guide-state").className).toContain("guide-state-ok");
      expect(navItems()[1].className).toContain("guide-nav-done");
      expect(next().label).toBe("Next");
      // The fix button is gone, so focus moves on.
      expect(focused.pop()).toBe(next());

      // The form opens by itself for the key and secret.
      next().click();
      await flush();
      expect(guideTitle()).toBe("Store the consumer key and secret");
      expect($(".credential-form")).not.toBeNull();
      expect($("lightning-button.guide-fix")).toBeNull();
      type("lightning-input.client-id", "3MVG9key");
      type("lightning-input.client-secret", "s3cret");
      saveClientCredentials.mockResolvedValue({
        ...BROKEN,
        urlMatches: true,
        calloutUrl: GOOD.calloutUrl,
        calloutsEnabled: false,
        credentialStatus: "Configured",
        monitor: { scheduled: false }
      });
      $("lightning-button.save-credentials").click();
      await flush();
      expect($(".credential-form")).toBeNull();
      expect(focused.pop()).toBe(next());
      // Not with callouts off.
      expect(testConnection).not.toHaveBeenCalled();
      expect(navItems()[0].className).toContain("guide-nav-done");

      next().click();
      await flush();
      expect(guideTitle()).toBe("Let Tributary users use the credential");
      grantPrincipalAccess.mockResolvedValue({
        ...GOOD,
        calloutsEnabled: false,
        monitor: { scheduled: false }
      });
      $("lightning-button.guide-fix").click();
      await flush();
      expect(navItems()[3].className).toContain("guide-nav-done");

      // Only an admin can turn callouts back on, in Setup.
      next().click();
      await flush();
      expect(guideTitle()).toBe("Turn on Enabled for Callouts");
      expect($(".guide-state").className).toContain("guide-state-problem");
      expect($(".guide-detail").textContent).toContain(
        "Setup > Named Credentials > Flow Tooling API > Edit > Enabled for Callouts"
      );
      $("lightning-button.guide-fix").click();
      expect(navigate).toHaveBeenCalledWith(
        {
          type: "standard__webPage",
          attributes: { url: "/lightning/setup/NamedCredential/home" }
        },
        undefined
      );
      getStatus.mockResolvedValue({ ...GOOD, monitor: { scheduled: false } });
      $("lightning-button-icon").click();
      await flush();
      expect(navItems()[4].className).toContain("guide-nav-done");
      expect(testConnection).toHaveBeenCalledTimes(1);

      // Already tested once callouts were on.
      next().click();
      await flush();
      expect(guideTitle()).toBe("Test the connection");
      expect(testConnection).toHaveBeenCalledTimes(1);
      expect($(".guide-detail").textContent).toBe(
        "Signed in to Acme as integration@acme.com."
      );

      next().click();
      await flush();
      expect(guideTitle()).toBe("Start automatic checks");
      expect($(".guide-count").textContent).toBe("Step 7 of 7 (optional)");
      expect(next().label).toBe("Finish");
      startMonitor.mockResolvedValue(GOOD);
      $("lightning-button.guide-start").click();
      await flush();
      expect(startMonitor).toHaveBeenCalledWith({ intervalMinutes: 15 });
      expect(navItems()[6].className).toContain("guide-nav-done");
      expect(focused.pop()).toBe(next());

      // Finished, the way on is Tributary itself.
      next().click();
      await flush();
      expect($(".guide-body")).toBeNull();
      expect($$("li.step-ok")).toHaveLength(7);
      expect(focused.pop()).toBe($(".open-compare"));
    });

    it("tests the connection on reaching it and drops an unsaved form", async () => {
      await mount({
        ...GOOD,
        urlMatches: false,
        calloutUrl: "https://other.my.salesforce.com"
      });
      expect(testConnection).not.toHaveBeenCalled();
      $("lightning-button.guide-open").click();
      await flush();
      expect(guideTitle()).toBe("Point the credential at this org");

      // Replacing credentials is offered, not forced.
      navItems()[2].querySelector("button").click();
      await flush();
      expect($(".credential-form")).toBeNull();
      $("lightning-button.guide-fix").click();
      await flush();
      type("lightning-input.client-id", "3MVG9key");
      $("lightning-button.guide-back").click();
      await flush();
      expect($(".credential-form")).toBeNull();
      expect(guideTitle()).toBe("Point the credential at this org");

      pointToThisOrg.mockResolvedValue(GOOD);
      $("lightning-button.guide-fix").click();
      await flush();
      navItems()[5].querySelector("button").click();
      await flush();
      expect(testConnection).toHaveBeenCalledWith({ connection: "local" });
      expect($(".guide-state").className).toContain("guide-state-ok");
    });

    it("closes back to the list, including to show a warning", async () => {
      await mount({ ...GOOD, notificationType: false });
      $("lightning-button.guide-open").click();
      await flush();
      // Everything done: the guide starts at the beginning.
      expect(guideTitle()).toBe("Create an external client app");
      expect($$(".guide-nav-done")).toHaveLength(7);
      $("lightning-button.guide-close").click();
      await flush();
      expect($("ol.steps")).not.toBeNull();
      expect(focused.pop()).toBe($(".guide-open"));

      $("lightning-button.guide-open").click();
      await flush();
      // Notifications aren't part of the guide, so the list shows it.
      $(".warning-link").click();
      await flush();
      expect($(".guide-body")).toBeNull();
      expect(focused.pop()).toBe(step("notifications").querySelector("h3"));
    });
  });
});
