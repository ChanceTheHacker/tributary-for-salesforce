# Setting up Tributary

This guide covers an org that has the package installed, or has had `force-app` deployed to it. Once the app can reach the org, everything else is done in the app itself.

## 1. Assign the permission sets

| Permission set      | Gives                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tributary User**  | Compare and merge flows, save merged versions (Tributary Save custom permission), request activations, and see governed flows and their history.     |
| **Tributary Admin** | Everything in Tributary User, plus governing flows, approving any activation, and running setup and the monitor (Tributary Admin custom permission). |

Saving to this org also needs **Manage Flow**. Activating an ungoverned flow (or one with enforcement Off) needs it too, unless the caller is a Tributary admin or the recorded owner. Admins and recorded owners have delegated approval authority through the integration user; they do not need Manage Flow themselves. Saving to another org needs the Tributary permission set, because the app saves there as that org's integration user.

Assign **Tributary Admin** to yourself first. Everything below happens on the **Tributary Setup** tab in the Tributary app.

**Local credential visibility (source change, 2026-10-02).** Every caller must be able to inspect the local named and external credential configurations through Salesforce `ConnectApi`. If either configuration is missing, unreadable or does not match this org, Tributary refuses the call **before authentication**; there is no post-login identity fallback. The permission sets do not automatically grant **View Setup and Configuration**. An administrator must assess and grant appropriate visibility, then verify comparison using the caller's own session. Green setup checks in an administrator's session do not prove a normal user's access. Ordinary-user permissions and managed-subscriber behavior still require installation testing before release.

These permissions delegate flow-metadata reads through the integration user; they do not reproduce the caller's Flow Builder visibility. Assign them only to people trusted to review the connected orgs' flow metadata.

## 2. Create the external client app

The app reads, saves and activates flow versions through the Tooling API. It signs in with the OAuth client credentials flow, so no user has to authorize it.

Since Spring '26, new orgs create **External Client Apps** rather than connected apps. An org that can still create connected apps can use one instead, with the same settings.

1. Setup → **External Client App Manager** → **New External Client App**. Give it a name (such as "Tributary") and a contact email, and leave **Distribution State** as **Local**.
2. Under **API (Enable OAuth Settings)**, turn on OAuth and add the **Manage user data via APIs (api)** scope. Any callback URL will do, because the flow doesn't use it. Tick **Enable Client Credentials Flow**, then create the app.
3. On the app's **Policies** tab, choose **Edit**, tick **Enable Client Credentials Flow** under OAuth Policies, and set **Run As** to an integration user. Save.
   - The Run As user must be able to read and deploy flows. That means **Modify Metadata Through Metadata API Functions** plus **Manage Flow**, or **Modify All Data**.
   - It also needs **View Setup and Configuration**, so the app can read the Setup Audit Trail and tell who activated a flow.
4. On the **Settings** tab, open **OAuth Settings** → **Consumer Key and Secret**, and keep that page open for the next step.

Activations the app makes are recorded in Salesforce under the Run As user. The app's own history records the person who asked for each one.

## 3. Work through the setup page

**Tributary Setup** checks each step and offers a fix for anything that's missing. Admins can also choose **Set up step by step**, which takes them through the same steps one at a time, starting with the external client app from step 2, and ends with starting the automatic checks:

| Step                                   | Fix                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The credential points at this org      | **Point it at this org** sets the Flow Tooling API named credential, and the token URL of its external credential, to this org's My Domain. The package ships them pointing at a placeholder (`https://login.salesforce.com`), so this is always the first step after an install.                           |
| The credential signs in at this org    | Checks that the token URL is this org's `/services/oauth2/token`. The same **Point it at this org** fixes it. Until both URLs are this org's, Tributary refuses to store or send the consumer key and secret.                                                                                               |
| Client credentials are stored          | **Enter credentials** asks for the consumer key and secret from step 2. They are stored encrypted in the external credential and never shown again.                                                                                                                                                         |
| Tributary users can use the credential | In the installed package, both permission sets already include the credential's `AppIdentity` principal. If this step ever shows a problem there, reinstall or upgrade Tributary; the packaged permission sets can't be edited. In an org where the source was deployed directly, **Grant access** adds it. |
| Callouts are turned on                 | Salesforce turns **Enabled for Callouts** off whenever an app changes where a credential points, and only an admin can turn it back on. **Open Named Credentials**, then **Flow Tooling API** → **Edit** → tick **Enabled for Callouts** → **Save**, and check again.                                       |
| The app can reach this org             | **Test** signs in, checks that it reached this org, reads a flow definition and reads the Setup Audit Trail. A warning here means the Run As user can't read the audit trail.                                                                                                                               |
| Owners can be notified                 | Checks that the Flow Governance Alert notification type exists. It comes with the package.                                                                                                                                                                                                                  |

In a new install the order is: point the credential at this org, store the key and secret, check access, turn callouts back on, then test. **Set up step by step** follows the same order.

When every step is green, open the **Compare Flows** tab. [`walkthrough.md`](walkthrough.md) takes a new admin through merging two edits of a flow, and bringing one flow's steps into another.

## 4. Connect other orgs (optional)

To compare or merge a flow across orgs (for example sandbox → production), each extra org needs three things:

1. **An external client app in that org.** Set it up the same way as step 2, with its own Run As user.
2. **Credentials in this org.** Setup → Named Credentials:
   - **External credential:** authentication protocol **OAuth 2.0**, flow **Client Credentials with Client Secret**, and identity provider URL `https://<other-org-domain>/services/oauth2/token`.
   - **Principal:** a named principal whose consumer key and secret are the other org's.
   - **Access:** the packaged permission sets can't be edited, so create a permission set of your own (such as "Tributary Connections"). Add the principal to it under **External Credential Principal Access**, and assign it to everyone who has Tributary User or Tributary Admin.
   - **Named credential:** URL `https://<other-org-domain>`, using that external credential, with **Generate Authorization Header** on. Under **Managed Package Access**, add `trib` to **Allowed Namespaces**, or the app can't use it.
3. **A Flow Connection record.** Setup → Custom Metadata Types → **Flow Connection** → Manage Records → New:
   - **Label:** the name users see, such as "Production" or "UAT sandbox".
   - **Flow Connection Name:** the connection's key. Links and history use it, so don't rename it later.
   - **Named Credential:** the API name of the named credential from step 2.
   - **Is Production:** tick it for a production org. The save dialog then warns before anyone saves a merged flow there.

Use **Test all** under **Orgs** on the setup page to check every connection. After that, the **Two orgs** mode on the Compare Flows tab can pick the new org.

## 5. Govern flows

On the **Governed Flows** tab, **Govern a flow** records an owner and a mode for a flow in any connected org. The version that's active at that moment becomes the approved version.

| Mode                                   | What happens                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Off                                    | Nothing is enforced. The owner is recorded and activation requests still go to them.                                                                                   |
| Owner only (stored as `Watch`)         | Only the owner's outside activations are accepted when the audit evidence matches; anyone else's activation is reverted to the approved version and the owner is told. |
| Approval required (stored as `Locked`) | Every activation needs approval in Tributary. Any activation outside Tributary, even the owner's, is reverted when monitoring runs.                                    |

- **Who can activate.** Tributary admins and the flow's owner see **Activate** on the Compare tab's Activate panel, in every mode. Anyone else sees **Request activation**, which notifies the owner. A flow that isn't governed, or is governed with mode Off, can be activated by any Tributary user who could activate it in Flow Builder. In another org, only admins can activate it, because the app activates there as the integration user.
- **Owners.** An owner must be an active user of this org who can sign in to it: users with **API Only User** can't own governed flows, because they couldn't open a request to approve it.
- **Requests.** Requests wait on the **Flow Approvals** tab under **Waiting for me**. A flow with no owner notifies nobody. Its requests wait in every admin's list instead. Approving queues the activation. Keep the page open for the result: acceptance into the queue is not confirmation that the version is active. The worker checks permissions again. If the version was edited after the request or its recorded review, the activation is refused; compare again and make a new request. Comments can contain up to 32,768 characters; an oversized comment or serialized queue payload is rejected before activation rather than silently truncated.
- **Policy changes (source change, 2026-10-02).** Changing the owner or mode, governing a previously ungoverned flow, or removing governance cancels that flow's pending requests. Compare again and submit a fresh request under the new policy. Label-only edits preserve them; completed requests and other flows are unchanged. A mutation with more than 2,000 pending requests is refused rather than partially applied.
- **Approved version.** Governing a flow approves whichever version is active at that moment. Switching a flow from Off to Watch or Locked does the same, because anything could have been activated while it was Off. In Off mode the approved version simply follows the active one.
- **Checks and reverts.** An activation made outside the app is only reverted when a check runs. Checks happen through **Run check now** on Governed Flows, or through the **Governance monitor** on the setup page, which runs every 5 to 60 minutes as the admin who started it. The **Last checked** column shows how each flow's last check went. Each check covers **every governed flow**, 25 flows per queued job, watched and enforced flows first and then the least recently attempted. Each job queues the next until every flow has been tried once. A failed attempt keeps the last successful audit-trail checkpoint. A flow that an activation or approval is under way for is skipped and tried again later in the same check; if it is still busy at the end, it is left for the next check. The monitor reports a check with any failed flows as **Checked with errors**, and says how many flows were left. Only one check runs at a time: a second manual check is refused as busy, and a scheduled check skips its turn. Activations, approvals and governance edits wait only for operations on the same flow.
- **The Setup Audit Trail.** Watch mode reads the audit trail to see who activated a version. If the Run As user can't read it, Watch mode reports an error for the flow instead of reverting. Locked mode doesn't need to know who activated a version, so it still reverts.
- **Other orgs.** Watch mode can't recognise the owner's activations in another org, because the owner is a user of this org. In another org, Watch behaves like Locked: every activation outside the app is reverted. Govern each org through a single Flow Connection. Two connections to the same org would be two records with separate approved versions.
- **History.** Every request, decision, activation and revert is recorded in the history panel on Governed Flows. It shows the latest 25 events grouped by day, and **Show older activity** loads more.

- **Uncertain outcomes.** Closing the page, losing the connection or reaching the three-minute polling limit does not cancel a queued operation. Check activation history, the active version and per-flow check results before submitting again. Aborted or failed Apex jobs release their claim on polling or the next enqueue. So does a job more than an hour old that Salesforce has purged from its job history. A merely slow job is not unlocked on a timer. Temporary operation results expire after 24 hours and are cleaned up in batches on subsequent operations; this does not delete request or audit history.

## 6. Limits

- Salesforce itself doesn't stop someone with Manage Flow from activating in Flow Builder. The app catches it afterwards and reverts. To prevent it entirely, don't give builders Manage Flow in production: they request activations and the app's integration user performs them.
- The committed per-flow claims serialize this installation's actions on each flow, not Flow Builder, direct API changes or another installation. Salesforce API changes and local audit writes are not a distributed transaction: an interrupted job may have changed the flow even if its final receipt is missing. Recheck the actual active version before retrying. The review timestamp check also cannot prevent an external edit between the final read and activation.
- Watch mode accepts an owner audit event only if its action/version matches the observed state and it does not predate the last successful check. The API and audit trail are separate snapshots, not proof against concurrent external changes.
- The 25-flow job size and the call-count guard avoid exhausting the callout-count limit for ordinary reads/reverts. A check sets its queue's chain depth explicitly, so a Developer Edition org's default of five chained jobs doesn't stop it partway through a long list. Slow endpoints and unusually large paginated responses can still hit Salesforce's time, heap or other governor limits.
- Managed-package flows can be compared but not saved over.
- A merged flow is always saved as a new **inactive** version or a new inactive flow. Activating it goes through the same rules as any other version.
- If the save dialog is closed while a save is running, the save still finishes. A message appears if it fails.
- A draft can be created successfully even if the following confirmation read or history write fails. In that case, the error identifies the draft and asks you to inspect the destination org's flow versions and history before retrying. Do not assume a save error means no draft exists; retrying can create another version.
