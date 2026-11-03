/**
 * Writes flow metadata as the XML the Metadata API produces (the form teams
 * keep in version control), and reads that XML back into the JSON shape the
 * Tooling API uses.
 *
 * Field order and types come from the generated schema in c/flowSchema, so
 * the text matches a retrieved .flow-meta.xml file line for line. Fields the
 * schema doesn't know (newer than the schema) are written after the known
 * ones, in alphabetical order.
 */
import { TYPES } from "c/flowSchema";
import { NODE_COLLECTIONS, RESOURCE_COLLECTIONS, START } from "c/flowModel";

const NAMESPACE = "http://soap.sforce.com/2006/04/metadata";
const INDENT = "    ";

const parsedTypes = new Map();

/** Fields of a schema type as [{ name, type, many }], in XML order. */
export function typeFields(type) {
  if (!TYPES[type]) {
    return undefined;
  }
  if (!parsedTypes.has(type)) {
    parsedTypes.set(
      type,
      TYPES[type].split(",").map((spec) => {
        const [name, rawType] = spec.split(":");
        const many = rawType.endsWith("*");
        return { name, type: many ? rawType.slice(0, -1) : rawType, many };
      })
    );
  }
  return parsedTypes.get(type);
}

function fieldMap(type) {
  const fields = typeFields(type);
  return fields ? new Map(fields.map((field) => [field.name, field])) : null;
}

const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
  // An XML parser reads a raw carriage return as a line feed, so one in the
  // value is written as a reference to survive the round trip.
  "\r": "&#13;"
};

export function escapeXml(text) {
  return String(text).replace(/[&<>"'\r]/g, (ch) => ESCAPES[ch]);
}

function formatScalar(value, type) {
  if (
    type === "double" &&
    typeof value === "number" &&
    Number.isInteger(value)
  ) {
    return value.toFixed(1);
  }
  return String(value);
}

function orderedEntries(value, type) {
  const known = typeFields(type) || [];
  const entries = [];
  const seen = new Set();
  for (const field of known) {
    if (seen.has(field.name)) {
      continue;
    }
    seen.add(field.name);
    if (value[field.name] !== undefined && value[field.name] !== null) {
      entries.push([field.name, value[field.name], field.type]);
    }
  }
  for (const key of Object.keys(value).sort()) {
    if (!seen.has(key) && value[key] !== undefined && value[key] !== null) {
      entries.push([key, value[key], undefined]);
    }
  }
  return entries;
}

// Key of a top-level collection item, as used by flowModel and flowDiff.
function itemKey(collection, item) {
  if (collection === "start") {
    return `start:${START}`;
  }
  return `${collection}:${item && item.name}`;
}

/**
 * Serializes flow metadata (Tooling API JSON) to Metadata API XML.
 *
 * Returns { text, lines, ranges }: lines are the text's lines, and ranges
 * maps each canvas element and resource ("decisions:Check",
 * "variables:recordId", "start:$Start") to the first and last line (0-based,
 * inclusive) of its block.
 */
export function toXml(metadata) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const ranges = new Map();
  lines.push(`<Flow xmlns="${NAMESPACE}">`);

  const write = (name, value, type, depth) => {
    const pad = INDENT.repeat(depth);
    if (Array.isArray(value)) {
      for (const item of value) {
        write(name, item, type, depth);
      }
      return;
    }
    if (value !== null && typeof value === "object") {
      const entries = orderedEntries(value, type);
      if (!entries.length) {
        lines.push(`${pad}<${name}/>`);
        return;
      }
      lines.push(`${pad}<${name}>`);
      for (const [key, item, itemType] of entries) {
        write(key, item, itemType, depth + 1);
      }
      lines.push(`${pad}</${name}>`);
      return;
    }
    // A value with line breaks (a formula, a text template) takes a line
    // per line, as in the file, so line numbers, ranges and line merges
    // match what's exported.
    const text = escapeXml(formatScalar(value, type));
    lines.push(...`${pad}<${name}>${text}</${name}>`.split("\n"));
  };

  for (const [name, value, type] of orderedEntries(metadata || {}, "Flow")) {
    if (name === "fullName") {
      continue;
    }
    const tracked =
      NODE_COLLECTIONS.includes(name) || RESOURCE_COLLECTIONS.includes(name);
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const start = lines.length;
      write(name, item, type, 1);
      if (tracked) {
        ranges.set(itemKey(name, item), { start, end: lines.length - 1 });
      }
    }
  }
  lines.push("</Flow>");
  return { text: lines.join("\n") + "\n", lines, ranges };
}

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'"
};

export class XmlError extends Error {
  constructor(message, line) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = "XmlError";
    this.line = line;
  }
}

function decode(text) {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][\w]*);|&/g,
    (match, entity) => {
      if (!entity) {
        throw new XmlError("An ampersand must be escaped as &amp;");
      }
      if (entity[0] === "#") {
        const code =
          entity[1] === "x"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        if (!(
          code === 9 ||
          code === 10 ||
          code === 13 ||
          (code >= 0x20 && code <= 0xd7ff) ||
          (code >= 0xe000 && code <= 0xfffd) ||
          (code >= 0x10000 && code <= 0x10ffff)
        )) {
          throw new XmlError(`Invalid character reference ${match}`);
        }
        return String.fromCodePoint(code);
      }
      if (Object.prototype.hasOwnProperty.call(ENTITIES, entity)) {
        return ENTITIES[entity];
      }
      throw new XmlError(`Unknown entity ${match}`);
    }
  );
}

/** Parses XML into a tree of { name, children, text, line }. */
function parseTree(xml) {
  // Line ends are normalized first, as XML requires: CRLF and a lone CR
  // read as LF. A carriage return in a value comes as &#13;.
  const text = xml.replace(/\r\n?/g, "\n");
  const root = { name: "#root", children: [], text: "" };
  const stack = [root];
  const newlines = [];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    newlines.push(i);
  }
  // 1-based line of a character offset.
  const lineAt = (index) => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (newlines[mid] < index) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low + 1;
  };
  const find = (token, from, what) => {
    const index = text.indexOf(token, from);
    if (index === -1) {
      throw new XmlError(`Unclosed ${what}`, lineAt(from));
    }
    return index;
  };
  let pos = 0;
  while (pos < text.length) {
    const top = stack[stack.length - 1];
    const lt = text.indexOf("<", pos);
    if (lt === -1) {
      top.text += decode(text.slice(pos));
      break;
    }
    top.text += decode(text.slice(pos, lt));
    if (text.startsWith("<?", lt)) {
      pos = find("?>", lt, "declaration") + 2;
    } else if (text.startsWith("<!--", lt)) {
      pos = find("-->", lt, "comment") + 3;
    } else if (text.startsWith("<![CDATA[", lt)) {
      const end = find("]]>", lt, "CDATA section");
      top.text += text.slice(lt + 9, end);
      pos = end + 3;
    } else {
      const gt = find(">", lt, "tag");
      const tag = text.slice(lt + 1, gt).trim();
      if (tag.startsWith("/")) {
        const name = tag.slice(1).trim();
        if (stack.length === 1 || top.name !== name) {
          throw new XmlError(
            stack.length === 1
              ? `Unexpected </${name}>`
              : `Expected </${top.name}> but found </${name}>`,
            lineAt(lt)
          );
        }
        stack.pop();
      } else {
        const selfClosing = tag.endsWith("/");
        const content = selfClosing ? tag.slice(0, -1).trimEnd() : tag;
        const match = /^([A-Za-z_][\w.-]*)([\s\S]*)$/.exec(content);
        if (!match) {
          throw new XmlError(`Invalid tag <${tag}>`, lineAt(lt));
        }
        const [, name, attributes] = match;
        if (attributes.trim()) {
          const namespace = /^\s+xmlns\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$/.exec(
            attributes
          );
          if (
            stack.length !== 1 ||
            name !== "Flow" ||
            !namespace ||
            decode(namespace[1] ?? namespace[2]) !== NAMESPACE
          ) {
            throw new XmlError(
              "Only the Flow metadata namespace attribute is supported; other attributes cannot be preserved",
              lineAt(lt)
            );
          }
        }
        const node = { name, children: [], text: "", line: lineAt(lt) };
        top.children.push(node);
        if (!selfClosing) {
          stack.push(node);
        }
      }
      pos = gt + 1;
    }
  }
  if (stack.length !== 1) {
    throw new XmlError(`Unclosed <${stack[stack.length - 1].name}>`);
  }
  return root;
}

function parseScalar(raw, type, line) {
  if (type === "boolean") {
    if (raw !== "true" && raw !== "false") {
      throw new XmlError(`Expected true or false, found "${raw}"`, line);
    }
    return raw === "true";
  }
  if (type === "int" || type === "long" || type === "double") {
    const number = Number(raw);
    const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
      raw.trim()
    );
    const whole = type === "double" || Number.isSafeInteger(number);
    if (!numeric || !Number.isFinite(number) || !whole) {
      throw new XmlError(`Expected a number, found "${raw}"`, line);
    }
    return number;
  }
  return raw;
}

function toJson(node, type) {
  const fields = fieldMap(type);
  if (!node.children.length) {
    const raw = node.text;
    if (fields) {
      // An empty complex element, e.g. <connector/>; never silently drop text.
      if (raw.trim()) {
        throw new XmlError(
          `<${node.name}> needs child elements, not text`,
          node.line
        );
      }
      return {};
    }
    return parseScalar(raw, type, node.line);
  }
  if ((type && !fields) || node.text.trim()) {
    throw new XmlError(
      `<${node.name}> mixes text and child elements`,
      node.line
    );
  }
  // Unknown metadata fields must not read or replace Object.prototype.
  const out = Object.create(null);
  for (const child of node.children) {
    const field = fields && fields.get(child.name);
    const childType = field ? field.type : undefined;
    const value = toJson(child, childType);
    const many = field
      ? field.many
      : Array.isArray(out[child.name]) || out[child.name] !== undefined;
    if (many) {
      if (out[child.name] === undefined) {
        out[child.name] = [];
      } else if (!Array.isArray(out[child.name])) {
        out[child.name] = [out[child.name]];
      }
      out[child.name].push(value);
    } else if (out[child.name] !== undefined) {
      throw new XmlError(`<${child.name}> appears more than once`, child.line);
    } else {
      out[child.name] = value;
    }
  }
  return out;
}

/** Parses Metadata API flow XML into Tooling API JSON. */
export function fromXml(text) {
  const tree = parseTree(text);
  if (tree.text.trim()) {
    throw new XmlError("Text is not allowed outside the <Flow> element");
  }
  const flow = tree.children.find((node) => node.name === "Flow");
  if (!flow) {
    throw new XmlError("The document has no <Flow> element");
  }
  if (tree.children.length !== 1) {
    throw new XmlError("The document has more than one root element");
  }
  return toJson(flow, "Flow");
}
