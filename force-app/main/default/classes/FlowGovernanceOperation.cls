/**
 * Activations, approvals and checks run queued, so their callouts don't hold
 * up a page. A committed claim, not a FOR UPDATE lock, spans those callouts:
 * Salesforce releases row locks on a callout.
 *
 * Claims are gates, one per flow, keyed by its org and developer name, so a
 * flow's names with and without a namespace share one. An operation waits
 * only for operations on the same flow. A check holds the sweep gate, so one
 * check runs at a time, and each slice of it claims only the flows it reads.
 *
 * Before flows had gates of their own, every operation held one shared gate.
 * An operation queued under it before an upgrade still holds it, and nothing
 * else starts until that operation ends.
 *
 * Without sharing: operations and their gates are private records, one gate
 * per flow shared by every user's operations on it, and a queued job ends
 * or recovers operations other users started. Every read and write here
 * must see all of them, or two users' operations on one flow would overlap.
 * No record is returned to a user from here except a receipt its creator,
 * or an admin, may read (status), and the request that names is read again
 * with the user's own access.
 */
public without sharing class FlowGovernanceOperation implements Queueable, Database.AllowsCallouts, Finalizer {
    private static final String BUSY = 'Another governance operation on this flow is queued or running. Wait for it to finish, then try again.';
    private static final String CHECK_BUSY = 'A check is already queued or running. Wait for it to finish, then try again.';
    private static final String STOPPED_ERROR = 'The job stopped. The flow may have changed; verify its active version and history before retrying.';
    private static final String LEGACY_BUSY = 'An operation queued before Tributary was updated is still queued or running. Wait for it to finish, then try again.';
    private static final String LEGACY_CHECK = 'This check was queued before Tributary was updated, so it didn\'t run. Start the check again.';
    // The gate every operation shared before each flow had its own. Nothing
    // claims it now, so once free it stays free.
    private static final String LEGACY_GATE = 'governance';
    // The gate a check holds from its first slice to its last.
    private static final String SWEEP_GATE = 'check';
    // Flows per check job. Even across 25 different orgs, reads and reverts
    // fit the 100-callout budget.
    private static final Integer SLICE = 25;
    private static final Set<String> STOPPED_JOBS = new Set<String>{ 'Aborted', 'Failed' };
    // A job is listed in AsyncApexJob from the moment it's queued, and kept
    // for days after it ends, so a job missing from it stopped long ago. This
    // is a margin on that, not a lease: a slow job is never taken for stopped.
    private static final Integer MISSING_JOB_HOURS = 1;
    private Id operationId;
    private static Id running;

    public FlowGovernanceOperation(Id operationId) {
        this.operationId = operationId;
    }

    public class Status {
        @AuraEnabled
        public String state;
        @AuraEnabled
        public String result;
        @AuraEnabled
        public String error;
        // A check's counts, exact however many results its receipt kept:
        // flows tried, checked, failed, and left for the next check.
        @AuraEnabled
        public Integer attempted;
        @AuraEnabled
        public Integer succeeded;
        @AuraEnabled
        public Integer failed;
        @AuraEnabled
        public Integer remaining;
    }

    // A check's plan, kept in its payload from one job to the next.
    public class Sweep {
        // When the check began: a flow tried since then is done.
        public Datetime since;
        // The governed flows this job checks.
        public List<Id> ids;
        public Integer slices;
        // Enough slices for every flow once, and one more; a flow skipped
        // again and again can't keep a check going.
        public Integer maxSlices;
        // Flows whose result couldn't be saved. They still look due, so
        // they're left out of later slices rather than tried again and again.
        public List<Id> unsaved = new List<Id>();
    }

    public static Id activate(FlowGovernanceService.RequestInput input) {
        FlowGovernanceService.authorizeActivation(input);
        return enqueue('activate', JSON.serialize(input), gateKey(input.connection, input.apiName));
    }

    public static Id approve(Id requestId, String comments) {
        Flow_Activation_Request__c request = FlowGovernanceService.authorizeApproval(requestId);
        FlowGovernanceService.validateComments(comments);
        return enqueue(
            'approve',
            JSON.serialize(new Map<String, Object>{ 'id' => requestId, 'comments' => comments }),
            gateKey(request.Connection__c, request.Flow_Api_Name__c)
        );
    }

    /** Checks every governed flow, a slice per job, until each has been tried once. */
    public static Id check() {
        FlowGovernanceService.requireAdmin();
        return startCheck(false);
    }

    /** A scheduled check leaves it to the running check when there is one. */
    public static void scheduledCheck() {
        FlowGovernanceService.requireAdmin();
        Savepoint start = Database.setSavepoint();
        try {
            startCheck(true);
        } catch (FlowGovernanceService.GovernanceException e) {
            // Its gates were being claimed at that moment; the next run starts one.
            Database.rollback(start);
            System.debug(LoggingLevel.WARN, 'Scheduled governance check skipped: ' + e.getMessage());
        }
    }

    /**
     * The gate for a flow: its org and developer name, so its names with and
     * without a namespace share one. Hashed to fit the key field.
     */
    public static String gateKey(String connection, String apiName) {
        String name;
        try {
            name = new FlowToolingClient.FlowName(apiName).developerName;
        } catch (Exception e) {
            // Not a flow name, so no activation can name it; it still gets a gate.
            name = String.valueOf(apiName);
        }
        String flow = FlowToolingClient.normalizeConnection(connection) + ':' + name;
        return 'flow:' + EncodingUtil.convertToHex(Crypto.generateDigest('SHA-256', Blob.valueOf(flow.toLowerCase())));
    }

    private static Id enqueue(String action, String payload, String key) {
        if (payload.length() > Flow_Operation__c.Payload__c.getDescribe().getLength()) {
            throw new FlowGovernanceService.GovernanceException(
                'The activation review and comments are too large to queue. Shorten them before trying again.'
            );
        }
        Flow_Operation__c gate = lockGates(new Set<String>{ key }, true).get(key);
        recoverStopped(new List<Flow_Operation__c>{ gate });
        requireIdle(gate, BUSY);
        requireNoLegacy();
        Flow_Operation__c operation = newOperation(action, payload);
        operation.Job_Id__c = System.enqueueJob(new FlowGovernanceOperation(operation.Id));
        Database.update(operation, AccessLevel.SYSTEM_MODE);
        claim(new List<Flow_Operation__c>{ gate }, operation.Id);
        return operation.Id;
    }

    private static Id startCheck(Boolean skipBusy) {
        Flow_Operation__c sweepGate = lockGates(new Set<String>{ SWEEP_GATE }, true).get(SWEEP_GATE);
        recoverStopped(new List<Flow_Operation__c>{ sweepGate });
        if (skipBusy && sweepGate.Active_Operation__c != null)
            return null;
        requireIdle(sweepGate, CHECK_BUSY);
        requireNoLegacy();
        Flow_Operation__c operation = newOperation('check', null);
        Sweep sweep = new Sweep();
        // Whole seconds, as Last Check Attempt keeps them, so a flow tried in
        // this second counts as tried.
        sweep.since = Datetime.newInstance(System.now().getTime() / 1000 * 1000);
        sweep.slices = 0;
        sweep.maxSlices = [SELECT COUNT() FROM Flow_Governance__c WITH SYSTEM_MODE] / SLICE + 2;
        sweep.ids = claimSlice(operation.Id, sweep);
        operation.Payload__c = JSON.serialize(sweep);
        operation.Job_Id__c = System.enqueueJob(new FlowGovernanceCheckJob(operation.Id), chainOptions(sweep));
        Database.update(operation, AccessLevel.SYSTEM_MODE);
        claim(new List<Flow_Operation__c>{ sweepGate }, operation.Id);
        return operation.Id;
    }

    // Developer Edition and trial orgs stop a chain of queued jobs at five
    // unless its first job says how deep it may go; the sweep's own limit on
    // slices still ends it.
    @TestVisible
    private static AsyncOptions chainOptions(Sweep sweep) {
        AsyncOptions options = new AsyncOptions();
        options.MaximumQueueableStackDepth = sweep.maxSlices + 1;
        return options;
    }

    private static Flow_Operation__c newOperation(String action, String payload) {
        // Polling receipts are temporary, not the activation/audit history.
        // Bounded cleanup keeps scheduled checks from filling org storage.
        Datetime cutoff = System.now().addDays(-1);
        List<Flow_Operation__c> expired = [
            SELECT Id
            FROM Flow_Operation__c
            WHERE Key__c = NULL AND State__c IN ('Completed', 'Failed') AND LastModifiedDate < :cutoff
            WITH SYSTEM_MODE
            LIMIT 100
        ];
        Database.delete(expired, AccessLevel.SYSTEM_MODE);
        Flow_Operation__c operation = new Flow_Operation__c(
            Action__c = action,
            Payload__c = payload,
            State__c = 'Queued'
        );
        Database.insert(operation, AccessLevel.SYSTEM_MODE);
        return operation;
    }

    // Claims the next flows a check should read: enforced flows before those
    // with governance off, least recently tried first. A flow another
    // operation holds is left for a later slice, or the next check.
    private static List<Id> claimSlice(Id operationId, Sweep sweep) {
        List<Flow_Governance__c> due = FlowGovernanceService.dueForCheck(sweep.since, SLICE * 4, sweep.unsaved);
        Map<Id, String> keys = new Map<Id, String>();
        for (Flow_Governance__c record : due) {
            keys.put(record.Id, gateKey(record.Connection__c, record.Flow_Api_Name__c));
        }
        Map<String, Flow_Operation__c> gates = lockGates(new Set<String>(keys.values()), false);
        recoverStopped(gates.values());
        List<Id> ids = new List<Id>();
        Map<Id, Flow_Operation__c> claimed = new Map<Id, Flow_Operation__c>();
        for (Flow_Governance__c record : due) {
            Flow_Operation__c gate = gates.get(keys.get(record.Id));
            if (gate == null || ids.size() == SLICE) {
                continue;
            }
            if (gate.Active_Operation__c == null) {
                gate.Active_Operation__c = operationId;
                claimed.put(gate.Id, gate);
            }
            // A flow governed under both its names shares its gate.
            if (gate.Active_Operation__c == operationId) {
                ids.add(record.Id);
            }
        }
        claim(claimed.values(), operationId);
        return ids;
    }

    // Called before reads/callouts, then checked again under a lock before DML.
    public static Decimal revision(String key) {
        // A stopped operation's claim is released by guardWrite, which can write.
        List<Flow_Operation__c> legacy = legacyHeld();
        if (!legacy.isEmpty() && stopped(legacy).isEmpty()) {
            requireIdle(legacy[0], LEGACY_BUSY);
        }
        List<Flow_Operation__c> gates = [
            SELECT Active_Operation__c, Revision__c
            FROM Flow_Operation__c
            WHERE Key__c = :key
            WITH SYSTEM_MODE
        ];
        if (gates.isEmpty())
            return 0;
        if (stopped(gates).isEmpty()) {
            requireIdle(gates[0], BUSY);
        }
        return revisionOf(gates[0]);
    }

    public static void guardWrite(String key, Decimal expected) {
        Flow_Operation__c gate = lockGates(new Set<String>{ key }, true).get(key);
        recoverStopped(new List<Flow_Operation__c>{ gate });
        requireIdle(gate, BUSY);
        requireNoLegacy();
        if (expected != null && expected != revisionOf(gate)) {
            throw new FlowGovernanceService.GovernanceException(
                'Governance changed while it was being read. Refresh and try again.'
            );
        }
        gate.Revision__c = revisionOf(gate) + 1;
        Database.update(gate, AccessLevel.SYSTEM_MODE);
    }

    private static Decimal revisionOf(Flow_Operation__c gate) {
        return gate.Revision__c == null ? 0 : gate.Revision__c;
    }

    // Locks the gates with these keys, creating any that don't exist yet.
    // When two operations create one at once, the second finds it busy:
    // strict refuses, otherwise that flow is left out.
    private static Map<String, Flow_Operation__c> lockGates(Set<String> keys, Boolean strict) {
        Map<String, Flow_Operation__c> gates = new Map<String, Flow_Operation__c>();
        try {
            for (Flow_Operation__c gate : [
                SELECT Id, Key__c, Active_Operation__c, Revision__c
                FROM Flow_Operation__c
                WHERE Key__c IN :keys
                WITH SYSTEM_MODE
                FOR UPDATE
            ]) {
                gates.put(gate.Key__c, gate);
            }
        } catch (QueryException e) {
            throw new FlowGovernanceService.GovernanceException(keys.contains(SWEEP_GATE) ? CHECK_BUSY : BUSY);
        }
        List<Flow_Operation__c> created = new List<Flow_Operation__c>();
        for (String key : keys) {
            if (!gates.containsKey(key)) {
                created.add(new Flow_Operation__c(Key__c = key, Revision__c = 0));
            }
        }
        List<Database.SaveResult> saved = Database.insert(created, false, AccessLevel.SYSTEM_MODE);
        for (Integer i = 0; i < saved.size(); i++) {
            if (saved[i].isSuccess()) {
                gates.put(created[i].Key__c, created[i]);
            } else if (strict) {
                // No unsafe retry.
                throw new FlowGovernanceService.GovernanceException(keys.contains(SWEEP_GATE) ? CHECK_BUSY : BUSY);
            }
        }
        return gates;
    }

    private static void claim(List<Flow_Operation__c> gates, Id operationId) {
        for (Flow_Operation__c gate : gates) {
            gate.Active_Operation__c = operationId;
            gate.Revision__c = revisionOf(gate) + 1;
        }
        Database.update(gates, AccessLevel.SYSTEM_MODE);
    }

    // The operations holding these gates whose jobs stopped without ending
    // them: aborted, failed, or gone.
    private static Set<Id> stopped(List<Flow_Operation__c> gates) {
        Set<Id> holders = new Set<Id>();
        for (Flow_Operation__c gate : gates) {
            if (gate.Active_Operation__c != null) {
                holders.add((Id) gate.Active_Operation__c);
            }
        }
        Set<Id> ended = new Set<Id>();
        if (holders.isEmpty()) {
            return ended;
        }
        // An operation that already ended, or no longer exists, has stopped too.
        List<Flow_Operation__c> queued = new List<Flow_Operation__c>();
        Set<Id> found = new Set<Id>();
        for (Flow_Operation__c operation : [
            SELECT Id, State__c, Job_Id__c, CreatedDate
            FROM Flow_Operation__c
            WHERE Id IN :holders
            WITH SYSTEM_MODE
        ]) {
            found.add(operation.Id);
            if (operation.State__c != 'Queued') {
                ended.add(operation.Id);
            } else {
                queued.add(operation);
            }
        }
        for (Id holder : holders) {
            if (!found.contains(holder)) {
                ended.add(holder);
            }
        }
        ended.addAll(stoppedJobs(queued));
        return ended;
    }

    // The queued operations among these whose jobs stopped: aborted, failed,
    // or purged from AsyncApexJob. One with no job yet hasn't stopped.
    private static Set<Id> stoppedJobs(List<Flow_Operation__c> operations) {
        Map<Id, Flow_Operation__c> byJob = new Map<Id, Flow_Operation__c>();
        for (Flow_Operation__c operation : operations) {
            if (operation.Job_Id__c != null) {
                byJob.put((Id) operation.Job_Id__c, operation);
            }
        }
        Set<Id> ended = new Set<Id>();
        if (byJob.isEmpty()) {
            return ended;
        }
        Set<Id> listed = new Set<Id>();
        for (AsyncApexJob job : [SELECT Id, Status FROM AsyncApexJob WHERE Id IN :byJob.keySet() WITH SYSTEM_MODE]) {
            listed.add(job.Id);
            if (STOPPED_JOBS.contains(job.Status)) {
                ended.add(byJob.get(job.Id).Id);
            }
        }
        Datetime settled = System.now().addHours(-MISSING_JOB_HOURS);
        for (Id job : byJob.keySet()) {
            if (!listed.contains(job) && byJob.get(job).CreatedDate < settled) {
                ended.add(byJob.get(job).Id);
            }
        }
        return ended;
    }

    // Ends the operations whose jobs stopped, releasing every gate they hold.
    // All at once, so many stopped operations cost no more than one.
    private static void recoverStopped(List<Flow_Operation__c> gates) {
        Set<Id> ended = stopped(gates);
        if (ended.isEmpty()) {
            return;
        }
        Set<String> holders = new Set<String>();
        for (Id operation : ended) {
            holders.add(operation);
        }
        List<Flow_Operation__c> failed = new List<Flow_Operation__c>();
        for (Flow_Operation__c operation : [
            SELECT Id
            FROM Flow_Operation__c
            WHERE Id IN :ended AND State__c = 'Queued'
            WITH SYSTEM_MODE
        ]) {
            failed.add(
                new Flow_Operation__c(
                    Id = operation.Id,
                    State__c = 'Failed',
                    Error__c = STOPPED_ERROR,
                    Payload__c = null
                )
            );
        }
        List<Flow_Operation__c> held = lockHeld(holders);
        for (Flow_Operation__c gate : held) {
            gate.Active_Operation__c = null;
        }
        Database.update(failed, AccessLevel.SYSTEM_MODE);
        Database.update(held, AccessLevel.SYSTEM_MODE);
        for (Flow_Operation__c gate : gates) {
            if (gate.Active_Operation__c != null && ended.contains((Id) gate.Active_Operation__c)) {
                gate.Active_Operation__c = null;
            }
        }
    }

    private static void requireIdle(Flow_Operation__c gate, String busy) {
        if (gate.Active_Operation__c != null)
            throw new FlowGovernanceService.GovernanceException(busy);
    }

    // The shared gate, while an operation queued before the upgrade holds it.
    // Read without a lock: it can only become free.
    private static List<Flow_Operation__c> legacyHeld() {
        return [
            SELECT Id, Key__c, Active_Operation__c, Revision__c
            FROM Flow_Operation__c
            WHERE Key__c = :LEGACY_GATE AND Active_Operation__c != NULL
            WITH SYSTEM_MODE
        ];
    }

    // Nothing starts while an operation queued before the upgrade is still
    // running. One whose job stopped is ended here.
    private static void requireNoLegacy() {
        List<Flow_Operation__c> legacy = legacyHeld();
        if (legacy.isEmpty())
            return;
        recoverStopped(legacy);
        requireIdle(legacy[0], LEGACY_BUSY);
    }

    public static Status status(Id id) {
        List<Flow_Operation__c> found = [
            SELECT
                Id,
                CreatedById,
                Action__c,
                State__c,
                Result__c,
                Error__c,
                Job_Id__c,
                CreatedDate,
                Attempted__c,
                Succeeded__c,
                Failed__c,
                Remaining__c
            FROM Flow_Operation__c
            WHERE Id = :id AND Key__c = NULL
            WITH SYSTEM_MODE
        ];
        if (found.isEmpty() || (found[0].CreatedById != UserInfo.getUserId() && !FlowGovernanceService.isAdmin())) {
            throw new FlowGovernanceService.GovernanceException('You cannot read that governance operation.');
        }
        Flow_Operation__c operation = found[0];
        if (operation.State__c == 'Queued' && !stoppedJobs(new List<Flow_Operation__c>{ operation }).isEmpty()) {
            finish(new Flow_Operation__c(Id = id), STOPPED_ERROR);
            operation = [
                SELECT Action__c, State__c, Result__c, Error__c, Attempted__c, Succeeded__c, Failed__c, Remaining__c
                FROM Flow_Operation__c
                WHERE Id = :id
                WITH SYSTEM_MODE
            ];
        }
        Status result = new Status();
        result.state = operation.State__c;
        result.result = operation.Result__c;
        result.error = operation.Error__c;
        if (operation.Action__c == 'check') {
            result.attempted = operation.Attempted__c?.intValue();
            result.succeeded = operation.Succeeded__c?.intValue();
            result.failed = operation.Failed__c?.intValue();
            result.remaining = operation.Remaining__c?.intValue();
            result.result = visibleResults(operation.Result__c);
        }
        if (operation.State__c == 'Completed' && operation.Action__c != 'check' && operation.Result__c != null) {
            // A decision's receipt names its request; the request as it stands,
            // as the user may read it, is the result.
            Map<String, Object> receipt = (Map<String, Object>) JSON.deserializeUntyped(operation.Result__c);
            if (receipt.get('requestId') != null) {
                result.result = JSON.serialize(
                    FlowGovernanceController.load(
                        new Flow_Activation_Request__c(
                            Id = (Id) (String) receipt.get('requestId'),
                            Status__c = (String) receipt.get('status')
                        )
                    )
                );
            }
        }
        return result;
    }

    // A check sees every governed flow, whatever the admin who runs it may
    // read, but tells them only about the flows they can see. A result shows
    // the flow's name, connection, versions and outcome, so the user must be
    // able to read those fields too: without any of them, user mode refuses
    // the query and no flow is shown. The counts still cover every flow, so a
    // check that failed somewhere still says so.
    private static String visibleResults(String stored) {
        if (stored == null) {
            return null;
        }
        List<FlowGovernanceService.CheckResult> results = (List<FlowGovernanceService.CheckResult>) JSON.deserialize(
            stored,
            List<FlowGovernanceService.CheckResult>.class
        );
        Set<Id> ids = new Set<Id>();
        for (FlowGovernanceService.CheckResult checked : results) {
            ids.add(checked.governanceId);
        }
        Set<Id> visible = new Set<Id>();
        try {
            visible = new Map<Id, Flow_Governance__c>(
                    [
                        SELECT
                            Id,
                            Flow_Api_Name__c,
                            Connection__c,
                            Active_Version__c,
                            Approved_Version__c,
                            Last_Check_Outcome__c,
                            Last_Check_Message__c
                        FROM Flow_Governance__c
                        WHERE Id IN :ids
                        WITH USER_MODE
                    ]
                )
                .keySet();
        } catch (QueryException e) {
            // No read on governance, or on a field a result shows: no flow to
            // tell them about.
        }
        List<FlowGovernanceService.CheckResult> shown = new List<FlowGovernanceService.CheckResult>();
        for (FlowGovernanceService.CheckResult checked : results) {
            if (visible.contains(checked.governanceId)) {
                shown.add(checked);
            }
        }
        return shown.size() == results.size() ? stored : JSON.serialize(shown, true);
    }

    public void execute(QueueableContext context) {
        executeOperation(operationId, context.getJobId());
    }

    public static void executeOperation(Id id, Id jobId) {
        Flow_Operation__c operation = [
            SELECT Action__c, Payload__c, State__c, Job_Id__c, Result__c, Attempted__c, Succeeded__c, Failed__c
            FROM Flow_Operation__c
            WHERE Id = :id
            WITH SYSTEM_MODE
        ];
        // Only the job the operation last queued runs it, and only while it
        // still holds its claims.
        if (
            operation.Job_Id__c != jobId ||
            operation.State__c != 'Queued' ||
            [SELECT COUNT() FROM Flow_Operation__c WHERE Active_Operation__c = :id WITH SYSTEM_MODE] == 0
        )
            return;
        // A check queued before checks ran in slices has no plan to follow.
        if (operation.Action__c == 'check' && operation.Payload__c == null) {
            finish(new Flow_Operation__c(Id = id), LEGACY_CHECK);
            return;
        }
        running = id;
        System.attachFinalizer(new FlowGovernanceOperation(id));
        Flow_Operation__c outcome = new Flow_Operation__c(Id = id);
        Sweep sweep;
        String error;
        try {
            if (operation.Action__c == 'check') {
                FlowGovernanceService.requireAdmin();
                sweep = (Sweep) JSON.deserialize(operation.Payload__c, Sweep.class);
                // A check queued before flows were set aside has no list of them.
                if (sweep.unsaved == null) {
                    sweep.unsaved = new List<Id>();
                }
                List<FlowGovernanceService.CheckResult> results = FlowGovernanceService.checkFlows(sweep.ids);
                tally(operation, outcome, results);
                noteUnsaved(sweep, results);
            } else {
                Flow_Activation_Request__c request;
                if (operation.Action__c == 'activate') {
                    request = FlowGovernanceService.activateNow(
                        (FlowGovernanceService.RequestInput) JSON.deserialize(
                            operation.Payload__c,
                            FlowGovernanceService.RequestInput.class
                        )
                    );
                } else {
                    Map<String, Object> payload = (Map<String, Object>) JSON.deserializeUntyped(operation.Payload__c);
                    request = FlowGovernanceService.approve(
                        (Id) (String) payload.get('id'),
                        (String) payload.get('comments')
                    );
                }
                // Only a small receipt is stored. The request's comments and summary
                // can fill the result field, and a failed save here would roll back
                // its history after the flow was already activated.
                outcome.Result__c = JSON.serialize(
                    new Map<String, Object>{ 'requestId' => request.Id, 'status' => request.Status__c }
                );
            }
        } catch (Exception e) {
            error =
                e.getMessage() + ' The flow may have changed; verify its active version and history before retrying.';
        } finally {
            running = null;
        }
        if (sweep != null && error == null) {
            if (continued(outcome, sweep)) {
                return;
            }
            // Flows another operation held, or that kept changing, wait for the next check.
            outcome.Remaining__c = FlowGovernanceService.countDue(sweep.since, sweep.unsaved);
        }
        finish(outcome, error);
    }

    // A flow the slice tried whose result couldn't be saved kept its last
    // attempt, so it still looks due. A skipped flow is meant to come round
    // again; anything else still due is left out of the rest of the check.
    @TestVisible
    private static void noteUnsaved(Sweep sweep, List<FlowGovernanceService.CheckResult> results) {
        Set<Id> skipped = new Set<Id>();
        for (FlowGovernanceService.CheckResult result : results) {
            if (result.outcome == 'skipped') {
                skipped.add(result.governanceId);
            }
        }
        for (Flow_Governance__c record : [
            SELECT Id
            FROM Flow_Governance__c
            WHERE Id IN :sweep.ids AND (Last_Attempt__c = NULL OR Last_Attempt__c < :sweep.since)
            WITH SYSTEM_MODE
        ]) {
            if (!skipped.contains(record.Id)) {
                sweep.unsaved.add(record.Id);
            }
        }
    }

    // Adds a slice's results to the check's, and counts how many flows it
    // tried, checked and failed on. A flow skipped by an earlier slice and
    // tried again counts once, as it ended. Messages are cut to what a
    // governed flow keeps.
    @TestVisible
    private static void tally(
        Flow_Operation__c before,
        Flow_Operation__c outcome,
        List<FlowGovernanceService.CheckResult> results
    ) {
        Set<Id> tried = new Set<Id>();
        for (FlowGovernanceService.CheckResult result : results) {
            result.message = result.message?.abbreviate(255);
            tried.add(result.governanceId);
        }
        List<FlowGovernanceService.CheckResult> all = new List<FlowGovernanceService.CheckResult>();
        Decimal retried = 0;
        if (before.Result__c != null) {
            for (
                FlowGovernanceService.CheckResult earlier : (List<FlowGovernanceService.CheckResult>) JSON.deserialize(
                    before.Result__c,
                    List<FlowGovernanceService.CheckResult>.class
                )
            ) {
                // Only a skipped flow comes round again; its tries count once.
                if (earlier.outcome == 'skipped' && tried.contains(earlier.governanceId)) {
                    retried++;
                } else {
                    all.add(earlier);
                }
            }
        }
        Integer failed = 0;
        Integer skipped = 0;
        for (FlowGovernanceService.CheckResult result : results) {
            if (FlowGovernanceService.FAILED_CHECKS.contains(result.outcome)) {
                failed++;
            } else if (result.outcome == 'skipped') {
                skipped++;
            }
        }
        outcome.Attempted__c = orZero(before.Attempted__c) - retried + results.size();
        outcome.Failed__c = orZero(before.Failed__c) + failed;
        outcome.Succeeded__c = orZero(before.Succeeded__c) + results.size() - failed - skipped;
        all.addAll(results);
        outcome.Result__c = receipt(all);
    }

    private static Decimal orZero(Decimal value) {
        return value == null ? 0 : value;
    }

    // Every result when they fit. Otherwise the ones someone should look at,
    // as many as fit; the counts still say how many flows were fine.
    private static String receipt(List<FlowGovernanceService.CheckResult> results) {
        Integer room = Flow_Operation__c.Result__c.getDescribe().getLength();
        String text = JSON.serialize(results, true);
        if (text.length() <= room) {
            return text;
        }
        List<FlowGovernanceService.CheckResult> notable = new List<FlowGovernanceService.CheckResult>();
        for (FlowGovernanceService.CheckResult result : results) {
            if (!QUIET_CHECKS.contains(result.outcome)) {
                notable.add(result);
            }
        }
        text = JSON.serialize(notable, true);
        while (text.length() > room) {
            Integer keep = notable.size() * room / text.length();
            while (notable.size() > keep) {
                notable.remove(notable.size() - 1);
            }
            text = JSON.serialize(notable, true);
        }
        return text;
    }

    // Outcomes that need no one's attention.
    private static final Set<String> QUIET_CHECKS = new Set<String>{ 'ok', 'off', 'baseline', 'accepted' };

    // After a slice, claims the next and queues the job that checks it,
    // releasing the flows this slice is done with. False when the check is
    // done: no flows left that it can claim, or as many slices as it needs.
    // A failure here leaves the slice's own results standing.
    private static Boolean continued(Flow_Operation__c outcome, Sweep sweep) {
        Savepoint start = Database.setSavepoint();
        try {
            sweep.slices++;
            sweep.ids = sweep.slices < sweep.maxSlices ? claimSlice(outcome.Id, sweep) : new List<Id>();
            if (sweep.ids.isEmpty()) {
                return false;
            }
            Set<String> keep = new Set<String>{ SWEEP_GATE };
            for (Flow_Governance__c record : [
                SELECT Connection__c, Flow_Api_Name__c
                FROM Flow_Governance__c
                WHERE Id IN :sweep.ids
                WITH SYSTEM_MODE
            ]) {
                keep.add(gateKey(record.Connection__c, record.Flow_Api_Name__c));
            }
            List<Flow_Operation__c> done = new List<Flow_Operation__c>();
            for (Flow_Operation__c gate : lockHeld(new Set<String>{ outcome.Id })) {
                if (!keep.contains(gate.Key__c)) {
                    gate.Active_Operation__c = null;
                    done.add(gate);
                }
            }
            Database.update(done, AccessLevel.SYSTEM_MODE);
            outcome.Payload__c = JSON.serialize(sweep);
            Database.update(outcome, AccessLevel.SYSTEM_MODE);
            // Tests can't chain queued jobs; they check the next slice is claimed.
            if (!Test.isRunningTest()) {
                Database.update(
                    new Flow_Operation__c(
                        Id = outcome.Id,
                        Job_Id__c = System.enqueueJob(new FlowGovernanceCheckJob(outcome.Id))
                    ),
                    AccessLevel.SYSTEM_MODE
                );
            }
            return true;
        } catch (Exception e) {
            Database.rollback(start);
            System.debug(LoggingLevel.WARN, 'Governance check stopped early: ' + e.getMessage());
            return false;
        }
    }

    public static void requireWorker() {
        if (running == null && !Test.isRunningTest()) {
            throw new FlowGovernanceService.GovernanceException(
                'Activation and checks must use a queued governance operation.'
            );
        }
    }

    // Ends an operation: records how, and releases every gate it holds. One
    // that holds none has already ended, and is left as it was.
    private static void finish(Flow_Operation__c outcome, String error) {
        List<Flow_Operation__c> held = lockHeld(new Set<String>{ outcome.Id });
        if (held.isEmpty())
            return;
        List<Flow_Operation__c> ended = [
            SELECT Id
            FROM Flow_Operation__c
            WHERE Id = :outcome.Id AND State__c = 'Queued'
            WITH SYSTEM_MODE
        ];
        if (!ended.isEmpty()) {
            outcome.State__c = error == null ? 'Completed' : 'Failed';
            outcome.Error__c = error == null ? null : error.abbreviate(32768);
            outcome.Payload__c = null;
            Database.update(outcome, AccessLevel.SYSTEM_MODE);
        }
        for (Flow_Operation__c gate : held) {
            gate.Active_Operation__c = null;
        }
        Database.update(held, AccessLevel.SYSTEM_MODE);
    }

    // The gates these operations hold, locked. Two transactions ending the
    // same stopped operation at once: the second is told to try again.
    private static List<Flow_Operation__c> lockHeld(Set<String> operations) {
        try {
            return [
                SELECT Id, Key__c
                FROM Flow_Operation__c
                WHERE Active_Operation__c IN :operations
                WITH SYSTEM_MODE
                FOR UPDATE
            ];
        } catch (QueryException e) {
            throw new FlowGovernanceService.GovernanceException(BUSY);
        }
    }

    public void execute(FinalizerContext context) {
        if (context.getResult() != ParentJobResult.SUCCESS) {
            finish(new Flow_Operation__c(Id = operationId), STOPPED_ERROR);
        }
    }
}
