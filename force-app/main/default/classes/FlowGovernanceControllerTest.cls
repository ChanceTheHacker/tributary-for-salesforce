@IsTest
private class FlowGovernanceControllerTest {
    private static final String FLOW = 'Demo_Flow';

    @TestSetup
    static void setup() {
        FlowCompareTestMock.grantRunningUser(new List<String>{ 'Flow_Compare_Admin' });
        FlowCompareTestMock.user('fcadmin', new List<String>{ 'Flow_Compare_Admin' });
        FlowCompareTestMock.user('fcowner', new List<String>{ 'Flow_Compare_User' });
        FlowCompareTestMock.user('fcother', new List<String>{ 'Flow_Compare_User' });
    }

    private static FlowCompareTestMock definitionMock(Integer active, Id actor) {
        return new FlowCompareTestMock()
            .route(
                'GET',
                'FROM FlowDefinition',
                200,
                FlowCompareTestMock.page(new List<Object>{ FlowCompareTestMock.definition(FLOW, active, 3, actor) })
            )
            .route(
                'GET',
                'FROM SetupAuditTrail',
                200,
                FlowCompareTestMock.page(new List<Object>{ FlowCompareTestMock.auditEntry(FLOW, active, actor) })
            )
            .route(
                'GET',
                'FROM Flow WHERE',
                200,
                FlowCompareTestMock.page(
                    new List<Object>{
                        new Map<String, Object>{
                            'Id' => FlowCompareTestMock.VERSION_ID,
                            'LastModifiedDate' => '2020-01-01T00:00:00.000+0000'
                        }
                    }
                )
            )
            .route('POST', '_HttpMethod=PATCH', 204, null);
    }

    private static Flow_Governance__c govern(Integer approved) {
        Flow_Governance__c record = new Flow_Governance__c(
            Name = 'Demo Flow',
            Flow_Api_Name__c = FLOW,
            Flow_Key__c = 'local:' + FLOW,
            Owner_User__c = FlowCompareTestMock.find('fcowner').Id,
            Mode__c = FlowGovernanceService.MODE_WATCH,
            Approved_Version__c = approved,
            Active_Version__c = approved
        );
        insert record;
        return record;
    }

    @IsTest
    static void expiredManageFlowDoesNotAuthorizeLocalChanges() {
        User expired;
        User active;
        System.runAs(FlowCompareTestMock.installer()) {
            PermissionSet access = new PermissionSet(
                Name = 'Tributary_Test_Manage_Flow',
                Label = 'Tributary Test Manage Flow',
                PermissionsManageInteraction = true,
                PermissionsViewSetup = true,
                PermissionsViewRoles = true
            );
            insert access;
            expired = FlowCompareTestMock.plainUser('fcexpire', new List<String>{ 'Flow_Compare_User' });
            active = FlowCompareTestMock.plainUser('fcactive', new List<String>{ 'Flow_Compare_User' });
            insert new List<PermissionSetAssignment>{
                new PermissionSetAssignment(
                    AssigneeId = expired.Id,
                    PermissionSetId = access.Id,
                    ExpirationDate = System.now().addDays(-1)
                ),
                new PermissionSetAssignment(AssigneeId = active.Id, PermissionSetId = access.Id)
            };
        }
        System.runAs(expired) {
            Assert.isFalse(FlowGovernanceService.hasManageFlow(), 'Expired access must not grant Manage Flow');
            Assert.isFalse(FlowGovernanceService.canSave('local'));
            Assert.isFalse(FlowGovernanceService.canApprove('local', null));
        }
        System.runAs(active) {
            Assert.isTrue(FlowGovernanceService.hasManageFlow());
            Assert.isTrue(FlowGovernanceService.canSave('local'));
        }
    }

    @IsTest
    static void governsFlowsAndRoutesRequestsToTheOwner() {
        Id ownerId = FlowCompareTestMock.find('fcowner').Id;
        Test.setMock(HttpCalloutMock.class, definitionMock(2, ownerId));
        FlowGovernanceController.Governance governance;
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcadmin')) {
            governance = FlowGovernanceController.saveGovernance(null, 'local', FLOW, 'Demo', ownerId, 'Watch');
        }
        Test.stopTest();
        Assert.areEqual(2, governance.approvedVersion);
        Assert.areEqual('Tributary fcowner', governance.ownerName);
        Assert.isFalse(governance.isOwner);

        FlowGovernanceController.Request request;
        System.runAs(FlowCompareTestMock.find('fcother')) {
            request = FlowGovernanceController.requestActivation(
                'local',
                FLOW,
                'Demo',
                3,
                null,
                'Please',
                '2 changes',
                2,
                null,
                null
            );
            Assert.areEqual('Pending', request.status);
            Assert.areEqual(2, request.comparedVersion);
            Assert.areEqual('Tributary fcowner', request.approverName);
            Assert.isTrue(request.canCancel);
            Assert.isFalse(request.canDecide);
            Assert.areEqual(1, FlowGovernanceController.listRequests('submitted', null).size());
            Assert.isTrue(FlowGovernanceController.listRequests('mine', null).isEmpty());
            FlowGovernanceController.FlowStatus status = FlowGovernanceController.getFlowStatus('local', FLOW);
            Assert.areEqual('Watch', status.governance.mode);
            Assert.isFalse(status.canActivate);
            Assert.isTrue(status.canRequest);
            Assert.isFalse(status.canGovern);
            Assert.areEqual(1, status.pending.size());
            Assert.isNull(status.pending[0].comments, 'Activation cards don\'t show a request\'s text');
            Assert.isFalse(status.monitor.scheduled, 'Governed flows say whether checks run');
        }
        // An admin may decide in the owner's place, but it isn't waiting for them.
        System.runAs(FlowCompareTestMock.find('fcadmin')) {
            Assert.isTrue(FlowGovernanceController.listRequests('mine', 'Pending').isEmpty());
            FlowGovernanceController.Request other = FlowGovernanceController.listRequests('all', 'Pending')[0];
            Assert.isTrue(other.canDecide);
            Assert.isTrue(other.overrides);
        }
        System.runAs(FlowCompareTestMock.find('fcowner')) {
            List<FlowGovernanceController.Request> mine = FlowGovernanceController.listRequests('mine', 'Pending');
            Assert.areEqual(1, mine.size());
            Assert.isTrue(mine[0].canDecide);
            Assert.isFalse(mine[0].canCancel);
            Assert.isTrue(FlowGovernanceController.getFlowStatus('local', FLOW).governance.isOwner);
            request = FlowGovernanceController.rejectRequest(request.id, 'Not yet');
            Assert.areEqual('Rejected', request.status);
            Assert.areEqual('Tributary fcowner', request.decidedBy);
        }
        System.runAs(FlowCompareTestMock.find('fcother')) {
            try {
                FlowGovernanceController.cancelRequest(request.id);
                Assert.fail('A rejected request stays rejected');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('already rejected'));
            }
            try {
                FlowGovernanceController.removeGovernance(governance.id);
                Assert.fail('Only admins remove governance');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('Admin'));
            }
        }
        System.runAs(FlowCompareTestMock.find('fcadmin')) {
            Assert.areEqual(1, FlowGovernanceController.listGoverned().size());
            Assert.areEqual(1, FlowGovernanceController.listRequests('all', null).size());
            List<FlowGovernanceController.AuditEvent> events = FlowGovernanceController.listAuditEvents(
                'local',
                FLOW,
                null
            );
            Assert.areEqual(3, events.size());
            Assert.areEqual('Rejected', events[0].type);
            Assert.areEqual('local', events[0].connection);
            Assert.areEqual(1, FlowGovernanceController.listAuditEvents(null, null, 1).size());
            FlowGovernanceController.removeGovernance(governance.id);
            Assert.isTrue(FlowGovernanceController.listGoverned().isEmpty());
        }
    }

    @IsTest
    static void pendingRequestsAndHistoryIncludeLocalNamespaceAliases() {
        String home = [SELECT NamespacePrefix FROM Organization LIMIT 1].NamespacePrefix;
        if (String.isBlank(home))
            return;
        String qualified = home + '__' + FLOW;
        System.runAs(FlowCompareTestMock.installer()) {
            govern(2);
            List<Flow_Activation_Request__c> requests = new List<Flow_Activation_Request__c>();
            List<Flow_Audit_Event__c> events = new List<Flow_Audit_Event__c>();
            for (String name : new List<String>{ FLOW, qualified, 'vendor__' + FLOW }) {
                requests.add(
                    new Flow_Activation_Request__c(
                        Flow_Api_Name__c = name,
                        Version_Number__c = 3,
                        Status__c = 'Pending'
                    )
                );
                events.add(new Flow_Audit_Event__c(Flow_Api_Name__c = name, Event_Type__c = 'Requested'));
            }
            requests.add(
                new Flow_Activation_Request__c(
                    Flow_Api_Name__c = FLOW,
                    Connection__c = 'Other_Org',
                    Version_Number__c = 3,
                    Status__c = 'Pending'
                )
            );
            events.add(
                new Flow_Audit_Event__c(
                    Flow_Api_Name__c = FLOW,
                    Connection__c = 'Other_Org',
                    Event_Type__c = 'Requested'
                )
            );
            insert requests;
            insert events;
            System.runAs(FlowCompareTestMock.find('fcowner')) {
                for (String name : new List<String>{ FLOW, qualified }) {
                    Assert.areEqual(2, FlowGovernanceController.getFlowStatus('local', name).pending.size());
                    Assert.areEqual(2, FlowGovernanceController.listAuditEvents('local', name, null).size());
                }
                Assert.areEqual(1, FlowGovernanceController.getFlowStatus('local', 'vendor__' + FLOW).pending.size());
                Assert.areEqual(1, FlowGovernanceController.listAuditEvents('Other_Org', FLOW, null).size());
            }
        }
    }

    @IsTest
    static void ownersApproveAndCancelThroughTheController() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(2);
            Id first;
            Id second;
            System.runAs(FlowCompareTestMock.find('fcother')) {
                first = FlowGovernanceController.requestActivation(
                        'local',
                        FLOW,
                        'Demo',
                        3,
                        null,
                        null,
                        null,
                        null,
                        null,
                        null
                    )
                    .id;
                second = FlowGovernanceController.requestActivation(
                        'local',
                        FLOW,
                        'Demo',
                        0,
                        null,
                        null,
                        null,
                        null,
                        null,
                        null
                    )
                    .id;
                Assert.areEqual('Cancelled', FlowGovernanceController.cancelRequest(second).status);
            }
            Test.setMock(HttpCalloutMock.class, definitionMock(2, null));
            FlowGovernanceController.Request approved;
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcowner')) {
                approved = FlowGovernanceController.approveRequest(first, 'Ship it');
            }
            Test.stopTest();
            approved = (FlowGovernanceController.Request) JSON.deserialize(
                FlowGovernanceController.getOperation(approved.operationId).result,
                FlowGovernanceController.Request.class
            );
            Assert.areEqual('Activated', approved.status);
            Assert.areEqual('Ship it', approved.decisionComments);
            Assert.isFalse(approved.canDecide);
        }
    }

    @IsTest
    static void ownersActivateThroughTheController() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(2);
            Test.setMock(HttpCalloutMock.class, definitionMock(2, null));
            FlowGovernanceController.Request activated;
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcother')) {
                try {
                    FlowGovernanceController.activateVersion(
                        'local',
                        FLOW,
                        'Demo',
                        3,
                        null,
                        null,
                        null,
                        null,
                        null,
                        null
                    );
                    Assert.fail('Only the owner may activate');
                } catch (AuraHandledException e) {
                    Assert.isTrue(e.getMessage().contains('Request activation'), e.getMessage());
                }
            }
            System.runAs(FlowCompareTestMock.find('fcowner')) {
                activated = FlowGovernanceController.activateVersion(
                    'local',
                    FLOW,
                    'Demo',
                    3,
                    FlowCompareTestMock.VERSION_ID,
                    'Hotfix',
                    '1 element changed',
                    null,
                    null,
                    null
                );
            }
            Test.stopTest();
            activated = (FlowGovernanceController.Request) JSON.deserialize(
                FlowGovernanceController.getOperation(activated.operationId).result,
                FlowGovernanceController.Request.class
            );
            Assert.areEqual('Activated', activated.status);
            Assert.areEqual(3, activated.versionNumber);
            Assert.areEqual('Tributary fcowner', activated.decidedBy);
            Assert.isFalse(activated.canDecide);
        }
    }

    @IsTest
    static void adminsRunTheCheckOnDemand() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(2);
            Test.setMock(HttpCalloutMock.class, definitionMock(3, FlowCompareTestMock.find('fcother').Id));
            List<FlowGovernanceController.CheckResult> results;
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcother')) {
                try {
                    FlowGovernanceController.runCheck();
                    Assert.fail('Only admins run checks');
                } catch (AuraHandledException e) {
                    Assert.isTrue(e.getMessage().contains('Admin'));
                }
            }
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                results = FlowGovernanceController.runCheck();
            }
            Test.stopTest();
            results = (List<FlowGovernanceController.CheckResult>) JSON.deserialize(
                FlowGovernanceController.getOperation(results[0].operationId).result,
                List<FlowGovernanceController.CheckResult>.class
            );
            Assert.areEqual(1, results.size());
            Assert.areEqual('reverted', results[0].outcome);
            Assert.areEqual(2, results[0].activeVersion);
            Assert.areEqual(2, results[0].approvedVersion);
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                FlowGovernanceController.Governance governance = FlowGovernanceController.listGoverned()[0];
                Assert.areEqual('reverted', governance.lastCheckOutcome);
                Assert.areEqual('Reverted version 3 to version 2.', governance.lastCheckMessage);
            }
        }
    }

    @IsTest
    static void everyoneSeesWhetherChecksRun() {
        System.runAs(FlowCompareTestMock.find('fcadmin')) {
            FlowGovernanceMonitor.start(30);
            FlowGovernanceMonitor.Status monitor = FlowGovernanceController.getMonitor();
            Assert.isTrue(monitor.scheduled);
            Assert.areEqual(30, monitor.intervalMinutes);
            Assert.isNotNull(monitor.nextRun);
            Assert.isNotNull(monitor.runningAs);
        }
        System.runAs(FlowCompareTestMock.find('fcother')) {
            FlowGovernanceMonitor.Status monitor = FlowGovernanceController.getMonitor();
            Assert.isTrue(monitor.scheduled);
            Assert.areEqual(30, monitor.intervalMinutes);
            Assert.isNull(monitor.runningAs, 'Who checks run as is for admins');
        }
    }

    @IsTest
    static void unrelatedRecentRequestsDoNotHideAnOwnersQueue() {
        System.runAs(FlowCompareTestMock.installer()) {
            Flow_Governance__c mine = govern(2);
            Flow_Governance__c other = new Flow_Governance__c(
                Name = 'Other',
                Flow_Api_Name__c = 'Other',
                Flow_Key__c = 'local:Other',
                Mode__c = 'Locked',
                Owner_User__c = FlowCompareTestMock.find('fcother').Id
            );
            insert other;
            Flow_Activation_Request__c older = new Flow_Activation_Request__c(
                Flow_Api_Name__c = FLOW,
                Governance__c = mine.Id,
                Version_Number__c = 3,
                Status__c = 'Pending'
            );
            insert older;
            Test.setCreatedDate(older.Id, System.now().addDays(-1));
            List<Flow_Activation_Request__c> unrelated = new List<Flow_Activation_Request__c>();
            for (Integer i = 0; i < 501; i++)
                unrelated.add(
                    new Flow_Activation_Request__c(
                        Flow_Api_Name__c = 'Other',
                        Governance__c = other.Id,
                        Version_Number__c = 3,
                        Status__c = 'Pending'
                    )
                );
            insert unrelated;
            System.runAs(FlowCompareTestMock.find('fcowner')) {
                List<FlowGovernanceController.Request> requests = FlowGovernanceController.listRequests(
                    'mine',
                    'Pending'
                );
                Assert.areEqual(1, requests.size());
                Assert.areEqual(older.Id, requests[0].id);
            }
        }
    }

    @IsTest
    static void usersWhoCantReadGovernanceStillGetTheRightButtons() {
        System.runAs(FlowCompareTestMock.installer()) {
            User outsider;
            System.runAs(FlowCompareTestMock.installer()) {
                outsider = FlowCompareTestMock.plainUser('fcnone', new List<String>());
            }
            govern(2);
            System.runAs(outsider) {
                FlowGovernanceController.FlowStatus status = FlowGovernanceController.getFlowStatus('local', FLOW);
                Assert.isNull(status.governance, 'Governance they can\'t read isn\'t shown');
                Assert.isFalse(status.canActivate, 'but it still decides who may activate');
                Assert.isTrue(status.pending.isEmpty());
            }
        }
    }

    @IsTest
    static void olderRequestsAnAdminOwnsStayInTheirQueue() {
        System.runAs(FlowCompareTestMock.installer()) {
            Flow_Governance__c mine = govern(2);
            mine.Owner_User__c = FlowCompareTestMock.find('fcadmin').Id;
            update mine;
            Flow_Governance__c other = new Flow_Governance__c(
                Name = 'Other',
                Flow_Api_Name__c = 'Other',
                Flow_Key__c = 'local:Other',
                Mode__c = 'Locked',
                Owner_User__c = FlowCompareTestMock.find('fcother').Id
            );
            insert other;
            // Theirs as the owner: one linked to its governance, one older kind matched by name.
            List<Flow_Activation_Request__c> older = new List<Flow_Activation_Request__c>{
                new Flow_Activation_Request__c(
                    Flow_Api_Name__c = FLOW,
                    Governance__c = mine.Id,
                    Version_Number__c = 3,
                    Status__c = 'Pending'
                ),
                new Flow_Activation_Request__c(Flow_Api_Name__c = FLOW, Version_Number__c = 4, Status__c = 'Pending')
            };
            insert older;
            for (Flow_Activation_Request__c request : older) {
                Test.setCreatedDate(request.Id, System.now().addDays(-1));
            }
            // Newer ones they could only decide in the owner's place: linked, by name, and by the local alias.
            String home = [SELECT NamespacePrefix FROM Organization LIMIT 1].NamespacePrefix;
            List<Flow_Activation_Request__c> overridden = new List<Flow_Activation_Request__c>();
            for (Integer i = 0; i < 501; i++) {
                Flow_Activation_Request__c request = new Flow_Activation_Request__c(
                    Flow_Api_Name__c = 'Other',
                    Version_Number__c = 3,
                    Status__c = 'Pending'
                );
                if (Math.mod(i, 3) == 0) {
                    request.Governance__c = other.Id;
                } else if (Math.mod(i, 3) == 1 && String.isNotBlank(home)) {
                    request.Flow_Api_Name__c = home + '__Other';
                }
                overridden.add(request);
            }
            insert overridden;
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                List<FlowGovernanceController.Request> requests = FlowGovernanceController.listRequests(
                    'mine',
                    'Pending'
                );
                Assert.areEqual(2, requests.size(), 'Requests an admin would override don\'t hide their own');
                Assert.areEqual(new Set<Id>{ older[0].Id, older[1].Id }, new Set<Id>{ requests[0].id, requests[1].id });
                Assert.isFalse(requests[0].overrides);
                FlowGovernanceController.RequestPage page = FlowGovernanceController.listRequestPage(
                    'mine',
                    'Pending',
                    null,
                    null,
                    25
                );
                Assert.areEqual(2, page.requests.size());
                Assert.isNull(page.nextBeforeId, 'There\'s no more');
                // Still theirs to decide as admins, from All requests.
                FlowGovernanceController.Request newest = FlowGovernanceController.listRequestPage(
                        'all',
                        'Pending',
                        null,
                        null,
                        1
                    )
                    .requests[0];
                Assert.isTrue(newest.canDecide);
                Assert.isTrue(newest.overrides);
            }
        }
    }

    @IsTest
    static void mineWithAnyStatusIncludesDecidedRequests() {
        System.runAs(FlowCompareTestMock.installer()) {
            Flow_Governance__c governance = govern(2);
            insert new List<Flow_Activation_Request__c>{
                new Flow_Activation_Request__c(
                    Flow_Api_Name__c = FLOW,
                    Governance__c = governance.Id,
                    Version_Number__c = 3,
                    Status__c = 'Pending'
                ),
                new Flow_Activation_Request__c(
                    Flow_Api_Name__c = FLOW,
                    Governance__c = governance.Id,
                    Version_Number__c = 4,
                    Status__c = 'Rejected'
                )
            };
            System.runAs(FlowCompareTestMock.find('fcowner')) {
                Assert.areEqual(2, FlowGovernanceController.listRequests('mine', null).size());
                List<FlowGovernanceController.Request> rejected = FlowGovernanceController.listRequests(
                    'mine',
                    'Rejected'
                );
                Assert.areEqual(1, rejected.size());
                Assert.isFalse(rejected[0].canDecide, 'A decided request can\'t be decided again');
                Assert.areEqual(1, FlowGovernanceController.listRequests('mine', 'Pending').size());
            }
            System.runAs(FlowCompareTestMock.find('fcother')) {
                Assert.isTrue(FlowGovernanceController.listRequests('mine', null).isEmpty());
            }
        }
    }

    @IsTest
    static void aLinkedRequestLoadsInFullWhateverItsStatusOrAge() {
        System.runAs(FlowCompareTestMock.installer()) {
            User outsider;
            System.runAs(FlowCompareTestMock.installer()) {
                outsider = FlowCompareTestMock.plainUser('fcnone', new List<String>());
            }
            Flow_Governance__c governance = govern(2);
            String comments = 'Why?'.repeat(1250);
            Flow_Activation_Request__c request = new Flow_Activation_Request__c(
                Flow_Api_Name__c = FLOW,
                Governance__c = governance.Id,
                Version_Number__c = 3,
                Status__c = 'Rejected',
                Request_Comments__c = comments,
                Change_Summary__c = '1 added.'
            );
            insert request;
            Test.setCreatedDate(request.Id, System.now().addYears(-2));
            System.runAs(FlowCompareTestMock.find('fcowner')) {
                FlowGovernanceController.Request linked = FlowGovernanceController.getRequest(request.Id);
                Assert.areEqual('Rejected', linked.status);
                Assert.isFalse(linked.canDecide);
                Assert.areEqual(comments, linked.comments);
                Assert.isFalse(linked.truncated);
                // A list shows the start of it, and says there's more.
                FlowGovernanceController.Request listed = FlowGovernanceController.listRequestPage(
                        'all',
                        null,
                        null,
                        null,
                        null
                    )
                    .requests[0];
                Assert.areEqual(1000, listed.comments.length());
                Assert.isTrue(listed.comments.startsWith('Why?Why?'));
                Assert.areEqual('1 added.', listed.changeSummary);
                Assert.isTrue(listed.truncated);
            }
            System.runAs(outsider) {
                try {
                    FlowGovernanceController.getRequest(request.Id);
                    Assert.fail('Only those who may read requests see one');
                } catch (AuraHandledException e) {
                    Assert.isTrue(e.getMessage().contains('access'), e.getMessage());
                }
            }
        }
    }

    @IsTest
    static void aFullPageOfTheLongestRequestsReadsAsPreviews() {
        System.runAs(FlowCompareTestMock.installer()) {
            // Every field full, on the largest page there is.
            String longest = 'x'.repeat(32768);
            List<Flow_Activation_Request__c> requests = new List<Flow_Activation_Request__c>();
            for (Integer i = 0; i < 100; i++) {
                requests.add(
                    new Flow_Activation_Request__c(
                        Flow_Api_Name__c = FLOW,
                        Version_Number__c = i,
                        Status__c = 'Pending',
                        Request_Comments__c = longest,
                        Decision_Comments__c = longest,
                        Change_Summary__c = i == 0 ? 'Short.' : longest,
                        Error__c = longest
                    )
                );
            }
            insert requests;
            longest = null;
            requests = null;
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                Test.startTest();
                FlowGovernanceController.RequestPage page = FlowGovernanceController.listRequestPage(
                    'all',
                    'Pending',
                    null,
                    null,
                    100
                );
                Test.stopTest();
                Assert.areEqual(100, page.requests.size());
                Assert.isNull(page.nextBeforeId, 'No lookahead row beyond the hundred');
                for (FlowGovernanceController.Request request : page.requests) {
                    Assert.areEqual(1000, request.comments.length());
                    Assert.areEqual(1000, request.error.length());
                    Assert.isTrue(request.truncated);
                    Assert.areEqual(request.versionNumber == 0 ? 6 : 1000, request.changeSummary.length());
                }
            }
        }
    }

    @IsTest
    static void pagesThroughRequestsAndHistoryWithoutRepeats() {
        System.runAs(FlowCompareTestMock.installer()) {
            List<Flow_Activation_Request__c> requests = new List<Flow_Activation_Request__c>();
            List<Flow_Audit_Event__c> events = new List<Flow_Audit_Event__c>();
            for (Integer i = 0; i < 7; i++) {
                requests.add(
                    new Flow_Activation_Request__c(
                        Flow_Api_Name__c = FLOW,
                        Version_Number__c = i,
                        Status__c = 'Pending'
                    )
                );
                events.add(new Flow_Audit_Event__c(Flow_Api_Name__c = FLOW, Event_Type__c = 'Requested'));
            }
            insert requests;
            insert events;
            // Rows share seconds: three from yesterday, four from now.
            for (Integer i = 0; i < 3; i++) {
                Test.setCreatedDate(requests[i].Id, System.now().addDays(-1));
                Test.setCreatedDate(events[i].Id, System.now().addDays(-1));
            }
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                List<Id> seen = new List<Id>();
                FlowGovernanceController.RequestPage page = FlowGovernanceController.listRequestPage(
                    'all',
                    'Pending',
                    null,
                    null,
                    3
                );
                Integer pages = 1;
                while (true) {
                    for (FlowGovernanceController.Request request : page.requests) {
                        seen.add(request.id);
                    }
                    if (page.nextBeforeId == null) {
                        break;
                    }
                    page = FlowGovernanceController.listRequestPage(
                        'all',
                        'Pending',
                        page.nextBefore,
                        page.nextBeforeId,
                        3
                    );
                    pages++;
                }
                Assert.areEqual(3, pages);
                List<Id> all = new List<Id>();
                for (FlowGovernanceController.Request request : FlowGovernanceController.listRequests('all', null)) {
                    all.add(request.id);
                }
                Assert.areEqual(all, seen, 'Pages follow on in order, each request once');
                Assert.areEqual(new Set<Id>(seen).size(), 7);

                List<Id> history = new List<Id>();
                List<FlowGovernanceController.AuditEvent> shown = FlowGovernanceController.listAuditEventsBefore(
                    'local',
                    FLOW,
                    null,
                    null,
                    3
                );
                while (!shown.isEmpty()) {
                    for (FlowGovernanceController.AuditEvent event : shown) {
                        history.add(event.id);
                    }
                    FlowGovernanceController.AuditEvent last = shown[shown.size() - 1];
                    shown = FlowGovernanceController.listAuditEventsBefore('local', FLOW, last.createdDate, last.id, 3);
                }
                List<Id> newest = new List<Id>();
                for (
                    FlowGovernanceController.AuditEvent event : FlowGovernanceController.listAuditEvents(
                        null,
                        null,
                        null
                    )
                ) {
                    newest.add(event.id);
                }
                Assert.areEqual(newest, history);
                Assert.areEqual(7, new Set<Id>(history).size());
            }
        }
    }

    // Reads requests and their status and version, but none of their text:
    // a narrower permission set than Tributary User, as a subscriber might make.
    private static User limitedUser() {
        return limitedUser(
            new List<Schema.SObjectField>{
                Flow_Activation_Request__c.Status__c,
                Flow_Activation_Request__c.Version_Number__c
            }
        );
    }

    // A plain user who may read requests, but of their fields only these.
    private static User limitedUser(List<Schema.SObjectField> readable) {
        PermissionSet limited = new PermissionSet(Name = 'Tributary_Test_Limited', Label = 'Tributary Test Limited');
        insert limited;
        String requestType = String.valueOf(Flow_Activation_Request__c.SObjectType);
        insert new ObjectPermissions(ParentId = limited.Id, SobjectType = requestType, PermissionsRead = true);
        List<FieldPermissions> fields = new List<FieldPermissions>();
        for (Schema.SObjectField field : readable) {
            fields.add(
                new FieldPermissions(
                    ParentId = limited.Id,
                    SobjectType = requestType,
                    Field = requestType + '.' + field.getDescribe().getName(),
                    PermissionsRead = true
                )
            );
        }
        insert fields;
        return FlowCompareTestMock.plainUser('fclimit', new List<String>{ 'Tributary_Test_Limited' });
    }

    private static Id requestAsOther(Integer version) {
        Id id;
        System.runAs(FlowCompareTestMock.find('fcother')) {
            id = FlowGovernanceController.requestActivation(
                    'local',
                    FLOW,
                    'Demo',
                    version,
                    null,
                    'Please',
                    '1 element changed',
                    null,
                    null,
                    null
                )
                .id;
        }
        return id;
    }

    @IsTest
    static void actingOnARequestShowsOnlyWhatTheUserMayRead() {
        System.runAs(FlowCompareTestMock.installer()) {
            User limited;
            User outsider;
            System.runAs(FlowCompareTestMock.installer()) {
                limited = limitedUser();
                outsider = FlowCompareTestMock.plainUser('fcnone', new List<String>());
            }
            Flow_Governance__c governance = govern(2);
            governance.Owner_User__c = limited.Id;
            update governance;
            Id first = requestAsOther(3);
            System.runAs(limited) {
                FlowGovernanceController.Request rejected = FlowGovernanceController.rejectRequest(first, 'Not yet');
                Assert.areEqual('Rejected', rejected.status);
                Assert.areEqual(3, rejected.versionNumber);
                Assert.isNull(rejected.changeSummary, 'The owner may decide, but not read the summary');
                Assert.isNull(rejected.comments);
                Assert.isNull(rejected.decisionComments);
                // Polling a decision's receipt reads its request the same way.
                Flow_Operation__c receipt = new Flow_Operation__c(
                    Action__c = 'approve',
                    State__c = 'Completed',
                    Result__c = JSON.serialize(new Map<String, Object>{ 'requestId' => first, 'status' => 'Rejected' })
                );
                Database.insert(receipt, AccessLevel.SYSTEM_MODE);
                FlowGovernanceController.Request polled = (FlowGovernanceController.Request) JSON.deserialize(
                    FlowGovernanceController.getOperation(receipt.Id).result,
                    FlowGovernanceController.Request.class
                );
                Assert.areEqual('Rejected', polled.status);
                Assert.isNull(polled.changeSummary);
                Assert.isNull(polled.comments);
            }

            // An owner who can't read requests at all hears only the outcome.
            governance.Owner_User__c = outsider.Id;
            update governance;
            Id second = requestAsOther(4);
            System.runAs(outsider) {
                Assert.isFalse(Schema.sObjectType.Flow_Activation_Request__c.isAccessible());
                FlowGovernanceController.Request rejected = FlowGovernanceController.rejectRequest(second, null);
                Assert.areEqual(second, rejected.id);
                Assert.areEqual('Rejected', rejected.status);
                Assert.isNull(rejected.versionNumber);
                Assert.isNull(rejected.changeSummary);
            }
            Assert.areEqual(
                'Rejected',
                [SELECT Status__c FROM Flow_Activation_Request__c WHERE Id = :second].Status__c
            );
        }
    }

    @IsTest
    static void actingOnARequestSaysWhatHappenedWithoutReadingItsStatus() {
        System.runAs(FlowCompareTestMock.installer()) {
            User limited;
            System.runAs(FlowCompareTestMock.installer()) {
                limited = limitedUser(new List<Schema.SObjectField>{ Flow_Activation_Request__c.Version_Number__c });
            }
            Flow_Governance__c governance = govern(2);
            governance.Owner_User__c = limited.Id;
            update governance;
            Id requestId = requestAsOther(3);
            Flow_Operation__c receipt = new Flow_Operation__c(
                Action__c = 'approve',
                State__c = 'Completed',
                Result__c = JSON.serialize(new Map<String, Object>{ 'requestId' => requestId, 'status' => 'Rejected' })
            );
            System.runAs(limited) {
                Assert.isFalse(Schema.sObjectType.Flow_Activation_Request__c.fields.Status__c.isAccessible());
                FlowGovernanceController.Request rejected = FlowGovernanceController.rejectRequest(
                    requestId,
                    'Not yet'
                );
                Assert.areEqual('Rejected', rejected.status, 'Their own action\'s outcome');
                Assert.areEqual(3, rejected.versionNumber);
                Assert.isNull(rejected.changeSummary, 'Nothing else unreadable is filled back in');
                Assert.isNull(rejected.decisionComments);
                // Polling a receipt says what happened, as flowActivation reads it.
                Database.insert(receipt, AccessLevel.SYSTEM_MODE);
                FlowGovernanceController.Request polled = (FlowGovernanceController.Request) JSON.deserialize(
                    FlowGovernanceController.getOperation(receipt.Id).result,
                    FlowGovernanceController.Request.class
                );
                Assert.areEqual('Rejected', polled.status);
                Assert.areEqual(3, polled.versionNumber);
            }
            // A request they can no longer see at all comes back as the receipt alone.
            delete new Flow_Activation_Request__c(Id = requestId);
            System.runAs(limited) {
                FlowGovernanceController.Request gone = (FlowGovernanceController.Request) JSON.deserialize(
                    FlowGovernanceController.getOperation(receipt.Id).result,
                    FlowGovernanceController.Request.class
                );
                Assert.areEqual(requestId, gone.id);
                Assert.areEqual('Rejected', gone.status);
                Assert.isNull(gone.versionNumber);
            }
        }
    }
}
