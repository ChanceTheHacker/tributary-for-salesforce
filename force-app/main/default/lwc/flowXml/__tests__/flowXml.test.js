import { toXml, fromXml, typeFields, XmlError } from "c/flowXml";
import { normalize } from "c/flowModel";

const fs = require("fs");
const path = require("path");
const root = path.join(process.cwd(), "test/fixtures/flows");
const records = fs
  .readdirSync(root)
  .flatMap((flow) =>
    fs
      .readdirSync(path.join(root, flow))
      .map((file) => [
        `${flow}/${file}`,
        require(`fixtures/flows/${flow}/${file}`)
      ])
  );
const retrieved = (name) =>
  fs.readFileSync(
    path.join(process.cwd(), `test/fixtures/xml/${name}.flow-meta.xml`),
    "utf8"
  );

describe("typeFields", () => {
  it("lists inherited fields first, in XML order", () => {
    const names = typeFields("FlowDecision").map((field) => field.name);
    expect(names.indexOf("name")).toBeLessThan(names.indexOf("label"));
    expect(names.indexOf("locationY")).toBeLessThan(names.indexOf("rules"));
    expect(typeFields("FlowDecision").find((f) => f.name === "rules")).toEqual({
      name: "rules",
      type: "FlowRule",
      many: true
    });
  });

  it("lists a field a type redeclares only once", () => {
    for (const type of ["FlowCustomError", "FlowDecision", "Flow"]) {
      const names = typeFields(type).map((field) => field.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe("toXml", () => {
  it("writes the same lines as a retrieve, whatever the list order", () => {
    // The retrieve returned the latest version (4) with the definition's
    // status. It also sorts the record update's assignments, which the
    // Tooling API keeps in the order they were added.
    const record = require("fixtures/flows/Case_Email_Routing/v4.json");
    const lines = (text) =>
      text
        .replace(/cllc__/g, "")
        .split("\n")
        .filter((line) => !line.includes("<status>"))
        .sort();
    const { text } = toXml(normalize(record.Metadata));
    expect(lines(text)).toEqual(lines(retrieved("Case_Email_Routing")));
  });

  it.each([
    ["Analyze_Flows", "Analyze_Flows/v1.json"],
    ["Case_Routing_Template_Creation", "Case_Routing_Template_Creation/v1.json"]
  ])("matches the retrieved %s", (name, fixture) => {
    const record = require(`fixtures/flows/${fixture}`);
    const { text } = toXml(normalize(record.Metadata));
    expect(text.replace(/cllc__/g, "")).toEqual(
      retrieved(name).replace(/cllc__/g, "")
    );
  });

  it("records the lines of each element and resource", () => {
    const record = require("fixtures/flows/Case_Email_Routing/v4.json");
    const { lines, ranges } = toXml(normalize(record.Metadata));
    const range = ranges.get("decisions:Was_a_match_found");
    expect(lines[range.start].trim()).toBe("<decisions>");
    expect(lines[range.start + 1].trim()).toBe(
      "<name>Was_a_match_found</name>"
    );
    expect(lines[range.end].trim()).toBe("</decisions>");
    expect(ranges.has("start:$Start")).toBe(true);
  });

  it("gives a value with line breaks a line per line", () => {
    const metadata = {
      label: "Lines",
      textTemplates: [
        {
          name: "Body",
          text: "Dear {!Name},\n\nThanks & bye\n",
          isViewedAsPlainText: true
        }
      ],
      variables: [{ name: "Name", dataType: "String" }]
    };
    const { text, lines, ranges } = toXml(metadata);
    expect(lines.join("\n") + "\n").toBe(text);
    expect(text).toContain(
      "        <text>Dear {!Name},\n\nThanks &amp; bye\n</text>\n"
    );
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
    // The template's block ends on its own closing line; the variable's
    // starts after it.
    const body = ranges.get("textTemplates:Body");
    expect(lines.slice(body.start, body.end + 1)).toEqual([
      "    <textTemplates>",
      "        <name>Body</name>",
      "        <isViewedAsPlainText>true</isViewedAsPlainText>",
      "        <text>Dear {!Name},",
      "",
      "Thanks &amp; bye",
      "</text>",
      "    </textTemplates>"
    ]);
    expect(ranges.get("variables:Name").start).toBe(body.end + 1);
    expect(normalize(fromXml(text))).toEqual(normalize(metadata));
  });

  it("writes a custom error's description once", () => {
    const { text } = toXml({
      customErrors: [{ name: "Stop", description: "Why", label: "Stop" }]
    });
    expect(text.match(/<description>Why<\/description>/g)).toHaveLength(1);
  });

  it("escapes text and writes whole doubles with a decimal point", () => {
    const { text } = toXml({
      apiVersion: 61,
      description: 'a < b & "c"',
      label: "x"
    });
    expect(text).toContain("<apiVersion>61.0</apiVersion>");
    expect(text).toContain(
      "<description>a &lt; b &amp; &quot;c&quot;</description>"
    );
  });
});

describe("fromXml", () => {
  it.each(records)("reads back %s", (name, record) => {
    const metadata = normalize(record.Metadata);
    expect(normalize(fromXml(toXml(metadata).text))).toEqual(metadata);
  });

  it("reads retrieved files into the Tooling API shape", () => {
    const metadata = fromXml(retrieved("Case_Email_Routing"));
    expect(Array.isArray(metadata.decisions)).toBe(true);
    expect(metadata.decisions[0].rules[0].conditions[0]).toMatchObject({
      operator: expect.any(String)
    });
    expect(metadata.apiVersion).toBe(61);
    expect(metadata.areMetricsLoggedToDataCloud).toBe(false);
    expect(metadata.start.locationX).toBe(526);
  });

  it("reports malformed XML with a line number", () => {
    expect(() => fromXml("<Flow>\n<label>x</name>\n</Flow>")).toThrow(XmlError);
    expect(() => fromXml("<Flow>\n<label>x</name>\n</Flow>")).toThrow(/Line 2/);
    expect(() => fromXml("<Flow><apiVersion>abc</apiVersion></Flow>")).toThrow(
      /number/
    );
    expect(() => fromXml("<Flow><label>x</label>")).toThrow(/Unclosed/);
  });
});

describe("XML editing preserves text and rejects lossy input", () => {
  it("keeps ordinary text and CDATA in their original order", () => {
    expect(
      fromXml(
        "<Flow><description>Before &amp; <![CDATA[<middle>]]> after <![CDATA[&end]]>.</description></Flow>"
      ).description
    ).toBe("Before & <middle> after &end.");
  });

  it.each([
    '<Flow><label ignored="data">value</label></Flow>',
    '<Flow><label ignored="a>b">value</label></Flow>',
    '<Flow xmlns="not-metadata"><label>value</label></Flow>',
    "<Flow><label garbage>value</label></Flow>",
    '<Flow><label xsi:nil="true"/></Flow>',
    "text<Flow/>",
    "<Flow/>text",
    "<Flow><label>one<unexpected>two</unexpected></label></Flow>",
    "<Flow><start>not an object</start></Flow>",
    "<Flow><label>&unclosed</label></Flow>",
    "<Flow><label>&constructor;</label></Flow>",
    "<Flow><apiVersion>Infinity</apiVersion></Flow>",
    "<Flow><start><locationX>1.5</locationX></start></Flow>"
  ])("rejects malformed or incorrectly typed XML: %s", (xml) => {
    expect(() => fromXml(xml)).toThrow(XmlError);
  });

  // An XML parser that follows the standard, to check both directions against.
  const standard = (xml, field) =>
    new DOMParser()
      .parseFromString(xml, "application/xml")
      .getElementsByTagName(field)[0].textContent;

  it("writes a carriage return so a standard parser reads it back", () => {
    const metadata = {
      label: "Returns",
      textTemplates: [{ name: "Body", text: "A\rB\r\nC" }]
    };
    const { text } = toXml(metadata);
    expect(text).not.toContain("\r");
    expect(text).toContain("<text>A&#13;B&#13;");
    expect(standard(text, "text")).toBe("A\rB\r\nC");
    expect(fromXml(text)).toEqual(metadata);
  });

  it("reads raw line ends as a standard parser does", () => {
    const xml =
      '<?xml version="1.0"?>\r\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\r\n' +
      "<description>A\r\nB\rC&#13;D</description>\r\n</Flow>\r\n";
    expect(standard(xml, "description")).toBe("A\nB\nC\rD");
    expect(fromXml(xml).description).toBe("A\nB\nC\rD");
  });

  it("preserves unknown fields even when their names are object properties", () => {
    const parsed = fromXml(
      "<Flow><constructor>x</constructor><__proto__>y</__proto__></Flow>"
    );
    expect(Object.keys(parsed)).toEqual(["constructor", "__proto__"]);
    expect(JSON.stringify(parsed)).toBe('{"constructor":"x","__proto__":"y"}');
  });
});
