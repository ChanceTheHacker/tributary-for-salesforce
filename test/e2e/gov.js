// Governance end to end on the demo flow. Never logs URLs or tokens.
// Exits non-zero when a step fails its checks or the page throws.
const { execFileSync } = require("child_process");
const { open, ALIAS, ORG, NS, OTHER, OUT } = require("./session");
const FLOW = "Flow_Compare_Demo";
const API = `${ORG}/services/data/v67.0`;
const compare = (q) =>
  `${ORG}/lightning/n/${NS}Flow_Compare?c__flow=${FLOW}&${q}`;

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sf(args) {
  const out = execFileSync("sf", [...args, "--target-org", ALIAS, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return JSON.parse(out.slice(out.indexOf("{"))).result;
}

// The REST API as the CLI's user; the token stays in this process.
let token;
async function rest(path, init = {}) {
  token = token || sf(["org", "auth", "show-access-token"]).accessToken;
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });
  const text = await response.text();
  check(response.ok, `${path.split("?")[0]} answered ${response.status}`);
  return text ? JSON.parse(text) : undefined;
}

async function definition() {
  const query = encodeURIComponent(
    `SELECT Id, ActiveVersion.VersionNumber, LatestVersion.VersionNumber FROM FlowDefinition WHERE DeveloperName = '${FLOW}'`
  );
  const { records } = await rest(`/tooling/query?q=${query}`);
  check(records.length === 1, `${FLOW} wasn't found`);
  const [record] = records;
  return {
    id: record.Id,
    active: record.ActiveVersion && record.ActiveVersion.VersionNumber,
    latest: record.LatestVersion.VersionNumber
  };
}

async function governance() {
  const query = encodeURIComponent(
    `SELECT ${NS}Mode__c, ${NS}Approved_Version__c FROM ${NS}Flow_Governance__c WHERE ${NS}Flow_Api_Name__c = '${NS}${FLOW}' AND ${NS}Connection__c = null`
  );
  const { records } = await rest(`/query?q=${query}`);
  check(records.length === 1, `${FLOW} isn't governed`);
  return {
    mode: records[0][`${NS}Mode__c`],
    approved: records[0][`${NS}Approved_Version__c`]
  };
}

const steps = {
  async activate1(page) {
    await page.goto(compare("c__va=1&c__vb=2&c__tab=activate"), {
      waitUntil: "domcontentloaded"
    });
    const button = page.getByRole("button", { name: "Activate version 1" });
    await button.waitFor({ timeout: 60000 });
    await button.click();
    const outcome = page.locator("c-flow-activation .outcome").first();
    await outcome.waitFor({ timeout: 60000 });
    const text = await outcome.innerText();
    check(/Version 1 is now active/.test(text), `activation said: ${text}`);
    check((await definition()).active === 1, "version 1 isn't active");
    return text;
  },
  async govern(page) {
    await page.goto(`${ORG}/lightning/n/${NS}Governed_Flows`, {
      waitUntil: "domcontentloaded"
    });
    await page
      .getByRole("button", { name: "Govern a flow" })
      .click({ timeout: 60000 });
    await page
      .getByRole("combobox", { name: "Flow" })
      .click({ timeout: 60000 });
    await page.getByRole("option", { name: /Flow Compare Demo/ }).click();
    await page.locator(".editor-mode label", { hasText: "Locked" }).click();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Save" }).click();
    await page
      .locator(".editor")
      .waitFor({ state: "detached", timeout: 60000 });
    const state = await governance();
    check(state.mode === "Locked", `governed as ${state.mode}`);
    check(
      state.approved === (await definition()).active,
      "the active version isn't the approved one"
    );
    return page
      .locator("table.governed tbody tr", { hasText: "Flow Compare Demo" })
      .innerText();
  },
  async request2(page) {
    await page.goto(compare("c__va=1&c__vb=2&c__tab=activate"), {
      waitUntil: "domcontentloaded"
    });
    const panel = page.locator("c-flow-activation").first();
    await panel.locator(".governance-text").waitFor({ timeout: 60000 });
    const before = await panel.innerText();
    await panel.getByLabel("Comments").fill("Adds the large-amount path.");
    await panel
      .getByRole("button", { name: "Request activation of version 2" })
      .click();
    const outcome = panel.locator(".outcome");
    await outcome.waitFor({ timeout: 60000 });
    const text = await outcome.innerText();
    check(/^Requested\./.test(text), `request said: ${text}`);
    check((await definition()).active !== 2, "version 2 became active");
    return [before, text];
  },
  async approve(page) {
    await page.goto(`${ORG}/lightning/n/${NS}Flow_Approvals`, {
      waitUntil: "domcontentloaded"
    });
    const card = page
      .locator(".request", { hasText: "Flow Compare Demo" })
      .first();
    await card.waitFor({ timeout: 60000 });
    const text = await card.innerText();
    const version = Number(/version (\d+)/.exec(text)[1]);
    await card.getByRole("button", { name: "Approve" }).click();
    await page
      .locator("lightning-textarea.dialog-comments textarea")
      .fill("Approved in the end-to-end run.");
    await page
      .locator("section.slds-modal lightning-button.confirm button")
      .click();
    await page
      .locator("section.slds-modal")
      .waitFor({ state: "detached", timeout: 90000 });
    check(
      (await definition()).active === version,
      `version ${version} isn't active after approval`
    );
    check(
      (await governance()).approved === version,
      `version ${version} isn't the approved version`
    );
    return text;
  },
  async owner(page) {
    await page.goto(`${ORG}/lightning/n/${NS}Governed_Flows`, {
      waitUntil: "domcontentloaded"
    });
    const row = page.locator("table.governed tbody tr", {
      hasText: "Flow Compare Demo"
    });
    await row.waitFor({ timeout: 60000 });
    await row.locator("lightning-button-menu.row-menu button").click();
    await page
      .getByRole("menuitem", { name: "Edit governance" })
      .click({ timeout: 30000 });
    const picker = page.locator("lightning-record-picker.editor-owner");
    await picker.waitFor({ timeout: 30000 });
    // Clear the current owner, then search for the new one.
    await picker.locator("button").last().click();
    await page.waitForTimeout(800);
    await picker.locator("input:visible").first().fill("Integration");
    await page
      .getByRole("option", { name: /Integration User/ })
      .first()
      .click({ timeout: 30000 });
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "Save" }).click();
    await page
      .locator(".editor")
      .waitFor({ state: "detached", timeout: 60000 });
    await page.waitForTimeout(3000);
    const text = await row.innerText();
    check(/Integration User/.test(text), `owner shows as: ${text}`);
    return text;
  },
  async submitted(page) {
    await page.goto(
      `${ORG}/lightning/n/${NS}Flow_Approvals?c__scope=submitted`,
      { waitUntil: "domcontentloaded" }
    );
    await page.locator(".request, .empty").first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(1500);
    return page.locator(".request, .empty").allInnerTexts();
  },
  async merge(page) {
    const before = await definition();
    await page.goto(compare("c__va=3&c__vb=4&c__base=2&c__tab=merge"), {
      waitUntil: "domcontentloaded"
    });
    const row = page
      .locator(".unit, li, div", { hasText: /Is Large\? › rules › Large/ })
      .last();
    await row.waitFor({ timeout: 60000 });
    await row.getByText("Version 4", { exact: true }).click();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Save merged flow" }).click();
    const dialog = page.locator("c-flow-save-dialog section");
    await dialog.waitFor({ timeout: 30000 });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.locator(".saved").waitFor({ timeout: 90000 });
    const text = await dialog.locator(".saved").innerText();
    const after = await definition();
    check(after.latest === before.latest + 1, "no new version was saved");
    check(after.active === before.active, "saving changed the active version");
    return text;
  },
  async remote(page) {
    await page.goto(
      `${ORG}/lightning/n/${NS}Flow_Compare?c__mode=orgs&c__connB=${OTHER.name}&c__flow=${FLOW}&c__va=5&c__vb=2&c__tab=merge`,
      { waitUntil: "domcontentloaded" }
    );
    await page
      .getByRole("button", { name: "Save merged flow" })
      .waitFor({ timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Save merged flow" }).click();
    const dialog = page.locator("c-flow-save-dialog section");
    await dialog.waitFor({ timeout: 30000 });
    await dialog.getByRole("combobox", { name: "Flow" }).click();
    await page.getByRole("option", { name: new RegExp(OTHER.label) }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.locator(".saved").waitFor({ timeout: 90000 });
    return dialog.locator(".saved").innerText();
  },
  async testall(page) {
    await page.goto(`${ORG}/lightning/n/${NS}Flow_Compare_Setup`, {
      waitUntil: "domcontentloaded"
    });
    await page
      .getByRole("button", { name: "Test all" })
      .click({ timeout: 60000 });
    // Done when the row says who it signed in as, or that it can't connect.
    const row = page.locator("li.connection", { hasText: OTHER.label });
    await row
      .locator(".connection-state:not(.state-untested):not(.state-testing)")
      .waitFor({ timeout: 90000 });
    await page.waitForTimeout(4000);
    return page.locator("li.connection").allInnerTexts();
  },
  async drift(page) {
    // Someone activates another version outside the app; the check has to
    // put the approved version back.
    const { mode, approved } = await governance();
    check(mode === "Locked", `drift needs Locked mode, not ${mode}`);
    const flow = await definition();
    check(flow.active === approved, "the flow has drifted already");
    const other = approved === 1 ? 2 : 1;
    await rest(
      `/tooling/sobjects/FlowDefinition/${flow.id}?_HttpMethod=PATCH`,
      {
        method: "POST",
        body: JSON.stringify({ Metadata: { activeVersionNumber: other } })
      }
    );
    check((await definition()).active === other, "couldn't arrange the drift");

    await page.goto(`${ORG}/lightning/n/${NS}Governed_Flows`, {
      waitUntil: "domcontentloaded"
    });
    await page
      .getByRole("button", { name: "Run check now" })
      .click({ timeout: 60000 });
    const result = page.locator(".check-results .check", {
      hasText: "Flow Compare Demo"
    });
    await result.waitFor({ timeout: 90000 });
    const text = await result.innerText();
    check(
      text.includes(`Reverted version ${other} to version ${approved}.`),
      `the check said: ${text}`
    );
    check(
      (await definition()).active === approved,
      "the approved version isn't active again"
    );
    return text;
  },
  async history(page) {
    await page.goto(`${ORG}/lightning/n/${NS}Governed_Flows`, {
      waitUntil: "domcontentloaded"
    });
    const row = page.locator("table.governed tbody tr", {
      hasText: "Flow Compare Demo"
    });
    await row.waitFor({ timeout: 60000 });
    await row.locator("lightning-button.history button").click();
    const events = page.locator(".history-panel .event");
    await events.first().waitFor({ timeout: 60000 });
    await page
      .locator(".history-panel .history-loading")
      .waitFor({ state: "detached", timeout: 60000 });
    const text = await page.locator(".history-panel").innerText();
    check(/^History: Flow Compare Demo/.test(text), `the panel says: ${text}`);
    return text;
  }
};

(async () => {
  const names = process.argv.slice(2);
  const unknown = names.filter((name) => !steps[name]);
  check(!unknown.length, `unknown steps: ${unknown.join(", ")}`);
  const { browser, page } = await open(`/lightning/n/${NS}Governed_Flows`);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err).slice(0, 200)));
  await page.waitForTimeout(6000);
  const failed = [];
  for (const name of names) {
    errors.length = 0;
    try {
      const out = await steps[name](page);
      console.log(`## ${name}\n${[].concat(out).join("\n")}`);
    } catch (e) {
      failed.push(name);
      console.log(
        `## ${name} FAILED: ${String(e).split("\n")[0].slice(0, 300)}`
      );
    }
    await page.screenshot({ path: `${OUT}/gov-${name}.png` });
    if (errors.length) {
      failed.push(`${name} (page errors)`);
      console.log("page errors:", errors.join(" || "));
    }
  }
  await browser.close();
  if (failed.length) {
    console.log(`Failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error(
    String(e)
      .replace(/(sid|otp|token)=[^&\s]+/g, "$1=…")
      .slice(0, 400)
  );
  process.exit(1);
});
