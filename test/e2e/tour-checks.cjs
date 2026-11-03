// Tests the tour's reporting without opening a browser or contacting an org.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "tour.js"), "utf8");

async function run({
  pageError = false,
  startupError = false,
  stepError = false
} = {}) {
  let onError;
  let closed = false;
  const process = { argv: ["node", "tour.js", "setup"] };
  const page = {
    on: (_event, handler) => {
      onError = handler;
    },
    waitForTimeout: async () => {
      if (startupError) onError(new Error("Startup failed"));
    },
    goto: async () => {
      if (pageError) onError(new Error("Component failed"));
      if (stepError) throw new Error("Navigation failed");
    },
    screenshot: async () => {}
  };
  await vm.runInNewContext(source, {
    process,
    console: { log() {}, error() {} },
    require: (name) => {
      if (name === "path") return path;
      if (name === "fs") return { mkdirSync() {} };
      assert.equal(name, "./session");
      return {
        ORG: "https://example.invalid",
        NS: "trib__",
        DISCOUNTS: {},
        OUT: "/unused",
        open: async () => ({
          page,
          browser: {
            close: async () => {
              closed = true;
            }
          }
        })
      };
    }
  });
  assert.equal(closed, true);
  return process.exitCode;
}

test("a clean tour succeeds", async () => {
  assert.equal(await run(), 0);
});
test("an uncaught component error fails an otherwise successful step", async () => {
  assert.equal(await run({ pageError: true }), 1);
});
test("a startup page error is not cleared by the first step", async () => {
  assert.equal(await run({ startupError: true }), 1);
});
test("a rejected step still fails the tour", async () => {
  assert.equal(await run({ stepError: true }), 1);
});
