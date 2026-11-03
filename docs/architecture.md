# Architecture

Tributary was written as a second-generation managed package that runs inside Salesforce (LWC + Apex, calling the Tooling and Metadata APIs through a packaged Named Credential). It does not replace Flow Builder, and a browser extension isn't needed. Its namespace is `trib`.

## What it does

1. **Visual diff.** Draws the real flow as a canvas and highlights what changed:
   - Elements and connectors: green when added, red when removed, amber when changed. A connector that now points somewhere else is drawn twice, red to its old target and green to its new one. Elements that only moved get a subtle marker, and a toggle hides them.
   - Opening an element shows its properties with changed fields highlighted: old value in red, new value in green, down to a single condition or input.
   - Views: side-by-side (before | after, with viewport panning kept in sync) and combined (one canvas that shows both states).
   - A resources panel shows variables, formulas and other resources with the same highlighting, plus the flow-level properties.
   - Compares any two flows: two versions of one flow, two unrelated flows, or flows in two orgs.
2. **Visual merge.** Merges on the same canvas: accept or reject a whole element, a single connector, or a single field inside an element, with the merged result drawn live. It's a three-way merge when both flows share an ancestor version and a two-way combine for unrelated flows. The merge checks dependencies: an element's resources come with it, and dangling connectors and name clashes are flagged. When both sides add to an ordered list (decision outcomes, screen fields...) at the same place, the order is a conflict to resolve, so the merge never picks which goes first. The result is saved as a new **inactive** version.
3. **Text diff and merge.** A unified or split view of the flow's metadata (green additions, red removals), with line-level picks for merging. Clicking an element on the canvas jumps to its lines.
4. **Ownership and activation approvals.** Each governed flow has an owner who approves activations. In Watch mode an activation by anyone but the owner is reverted; in Locked mode every activation outside Tributary is reverted. [`setup.md`](setup.md) describes the modes.

Salesforce's own Compare Versions has, since Summer '26, a canvas view that highlights added, changed and missing elements. It only compares versions of the same flow in the same org, doesn't highlight connectors, and can't merge.

## Clean-room rules

Tributary doesn't copy or trace Flow Builder's code, CSS, images or screenshots, and doesn't reproduce its layout. The canvas is its own renderer built on SLDS. SLDS element icons are used unmodified, with the attribution their licence requires (see [`NOTICE`](../NOTICE)).

## Components

- `lwc/flowModel`: reads a Tooling API `Flow` record (or bare metadata) into a graph: canvas elements (nodes), connectors (edges, found generically by `targetReference`, each with a kind: next, outcome, default, fault, loop next/end, scheduled path, wait event...), resources and flow-level properties. Tooling JSON is normalized (nulls and empty lists dropped, keys sorted), so equal JSON means equal values. Flows without a start element get a synthetic one.
- `lwc/flowDiff`: matches elements and resources by API name and type, and connectors by the element and slot they leave from. It reports added, removed, changed and moved elements, plus retargeted connectors, each with a field-level change list. Named lists (decision outcomes, screen fields...) are matched by name and report reordering, and other lists are aligned like a line diff. Version status is left out of the comparison.
- `lwc/flowLayout`, `lwc/flowScene`, `lwc/flowCanvas`: lay out the graph (the flow's own coordinates for free-form flows, a layered layout for auto-layout ones) and draw it as SVG with SLDS icons. `lwc/flowElementPanel` and `lwc/flowResourcesPanel` show properties and resources with field-level highlights.
- `lwc/flowDiffView`: the side-by-side and combined canvases, the XML view (`lwc/flowTextDiff`, `lwc/lineDiff`), and change navigation.
- `lwc/flowMerge`, `lwc/flowMergeView`, `lwc/flowTextMerge`: three-way (or two-way) merge with element, connector and field picks, dependency and problem checks, and a line-level XML merge. `lwc/flowSaveDialog` saves the result as a new inactive version, or as a new flow.
- `lwc/flowActivation`, `lwc/flowGovernance`, `lwc/flowApprovals`, `lwc/flowCompareSetup`: activation with ownership rules, governed flows and history, approvals, and setup.
- Apex: `FlowToolingClient` makes Tooling/REST callouts through the `Flow_Tooling_API` named credential (or a `Flow_Connection__mdt` connection's own credential). `FlowCompareController` lists connections, flows and versions, and saves. `FlowGovernanceService`/`FlowGovernanceController` handle ownership, requests, approvals, activation, drift checks and reverts, and the audit log. `FlowGovernanceMonitor` and `FlowGovernanceCheckJob` run the scheduled check. `FlowCompareSetupController` runs the setup checks and fixes.
- Objects: `Flow_Governance__c`, `Flow_Activation_Request__c`, `Flow_Audit_Event__c`, and the `Flow_Connection__mdt` custom metadata type. Permission sets `Flow_Compare_User` and `Flow_Compare_Admin`, custom permissions `Flow_Compare_Save` and `Flow_Compare_Admin`, and the `Flow_Governance_Alert` notification type.

API names (`Flow_Compare`, `FlowCompareController` and so on) keep the project's early working name, Flow Compare. Only admins reading metadata see them.

## Tests

The Jest tests (`npm test`) run against real flows saved in `test/fixtures/flows/<Flow>/v<N>.json`. Six Apex test classes cover the Apex: `FlowCompareControllerTest`, `FlowCompareSetupControllerTest`, `FlowGovernanceControllerTest`, `FlowGovernanceOperationTest`, `FlowGovernanceServiceTest` and `FlowToolingClientTest`. Browser checks against a real org are in [`test/e2e`](../test/e2e/README.md), and [`performance.md`](performance.md) covers how the engines scale with flow size.

## Packaging

The source is written for the `trib` package: `sfdx-project.json` has namespace `trib`, the permission sets grant the `trib__` credential principal, and the credentials ship a neutral URL that **Point it at this org** on the Setup page replaces. `scripts/deploy-to.sh` rewrites a private copy for any test org's My Domain and namespace, so the same source deploys to an org without the `trib` namespace.
