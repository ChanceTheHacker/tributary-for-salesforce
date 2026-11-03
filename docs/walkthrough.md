# Walkthrough: merge two edits of a flow, or combine two flows

Tributary does two different jobs, and each one starts differently. This page takes a new admin through both, using one set of made-up flows, so every step can be tried without touching real automation. Set the app up first with [`setup.md`](setup.md).

Everything below is done by clicking. Nothing needs the flow's XML, although the **XML merge** is there for anyone who prefers it.

## Which job is it?

| You have                                                   | On the Compare Flows tab, choose                                                                  | You get                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Two edits of one flow, both made from the same version     | **Versions of a flow**, then turn on **Three-way merge** and choose the version both started from | A three-way merge. Changes only one side made are taken for you. You decide only where both changed the same thing.        |
| The same flow in two orgs                                  | **Two orgs**                                                                                      | A two-way merge. You pick a side for each difference.                                                                      |
| Two different flows, and you want one's steps in the other | **Two flows**                                                                                     | A two-way merge with a mapping. B's elements are brought into A, using A's variables and records wherever you map them to. |

Whichever it is, saving adds an **inactive** version, or an inactive new flow. Nothing changes for users until a version is activated, and activating goes through the flow's approval rules ([`setup.md`](setup.md) §5).

## The example flows

`test/e2e/seed-flows.js` puts made-up flows in a dev org as inactive drafts and never activates anything (see [`test/e2e/README.md`](../test/e2e/README.md)). This page uses two groups of them:

- **`UAT_Discounts_A`**, in three versions: a base, and two separate edits of it. In `tributary-dev` they're versions 6, 7 and 8. Another org will number them differently.
- **Three Case triage flows** that do related work from different starts:
  - `UAT_Case_Triage_Record` runs when a case is created or changed.
  - `UAT_Case_Triage_Sub` is a subflow that's handed the case as a `caseRecord` input.
  - `UAT_Case_Screen` is a screen flow that's given a `recordId` and looks the case up with **Get Case**.

Never activate `UAT_Case_Triage_Record`. It's record-triggered, so it would run on every case saved in the org.

## Job 1: merge two edits of a flow

1. **Pick them.** Choose **Versions of a flow** and pick `UAT_Discounts_A`. Choose version 7 as **Version A** and version 8 as **Version B**.
   - The **Compare** tab draws both. Added elements are green, removed ones red and changed ones amber.
   - Select an element to see its changed fields, old value and new.
2. **Give it a base.** Turn on **Three-way merge** and choose version 6 as the **Common base**. Then open the **Merge** tab.
3. **Settle the conflicts.** **Visual merge** opens with every change only one side made already taken. The panel beside the canvas has tabs:
   - **Differences** lists every change. **Only unresolved conflicts** narrows the list. The arrows in the toolbar step through them.
   - Selecting an element shows its choices. A whole element, one connector or one field can each be taken from either version.
   - **Resolve all conflicts using…**, in the toolbar menu, settles every conflict at once. Undo and redo work as usual (Ctrl+Z, Ctrl+Shift+Z).
4. **Take related changes together.** The **Groups** tab collects changed elements that are joined by connectors. Take a whole group from one version, or **Select** it to look closer.
5. **Fix what's left.** The **Problems** tab lists connectors that lead nowhere, resources nothing defines and clashing names. **Save visual merge** stays off until every conflict is settled and every error is fixed. Warnings don't stop a save, but read them.
6. **Save.** See [Saving: the receipt](#saving-the-receipt) below.

## Job 2: bring one flow's steps into another

Here the Case subflow's steps go into the record-triggered flow.

1. **Pick them.** Choose **Two flows**.
   - Pick `UAT_Case_Triage_Record` as flow A, the flow that receives the steps.
   - Pick `UAT_Case_Triage_Sub` as flow B, the flow they come from.
   - Open the **Merge** tab. Because these are different flows, it opens on **Mapping**.
2. **Map what B uses.** Under **Map what it uses**, each thing the subflow takes from outside gets one row:
   - its triggering record;
   - the record before the change;
   - its input variables;
   - its Get Records results.

   Each row says what uses it and suggests the closest match in A, with **Why:** underneath. For the example, `caseRecord` is suggested as `$Record`, because both hold a Case.
   - To use something else of A's, choose it from the row's list. A choice that can't hold the value is marked as an error on the row.
   - When nothing in A should stand in for it, choose **A new … variable** (or **Bring it in as its own element**, for a Get Records result) and give it a **Name**. This is how a new variable is made.
   - A suggestion made only because the names match shows **Keep this mapping**. Check the two really hold the same thing, then keep it or choose another.
   - A Get Records result is only suggested as a record A already has when its whole query is `Id = ` that record's ID. Any other lookup is brought along. Mapping it by hand anyway is allowed, with a warning that its query is dropped.

3. **Decide on shared elements.** **In both flows** lists elements both flows name the same. Once mapped, some do the same thing and lead to the same places; choose **One element** for those. Keep both when they differ. Keeping both renames B's copy, as `Check_Priority_2`, for example.
4. **Read the summary.** Below the rows, the panel lists what was **Mapped**, the **New variables**, anything **Renamed to avoid a clash**, and resources **Not brought in, as this flow has them**. B's own start isn't brought in: its elements run from A's start, wherever they're put. **Back to the suggestions** undoes every mapping choice.
5. **Put it on a path.** **Put UAT Case Triage Sub after** chooses where B's steps start, such as straight after A's start or on one of a decision's outcomes. The canvas previews it; **Put it here** makes it so.
6. **Wire it in.** Select any element to see **Goes to**, which points each of its paths at any element in the result. This is how B's last step joins the rest of A. To move several elements at once, Shift-click or Ctrl-click them. The selection panel can then **Take them all from** one side, or **Put them on a path** after any element.
7. **Check and save.** The **Problems** tab lists anything mapped to something that can't hold it, a record that's changed but can't be, and connectors that lead nowhere. Then save it, as a new version of A or as a new flow.

   The **XML merge** of two flows uses the same mapping. Its problems are listed above the XML, and each one opens its row on the Mapping tab. A mapping error blocks saving or downloading the XML merge too, whatever the XML says, until the mapping is fixed.

The same steps work the other way round, and with the screen flow. Mapping the screen flow into the record-triggered one suggests `recordId` → `$Record.Id`, and its **Get Case** → `$Record`, so the lookup isn't needed.

## Saving: the receipt

**Save visual merge** opens the save dialog. Choose **New version of a flow** or **New flow**, and optionally a **Version description**. **What's being saved** is the receipt:

- **Fingerprint.** The SHA-256 of the exact flow being sent. The org works it out again from what arrives, and saves only if the two match.
- **Made from.** Each version the merge came from: its org, version and ID, and when and by whom it was last changed.
- **Decided.** What was chosen: which side each settled conflict came from, connectors rewired, what was mapped from the other flow, new resources and renames.
- **Checked.** Three checks, kept apart:
  - **Checked in Tributary** reads connectors, references and required parts from the metadata. It doesn't run the flow.
  - **Apex tests** aren't run by Tributary. Run the org's tests that cover the flow before it's activated.
  - **Checked by the org** happens when it's saved. The org accepting a version means its metadata is valid. That isn't proof the flow does what was intended.

The receipt goes into the flow's history on **Governed Flows**, and with the change summary on any activation request.

**When a source changed.** If a version the merge was made from was edited or deleted after it was compared, nothing is saved. The same goes for a new version of the target saved in the meantime. The dialog says what changed. **Compare again** reloads the newest versions, so the merge can be reviewed again.

**Activating it later.** An activation made from the save dialog, or a request made from it, remembers when the version was saved. If the version is edited in Flow Builder after that, approving or activating it is refused, because it's no longer what the receipt describes.

## What it can't do

- **Valid isn't equivalent.** The checks read the metadata. None of them runs the flow, and a merged flow that saves cleanly can still behave differently. Test it in a sandbox before activating it.
- **Apex tests aren't run.** Tributary doesn't run them. Run the org's own before activating.
- **Mapping covers what a flow takes from outside.** That means its triggering record, the record before the change, input variables and Get Records results. Every other resource is brought in as it is, renamed if its name clashes. A mapping suggested only because the names match is flagged until someone keeps it or chooses another.
- **Starts aren't merged.** Bringing in another flow never brings its start, trigger or schedule. Its steps run from the receiving flow's start.
- **Some staleness can't be checked.** A source without a version ID, such as a pasted or downloaded draft, can't be checked for changes. A source that has an ID but no recorded change time counts as changed.
- **The change summary is the requester's.** An activation request's change summary comes from the browser that made it. The save's own history entry, including the fingerprint and the sources the org checked, is written by the org.
- **Saving never activates.** Merges are saved inactive, and activation is always a separate step with its own approval.
