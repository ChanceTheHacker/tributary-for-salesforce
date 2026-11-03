// What each help video shows, for record-help.js. A scene's setup runs off
// camera; each step's text is the caption shown while it plays.
//
// Only the synthetic Order_Discounts and Partner_Discounts flows are used
// (seed-flows.js). govern, request, approve and history follow on from one
// another and are recorded together, in that order; compare and activate
// put Order_Discounts back as seeded: ungoverned, inactive, versions 1-3.
const FLOW = "Order_Discounts";

// Records made through the page carry the name as filmed, without the
// namespace that record-help.js hides; those made on the server keep it.
const named = (ctx) =>
  `${ctx.NS}Flow_Api_Name__c IN ('${ctx.NS}${FLOW}', '${FLOW}')`;

const page = (ns, name, query = "") =>
  `/lightning/n/${ns}${name}${query ? `?${query}` : ""}`;

// A page opens inside whichever app was used last, so the navigation bar
// is checked for Tributary's own; a redirect loop is retried once.
async function go(ctx, name, query, ready, tries = 2) {
  const open = (url) =>
    ctx.page.goto(`${ctx.ORG}${url}`, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });
  try {
    await open(page(ctx.NS, name, query));
    await ctx.page.locator(ready).first().waitFor({ timeout: 90000 });
    const app = ctx.page.locator("one-appnav .appName").first();
    await app.waitFor({ timeout: 30000 });
    if ((await app.innerText()).trim() !== "Tributary") {
      if (tries <= 1) {
        throw new Error("Tributary's navigation bar is not showing");
      }
      await open(`/lightning/app/${ctx.NS}Flow_Compare`);
      await ctx.page.waitForTimeout(5000);
      return go(ctx, name, query, ready, tries - 1);
    }
  } catch (error) {
    if (tries <= 1 || !/ERR_TOO_MANY_REDIRECTS/.test(error.message)) {
      throw error;
    }
    await ctx.page.waitForTimeout(5000);
    return go(ctx, name, query, ready, tries - 1);
  }
  await ctx.page.waitForTimeout(2500);
}

const compare = (ctx, query, ready = "c-flow-canvas .node") =>
  go(ctx, "Flow_Compare", query, ready);

const soql = (text) => `/query?q=${encodeURIComponent(text)}`;
const tooling = (text) => `/tooling/query?q=${encodeURIComponent(text)}`;

async function records(ctx, text) {
  return (await ctx.rest(soql(text))).records;
}

async function userId(ctx, where) {
  const [user] = await records(
    ctx,
    `SELECT Id FROM User WHERE ${where} LIMIT 1`
  );
  return user.Id;
}

const me = (ctx) =>
  userId(ctx, `Username = '${ctx.sf(["org", "display", "user"]).username}'`);

async function governance(ctx) {
  const [record] = await records(
    ctx,
    `SELECT Id FROM ${ctx.NS}Flow_Governance__c WHERE ${named(ctx)} AND ${ctx.NS}Connection__c = null`
  );
  return record;
}

async function update(ctx, object, id, fields) {
  await ctx.rest(`/sobjects/${ctx.NS}${object}/${id}`, {
    method: "PATCH",
    body: JSON.stringify(
      Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [`${ctx.NS}${key}`, value])
      )
    )
  });
}

async function remove(ctx, object, where) {
  const found = await records(
    ctx,
    `SELECT Id FROM ${ctx.NS}${object} WHERE ${where}`
  );
  for (const { Id } of found) {
    await ctx.rest(`/sobjects/${ctx.NS}${object}/${Id}`, { method: "DELETE" });
  }
}

async function definition(ctx) {
  const [record] = (
    await ctx.rest(
      tooling(`SELECT Id FROM FlowDefinition WHERE DeveloperName = '${FLOW}'`)
    )
  ).records;
  return record.Id;
}

async function deactivate(ctx) {
  await ctx.rest(
    `/tooling/sobjects/FlowDefinition/${await definition(ctx)}?_HttpMethod=PATCH`,
    {
      method: "POST",
      body: JSON.stringify({ Metadata: { activeVersionNumber: 0 } })
    }
  );
}

// Versions the save video made.
async function dropSaved(ctx) {
  const { records: extra } = await ctx.rest(
    tooling(
      `SELECT Id FROM Flow WHERE Definition.DeveloperName = '${FLOW}' AND VersionNumber > 3 AND Status != 'Active'`
    )
  );
  for (const { Id } of extra) {
    await ctx.rest(`/tooling/sobjects/Flow/${Id}`, { method: "DELETE" });
  }
}

// Order_Discounts as seed-flows.js left it.
async function reset(ctx) {
  const name = named(ctx);
  await remove(ctx, "Flow_Activation_Request__c", name);
  await remove(ctx, "Flow_Audit_Event__c", name);
  const record = await governance(ctx);
  if (record) {
    await ctx.rest(`/sobjects/${ctx.NS}Flow_Governance__c/${record.Id}`, {
      method: "DELETE"
    });
  }
  await deactivate(ctx);
  await dropSaved(ctx);
}

const MERGE = `c__flow=${FLOW}&c__va=2&c__vb=3&c__base=1&c__tab=merge`;
const ACTIVATE = `c__flow=${FLOW}&c__va=2&c__vb=3&c__tab=activate`;
const conflict = (page) =>
  page.locator("c-flow-canvas .node.has-conflict").first();
// On version B's side, where changes read as changes rather than removals.
const changed = (page) =>
  page.locator("c-flow-canvas").last().locator(".node.status-changed").first();
// The choice for version 3 in the open element's panel.
const pick = (page) =>
  page
    .locator("c-flow-element-panel label")
    .filter({ has: page.getByRole("radio", { name: /^Version 3/ }) })
    .first();
const outcome = (page) =>
  page.locator("c-flow-activation .outcome, c-flow-activation .error").first();

module.exports = [
  {
    topic: "compare",
    title: "Compare two versions of a flow",
    action: "compare two versions of a flow",
    async setup(ctx) {
      await reset(ctx);
      await go(ctx, "Flow_Compare", "", "c-flow-picker input");
    },
    steps: [
      {
        text: "Choose the flow you want to compare.",
        async run({ page, click, type, pause }) {
          await click(
            page.getByRole("combobox", { name: "Flow" }).first(),
            300
          );
          await type("Order", 500);
          await click(
            page.getByRole("option", { name: /Order Discounts/ }).first()
          );
          await page
            .locator("c-flow-canvas .node")
            .first()
            .waitFor({ timeout: 90000 });
          await pause(1200);
        }
      },
      {
        text: "Tributary picks two versions for you. Change either one here.",
        async run({ page, hover }) {
          await hover(page.getByRole("combobox", { name: "Version A" }), 900);
          await hover(page.getByRole("combobox", { name: "Version B" }), 900);
        }
      },
      {
        text: "Colours show what was added, removed or changed.",
        async run({ page, hover }) {
          await hover(changed(page), 800);
          await hover(
            page
              .locator("c-flow-canvas")
              .last()
              .locator(".node.status-added")
              .first(),
            800
          );
        }
      },
      {
        text: "Click any element to see exactly what changed in it.",
        hold: 2600,
        async run({ page, click }) {
          await click(changed(page), 1200);
        }
      }
    ]
  },
  {
    topic: "compare-other",
    title: "Compare two flows, or two orgs",
    action: "compare two different flows, or a flow in two orgs",
    async setup(ctx) {
      await compare(ctx, `c__flow=${FLOW}&c__va=1&c__vb=3`);
    },
    steps: [
      {
        text: "Choose Two flows to put different flows side by side.",
        async run({ page, click }) {
          await click(
            page.getByText("Two flows", { exact: true }).first(),
            1500
          );
        }
      },
      {
        text: "Pick the second flow.",
        async run({ page, click, type, pause }) {
          await click(
            page.getByRole("combobox", { name: "Flow B" }).first(),
            300
          );
          await type("Partner", 500);
          await click(
            page.getByRole("option", { name: /Partner Discounts/ }).first()
          );
          await page
            .locator("c-flow-canvas .node")
            .first()
            .waitFor({ timeout: 90000 });
          await pause(1500);
        }
      },
      {
        text: "Their differences are shown just as for two versions.",
        async run({ page, hover }) {
          await hover(changed(page), 1200);
        }
      },
      {
        text: "Two orgs compares a flow with its copy in another org, such as a sandbox.",
        hold: 2600,
        async run({ page, hover }) {
          await hover(
            page.getByText("Two orgs", { exact: true }).first(),
            1200
          );
        }
      }
    ]
  },
  {
    topic: "views",
    title: "Read the differences",
    action: "read the differences in each view",
    async setup(ctx) {
      await compare(ctx, `c__flow=${FLOW}&c__va=1&c__vb=3`);
    },
    steps: [
      {
        text: "Side by side puts version A on the left and B on the right.",
        async run({ page, hover }) {
          await hover(
            page.getByText("Side by side", { exact: true }).first(),
            1200
          );
        }
      },
      {
        text: "Step through the changes one at a time with the arrows.",
        async run({ page, click }) {
          const next = page
            .getByRole("button", { name: "Next change" })
            .first();
          await click(next, 1100);
          await click(next, 1100);
        }
      },
      {
        text: "Combined shows one canvas with every change marked.",
        async run({ page, click }) {
          await click(
            page.getByText("Combined", { exact: true }).first(),
            2000
          );
        }
      },
      {
        text: "Fade unchanged dims everything that stayed the same.",
        async run({ page, click }) {
          await click(
            page.getByText("Fade unchanged", { exact: true }).first(),
            1500
          );
        }
      },
      {
        text: "XML shows the flow's file, line by line.",
        hold: 2400,
        async run({ page, click }) {
          await click(page.getByText("XML", { exact: true }).first(), 1800);
        }
      }
    ]
  },
  {
    topic: "merge",
    title: "Merge two versions",
    action: "merge two versions into one",
    async setup(ctx) {
      await compare(ctx, MERGE);
    },
    steps: [
      {
        text: "Merge builds one flow from two versions. With a common base, it knows who changed what.",
        hold: 2200,
        async run({ page, hover }) {
          await hover(
            page.getByText("Three-way merge", { exact: true }).first(),
            900
          );
          await hover(page.getByRole("combobox", { name: /Common base/ }), 900);
        }
      },
      {
        text: "A conflict is something both versions changed. Click one to decide.",
        async run({ page, click }) {
          await click(conflict(page), 1400);
        }
      },
      {
        text: "Choose which version to keep.",
        async run({ page, click }) {
          await click(pick(page), 1400);
        }
      },
      {
        text: "Or take one side for everything with a preset.",
        async run({ page, click, hover, pause }) {
          await click(
            page.locator("lightning-button-menu.presets button").first(),
            900
          );
          await hover(page.getByRole("menuitem").first(), 900);
          await page.keyboard.press("Escape");
          await pause(500);
        }
      },
      {
        text: "Changed your mind? Undo, or press Ctrl+Z.",
        hold: 2400,
        async run({ page, click }) {
          await click(page.locator("lightning-button-icon.undo button"), 1200);
        }
      }
    ]
  },
  {
    topic: "save",
    title: "Save a merged flow",
    action: "save a merged flow",
    async setup(ctx) {
      await dropSaved(ctx);
      await compare(ctx, MERGE);
      await ctx.page.locator("lightning-button-menu.presets button").click();
      await ctx.page.getByRole("menuitem", { name: /using Version 3/ }).click();
      await ctx.page.waitForTimeout(1500);
    },
    cleanup: dropSaved,
    steps: [
      {
        text: "Once every conflict is settled, save the result.",
        async run({ page, click }) {
          await click(
            page.locator("c-flow-merge-view lightning-button.save button"),
            1500
          );
        }
      },
      {
        text: "It's saved as a new version of the flow. Nothing is activated.",
        async run({ page, hover }) {
          await hover(page.locator("c-flow-save-dialog section").first(), 1500);
        }
      },
      {
        text: "Save.",
        async run({ page, click, cut }) {
          const dialog = page.locator("c-flow-save-dialog section");
          await click(
            dialog.getByRole("button", { name: "Save", exact: true }),
            300
          );
          await cut(() =>
            dialog.locator(".saved").waitFor({ timeout: 180000 })
          );
        }
      },
      {
        text: "The new version is ready to test, compare or activate.",
        hold: 2800,
        async run({ page, hover }) {
          await hover(page.locator("c-flow-save-dialog .saved"), 800);
        }
      }
    ]
  },
  {
    topic: "activate",
    title: "Activate a version",
    action: "activate a version",
    async setup(ctx) {
      await reset(ctx);
      await compare(ctx, ACTIVATE, "c-flow-activation");
    },
    cleanup: deactivate,
    steps: [
      {
        text: "Activate shows which version is live and lets you switch.",
        async run({ page, hover }) {
          await hover(page.locator("c-flow-activation").first(), 1400);
        }
      },
      {
        text: "Click Activate on the version you want live.",
        async run({ page, click }) {
          await click(
            page
              .locator("c-flow-activation")
              .getByRole("button", { name: "Activate version 3" }),
            1200
          );
        }
      },
      {
        text: "Confirm.",
        async run({ page, click, cut }) {
          await click(
            page.locator(
              "c-flow-activation lightning-button.confirm-activate button"
            ),
            300
          );
          await cut(() => outcome(page).waitFor({ timeout: 240000 }));
        }
      },
      {
        text: "Version 3 is live, and the change is recorded.",
        hold: 2600,
        async run({ page, hover }) {
          await hover(page.locator("c-flow-activation .outcome.ok"), 800);
        }
      }
    ]
  },
  {
    topic: "govern",
    title: "Govern a flow",
    action: "put a flow under governance",
    async setup(ctx) {
      await reset(ctx);
      await go(ctx, "Governed_Flows", "", "table.governed, .empty");
    },
    steps: [
      {
        text: "Governing a flow gives it an owner, who decides what gets activated.",
        async run({ page, click }) {
          await click(
            page.getByRole("button", { name: "Govern a flow" }),
            1500
          );
        }
      },
      {
        text: "Choose the flow.",
        async run({ page, click }) {
          await click(
            page.getByRole("combobox", { name: "Flow" }).first(),
            700
          );
          await click(
            page.getByRole("option", { name: /Order Discounts/ }).first(),
            900
          );
        }
      },
      {
        text: "The owner approves requests to activate it.",
        async run({ page, hover }) {
          await hover(
            page.locator("lightning-record-picker.editor-owner"),
            1400
          );
        }
      },
      {
        text: "Approval required means every activation needs the owner's approval.",
        hold: 2200,
        async run({ page, click }) {
          await click(
            page.locator(".editor-mode label", {
              hasText: "Approval required"
            }),
            1200
          );
        }
      },
      {
        text: "Save. The flow is now governed.",
        hold: 2600,
        async run({ page, click, cut }) {
          await click(
            page.getByRole("button", { name: "Save", exact: true }),
            300
          );
          await cut(() =>
            page
              .locator(".editor")
              .waitFor({ state: "detached", timeout: 90000 })
          );
        }
      }
    ]
  },
  {
    topic: "request",
    title: "Ask for a version to be activated",
    action: "ask a flow's owner to activate a version",
    // A made-up owner, so the request is someone else's to approve.
    async setup(ctx) {
      const record = await governance(ctx);
      await update(ctx, "Flow_Governance__c", record.Id, {
        Owner_User__c: await userId(ctx, "Name = 'Integration User'")
      });
      await compare(ctx, ACTIVATE, "c-flow-activation .governance-text");
    },
    steps: [
      {
        text: "A governed flow is activated by its owner. You ask them.",
        async run({ page, hover }) {
          await hover(
            page.locator("c-flow-activation .governance-text").first(),
            1600
          );
        }
      },
      {
        text: "Say what the version changes.",
        async run({ page, click, type }) {
          await click(
            page
              .locator("c-flow-activation")
              .getByLabel(/Comments/)
              .first(),
            300
          );
          await type("Adds the partner discount tier.", 600);
        }
      },
      {
        text: "Send the request.",
        async run({ page, click, cut }) {
          await click(
            page.getByRole("button", {
              name: "Request activation of version 3"
            }),
            300
          );
          await cut(() => outcome(page).waitFor({ timeout: 90000 }));
        }
      },
      {
        text: "The owner is told. Follow it on Flow Approvals.",
        hold: 2800,
        async run({ page, hover }) {
          await hover(page.locator("c-flow-activation .outcome.ok"), 800);
        }
      }
    ]
  },
  {
    topic: "approve",
    title: "Approve a request",
    action: "approve or reject a request",
    // The request comes back to the recording user, who made it, so no one
    // else is told of the decision.
    async setup(ctx) {
      const mine = await me(ctx);
      await update(ctx, "Flow_Governance__c", (await governance(ctx)).Id, {
        Owner_User__c: mine
      });
      const pending = await records(
        ctx,
        `SELECT Id FROM ${ctx.NS}Flow_Activation_Request__c WHERE ${named(ctx)} AND ${ctx.NS}Status__c = 'Pending'`
      );
      for (const { Id } of pending) {
        await update(ctx, "Flow_Activation_Request__c", Id, {
          Approver__c: mine
        });
      }
      await go(ctx, "Flow_Approvals", "", ".request");
    },
    steps: [
      {
        text: "Flow Approvals lists the requests waiting for you.",
        async run({ page, hover }) {
          await hover(
            page.locator(".request", { hasText: "Order Discounts" }).first(),
            1500
          );
        }
      },
      {
        text: "Compare shows what the version would change.",
        async run({ page, hover }) {
          await hover(
            page
              .locator(".request", { hasText: "Order Discounts" })
              .first()
              .getByRole("button", { name: /Compare/ })
              .first(),
            1400
          );
        }
      },
      {
        text: "Approve it, with a note if you like. Reject works the same way.",
        async run({ page, click, type }) {
          await click(
            page
              .locator(".request", { hasText: "Order Discounts" })
              .first()
              .getByRole("button", { name: /^Approve/ }),
            900
          );
          await click(
            page.locator("lightning-textarea.dialog-comments textarea"),
            300
          );
          await type("Looks good.", 600);
        }
      },
      {
        text: "Confirm. The version is activated for the requester.",
        hold: 2800,
        async run({ page, click, cut }) {
          await click(
            page.locator("section.slds-modal lightning-button.confirm button"),
            300
          );
          await cut(() =>
            page
              .locator("section.slds-modal")
              .waitFor({ state: "detached", timeout: 240000 })
          );
        }
      }
    ]
  },
  {
    topic: "history",
    title: "See a flow's history",
    action: "see a governed flow's history",
    async setup(ctx) {
      await go(ctx, "Governed_Flows", "", "table.governed tbody tr");
    },
    cleanup: reset,
    steps: [
      {
        text: "Governed Flows lists each flow with its owner, mode and live version.",
        async run({ page, hover }) {
          await hover(
            page.locator("table.governed tbody tr", {
              hasText: "Order Discounts"
            }),
            1600
          );
        }
      },
      {
        text: "History shows every request, approval and activation.",
        hold: 2400,
        async run({ page, click }) {
          await click(
            page
              .locator("table.governed tbody tr", {
                hasText: "Order Discounts"
              })
              .locator("lightning-button.history button"),
            300
          );
          await page
            .locator("ol.events li.event")
            .first()
            .waitFor({ timeout: 60000 });
          await page.waitForTimeout(1200);
        }
      },
      {
        text: "Run check now puts back anything activated outside the rules.",
        hold: 2400,
        async run({ page, hover }) {
          await hover(
            page.getByRole("button", { name: "Run check now" }),
            1200
          );
        }
      }
    ]
  }
];
