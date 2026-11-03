# Tributary: security overview

This describes what Tributary is made of, where its data goes, how it authenticates, and how it decides who may do what. It also covers each place where it reads or writes data in system mode or without sharing, and why that is safe. Installation and configuration are in [`setup.md`](setup.md), and a guided tour of the features is in [`walkthrough.md`](walkthrough.md).

## What Tributary is

Tributary was written to be distributed as a second-generation managed package (namespace `trib`) and runs entirely inside Salesforce. The AppExchange release was cancelled, so no managed package was ever built or installed; the source has only been deployed to development orgs. It lets admins:

- compare two flows or flow versions on a visual canvas and as XML;
- merge them and save the result as a new, **inactive** flow version;
- put flows under an owner's control, so an activation needs the owner's approval, and activations that bypass it are detected and reverted.

The package contains only Salesforce platform components:

| Kind                     | Components                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lightning Web Components | 38 bundles: the canvas and diff/merge engines, the pages and their panels. All of it is our own code, with no third-party libraries.                                                                                                                 |
| Apex                     | `FlowCompareController`, `FlowCompareSetupController`, `FlowGovernanceController`, `FlowGovernanceService`, `FlowGovernanceOperation`, `FlowGovernanceMonitor`, `FlowGovernanceCheckJob`, `FlowToolingClient`, plus six test classes and a test mock |
| Custom objects           | `Flow_Governance__c` (a governed flow, its owner and mode), `Flow_Activation_Request__c` (a request to activate a version), `Flow_Audit_Event__c` (the audit log), `Flow_Operation__c` (internal locks for queued work)                              |
| Custom metadata type     | `Flow_Connection__mdt`: other orgs the subscriber chooses to connect, each naming a subscriber-created named credential                                                                                                                              |
| Credentials              | Named credential and external credential `Flow_Tooling_API` (principal `AppIdentity`, OAuth 2.0 client credentials). The package ships **no secrets**: the subscriber enters their own client ID and secret.                                         |
| Permissions              | Permission sets **Tributary User** (`Flow_Compare_User`) and **Tributary Admin** (`Flow_Compare_Admin`); custom permissions `Flow_Compare_Save` and `Flow_Compare_Admin`                                                                             |
| Other                    | A Lightning app, four tabs and their Lightning pages, the custom notification type `Flow_Governance_Alert`, and ten MP4 help videos as static resources                                                                                              |

There is no Visualforce, no Aura, no triggers, no external website, service or API, no mobile app and no browser extension.

## Data flow

```
 Browser (Lightning Experience)
   │  LWC → @AuraEnabled Apex (Lightning's own authenticated channel)
   ▼
 Tributary Apex, running as the signed-in user
   │  checks the user's permissions (below), then calls:
   ├─► Tooling / Metadata REST API of THIS org
   │     through named credential Flow_Tooling_API
   │     = OAuth 2.0 client credentials → the subscriber's own External Client App
   │       → runs as the subscriber's chosen integration user
   └─► Tooling / Metadata REST API of ANOTHER Salesforce org (optional)
         through a named credential the subscriber creates and lists in Flow_Connection__mdt
```

- **Nothing leaves Salesforce.** Every callout goes to a Salesforce org's own REST API: the subscriber's org, or another org the subscriber connected. Tributary has no servers and collects no telemetry. It doesn't send email; alerts are Salesforce custom notifications to the flow's owner.
- **What is read and written:** flow metadata and versions (read; a new inactive version or a new flow is created only on save), flow activation state (changed only by an approved request, an admin, or a revert of an unapproved activation), and the package's own four objects.
- **In the browser**, flows are parsed, compared and merged by the package's own JavaScript: a hand-written XML reader and writer (no `DOMParser`, so no entity expansion). Nothing uses `innerHTML`, `lwc:dom="manual"`, `eval`, `new Function`, `loadScript` or `loadStyle`, and nothing loads from outside the org. Templates render all text through Lightning's escaped bindings.

### Browser storage

`flowUtils` keeps merge picks, variable mappings and hand-edited XML drafts in `sessionStorage`, so a reload in the same browser tab can restore work. Draft XML can contain flow metadata and literal values; this is browser-resident data, not an upload to a Tributary service. Each draft store retains the last merge of its kind; normal tab closure ends session storage, subject to the browser's session-restoration behavior. The help-video preference is in `localStorage` and persists in that browser, not as a Salesforce user setting. These stores do not hold OAuth credentials. Include this behavior in the final privacy disclosure and test browser/session isolation with the installed package.

### Why Tributary calls its own org's API

Apex has no native way to read a flow's full metadata, create a flow version, or activate one: those need the Tooling and Metadata APIs. A Lightning session ID can't be used for API calls, and working around that is not allowed. So Tributary calls the org's own REST API through a named credential. It uses the OAuth 2.0 client credentials flow with an External Client App the subscriber creates in their org, and a Run As user they choose.

This means the API calls run as that integration user, not as the person using Tributary. Tributary checks application authorization before changes; local saves also require the person's own **Manage Flow** permission. Remote writes are delegated access through the configured integration user, not a check of that person's permissions in the remote org.

Metadata reads are also delegated: **Tributary User** grants controller and credential-principal access, not a per-user Flow Builder visibility check. Local calls additionally require the caller to be able to inspect both credential configurations through `ConnectApi`; unreadable configuration now fails closed before authentication. Tributary User does not grant **View Setup and Configuration** automatically. Assign metadata access only to people trusted to review the connected orgs' flow metadata, which can contain business logic and literal values. Governance records and audit records returned to the browser still use the record and field checks described below.

### Credentials

- The package ships the named credential and external credential with a placeholder URL (`https://login.salesforce.com`) and no client ID or secret. The named credential has `ManagedByNamespace = SubscriberMode`, so the subscriber can edit it.
- On the Setup page, **Point it at this org** replaces the placeholder with the org's My Domain on both credentials, and links the named credential to the package's own external credential. Salesforce then turns off _Enabled for Callouts_ on the credential, and the page asks an admin to turn it back on in Setup. That human approval stays in place.
- **Enter credentials** stores the client ID and secret as the external credential's principal parameters, through `ConnectApi` with encrypted inputs. They are stored and encrypted by Salesforce's credential store, are never returned to the browser, and are never logged or written to any record.
- Tributary uses the credential only while all of these hold:
  - the named credential calls this org's HTTPS My Domain;
  - it is linked to Tributary's own `Flow_Tooling_API` external credential: the same record by ID, not just the same name;
  - that external credential's token URL is `https://<My Domain>/services/oauth2/token`.

  It refuses to store a client ID and secret unless they all hold. It refuses any call, before signing in, if either configuration cannot be read or does not match. A refusal stands for the rest of the transaction.

- Within Tributary, only users with the **Tributary Admin** custom permission can change credentials. The credential principal is granted through the two packaged permission sets.
- Connections to other orgs use named credentials that the subscriber creates and controls. `Flow_Connection__mdt` stores only the credential's API name, not a secret. A caller can't choose an arbitrary credential: a connection must be listed in the metadata type, which only admins can deploy.

#### Users who can't read credential setup

The post-authentication `Organization` ID fallback has been removed. Every packaged local-credential entry point, including aliases and Continuations, now requires a readable, matching named-credential configuration and external-credential token URL **before any authenticated callout**. Missing, unreadable or mismatched configuration produces an actionable refusal. The token URL must match this org's exact HTTPS token endpoint without a query or fragment.

An administrator must arrange the caller's credential-configuration visibility, then verify it using that caller's own session. **View Setup and Configuration** is not silently added to either permission set. Tests cover refusal before authentication, but ordinary-caller `ConnectApi` visibility and a clean managed-subscriber installation were never tested.

Only trusted credential administrators should hold **Manage Named Credentials**. If the credential previously pointed elsewhere, rotate the External Client App secret. Explicit subscriber-delegated remote connections are separate from the packaged local credential and retain their configured behavior.

## Authorization

| Who                            | Needs                                                                               | Can                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Anyone with **Tributary User** | the permission set and, for local metadata calls, readable credential configuration | list, compare and merge flows in the browser; request an activation; see governed flows and history                          |
| Savers                         | the **Flow_Compare_Save** custom permission and, in this org, **Manage Flow**       | save a merge as a new inactive version or a new flow; activate flows nobody governs                                          |
| A flow's owner                 | to be named owner on its `Flow_Governance__c` record                                | approve or reject that flow's activation requests                                                                            |
| **Tributary Admin**            | the permission set                                                                  | everything above, plus Setup, governing flows and choosing owners and modes, approving any request, and starting the monitor |

These rules are enforced in Apex on every call, not just by hiding buttons.

- Saving to this org requires **Manage Flow**, checked against the user's own permission set assignments, including the profile's. So Tributary never lets anyone change a flow they couldn't change in Flow Builder, even though the API call runs as the integration user. A connection that points back at this org is held to the same rule.
- Saves only ever create **inactive** versions or new flows. A save is rejected if:
  - the target flow version is not a draft;
  - it belongs to an installed package;
  - the flow changed on the server since the user loaded it.
- Activating a governed flow needs an approved request from its owner, or an admin. Approvals, activations and checks run as queued jobs. Each checks again, in the job, that the approver may approve and that the version approved is the version activated.
- An owner must be an active, standard Salesforce user who can use Tributary; API-only users and inactive users can't be owners.
- The Setup page's changes (credentials, principal access repair, connection test, monitor schedule) all need Tributary Admin.

## Data access: sharing, CRUD and FLS

All Apex classes are `with sharing`, except `FlowGovernanceOperation` and the inner class `FlowGovernanceService.Policy` (see below). Queries and DML that serve a user's request run **`WITH USER_MODE` / `AccessLevel.USER_MODE`**, so the user's object, field and record access applies. Records returned to the browser are limited to what the user can read. System mode is used only in the places listed here, each for a reason the user's own access can't serve:

| Where                                                                       | What                                                                                                                                 | Why it's safe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization lookups in `FlowGovernanceService.Policy` (`without sharing`) | reading a flow's `Flow_Governance__c` record (owner and mode), and the user's Manage Flow assignment                                 | A governance decision must see the real owner and mode even when the user can't see the record, or hiding a record would let a user skip its owner. The result is used only to allow or deny, and to work out which buttons to show; nothing from it goes to the user who couldn't read it.                                                                                                                                                                                                                                                                                         |
| The governance check, in `FlowGovernanceService.Policy`                     | reading the governed flows due for a check, locking one to enforce it, and writing the check's result fields on `Flow_Governance__c` | A check must see every governed flow, whatever sharing the subscriber sets, or a hidden Locked flow would never be enforced. Only a check started by a user with the Tributary Admin custom permission, and its queued jobs, reach this code. It writes only the check's own fields (last checked, outcome, message, active and approved version), which no permission set lets users edit. Its per-flow results are shown only for flows whose record, and whose fields the result shows, the admin can read in user mode. The counts cover every flow, so a failure isn't hidden. |
| Audit log writes                                                            | inserting `Flow_Audit_Event__c`                                                                                                      | Users can read the audit log but never create, edit or delete entries: no permission set grants those. Only the package writes it, recording what actually happened.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Approval, activation and check results                                      | updating `Flow_Activation_Request__c` and `Flow_Governance__c` status fields after a queued operation                                | These fields record the outcome of a checked operation. The user's permissions were already checked when the operation was started and again in the job. The permission sets give users read-only access to these fields so they can't forge an approval.                                                                                                                                                                                                                                                                                                                           |
| `FlowGovernanceOperation` (`without sharing`)                               | `Flow_Operation__c` claims (the per-flow locks), and reading and updating the records an operation acts on                           | The job must see the same records whoever queued it, and a claim must be visible to every job, or two could run at once on the same flow. `Flow_Operation__c` has private sharing and no permission set grants any access to it: it is internal plumbing. The job only acts on the request or check it was queued for, whose authorization was checked before queueing and is checked again in the job.                                                                                                                                                                             |
| Pending-request invalidation in `FlowGovernanceService.Policy`              | cancelling Pending requests for the same org/flow after owner or mode changes, initial governance or removal                         | The governance mutation is authorized and performed through user-mode DML in the same transaction. Invalidation must reach requests hidden from the administrator by sharing, otherwise old approvals could survive the policy change. It writes only cancellation status, actor, time and reason, with audit entries; completed requests and other flows are untouched. More than 2,000 matching requests fails the whole mutation closed. Request creation and policy changes share the per-flow operation gate.                                                                  |
| Setup principal repair                                                      | `SetupEntityAccess` rows granting the credential principal to the two **packaged** permission sets                                   | This is admin-only. It only touches `trib`-namespace permission sets and the package's own principal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**Requests returned after an action.** After a user approves, rejects or cancels a request, or polls a queued operation, the request goes back to the browser only if a `WITH USER_MODE` query shows the user can see it, which applies sharing and restriction rules. It is then read with sharing and passed through `Security.stripInaccessible`. Otherwise the user gets only its ID and the outcome of their own action. That outcome is returned even when the user can't read the Status field, since their own action already told them.

`Flow_Operation__c` is not granted in any permission set. The other three objects' fields are granted read-only to Tributary User, apart from the fields a requester fills in. They are granted to Tributary Admin as the admin pages need.

Every system-mode statement and `without sharing` class has a comment in the code saying why.

## Input handling

- Flow API names, version numbers and record IDs from the browser are checked against strict patterns before they go into a SOQL filter or an API path. Version numbers are typed integers. SOQL uses bind variables.
- The browser can't choose a URL or a credential: callouts go to fixed Tooling and Metadata API paths, through the packaged credential or one listed in `Flow_Connection__mdt`.
- Flow XML from a merge is sent to the Metadata/Tooling API as data. The API validates it, as it would for Flow Builder.
- Error messages returned to the browser are rendered as text, not HTML.

## Asynchronous work

- **Approvals and activations** run as queued jobs (`FlowGovernanceOperation`), so their callouts don't hold up a page. A committed per-flow claim makes sure only one operation acts on a flow at a time, because Salesforce releases row locks during callouts. A finalizer releases the claim if a job fails. If Salesforce purges a job from its job history before the operation finishes, the operation counts as stopped once it is an hour old, and its claim is released.
- **The monitor** (`FlowGovernanceMonitor`, scheduled by an admin from the Setup page) queues a check (`FlowGovernanceCheckJob`). The check compares each governed flow's active version with the approved one and, in Watch and Locked mode, reactivates the approved version and notifies the owner. It runs as the admin who scheduled it, and sees every governed flow (see the table above). It can be stopped from the same page.

## Secrets and logging

- No credentials, tokens or session IDs are stored in code, custom settings, custom metadata or records.
- Code Analyzer flags four constants and a map as possible hard-coded credentials. Two constants hold the credential's API **name** (`Flow_Tooling_API`), one holds Salesforce's standard token path, one is the unreadable-configuration error message (reported three times), and the map is built from the admin's own input. None is a hard-coded secret. Salesforce Graph Engine did not finish on every entry point, so the scans are not a clean bill of health.
- `System.debug` is used in three places, for failures of background work, and logs only the error message. Nothing sensitive is logged.

## Not applicable

- **Dynamic scanning (DAST).** Tributary has no endpoints outside Salesforce: no website, web service, API, mobile app or browser extension. All its traffic is Lightning's own channel and Salesforce's own REST APIs.
- **Third-party libraries.** None. SLDS icons are used under their licence (see `NOTICE`); the diff, merge, layout and XML code is original.
- **Guest and Experience Cloud users.** Tributary has no public pages. Its tabs and Apex classes are only granted through the two permission sets.
