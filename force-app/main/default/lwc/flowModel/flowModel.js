/**
 * Reads flow metadata into a graph the canvas and the diff can share: the
 * elements drawn on the canvas (nodes), the connectors between them (edges),
 * the resources in the side panel, and the flow-level properties.
 *
 * Input is a Tooling API Flow record ({ FullName, VersionNumber, Status,
 * Metadata }) or the bare Metadata object. Everything is normalized first:
 * the Tooling API returns every unset field as null or [], and those carry no
 * meaning, so they are dropped and object keys are sorted. Two normalized
 * values are equal exactly when their JSON is equal.
 */

// Flow fields holding FlowNode subtypes: the elements drawn on the canvas.
export const NODE_COLLECTIONS = Object.freeze([
  "actionCalls",
  "apexPluginCalls",
  "assignments",
  "collectionProcessors",
  "customErrors",
  "decisions",
  "experiments",
  "groups",
  "loops",
  "orchestratedStages",
  "recordCreates",
  "recordDeletes",
  "recordLookups",
  "recordRollbacks",
  "recordUpdates",
  "screens",
  "start",
  "steps",
  "subflows",
  "transforms",
  "waits"
]);

// Flow fields holding named elements that aren't drawn: the resources.
export const RESOURCE_COLLECTIONS = Object.freeze([
  "choices",
  "collectionFilterCriteria",
  "constants",
  "customProperties",
  "dynamicChoiceSets",
  "exitRules",
  "formulas",
  "stages",
  "textTemplates",
  "variables"
]);

// The start element has no name in metadata. `$` can't appear in an API name,
// so this key never collides with a real element.
export const START = "$Start";

// Connector fields that sit directly on an element, by the kind of path they draw.
const CONNECTOR_KINDS = Object.freeze({
  connector: "next",
  // A legacy step lists its connectors.
  connectors: "next",
  defaultConnector: "default",
  faultConnector: "fault",
  nextValueConnector: "loopNext",
  noMoreValuesConnector: "loopEnd"
});

// Connectors inside a list (decision outcomes, scheduled paths, wait events,
// experiment paths) take their kind from the list.
const LIST_CONNECTOR_KINDS = Object.freeze({
  rules: "outcome",
  scheduledPaths: "scheduledPath",
  waitEvents: "waitEvent",
  paths: "experimentPath"
});

// Order of an element's paths on the canvas: the main path first, fault path
// last. Normalized keys are alphabetical, which would put a decision's default
// outcome before its rules.
const PATH_ORDER = Object.freeze({
  connector: 0,
  nextValueConnector: 1,
  noMoreValuesConnector: 3,
  defaultConnector: 4,
  faultConnector: 5
});
const LIST_PATH_ORDER = 2;

const LOCATION_FIELDS = new Set(["locationX", "locationY"]);

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Drops null, undefined, empty arrays and empty objects (recursively) and
 * sorts object keys. Returns undefined when nothing is left.
 */
export function normalize(value) {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map(normalize).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (isPlainObject(value)) {
    const out = {};
    let empty = true;
    for (const key of Object.keys(value).sort()) {
      const item = normalize(value[key]);
      if (item !== undefined) {
        out[key] = item;
        empty = false;
      }
    }
    return empty ? undefined : out;
  }
  return value;
}

export function isConnector(value) {
  return isPlainObject(value) && typeof value.targetReference === "string";
}

/** Copies a value with every connector object removed from it. */
function withoutConnectors(value) {
  if (Array.isArray(value)) {
    return normalize(
      value.filter((item) => !isConnector(item)).map(withoutConnectors)
    );
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (!isConnector(item)) {
        out[key] = withoutConnectors(item);
      }
    }
    return normalize(out);
  }
  return value;
}

// Fields that name an item within its list. Most items have a name; an
// action's paths go by pathName, and a record's field values by field.
export const ITEM_KEYS = Object.freeze(["name", "pathName", "field"]);

/** An item's name within its list, or undefined when it has none. */
export function itemKey(item) {
  if (!isPlainObject(item)) {
    return undefined;
  }
  const key = ITEM_KEYS.find((field) => typeof item[field] === "string");
  return key && item[key];
}

/**
 * The item a path segment names in a list, as segmentFor made it: the item
 * of that name, else the unnamed item at that index. A position never finds
 * a named item, so a slot saved before its list was keyed by name finds
 * nothing rather than whatever is now in that place.
 */
export function itemAt(list, segment) {
  const named = list.find((item) => itemKey(item) === segment);
  if (named || !/^\d+$/.test(segment)) {
    return named;
  }
  const item = list[Number(segment)];
  return itemKey(item) === undefined ? item : undefined;
}

/** An array item's identity within its list: its name if it has one, else its index. */
function segmentFor(item, index) {
  const key = itemKey(item);
  return key === undefined ? index : key;
}

function pathOrder([key]) {
  return key in PATH_ORDER ? PATH_ORDER[key] : LIST_PATH_ORDER;
}

/**
 * Finds every connector in an element, however deeply nested, so element
 * types added in later API versions are still wired up. They come back in
 * canvas order (see PATH_ORDER).
 */
function findConnectors(element) {
  const found = [];
  const walk = (value, path, listItem, listName) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (isConnector(item)) {
          // A list of connectors, like a legacy step's.
          found.push({
            path: [...path, index],
            field: path[path.length - 1],
            connector: item,
            listItem,
            listName
          });
        } else {
          walk(
            item,
            [...path, segmentFor(item, index)],
            item,
            path[path.length - 1]
          );
        }
      });
      return;
    }
    if (!isPlainObject(value)) {
      return;
    }
    const entries = Object.entries(value).sort(
      (a, b) => pathOrder(a) - pathOrder(b)
    );
    for (const [key, item] of entries) {
      if (isConnector(item)) {
        found.push({
          path: [...path, key],
          field: key,
          connector: item,
          listItem,
          listName
        });
      } else if (item !== null && typeof item === "object") {
        walk(item, [...path, key], listItem, listName);
      }
    }
  };
  walk(element, [], undefined, undefined);
  return found;
}

function edgeFor(source, element, found) {
  const { path, field, connector, listItem, listName } = found;
  // Anything else on the connector (rare: isGoTo=false, metadata values) is
  // kept so the element can be written back exactly.
  const { targetReference, isGoTo, ...extra } = connector;
  let kind = CONNECTOR_KINDS[field] || field;
  let label;
  if (listItem && field === "connector") {
    kind = LIST_CONNECTOR_KINDS[listName] || listName;
    label = listItem.label;
  } else if (field === "defaultConnector") {
    label = element.defaultConnectorLabel;
  }
  const slot = path.join(".");
  return {
    key: `${source}.${slot}`,
    source,
    target: targetReference,
    slot,
    kind,
    label,
    isGoTo: isGoTo === true,
    ...(isGoTo === false || Object.keys(extra).length
      ? { extra: { ...extra, ...(isGoTo === false ? { isGoTo } : {}) } }
      : {})
  };
}

function metadataValue(metadataValues, name) {
  const entry = (metadataValues || []).find((item) => item.name === name);
  return entry && entry.value ? entry.value.stringValue : undefined;
}

/**
 * Builds the graph for one flow version.
 *
 * nodes and resources are Maps in metadata order, and edges are grouped by
 * element in canvas order; props holds every
 * other flow field except status; duplicates lists names defined more than
 * once, as [{ name, type, earlier }]. Node and resource `fields` exclude the name, the canvas
 * position and all connectors, which are modelled separately.
 */
export function buildModel(input) {
  const record = input && input.Metadata ? input : { Metadata: input };
  const metadata = normalize(record.Metadata) || {};

  const nodes = new Map();
  const edges = new Map();
  const resources = new Map();
  const props = {};
  // Elements and resources are filed by name, so a name defined twice
  // (hand-edited XML can do it) keeps only its last definition. Each
  // repeat is noted here, for validateFlow to report: Salesforce rejects it.
  const duplicates = [];
  const define = (map, key, item) => {
    const earlier = map.get(key);
    if (earlier) {
      duplicates.push({ name: key, type: item.type, earlier: earlier.type });
    }
    map.set(key, item);
  };

  const addNode = (type, element, key) => {
    const fields = {};
    for (const [field, value] of Object.entries(element)) {
      if (field !== "name" && !LOCATION_FIELDS.has(field)) {
        fields[field] = value;
      }
    }
    define(nodes, key, {
      key,
      name: key,
      type,
      label: element.label,
      subtype: element.elementSubtype,
      group: element.group,
      x: element.locationX,
      y: element.locationY,
      fields: withoutConnectors(fields) || {}
    });
    for (const found of findConnectors(element)) {
      const edge = edgeFor(key, element, found);
      edges.set(edge.key, edge);
    }
  };

  for (const [field, value] of Object.entries(metadata)) {
    if (field === "start") {
      addNode("start", value, START);
    } else if (NODE_COLLECTIONS.includes(field)) {
      for (const element of value) {
        addNode(field, element, element.name);
      }
    } else if (RESOURCE_COLLECTIONS.includes(field)) {
      for (const element of value) {
        const { name, ...fields } = element;
        define(resources, name, { key: name, name, type: field, fields });
      }
    } else if (field !== "status") {
      // Status is the version's lifecycle (Draft, Active, Obsolete), not
      // part of its logic, and is kept apart from the other properties.
      props[field] = value;
    }
  }

  // Older flows (and some system flows) have no start element, only a
  // reference to the first element. Give them a start node so the canvas
  // and the diff treat every flow the same way.
  if (!nodes.has(START) && metadata.startElementReference) {
    nodes.set(START, {
      key: START,
      name: START,
      type: "start",
      synthetic: true,
      fields: {}
    });
    const edge = {
      key: `${START}.startElementReference`,
      source: START,
      target: metadata.startElementReference,
      slot: "startElementReference",
      kind: "next",
      isGoTo: false
    };
    edges.set(edge.key, edge);
  }

  const fullName = record.FullName || metadata.fullName;
  return {
    id: record.Id,
    // Tooling FullNames of older versions end in "-<version>".
    name: fullName ? fullName.replace(/-\d+$/, "") : undefined,
    label: metadata.label,
    version: record.VersionNumber,
    status: record.Status || metadata.status,
    processType: metadata.processType,
    canvasMode: metadataValue(metadata.processMetadataValues, "CanvasMode"),
    nodes,
    edges,
    resources,
    props,
    duplicates
  };
}

export function isModel(value) {
  return (
    isPlainObject(value) &&
    value.nodes instanceof Map &&
    value.edges instanceof Map
  );
}

/** Edges leaving a node, main path first. */
export function outgoing(model, nodeKey) {
  return [...model.edges.values()].filter((edge) => edge.source === nodeKey);
}

/** Edges arriving at a node. */
export function incoming(model, nodeKey) {
  return [...model.edges.values()].filter((edge) => edge.target === nodeKey);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Puts a connector back at its slot, e.g. "rules.Match_Found.connector".
// List items are found by name (see itemAt).
function setConnector(element, edge) {
  const segments = edge.slot.split(".");
  const isIndex = (segment) => /^\d+$/.test(segment);
  let current = element;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    let next;
    if (Array.isArray(current)) {
      next = itemAt(current, segment);
    } else {
      if (
        !isPlainObject(current[segment]) &&
        !Array.isArray(current[segment])
      ) {
        // Only a container that holds the connector itself is made here;
        // a missing list item means the connector has nowhere to go.
        current[segment] = isIndex(segments[i + 1]) ? [] : {};
      }
      next = current[segment];
    }
    if (!next) {
      return false;
    }
    current = next;
  }
  current[segments[segments.length - 1]] = {
    ...(edge.extra || {}),
    ...(edge.isGoTo ? { isGoTo: true } : {}),
    targetReference: edge.target
  };
  return true;
}

/**
 * Writes a model back out as flow metadata (normalized Tooling API JSON). For
 * a model from buildModel this gives back the metadata it was read from,
 * except the version status. Merged models are saved through this.
 */
export function toMetadata(model) {
  const out = clone(model.props) || {};
  const collections = {};
  const bySource = new Map();
  for (const edge of model.edges.values()) {
    if (!bySource.has(edge.source)) {
      bySource.set(edge.source, []);
    }
    bySource.get(edge.source).push(edge);
  }

  delete out.startElementReference;
  for (const node of model.nodes.values()) {
    const edges = bySource.get(node.key) || [];
    if (node.synthetic) {
      const first = edges.find((edge) => edge.slot === "startElementReference");
      if (first) {
        out.startElementReference = first.target;
      }
      continue;
    }
    const element = clone(node.fields) || {};
    if (node.type !== "start") {
      element.name = node.key;
    }
    if (node.x !== undefined) {
      element.locationX = node.x;
    }
    if (node.y !== undefined) {
      element.locationY = node.y;
    }
    for (const edge of edges) {
      setConnector(element, edge);
    }
    if (node.type === "start") {
      out.start = element;
    } else {
      (collections[node.type] = collections[node.type] || []).push(element);
    }
  }
  for (const resource of model.resources.values()) {
    (collections[resource.type] = collections[resource.type] || []).push({
      name: resource.key,
      ...clone(resource.fields)
    });
  }
  if (
    model.props.startElementReference &&
    !out.startElementReference &&
    !model.nodes.has(START)
  ) {
    out.startElementReference = model.props.startElementReference;
  }
  return normalize({ ...out, ...collections }) || {};
}
