const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Run the real server's guards without Salesforce, a browser, or a listener.
function load(names) {
  const sandbox = {
    module: { exports: {} },
    process: {
      env: names === undefined ? {} : { UAT_PROTECTED_NAMES: names }
    },
    require(name) {
      if (name === "./session") {
        return { ORG: "https://example.test", CHROMIUM: "/test/chromium" };
      }
      if (name === "playwright-core") {
        return { chromium: { launch: () => new Promise(() => {}) } };
      }
      if (["http", "fs", "path", "child_process"].includes(name)) return {};
      throw new Error(`Unexpected dependency: ${name}`);
    }
  };
  const source = fs.readFileSync(path.join(__dirname, "uat-server.js"), "utf8");
  vm.runInNewContext(
    `${source}\nmodule.exports = { guardChange, commands, PEOPLE, REAL };`,
    sandbox
  );
  return sandbox.module.exports;
}

function screen(text) {
  const loc = {
    filter: () => loc,
    first: () => loc,
    waitFor: async () => {},
    evaluate: async () => text
  };
  return { page: { locator: () => loc } };
}

test("missing or empty protected names stop the server", () => {
  for (const names of [undefined, "", " , , "]) {
    assert.throws(() => load(names), /UAT_PROTECTED_NAMES/);
  }
});

test("configured names block person selection and changes on that screen", async () => {
  const { guardChange } = load("Example Person,Example Surname");
  await assert.rejects(guardChange({}, "EXAMPLE PERSON"), /BLOCKED/);
  await assert.rejects(
    guardChange(screen("Owner: Example Surname"), "Save"),
    /BLOCKED/
  );
});

test("configured names cannot be filled or typed", async () => {
  const { commands } = load("Example Person");
  await assert.rejects(
    commands.fill({}, ["input", "Example Person"]),
    /BLOCKED/
  );
  await assert.rejects(commands.type({}, ["Example", "Person"]), /BLOCKED/);
});

test("name configuration is literal, trimmed and case insensitive", () => {
  const { PEOPLE } = load(" Example (Person), ,Example.Name ");
  assert.equal(PEOPLE.test("example (person)"), true);
  assert.equal(PEOPLE.test("Example.Name"), true);
  assert.equal(PEOPLE.test("ExampleXName"), false);
  assert.equal(PEOPLE.test("Example Person"), false);
  assert.equal(PEOPLE.test(""), false);
});

test("existing flow protection and safe actions are preserved", async () => {
  const { guardChange } = load("Example Person");
  await assert.rejects(
    guardChange(screen("Case Email Routing"), "Save"),
    /BLOCKED/
  );
  await guardChange(screen("UAT_Discounts_A"), "Save");
  await guardChange(screen("Example Person"), "Compare");
});
