@IsTest
private class FlowGovernanceOperationTest {
    @TestSetup
    static void setup() {
        FlowCompareTestMock.grantRunningUser(new List<String>{ 'Flow_Compare_Admin' });
        FlowCompareTestMock.plainUser('opother', new List<String>{ 'Flow_Compare_User' });
    }

    // The gates an operation holds.
    public static Integer held(Id operationId) {
        return [SELECT COUNT() FROM Flow_Operation__c WHERE Active_Operation__c = :operationId WITH SYSTEM_MODE];
    }

    public static Flow_Operation__c gate(String apiName) {
        String key = FlowGovernanceOperation.gateKey('local', apiName);
        return [SELECT Active_Operation__c FROM Flow_Operation__c WHERE Key__c = :key WITH SYSTEM_MODE];
    }

    private static FlowGovernanceService.RequestInput input() {
        FlowGovernanceService.RequestInput input = new FlowGovernanceService.RequestInput();
        input.connection = 'local';
        input.apiName = 'Demo_Flow';
        input.versionNumber = 3;
        return input;
    }

    private class ClaimedCallout implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest request) {
            Assert.areEqual(0, Limits.getDmlStatements(), 'The claim must be committed before the worker calls out');
            Assert.isNotNull(gate('Demo_Flow').Active_Operation__c);
            try {
                FlowGovernanceOperation.guardWrite(FlowGovernanceOperation.gateKey('local', 'Demo_Flow'), null);
                Assert.fail('Governance writes must not race the callout');
            } catch (FlowGovernanceService.GovernanceException e) {
                Assert.isTrue(e.getMessage().contains('queued or running'));
            }
            HttpResponse response = new HttpResponse();
            response.setStatusCode(200);
            if (request.getMethod() == 'GET') {
                response.setBody(
                    JSON.serialize(
                        FlowCompareTestMock.page(
                            new List<Object>{ FlowCompareTestMock.definition('Demo_Flow', 2, 3, null) }
                        )
                    )
                );
            } else {
                response.setStatusCode(204);
            }
            return response;
        }
    }

    @IsTest
    static void claimSpansCalloutsAndReleasesOnSuccess() {
        System.runAs(FlowCompareTestMock.installer()) {
            Test.setMock(HttpCalloutMock.class, new ClaimedCallout());
            Test.startTest();
            Id id = FlowGovernanceOperation.activate(input());
            Assert.areEqual('Queued', FlowGovernanceController.getOperation(id).state);
            try {
                FlowGovernanceOperation.activate(input());
                Assert.fail('Another operation on the flow cannot overtake the queued activation');
            } catch (FlowGovernanceService.GovernanceException e) {
                Assert.isTrue(e.getMessage().contains('queued or running'));
            }
            // A check doesn't wait for an activation; one check waits for another.
            FlowGovernanceOperation.check();
            try {
                FlowGovernanceOperation.check();
                Assert.fail('One check at a time');
            } catch (FlowGovernanceService.GovernanceException e) {
                Assert.isTrue(e.getMessage().contains('check is already queued or running'));
            }
            new FlowGovernanceMonitor().execute(null);
            Assert.areEqual(2, Limits.getQueueableJobs(), 'A scheduled check leaves the running check be');
            Test.stopTest();
            FlowGovernanceOperation.Status outcome = FlowGovernanceController.getOperation(id);
            Assert.areEqual('Completed', outcome.state, outcome.error == null ? '' : outcome.error);
            FlowGovernanceController.Request request = (FlowGovernanceController.Request) JSON.deserialize(
                outcome.result,
                FlowGovernanceController.Request.class
            );
            Assert.areEqual('Activated', request.status, request.error == null ? '' : request.error);
            Assert.isNull(gate('Demo_Flow').Active_Operation__c);
            Assert.isNull([SELECT Payload__c FROM Flow_Operation__c WHERE Id = :id WITH SYSTEM_MODE].Payload__c);
        }
    }

    @IsTest
    static void queuesAFullReceiptAndCommentsWithoutTruncation() {
        System.runAs(FlowCompareTestMock.installer()) {
            FlowGovernanceService.RequestInput full = input();
            full.changeSummary = 'r'.repeat(32768);
            full.comments = 'c'.repeat(32768);
            insert new Flow_Governance__c(
                Name = 'Demo',
                Flow_Api_Name__c = 'Demo_Flow',
                Flow_Key__c = 'local:Demo_Flow',
                Mode__c = 'Locked',
                Owner_User__c = FlowCompareTestMock.find('opother').Id
            );
            Test.setMock(HttpCalloutMock.class, new ClaimedCallout());
            Test.startTest();
            Id id = FlowGovernanceOperation.activate(full);
            Test.stopTest();
            FlowGovernanceOperation.Status outcome = FlowGovernanceController.getOperation(id);
            Assert.areEqual('Completed', outcome.state, outcome.error == null ? '' : outcome.error);
            FlowGovernanceController.Request request = (FlowGovernanceController.Request) JSON.deserialize(
                outcome.result,
                FlowGovernanceController.Request.class
            );
            Assert.areEqual('Activated', request.status);
            Assert.areEqual(full.changeSummary, request.changeSummary);
            Assert.areEqual(full.comments, request.comments);
        }
    }

    @IsTest
    static void aDecisionTooLongToCopyStillCompletes() {
        System.runAs(FlowCompareTestMock.installer()) {
            // Quotes double when serialized, so a copy of this request can't fit the result field.
            String quotes = '"'.repeat(32768);
            FlowGovernanceService.RequestInput full = input();
            full.comments = quotes;
            full.changeSummary = quotes;
            Id requestId = FlowGovernanceService.requestActivation(full).Id;
            Test.setMock(HttpCalloutMock.class, new ClaimedCallout());
            Test.startTest();
            Id id = FlowGovernanceOperation.approve(requestId, quotes);
            Test.stopTest();
            Assert.areEqual(
                'Activated',
                [SELECT Status__c FROM Flow_Activation_Request__c WHERE Id = :requestId WITH SYSTEM_MODE].Status__c,
                'The decision and its history stand'
            );
            FlowGovernanceOperation.Status outcome = FlowGovernanceController.getOperation(id);
            Assert.areEqual('Completed', outcome.state, outcome.error == null ? '' : outcome.error);
            Assert.isTrue(
                [SELECT Result__c FROM Flow_Operation__c WHERE Id = :id WITH SYSTEM_MODE].Result__c.length() < 200
            );
            FlowGovernanceController.Request request = (FlowGovernanceController.Request) JSON.deserialize(
                outcome.result,
                FlowGovernanceController.Request.class
            );
            Assert.areEqual(requestId, request.id);
            Assert.areEqual('Activated', request.status);
            Assert.areEqual(quotes, request.comments);
            Assert.areEqual(quotes, request.decisionComments);
            Assert.areEqual(quotes, request.changeSummary);
        }
    }

    @IsTest
    static void oversizedCommentsAreRejectedBeforeEnqueueOrActivation() {
        System.runAs(FlowCompareTestMock.installer()) {
            FlowGovernanceService.RequestInput oversized = input();
            oversized.comments = 'c'.repeat(32769);
            Id requestId = FlowGovernanceService.requestActivation(input()).Id;
            FlowCompareTestMock mock = new FlowCompareTestMock();
            Test.setMock(HttpCalloutMock.class, mock);
            Test.startTest();
            for (Integer action = 0; action < 3; action++) {
                try {
                    if (action == 0) {
                        FlowGovernanceOperation.activate(oversized);
                    } else if (action == 1) {
                        FlowGovernanceOperation.approve(requestId, oversized.comments);
                    } else {
                        FlowGovernanceService.approve(requestId, oversized.comments);
                    }
                    Assert.fail('Oversized comments must fail before any side effect');
                } catch (FlowGovernanceService.GovernanceException e) {
                    Assert.isTrue(e.getMessage().contains('32,768'), e.getMessage());
                }
            }
            Assert.areEqual(0, Limits.getQueueableJobs());
            Test.stopTest();
            Assert.areEqual(0, mock.requests.size());
            Assert.areEqual('Pending', FlowGovernanceService.loadRequest(requestId).Status__c);
        }
    }

    @IsTest
    static void aCheckThatCouldNotReachItsOrgIsNotASuccess() {
        System.runAs(FlowCompareTestMock.installer()) {
            insert new Flow_Governance__c(
                Name = 'Demo',
                Flow_Api_Name__c = 'Demo_Flow',
                Flow_Key__c = 'local:Demo_Flow',
                Mode__c = 'Watch',
                Owner_User__c = FlowCompareTestMock.find('opother').Id,
                Approved_Version__c = 2
            );
            Test.setMock(
                HttpCalloutMock.class,
                new FlowCompareTestMock()
                    .route('GET', '/query', 401, FlowCompareTestMock.error('Session expired', 'INVALID_SESSION_ID'))
            );
            Test.startTest();
            Id id = FlowGovernanceOperation.check();
            Test.stopTest();
            FlowGovernanceOperation.Status outcome = FlowGovernanceController.getOperation(id);
            Assert.areEqual('Completed', outcome.state, 'The check ran; its results say what went wrong');
            Assert.isTrue(outcome.result.contains('"outcome":"error"'), outcome.result);
            Flow_Operation__c receipt = [
                SELECT Attempted__c, Succeeded__c, Failed__c
                FROM Flow_Operation__c
                WHERE Id = :id
                WITH SYSTEM_MODE
            ];
            Assert.areEqual(1, receipt.Attempted__c);
            Assert.areEqual(0, receipt.Succeeded__c);
            Assert.areEqual(1, receipt.Failed__c);
            // The poller gets the same counts, however few results the receipt keeps.
            Assert.areEqual(1, outcome.attempted);
            Assert.areEqual(0, outcome.succeeded);
            Assert.areEqual(1, outcome.failed);
            Assert.areEqual(0, outcome.remaining);
            FlowGovernanceMonitor.Status monitor = FlowGovernanceMonitor.status();
            Assert.areEqual(FlowGovernanceMonitor.COMPLETED_WITH_ERRORS, monitor.lastStatus);
            Assert.isNull(monitor.lastSuccess, 'An unreachable org was not checked');
            Assert.areEqual(1, monitor.lastChecked);
            Assert.areEqual(1, monitor.lastFailed);
            Assert.isFalse(monitor.running);
            Assert.isTrue(monitor.lastError.startsWith('1 of 1 flows'), monitor.lastError);
        }
    }

    @IsTest
    static void operationsArePrivateAndAuthorizeBeforeEnqueue() {
        Id id;
        System.runAs(FlowCompareTestMock.installer()) {
            Test.startTest();
            id = FlowGovernanceOperation.check();
        }
        System.runAs(FlowCompareTestMock.find('opother')) {
            try {
                FlowGovernanceController.getOperation(id);
                Assert.fail('Other users cannot poll private results');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('cannot read'));
            }
            try {
                FlowGovernanceOperation.activate(input());
                Assert.fail('No save or admin permission');
            } catch (FlowGovernanceService.GovernanceException e) {
                Assert.isTrue(e.getMessage().contains('Request activation'));
            }
        }
        Test.stopTest();
    }

    private static Flow_Governance__c governed(String apiName, String mode, Integer approved) {
        return new Flow_Governance__c(
            Name = apiName,
            Flow_Api_Name__c = apiName,
            Flow_Key__c = 'local:' + apiName,
            Mode__c = mode,
            Owner_User__c = FlowCompareTestMock.find('opother').Id,
            Approved_Version__c = approved,
            Active_Version__c = approved
        );
    }

    // An operation that holds a flow's gate and is still running.
    private static Id holdGate(String apiName) {
        Flow_Operation__c holder = new Flow_Operation__c(Action__c = 'activate', State__c = 'Queued');
        Database.insert(holder, AccessLevel.SYSTEM_MODE);
        Database.insert(
            new Flow_Operation__c(
                Key__c = FlowGovernanceOperation.gateKey('local', apiName),
                Active_Operation__c = holder.Id,
                Revision__c = 1
            ),
            AccessLevel.SYSTEM_MODE
        );
        return holder.Id;
    }

    // Each governed flow's definition, on its approved version.
    private static FlowCompareTestMock definitionsMock(List<Flow_Governance__c> records) {
        List<Object> definitions = new List<Object>();
        for (Flow_Governance__c record : records) {
            definitions.add(
                FlowCompareTestMock.definition(record.Flow_Api_Name__c, record.Approved_Version__c.intValue(), 3, null)
            );
        }
        return new FlowCompareTestMock()
            .route('GET', 'FROM FlowDefinition', 200, FlowCompareTestMock.page(definitions));
    }

    @IsTest
    static void aFlowsNamesShareOneGate() {
        String key = FlowGovernanceOperation.gateKey('local', 'Demo_Flow');
        Assert.areEqual(key, FlowGovernanceOperation.gateKey(null, 'home__Demo_Flow'));
        Assert.areEqual(key, FlowGovernanceOperation.gateKey('local', 'demo_flow'));
        Assert.areNotEqual(key, FlowGovernanceOperation.gateKey('Staging', 'Demo_Flow'), 'Another org\'s flow');
        Assert.areNotEqual(key, FlowGovernanceOperation.gateKey('local', 'Other_Flow'));
        Assert.isTrue(key.length() <= 80);
        System.runAs(FlowCompareTestMock.installer()) {
            Test.setMock(HttpCalloutMock.class, new FlowCompareTestMock());
            Test.startTest();
            FlowGovernanceService.RequestInput namespaced = input();
            namespaced.apiName = 'home__Demo_Flow';
            FlowGovernanceOperation.activate(namespaced);
            try {
                FlowGovernanceOperation.activate(input());
                Assert.fail('Its name without the namespace is the same flow');
            } catch (FlowGovernanceService.GovernanceException e) {
                Assert.isTrue(e.getMessage().contains('queued or running'), e.getMessage());
            }
            FlowGovernanceService.RequestInput other = input();
            other.apiName = 'Other_Flow';
            FlowGovernanceOperation.activate(other);
            Assert.areEqual(2, Limits.getQueueableJobs(), 'Another flow doesn\'t wait');
            Test.stopTest();
        }
    }

    @IsTest
    static void aCheckLeavesAFlowAnotherOperationHoldsAndChecksTheRest() {
        System.runAs(FlowCompareTestMock.installer()) {
            List<Flow_Governance__c> records = new List<Flow_Governance__c>{
                governed('Demo_Flow', 'Locked', 2),
                governed('Other_Flow', 'Watch', 2)
            };
            insert records;
            Id activation = holdGate('Demo_Flow');
            FlowGovernanceService.RequestInput other = input();
            other.apiName = 'Other_Flow';
            Id otherRequest = FlowGovernanceService.requestActivation(other).Id;
            FlowGovernanceService.RequestInput third = input();
            third.apiName = 'Third_Flow';
            Id thirdRequest = FlowGovernanceService.requestActivation(third).Id;
            Test.setMock(HttpCalloutMock.class, definitionsMock(records));
            Test.startTest();
            Id check = FlowGovernanceOperation.check();
            Assert.areEqual(activation, gate('Demo_Flow').Active_Operation__c, 'The activation keeps its flow');
            Assert.areEqual(check, gate('Other_Flow').Active_Operation__c);
            // Decisions on a flow being checked wait; decisions on others don't.
            try {
                FlowGovernanceService.cancel(otherRequest);
                Assert.fail('The check holds Other_Flow');
            } catch (FlowGovernanceService.GovernanceException e) {
                Assert.isTrue(e.getMessage().contains('queued or running'), e.getMessage());
            }
            Assert.areEqual(FlowGovernanceService.CANCELLED, FlowGovernanceService.cancel(thirdRequest).Status__c);
            Test.stopTest();
            FlowGovernanceOperation.Status outcome = FlowGovernanceController.getOperation(check);
            Assert.areEqual('Completed', outcome.state, outcome.error == null ? '' : outcome.error);
            List<FlowGovernanceController.CheckResult> results = (List<FlowGovernanceController.CheckResult>) JSON.deserialize(
                outcome.result,
                List<FlowGovernanceController.CheckResult>.class
            );
            Assert.areEqual(1, results.size());
            Assert.areEqual('Other_Flow', results[0].apiName);
            Assert.areEqual('ok', results[0].outcome);
            Assert.areEqual(0, held(check));
            Assert.areEqual(activation, gate('Demo_Flow').Active_Operation__c);
            FlowGovernanceMonitor.Status monitor = FlowGovernanceMonitor.status();
            Assert.areEqual('Completed', monitor.lastStatus);
            Assert.areEqual(1, monitor.lastRemaining, 'The flow held elsewhere waits for the next check');
        }
    }

    @IsTest
    static void aStoppedOperationsClaimIsRecoveredByWhateverNeedsItsFlow() {
        System.runAs(FlowCompareTestMock.installer()) {
            List<Flow_Governance__c> records = new List<Flow_Governance__c>{ governed('Demo_Flow', 'Locked', 2) };
            insert records;
            Id requestId = FlowGovernanceService.requestActivation(input()).Id;
            Test.setMock(HttpCalloutMock.class, definitionsMock(records));
            Test.startTest();
            Id first = FlowGovernanceOperation.activate(input());
            System.abortJob([SELECT Job_Id__c FROM Flow_Operation__c WHERE Id = :first WITH SYSTEM_MODE].Job_Id__c);
            // Cancelling a request for the flow ends the stopped activation.
            Assert.areEqual(FlowGovernanceService.CANCELLED, FlowGovernanceService.cancel(requestId).Status__c);
            Assert.areEqual(
                'Failed',
                [SELECT State__c FROM Flow_Operation__c WHERE Id = :first WITH SYSTEM_MODE].State__c
            );
            Id second = FlowGovernanceOperation.activate(input());
            System.abortJob([SELECT Job_Id__c FROM Flow_Operation__c WHERE Id = :second WITH SYSTEM_MODE].Job_Id__c);
            // So does a check that needs it.
            Id check = FlowGovernanceOperation.check();
            Assert.areEqual(check, gate('Demo_Flow').Active_Operation__c);
            Assert.areEqual(0, held(second));
            Assert.areEqual(
                'Failed',
                [SELECT State__c FROM Flow_Operation__c WHERE Id = :second WITH SYSTEM_MODE].State__c
            );
            Test.stopTest();
            Assert.areEqual('Completed', FlowGovernanceController.getOperation(check).state);
            Assert.areEqual(0, held(check));
        }
    }

    // An operation queued before each flow had its own gate: it holds the
    // gate every operation used to share, and its job is queued as it was.
    private static Id legacyOperation(String action, String payload) {
        Flow_Operation__c operation = new Flow_Operation__c(
            Action__c = action,
            Payload__c = payload,
            State__c = 'Queued'
        );
        Database.insert(operation, AccessLevel.SYSTEM_MODE);
        operation.Job_Id__c = action == 'check'
            ? System.enqueueJob(new FlowGovernanceCheckJob(operation.Id))
            : System.enqueueJob(new FlowGovernanceOperation(operation.Id));
        Database.update(operation, AccessLevel.SYSTEM_MODE);
        Database.insert(
            new Flow_Operation__c(Key__c = 'governance', Active_Operation__c = operation.Id, Revision__c = 1),
            AccessLevel.SYSTEM_MODE
        );
        return operation.Id;
    }

    private static void assertHeldBack(String message) {
        Assert.isTrue(message.contains('queued before Tributary was updated'), message);
    }

    @IsTest
    static void anOperationQueuedBeforeAnUpgradeHoldsBackEveryOtherUntilItEnds() {
        System.runAs(FlowCompareTestMock.installer()) {
            Id requestId = FlowGovernanceService.requestActivation(input()).Id;
            Test.setMock(HttpCalloutMock.class, new FlowCompareTestMock());
            Test.startTest();
            Id legacy = legacyOperation('check', null);
            try {
                FlowGovernanceOperation.activate(input());
                Assert.fail('An activation waits for the operation queued before the upgrade');
            } catch (FlowGovernanceService.GovernanceException e) {
                assertHeldBack(e.getMessage());
            }
            try {
                FlowGovernanceOperation.check();
                Assert.fail('So does a check');
            } catch (FlowGovernanceService.GovernanceException e) {
                assertHeldBack(e.getMessage());
            }
            try {
                FlowGovernanceService.cancel(requestId);
                Assert.fail('So does a decision');
            } catch (FlowGovernanceService.GovernanceException e) {
                assertHeldBack(e.getMessage());
            }
            try {
                FlowGovernanceOperation.revision(FlowGovernanceOperation.gateKey('local', 'Demo_Flow'));
                Assert.fail('And a read before one');
            } catch (FlowGovernanceService.GovernanceException e) {
                assertHeldBack(e.getMessage());
            }
            // A scheduled check leaves it for the next run.
            new FlowGovernanceMonitor().execute(null);
            Assert.areEqual(1, Limits.getQueueableJobs());
            Test.stopTest();
            // Its own job still runs. A check queued then has no plan, so it
            // ends saying so, and frees the shared gate.
            FlowGovernanceOperation.Status outcome = FlowGovernanceController.getOperation(legacy);
            Assert.areEqual('Failed', outcome.state);
            Assert.isTrue(outcome.error.contains('Start the check again'), outcome.error);
            Assert.areEqual(0, held(legacy));
            Assert.areEqual(FlowGovernanceService.CANCELLED, FlowGovernanceService.cancel(requestId).Status__c);
            Assert.isNotNull(FlowGovernanceOperation.activate(input()));
        }
    }

    @IsTest
    static void anOperationQueuedBeforeAnUpgradeWhoseJobStoppedHoldsNothingBack() {
        System.runAs(FlowCompareTestMock.installer()) {
            Test.setMock(HttpCalloutMock.class, new FlowCompareTestMock());
            Test.startTest();
            Id legacy = legacyOperation('activate', JSON.serialize(input()));
            System.abortJob([SELECT Job_Id__c FROM Flow_Operation__c WHERE Id = :legacy WITH SYSTEM_MODE].Job_Id__c);
            Assert.areEqual(0, FlowGovernanceOperation.revision(FlowGovernanceOperation.gateKey('local', 'Demo_Flow')));
            Id id = FlowGovernanceOperation.activate(input());
            Assert.areEqual(id, gate('Demo_Flow').Active_Operation__c);
            Assert.areEqual(0, held(legacy));
            Assert.areEqual(
                'Failed',
                [SELECT State__c FROM Flow_Operation__c WHERE Id = :legacy WITH SYSTEM_MODE].State__c
            );
            Test.stopTest();
        }
    }

    @IsTest
    static void aCheckGoesOnToTheNextSliceEnforcedFlowsFirst() {
        System.runAs(FlowCompareTestMock.installer()) {
            List<Flow_Governance__c> records = new List<Flow_Governance__c>();
            for (Integer i = 0; i < 26; i++) {
                Flow_Governance__c record = governed('Watched_' + i, 'Watch', 1);
                record.Last_Attempt__c = System.now().addHours(-1);
                records.add(record);
            }
            // Never tried, yet flows whose governance is off wait for enforced ones.
            records.add(governed('Off_0', 'Off', 1));
            records.add(governed('Off_1', 'Off', 1));
            Database.insert(records, AccessLevel.SYSTEM_MODE);
            Test.setMock(HttpCalloutMock.class, definitionsMock(records));
            Test.startTest();
            Id check = FlowGovernanceOperation.check();
            Test.stopTest();
            Flow_Operation__c operation = [
                SELECT State__c, Payload__c, Attempted__c, Succeeded__c, Failed__c
                FROM Flow_Operation__c
                WHERE Id = :check
                WITH SYSTEM_MODE
            ];
            Assert.areEqual('Queued', operation.State__c, 'The check goes on with the rest');
            Assert.areEqual(25, operation.Attempted__c);
            Assert.areEqual(25, operation.Succeeded__c);
            Assert.areEqual(0, operation.Failed__c);
            Assert.areEqual(
                0,
                [
                    SELECT COUNT()
                    FROM Flow_Governance__c
                    WHERE Mode__c = 'Off' AND Last_Attempt__c != NULL
                    WITH SYSTEM_MODE
                ]
            );
            Set<Id> next = new Set<Id>();
            for (
                Object id : (List<Object>) ((Map<String, Object>) JSON.deserializeUntyped(operation.Payload__c))
                    .get('ids')
            ) {
                next.add((Id) (String) id);
            }
            List<String> names = new List<String>();
            for (Flow_Governance__c record : [
                SELECT Flow_Api_Name__c
                FROM Flow_Governance__c
                WHERE Id IN :next
                ORDER BY Flow_Api_Name__c
            ]) {
                names.add(record.Flow_Api_Name__c);
            }
            Assert.areEqual(3, names.size(), String.join(names, ', '));
            Assert.areEqual('Off_0', names[0]);
            Assert.areEqual('Off_1', names[1]);
            Assert.isTrue(names[2].startsWith('Watched_'));
            // The next slice's flows and the check itself stay claimed; the rest are free.
            Assert.areEqual(4, held(check));
            Assert.isTrue(FlowGovernanceMonitor.status().running, 'The check is still going');
        }
    }

    @IsTest
    static void aFlowWhoseResultCouldNotBeSavedIsNotTriedAgain() {
        System.runAs(FlowCompareTestMock.installer()) {
            Datetime since = System.now().addMinutes(-1);
            Flow_Governance__c saved = governed('Saved_Flow', 'Watch', 1);
            saved.Last_Attempt__c = System.now();
            Flow_Governance__c unsaved = governed('Unsaved_Flow', 'Watch', 1);
            Flow_Governance__c skipped = governed('Skipped_Flow', 'Watch', 1);
            Flow_Governance__c waiting = governed('Waiting_Flow', 'Watch', 1);
            Database.insert(new List<Flow_Governance__c>{ saved, unsaved, skipped, waiting }, AccessLevel.SYSTEM_MODE);
            FlowGovernanceOperation.Sweep sweep = new FlowGovernanceOperation.Sweep();
            sweep.since = since;
            sweep.ids = new List<Id>{ saved.Id, unsaved.Id, skipped.Id };
            List<FlowGovernanceService.CheckResult> results = new List<FlowGovernanceService.CheckResult>();
            for (Flow_Governance__c record : new List<Flow_Governance__c>{ saved, unsaved, skipped }) {
                FlowGovernanceService.CheckResult result = new FlowGovernanceService.CheckResult();
                result.governanceId = record.Id;
                result.outcome = record == skipped ? 'skipped' : record == saved ? 'ok' : 'error';
                results.add(result);
            }
            FlowGovernanceOperation.noteUnsaved(sweep, results);
            Assert.areEqual(new List<Id>{ unsaved.Id }, sweep.unsaved, 'Only the flow whose save failed');
            // Later slices, and the count of what's left, pass it by; a skipped flow comes round again.
            Set<Id> due = new Set<Id>();
            for (Flow_Governance__c record : FlowGovernanceService.dueForCheck(since, 100, sweep.unsaved)) {
                due.add(record.Id);
            }
            Assert.areEqual(new Set<Id>{ skipped.Id, waiting.Id }, due);
            Assert.areEqual(2, FlowGovernanceService.countDue(since, sweep.unsaved));
        }
    }

    @IsTest
    static void aCheckMayChainAsManyJobsAsItHasSlices() {
        FlowGovernanceOperation.Sweep sweep = new FlowGovernanceOperation.Sweep();
        sweep.maxSlices = 9;
        // Developer Edition orgs otherwise stop a chain at five jobs.
        Assert.isTrue(FlowGovernanceOperation.chainOptions(sweep).MaximumQueueableStackDepth > sweep.maxSlices);
    }

    @IsTest
    static void aFlowSkippedAndTriedAgainCountsOnce() {
        Id governanceId = Id.valueOf(Flow_Governance__c.SObjectType.getDescribe().getKeyPrefix() + '000000000001AAA');
        FlowGovernanceService.CheckResult skipped = new FlowGovernanceService.CheckResult();
        skipped.governanceId = governanceId;
        skipped.outcome = 'skipped';
        FlowGovernanceService.CheckResult checked = new FlowGovernanceService.CheckResult();
        checked.governanceId = governanceId;
        checked.outcome = 'ok';
        // An earlier slice skipped the flow; a later one checked it.
        Flow_Operation__c before = new Flow_Operation__c(
            Attempted__c = 1,
            Succeeded__c = 0,
            Failed__c = 0,
            Result__c = JSON.serialize(new List<FlowGovernanceService.CheckResult>{ skipped })
        );
        Flow_Operation__c outcome = new Flow_Operation__c();
        FlowGovernanceOperation.tally(before, outcome, new List<FlowGovernanceService.CheckResult>{ checked });
        Assert.areEqual(1, outcome.Attempted__c);
        Assert.areEqual(1, outcome.Succeeded__c);
        List<FlowGovernanceService.CheckResult> results = (List<FlowGovernanceService.CheckResult>) JSON.deserialize(
            outcome.Result__c,
            List<FlowGovernanceService.CheckResult>.class
        );
        Assert.areEqual(1, results.size());
        Assert.areEqual('ok', results[0].outcome);
    }

    @IsTest
    static void aCheckRecoversManyStoppedClaimsAtOnce() {
        System.runAs(FlowCompareTestMock.installer()) {
            List<Flow_Governance__c> records = new List<Flow_Governance__c>();
            List<Flow_Operation__c> holders = new List<Flow_Operation__c>();
            for (Integer i = 0; i < 60; i++) {
                records.add(governed('Held_' + i, 'Watch', 1));
                // Each ended without releasing its gate.
                holders.add(new Flow_Operation__c(Action__c = 'activate', State__c = 'Failed'));
            }
            insert records;
            Database.insert(holders, AccessLevel.SYSTEM_MODE);
            List<Flow_Operation__c> gates = new List<Flow_Operation__c>();
            for (Integer i = 0; i < 60; i++) {
                gates.add(
                    new Flow_Operation__c(
                        Key__c = FlowGovernanceOperation.gateKey('local', 'Held_' + i),
                        Active_Operation__c = holders[i].Id
                    )
                );
            }
            Database.insert(gates, AccessLevel.SYSTEM_MODE);
            Test.startTest();
            Id check = FlowGovernanceOperation.check();
            Assert.isTrue(Limits.getQueries() < 30, 'Recovery is done together: ' + Limits.getQueries());
            Assert.areEqual(26, held(check), 'A slice of 25 flows, and the check itself');
            Set<String> ended = new Set<String>();
            for (Flow_Operation__c holder : holders) {
                ended.add(holder.Id);
            }
            Assert.areEqual(
                0,
                [SELECT COUNT() FROM Flow_Operation__c WHERE Active_Operation__c IN :ended WITH SYSTEM_MODE]
            );
            System.abortJob([SELECT Job_Id__c FROM Flow_Operation__c WHERE Id = :check WITH SYSTEM_MODE].Job_Id__c);
            Test.stopTest();
        }
    }

    @IsTest
    static void abortedJobsReleaseTheirClaimWithoutALease() {
        System.runAs(FlowCompareTestMock.installer()) {
            Test.startTest();
            Id id = FlowGovernanceOperation.check();
            System.abortJob([SELECT Job_Id__c FROM Flow_Operation__c WHERE Id = :id WITH SYSTEM_MODE].Job_Id__c);
            FlowGovernanceOperation.Status outcome = FlowGovernanceController.getOperation(id);
            Assert.areEqual('Failed', outcome.state);
            Assert.isTrue(outcome.error.contains('may have changed'));
            Assert.areEqual(0, held(id), 'Its claims are released');
            Test.stopTest();
        }
    }

    // An operation holding a flow's gate whose job isn't in AsyncApexJob, as
    // when Salesforce has purged a job that stopped days ago.
    private static Id holdGateWithMissingJob(String apiName, Datetime created) {
        Flow_Operation__c holder = new Flow_Operation__c(
            Action__c = 'activate',
            State__c = 'Queued',
            Job_Id__c = '707000000000001'
        );
        Database.insert(holder, AccessLevel.SYSTEM_MODE);
        Test.setCreatedDate(holder.Id, created);
        Database.insert(
            new Flow_Operation__c(
                Key__c = FlowGovernanceOperation.gateKey('local', apiName),
                Active_Operation__c = holder.Id,
                Revision__c = 1
            ),
            AccessLevel.SYSTEM_MODE
        );
        return holder.Id;
    }

    @IsTest
    static void anOperationWhoseJobWasPurgedHoldsNothingBack() {
        System.runAs(FlowCompareTestMock.installer()) {
            Id purged = holdGateWithMissingJob('Demo_Flow', System.now().addDays(-8));
            Id polled = holdGateWithMissingJob('Polled_Flow', System.now().addDays(-8));
            Id recent = holdGateWithMissingJob('Other_Flow', System.now());
            Test.setMock(HttpCalloutMock.class, new FlowCompareTestMock());
            Test.startTest();
            Id id = FlowGovernanceOperation.activate(input());
            Assert.areEqual(id, gate('Demo_Flow').Active_Operation__c);
            Assert.areEqual(
                'Failed',
                [SELECT State__c FROM Flow_Operation__c WHERE Id = :purged WITH SYSTEM_MODE].State__c
            );
            FlowGovernanceOperation.Status outcome = FlowGovernanceController.getOperation(polled);
            Assert.areEqual('Failed', outcome.state);
            Assert.isTrue(outcome.error.contains('may have changed'), outcome.error);
            Assert.areEqual(0, held(polled));
            // A job queued moments ago is never taken for one that's gone.
            FlowGovernanceService.RequestInput other = input();
            other.apiName = 'Other_Flow';
            try {
                FlowGovernanceOperation.activate(other);
                Assert.fail('The recent operation still holds its flow');
            } catch (FlowGovernanceService.GovernanceException e) {
                Assert.isTrue(e.getMessage().contains('queued or running'), e.getMessage());
            }
            Assert.areEqual('Queued', FlowGovernanceController.getOperation(recent).state);
            Test.stopTest();
        }
    }

    @IsTest
    static void enqueueRecoversAnAbortedJobEvenWithoutPolling() {
        System.runAs(FlowCompareTestMock.installer()) {
            Test.startTest();
            Id first = FlowGovernanceOperation.check();
            System.abortJob([SELECT Job_Id__c FROM Flow_Operation__c WHERE Id = :first WITH SYSTEM_MODE].Job_Id__c);
            Id next = FlowGovernanceOperation.check();
            Assert.areNotEqual(first, next);
            Assert.areEqual('Failed', FlowGovernanceController.getOperation(first).state);
            Test.stopTest();
            Assert.areEqual('Completed', FlowGovernanceController.getOperation(next).state);
        }
    }

    @IsTest
    static void changedGovernanceInvalidatesAnEarlierRead() {
        System.runAs(FlowCompareTestMock.installer()) {
            String key = FlowGovernanceOperation.gateKey('local', 'Demo_Flow');
            Decimal before = FlowGovernanceOperation.revision(key);
            FlowGovernanceOperation.guardWrite(key, before);
            Assert.areEqual(before + 1, FlowGovernanceOperation.revision(key));
            Assert.areEqual(
                0,
                FlowGovernanceOperation.revision(FlowGovernanceOperation.gateKey('local', 'Other_Flow')),
                'Each flow has its own revision'
            );
            try {
                FlowGovernanceOperation.guardWrite(key, before);
                Assert.fail('A baseline read before a concurrent change cannot overwrite it');
            } catch (FlowGovernanceService.GovernanceException e) {
                Assert.isTrue(e.getMessage().contains('changed while'));
            }
        }
    }

    @IsTest
    static void refusesAnEditWithinTheSameSecondAfterReview() {
        System.runAs(FlowCompareTestMock.installer()) {
            FlowGovernanceService.RequestInput reviewed = input();
            reviewed.reviewedAt = (Datetime) JSON.deserialize('"2026-09-01T10:00:00.100Z"', Datetime.class);
            Id requestId = FlowGovernanceService.requestActivation(reviewed).Id;
            Assert.areEqual(
                reviewed.reviewedAt.getTime(),
                [SELECT Reviewed_Millis__c FROM Flow_Activation_Request__c WHERE Id = :requestId WITH SYSTEM_MODE]
                    .Reviewed_Millis__c.longValue()
            );
            Test.setMock(
                HttpCalloutMock.class,
                new FlowCompareTestMock()
                    .route(
                        'GET',
                        'FROM FlowDefinition',
                        200,
                        FlowCompareTestMock.page(
                            new List<Object>{ FlowCompareTestMock.definition('Demo_Flow', 2, 3, null) }
                        )
                    )
                    .route(
                        'GET',
                        'FROM Flow WHERE',
                        200,
                        FlowCompareTestMock.page(
                            new List<Object>{
                                new Map<String, Object>{
                                    'Id' => FlowCompareTestMock.VERSION_ID,
                                    'LastModifiedDate' => '2026-09-01T10:00:00.200Z'
                                }
                            }
                        )
                    )
            );
            Test.startTest();
            Id id = FlowGovernanceOperation.approve(requestId, null);
            Test.stopTest();
            FlowGovernanceOperation.Status outcome = FlowGovernanceController.getOperation(id);
            Assert.areEqual('Completed', outcome.state);
            FlowGovernanceController.Request result = (FlowGovernanceController.Request) JSON.deserialize(
                outcome.result,
                FlowGovernanceController.Request.class
            );
            Assert.areEqual('Failed', result.status);
            Assert.isTrue(result.error.contains('changed after its merge was reviewed'), result.error);
        }
    }

    @IsTest
    static void workerRefusesAnOwnerWhoseAccessChangedAfterEnqueue() {
        System.runAs(FlowCompareTestMock.installer()) {
            User owner = FlowCompareTestMock.find('opother');
            Flow_Governance__c governance = new Flow_Governance__c(
                Name = 'Demo',
                Flow_Api_Name__c = 'Demo_Flow',
                Flow_Key__c = 'local:Demo_Flow',
                Mode__c = 'Locked',
                Owner_User__c = owner.Id
            );
            insert governance;
            Id id;
            Test.startTest();
            System.runAs(owner) {
                id = FlowGovernanceOperation.activate(input());
            }
            // An org admin can change records outside Tributary's gate.
            governance.Owner_User__c = UserInfo.getUserId();
            update governance;
            Test.stopTest();
            FlowGovernanceOperation.Status outcome = FlowGovernanceController.getOperation(id);
            Assert.areEqual('Failed', outcome.state);
            Assert.isTrue(outcome.error.contains('Request activation'));
            Assert.areEqual(0, held(id), 'Its claims are released');
            Assert.areEqual(0, [SELECT COUNT() FROM Flow_Activation_Request__c]);
        }
    }

    @IsTest
    static void workerRevalidatesAndReleasesAFailedOperation() {
        System.runAs(FlowCompareTestMock.installer()) {
            Test.startTest();
            Id id = FlowGovernanceOperation.activate(input());
            // Simulate a stale/corrupt queued request. Validation happens again in the worker.
            Database.update(
                new Flow_Operation__c(Id = id, Payload__c = '{"apiName":"bad name","versionNumber":3}'),
                AccessLevel.SYSTEM_MODE
            );
            Test.stopTest();
            FlowGovernanceOperation.Status outcome = FlowGovernanceController.getOperation(id);
            Assert.areEqual('Failed', outcome.state);
            Assert.isTrue(outcome.error.contains('Not a flow API name'));
            Assert.areEqual(0, held(id), 'Its claims are released');
        }
    }
}
