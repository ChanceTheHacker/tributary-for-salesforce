# Browser checks

Headless Chromium runs against the `tributary-dev` org and saves screenshots to `out/`. It logs in through a one-time link from `sf org open --url-only`, which is never printed.

`E2E_ORG=trib-ns` runs them in the org that owns the `trib` namespace, where Tributary's pages, objects and fields are prefixed `trib__` instead of `cllc__`. Deploy there with `scripts/deploy-to.sh trib-ns`. `session.js` lists the orgs the scripts know, with each one's seeded `UAT_Discounts_A` versions and its second Flow Connection. `Case_Email_Routing` and `lead_automation_test` are only in `tributary-dev`, so the pages and steps that open them (`e2e.js` `compare`, `merge`, `activate` and `flows`, and the tour's `compare-large` and `compare-flows`) fail in `trib-ns`.

```sh
cd test/e2e && npm install
node e2e.js                        # every page, or name some: node e2e.js demo-compare demo-merge
node gov.js activate1 govern owner # governance steps, in order
node tour.js --width=1280          # a screenshot of every screen and state, for design review
node tour.js merge activate-confirm --out=/tmp/shots
```

`seed-flows.js` puts the large test flows in the org as new draft versions and never activates anything. `UAT_Discounts_A`–`F` each get a base, "ours" and "theirs" version to merge three ways. `UAT_Case_Triage_Record`, `UAT_Case_Triage_Sub` and `UAT_Case_Screen` do related work from different starts, for merging across flows with a mapping. The record-triggered one must never be activated. `Order_Discounts` (versions 1–3: base, ours, theirs) and `Partner_Discounts` are made-up copies with ordinary names, for the help videos.

```sh
node seed-flows.js                          # create what isn't in the org yet
node seed-flows.js --dry-run                # only say what it would create
node seed-flows.js --dump=/tmp/flows        # also write each flow as /tmp/flows/<Flow>/vN.json
```

The `merge-large`, `merge-groups`, `merge-multi` and `merge-goes-to` tour steps open the three-way `UAT_Discounts_A` merge (versions 7 and 8 on base 6 in `tributary-dev`, 2 and 3 on base 1 in `trib-ns`). `merge-mapping` and `merge-mapping-place` open the cross-flow merge of the two Case triage flows. The Jest fixtures in `test/fixtures/flows` for these flows are `--dump` output.

`tour.js` is read-only: it opens dialogs, menus and the activation confirmation and cancels them, and only ever asks to activate `Flow_Compare_Demo`. Screenshots go to `out/tour/` unless `--out` says otherwise.

Each step or page prints what it saw. A script exits non-zero when a step fails its checks or a page logs an error, and prints which ones did. The tour's exit-status regression checks run without a browser or Salesforce access: `node --test test/e2e/tour-checks.cjs` from the repository root.

`gov.js` changes only `Flow_Compare_Demo`. `e2e.js` also opens `Case_Email_Routing`, but only to look at it. `gov.js drift` needs the demo flow governed in Locked mode with its approved version active. It activates a different version through the Tooling API, as someone working outside the app would, and then expects the check to put the approved version back. `e2e.js orgs` and `gov.js remote testall` also need the org's second Flow Connection: `Loopback` in `tributary-dev`, which has to be added first (see `docs/setup.md` §4), and `Dev_Org` in `trib-ns`, which reaches `tributary-dev`. There, `gov.js remote` saves a new draft version of `Flow_Compare_Demo` in `tributary-dev`. `gov.js request2` must run as someone who isn't the flow's owner or a Tributary admin.

## User-acceptance test server

`uat-server.js` uses `tributary-dev` and its `cllc__` pages. Before starting it, set `UAT_PROTECTED_NAMES` in your local environment to a comma-separated list of the real people's names that testers must not select, type or notify. Include first and last names separately if either can appear alone. Keep this list out of source control and shared logs. The server refuses to start if the list is missing or empty; it treats each entry as literal text, ignoring case. This guard helps prevent mistakes, but is not an authorization boundary: use a dedicated test org and test account.

Run `node --test test/e2e/uat-guard-checks.cjs` from the repository root to check the guard without Salesforce or a browser.

## Help videos

The help buttons beside each feature play short videos recorded by `record-help.js` from the scenes in `help-scenes.js`. A scene's setup runs off camera; each step is an action and the caption the player shows while it plays. The recorder writes each video to `force-app/main/default/staticresources/Help_<Topic>.resource` (H.264, no sound, the Salesforce header cropped off) and its steps, with the second each starts, to `lwc/flowHelp/helpTopics.js`. Captions can be corrected there by hand. Deploy both afterwards.

```sh
node record-help.js                  # every topic
node record-help.js merge save       # just these
node record-help.js views --keep     # keep the frames in out/help/views/
```

Nothing real is filmed:

- The scenes use only `Order_Discounts` and `Partner_Discounts`.
- Every answer from the org is rewritten on its way to the page: people's names, usernames and emails become made-up ones, the org's name becomes "Northwind Traders", and the namespace comes off the two flows' names.
- Lists leave out every other flow, and anything recorded about one.
- At every step the text on screen, and every field's value, is checked for what should have been rewritten. A match throws that video away and fails the run; `HELP_DEBUG=1` says what was seen.

The videos change the org. `save` saves a version 4 of `Order_Discounts` and deletes it again. `activate` activates version 3 and deactivates it. `govern`, `request`, `approve` and `history` follow on from one another and must be recorded together, in that order: they govern the flow, request and approve an activation, then put everything back. The request goes to the Integration User, and the approval comes back to the user recording it, who made the request, so no one else is notified.

Pipe the output through `sed -E 's/(sid|otp|token)=[^&[:space:]]+/\1=…/g'` whenever it might be shared.
