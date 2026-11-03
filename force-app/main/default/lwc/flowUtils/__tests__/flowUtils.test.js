import { checkStatus, checkSummary } from "c/flowUtils";

const SCHEDULED = {
  scheduled: true,
  intervalMinutes: 15,
  nextRun: "2026-09-29T12:15:00.000Z",
  lastRun: "2026-09-29T12:00:05.000Z"
};

describe("checkStatus", () => {
  it("calls a clean check scheduled, with when it last succeeded", () => {
    const checks = checkStatus({
      ...SCHEDULED,
      lastStatus: "Completed",
      lastSuccess: "2026-09-29T12:00:05.000Z",
      lastChecked: 4,
      lastFailed: 0
    });
    expect(checks.state).toBe("Scheduled");
    expect(checks.badgeClass).toContain("slds-theme_success");
    expect(checks.text).toContain("Last successful check");
  });

  it("doesn't show a check that couldn't reach its flows as a success", () => {
    const checks = checkStatus({
      ...SCHEDULED,
      lastStatus: "Completed with errors",
      lastSuccess: "2026-09-28T09:00:00.000Z",
      lastChecked: 3,
      lastFailed: 3
    });
    expect(checks.state).toBe("Checked with errors");
    expect(checks.badgeClass).not.toContain("slds-theme_success");
    expect(checks.text).toContain("couldn't check or revert 3 flows");
    // The last success is the one before, still shown for what it is.
    expect(checks.text).toContain("Last successful check");
  });

  it("says some flows when an older status has no count", () => {
    const checks = checkStatus({
      ...SCHEDULED,
      lastStatus: "Completed with errors"
    });
    expect(checks.text).toContain("couldn't check or revert some flows");
  });

  it("says how many flows were left for the next check", () => {
    expect(
      checkStatus({ ...SCHEDULED, lastStatus: "Completed", lastRemaining: 2 })
        .text
    ).toContain("2 flows were left for the next check.");
    expect(
      checkStatus({ ...SCHEDULED, lastStatus: "Completed", lastRemaining: 0 })
        .text
    ).not.toContain("left for");
  });

  it("still reports a check that didn't finish, and one running", () => {
    expect(checkStatus({ ...SCHEDULED, lastStatus: "Failed" }).state).toBe(
      "Check failed"
    );
    expect(
      checkStatus({ ...SCHEDULED, lastStatus: "Queued", running: true }).state
    ).toBe("Checking");
    expect(checkStatus({ scheduled: false }).state).toBe("Stopped");
    expect(checkStatus(undefined)).toBeUndefined();
  });
});

describe("checkSummary", () => {
  it("counts from the results when that's all there is", () => {
    expect(
      checkSummary([{ outcome: "ok" }, { outcome: "skipped" }]).message
    ).toBe("1 flow checked, all as approved. 1 flow left for the next check.");
  });

  it("uses a check's exact counts when its results leave flows out", () => {
    // A big healthy check keeps no results; a held flow is left for later.
    expect(
      checkSummary([], {
        attempted: 200,
        succeeded: 200,
        failed: 0,
        remaining: 1
      })
    ).toEqual({
      message:
        "200 flows checked, all as approved. 1 flow left for the next check.",
      variant: "success"
    });
    expect(
      checkSummary([{ outcome: "reverted" }], {
        attempted: 60,
        succeeded: 57,
        failed: 2,
        remaining: 0
      })
    ).toEqual({
      message: "59 flows checked, 2 needing attention.",
      variant: "warning"
    });
  });
});

describe("tabApiName", () => {
  const SCHEMA = "@salesforce/schema/Flow_Governance__c";
  // flowUtils as loaded with the package object named as given, or as in
  // an org without a namespace when it's left out.
  const load = (objectApiName) => {
    let utils;
    jest.isolateModules(() => {
      if (objectApiName) {
        jest.doMock(SCHEMA, () => ({ default: { objectApiName } }), {
          virtual: true
        });
      } else {
        jest.dontMock(SCHEMA);
      }
      utils = require("c/flowUtils");
    });
    return utils;
  };
  const page = (apiName) => ({
    type: "standard__navItemPage",
    attributes: { apiName }
  });

  it("names the package's tabs from a subscriber's own App Page", () => {
    const { tabApiName, compareRef, monitorRef } = load(
      "trib__Flow_Governance__c"
    );
    const host = page("Sales_Tools");
    expect(tabApiName(host, "Flow_Compare")).toBe("trib__Flow_Compare");
    expect(compareRef(host, { apiName: "Route" }).attributes.apiName).toBe(
      "trib__Flow_Compare"
    );
    expect(monitorRef(host).attributes.apiName).toBe(
      "trib__Flow_Compare_Setup"
    );
  });

  it("ignores another namespace on the page", () => {
    expect(
      load("trib__Flow_Governance__c").tabApiName(
        page("acme__Sales_Home"),
        "Flow_Compare"
      )
    ).toBe("trib__Flow_Compare");
    // Unpackaged, where the object has no namespace, neither does the tab.
    expect(load().tabApiName(page("acme__Sales_Home"), "Flow_Compare")).toBe(
      "Flow_Compare"
    );
  });

  it("works unpackaged", () => {
    const { tabApiName } = load();
    expect(tabApiName(page("Flow_Compare"), "Flow_Compare_Setup")).toBe(
      "Flow_Compare_Setup"
    );
    expect(tabApiName(undefined, "Flow_Compare")).toBe("Flow_Compare");
    // One of the package's own tabs names its namespace.
    expect(tabApiName(page("cllc__Governed_Flows"), "Flow_Compare")).toBe(
      "cllc__Flow_Compare"
    );
  });
});
