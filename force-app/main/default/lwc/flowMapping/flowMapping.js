/**
 * Maps one flow onto another so two different flows can be merged: the
 * other flow's $Record, variables and Get Records elements are mapped onto
 * this flow's (or onto new variables), clashing names are renamed, and its
 * elements are brought in beside this flow's.
 *
 * planMapping(target, source) lists what there is to decide, with
 * suggestions. translateFlow(target, source, choices) gives the flow to
 * merge from: the target with the source's elements added, written in the
 * target's names. It keeps the target's start and flow settings, so a merge
 * against the target only differs by what the other flow brings.
 *
 * Choices: { roots: { <lower-case name>: { to } | { create } },
 *            elements: { <lower-case name>: "one" | "both" } }
 *   to      what the name becomes: something the target has ("$Record",
 *           "caseVar", "Get_Case") or a longer reference ("$Record.Id")
 *   create  bring it along under this name; for $Record, a new variable
 *   one     an element both flows name the same is one element
 *   both    keep both, renaming the other flow's
 */
import {
  buildModel,
  isConnector,
  isModel,
  isPlainObject,
  toMetadata,
  NODE_COLLECTIONS,
  RESOURCE_COLLECTIONS,
  START
} from "c/flowModel";
import { ERROR, NOT_DEFINED, WARNING, referenceRoot } from "c/flowMerge";
import { NODE_WIDTH, layoutFlow, nodeId, usesAutoLayout } from "c/flowLayout";

export const RECORD = "$record";
export const PRIOR = "$record__prior";
const RECORD_ID = "$record.id";

const RECORD_TRIGGERS = new Set(["RecordAfterSave", "RecordBeforeSave"]);
const REFERENCE_FIELD = /References?$/;
const MERGE_FIELD = /\{!\s*([^}\s]+?)\s*\}/g;
// Fields that store a value into what they name.
const WRITE_FIELD =
  /^(assignToReference|outputReference|assignRecordIdToReference|assignNextValueToReference)$/;
const MAX_NAME = 80;
// Scores at which a target is suggested, and used without asking.
const SUGGEST = 30;
const RECORD_DEFAULT = 40;
const DEFAULT = 80;

const lower = (name) => String(name).toLowerCase();
const squash = (name) => lower(name).replace(/[^a-z0-9]/g, "");

function asModel(input) {
  return isModel(input) ? input : buildModel(input);
}

/** Whether two flows are different flows, not versions of one, so merging them needs a mapping. */
export function isCrossFlow(before, after) {
  return Boolean(
    before &&
    after &&
    before.name &&
    after.name &&
    lower(before.name) !== lower(after.name)
  );
}

/** Whether a name can be a flow API name. */
export function validName(name) {
  return (
    typeof name === "string" &&
    name.length <= MAX_NAME &&
    /^[A-Za-z][A-Za-z0-9_]*$/.test(name) &&
    !name.includes("__") &&
    !name.endsWith("_")
  );
}

function sanitize(name) {
  let out = String(name || "")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[A-Za-z]/.test(out)) {
    out = `X${out}`;
  }
  return out.slice(0, MAX_NAME).replace(/_+$/, "");
}

// A name from `base` that `free` accepts: base itself, else base_2, base_3...
function uniqueName(base, free) {
  const clean = sanitize(base);
  if (free(clean)) {
    return clean;
  }
  // After note_2, note_3 rather than note_2_2.
  const numbered = /^(.*[^_])_(\d+)$/.exec(clean);
  const number = numbered ? Number(numbered[2]) : undefined;
  // Huge numeric suffixes round, stop incrementing, or become exponent text.
  // Treat those as part of the name rather than as a counter.
  const increment = Number.isSafeInteger(number);
  let stem = increment ? numbered[1] : clean;
  for (let n = increment ? number + 1 : 2; ; n++) {
    if (!Number.isSafeInteger(n)) {
      stem = clean;
      n = 2;
    }
    const suffix = `_${n}`;
    const name = `${stem.slice(0, MAX_NAME - suffix.length).replace(/_+$/, "")}${suffix}`;
    if (free(name)) {
      return name;
    }
  }
}

function objectBase(object) {
  return object ? sanitize(object.replace(/__c$/i, "")) : "Triggering";
}

// Names defined inside an element or resource: outcomes, screen fields,
// wait events... (not the names of parameters it passes on).
function innerNames(value, found = [], key) {
  if (Array.isArray(value)) {
    if (!(key && NOT_DEFINED.test(key))) {
      for (const item of value) {
        innerNames(item, found);
      }
    }
  } else if (isPlainObject(value)) {
    if (typeof value.name === "string") {
      found.push(value.name);
    }
    for (const [field, item] of Object.entries(value)) {
      innerNames(item, found, field);
    }
  }
  return found;
}

// Every name a flow defines, lower-cased, with what defines it: the key of
// the element or resource.
function nameOwners(model) {
  const owners = new Map();
  const add = (name, owner) => {
    if (!owners.has(lower(name))) {
      owners.set(lower(name), owner);
    }
  };
  for (const node of model.nodes.values()) {
    if (node.key !== START) {
      add(node.key, node.key);
      for (const name of innerNames(node.fields)) {
        add(name, node.key);
      }
    }
  }
  for (const resource of model.resources.values()) {
    add(resource.key, resource.key);
    for (const name of innerNames(resource.fields)) {
      add(name, resource.key);
    }
  }
  return owners;
}

/**
 * Where a flow's names are used: lower-case name → { name, owners,
 * writers }, for names it defines and $Record / $Record__Prior. Owners are
 * the elements and resources using it; writers the ones storing into it,
 * as { owner, field }. The start isn't counted: a mapped flow keeps the
 * target's.
 */
export function rootUses(model) {
  const uses = new Map();
  const note = (root, owner, field) => {
    const key = lower(root);
    if (key.startsWith("$") && key !== RECORD && key !== PRIOR) {
      return;
    }
    if (!uses.has(key)) {
      uses.set(key, { name: root, owners: [], writers: [] });
    }
    const use = uses.get(key);
    if (!use.owners.includes(owner)) {
      use.owners.push(owner);
    }
    if (field && WRITE_FIELD.test(field)) {
      use.writers.push({ owner, field });
    }
  };
  const walk = (value, owner, field) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, owner, field);
      }
    } else if (isPlainObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        walk(item, owner, key);
      }
    } else if (typeof value === "string") {
      if (field && REFERENCE_FIELD.test(field)) {
        const root = referenceRoot(value);
        if (root) {
          note(root, owner, field);
        }
      }
      for (const match of value.matchAll(MERGE_FIELD)) {
        const root = referenceRoot(match[1]);
        if (root) {
          note(root, owner);
        }
      }
    }
  };
  for (const node of model.nodes.values()) {
    if (node.key !== START) {
      walk(node.fields, node.key);
    }
  }
  for (const resource of model.resources.values()) {
    walk(resource.fields, resource.key);
  }
  return uses;
}

const sobject = (objectType, extra = {}) => ({
  kind: "data",
  dataType: "SObject",
  objectType,
  collection: false,
  ...extra
});

function describeResource(resource) {
  const { fields, type } = resource;
  switch (type) {
    case "variables":
      return {
        kind: "data",
        dataType: fields.dataType,
        objectType: fields.objectType,
        apexClass: fields.apexClass,
        collection: fields.isCollection === true,
        input: fields.isInput === true
      };
    case "formulas":
    case "constants":
      return { kind: "data", dataType: fields.dataType, readOnly: true };
    case "textTemplates":
      return { kind: "data", dataType: "String", readOnly: true };
    default:
      return { kind: type, readOnly: true };
  }
}

/**
 * What a Get Records compares the Id with, lower-case, when that is all its
 * query does: one record, found by one `Id = {!ref}` condition. It then gets
 * the record with that ID or nothing. Any other condition, an OR, a limit or
 * related records could get another record or leave it out, so removing
 * such a lookup in favour of a record the flow already has isn't safe.
 */
function soleIdRef(fields) {
  const filters = fields.filters || [];
  const [filter] = filters;
  const ref = filter && filter.value && filter.value.elementReference;
  return fields.getFirstRecordOnly === true &&
    filters.length === 1 &&
    lower(filter.field || "") === "id" &&
    (filter.operator || "EqualTo") === "EqualTo" &&
    typeof ref === "string" &&
    /^(and|or|1)?$/.test(lower(fields.filterLogic || "").trim()) &&
    fields.limit === undefined &&
    fields.relatedRecords === undefined
    ? lower(ref)
    : undefined;
}

// The ID reference of a record a name holds: "$record.id" for $Record.
const idOf = (name) => `${lower(name)}.id`;

function describeLookup(node) {
  const idRef = soleIdRef(node.fields);
  return sobject(node.fields.object, {
    collection: node.fields.getFirstRecordOnly !== true,
    readOnly: true,
    byId: idRef !== undefined,
    // What the ID is compared with, to tell whether it's the record the
    // flow starts from.
    idRef
  });
}

/**
 * Which target record ID each source ID is taken to be, by the choices for
 * the non-lookup rows: recordId mapped to $Record.Id, or $Record.Id itself
 * when $Record is mapped onto the target's $Record.
 */
function idsAs(rows, choiceOf) {
  const ids = new Map();
  for (const row of rows) {
    const to = row.kind === "lookup" ? undefined : choiceOf(row).to;
    if (to === undefined) {
      continue;
    }
    if (/\.id$/i.test(to)) {
      ids.set(row.key, lower(to));
    } else {
      ids.set(idOf(row.key), idOf(to));
    }
  }
  return ids;
}

// Whether a Get Records gets exactly the record `to` holds, so it can go
// and what it stored be read from `to` instead.
function getsSameRecord(fields, to, ids) {
  const ref = soleIdRef(fields);
  return ref !== undefined && ids.get(ref) === idOf(to);
}

const DATA_TYPE_GROUPS = {
  string: "text",
  picklist: "text",
  multipicklist: "text",
  number: "number",
  currency: "number"
};

function typeGroup(dataType) {
  const key = lower(dataType || "");
  return DATA_TYPE_GROUPS[key] || key;
}

const DATA_TYPE_LABELS = {
  String: "Text",
  DateTime: "Date/Time",
  Multipicklist: "Multi-Select Picklist"
};

const KIND_LABELS = {
  choices: "Choice",
  dynamicChoiceSets: "Choice set",
  stages: "Stage",
  collectionFilterCriteria: "Filter",
  customProperties: "Property",
  exitRules: "Exit rule"
};

/** What a type descriptor holds, in words: "Case record", "Text collection". */
export function typeLabel(desc) {
  if (!desc) {
    return "";
  }
  if (desc.kind !== "data") {
    return KIND_LABELS[desc.kind] || desc.kind;
  }
  if (desc.dataType === "SObject") {
    const object = desc.objectType || "Any";
    return desc.collection ? `${object} records` : `${object} record`;
  }
  const base =
    desc.dataType === "Apex" && desc.apexClass
      ? desc.apexClass
      : DATA_TYPE_LABELS[desc.dataType] || desc.dataType || "Value";
  return desc.collection ? `${base} collection` : base;
}

/**
 * Whether what `from` holds fits in `to`: the same kind of value, the same
 * object for records, both single or both collections. A name the flow
 * stores into can't become something read-only.
 */
export function compatible(from, to, written = false) {
  if (!from || !to || (written && to.readOnly)) {
    return false;
  }
  if (from.kind !== "data" || to.kind !== "data") {
    return from.kind === to.kind;
  }
  if (typeGroup(from.dataType) !== typeGroup(to.dataType)) {
    return false;
  }
  if (Boolean(from.collection) !== Boolean(to.collection)) {
    return false;
  }
  if (
    from.dataType === "SObject" &&
    from.objectType &&
    to.objectType &&
    lower(from.objectType) !== lower(to.objectType)
  ) {
    return false;
  }
  if (
    from.dataType === "Apex" &&
    from.apexClass &&
    to.apexClass &&
    lower(from.apexClass) !== lower(to.apexClass)
  ) {
    return false;
  }
  return true;
}

function startObject(model) {
  const start = model.nodes.get(START);
  return start && !start.synthetic ? start.fields.object : undefined;
}

// What a source name can become in the target.
function targetsOf(target) {
  const out = [];
  const start = target.nodes.get(START);
  const object = startObject(target);
  if (object) {
    out.push({
      to: "$Record",
      global: RECORD,
      label: `Triggering ${object} ($Record)`,
      desc: sobject(object)
    });
    if (
      RECORD_TRIGGERS.has(start.fields.triggerType) &&
      /Update/.test(start.fields.recordTriggerType || "")
    ) {
      out.push({
        to: "$Record__Prior",
        global: PRIOR,
        label: `${object} before the change ($Record__Prior)`,
        desc: sobject(object, { readOnly: true })
      });
    }
    out.push({
      to: "$Record.Id",
      global: RECORD_ID,
      label: `Triggering ${object} ID ($Record.Id)`,
      desc: { kind: "data", dataType: "String", readOnly: true, object }
    });
  }
  for (const resource of target.resources.values()) {
    const desc = describeResource(resource);
    out.push({
      to: resource.key,
      label: resource.key,
      resourceType: resource.type,
      desc
    });
    // A record the flow is given has an ID a record ID can be.
    if (desc.dataType === "SObject" && desc.input && !desc.collection) {
      out.push({
        to: `${resource.key}.Id`,
        idOf: resource.key,
        label: `${resource.key} ID (${resource.key}.Id)`,
        desc: {
          kind: "data",
          dataType: "String",
          readOnly: true,
          object: desc.objectType
        }
      });
    }
  }
  for (const node of target.nodes.values()) {
    if (
      node.type === "recordLookups" &&
      node.fields.storeOutputAutomatically === true
    ) {
      out.push({
        to: node.key,
        label: node.label ? `${node.label} (${node.key})` : node.key,
        nodeKey: node.key,
        desc: describeLookup(node)
      });
    }
  }
  return out.map((option) => ({
    ...option,
    typeLabel: typeLabel(option.desc)
  }));
}

function isIdName(name, object) {
  const key = squash(name);
  return (
    key === "recordid" ||
    key === "id" ||
    (object && key === `${squash(object.replace(/__c$/i, ""))}id`)
  );
}

// How well a target fits a source name, and why: { score, basis, byName },
// score 0 when it can't hold it. The type always has to fit; byName marks
// the guesses resting on nothing but the names.
function fitOf(row, option) {
  const fit = (score, basis, byName = false) => ({ score, basis, byName });
  if (option.global === RECORD_ID || option.idOf) {
    return row.kind === "resource" &&
      typeGroup(row.desc.dataType) === "text" &&
      !row.desc.collection &&
      !row.written &&
      isIdName(row.name, option.desc.object)
      ? fit(
          80,
          `Text named like a record ID, so taken to be the ${option.desc.object} ID`,
          true
        )
      : fit(0);
  }
  if (!compatible(row.desc, option.desc, row.written)) {
    return fit(0);
  }
  if (lower(row.name) === lower(option.to)) {
    return fit(100, "Same name and type");
  }
  if (row.global && row.global === option.global) {
    return fit(95, "The same record");
  }
  if (row.desc.dataType === "SObject" && !row.desc.collection) {
    const object = row.desc.objectType || "record";
    const byId = (yes) => (yes ? " by ID" : " (not by ID)");
    if (row.kind === "record" && option.desc.input) {
      return fit(
        80,
        `A ${object} this flow is given, taken to be the one the other starts from`
      );
    }
    if (row.desc.input && option.global === RECORD) {
      return fit(
        80,
        `Given a ${object}, taken to be the one this flow starts from`
      );
    }
    // Mapping a lookup drops its query, so it's only done without asking
    // when the lookup gets the record its own flow starts from. Any other
    // ID, a parent case say, is offered but left to the user.
    if (row.kind === "lookup" && option.global === RECORD) {
      return fit(
        row.desc.gets.has(RECORD_ID) ? 80 : row.desc.byId ? 70 : 50,
        `Gets a ${object}${byId(row.desc.byId)}, taken to be the one this flow starts from`
      );
    }
    // The record one flow is given and the one the other looks up by ID.
    if (row.kind === "lookup" && option.desc.input) {
      return fit(
        row.desc.gets.has(`${lower(option.to)}.id`)
          ? 80
          : row.desc.byId
            ? 70
            : 50,
        `Gets a ${object}${byId(row.desc.byId)}, taken to be the one this flow is given`
      );
    }
    if (row.desc.input && option.nodeKey) {
      return fit(
        option.desc.byId ? 80 : 40,
        `Given a ${object}, taken to be the one this flow gets${byId(option.desc.byId)}`
      );
    }
    if (row.kind === "record" && option.nodeKey) {
      return fit(
        option.desc.byId ? 70 : 40,
        `This flow gets a ${object}${byId(option.desc.byId)}, taken to be the one the other starts from`
      );
    }
  }
  if (squash(row.name) === squash(option.to)) {
    return fit(60, "Similar name, same type", true);
  }
  const object =
    row.desc.objectType && squash(row.desc.objectType.replace(/__c$/i, ""));
  if (object && squash(option.to).includes(object)) {
    return fit(30, `Same type, named for ${row.desc.objectType}`, true);
  }
  return fit(10, "Same type");
}

/**
 * What mapping `source` onto `target` needs decided:
 *   roots     names the source's elements use that the target may already
 *             have: $Record, $Record__Prior, its variables and other
 *             resources, and Get Records elements that store their record.
 *             Each is { key, name, kind, desc, typeLabel, uses, written,
 *             options, suggestion, defaultChoice }, options being the
 *             target's names that could hold it, best first, each with
 *             its score, the basis for it in words, and byName when only
 *             the names suggest it.
 *   elements  elements both flows have under one name and type:
 *             { key, name, targetKey, type, label, same, defaultChoice },
 *             same when they do the same and lead to the same places once
 *             mapped, suggested as "one" element then and "both" otherwise.
 */
export function planMapping(targetInput, sourceInput) {
  const target = asModel(targetInput);
  const source = asModel(sourceInput);
  const uses = rootUses(source);
  const options = targetsOf(target);
  const targetNodes = new Map(
    [...target.nodes.values()].map((node) => [lower(node.key), node])
  );
  const targetNames = nameOwners(target);
  const sourceNames = nameOwners(source);
  const taken = (name) =>
    targetNames.has(lower(name)) || sourceNames.has(lower(name));

  const elements = [];
  const sameElement = new Set();
  for (const node of source.nodes.values()) {
    const match = targetNodes.get(lower(node.key));
    if (node.key !== START && match && match.type === node.type) {
      sameElement.add(lower(node.key));
      elements.push({
        key: lower(node.key),
        name: node.key,
        targetKey: match.key,
        type: node.type,
        label: node.label || node.key
      });
    }
  }

  const rows = [];
  const addRow = (row, use) => {
    row.uses = use ? use.owners : [];
    row.written = Boolean(use && use.writers.length);
    row.typeLabel = typeLabel(row.desc);
    row.options = options
      .map((option) => ({ ...option, ...fitOf(row, option) }))
      .filter((option) => option.score > 0)
      // On a tie, the record the flow starts from before anything else.
      .sort(
        (a, b) =>
          b.score - a.score ||
          Boolean(b.global) - Boolean(a.global) ||
          a.label.localeCompare(b.label)
      );
    const best = row.options[0];
    row.suggestion = best && best.score >= SUGGEST ? best.to : undefined;
    const threshold = row.global ? RECORD_DEFAULT : DEFAULT;
    row.defaultChoice =
      best && best.score >= threshold
        ? { to: best.to }
        : { create: row.createName };
    rows.push(row);
  };

  const object = startObject(source);
  for (const [key, name, suffix] of [
    [RECORD, "$Record", "Record"],
    [PRIOR, "$Record__Prior", "PriorRecord"]
  ]) {
    const use = uses.get(key);
    if (use) {
      addRow(
        {
          key,
          name,
          kind: key === RECORD ? "record" : "prior",
          global: key,
          desc: sobject(object, { readOnly: key === PRIOR }),
          createName: uniqueName(
            `${objectBase(object)}${suffix}`,
            (candidate) => !taken(candidate)
          )
        },
        use
      );
    }
  }
  const ownName = (name) =>
    uniqueName(
      name,
      (candidate) =>
        !targetNames.has(lower(candidate)) &&
        (lower(candidate) === lower(name) || !sourceNames.has(lower(candidate)))
    );
  for (const resource of source.resources.values()) {
    const use = uses.get(lower(resource.key));
    const io =
      resource.type === "variables" &&
      (resource.fields.isInput === true || resource.fields.isOutput === true);
    if (use || io) {
      addRow(
        {
          key: lower(resource.key),
          name: resource.key,
          kind: "resource",
          resourceType: resource.type,
          desc: describeResource(resource),
          createName: ownName(resource.key)
        },
        use
      );
    }
  }
  // Which target record ID each source name is taken to be, by the rows so
  // far: recordId as $Record.Id, say.
  const ids = idsAs(rows, (row) => row.defaultChoice);
  for (const node of source.nodes.values()) {
    const use = uses.get(lower(node.key));
    if (
      use &&
      node.type === "recordLookups" &&
      node.fields.storeOutputAutomatically === true &&
      !sameElement.has(lower(node.key))
    ) {
      const desc = describeLookup(node);
      // The target records whose ID it gets: "$record.id" when its Id
      // equals $Record.Id, or an ID mapped to it.
      desc.gets = new Set(ids.has(desc.idRef) ? [ids.get(desc.idRef)] : []);
      const row = {
        key: lower(node.key),
        name: node.key,
        label: node.label || node.key,
        kind: "lookup",
        nodeKey: node.key,
        desc,
        createName: ownName(node.key)
      };
      addRow(row, use);
      // Mapping a lookup removes it, so without asking that's only done
      // when it gets the very record it's mapped to.
      const to = row.defaultChoice.to;
      if (to !== undefined && !getsSameRecord(node.fields, to, ids)) {
        row.defaultChoice = { create: row.createName };
      }
    }
  }

  // Records first: mapping them is what ties the two flows together.
  const isRecord = (row) => row.desc.dataType === "SObject";
  rows.sort((a, b) => isRecord(b) - isRecord(a));

  const plan = {
    target: { name: target.name, label: target.label || target.name },
    source: { name: source.name, label: source.label || source.name },
    roots: rows,
    elements
  };
  // One element where both do the same and lead to the same places once
  // mapped; otherwise keeping only one would lose the other flow's work or
  // strand what its paths led to.
  if (elements.length) {
    const one = Object.fromEntries(elements.map((row) => [row.key, "one"]));
    const { model } = translateFlow(
      target,
      source,
      { roots: suggestedChoices(plan).roots, elements: one },
      plan
    );
    const paths = (from, key) =>
      [...from.edges.values()]
        .filter((edge) => edge.source === key)
        .map((edge) => `${edge.slot}>${lower(edge.target)}`)
        .sort()
        .join();
    for (const row of elements) {
      row.same =
        canonical(model.nodes.get(row.targetKey).fields) ===
          canonical(target.nodes.get(row.targetKey).fields) &&
        paths(model, row.targetKey) === paths(target, row.targetKey);
      row.defaultChoice = row.same ? "one" : "both";
    }
  }
  return plan;
}

// What an element does, as text: its fields without where it sits, what
// it's called or where it leads.
function canonical(value) {
  const strip = (item) => {
    if (Array.isArray(item)) {
      return item.map(strip);
    }
    if (isPlainObject(item)) {
      const out = {};
      for (const key of Object.keys(item).sort()) {
        if (
          !/^(locationX|locationY|label)$/.test(key) &&
          !isConnector(item[key])
        ) {
          out[key] = strip(item[key]);
        }
      }
      return out;
    }
    return item;
  };
  return JSON.stringify(strip(value));
}

/**
 * The choices planMapping suggests, in the shape translateFlow takes. A
 * suggested mapping is marked suggested until someone chooses it.
 */
export function suggestedChoices(plan) {
  const roots = {};
  for (const row of plan.roots) {
    roots[row.key] =
      row.defaultChoice.to === undefined
        ? { ...row.defaultChoice }
        : { ...row.defaultChoice, suggested: true };
  }
  const elements = {};
  for (const row of plan.elements) {
    elements[row.key] = row.defaultChoice || "one";
  }
  return { roots, elements };
}

function chosen(choices, row) {
  const choice = ((choices && choices.roots) || {})[row.key];
  if (choice && typeof choice.to === "string" && choice.to.trim()) {
    return { to: choice.to.trim(), suggested: choice.suggested === true };
  }
  if (choice && typeof choice.create === "string") {
    return { create: choice.create.trim() || row.createName };
  }
  return row.defaultChoice.to === undefined
    ? row.defaultChoice
    : { ...row.defaultChoice, suggested: true };
}

const FIELD_PATH = /^\s*([^.[\s]+)([\s\S]*)$/;

// What's wrong with mapping `row` onto `to` in the target, as
// [severity, code, message], or undefined when it fits. Only the types
// decide: a name alone never makes a mapping fit.
function targetProblem(target, options, row, to, writers) {
  const find = (name) => options.find((item) => lower(item.to) === lower(name));
  const option = find(to);
  const what = `${row.name} (${row.typeLabel})`;
  const changedBy = () =>
    writers.length
      ? `${writers.slice(0, 2).join(" and ")}${writers.length > 2 ? ` and ${writers.length - 2} more` : ""} ${writers.length > 1 ? "change" : "changes"} it`
      : "it's changed";
  if (option) {
    if (row.written && option.desc.readOnly) {
      return [
        ERROR,
        "mappingReadOnly",
        `${what} is mapped to ${option.to}, which can't be changed, but ${changedBy()}. Map it to a variable, or bring it in as its own.`
      ];
    }
    if (!compatible(row.desc, option.desc, row.written)) {
      return [
        ERROR,
        "mappingType",
        `${what} is mapped to ${option.to} (${option.typeLabel}), which can't hold it.`
      ];
    }
    return undefined;
  }
  const match = FIELD_PATH.exec(to);
  const root = match ? match[1] : "";
  const path = match ? match[2].trim() : "";
  const base = find(root);
  if (!base && !nameOwners(target).has(lower(root))) {
    return [
      ERROR,
      "mappingUnresolved",
      `${what} is mapped to ${to}, which ${target.label || target.name} doesn't have.`
    ];
  }
  if (!path) {
    return [
      ERROR,
      "mappingType",
      `${what} is mapped to ${to}, which isn't a variable, record or Get Records result, so what it holds can't be checked.`
    ];
  }
  if (base) {
    const { desc } = base;
    if (
      desc.kind !== "data" ||
      desc.dataType !== "SObject" ||
      desc.collection
    ) {
      return [
        ERROR,
        "mappingType",
        `${what} is mapped to ${to}, but ${base.to} (${base.typeLabel}) has no fields.`
      ];
    }
    if (row.written && base.global === PRIOR) {
      return [
        ERROR,
        "mappingReadOnly",
        `${what} is mapped to ${to}, which can't be changed, but ${changedBy()}.`
      ];
    }
  }
  return [
    WARNING,
    "mappingUnchecked",
    `${what} is mapped to ${to}, whose type isn't checked here, so make sure it matches ${row.name}'s.`
  ];
}

// Replaces connectors into dropped elements with where those led
// (`next`: lower-case name → the new target, or "" to leave it unconnected).
function bypass(value, next) {
  const swap = (connector) => {
    const to = next.get(lower(connector.targetReference));
    return to ? { ...connector, targetReference: to } : undefined;
  };
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        isConnector(item) && next.has(lower(item.targetReference))
          ? swap(item)
          : bypass(item, next)
      )
      .filter((item) => item !== undefined);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (isConnector(item) && next.has(lower(item.targetReference))) {
        const swapped = swap(item);
        if (swapped) {
          out[key] = swapped;
        }
      } else {
        out[key] = bypass(item, next);
      }
    }
    return out;
  }
  return value;
}

// Renames the names a value defines and rewrites the names it refers to.
function rewrite(value, field, ctx, defines = true) {
  if (Array.isArray(value)) {
    const inner = defines && !(field && NOT_DEFINED.test(field));
    return value.map((item) => rewrite(item, field, ctx, inner));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        key === "name" && defines && typeof item === "string"
          ? ctx.rename(item)
          : rewrite(item, key, ctx, defines);
    }
    return out;
  }
  if (typeof value === "string") {
    const text =
      field && REFERENCE_FIELD.test(field) ? ctx.reference(value) : value;
    return text.replace(MERGE_FIELD, (whole, inner) => {
      const next = ctx.reference(inner);
      return next === inner ? whole : `{!${next}}`;
    });
  }
  return value;
}

// A screen's triggers name the screen's own actions and fields by their
// plain names (screenActionName, eventSource), not as references, so they
// follow those names when they're renamed. Anything else they name is left.
function renameScreenLocal(screen, out, ctx) {
  const own = new Set(innerNames(screen).map(lower));
  const local = (name) =>
    typeof name === "string" && own.has(lower(name)) ? ctx.rename(name) : name;
  for (const trigger of out.triggers || []) {
    if (trigger.eventSource !== undefined) {
      trigger.eventSource = local(trigger.eventSource);
    }
    for (const handler of trigger.handlers || []) {
      if (handler.screenActionName !== undefined) {
        handler.screenActionName = local(handler.screenActionName);
      }
    }
  }
}

/**
 * The flow to merge `source` into `target` from: the target with the
 * source's elements and resources added, in the target's names, as a
 * model named after the source. Returns { model, notes }, notes being
 *   mapped    [{ from, to }]         names now referring to the target's
 *   renamed   [{ from, to, kind }]   names changed to avoid a clash
 *   created   [{ name, from }]       variables made for a mapping
 *   dropped   [{ name, kind, reason }] elements and resources not brought
 *             ("mapped": the target has them; "unused": only what was
 *             dropped used them)
 *   added     keys of the source's elements, in the result's names
 *   entry     the element the source's start led to, if it's brought
 *   sourceStart  the source's trigger, which isn't: { object,
 *             triggerType, recordTriggerType } or undefined
 * and issues, shaped like validateFlow's with the mapping row's key as
 * mappingKey: a mapping onto something the target doesn't have, can't
 * hold the value or can't change is an error, so it blocks saving even
 * when the result reads as a valid flow.
 */
export function translateFlow(targetInput, sourceInput, choices, plan) {
  const target = asModel(targetInput);
  const source = asModel(sourceInput);
  const mapping = plan || planMapping(target, source);
  const notes = {
    mapped: [],
    renamed: [],
    created: [],
    dropped: [],
    added: [],
    entry: undefined,
    sourceStart: undefined
  };

  const targetNames = nameOwners(target);
  const sourceNames = nameOwners(source);
  const assigned = new Set();
  const claim = (base, own) => {
    const name = uniqueName(
      base,
      (candidate) =>
        !targetNames.has(lower(candidate)) &&
        !assigned.has(lower(candidate)) &&
        (lower(candidate) === lower(own || "") ||
          !sourceNames.has(lower(candidate)))
    );
    assigned.add(lower(name));
    return name;
  };

  const sourceNodes = new Map(
    [...source.nodes.values()].map((node) => [lower(node.key), node])
  );
  const replace = new Map();
  const renames = new Map();
  const handled = new Set();
  const dropNodes = new Map();
  const dropResources = new Set();
  const created = [];
  const rename = (from, to, kind) => {
    handled.add(lower(from));
    if (to !== from) {
      renames.set(lower(from), to);
      replace.set(lower(from), to);
      notes.renamed.push({ from, to, kind });
    }
  };

  // Elements both flows name the same: one element, or both.
  const same = new Map();
  const choiceOf = (row) =>
    (((choices && choices.elements) || {})[row.key] || row.defaultChoice) ===
    "both"
      ? "both"
      : "one";
  for (const row of mapping.elements) {
    if (choiceOf(row) === "one") {
      same.set(row.key, row.targetKey);
      rename(row.name, row.targetKey, "element");
    } else {
      rename(row.name, claim(row.name, row.name), "element");
    }
  }

  const uses = rootUses(source);
  const issues = [];
  const flag = (row, [severity, code, message]) =>
    issues.push({
      severity,
      code,
      mappingKey: row.key,
      name: row.name,
      message
    });
  const options = targetsOf(target);
  const sharing = new Map();
  // A new name as asked for, or the one used instead when it's taken.
  const claimAs = (row, want, fallback, own) => {
    if (!validName(want)) {
      flag(row, [
        ERROR,
        "mappingName",
        `"${want}" can't be the name for ${row.name}: use letters, numbers and single underscores, starting with a letter.`
      ]);
      return claim(fallback, own);
    }
    const name = claim(want, own);
    if (name !== want) {
      flag(row, [
        WARNING,
        "mappingRenamed",
        `${want} is already a name in ${target.label || target.name} (names ignore case), so ${row.name} comes in as ${name}.`
      ]);
    }
    return name;
  };
  const ids = idsAs(mapping.roots, (row) => chosen(choices, row));
  for (const row of mapping.roots) {
    let choice = chosen(choices, row);
    handled.add(row.key);
    const lookup =
      row.kind === "lookup" ? sourceNodes.get(lower(row.nodeKey)) : undefined;
    // Mapping a lookup removes its query. A suggestion never does that
    // unless the query gets the same record; someone who chose it is told.
    const dropsQuery =
      lookup &&
      choice.to !== undefined &&
      !getsSameRecord(lookup.fields, choice.to, ids);
    if (dropsQuery && choice.suggested) {
      choice = { create: row.createName };
    }
    if (choice.to !== undefined) {
      const writers = [
        ...new Set(
          (uses.get(row.key) || { writers: [] }).writers.map(
            (writer) => writer.owner
          )
        )
      ];
      const problem = targetProblem(target, options, row, choice.to, writers);
      if (problem) {
        flag(row, problem);
      } else if (dropsQuery) {
        flag(row, [
          WARNING,
          "mappingQuery",
          `${row.name} doesn't find its record only by the ID of ${choice.to}, so taking it to be ${choice.to} drops a query that could get another record. Bring it in as its own to keep the query.`
        ]);
      } else if (choice.suggested) {
        const option = row.options.find(
          (item) => lower(item.to) === lower(choice.to)
        );
        if (option && option.byName) {
          flag(row, [
            WARNING,
            "mappingAssumed",
            `${row.name} is mapped to ${option.to} only because of its name (${option.basis.charAt(0).toLowerCase()}${option.basis.slice(1)}). Check it holds the same, or choose another mapping.`
          ]);
        }
      }
      const shared = lower(choice.to);
      if (!sharing.has(shared)) {
        sharing.set(shared, { to: choice.to, rows: [] });
      }
      sharing.get(shared).rows.push(row);
      replace.set(row.key, choice.to);
      notes.mapped.push({ from: row.name, to: choice.to });
      if (row.kind === "lookup") {
        dropNodes.set(row.key, "mapped");
      } else if (row.kind === "resource") {
        dropResources.add(row.key);
        notes.dropped.push({
          name: row.name,
          kind: "resource",
          reason: "mapped"
        });
        // A Get Records that only fills the variable goes with it, when
        // it gets the very record the variable is mapped to. Otherwise it
        // stays, and fills the target's instead.
        const filled = (uses.get(row.key) || { writers: [] }).writers;
        const lookups = filled.filter((writer) => {
          const node = sourceNodes.get(lower(writer.owner));
          return (
            node &&
            node.type === "recordLookups" &&
            writer.field === "outputReference" &&
            getsSameRecord(node.fields, choice.to, ids)
          );
        });
        if (lookups.length && lookups.length === filled.length) {
          for (const writer of lookups) {
            dropNodes.set(lower(writer.owner), "mapped");
          }
        }
      }
    } else if (row.kind === "record" || row.kind === "prior") {
      const name = claimAs(row, choice.create, row.createName);
      replace.set(row.key, name);
      created.push({
        name,
        dataType: "SObject",
        objectType: row.desc.objectType,
        isCollection: false,
        isInput: true,
        isOutput: false
      });
      notes.created.push({ name, from: row.name });
    } else {
      rename(
        row.name,
        claimAs(row, choice.create, row.name, row.name),
        row.kind === "lookup" ? "element" : "resource"
      );
    }
  }
  // Names mapped onto one of the target's share it: what one stores, the
  // others see.
  for (const { to, rows } of sharing.values()) {
    const writer = rows.find((row) => row.written);
    if (rows.length > 1 && writer) {
      flag(writer, [
        WARNING,
        "mappingShared",
        `${rows.map((item) => item.name).join(" and ")} are all mapped to ${to}, and ${writer.name} is changed, so they no longer hold separate values.`
      ]);
    }
  }

  // Resources only dropped elements (or dropped resources) used.
  const dropped = (owner) =>
    dropNodes.has(lower(owner)) || dropResources.has(lower(owner));
  for (let changed = true; changed;) {
    changed = false;
    for (const resource of source.resources.values()) {
      const key = lower(resource.key);
      const use = uses.get(key);
      if (
        !dropResources.has(key) &&
        use &&
        use.owners.length &&
        use.owners.every(dropped)
      ) {
        dropResources.add(key);
        notes.dropped.push({
          name: resource.key,
          kind: "resource",
          reason: "unused"
        });
        changed = true;
      }
    }
  }

  // Everything else keeps its name unless the target has it. An unused
  // resource the target has the same kind of is the target's.
  const targetResources = new Map(
    [...target.resources.values()].map((resource) => [
      lower(resource.key),
      resource
    ])
  );
  for (const resource of source.resources.values()) {
    const key = lower(resource.key);
    if (handled.has(key) || dropResources.has(key)) {
      continue;
    }
    const match = targetResources.get(key);
    if (match && match.type === resource.type && !uses.has(key)) {
      dropResources.add(key);
      notes.dropped.push({
        name: resource.key,
        kind: "resource",
        reason: "mapped"
      });
    } else if (targetNames.has(key)) {
      rename(resource.key, claim(resource.key, resource.key), "resource");
    }
  }
  for (const node of source.nodes.values()) {
    const key = lower(node.key);
    if (node.key === START || handled.has(key) || dropNodes.has(key)) {
      continue;
    }
    if (targetNames.has(key)) {
      rename(node.key, claim(node.key, node.key), "element");
    }
  }
  // Names inside elements: an outcome or screen field the target defines
  // somewhere else is renamed.
  const insideOf = (value, owner) => {
    for (const name of innerNames(value)) {
      const key = lower(name);
      const holder = targetNames.get(key);
      if (holder && holder !== owner && !renames.has(key)) {
        rename(name, claim(name, name), "name");
      }
    }
  };
  for (const node of source.nodes.values()) {
    const key = lower(node.key);
    if (node.key !== START && !dropNodes.has(key)) {
      insideOf(node.fields, same.get(key));
    }
  }
  for (const resource of source.resources.values()) {
    if (!dropResources.has(lower(resource.key))) {
      insideOf(resource.fields, undefined);
    }
  }

  for (const [key, reason] of dropNodes) {
    const node = sourceNodes.get(key);
    notes.dropped.push({ name: node.key, kind: "element", reason });
  }

  // Connectors into dropped elements lead on to where those went.
  const next = new Map();
  const follow = (key, seen = new Set()) => {
    const node = sourceNodes.get(lower(key));
    if (!node || !dropNodes.has(lower(key))) {
      return key;
    }
    if (seen.has(lower(key))) {
      return "";
    }
    seen.add(lower(key));
    const edge = source.edges.get(`${node.key}.connector`);
    return edge ? follow(edge.target, seen) : "";
  };
  for (const key of dropNodes.keys()) {
    next.set(key, follow(key));
  }

  const ctx = {
    rename: (name) => renames.get(lower(name)) || name,
    reference: (text) => {
      const match = /^(\s*)([^.[\s]+)([\s\S]*)$/.exec(text);
      if (!match) {
        return text;
      }
      const to = replace.get(lower(match[2]));
      return to === undefined ? text : `${match[1]}${to}${match[3]}`;
    }
  };

  const metadata = toMetadata(source);
  const brought = {};
  const keyMap = new Map();
  for (const collection of NODE_COLLECTIONS) {
    if (collection === "start" || !Array.isArray(metadata[collection])) {
      continue;
    }
    for (const element of metadata[collection]) {
      const key = lower(element.name);
      if (dropNodes.has(key)) {
        continue;
      }
      const out = rewrite(bypass(element, next), undefined, ctx);
      // Node groups and their branch names are plain API names, not *Reference fields.
      if (typeof element.group === "string") {
        out.group = ctx.rename(element.group);
      }
      if (
        collection === "groups" &&
        typeof element.sourceBranchApiName === "string"
      ) {
        out.sourceBranchApiName = ctx.rename(element.sourceBranchApiName);
      }
      if (collection === "screens") {
        renameScreenLocal(element, out, ctx);
      }
      keyMap.set(element.name, out.name);
      const match = same.get(key);
      if (match) {
        const node = target.nodes.get(match);
        out.locationX = node.x;
        out.locationY = node.y;
      }
      (brought[collection] = brought[collection] || []).push(out);
    }
  }
  for (const collection of RESOURCE_COLLECTIONS) {
    for (const resource of metadata[collection] || []) {
      if (!dropResources.has(lower(resource.name))) {
        (brought[collection] = brought[collection] || []).push(
          rewrite(resource, undefined, ctx)
        );
      }
    }
  }
  for (const variable of created) {
    (brought.variables = brought.variables || []).push(variable);
  }

  // The target, with the brought elements added (an element that's one in
  // both becomes the source's version).
  const union = toMetadata(target);
  for (const [collection, items] of Object.entries(brought)) {
    const list = (union[collection] = union[collection] || []);
    for (const item of items) {
      const index = list.findIndex(
        (existing) => lower(existing.name) === lower(item.name)
      );
      if (index >= 0) {
        list[index] = item;
      } else {
        list.push(item);
      }
    }
  }

  const model = buildModel({ FullName: source.name, Metadata: union });
  Object.assign(model, {
    id: source.id,
    version: source.version,
    status: source.status,
    label: source.label
  });

  for (const node of source.nodes.values()) {
    const key = lower(node.key);
    if (node.key !== START && !dropNodes.has(key) && !same.has(key)) {
      notes.added.push(keyMap.get(node.key));
    }
  }
  placeAdded(model, target, source, keyMap, notes.added);

  const first = [...source.edges.values()].find(
    (edge) =>
      edge.source === START &&
      (edge.slot === "connector" || edge.slot === "startElementReference")
  );
  if (first) {
    const to = follow(first.target);
    const entry = to && sourceNodes.get(lower(to));
    const key = entry && keyMap.get(entry.key);
    notes.entry = key && notes.added.includes(key) ? key : undefined;
    if (to && !entry) {
      issues.push({
        severity: ERROR,
        code: "mappingEntry",
        message: `The source flow's entry leads to ${to}, which doesn't exist. Repair its start path before bringing it into this flow.`
      });
    }
  }
  const start = source.nodes.get(START);
  if (
    start &&
    !start.synthetic &&
    (start.fields.object || start.fields.triggerType)
  ) {
    notes.sourceStart = {
      object: start.fields.object,
      triggerType: start.fields.triggerType,
      recordTriggerType: start.fields.recordTriggerType
    };
  }
  return { model, notes, issues };
}

/**
 * A merge's result (resolveMerge's) with the mapping's issues first and
 * counted with its errors, so a mapping that doesn't fit blocks saving
 * like any other error.
 */
export function withMappingIssues(resolved, translation) {
  const extra = (translation && translation.issues) || [];
  if (!extra.length) {
    return resolved;
  }
  return {
    ...resolved,
    issues: [...extra, ...resolved.issues],
    errors:
      resolved.errors + extra.filter((issue) => issue.severity === ERROR).length
  };
}

// Puts the brought elements to the right of the target's on a free-form
// canvas, laid out as they were in their own flow.
function placeAdded(model, target, source, keyMap, added) {
  if (!added.length || usesAutoLayout(target)) {
    return;
  }
  const from = new Map();
  if (usesAutoLayout(source)) {
    const layout = layoutFlow(source);
    for (const node of source.nodes.values()) {
      const point = layout.nodes.get(nodeId(node));
      if (point) {
        from.set(keyMap.get(node.key), point);
      }
    }
  } else {
    for (const node of source.nodes.values()) {
      if (typeof node.x === "number" && typeof node.y === "number") {
        from.set(keyMap.get(node.key), { x: node.x, y: node.y });
      }
    }
  }
  const points = added.map((key) => from.get(key)).filter(Boolean);
  const placed = [...target.nodes.values()].filter(
    (node) => !node.synthetic && typeof node.x === "number"
  );
  if (!points.length) {
    return;
  }
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const right = placed.length
    ? Math.max(...placed.map((node) => node.x)) + 2 * NODE_WIDTH
    : 0;
  const top = placed.length ? Math.min(...placed.map((node) => node.y)) : 0;
  for (const key of added) {
    const point = from.get(key);
    const node = model.nodes.get(key);
    if (point && node) {
      node.x = Math.round(point.x - minX + right);
      node.y = Math.round(point.y - minY + top);
    }
  }
}
