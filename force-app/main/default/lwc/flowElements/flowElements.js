/**
 * What each kind of flow element and resource is called and which SLDS icon
 * it's drawn with. SLDS icons are used unmodified (see NOTICE).
 */
import { ITEM_KEYS, itemAt } from "c/flowModel";

const ELEMENTS = Object.freeze({
  actionCalls: { label: "Action", icon: "standard:invocable_action" },
  apexPluginCalls: { label: "Apex Plugin", icon: "standard:apex_plugin" },
  assignments: { label: "Assignment", icon: "standard:assignment" },
  collectionProcessors: {
    label: "Collection Processor",
    icon: "standard:collection"
  },
  customErrors: { label: "Custom Error", icon: "standard:custom" },
  decisions: { label: "Decision", icon: "standard:decision" },
  experiments: { label: "Experiment", icon: "standard:steps" },
  groups: { label: "Group", icon: "standard:groups" },
  loops: { label: "Loop", icon: "standard:loop" },
  orchestratedStages: { label: "Stage", icon: "standard:stage" },
  recordCreates: { label: "Create Records", icon: "standard:record_create" },
  recordDeletes: { label: "Delete Records", icon: "standard:record_delete" },
  recordLookups: { label: "Get Records", icon: "standard:record_lookup" },
  recordRollbacks: { label: "Roll Back Records", icon: "standard:record" },
  recordUpdates: { label: "Update Records", icon: "standard:record_update" },
  screens: { label: "Screen", icon: "standard:screen" },
  start: { label: "Start", icon: "standard:flow" },
  steps: { label: "Step", icon: "standard:steps" },
  subflows: { label: "Subflow", icon: "standard:flow" },
  transforms: { label: "Transform", icon: "standard:data_transforms" },
  waits: { label: "Pause", icon: "standard:waits" }
});

const ACTION_ICONS = Object.freeze({
  apex: "standard:apex",
  emailAlert: "standard:email",
  emailSimple: "standard:email",
  customNotificationAction: "standard:custom_notification",
  flow: "standard:flow",
  quickAction: "standard:actions_and_buttons",
  component: "standard:screen"
});

const COLLECTION_PROCESSORS = Object.freeze({
  SortCollectionProcessor: { label: "Collection Sort", icon: "standard:sort" },
  FilterCollectionProcessor: {
    label: "Collection Filter",
    icon: "standard:filter"
  }
});

const RESOURCES = Object.freeze({
  choices: { label: "Choice", icon: "standard:choice" },
  collectionFilterCriteria: {
    label: "Collection Filter Criteria",
    icon: "standard:filter_criteria"
  },
  constants: { label: "Constant", icon: "standard:constant" },
  customProperties: { label: "Custom Property", icon: "standard:custom" },
  dynamicChoiceSets: {
    label: "Choice Set",
    icon: "standard:dynamic_record_choice"
  },
  exitRules: { label: "Exit Rule", icon: "standard:filter_criteria_rule" },
  formulas: { label: "Formula", icon: "standard:formula" },
  stages: { label: "Stage", icon: "standard:stage" },
  textTemplates: { label: "Text Template", icon: "standard:text_template" },
  variables: { label: "Variable", icon: "standard:variable" }
});

const CONNECTOR_LABELS = Object.freeze({
  fault: "Fault",
  loopNext: "For Each Item",
  loopEnd: "After Last Item",
  default: "Default Outcome"
});

const TRIGGERS = Object.freeze({
  RecordAfterSave: "Record-Triggered",
  RecordBeforeSave: "Record-Triggered (Fast Field Updates)",
  RecordBeforeDelete: "Record-Triggered (Before Delete)",
  Scheduled: "Schedule-Triggered",
  PlatformEvent: "Platform Event–Triggered",
  Segment: "Segment-Triggered",
  Capability: "Capability"
});

const RECORD_EVENTS = Object.freeze({
  Create: "is created",
  Update: "is updated",
  CreateAndUpdate: "is created or updated",
  Delete: "is deleted"
});

const PROCESS_TYPES = Object.freeze({
  Flow: "Screen Flow",
  AutoLaunchedFlow: "Autolaunched Flow",
  Workflow: "Process Builder",
  CustomEvent: "Process Builder",
  InvocableProcess: "Process Builder",
  Orchestrator: "Orchestration",
  TransactionSecurityFlow: "Transaction Security Flow",
  FieldServiceMobile: "Field Service Mobile Flow",
  FieldServiceWeb: "Field Service Embedded Flow",
  ContactRequestFlow: "Contact Request Flow",
  CheckoutFlow: "Checkout Flow",
  Survey: "Survey",
  Appointments: "Appointments Flow",
  RoutingFlow: "Omni-Channel Flow",
  EvaluationFlow: "Evaluation Flow"
});

/** Label and icon for a canvas element: a model node, or { type, fields }. */
export function elementInfo(node) {
  const type = node.type;
  const fields = node.fields || {};
  let info = ELEMENTS[type] || {
    label: humanize(type),
    icon: "standard:default"
  };
  if (type === "actionCalls" && ACTION_ICONS[fields.actionType]) {
    info = { ...info, icon: ACTION_ICONS[fields.actionType] };
  } else if (type === "collectionProcessors") {
    info = COLLECTION_PROCESSORS[fields.elementSubtype] || info;
  }
  return info;
}

/** Label and icon for a resource. */
export function resourceInfo(resource) {
  const info = RESOURCES[resource.type] || {
    label: humanize(resource.type),
    icon: "standard:default"
  };
  const fields = resource.fields || {};
  if (resource.type === "variables") {
    if (fields.isCollection) {
      return {
        label:
          fields.dataType === "SObject"
            ? "Record Collection Variable"
            : "Collection Variable",
        icon: "standard:collection_variable"
      };
    }
    if (fields.dataType === "SObject") {
      return { label: "Record Variable", icon: "standard:record" };
    }
  }
  return info;
}

export function resourceTypeLabel(type) {
  return (RESOURCES[type] || { label: humanize(type) }).label;
}

/** The label a connector is drawn with, or undefined for a plain next path. */
export function connectorLabel(edge) {
  if (edge.kind === "outcome" || edge.kind === "waitEvent") {
    return edge.label || lastNamedSegment(edge.slot);
  }
  if (edge.kind === "scheduledPath") {
    return edge.label || "Scheduled Path";
  }
  if (edge.kind === "default") {
    return edge.label || CONNECTOR_LABELS.default;
  }
  if (CONNECTOR_LABELS[edge.kind]) {
    return CONNECTOR_LABELS[edge.kind];
  }
  if (edge.kind === "experimentPath") {
    return edge.label || lastNamedSegment(edge.slot);
  }
  return undefined;
}

const SLOT_LABELS = Object.freeze({
  connector: "Next",
  startElementReference: "Next",
  faultConnector: CONNECTOR_LABELS.fault,
  nextValueConnector: CONNECTOR_LABELS.loopNext,
  noMoreValuesConnector: CONNECTOR_LABELS.loopEnd,
  timeoutConnector: "Timeout"
});

/**
 * What a connector slot of an element is called, whether or not anything
 * is connected there: "Next", "Default Outcome", an outcome's label.
 */
export function slotLabel(node, slot) {
  if (SLOT_LABELS[slot]) {
    return SLOT_LABELS[slot];
  }
  const fields = (node && node.fields) || {};
  if (slot === "defaultConnector") {
    return fields.defaultConnectorLabel || CONNECTOR_LABELS.default;
  }
  const [list, name] = String(slot).split(".");
  const item =
    name === undefined
      ? undefined
      : itemAt(Array.isArray(fields[list]) ? fields[list] : [], name);
  return (item && item.label) || name || humanize(slot);
}

function lastNamedSegment(slot) {
  const segments = String(slot || "").split(".");
  return segments.length > 1 ? segments[segments.length - 2] : undefined;
}

/** What kind of flow this is, e.g. "Record-Triggered Flow". */
export function flowTypeLabel(model) {
  const start = model.nodes && model.nodes.get("$Start");
  const fields = (start && start.fields) || {};
  if (fields.triggerType && TRIGGERS[fields.triggerType]) {
    return `${TRIGGERS[fields.triggerType]} Flow`;
  }
  if (model.processType === "AutoLaunchedFlow") {
    return "Autolaunched Flow (No Trigger)";
  }
  return (
    PROCESS_TYPES[model.processType] || humanize(model.processType || "Flow")
  );
}

/** One line describing what starts the flow, for the start element. */
export function startSummary(model) {
  const start = model.nodes && model.nodes.get("$Start");
  const fields = (start && start.fields) || {};
  if (fields.object && RECORD_EVENTS[fields.recordTriggerType]) {
    return `When a ${fields.object} record ${RECORD_EVENTS[fields.recordTriggerType]}`;
  }
  if (fields.triggerType === "Scheduled" && fields.schedule) {
    const s = fields.schedule;
    return [s.frequency, s.startDate, s.startTime].filter(Boolean).join(" · ");
  }
  if (fields.triggerType === "PlatformEvent" && fields.object) {
    return `When ${fields.object} is published`;
  }
  return flowTypeLabel(model);
}

/** "recordLookups" → "Record Lookups", "loopNext" → "Loop Next". */
export function humanize(name) {
  if (!name) {
    return "";
  }
  const spaced = String(name)
    .replace(/__c$/, "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Keys with a value; the Tooling API sends every other one as null.
function setKeys(value) {
  return Object.keys(value).filter(
    (key) => value[key] !== null && value[key] !== undefined
  );
}

// A flow value ({ stringValue: "x" }) reads better as just its content.
function isFlowValue(value) {
  const keys = setKeys(value);
  return keys.length === 1 && /(Value|Reference|Expression)$/.test(keys[0]);
}

function isRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    (Array.isArray(value) || !isFlowValue(value))
  );
}

// Plain words for the operators of conditions, filters and assignments.
const COMPARISONS = Object.freeze({
  EqualTo: "equals",
  NotEqualTo: "doesn't equal",
  GreaterThan: "is greater than",
  LessThan: "is less than",
  GreaterThanOrEqualTo: "is at least",
  LessThanOrEqualTo: "is at most",
  StartsWith: "starts with",
  EndsWith: "ends with",
  Contains: "contains",
  In: "is one of",
  NotIn: "isn't one of",
  IsOn: "is on",
  IsBefore: "is before",
  IsAfter: "is after"
});

// Operators whose right side is true or false: "is null", "isn't null".
const YES_NO = Object.freeze({
  IsNull: ["is null", "isn't null"],
  IsBlank: ["is blank", "isn't blank"],
  IsEmpty: ["is empty", "isn't empty"],
  IsChanged: ["changed", "didn't change"],
  WasSet: ["was set", "wasn't set"],
  WasSelected: ["was selected", "wasn't selected"],
  WasVisited: ["was visited", "wasn't visited"],
  HasError: ["has an error", "has no error"]
});

// Operators that need nothing on the right.
const UNARY = Object.freeze({
  HasValue: "has a value",
  HasNoValue: "has no value",
  IsToday: "is today",
  IsTomorrow: "is tomorrow",
  IsYesterday: "is yesterday",
  IsThisMonth: "is this month",
  IsNextMonth: "is next month",
  IsLastMonth: "is last month",
  ThisYear: "is this year",
  NextYear: "is next year",
  LastYear: "is last year",
  IsAnniversaryOfToday: "is an anniversary of today",
  IsNotAnniversaryOfToday: "isn't an anniversary of today"
});

// Operators counting a number of days, months or years.
const SPANS = Object.freeze({
  LastNumberOfDays: ["is in the last", "days"],
  NextNumberOfDays: ["is in the next", "days"],
  GreaterThanLastNumberOfDays: ["is more than", "days ago"],
  LastNumberOfMonths: ["is in the last", "months"],
  NextNumberOfMonths: ["is in the next", "months"],
  LastNumberOfYears: ["is in the last", "years"]
});

const ASSIGNMENTS = Object.freeze({
  Assign: (to, value) => `Set ${to} to ${value}`,
  Add: (to, value) => `Add ${value} to ${to}`,
  Subtract: (to, value) => `Subtract ${value} from ${to}`,
  AddItem: (to, value) => `Add ${value} to the end of ${to}`,
  AddAtStart: (to, value) => `Add ${value} to the start of ${to}`,
  RemoveFirst: (to, value) => `Remove the first ${value} from ${to}`,
  RemoveAll: (to, value) => `Remove every ${value} from ${to}`,
  RemoveBeforeFirst: (to, value) =>
    `Remove everything before the first ${value} in ${to}`,
  RemoveAfterFirst: (to, value) =>
    `Remove everything after the first ${value} in ${to}`,
  RemoveUncommon: (to, value) =>
    `Keep only the items of ${to} that are also in ${value}`,
  RemovePosition: (to, value) => `Remove item ${value} from ${to}`,
  AssignCount: (to, value) => `Set ${to} to the number of items in ${value}`
});

const LOGIC = Object.freeze({
  and: "All conditions are met",
  or: "Any condition is met",
  formula_evaluates_to_true: "The formula is true",
  no_conditions: "Always"
});

/** "and" → "All conditions are met"; custom logic stays as written. */
export function logicLabel(logic) {
  if (LOGIC[logic]) {
    return LOGIC[logic];
  }
  return logic ? `Custom: ${String(logic).toUpperCase()}` : "";
}

/** An operator in words: "GreaterThan" → "is greater than". */
export function operatorLabel(operator) {
  const yesNo = YES_NO[operator];
  return (
    COMPARISONS[operator] ||
    UNARY[operator] ||
    (SPANS[operator] && SPANS[operator].join(" N ")) ||
    (yesNo && yesNo[0]) ||
    (ASSIGNMENTS[operator] && humanize(operator).toLowerCase()) ||
    operator
  );
}

// One side of a phrase: a reference by its name, text in quotes.
function operand(value) {
  if (value === undefined) {
    return "nothing";
  }
  if (typeof value === "string") {
    return `“${value}”`;
  }
  if (typeof value !== "object" || value === null) {
    return String(value);
  }
  const [key] = setKeys(value);
  if (isFlowValue(value)) {
    const inner = value[key];
    if (key === "elementReference") {
      return String(inner);
    }
    if (key === "formulaExpression") {
      return `the formula ${inner}`;
    }
    return typeof inner === "string" ? `“${inner}”` : String(inner);
  }
  return formatValue(value);
}

function isTrue(value) {
  const inner = value && typeof value === "object" ? value.booleanValue : value;
  return inner !== false && inner !== "false";
}

function comparison(left, operator, right) {
  if (UNARY[operator]) {
    return `${left} ${UNARY[operator]}`;
  }
  if (YES_NO[operator]) {
    return `${left} ${YES_NO[operator][isTrue(right) ? 0 : 1]}`;
  }
  if (SPANS[operator]) {
    const [before, after] = SPANS[operator];
    return `${left} ${before} ${operand(right)} ${after}`;
  }
  const words = COMPARISONS[operator] || humanize(operator).toLowerCase();
  return `${left} ${words} ${operand(right)}`;
}

/**
 * A condition, filter, assignment or parameter as one plain sentence, e.g.
 * "Amount is greater than 10000" or "Set Total to 0". `key` is the list the
 * value sits in, for the kinds that only it tells apart. Anything else gives
 * undefined.
 */
export function phrase(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const keys = setKeys(value).filter(
    (name) => name !== "processMetadataValues"
  );
  const only = (...allowed) => keys.every((name) => allowed.includes(name));
  const { operator } = value;
  if (
    operator &&
    (value.leftValueReference || value.objectFieldName) &&
    only(
      "leftValueReference",
      "objectFieldName",
      "objectReferencePath",
      "operator",
      "rightValue"
    )
  ) {
    return comparison(
      value.objectFieldName || value.leftValueReference,
      operator,
      value.rightValue
    );
  }
  if (operator && value.field && only("field", "operator", "value")) {
    return comparison(value.field, operator, value.value);
  }
  const target = value.assignToReference || value.assignToFieldReference;
  if (
    operator &&
    target &&
    only("assignToReference", "assignToFieldReference", "operator", "value")
  ) {
    const words = ASSIGNMENTS[operator];
    return words
      ? words(target, operand(value.value))
      : `${target} ${humanize(operator).toLowerCase()} ${operand(value.value)}`;
  }
  if (value.field && !operator && only("field", "value")) {
    return `Set ${value.field} to ${operand(value.value)}`;
  }
  if (
    value.assignToReference &&
    value.field &&
    only("assignToReference", "field")
  ) {
    return `Store ${value.field} in ${value.assignToReference}`;
  }
  if (key === "inputParameters" && value.name && only("name", "value")) {
    return `Set input ${value.name} to ${operand(value.value)}`;
  }
  if (
    key === "outputParameters" &&
    value.name &&
    value.assignToReference &&
    only("name", "assignToReference")
  ) {
    return `Store output ${value.name} in ${value.assignToReference}`;
  }
  return undefined;
}

// A plain value that's really one of a few codes reads as words.
function plainScalar(value, key) {
  if (key === "operator") {
    return operatorLabel(value);
  }
  if (key === "conditionLogic" || key === "filterLogic") {
    return logicLabel(value);
  }
  return undefined;
}

// A list or record as "Name: value" lines: records nest by indent and list
// items are numbered. Empty fields are left out; the XML has them all.
// Conditions, assignments and the like read as a sentence each.
function readableLines(value, key) {
  const list = Array.isArray(value);
  const entries = list
    ? value.map((item, index) => [`${index + 1}.`, item, key])
    : setKeys(value)
        .filter((name) => !(Array.isArray(value[name]) && !value[name].length))
        .map((name) => {
          const words = humanize(name);
          return [
            `${words.charAt(0)}${words.slice(1).toLowerCase()}:`,
            value[name],
            name
          ];
        });
  const lines = [];
  for (const [name, item, itemKey] of entries) {
    if (!isRecord(item) || phrase(item, itemKey)) {
      lines.push(`${name} ${formatValue(item, itemKey)}`);
      continue;
    }
    const inner = readableLines(item, itemKey);
    if (list) {
      // "1. First field", the rest lined up under it.
      const pad = " ".repeat(name.length + 1);
      lines.push(`${name} ${inner[0] || ""}`.trimEnd());
      lines.push(...inner.slice(1).map((line) => pad + line));
    } else {
      lines.push(name, ...inner.map((line) => `  ${line}`));
    }
  }
  return lines;
}

/**
 * A value shown in the property panel: plain values as they are, a flow
 * value as its content, conditions and the like as a sentence, and lists and
 * records as readable lines. `key` is the field the value is in.
 */
export function formatValue(value, key) {
  if (value === undefined) {
    return "—";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return plainScalar(value, key) || value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const sentence = phrase(value, key);
  if (sentence) {
    return sentence;
  }
  if (!isRecord(value)) {
    const [inner] = setKeys(value);
    return inner === "elementReference"
      ? `{!${value[inner]}}`
      : formatValue(value[inner]);
  }
  const lines = readableLines(value, key);
  return lines.length ? lines.join("\n") : "None";
}

/**
 * Where a change sits inside something that reads as a sentence, such as a
 * condition: the path of that part and the list it's in, or undefined. The
 * fields are the element's own, on the side the path is numbered in.
 */
export function phraseContext(fields, path) {
  let value = fields;
  for (let depth = 0; depth < path.length; depth++) {
    const segment = path[depth];
    if (Array.isArray(value)) {
      value =
        typeof segment === "number"
          ? value[segment]
          : value.find(
              (item) => item && ITEM_KEYS.some((key) => item[key] === segment)
            );
    } else if (value && typeof value === "object") {
      value = value[segment];
    } else {
      return undefined;
    }
    const listKey = depth > 0 ? path[depth - 1] : undefined;
    if (phrase(value, listKey)) {
      return { path: path.slice(0, depth + 1), key: listKey, value };
    }
  }
  return undefined;
}
