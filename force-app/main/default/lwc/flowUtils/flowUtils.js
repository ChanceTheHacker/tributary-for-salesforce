/**
 * Small helpers shared by the Tributary pages.
 */

import GOVERNANCE from "@salesforce/schema/Flow_Governance__c";

/** Makes invisible direction/format controls explicit in review text, never stored values. */
export function visibleText(value) {
  if (typeof value !== "string") return value;
  return value.replace(
    /[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g,
    (character) =>
      `⟦U+${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟧`
  );
}

/** A readable message from an Apex, LDS or JavaScript error. */
export function errorText(error) {
  return visibleText(errorMessage(error));
}

function errorMessage(error) {
  if (!error) {
    return "Something went wrong.";
  }
  if (typeof error === "string") {
    return error;
  }
  const body = error.body;
  if (Array.isArray(body)) {
    return body.map((item) => item.message).join(" ");
  }
  if (body) {
    if (body.message) {
      return body.message;
    }
    if (body.pageErrors && body.pageErrors.length) {
      return body.pageErrors.map((item) => item.message).join(" ");
    }
  }
  return error.message || "Something went wrong.";
}

/**
 * Sets --fc-fill-height on an element to the room between its top and the
 * bottom of the window, at least min pixels, so a canvas can end at the
 * window's edge instead of below it.
 */
export function fillWindow(element, min = 416, margin = 16) {
  // A hidden element keeps what it had.
  if (!element || !element.getClientRects().length) {
    return;
  }
  const top = element.getBoundingClientRect().top + (window.scrollY || 0);
  const value = `${Math.max(min, Math.round(window.innerHeight - top - margin))}px`;
  if (element.style.getPropertyValue("--fc-fill-height") !== value) {
    element.style.setProperty("--fc-fill-height", value);
  }
}

/**
 * A metadata name as words: "assignmentItems" → "Assignment items". Names
 * people chose (capitalised, or with underscores) are left alone.
 */
export function humanize(name) {
  const text = visibleText(String(name));
  if (!/^[a-z][A-Za-z0-9]*$/.test(text)) {
    return text;
  }
  const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// What one item of a list is called, for "Condition 2" or
// "Outcome Large Order" in a path.
const LIST_ITEMS = {
  assignmentItems: "Assignment",
  conditions: "Condition",
  filters: "Filter",
  inputAssignments: "Field",
  inputParameters: "Input",
  outputAssignments: "Output",
  outputParameters: "Output",
  rules: "Outcome",
  scheduledPaths: "Scheduled path",
  waitEvents: "Event",
  fields: "Screen field",
  choiceReferences: "Choice",
  sortOptions: "Sort",
  mapItems: "Mapping"
};

/**
 * A change path as words, a list's item joined to its list:
 * ["rules", "Match", "conditions", 0, "operator"] →
 * "Outcome Match › Condition 1 › Operator".
 */
export function humanPath(path) {
  const parts = [];
  let previous;
  for (const segment of path || []) {
    const item = LIST_ITEMS[previous];
    const index = typeof segment === "number" || /^\d+$/.test(String(segment));
    if (item && parts.length) {
      parts[parts.length - 1] = index
        ? `${item} ${Number(segment) + 1}`
        : `${item} ${humanize(segment)}`;
    } else if (index) {
      const position = Number(segment) + 1;
      if (parts.length) {
        parts[parts.length - 1] += ` ${position}`;
      } else {
        parts.push(`Item ${position}`);
      }
    } else {
      parts.push(humanize(segment));
    }
    previous = segment;
  }
  return parts.join(" › ");
}

// A connector's slot as words; outcomes and wait events go by their name.
const CONNECTOR_SLOTS = {
  connector: "Connector",
  startElementReference: "Connector",
  faultConnector: "Fault connector",
  defaultConnector: "Default outcome connector",
  nextValueConnector: "For each item connector",
  noMoreValuesConnector: "After last item connector"
};

function connectorTitle(name) {
  if (CONNECTOR_SLOTS[name]) {
    return CONNECTOR_SLOTS[name];
  }
  // "rules.Large_Order.connector" when the outcome has no label.
  const segments = name.split(".");
  return segments.length > 1
    ? `${humanize(segments[segments.length - 2])} connector`
    : `“${name}” connector`;
}

/** What a merge unit covers, within its element, in words. */
export function unitTitle(unit) {
  const tail = unit.label.split(" › ").slice(1).join(" › ");
  switch (unit.kind) {
    case "node":
      return "Whole element";
    case "resource":
      return "Whole resource";
    case "field":
      return humanPath(unit.path);
    case "order":
      return `Order of ${humanPath(unit.path).toLowerCase()}`;
    case "pos":
      return "Position on the canvas";
    case "edge":
      return connectorTitle(tail);
    case "prop":
      return humanize(unit.label);
    default:
      return tail || unit.label;
  }
}

/** "3 elements", "1 element". */
export function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

// Where merge work waits out a page reload. Each store keeps one draft: the
// merge last worked on.
export const DRAFTS = {
  picks: "flowCompare.mergeDraft",
  text: "flowCompare.textDraft",
  mapping: "flowCompare.mappingDraft"
};

/** The draft kept in a store for this merge key, if there is one. */
export function readDraft(store, key) {
  try {
    const draft = JSON.parse(window.sessionStorage.getItem(store));
    return draft && draft.key === key ? draft.value : undefined;
  } catch (ignored) {
    // Storage may be off or hold something unreadable: start afresh.
    return undefined;
  }
}

/**
 * Keeps a draft for this merge key; an empty one clears the store. False
 * when storage refused it (off, or full).
 */
export function writeDraft(store, key, value) {
  try {
    if (value && Object.keys(value).length) {
      window.sessionStorage.setItem(store, JSON.stringify({ key, value }));
    } else {
      window.sessionStorage.removeItem(store);
    }
    return true;
  } catch (ignored) {
    // Without storage, the work lasts until the page reloads.
    return false;
  }
}

// Whether the help videos' buttons show, kept per browser. Help is on until
// someone turns it off; every help button and switch on the page follows
// HELP_EVENT.
const HELP = "tributary.helpVideos";
export const HELP_EVENT = "tributaryhelpchange";
let helpWithoutStorage = true;

/** True unless help videos were turned off in this browser. */
export function helpShown() {
  try {
    return window.localStorage.getItem(HELP) !== "off";
  } catch (ignored) {
    return helpWithoutStorage;
  }
}

/** Turns help videos on or off here and tells every help button. */
export function showHelp(on) {
  try {
    if (on) {
      window.localStorage.removeItem(HELP);
    } else {
      window.localStorage.setItem(HELP, "off");
    }
  } catch (ignored) {
    // Without storage the choice lasts until the page reloads.
    helpWithoutStorage = on;
  }
  window.dispatchEvent(new CustomEvent(HELP_EVENT, { detail: { on } }));
}

// Made once: toLocaleString builds a formatter on every call, which a
// long list of dates feels.
let dateTimeFormat;

/** A date and time in the user's locale, or "" when missing. */
export function formatDateTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  dateTimeFormat =
    dateTimeFormat ||
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    });
  return dateTimeFormat.format(date);
}

/** The time of day of a date-time, short: 3:42 PM. */
export function formatTime(value) {
  const date = new Date(value);
  return !value || Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(undefined, { timeStyle: "short" });
}

/**
 * The local day a date-time falls on, to group by: a key, and a heading of
 * Today, Yesterday or the date, with the year only when it isn't this one.
 */
export function dayOf(value, now = new Date()) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return { key: "undated", label: "Undated" };
  }
  const start = (day) =>
    new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  // Rounded: a day either side of a clock change isn't 24 hours long.
  const ago = Math.round((start(now) - start(date)) / 86400000);
  let label;
  if (ago === 0) {
    label = "Today";
  } else if (ago === 1) {
    label = "Yesterday";
  } else {
    label = date.toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: date.getFullYear() === now.getFullYear() ? undefined : "numeric"
    });
  }
  return {
    key: `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`,
    label
  };
}

/**
 * How the scheduled governance checks stand, from a monitor status: state is
 * Scheduled, Checking, Stopped, Check failed or Checked with errors, with an
 * SLDS badge class and a sentence saying what that means for governed flows.
 */
export function checkStatus(monitor) {
  if (!monitor) {
    return undefined;
  }
  const next =
    monitor.scheduled && monitor.nextRun
      ? ` Next check ${formatDateTime(monitor.nextRun)}.`
      : "";
  const success = monitor.lastSuccess
    ? ` Last successful check ${formatDateTime(monitor.lastSuccess)}.`
    : "";
  // Flows the last check didn't reach: another operation held them, or the
  // org stopped its run of jobs. The next check starts with them.
  const left = monitor.lastRemaining
    ? ` ${plural(monitor.lastRemaining, "flow was", "flows were")} left for the next check.`
    : "";
  if (monitor.running) {
    return {
      state: "Checking",
      badgeClass: "slds-badge slds-badge_lightest",
      text: `Checking governed flows now.${next}`
    };
  }
  if (!monitor.scheduled) {
    return {
      state: "Stopped",
      badgeClass: "slds-badge slds-theme_warning",
      stopped: true,
      text: "Automatic checks stopped — outside activations are checked only when you run a check."
    };
  }
  if (monitor.lastStatus === "Failed" || monitor.lastStatus === "Aborted") {
    return {
      state: "Check failed",
      badgeClass: "slds-badge slds-theme_error",
      text: `The last automatic check didn't finish.${next}${success}`
    };
  }
  // It finished, but some flows went unchecked or unreverted: not all clear.
  if (monitor.lastStatus === "Completed with errors") {
    return {
      state: "Checked with errors",
      badgeClass: "slds-badge slds-theme_warning",
      text: `The last check couldn't check or revert ${monitor.lastFailed ? plural(monitor.lastFailed, "flow") : "some flows"}. Governed Flows shows which.${left}${next}${success}`
    };
  }
  return {
    state: "Scheduled",
    badgeClass: "slds-badge slds-theme_success",
    text: `Checked every ${plural(monitor.intervalMinutes, "minute")}.${left}${next}${success}`
  };
}

// Check outcomes someone should look at.
const CHECK_PROBLEMS = ["reverted", "revertFailed", "missing", "error"];

/**
 * A finished check in a sentence, for a toast: its message and variant.
 * Flows that were changing while it ran, or that another operation held,
 * wait for the next check. counts, from waitForCheck, are exact when the
 * results leave out flows that were fine.
 */
export function checkSummary(results, counts) {
  let problems = results.filter((result) =>
    CHECK_PROBLEMS.includes(result.outcome)
  ).length;
  let skipped = results.filter((result) => result.outcome === "skipped").length;
  let checked = results.length - skipped;
  if (counts && counts.attempted != null) {
    checked = (counts.succeeded || 0) + (counts.failed || 0);
    problems = Math.max(problems, counts.failed || 0);
    // What's left counts flows still skipped at the end.
    skipped =
      counts.remaining != null ? counts.remaining : counts.attempted - checked;
  }
  const later = skipped
    ? ` ${plural(skipped, "flow")} left for the next check.`
    : "";
  return {
    message: `${plural(checked, "flow")} checked${problems ? `, ${plural(problems, "needing attention", "needing attention")}` : ", all as approved"}.${later}`,
    variant: problems ? "warning" : "success"
  };
}

/** The Setup tab, opened at its automatic checks. */
export function monitorRef(pageRef) {
  return {
    type: "standard__navItemPage",
    attributes: { apiName: tabApiName(pageRef, "Flow_Compare_Setup") },
    state: { c__section: "monitor" }
  };
}

// The package's namespace, from one of its own objects: installed, or in a
// namespaced org, the object's API name carries it. The page can't say:
// these components also go on an admin's own Lightning pages.
const PACKAGE_PREFIX =
  (/^(\w+?__)Flow_Governance__c$/.exec(GOVERNANCE.objectApiName) || [])[1] ||
  "";
// The package's own tabs, which name its namespace when the object doesn't.
const OWN_TAB =
  /^([A-Za-z0-9]+__)(?:Flow_Compare|Flow_Compare_Setup|Governed_Flows|Flow_Approvals)$/;

/**
 * A tab's API name with the package's namespace, so links between the
 * package's tabs work installed or not, from its own tabs or another page.
 */
export function tabApiName(pageRef, name) {
  if (PACKAGE_PREFIX) {
    return `${PACKAGE_PREFIX}${name}`;
  }
  const current = pageRef && pageRef.attributes && pageRef.attributes.apiName;
  const match = current && OWN_TAB.exec(current);
  return `${match ? match[1] : ""}${name}`;
}

/**
 * The page reference of the Compare Flows tab showing a flow, and one of its
 * versions when versionNumber is given, against comparedVersion when that is.
 */
export function compareRef(
  pageRef,
  { connection, apiName, versionNumber, comparedVersion, requestId }
) {
  const state = { c__flow: apiName };
  if (requestId) state.c__request = requestId;
  if (versionNumber !== undefined && versionNumber !== null) {
    state.c__vb = String(versionNumber);
  }
  // A request's summary compares with a version: open that comparison.
  if (comparedVersion !== undefined && comparedVersion !== null) {
    state.c__va = String(comparedVersion);
  }
  if (connection && connection !== "local") {
    state.c__conn = connection;
  }
  return {
    type: "standard__navItemPage",
    attributes: { apiName: tabApiName(pageRef, "Flow_Compare") },
    state
  };
}

// Stored values stay as they are; people read what each one does.
const MODE_LABELS = {
  Off: "Off",
  Watch: "Owner only",
  Locked: "Approval required"
};

/** A governance mode as people read it. */
export function modeLabel(mode) {
  return MODE_LABELS[mode] || mode;
}

/**
 * Badge classes for governance modes, the same on every page. The page's own
 * stylesheet colours mode-owner and mode-approval.
 */
export function modeBadge(mode) {
  switch (mode) {
    case "Watch":
      return "slds-badge mode-badge mode-owner";
    case "Locked":
      return "slds-badge mode-badge mode-approval";
    case "Off":
      return "slds-badge";
    default:
      return "slds-badge slds-badge_lightest";
  }
}

/** SLDS badge classes for request statuses. */
export function statusClass(status) {
  switch (status) {
    case "Pending":
      return "slds-badge slds-theme_warning";
    case "Activated":
    case "Approved":
      return "slds-badge slds-theme_success";
    case "Rejected":
    case "Failed":
      return "slds-badge slds-theme_error";
    default:
      return "slds-badge";
  }
}

const MODAL_CONTROLS = [
  "button",
  "a[href]",
  "textarea",
  "lightning-button",
  "lightning-button-icon",
  "lightning-input",
  "lightning-textarea",
  "lightning-combobox",
  "lightning-radio-group",
  "lightning-record-picker"
].join(", ");

/**
 * Focuses the first or the last control of a modal that can take focus, or
 * the modal itself when none can. Guards just before and after a modal call
 * this so that Tab and Shift+Tab wrap around instead of leaving it.
 */
export function focusModalEnd(dialog, last) {
  if (!dialog) {
    return;
  }
  const controls = [...dialog.querySelectorAll(MODAL_CONTROLS)].filter(
    (control) => !control.disabled
  );
  const control = last ? controls[controls.length - 1] : controls[0];
  (control || dialog).focus();
}
