/**
 * Tributary Setup: checks each part the app needs (the credential it
 * calls this org with, access to that credential, connected orgs, the
 * automatic governance checks) and fixes what it can with one click.
 *
 * Opened with c__section=monitor, it goes straight to the automatic checks.
 *
 * Admins can also be guided through the connection one step at a time,
 * including the external client app that has to be made elsewhere in Setup.
 */
import { waitForCheck } from "c/flowOperation";
import { governanceChange } from "c/flowGovernanceCache";
import { LightningElement, wire } from "lwc";
import { CurrentPageReference, NavigationMixin } from "lightning/navigation";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import getStatus from "@salesforce/apex/FlowCompareSetupController.getStatus";
import testConnection from "@salesforce/apexContinuation/FlowCompareSetupController.testConnection";
import connectionUser from "@salesforce/apex/FlowCompareSetupController.connectionUser";
import pointToThisOrg from "@salesforce/apex/FlowCompareSetupController.pointToThisOrg";
import saveClientCredentials from "@salesforce/apex/FlowCompareSetupController.saveClientCredentials";
import grantPrincipalAccess from "@salesforce/apex/FlowCompareSetupController.grantPrincipalAccess";
import startMonitor from "@salesforce/apex/FlowCompareSetupController.startMonitor";
import stopMonitor from "@salesforce/apex/FlowCompareSetupController.stopMonitor";
import runCheck from "@salesforce/apex/FlowGovernanceController.runCheck";
import {
  errorText,
  formatDateTime,
  plural,
  checkStatus,
  checkSummary,
  tabApiName
} from "c/flowUtils";

const INTERVALS = [5, 10, 15, 20, 30, 60];

const OK = "ok";
const PROBLEM = "problem";
const WARNING = "warning";
// Not known yet: waiting on a test, or on the steps before it.
const PENDING = "pending";

const ICONS = {
  [OK]: "utility:success",
  [PROBLEM]: "utility:error",
  [WARNING]: "utility:warning",
  [PENDING]: "utility:clock"
};

const ICON_VARIANTS = {
  [OK]: "success",
  [PROBLEM]: "error",
  [WARNING]: "warning"
};

export default class FlowCompareSetup extends NavigationMixin(
  LightningElement
) {
  status;
  _statusToken = 0;
  loading = false;
  error;
  // The step whose fix is running.
  working;
  clientId = "";
  clientSecret = "";
  showCredentialForm = false;
  credentialError;
  health = {};
  testing = {};
  // The latest test of each connection. Only its answer is shown, so an
  // earlier test that finishes later can't overwrite it.
  _tests = {};
  interval = "15";
  // The section the page was opened at, marked briefly once it's shown.
  arrived;
  _jumpTo;
  // Asking before the automatic checks stop.
  confirmingStop = false;
  checking = false;
  _focus;
  // The guided setup, and which of its steps is showing.
  guiding = false;
  guideIndex = 0;
  // A step to show in the list once the guide has closed.
  _revealStep;

  @wire(CurrentPageReference)
  handlePageRef(pageRef) {
    this.pageRef = pageRef;
    const section = pageRef && pageRef.state && pageRef.state.c__section;
    if (section) {
      this._jumpTo = section;
    }
  }

  connectedCallback() {
    this.load();
  }

  renderedCallback() {
    if (this._focus) {
      const target = this.template.querySelector(this._focus);
      this._focus = undefined;
      if (target) {
        target.focus();
      }
    }
    if (this._revealStep) {
      const key = this._revealStep;
      this._revealStep = undefined;
      this.reveal(`[data-step="${key}"]`, ".step-title");
    }
    if (!this._jumpTo || !this.ready) {
      return;
    }
    const name = this._jumpTo;
    this._jumpTo = undefined;
    this.reveal(`[data-section="${name}"]`, "h2");
    this.arrived = name;
  }

  // Scrolls to part of the page and moves focus to its heading.
  reveal(selector, headingSelector) {
    const section = this.template.querySelector(selector);
    if (!section) {
      return false;
    }
    const still =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (section.scrollIntoView) {
      section.scrollIntoView({
        behavior: still ? "auto" : "smooth",
        block: "start"
      });
    }
    const heading = section.querySelector(headingSelector);
    if (heading) {
      heading.focus({ preventScroll: true });
    }
    return true;
  }

  async load() {
    const token = ++this._statusToken;
    this.loading = true;
    this.error = undefined;
    try {
      const status = await getStatus();
      if (token !== this._statusToken) {
        return;
      }
      this.setStatus(status);
      if (this.canTestLocal) {
        this.test("local");
      }
    } catch (error) {
      if (token === this._statusToken) {
        this.error = errorText(error);
      }
    } finally {
      if (token === this._statusToken) {
        this.loading = false;
      }
    }
  }

  setStatus(status) {
    // A completed fix also supersedes any status read already on its way.
    this._statusToken++;
    this.loading = false;
    this.error = undefined;
    this.status = status;
    if (status.monitor && status.monitor.intervalMinutes) {
      this.interval = String(status.monitor.intervalMinutes);
    }
  }

  get ready() {
    return Boolean(this.status);
  }

  get isAdmin() {
    return Boolean(this.status && this.status.isAdmin);
  }

  get notAdmin() {
    return this.ready && !this.isAdmin;
  }

  // Checks

  get credentialConfigured() {
    return this.status.credentialStatus === "Configured";
  }

  get principalMissing() {
    return (this.status.permissionSets || []).filter(
      (permissionSet) => !permissionSet.hasPrincipalAccess
    );
  }

  // The connection can be tested once the credential is right.
  get canTestLocal() {
    return Boolean(
      this.status &&
      this.credentialConfigured &&
      this.status.urlMatches &&
      this.status.tokenUrlMatches &&
      this.status.calloutsEnabled !== false
    );
  }

  get testingLocal() {
    return Boolean(this.testing.local);
  }

  get testStep() {
    const local = this.health.local;
    if (this.testingLocal) {
      return { state: PENDING, detail: "Testing the connection…" };
    }
    if (!local) {
      return {
        state: PENDING,
        detail: this.canTestLocal
          ? "Not tested yet."
          : "Fix the steps above, then test the connection."
      };
    }
    if (!local.ok) {
      return { state: PROBLEM, detail: local.message };
    }
    return {
      state: local.auditAccess ? OK : WARNING,
      detail: `Signed in to ${local.orgName}${local.username ? ` as ${local.username}` : ""}.${local.message ? ` ${local.message}` : ""}`
    };
  }

  get steps() {
    const status = this.status;
    const steps = [
      {
        key: "url",
        title: "The credential points at this org",
        state: status.urlMatches ? OK : PROBLEM,
        detail: status.urlMatches
          ? `Calls go to ${status.calloutUrl}.`
          : status.credentialError
            ? `The Flow Tooling API credential couldn't be read: ${status.credentialError}`
            : `Calls go to ${status.calloutUrl || "nowhere yet"}, not ${status.orgDomainUrl}.`,
        fix:
          status.urlMatches || status.credentialError
            ? undefined
            : "Point it at this org",
        action: "point"
      },
      {
        key: "token",
        title: "The credential signs in at this org",
        state: status.credentialError
          ? PENDING
          : status.tokenUrlMatches
            ? OK
            : PROBLEM,
        detail: status.credentialError
          ? "Not known until the credential can be read."
          : status.tokenUrlMatches
            ? `The consumer key and secret only go to ${status.tokenUrl}.`
            : `It signs in at ${status.tokenUrl || "no token URL of its own"}, not ${status.orgDomainUrl}/services/oauth2/token, so the consumer key and secret can't be stored or sent.`,
        fix:
          status.tokenUrlMatches || status.credentialError
            ? undefined
            : "Point it at this org",
        action: "point"
      },
      {
        key: "credentials",
        title: "Client credentials are stored",
        state: this.credentialConfigured ? OK : PROBLEM,
        detail: this.credentialConfigured
          ? `The app signs in with the consumer key and secret of your external client app${status.tokenUrl ? ` at ${status.tokenUrl}` : ""}.`
          : "Enter the consumer key and secret of an external client app (or connected app) with the client credentials flow enabled.",
        fix: this.credentialConfigured ? "Replace" : "Enter credentials",
        fixVariant: this.credentialConfigured ? "neutral" : "brand",
        action: "credentials"
      },
      {
        key: "access",
        title: "Tributary users can use the credential",
        state: this.principalMissing.length ? PROBLEM : OK,
        detail: this.principalMissing.length
          ? `${this.principalMissing.map((permissionSet) => permissionSet.label).join(" and ")} can't use the Flow Tooling API credential yet.`
          : "Both Tributary permission sets can use the Flow Tooling API credential.",
        fix: this.principalMissing.length ? "Grant access" : undefined,
        action: "grant"
      },
      {
        // Salesforce's own safeguard: only an admin can turn callouts back on.
        key: "callouts",
        title: "Callouts are turned on",
        state:
          status.calloutsEnabled === false
            ? PROBLEM
            : status.credentialError
              ? PENDING
              : OK,
        detail:
          status.calloutsEnabled === false
            ? "Salesforce turns callouts off whenever an app changes where the credential points. Turn on Enabled for Callouts: Setup > Named Credentials > Flow Tooling API > Edit > Enabled for Callouts. Then check again here."
            : status.credentialError
              ? "Not known until the credential can be read."
              : "The Flow Tooling API credential is enabled for callouts.",
        fix:
          status.calloutsEnabled === false
            ? "Open Named Credentials"
            : undefined,
        action: "openCredentials"
      },
      {
        key: "test",
        title: "The app can reach this org",
        ...this.testStep,
        fix: this.testingLocal ? "Testing…" : "Test",
        fixVariant: "neutral",
        action: "testLocal"
      },
      {
        key: "notifications",
        title: "Owners can be notified",
        state: status.notificationType ? OK : WARNING,
        detail: status.notificationType
          ? "Requests, decisions and reverted activations send notifications."
          : "The Flow Governance Alert notification type is missing, so nobody is notified. Reinstall the package to restore it."
      }
    ];
    return steps.map((step) => ({
      ...step,
      icon: ICONS[step.state],
      iconVariant: ICON_VARIANTS[step.state],
      iconText:
        step.state === PENDING
          ? "Not checked yet"
          : step.state === OK
            ? "Passed"
            : "Needs attention",
      itemClass: `step step-${step.state}`,
      showFix:
        Boolean(step.fix) &&
        this.isAdmin &&
        (step.action !== "testLocal" || this.canTestLocal),
      fixVariant: step.fixVariant || "brand",
      busy:
        this.working === step.action ||
        (step.action === "testLocal" && this.testingLocal)
    }));
  }

  get problemCount() {
    return this.steps.filter((step) => step.state === PROBLEM).length;
  }

  // Governed flows go unwatched while the automatic checks are stopped.
  get checksNeedStarting() {
    return Boolean(
      this.status && this.status.governedCount && !this.monitor.scheduled
    );
  }

  // Each warning by name, to go straight to it from the summary.
  get warnings() {
    const warnings = this.steps
      .filter((step) => step.state === WARNING)
      .map((step) => ({ key: step.key, text: step.title }));
    if (this.checksNeedStarting) {
      const count = this.status.governedCount;
      warnings.push({
        key: "monitor",
        text: `Automatic checks are stopped: ${plural(count, "governed flow")} ${count === 1 ? "isn't" : "aren't"} enforced`
      });
    }
    return warnings;
  }

  get warningCount() {
    return this.warnings.length;
  }

  get showWarnings() {
    return this.summaryState === WARNING;
  }

  handleWarning(event) {
    const { key } = event.currentTarget.dataset;
    if (key === "monitor") {
      this.reveal('[data-section="monitor"]', "h2");
      this.arrived = "monitor";
      return;
    }
    if (this.guiding) {
      const index = this.guideSteps.findIndex((step) => step.key === key);
      if (index !== -1) {
        this.goTo(index);
        return;
      }
      // Not part of the guide: back to the list, where it is.
      this.guiding = false;
      this._revealStep = key;
      return;
    }
    this.reveal(`[data-step="${key}"]`, ".step-title");
  }

  // Nothing is called set up until the connection has been tried.
  get summaryState() {
    if (!this.ready) {
      return undefined;
    }
    if (this.problemCount) {
      return PROBLEM;
    }
    if (this.testingLocal || !this.health.local) {
      return PENDING;
    }
    return this.warningCount ? WARNING : OK;
  }

  get summaryText() {
    switch (this.summaryState) {
      case PROBLEM:
        return `${plural(this.problemCount, "thing needs", "things need")} fixing before Tributary can read and change flows.`;
      case PENDING:
        return this.testingLocal
          ? "Verifying the connection to this org…"
          : "Verification pending: test the connection to this org.";
      case WARNING:
        return `Tributary works. ${this.warningCount === 1 ? "One thing needs" : `${this.warningCount} things need`} a look:`;
      case OK:
        return "Tributary is set up.";
      default:
        return "";
    }
  }

  get summaryClass() {
    return `summary summary-${this.summaryState || "pending"}`;
  }

  get checksNote() {
    return this.problemCount
      ? "Checks run as whoever starts them, through the connection above, so fix those steps first."
      : "Checks run as whoever starts them, through the connection above.";
  }

  /** Once it works, the way on is to use it. */
  get canOpenCompare() {
    return this.summaryState === OK || this.summaryState === WARNING;
  }

  handleOpenCompare() {
    this[NavigationMixin.Navigate]({
      type: "standard__navItemPage",
      attributes: { apiName: tabApiName(this.pageRef, "Flow_Compare") }
    });
  }

  handleFix(event) {
    const { action } = event.currentTarget.dataset;
    if (action === "point") {
      this.run(action, pointToThisOrg, (status) =>
        status.calloutsEnabled === false
          ? "The credential now points at this org. Salesforce turned its callouts off: turn on Enabled for Callouts next."
          : "The credential now points at this org."
      );
    } else if (action === "openCredentials") {
      this[NavigationMixin.Navigate]({
        type: "standard__webPage",
        attributes: { url: "/lightning/setup/NamedCredential/home" }
      });
    } else if (action === "grant") {
      this.run(
        action,
        grantPrincipalAccess,
        "Tributary users can use the credential."
      );
    } else if (action === "credentials") {
      this.showCredentialForm = true;
      this.credentialError = undefined;
    } else if (action === "testLocal") {
      this.test("local");
    }
  }

  async run(action, method, success, params) {
    this.working = action;
    try {
      const status = await method(params);
      this.setStatus(status);
      this.toast(
        "Done",
        typeof success === "function" ? success(status) : success,
        "success"
      );
      // The fix button goes once its step is done, so focus moves on.
      if (this.guiding && this.guideStep.done) {
        this._focus = ".guide-next";
      }
      return true;
    } catch (error) {
      this.toast("That didn't work", errorText(error), "error");
      return false;
    } finally {
      this.working = undefined;
    }
  }

  toast(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }

  // Guided setup: the same checks as the list, in the order they're done,
  // with the part outside this page spelled out.

  get canGuide() {
    return this.isAdmin && !this.guiding;
  }

  get guideSteps() {
    const checks = {};
    for (const step of this.steps) {
      checks[step.key] = step;
    }
    const steps = [
      {
        key: "app",
        label: "Client app",
        title: "Create an external client app",
        isApp: true,
        // Nothing here can see the app; a stored key and secret means one exists.
        done: this.credentialConfigured
      },
      {
        key: "url",
        label: "Credential",
        title: "Point the credential at this org",
        // Where it calls, then where it signs in: one fix sets both.
        check: checks.url.state === OK ? checks.token : checks.url,
        help: "The package ships the credential pointing at a placeholder, so this is the first fix after every install."
      },
      {
        key: "credentials",
        label: "Key and secret",
        title: "Store the consumer key and secret",
        check: checks.credentials
      },
      {
        key: "access",
        label: "Access",
        title: "Let Tributary users use the credential",
        check: checks.access,
        help: "Gives both Tributary permission sets access to the credential's AppIdentity principal."
      },
      {
        key: "callouts",
        label: "Callouts",
        title: "Turn on Enabled for Callouts",
        check: checks.callouts,
        help: "Tributary can't turn callouts on itself: Salesforce leaves that to an admin, in Setup."
      },
      {
        key: "test",
        label: "Test",
        title: "Test the connection",
        check: checks.test,
        help: "Signs in as the external client app's Run As user, reads a flow definition and reads the Setup Audit Trail."
      },
      {
        key: "monitor",
        label: "Checks",
        title: "Start automatic checks",
        isMonitor: true,
        optional: true,
        done: Boolean(this.monitor.scheduled)
      }
    ];
    return steps.map((step, index) => {
      const done = step.check
        ? step.check.state === OK || step.check.state === WARNING
        : step.done;
      const current = index === this.guideIndex;
      return {
        ...step,
        index,
        number: index + 1,
        done,
        ariaCurrent: current ? "step" : undefined,
        navClass: [
          "guide-nav-item",
          done ? "guide-nav-done" : "",
          current ? "guide-nav-current" : ""
        ]
          .filter(Boolean)
          .join(" "),
        stateClass: `guide-state guide-state-${step.check ? step.check.state : PENDING}`,
        // The form stands in for its own button.
        showFix:
          Boolean(step.check && step.check.showFix) &&
          !(step.key === "credentials" && this.showCredentialForm),
        countText: `Step ${index + 1} of ${steps.length}${step.optional ? " (optional)" : ""}`
      };
    });
  }

  get guideStep() {
    return this.guideSteps[this.guideIndex];
  }

  // One item, keyed by step, so each step's body is drawn afresh.
  get guideCurrent() {
    return [this.guideStep];
  }

  get guideFirst() {
    return this.guideIndex === 0;
  }

  get guideLast() {
    return this.guideIndex === this.guideSteps.length - 1;
  }

  get guideNextLabel() {
    if (this.guideLast) {
      return "Finish";
    }
    const step = this.guideStep;
    return step.done || step.isApp ? "Next" : "Skip for now";
  }

  get guideMonitorText() {
    return this.monitor.scheduled
      ? this.monitorText
      : "Governance is only enforced while checks run: each one puts back the approved version of a governed flow activated outside Tributary. Start them now, or later under Automatic checks.";
  }

  handleGuideOpen() {
    const next = this.guideSteps.findIndex((step) => !step.done);
    this.guiding = true;
    this.goTo(next === -1 ? 0 : next);
  }

  goTo(index) {
    const step = this.guideSteps[index];
    if (this.showCredentialForm && step.key !== "credentials") {
      this.handleCredentialCancel();
    }
    this.guideIndex = index;
    this._focus = ".guide-title";
    if (step.key === "credentials" && !this.credentialConfigured) {
      this.showCredentialForm = true;
      this.credentialError = undefined;
    }
    if (
      step.key === "test" &&
      this.canTestLocal &&
      !this.health.local &&
      !this.testingLocal
    ) {
      this.test("local");
    }
  }

  handleGuideJump(event) {
    this.goTo(Number(event.currentTarget.dataset.index));
  }

  handleGuideBack() {
    this.goTo(this.guideIndex - 1);
  }

  handleGuideNext() {
    if (this.guideLast) {
      this.closeGuide(this.canOpenCompare ? ".open-compare" : ".guide-open");
    } else {
      this.goTo(this.guideIndex + 1);
    }
  }

  handleGuideClose() {
    this.closeGuide(".guide-open");
  }

  closeGuide(focus) {
    this.guiding = false;
    this._focus = focus;
  }

  // Client credentials

  handleClientId(event) {
    this.clientId = event.target.value;
  }

  handleClientSecret(event) {
    this.clientSecret = event.target.value;
  }

  get credentialSaveDisabled() {
    return (
      this.working === "credentials" ||
      !this.clientId.trim() ||
      !this.clientSecret.trim()
    );
  }

  handleCredentialCancel() {
    this.showCredentialForm = false;
    this.clientId = "";
    this.clientSecret = "";
  }

  async handleCredentialSave() {
    this.working = "credentials";
    this.credentialError = undefined;
    try {
      this.setStatus(
        await saveClientCredentials({
          clientId: this.clientId,
          clientSecret: this.clientSecret
        })
      );
      this.showCredentialForm = false;
      if (this.guiding) {
        this._focus = ".guide-next";
      }
      if (this.canTestLocal) {
        this.toast("Credentials saved", "Testing the connection…", "success");
        this.test("local");
      } else {
        this.toast(
          "Credentials saved",
          "Fix the remaining steps, then test the connection.",
          "success"
        );
      }
    } catch (error) {
      this.credentialError = errorText(error);
    } finally {
      // The secret never stays in the page.
      this.clientSecret = "";
      this.working = undefined;
    }
    if (!this.showCredentialForm) {
      this.clientId = "";
    }
  }

  // Connections

  async test(name) {
    const run = (this._tests[name] || 0) + 1;
    this._tests[name] = run;
    this.testing = { ...this.testing, [name]: true };
    let health;
    try {
      health = await testConnection({ connection: name });
    } catch (error) {
      health = { connection: name, ok: false, message: errorText(error) };
    }
    if (this._tests[name] !== run) {
      return;
    }
    this.health = { ...this.health, [name]: health };
    this.testing = { ...this.testing, [name]: false };
    // Who it signs in as is a nicety, asked for once the checks show.
    if (health && health.ok) {
      this.addUser(name, run);
    }
  }

  async addUser(name, run) {
    let username;
    try {
      username = await connectionUser({ connection: name });
    } catch (ignored) {
      // The checks already say whether the connection works.
      return;
    }
    if (username && this._tests[name] === run && this.health[name]) {
      this.health = {
        ...this.health,
        [name]: { ...this.health[name], username }
      };
    }
  }

  handleTest(event) {
    this.test(event.currentTarget.dataset.name);
  }

  handleTestAll() {
    for (const connection of this.status.connections || []) {
      this.test(connection.name);
    }
  }

  get connectionRows() {
    return (this.status.connections || []).map((connection) => {
      const health = this.health[connection.name];
      let state = "untested";
      let text = "Not tested";
      if (this.testing[connection.name]) {
        state = "testing";
        text = "Testing…";
      } else if (health && health.ok) {
        state = health.auditAccess ? OK : WARNING;
        text = `${health.orgName}${health.isSandbox ? " (sandbox)" : ""}${health.username ? `, as ${health.username}` : ""}`;
      } else if (health) {
        state = PROBLEM;
        text = "Can't connect";
      }
      const kind = connection.isLocal
        ? "This org"
        : connection.isProduction
          ? "Production"
          : "Other org";
      return {
        ...connection,
        kind,
        showKind: kind !== connection.label,
        state,
        stateText: text,
        stateClass: `connection-state state-${state}`,
        message: health && health.message,
        testing: Boolean(this.testing[connection.name])
      };
    });
  }

  // The packaged permission sets can't be changed in an installed package.
  get otherOrgAccessText() {
    const namespace = this.status.packageNamespace || "Tributary's namespace";
    return `Give each connection's principal to a permission set of your own, assigned alongside Tributary User or Tributary Admin, and list ${namespace} in its named credential's Allowed Namespaces.`;
  }

  get hasOtherOrgs() {
    return (this.status.connections || []).some(
      (connection) => !connection.isLocal
    );
  }

  // Permission sets

  get permissionSetRows() {
    return (this.status.permissionSets || []).map((permissionSet) => ({
      ...permissionSet,
      assignedText: plural(permissionSet.assigned, "user"),
      accessText: permissionSet.hasPrincipalAccess
        ? "Can use the credential"
        : "No credential access",
      accessClass: permissionSet.hasPrincipalAccess
        ? "access access-ok"
        : "access access-missing"
    }));
  }

  handleOpenPermissionSet(event) {
    this[NavigationMixin.Navigate]({
      type: "standard__webPage",
      attributes: {
        url: `/lightning/setup/PermSets/page?address=${encodeURIComponent(`/${event.currentTarget.dataset.id}?s=UserAssignments`)}`
      }
    });
  }

  // Automatic checks

  get monitor() {
    return (this.status && this.status.monitor) || {};
  }

  // Named as on the Governance tab and beside Activate.
  get checks() {
    return checkStatus(this.monitor);
  }

  get monitorText() {
    const { runningAs } = this.monitor;
    return `${this.checks.text}${this.monitor.scheduled && runningAs ? ` Checks run as ${runningAs}.` : ""}`;
  }

  // Said when the last check didn't end well; success is in the text above.
  get lastRunText() {
    const { lastRun, lastStatus, running } = this.monitor;
    if (!lastRun || running || !lastStatus || lastStatus === "Completed") {
      return "";
    }
    return `Last check ${formatDateTime(lastRun)}: ${lastStatus.toLowerCase()}.`;
  }

  get monitorClass() {
    const classes = ["card"];
    if (this.checksNeedStarting) {
      classes.push("card-warning");
    }
    if (this.arrived === "monitor") {
      classes.push("arrived");
    }
    return classes.join(" ");
  }

  get intervalOptions() {
    return INTERVALS.map((minutes) => ({
      value: String(minutes),
      label: minutes === 60 ? "Every hour" : `Every ${minutes} minutes`
    }));
  }

  get startLabel() {
    return this.monitor.scheduled ? "Change interval" : "Start checks";
  }

  get monitorBusy() {
    return this.working === "monitor" || this.checking;
  }

  get canRunCheck() {
    return Boolean(this.status.governedCount);
  }

  get countsText() {
    const status = this.status;
    return `${plural(status.governedCount || 0, "governed flow")}, ${plural(status.pendingCount || 0, "pending request")}.`;
  }

  handleInterval(event) {
    this.interval = event.detail.value;
  }

  handleStartMonitor() {
    const minutes = Number(this.interval);
    // Governance pages say whether checks run, so they read it again.
    this.run(
      "monitor",
      (params) => governanceChange(() => startMonitor(params)),
      `Governed flows are checked every ${plural(minutes, "minute")}.`,
      { intervalMinutes: minutes }
    );
  }

  // Stopping leaves governed flows unenforced, so it's confirmed first.
  handleStopMonitor() {
    this.confirmingStop = true;
    this._focus = ".stop-cancel";
  }

  handleStopCancel() {
    this.confirmingStop = false;
    this._focus = ".stop-monitor";
  }

  async handleStopConfirm() {
    const stopped = await this.run(
      "monitor",
      () => governanceChange(stopMonitor),
      "Automatic checks are stopped."
    );
    this.confirmingStop = false;
    this._focus = stopped ? ".start-monitor" : ".stop-monitor";
  }

  // The same check the schedule runs, now.
  async handleRunCheck() {
    this.checking = true;
    try {
      const check = await governanceChange(async () =>
        waitForCheck(await runCheck(), () => !this.isConnected)
      );
      const { message, variant } = checkSummary(check.results, check);
      this.toast("Check finished", message, variant);
      this.setStatus(await getStatus());
    } catch (error) {
      this.toast("Check outcome unavailable", errorText(error), "error");
    } finally {
      this.checking = false;
    }
  }

  handleRefresh() {
    this.load();
  }
}
