@IsTest
private class FlowGovernanceServiceTest {
    private static final String FLOW = 'Demo_Flow';

    @TestSetup
    static void setup() {
        FlowCompareTestMock.grantRunningUser(new List<String>{ 'Flow_Compare_Admin' });
        FlowCompareTestMock.user('fcadmin', new List<String>{ 'Flow_Compare_Admin' });
        FlowCompareTestMock.user('fcowner', new List<String>{ 'Flow_Compare_User' });
        FlowCompareTestMock.user('fcother', new List<String>{ 'Flow_Compare_User' });
        FlowCompareTestMock.plainUser('fcpadmin', new List<String>{ 'Flow_Compare_Admin' });
        FlowCompareTestMock.plainUser('fcpowner', new List<String>{ 'Flow_Compare_User' });
        FlowCompareTestMock.plainUser('fcpother', new List<String>{ 'Flow_Compare_User' });
    }

    private static Flow_Governance__c govern(String mode, Integer approved) {
        return govern(mode, approved, FlowCompareTestMock.find('fcowner').Id);
    }

    private static Flow_Governance__c govern(String mode, Integer approved, Id ownerId) {
        Flow_Governance__c record = new Flow_Governance__c(
            Name = 'Demo Flow',
            Flow_Api_Name__c = FLOW,
            Flow_Key__c = 'local:' + FLOW,
            Owner_User__c = ownerId,
            Mode__c = mode,
            Approved_Version__c = approved,
            Active_Version__c = approved
        );
        insert record;
        return record;
    }

    private static FlowGovernanceService.RequestInput input(Integer version) {
        FlowGovernanceService.RequestInput input = new FlowGovernanceService.RequestInput();
        input.apiName = FLOW;
        input.label = 'Demo Flow';
        input.versionNumber = version;
        input.versionId = FlowCompareTestMock.VERSION_ID;
        input.comments = 'Please';
        input.changeSummary = '1 element changed';
        return input;
    }

    private static FlowCompareTestMock activationMock(Integer active, Integer patchStatus) {
        return activationMock(active, patchStatus, '2020-01-01T00:00:00.000+0000');
    }

    // versionModified is when the requested version was last saved.
    private static FlowCompareTestMock activationMock(Integer active, Integer patchStatus, String versionModified) {
        return new FlowCompareTestMock()
            .route(
                'GET',
                'FROM FlowDefinition',
                200,
                FlowCompareTestMock.page(
                    new List<Object>{ FlowCompareTestMock.definition(FLOW, active, 3, UserInfo.getUserId()) }
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
                            'LastModifiedDate' => versionModified
                        }
                    }
                )
            )
            .route(
                'POST',
                'FlowDefinition/' + FlowCompareTestMock.DEFINITION_ID + '?_HttpMethod=PATCH',
                patchStatus,
                patchStatus < 300 ? null : FlowCompareTestMock.error('Not allowed', 'FIELD_INTEGRITY_EXCEPTION')
            );
    }

    private static List<String> events() {
        List<String> types = new List<String>();
        for (Flow_Audit_Event__c event : [SELECT Event_Type__c FROM Flow_Audit_Event__c ORDER BY Name]) {
            types.add(event.Event_Type__c);
        }
        return types;
    }

    @IsTest
    static void ownerApprovesAnotherUsersRequest() {
        System.runAs(FlowCompareTestMock.installer()) {
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                govern(FlowGovernanceService.MODE_WATCH, 2);
            }
            Flow_Activation_Request__c request;
            System.runAs(FlowCompareTestMock.find('fcother')) {
                request = FlowGovernanceService.requestActivation(input(3));
                Assert.areEqual(FlowCompareTestMock.find('fcowner').Id, request.Approver__c);
                try {
                    FlowGovernanceService.approve(request.Id, null);
                    Assert.fail('Only the owner may approve');
                } catch (FlowGovernanceService.GovernanceException e) {
                    Assert.isTrue(e.getMessage().contains('owner'));
                }
            }
            FlowCompareTestMock mock = activationMock(2, 204);
            Test.setMock(HttpCalloutMock.class, mock);
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcowner')) {
                FlowGovernanceService.approve(request.Id, 'Looks good');
            }
            Test.stopTest();

            request = FlowGovernanceService.loadRequest(request.Id);
            Assert.areEqual(FlowGovernanceService.ACTIVATED, request.Status__c);
            Assert.areEqual(FlowCompareTestMock.find('fcowner').Id, request.Decided_By__c);
            Assert.areEqual(1, mock.count('POST', '_HttpMethod=PATCH'));
            Assert.areEqual(1, mock.count('GET', 'FROM Flow WHERE'));
            Assert.isTrue(mock.requests[2].getBody().contains('"activeVersionNumber":3'));
            Assert.areEqual(3, [SELECT Approved_Version__c FROM Flow_Governance__c].Approved_Version__c);
            Assert.areEqual(new List<String>{ 'Requested', 'Approved', 'Activated' }, events());
            Assert.isFalse(FlowGovernanceService.sentNotifications.isEmpty());
            String target = (String) FlowGovernanceService.sentNotifications[0].get('target');
            Assert.isTrue(target.contains('Flow_Approvals'), target);
            Assert.isTrue(target.contains(request.Id), target);
        }
    }

    @IsTest
    static void failedActivationIsRecorded() {
        System.runAs(FlowCompareTestMock.installer()) {
            User owner = FlowCompareTestMock.find('fcowner');
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                govern(FlowGovernanceService.MODE_LOCKED, 2);
            }
            Test.setMock(HttpCalloutMock.class, activationMock(2, 400));
            Flow_Activation_Request__c request;
            System.runAs(owner) {
                request = FlowGovernanceService.requestActivation(input(3));
            }
            // Callouts can't follow DML in the same test context without startTest.
            Test.startTest();
            System.runAs(owner) {
                request = FlowGovernanceService.approve(request.Id, null);
            }
            Test.stopTest();
            Assert.areEqual(FlowGovernanceService.FAILED, request.Status__c);
            Assert.areEqual('Not allowed', request.Error__c);
            Assert.areEqual(2, [SELECT Approved_Version__c FROM Flow_Governance__c].Approved_Version__c);
            Assert.areEqual(new List<String>{ 'Requested', 'Approved', 'Activation Failed' }, events());
        }
    }

    @IsTest
    static void staleRequestDoesNotUndoANewerActivation() {
        System.runAs(FlowCompareTestMock.installer()) {
            User owner = FlowCompareTestMock.find('fcowner');
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                govern(FlowGovernanceService.MODE_WATCH, 1);
            }
            Flow_Activation_Request__c stale;
            System.runAs(FlowCompareTestMock.find('fcother')) {
                FlowGovernanceService.RequestInput old = input(3);
                old.replacesVersion = 1;
                stale = FlowGovernanceService.requestActivation(old);
            }
            // Version 2 was activated after the request was made. (Each
            // approval is its own transaction, so a request that replaces
            // version 2 is approved in currentRequestActivates.)
            FlowCompareTestMock mock = activationMock(2, 204);
            Test.setMock(HttpCalloutMock.class, mock);
            Test.startTest();
            System.runAs(owner) {
                FlowGovernanceService.approve(stale.Id, null);
            }
            Test.stopTest();
            stale = FlowGovernanceService.loadRequest(stale.Id);
            Assert.areEqual(FlowGovernanceService.FAILED, stale.Status__c);
            Assert.isTrue(stale.Error__c.contains('from version 1 to version 2'), stale.Error__c);
            Assert.areEqual(0, mock.count('POST', '_HttpMethod=PATCH'));
        }
    }

    @IsTest
    static void currentRequestActivates() {
        System.runAs(FlowCompareTestMock.installer()) {
            User owner = FlowCompareTestMock.find('fcowner');
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                govern(FlowGovernanceService.MODE_WATCH, 1);
            }
            Flow_Activation_Request__c current;
            System.runAs(FlowCompareTestMock.find('fcother')) {
                FlowGovernanceService.RequestInput fresh = input(3);
                fresh.replacesVersion = 2;
                current = FlowGovernanceService.requestActivation(fresh);
            }
            FlowCompareTestMock mock = activationMock(2, 204);
            Test.setMock(HttpCalloutMock.class, mock);
            Test.startTest();
            System.runAs(owner) {
                FlowGovernanceService.approve(current.Id, null);
            }
            Test.stopTest();
            current = FlowGovernanceService.loadRequest(current.Id);
            Assert.areEqual(FlowGovernanceService.ACTIVATED, current.Status__c);
            Assert.areEqual(1, mock.count('POST', '_HttpMethod=PATCH'));
        }
    }

    @IsTest
    static void ownerRejectsAndRequesterCancels() {
        System.runAs(FlowCompareTestMock.installer()) {
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                govern(FlowGovernanceService.MODE_WATCH, 2);
            }
            Flow_Activation_Request__c first;
            Flow_Activation_Request__c second;
            System.runAs(FlowCompareTestMock.find('fcother')) {
                first = FlowGovernanceService.requestActivation(input(3));
                second = FlowGovernanceService.requestActivation(input(0));
            }
            System.runAs(FlowCompareTestMock.find('fcowner')) {
                Assert.areEqual(
                    FlowGovernanceService.REJECTED,
                    FlowGovernanceService.reject(first.Id, 'Not yet').Status__c
                );
                try {
                    FlowGovernanceService.cancel(second.Id);
                    Assert.fail('Only the requester may cancel');
                } catch (FlowGovernanceService.GovernanceException e) {
                    Assert.isTrue(e.getMessage().contains('cancel'));
                }
            }
            System.runAs(FlowCompareTestMock.find('fcother')) {
                Assert.areEqual(FlowGovernanceService.CANCELLED, FlowGovernanceService.cancel(second.Id).Status__c);
                try {
                    FlowGovernanceService.cancel(second.Id);
                    Assert.fail('A decided request stays decided');
                } catch (FlowGovernanceService.GovernanceException e) {
                    Assert.isTrue(e.getMessage().contains('already'));
                }
            }
            Assert.areEqual(new List<String>{ 'Requested', 'Requested', 'Rejected', 'Cancelled' }, events());
        }
    }

    @IsTest
    static void approvalRefusesAVersionEditedAfterTheRequest() {
        System.runAs(FlowCompareTestMock.installer()) {
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                govern(FlowGovernanceService.MODE_WATCH, 2);
            }
            Flow_Activation_Request__c request;
            System.runAs(FlowCompareTestMock.find('fcother')) {
                request = FlowGovernanceService.requestActivation(input(3));
            }
            FlowCompareTestMock mock = activationMock(2, 204, '2099-01-01T00:00:00.000+0000');
            Test.setMock(HttpCalloutMock.class, mock);
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcowner')) {
                request = FlowGovernanceService.approve(request.Id, null);
            }
            Test.stopTest();
            Assert.areEqual(FlowGovernanceService.FAILED, request.Status__c);
            Assert.isTrue(request.Error__c.contains('changed after it was requested'), request.Error__c);
            Assert.areEqual(0, mock.count('POST', '_HttpMethod=PATCH'));
            Assert.areEqual(2, [SELECT Approved_Version__c FROM Flow_Governance__c].Approved_Version__c);
        }
    }

    @IsTest
    static void approvalRefusesAVersionEditedAfterItsMergeWasReviewed() {
        System.runAs(FlowCompareTestMock.installer()) {
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                govern(FlowGovernanceService.MODE_WATCH, 2);
            }
            // Saved from a merge on the 1st, edited on the 2nd, requested after.
            FlowGovernanceService.RequestInput reviewed = input(3);
            reviewed.reviewedAt = Datetime.newInstanceGmt(2026, 9, 1, 10, 0, 0);
            reviewed.changeSummary = 'Decided:\n- 2 differences.';
            Flow_Activation_Request__c request;
            System.runAs(FlowCompareTestMock.find('fcother')) {
                request = FlowGovernanceService.requestActivation(reviewed);
            }
            Assert.areEqual(
                reviewed.reviewedAt,
                [SELECT Reviewed_At__c FROM Flow_Activation_Request__c WHERE Id = :request.Id].Reviewed_At__c
            );
            FlowCompareTestMock mock = activationMock(2, 204, '2026-09-02T10:00:00.000+0000');
            Test.setMock(HttpCalloutMock.class, mock);
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcowner')) {
                request = FlowGovernanceService.approve(request.Id, null);
            }
            Test.stopTest();
            Assert.areEqual(FlowGovernanceService.FAILED, request.Status__c);
            Assert.areEqual(
                'Version 3 was changed after its merge was reviewed, so it isn\'t what the summary describes. Compare it again and make a new request.',
                request.Error__c
            );
            Assert.areEqual(0, mock.count('POST', '_HttpMethod=PATCH'));
        }
    }

    @IsTest
    static void activatesAReviewedVersionUnchangedSinceItWasSaved() {
        Flow_Activation_Request__c activated = activateReviewed(Datetime.newInstanceGmt(2026, 9, 1, 10, 0, 0), 1);
        Assert.areEqual(FlowGovernanceService.ACTIVATED, activated.Status__c);
    }

    @IsTest
    static void refusesToActivateAReviewedVersionChangedSince() {
        Flow_Activation_Request__c refused = activateReviewed(Datetime.newInstanceGmt(2026, 8, 31, 10, 0, 0), 0);
        Assert.areEqual(FlowGovernanceService.FAILED, refused.Status__c);
        Assert.isTrue(refused.Error__c.endsWith('Compare it again before activating it.'), refused.Error__c);
    }

    // The owner activates version 3, last saved 2026-09-01 10:00 UTC, as
    // reviewed at reviewedAt.
    private static Flow_Activation_Request__c activateReviewed(Datetime reviewedAt, Integer patches) {
        System.runAs(FlowCompareTestMock.find('fcadmin')) {
            govern(FlowGovernanceService.MODE_LOCKED, 2);
        }
        FlowGovernanceService.RequestInput reviewed = input(3);
        reviewed.reviewedAt = reviewedAt;
        FlowCompareTestMock mock = activationMock(2, 204, '2026-09-01T10:00:00.000+0000');
        Test.setMock(HttpCalloutMock.class, mock);
        Flow_Activation_Request__c request;
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcowner')) {
            request = FlowGovernanceService.activateNow(reviewed);
        }
        Test.stopTest();
        Assert.areEqual(1, mock.count('GET', 'FROM Flow WHERE'));
        Assert.areEqual(patches, mock.count('POST', '_HttpMethod=PATCH'));
        return request;
    }

    @IsTest
    static void ownersActivateDirectlyAndOthersCannot() {
        System.runAs(FlowCompareTestMock.installer()) {
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                govern(FlowGovernanceService.MODE_LOCKED, 2);
            }
            FlowCompareTestMock mock = activationMock(2, 204);
            Test.setMock(HttpCalloutMock.class, mock);
            Flow_Activation_Request__c request;
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcother')) {
                try {
                    FlowGovernanceService.activateNow(input(3));
                    Assert.fail('Only the owner may activate a governed flow');
                } catch (FlowGovernanceService.GovernanceException e) {
                    Assert.isTrue(e.getMessage().contains('Request activation'));
                }
            }
            System.runAs(FlowCompareTestMock.find('fcowner')) {
                request = FlowGovernanceService.activateNow(input(3));
            }
            Test.stopTest();
            Assert.areEqual(FlowGovernanceService.ACTIVATED, request.Status__c);
            Assert.areEqual(FlowCompareTestMock.find('fcowner').Id, request.Decided_By__c);
            Assert.isNull(request.Decision_Comments__c);
            // A direct activation checks nothing a request could have gone stale on.
            Assert.areEqual(0, mock.count('GET', 'FROM Flow WHERE'));
            Assert.areEqual(1, mock.count('POST', '_HttpMethod=PATCH'));
            Assert.areEqual(3, [SELECT Approved_Version__c FROM Flow_Governance__c].Approved_Version__c);
            Assert.areEqual(new List<String>{ 'Activated' }, events());
            Assert.areEqual('Please', [SELECT Details__c FROM Flow_Audit_Event__c].Details__c);
            Assert.isTrue(FlowGovernanceService.sentNotifications.isEmpty());
        }
    }

    @IsTest
    static void ownersHearWhenAnAdminActivatesTheirFlow() {
        System.runAs(FlowCompareTestMock.installer()) {
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                govern(FlowGovernanceService.MODE_WATCH, 2);
            }
            Test.setMock(HttpCalloutMock.class, activationMock(2, 204));
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                FlowGovernanceService.activateNow(input(0));
            }
            Test.stopTest();
            Assert.areEqual(0, [SELECT Approved_Version__c FROM Flow_Governance__c].Approved_Version__c);
            Assert.areEqual(1, FlowGovernanceService.sentNotifications.size());
            Map<String, Object> sent = FlowGovernanceService.sentNotifications[0];
            Assert.isTrue(((String) sent.get('body')).contains('activated'), (String) sent.get('body'));
            Assert.isTrue(((String) sent.get('target')).contains('Governed_Flows'), (String) sent.get('target'));
            // The comment is the request's; the decision only says whose it was.
            Flow_Activation_Request__c decided = [
                SELECT Request_Comments__c, Decision_Comments__c
                FROM Flow_Activation_Request__c
            ];
            Assert.areEqual('Please', decided.Request_Comments__c);
            Assert.areEqual('Admin override.', decided.Decision_Comments__c);
            Flow_Audit_Event__c activated = [
                SELECT Details__c
                FROM Flow_Audit_Event__c
                WHERE Event_Type__c = 'Activated'
            ];
            Assert.areEqual('Admin override: Please', activated.Details__c);
        }
    }

    @IsTest
    static void localUsersWhoCanSaveActivateUngovernedFlows() {
        Test.setMock(HttpCalloutMock.class, activationMock(2, 204));
        Flow_Activation_Request__c request;
        System.runAs(FlowCompareTestMock.find('fcother')) {
            Assert.isTrue(FlowGovernanceService.canApprove(null, null));
            Assert.isFalse(FlowGovernanceService.canApprove('Staging', null), 'Other orgs are admin-only');
            request = FlowGovernanceService.requestActivation(input(3));
            Assert.isNull(request.Approver__c);
        }
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcother')) {
            request = FlowGovernanceService.approve(request.Id, null);
        }
        Test.stopTest();
        Assert.areEqual(FlowGovernanceService.ACTIVATED, request.Status__c);
    }

    @IsTest
    static void recognisesManageFlowGrantedByAProfile() {
        User viaProfile = FlowCompareTestMock.find('fcother');
        Id profileId = [SELECT ProfileId FROM User WHERE Id = :viaProfile.Id].ProfileId;
        // Its profile grants Manage Flow, and none of its permission sets do. Every
        // user is assigned their profile's own permission set, so the query sees it.
        Assert.isTrue(
            [
                SELECT PermissionsManageInteraction
                FROM PermissionSet
                WHERE IsOwnedByProfile = TRUE AND ProfileId = :profileId
            ]
            .PermissionsManageInteraction
        );
        Assert.areEqual(
            0,
            [
                SELECT COUNT()
                FROM PermissionSetAssignment
                WHERE
                    AssigneeId = :viaProfile.Id
                    AND PermissionSet.IsOwnedByProfile = FALSE
                    AND PermissionSet.PermissionsManageInteraction = TRUE
            ]
        );
        System.runAs(viaProfile) {
            Assert.isTrue(FlowGovernanceService.hasManageFlow());
            Assert.isTrue(FlowGovernanceService.canSave(null));
        }
        System.runAs(FlowCompareTestMock.find('fcpother')) {
            Assert.isFalse(FlowGovernanceService.hasManageFlow());
            Assert.isFalse(FlowGovernanceService.canSave(null));
            Assert.isTrue(FlowGovernanceService.canSave('Staging'), 'Manage Flow is this org\'s permission');
        }
    }

    @IsTest
    static void requestsNeedAVersion() {
        System.runAs(FlowCompareTestMock.find('fcother')) {
            try {
                FlowGovernanceService.requestActivation(input(null));
                Assert.fail('A version is required');
            } catch (FlowGovernanceService.GovernanceException e) {
                Assert.isTrue(e.getMessage().contains('version'));
            }
        }
    }

    @IsTest
    static void systemUsersCannotOwnAFlow() {
        List<User> automated = [SELECT Id FROM User WHERE UserType = 'AutomatedProcess' LIMIT 1];
        User inactive = FlowCompareTestMock.find('fcowner');
        System.runAs(FlowCompareTestMock.installer()) {
            inactive.IsActive = false;
            update inactive;
        }
        System.runAs(FlowCompareTestMock.installer()) {
            FlowGovernanceService.GovernanceInput input = new FlowGovernanceService.GovernanceInput();
            input.apiName = FLOW;
            input.mode = FlowGovernanceService.MODE_WATCH;
            List<Id> owners = new List<Id>{ inactive.Id };
            if (!automated.isEmpty()) {
                owners.add(automated[0].Id);
            }
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                for (Id owner : owners) {
                    input.ownerId = owner;
                    try {
                        FlowGovernanceService.saveGovernance(input);
                        Assert.fail('Only an active person may own a flow');
                    } catch (FlowGovernanceService.GovernanceException e) {
                        Assert.isTrue(e.getMessage().contains('active Salesforce user'), e.getMessage());
                    }
                }
            }
            Assert.areEqual(0, [SELECT COUNT() FROM Flow_Governance__c]);
        }
    }

    @IsTest
    static void apiOnlyUsersCannotOwnAFlow() {
        User apiOnly = FlowCompareTestMock.find('fcowner');
        System.runAs(FlowCompareTestMock.installer()) {
            PermissionSet api = new PermissionSet(
                Name = 'Tributary_Test_Api_Only',
                Label = 'Tributary Test API Only',
                PermissionsApiEnabled = true,
                PermissionsApiUserOnly = true
            );
            insert api;
            insert new PermissionSetAssignment(AssigneeId = apiOnly.Id, PermissionSetId = api.Id);
        }
        System.runAs(FlowCompareTestMock.installer()) {
            FlowGovernanceService.GovernanceInput input = new FlowGovernanceService.GovernanceInput();
            input.apiName = FLOW;
            input.mode = FlowGovernanceService.MODE_WATCH;
            input.ownerId = apiOnly.Id;
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                try {
                    FlowGovernanceService.saveGovernance(input);
                    Assert.fail('An API-only user can\'t sign in to approve');
                } catch (FlowGovernanceService.GovernanceException e) {
                    Assert.isTrue(e.getMessage().contains('API-only'), e.getMessage());
                }
            }
            Assert.areEqual(0, [SELECT COUNT() FROM Flow_Governance__c]);
        }
    }

    // A subscriber may make governance private. Tests can't change its
    // sharing, which is Public Read/Write here, so this checks the selector
    // authorization reads through, which ignores sharing: as a user who can't
    // read governance at all, it finds and locks a record they don't own.
    @IsTest
    static void authorizationFindsGovernanceWhateverTheUsersAccess() {
        System.runAs(FlowCompareTestMock.installer()) {
            User outsider;
            System.runAs(FlowCompareTestMock.installer()) {
                outsider = FlowCompareTestMock.plainUser('fcnone', new List<String>());
            }
            Flow_Governance__c record = govern(FlowGovernanceService.MODE_LOCKED, 2);
            System.runAs(outsider) {
                Assert.isFalse(Schema.sObjectType.Flow_Governance__c.isAccessible());
                FlowGovernanceService.Policy policies = new FlowGovernanceService.Policy();
                List<String> keys = FlowGovernanceService.flowKeys(null, FLOW);
                Assert.areEqual(record.Id, policies.find(keys, false)[0].Id);
                Assert.areEqual(record.Id, policies.find(keys, true)[0].Id);
                Assert.areEqual(record.Id, FlowGovernanceService.findGovernance(null, FLOW).Id);
                Assert.areEqual(
                    1,
                    FlowGovernanceService.governanceFor(new Set<Id>{ record.Id }, new Set<String>()).size()
                );
                Assert.areEqual(1, FlowGovernanceService.allGovernance().size());
                Assert.isFalse(
                    FlowGovernanceService.canApprove(null, FlowGovernanceService.findGovernance(null, FLOW))
                );
            }
        }
    }

    // A permission set of a subscriber's own, granting only the Tributary Admin custom permission.
    private static String adminOnly() {
        PermissionSet permissionSet = new PermissionSet(
            Name = 'Tributary_Test_Admin_Only',
            Label = 'Tributary Test Admin Only'
        );
        insert permissionSet;
        insert new SetupEntityAccess(
            ParentId = permissionSet.Id,
            SetupEntityId = [
                SELECT Id
                FROM CustomPermission
                WHERE DeveloperName = 'Flow_Compare_Admin' AND NamespacePrefix = :FlowGovernanceService.NAMESPACE
            ]
            .Id
        );
        return permissionSet.Name;
    }

    // An admin by a subscriber's own permission set, without View All, runs
    // the check. Governance is Public Read/Write here, so the record can't be
    // hidden from them in this org; made Private, the check must still see,
    // revert and save it rather than skip it and report itself complete.
    @IsTest
    static void aCheckEnforcesGovernanceItsAdminCannotSee() {
        System.runAs(FlowCompareTestMock.installer()) {
            User admin;
            System.runAs(FlowCompareTestMock.installer()) {
                admin = FlowCompareTestMock.plainUser('fcaonly', new List<String>{ 'Flow_Compare_User', adminOnly() });
            }
            Flow_Governance__c record = govern(FlowGovernanceService.MODE_LOCKED, 2);
            FlowCompareTestMock mock = checkMock(3, FlowCompareTestMock.find('fcother').Id, 204);
            Test.setMock(HttpCalloutMock.class, mock);
            List<FlowGovernanceService.CheckResult> results;
            Test.startTest();
            System.runAs(admin) {
                Assert.isTrue(FlowGovernanceService.isAdmin());
                Assert.areEqual(1, FlowGovernanceService.countDue(System.now().addMinutes(1), new List<Id>()));
                results = FlowGovernanceService.checkAll();
            }
            Test.stopTest();
            Assert.areEqual(1, results.size());
            Assert.areEqual('reverted', results[0].outcome);
            Assert.areEqual(1, mock.count('POST', '_HttpMethod=PATCH'));
            Assert.areEqual(
                'reverted',
                [SELECT Last_Check_Outcome__c FROM Flow_Governance__c WHERE Id = :record.Id].Last_Check_Outcome__c
            );
        }
    }

    // What a check found is told only about the flows the admin polling it
    // can see; its counts still cover every flow.
    @IsTest
    static void aCheckTellsItsAdminOnlyAboutFlowsTheyCanSee() {
        System.runAs(FlowCompareTestMock.installer()) {
            User admin;
            User partial;
            System.runAs(FlowCompareTestMock.installer()) {
                String adminSet = adminOnly();
                admin = FlowCompareTestMock.plainUser('fcaonly', new List<String>{ adminSet });
                partial = FlowCompareTestMock.plainUser('fcapart', new List<String>{ adminSet, governanceNamesOnly() });
            }
            Flow_Governance__c record = govern(FlowGovernanceService.MODE_LOCKED, 2);
            FlowGovernanceService.CheckResult found = new FlowGovernanceService.CheckResult();
            found.governanceId = record.Id;
            found.apiName = FLOW;
            found.outcome = 'revertFailed';
            Flow_Operation__c receipt = new Flow_Operation__c(
                Action__c = 'check',
                State__c = 'Completed',
                Result__c = JSON.serialize(new List<FlowGovernanceService.CheckResult>{ found }, true),
                Attempted__c = 1,
                Succeeded__c = 0,
                Failed__c = 1,
                Remaining__c = 0
            );
            Database.insert(receipt, AccessLevel.SYSTEM_MODE);
            Assert.isTrue(FlowGovernanceController.getOperation(receipt.Id).result.contains(FLOW));
            System.runAs(admin) {
                Assert.isFalse(Schema.sObjectType.Flow_Governance__c.isAccessible());
                FlowGovernanceOperation.Status polled = FlowGovernanceController.getOperation(receipt.Id);
                Assert.areEqual('[]', polled.result);
                Assert.areEqual(1, polled.attempted);
                Assert.areEqual(1, polled.failed);
            }
            // They can see the record, but not the versions or the outcome a result shows.
            System.runAs(partial) {
                Assert.isTrue(Schema.sObjectType.Flow_Governance__c.isAccessible());
                Assert.isFalse(Schema.sObjectType.Flow_Governance__c.fields.Active_Version__c.isAccessible());
                FlowGovernanceOperation.Status polled = FlowGovernanceController.getOperation(receipt.Id);
                Assert.areEqual('[]', polled.result);
                Assert.areEqual(1, polled.failed);
            }
        }
    }

    // A permission set that lets its users read governance records, but of
    // their fields only the connection (the flow's name is required, so
    // always readable).
    private static String governanceNamesOnly() {
        PermissionSet permissionSet = new PermissionSet(
            Name = 'Tributary_Test_Governance_Names',
            Label = 'Tributary Test Governance Names'
        );
        insert permissionSet;
        String governanceType = String.valueOf(Flow_Governance__c.SObjectType);
        insert new ObjectPermissions(ParentId = permissionSet.Id, SobjectType = governanceType, PermissionsRead = true);
        insert new FieldPermissions(
            ParentId = permissionSet.Id,
            SobjectType = governanceType,
            Field = governanceType + '.' + Flow_Governance__c.Connection__c.getDescribe().getName(),
            PermissionsRead = true
        );
        return permissionSet.Name;
    }

    @IsTest
    static void adminsGovernFlowsFromTheActiveVersion() {
        System.runAs(FlowCompareTestMock.installer()) {
            Test.setMock(HttpCalloutMock.class, activationMock(4, 204));
            FlowGovernanceService.GovernanceInput input = new FlowGovernanceService.GovernanceInput();
            input.apiName = FLOW;
            input.label = 'Demo Flow';
            input.ownerId = FlowCompareTestMock.find('fcowner').Id;
            input.mode = FlowGovernanceService.MODE_WATCH;
            System.runAs(FlowCompareTestMock.find('fcother')) {
                try {
                    FlowGovernanceService.saveGovernance(input);
                    Assert.fail('Only admins govern flows');
                } catch (FlowGovernanceService.GovernanceException e) {
                    Assert.isTrue(e.getMessage().contains('Admin'));
                }
            }
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                Flow_Governance__c record = FlowGovernanceService.saveGovernance(input);
                Assert.areEqual(4, record.Approved_Version__c);
                Assert.areEqual('local:' + FLOW, record.Flow_Key__c);
                input.mode = FlowGovernanceService.MODE_LOCKED;
                FlowGovernanceService.saveGovernance(input);
                Assert.areEqual(FlowGovernanceService.MODE_LOCKED, [SELECT Mode__c FROM Flow_Governance__c].Mode__c);
                Assert.areEqual(4, [SELECT Approved_Version__c FROM Flow_Governance__c].Approved_Version__c);
                // History names modes the way the app does.
                Assert.isTrue(
                    [
                            SELECT Details__c
                            FROM Flow_Audit_Event__c
                            WHERE Event_Type__c = 'Governance Changed'
                            ORDER BY CreatedDate DESC, Id DESC
                            LIMIT 1
                        ]
                        .Details__c.startsWith('Mode: Approval required.')
                );
                input.mode = FlowGovernanceService.MODE_WATCH;
                input.ownerId = null;
                try {
                    FlowGovernanceService.saveGovernance(input);
                    Assert.fail('A governed flow needs an owner');
                } catch (FlowGovernanceService.GovernanceException e) {
                    Assert.isTrue(e.getMessage().contains('owner'));
                }
                input.mode = 'Sometimes';
                try {
                    FlowGovernanceService.saveGovernance(input);
                    Assert.fail('Unknown modes are refused');
                } catch (FlowGovernanceService.GovernanceException e) {
                    Assert.isTrue(e.getMessage().contains('mode'));
                }
                FlowGovernanceService.removeGovernance(record.Id);
            }
            Test.stopTest();
            Assert.areEqual(0, [SELECT COUNT() FROM Flow_Governance__c]);
            Assert.areEqual(3, [SELECT COUNT() FROM Flow_Audit_Event__c WHERE Event_Type__c = 'Governance Changed']);
        }
    }

    @IsTest
    static void turningEnforcementOnStartsFromTheActiveVersion() {
        System.runAs(FlowCompareTestMock.installer()) {
            Flow_Governance__c record = govern(FlowGovernanceService.MODE_OFF, 2);
            Test.setMock(HttpCalloutMock.class, activationMock(5, 204));
            FlowGovernanceService.GovernanceInput input = new FlowGovernanceService.GovernanceInput();
            input.id = record.Id;
            input.apiName = 'Some_Other_Flow';
            input.connection = 'Staging';
            input.ownerId = FlowCompareTestMock.find('fcother').Id;
            input.mode = FlowGovernanceService.MODE_LOCKED;
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                FlowGovernanceService.saveGovernance(input);
            }
            Test.stopTest();
            record = [
                SELECT Flow_Api_Name__c, Connection__c, Flow_Key__c, Name, Owner_User__c, Mode__c, Approved_Version__c
                FROM Flow_Governance__c
            ];
            Assert.areEqual(FLOW, record.Flow_Api_Name__c, 'Editing keeps the flow');
            Assert.isNull(record.Connection__c, 'Editing keeps the org');
            Assert.areEqual('local:' + FLOW, record.Flow_Key__c);
            Assert.areEqual('Demo Flow', record.Name);
            Assert.areEqual(input.ownerId, record.Owner_User__c);
            Assert.areEqual(5, record.Approved_Version__c);
            Flow_Audit_Event__c changed = [SELECT Version_Number__c, Details__c FROM Flow_Audit_Event__c];
            Assert.areEqual(5, changed.Version_Number__c);
            Assert.isTrue(changed.Details__c.contains('reset'), changed.Details__c);
        }
    }

    @IsTest
    static void changingOwnerKeepsTheApprovedVersion() {
        System.runAs(FlowCompareTestMock.installer()) {
            Flow_Governance__c record = govern(FlowGovernanceService.MODE_WATCH, 2);
            FlowGovernanceService.GovernanceInput input = new FlowGovernanceService.GovernanceInput();
            input.id = record.Id;
            input.label = 'Renamed';
            input.ownerId = FlowCompareTestMock.find('fcother').Id;
            input.mode = FlowGovernanceService.MODE_LOCKED;
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                // No mock: an edit that keeps enforcement on makes no callouts.
                FlowGovernanceService.saveGovernance(input);
            }
            record = [SELECT Name, Mode__c, Approved_Version__c FROM Flow_Governance__c];
            Assert.areEqual('Renamed', record.Name);
            Assert.areEqual(FlowGovernanceService.MODE_LOCKED, record.Mode__c);
            Assert.areEqual(2, record.Approved_Version__c);
        }
    }

    @IsTest
    static void changingOwnerCancelsOnlyThisFlowsPendingReviews() {
        System.runAs(FlowCompareTestMock.installer()) {
            Flow_Governance__c record = govern(FlowGovernanceService.MODE_WATCH, 2);
            Flow_Activation_Request__c pending = FlowGovernanceService.requestActivation(input(3));
            Flow_Activation_Request__c completed = FlowGovernanceService.requestActivation(input(2));
            FlowGovernanceService.cancel(completed.Id);
            FlowGovernanceService.RequestInput other = input(3);
            other.apiName = 'Other_Flow';
            Id otherFlow = FlowGovernanceService.requestActivation(other).Id;
            other.apiName = FLOW;
            other.connection = 'Staging';
            Id otherOrg = FlowGovernanceService.requestActivation(other).Id;
            String home = [SELECT NamespacePrefix FROM Organization].NamespacePrefix;
            other.connection = 'local';
            other.apiName = String.isBlank(home) ? FLOW : home + '__' + FLOW;
            Id alias = FlowGovernanceService.requestActivation(other).Id;
            FlowGovernanceService.GovernanceInput edit = governanceEdit(record);
            edit.ownerId = FlowCompareTestMock.find('fcother').Id;
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                FlowGovernanceService.saveGovernance(edit);
            }
            pending = FlowGovernanceService.loadRequest(pending.Id);
            Assert.areEqual(FlowGovernanceService.CANCELLED, pending.Status__c);
            Assert.isTrue(pending.Decision_Comments__c.contains('Governance changed'));
            Assert.areEqual(FlowCompareTestMock.find('fcadmin').Id, pending.Decided_By__c);
            Assert.areEqual(FlowGovernanceService.CANCELLED, FlowGovernanceService.loadRequest(alias).Status__c);
            Assert.areEqual(FlowGovernanceService.PENDING, FlowGovernanceService.loadRequest(otherFlow).Status__c);
            Assert.areEqual(FlowGovernanceService.PENDING, FlowGovernanceService.loadRequest(otherOrg).Status__c);
            Assert.isNull(FlowGovernanceService.loadRequest(completed.Id).Decision_Comments__c);
            Id adminId = FlowCompareTestMock.find('fcadmin').Id;
            Assert.areEqual(
                2,
                [SELECT COUNT() FROM Flow_Audit_Event__c WHERE Event_Type__c = 'Cancelled' AND Actor__c = :adminId]
            );
            Assert.areEqual(edit.ownerId, FlowGovernanceService.requestActivation(input(3)).Approver__c);
        }
    }

    private static FlowGovernanceService.GovernanceInput governanceEdit(Flow_Governance__c record) {
        FlowGovernanceService.GovernanceInput edit = new FlowGovernanceService.GovernanceInput();
        edit.id = record.Id;
        edit.ownerId = record.Owner_User__c;
        edit.mode = record.Mode__c;
        return edit;
    }

    @IsTest
    static void changingModeCancelsPendingReviews() {
        System.runAs(FlowCompareTestMock.installer()) {
            Flow_Governance__c record = govern(FlowGovernanceService.MODE_WATCH, 2);
            for (String mode : new List<String>{ FlowGovernanceService.MODE_LOCKED, FlowGovernanceService.MODE_OFF }) {
                Id requestId = FlowGovernanceService.requestActivation(input(3)).Id;
                FlowGovernanceService.GovernanceInput edit = governanceEdit(record);
                edit.mode = mode;
                FlowGovernanceService.saveGovernance(edit);
                Assert.areEqual(
                    FlowGovernanceService.CANCELLED,
                    FlowGovernanceService.loadRequest(requestId).Status__c
                );
            }
        }
    }

    @IsTest
    static void labelEditsKeepPendingReviews() {
        System.runAs(FlowCompareTestMock.installer()) {
            Flow_Governance__c record = govern(FlowGovernanceService.MODE_WATCH, 2);
            Id requestId = FlowGovernanceService.requestActivation(input(3)).Id;
            FlowGovernanceService.GovernanceInput edit = governanceEdit(record);
            edit.label = 'A clearer label';
            FlowGovernanceService.saveGovernance(edit);
            Assert.areEqual(FlowGovernanceService.PENDING, FlowGovernanceService.loadRequest(requestId).Status__c);
        }
    }

    @IsTest
    static void removalCancelsPendingReviews() {
        System.runAs(FlowCompareTestMock.installer()) {
            Flow_Governance__c record = govern(FlowGovernanceService.MODE_WATCH, 2);
            Id requestId = FlowGovernanceService.requestActivation(input(3)).Id;
            FlowGovernanceService.removeGovernance(record.Id);
            Assert.areEqual(FlowGovernanceService.CANCELLED, FlowGovernanceService.loadRequest(requestId).Status__c);
            try {
                FlowGovernanceService.authorizeApproval(requestId);
                Assert.fail('Removing governance cannot make an old request approvable');
            } catch (FlowGovernanceService.GovernanceException e) {
                Assert.isTrue(e.getMessage().contains('already cancelled'));
            }
        }
    }

    @IsTest
    static void newGovernanceCancelsUngovernedReviews() {
        System.runAs(FlowCompareTestMock.installer()) {
            Id requestId = FlowGovernanceService.requestActivation(input(3)).Id;
            Test.setMock(HttpCalloutMock.class, activationMock(2, 204));
            FlowGovernanceService.GovernanceInput edit = new FlowGovernanceService.GovernanceInput();
            edit.apiName = FLOW;
            edit.ownerId = FlowCompareTestMock.find('fcowner').Id;
            edit.mode = FlowGovernanceService.MODE_WATCH;
            Test.startTest();
            FlowGovernanceService.saveGovernance(edit);
            Test.stopTest();
            Assert.areEqual(FlowGovernanceService.CANCELLED, FlowGovernanceService.loadRequest(requestId).Status__c);
        }
    }

    @IsTest
    static void requestsCannotRaceAQueuedActivation() {
        System.runAs(FlowCompareTestMock.installer()) {
            Test.setMock(HttpCalloutMock.class, activationMock(2, 204));
            Test.startTest();
            FlowGovernanceOperation.activate(input(3));
            try {
                FlowGovernanceService.requestActivation(input(3));
                Assert.fail('A request must take the same gate as other governance writes');
            } catch (FlowGovernanceService.GovernanceException e) {
                Assert.isTrue(e.getMessage().contains('queued or running'));
            }
            Assert.areEqual(0, [SELECT COUNT() FROM Flow_Activation_Request__c]);
            Test.stopTest();
        }
    }

    @IsTest
    static void editingAFlowNoLongerGovernedFails() {
        System.runAs(FlowCompareTestMock.installer()) {
            Flow_Governance__c record = govern(FlowGovernanceService.MODE_WATCH, 2);
            delete record;
            FlowGovernanceService.GovernanceInput input = new FlowGovernanceService.GovernanceInput();
            input.id = record.Id;
            input.ownerId = FlowCompareTestMock.find('fcowner').Id;
            input.mode = FlowGovernanceService.MODE_WATCH;
            System.runAs(FlowCompareTestMock.find('fcadmin')) {
                try {
                    FlowGovernanceService.saveGovernance(input);
                    Assert.fail('A removed flow can\'t be edited');
                } catch (FlowGovernanceService.GovernanceException e) {
                    Assert.isTrue(e.getMessage().contains('no longer governed'));
                }
            }
        }
    }

    @IsTest
    static void ordinaryUsersRequestAndOwnersApprove() {
        System.runAs(FlowCompareTestMock.installer()) {
            Id ownerId = FlowCompareTestMock.find('fcpowner').Id;
            govern(FlowGovernanceService.MODE_WATCH, 2, ownerId);
            Flow_Activation_Request__c request;
            System.runAs(FlowCompareTestMock.find('fcpother')) {
                // No Manage Flow, so even ungoverned flows need a request here.
                Assert.isFalse(FlowGovernanceService.canApprove(null, null));
                Assert.areEqual(1, FlowGovernanceController.listGoverned().size());
                try {
                    FlowGovernanceService.activateNow(input(3));
                    Assert.fail('Only the owner may activate');
                } catch (FlowGovernanceService.GovernanceException e) {
                    Assert.isTrue(e.getMessage().contains('owner'));
                }
                request = FlowGovernanceService.requestActivation(input(3));
                Assert.areEqual(ownerId, request.Approver__c);
                Assert.areEqual(1, FlowGovernanceController.listRequests('submitted', null).size());
                Assert.isFalse(FlowGovernanceController.listAuditEvents('local', FLOW, null).isEmpty());
            }
            System.runAs(FlowCompareTestMock.find('fcpowner')) {
                Assert.areEqual(1, FlowGovernanceController.listRequests('mine', 'Pending').size());
            }
            Test.setMock(HttpCalloutMock.class, activationMock(2, 204));
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcpowner')) {
                request = FlowGovernanceService.approve(request.Id, 'Fine');
            }
            Test.stopTest();
            Assert.areEqual(FlowGovernanceService.ACTIVATED, request.Status__c);
            Assert.areEqual(3, [SELECT Approved_Version__c FROM Flow_Governance__c].Approved_Version__c);
        }
    }

    @IsTest
    static void ordinaryAdminsGovernFlows() {
        Test.setMock(HttpCalloutMock.class, activationMock(4, 204));
        FlowGovernanceService.GovernanceInput input = new FlowGovernanceService.GovernanceInput();
        input.apiName = FLOW;
        input.ownerId = FlowCompareTestMock.find('fcpowner').Id;
        input.mode = FlowGovernanceService.MODE_WATCH;
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcpadmin')) {
            Flow_Governance__c record = FlowGovernanceService.saveGovernance(input);
            Assert.areEqual(4, record.Approved_Version__c);
            Assert.areEqual(1, FlowGovernanceController.listGoverned().size());
            FlowGovernanceService.removeGovernance(record.Id);
        }
        Test.stopTest();
        Assert.areEqual(0, [SELECT COUNT() FROM Flow_Governance__c]);
    }

    private static FlowCompareTestMock checkMock(Integer active, Id actor, Integer patchStatus) {
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
                'POST',
                '_HttpMethod=PATCH',
                patchStatus,
                patchStatus < 300 ? null : FlowCompareTestMock.error('Locked by admin', 'UNKNOWN_EXCEPTION')
            );
    }

    private static FlowGovernanceService.CheckResult check() {
        List<FlowGovernanceService.CheckResult> results;
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcadmin')) {
            results = FlowGovernanceService.checkAll();
        }
        Test.stopTest();
        Assert.areEqual(1, results.size());
        return results[0];
    }

    @IsTest
    static void revertsActivationsByOthersInWatchMode() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_WATCH, 2);
            FlowCompareTestMock mock = checkMock(3, FlowCompareTestMock.find('fcother').Id, 204);
            Test.setMock(HttpCalloutMock.class, mock);
            FlowGovernanceService.CheckResult result = check();
            Assert.areEqual('reverted', result.outcome);
            Assert.isTrue(mock.requests[2].getBody().contains('"activeVersionNumber":2'));
            Flow_Governance__c record = [
                SELECT
                    Active_Version__c,
                    Approved_Version__c,
                    Last_Checked__c,
                    Last_Check_Outcome__c,
                    Last_Check_Message__c
                FROM Flow_Governance__c
            ];
            Assert.areEqual(2, record.Active_Version__c);
            Assert.isNotNull(record.Last_Checked__c);
            Assert.areEqual('reverted', record.Last_Check_Outcome__c);
            Assert.areEqual('Reverted version 3 to version 2.', record.Last_Check_Message__c);
            Assert.areEqual(new List<String>{ 'Unapproved Activation', 'Reverted' }, events());
            Assert.areEqual(
                FlowCompareTestMock.find('fcother').Id,
                [SELECT Actor__c FROM Flow_Audit_Event__c WHERE Event_Type__c = 'Unapproved Activation'].Actor__c
            );
            Assert.isTrue(
                ((String) FlowGovernanceService.sentNotifications[0].get('body')).contains('Tributary fcother')
            );
        }
    }

    @IsTest
    static void acceptsTheOwnersActivationInWatchMode() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_WATCH, 2);
            FlowCompareTestMock mock = checkMock(3, FlowCompareTestMock.find('fcowner').Id, 204);
            Test.setMock(HttpCalloutMock.class, mock);
            Assert.areEqual('accepted', check().outcome);
            Assert.areEqual(0, mock.count('POST', '_HttpMethod=PATCH'));
            Assert.areEqual(3, [SELECT Approved_Version__c FROM Flow_Governance__c].Approved_Version__c);
            Assert.areEqual(new List<String>{ 'Owner Activation Accepted' }, events());
        }
    }

    @IsTest
    static void doesNotAttributeADifferentVersionToTheOwner() {
        rejectsHistoricalOwnerEvent(false);
    }

    @IsTest
    static void doesNotReuseAnOwnerEventFromBeforeTheLastCheck() {
        rejectsHistoricalOwnerEvent(true);
    }

    private static void rejectsHistoricalOwnerEvent(Boolean oldDate) {
        System.runAs(FlowCompareTestMock.installer()) {
            Flow_Governance__c governed = govern(FlowGovernanceService.MODE_WATCH, 2);
            if (oldDate) {
                governed.Last_Checked__c = System.now().addHours(-1);
                update governed;
            }
            Map<String, Object> entry = FlowCompareTestMock.auditEntry(
                FLOW,
                oldDate ? 3 : 2,
                FlowCompareTestMock.find('fcowner').Id
            );
            FlowCompareTestMock mock = new FlowCompareTestMock()
                .route(
                    'GET',
                    'FROM FlowDefinition',
                    200,
                    FlowCompareTestMock.page(new List<Object>{ FlowCompareTestMock.definition(FLOW, 3, 3, null) })
                )
                .route('GET', 'FROM SetupAuditTrail', 200, FlowCompareTestMock.page(new List<Object>{ entry }))
                .route('POST', '_HttpMethod=PATCH', 204, null);
            Test.setMock(HttpCalloutMock.class, mock);
            Assert.areEqual('reverted', check().outcome);
            Assert.areEqual(2, [SELECT Approved_Version__c FROM Flow_Governance__c].Approved_Version__c);
            Assert.isNull(
                [SELECT Actor__c FROM Flow_Audit_Event__c WHERE Event_Type__c = 'Unapproved Activation'].Actor__c
            );
        }
    }

    // Stands in for an org, and notes when its flow definitions were read.
    private class TimedMock implements HttpCalloutMock {
        private final FlowCompareTestMock wrapped;
        public Long readAt;

        TimedMock(FlowCompareTestMock wrapped) {
            this.wrapped = wrapped;
        }

        public HttpResponse respond(HttpRequest request) {
            if (readAt == null && request.getEndpoint().contains('FlowDefinition')) {
                readAt = System.currentTimeMillis();
                // Let the clock move into the next second, as a slow read or a
                // revert would. Date-time fields keep whole seconds.
                while (System.currentTimeMillis() / 1000 == readAt / 1000) {
                    continue;
                }
            }
            return wrapped.respond(request);
        }
    }

    @IsTest
    static void checkpointsWhenTheFlowWasReadNotWhenTheCheckEnded() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_WATCH, 2);
            TimedMock mock = new TimedMock(checkMock(2, FlowCompareTestMock.find('fcother').Id, 204));
            Test.setMock(HttpCalloutMock.class, mock);
            Assert.areEqual('ok', check().outcome);
            // The owner may activate a version after the read. That activation
            // must still be newer than the checkpoint when the next check sees it.
            Assert.isTrue(
                [SELECT Last_Checked__c FROM Flow_Governance__c].Last_Checked__c.getTime() <= mock.readAt,
                'The checkpoint is no later than the read'
            );
        }
    }

    @IsTest
    static void acceptsAnOwnerActivationStampedJustBeforeTheCheckpoint() {
        System.runAs(FlowCompareTestMock.installer()) {
            Flow_Governance__c governed = govern(FlowGovernanceService.MODE_WATCH, 2);
            // The last check read the flow at 10:00:20. The owner activated just
            // after, in an org whose clock stamped that 10:00:00.
            governed.Last_Checked__c = Datetime.newInstanceGmt(2026, 9, 1, 10, 0, 20);
            update governed;
            FlowCompareTestMock mock = checkMock(3, FlowCompareTestMock.find('fcowner').Id, 204);
            Test.setMock(HttpCalloutMock.class, mock);
            Assert.areEqual('accepted', check().outcome);
            Assert.areEqual(0, mock.count('POST', '_HttpMethod=PATCH'));
        }
    }

    @IsTest
    static void boundsChecksAndRotatesFailuresWithoutLosingTheCheckpoint() {
        System.runAs(FlowCompareTestMock.installer()) {
            Datetime checkpoint = Datetime.newInstanceGmt(2026, 9, 1, 0, 0, 0);
            List<Flow_Governance__c> records = new List<Flow_Governance__c>();
            for (Integer i = 0; i < 26; i++)
                records.add(
                    new Flow_Governance__c(
                        Name = 'Flow' + i,
                        Flow_Api_Name__c = 'Flow' + i,
                        Flow_Key__c = 'local:Flow' + i,
                        Mode__c = 'Off',
                        Last_Checked__c = checkpoint,
                        Last_Attempt__c = i < 25 ? System.now() : null
                    )
                );
            Database.insert(records, AccessLevel.SYSTEM_MODE);
            Test.setMock(
                HttpCalloutMock.class,
                new FlowCompareTestMock()
                    .route('GET', '/query', 401, FlowCompareTestMock.error('Session expired', 'INVALID_SESSION_ID'))
            );
            Test.startTest();
            List<FlowGovernanceService.CheckResult> results = FlowGovernanceService.checkAll();
            Test.stopTest();
            Assert.areEqual(25, results.size());
            Assert.areEqual('Flow25', results[0].apiName, 'A never-attempted flow precedes recently failing flows');
            Flow_Governance__c last = [
                SELECT Last_Attempt__c, Last_Checked__c, Last_Check_Outcome__c
                FROM Flow_Governance__c
                WHERE Id = :records[25].Id
                WITH SYSTEM_MODE
            ];
            Assert.isNotNull(last.Last_Attempt__c);
            Assert.areEqual(checkpoint, last.Last_Checked__c);
            Assert.areEqual('error', last.Last_Check_Outcome__c);
        }
    }

    @IsTest
    static void aResultThatCannotBeSavedFailsTheCheck() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_OFF, 2);
            // Too large for the version fields, so saving what was read fails.
            Test.setMock(HttpCalloutMock.class, checkMock(1000000, FlowCompareTestMock.find('fcother').Id, 204));
            FlowGovernanceService.CheckResult result = check();
            Assert.areEqual('error', result.outcome);
            Assert.isTrue(result.message.contains('couldn\'t be saved'), result.message);
            Flow_Governance__c record = [SELECT Approved_Version__c, Last_Checked__c FROM Flow_Governance__c];
            Assert.areEqual(2, record.Approved_Version__c);
            Assert.isNull(record.Last_Checked__c);
        }
    }

    @IsTest
    static void revertsEvenTheOwnerInLockedMode() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_LOCKED, 2);
            Test.setMock(HttpCalloutMock.class, checkMock(3, FlowCompareTestMock.find('fcowner').Id, 204));
            Assert.areEqual('reverted', check().outcome);
        }
    }

    @IsTest
    static void reportsARevertThatFails() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_LOCKED, 2);
            Test.setMock(HttpCalloutMock.class, checkMock(3, FlowCompareTestMock.find('fcother').Id, 500));
            FlowGovernanceService.CheckResult result = check();
            Assert.areEqual('revertFailed', result.outcome);
            Assert.areEqual(new List<String>{ 'Unapproved Activation', 'Revert Failed' }, events());
        }
    }

    @IsTest
    static void recordsABaselineAndLeavesApprovedVersionsAlone() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_WATCH, null);
            Test.setMock(HttpCalloutMock.class, checkMock(5, FlowCompareTestMock.find('fcother').Id, 204));
            Assert.areEqual('baseline', check().outcome);
            Assert.areEqual(5, [SELECT Approved_Version__c FROM Flow_Governance__c].Approved_Version__c);
        }
    }

    @IsTest
    static void tracksTheActiveVersionWhenEnforcementIsOff() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_OFF, 2);
            FlowCompareTestMock mock = checkMock(3, FlowCompareTestMock.find('fcother').Id, 204);
            Test.setMock(HttpCalloutMock.class, mock);
            Assert.areEqual('off', check().outcome);
            Assert.areEqual(0, mock.count('POST', '_HttpMethod=PATCH'));
            Flow_Governance__c record = [SELECT Approved_Version__c, Active_Version__c FROM Flow_Governance__c];
            Assert.areEqual(3, record.Approved_Version__c);
            Assert.areEqual(3, record.Active_Version__c);
            Assert.isTrue(events().isEmpty());
        }
    }

    @IsTest
    static void matchesFlowsByTheirFullName() {
        System.runAs(FlowCompareTestMock.installer()) {
            // A namespaced flow with the same developer name must not stand in.
            govern(FlowGovernanceService.MODE_WATCH, 3);
            Map<String, Object> packaged = FlowCompareTestMock.definition(FLOW, 9, 9, null);
            packaged.put('NamespacePrefix', 'other');
            packaged.put('ManageableState', 'installed');
            Test.setMock(
                HttpCalloutMock.class,
                new FlowCompareTestMock()
                    .route(
                        'GET',
                        'FROM FlowDefinition',
                        200,
                        FlowCompareTestMock.page(
                            new List<Object>{
                                FlowCompareTestMock.definition(FLOW, 3, 3, FlowCompareTestMock.find('fcother').Id),
                                packaged
                            }
                        )
                    )
                    .route('GET', 'FROM SetupAuditTrail', 200, FlowCompareTestMock.page(new List<Object>()))
            );
            Assert.areEqual('ok', check().outcome);
        }
    }

    @IsTest
    static void reportsFlowsThatAreUpToDate() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_WATCH, 3);
            FlowCompareTestMock mock = checkMock(3, FlowCompareTestMock.find('fcother').Id, 204);
            Test.setMock(HttpCalloutMock.class, mock);
            Assert.areEqual('ok', check().outcome);
            Assert.areEqual(0, mock.count('GET', 'FROM SetupAuditTrail'), 'No one to name when nothing changed');
            Assert.areEqual(1, mock.requests.size());
        }
    }

    @IsTest
    static void reportsMissingFlows() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_WATCH, 3);
            Test.setMock(
                HttpCalloutMock.class,
                new FlowCompareTestMock()
                    .route('GET', 'FROM FlowDefinition', 200, FlowCompareTestMock.page(new List<Object>()))
            );
            Assert.areEqual('missing', check().outcome);
        }
    }

    @IsTest
    static void reportsUnreachableOrgs() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_WATCH, 3);
            Test.setMock(
                HttpCalloutMock.class,
                new FlowCompareTestMock()
                    .route('GET', '/query', 401, FlowCompareTestMock.error('Session expired', 'INVALID_SESSION_ID'))
            );
            FlowGovernanceService.CheckResult result = check();
            Assert.areEqual('error', result.outcome);
            Assert.isTrue(result.message.contains('Session expired'));
            Flow_Governance__c record = [
                SELECT Last_Checked__c, Last_Check_Outcome__c, Last_Check_Message__c
                FROM Flow_Governance__c
            ];
            Assert.isNull(record.Last_Checked__c, 'The next check looks back to before this one');
            Assert.areEqual('error', record.Last_Check_Outcome__c);
            Assert.isTrue(record.Last_Check_Message__c.contains('Session expired'));
        }
    }

    // Flow definitions, an audit trail that can't be read, and a revert that works.
    private static FlowCompareTestMock noAuditTrailMock(Integer active) {
        return new FlowCompareTestMock()
            .route(
                'GET',
                'FROM FlowDefinition',
                200,
                FlowCompareTestMock.page(new List<Object>{ FlowCompareTestMock.definition(FLOW, active, 3, null) })
            )
            .route(
                'GET',
                'FROM SetupAuditTrail',
                403,
                FlowCompareTestMock.error('Insufficient privileges', 'INSUFFICIENT_ACCESS')
            )
            .route('POST', '_HttpMethod=PATCH', 204, null);
    }

    @IsTest
    static void watchWaitsWhenItCantTellWhoActivated() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_WATCH, 2);
            FlowCompareTestMock mock = noAuditTrailMock(3);
            Test.setMock(HttpCalloutMock.class, mock);
            FlowGovernanceService.CheckResult result = check();
            Assert.areEqual('error', result.outcome);
            Assert.isTrue(result.message.contains('Insufficient privileges'), result.message);
            Assert.areEqual(0, mock.count('POST', '_HttpMethod=PATCH'), 'It might have been the owner');
            Flow_Governance__c record = [SELECT Approved_Version__c, Last_Checked__c FROM Flow_Governance__c];
            Assert.areEqual(2, record.Approved_Version__c);
            Assert.isNull(record.Last_Checked__c);
        }
    }

    @IsTest
    static void lockedRevertsWithoutTheAuditTrail() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_LOCKED, 2);
            FlowCompareTestMock mock = noAuditTrailMock(3);
            Test.setMock(HttpCalloutMock.class, mock);
            Assert.areEqual('reverted', check().outcome);
            Assert.areEqual(1, mock.count('POST', '_HttpMethod=PATCH'));
        }
    }

    @IsTest
    static void namesWhoActivatedInAnotherOrg() {
        System.runAs(FlowCompareTestMock.installer()) {
            FlowToolingClient.testConnections.put(
                'Staging',
                new Flow_Connection__mdt(DeveloperName = 'Staging', Named_Credential__c = 'Staging_Org')
            );
            Flow_Governance__c record = govern(FlowGovernanceService.MODE_WATCH, 2);
            record.Connection__c = 'Staging';
            record.Flow_Key__c = 'Staging:' + FLOW;
            update record;
            // The owner's Id in this org means someone else, or no one, over there.
            Map<String, Object> entry = FlowCompareTestMock.auditEntry(FLOW, 3, FlowCompareTestMock.find('fcowner').Id);
            entry.put('CreatedBy', new Map<String, Object>{ 'Name' => 'Grace Hopper' });
            FlowCompareTestMock mock = new FlowCompareTestMock()
                .route(
                    'GET',
                    'FROM FlowDefinition',
                    200,
                    FlowCompareTestMock.page(new List<Object>{ FlowCompareTestMock.definition(FLOW, 3, 3, null) })
                )
                .route('GET', 'FROM SetupAuditTrail', 200, FlowCompareTestMock.page(new List<Object>{ entry }))
                .route('POST', '_HttpMethod=PATCH', 204, null);
            Test.setMock(HttpCalloutMock.class, mock);
            Assert.areEqual('reverted', check().outcome);
            Assert.isTrue(mock.requests[0].getEndpoint().startsWith('callout:Staging_Org'));
            Flow_Audit_Event__c unapproved = [
                SELECT Actor__c, Details__c
                FROM Flow_Audit_Event__c
                WHERE Event_Type__c = 'Unapproved Activation'
            ];
            Assert.isNull(unapproved.Actor__c);
            Assert.isTrue(unapproved.Details__c.contains('Grace Hopper'), unapproved.Details__c);
            Assert.isTrue(((String) FlowGovernanceService.sentNotifications[0].get('body')).contains('Grace Hopper'));
        }
    }

    @IsTest
    static void checksTheLeastRecentlyCheckedFlowsFirst() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_WATCH, 3);
            insert new Flow_Governance__c(
                Name = 'Other Flow',
                Flow_Api_Name__c = 'Other_Flow',
                Flow_Key__c = 'local:Other_Flow',
                Owner_User__c = FlowCompareTestMock.find('fcowner').Id,
                Mode__c = FlowGovernanceService.MODE_WATCH,
                Approved_Version__c = 3,
                Active_Version__c = 3,
                Last_Checked__c = System.now().addHours(-1)
            );
            Test.setMock(
                HttpCalloutMock.class,
                new FlowCompareTestMock()
                    .route(
                        'GET',
                        'FROM FlowDefinition',
                        200,
                        FlowCompareTestMock.page(
                            new List<Object>{
                                FlowCompareTestMock.definition(FLOW, 3, 3, null),
                                FlowCompareTestMock.definition('Other_Flow', 3, 3, null)
                            }
                        )
                    )
                    .route('GET', 'FROM SetupAuditTrail', 200, FlowCompareTestMock.page(new List<Object>()))
            );
            List<FlowGovernanceService.CheckResult> results;
            Test.startTest();
            results = FlowGovernanceService.checkAll();
            Test.stopTest();
            Assert.areEqual(2, results.size());
            Assert.areEqual(FLOW, results[0].apiName, 'Never checked comes first');
            Assert.areEqual('Other_Flow', results[1].apiName);
            Assert.areEqual('ok', results[1].outcome);
        }
    }

    // The flow in the org's own namespace, as the Tooling API describes it.
    private static FlowCompareTestMock namespacedMock(Integer active) {
        Map<String, Object> definition = FlowCompareTestMock.definition(FLOW, active, 3, null);
        definition.put('NamespacePrefix', 'home');
        definition.put('ManageableState', 'unmanaged');
        return new FlowCompareTestMock()
            .route('GET', 'FROM FlowDefinition', 200, FlowCompareTestMock.page(new List<Object>{ definition }))
            .route('POST', '_HttpMethod=PATCH', 204, null);
    }

    @IsTest
    static void decisionsFollowTheFlowNotItsName() {
        System.runAs(FlowCompareTestMock.installer()) {
            // Governed under its bare name, the flow is asked for by its full one.
            Flow_Governance__c record = govern(FlowGovernanceService.MODE_LOCKED, 2);
            FlowCompareTestMock mock = namespacedMock(2);
            Test.setMock(HttpCalloutMock.class, mock);
            FlowGovernanceService.RequestInput input = input(3);
            input.apiName = 'home__' + FLOW;
            Flow_Activation_Request__c request;
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcother')) {
                try {
                    FlowGovernanceService.activateNow(input);
                    Assert.fail('The flow\'s own governance applies, whatever it was called');
                } catch (FlowGovernanceService.GovernanceException e) {
                    Assert.isTrue(e.getMessage().contains('Request activation'), e.getMessage());
                }
            }
            System.runAs(FlowCompareTestMock.find('fcowner')) {
                request = FlowGovernanceService.activateNow(input);
            }
            Test.stopTest();
            Assert.areEqual(1, mock.count('POST', '_HttpMethod=PATCH'));
            Assert.areEqual(FlowGovernanceService.ACTIVATED, request.Status__c);
            Assert.areEqual('home__' + FLOW, request.Flow_Api_Name__c);
            Assert.areEqual(record.Id, request.Governance__c);
            Assert.areEqual(FlowCompareTestMock.find('fcowner').Id, request.Approver__c);
            Assert.areEqual(3, [SELECT Approved_Version__c FROM Flow_Governance__c].Approved_Version__c);
        }
    }

    @IsTest
    static void findsGovernanceUnderEitherNameInThisOrg() {
        System.runAs(FlowCompareTestMock.installer()) {
            String home = [SELECT NamespacePrefix FROM Organization].NamespacePrefix;
            Flow_Governance__c record = govern(FlowGovernanceService.MODE_WATCH, 2);
            Assert.areEqual(record.Id, FlowGovernanceService.findGovernance(null, FLOW).Id);
            Assert.isNull(FlowGovernanceService.findGovernance('Staging', FLOW), 'Another org\'s flow is another flow');
            Assert.isNull(FlowGovernanceService.findGovernance(null, 'elsewhere__' + FLOW));
            if (home != null) {
                Assert.areEqual(record.Id, FlowGovernanceService.findGovernance(null, home + '__' + FLOW).Id);
                Assert.isNull(FlowGovernanceService.findGovernance('Staging', home + '__' + FLOW));
            }
        }
    }

    @IsTest
    static void newGovernanceUsesTheFlowsFullName() {
        Test.setMock(HttpCalloutMock.class, namespacedMock(4));
        FlowGovernanceService.GovernanceInput input = new FlowGovernanceService.GovernanceInput();
        input.apiName = FLOW;
        input.ownerId = FlowCompareTestMock.find('fcowner').Id;
        input.mode = FlowGovernanceService.MODE_WATCH;
        Flow_Governance__c record;
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcadmin')) {
            record = FlowGovernanceService.saveGovernance(input);
        }
        Test.stopTest();
        Assert.areEqual('home__' + FLOW, record.Flow_Api_Name__c);
        Assert.areEqual('local:home__' + FLOW, record.Flow_Key__c);
        Assert.areEqual(4, record.Approved_Version__c);
    }

    @IsTest
    static void cannotAttributeAnOwnersUnrelatedActivationThroughItsLabel() {
        System.runAs(FlowCompareTestMock.installer()) {
            govern(FlowGovernanceService.MODE_WATCH, 2);
            Map<String, Object> forged = FlowCompareTestMock.auditEntry(
                'Other_Flow',
                3,
                FlowCompareTestMock.find('fcowner').Id
            );
            forged.put(
                'Display',
                'Activated flow version #3 "Label with Unique Name "Demo_Flow"" for flow with Unique Name "Other_Flow"'
            );
            FlowCompareTestMock mock = new FlowCompareTestMock()
                .route(
                    'GET',
                    'FROM FlowDefinition',
                    200,
                    FlowCompareTestMock.page(new List<Object>{ FlowCompareTestMock.definition(FLOW, 3, 3, null) })
                )
                .route('GET', 'FROM SetupAuditTrail', 200, FlowCompareTestMock.page(new List<Object>{ forged }))
                .route('POST', '_HttpMethod=PATCH', 204, null);
            Test.setMock(HttpCalloutMock.class, mock);
            Assert.areEqual('reverted', check().outcome);
            Assert.areEqual(1, mock.count('POST', '_HttpMethod=PATCH'));
            Assert.areEqual(2, [SELECT Approved_Version__c FROM Flow_Governance__c].Approved_Version__c);
        }
    }

    @IsTest
    static void parsesAuditTrailEntries() {
        Assert.areEqual(
            'Demo_Flow',
            FlowGovernanceService.uniqueName('Activated flow version #2 "Demo" for flow with Unique Name "Demo_Flow"')
        );
        Assert.areEqual(
            'Other_Flow',
            FlowGovernanceService.uniqueName(
                'Activated flow version #2 "for flow with Unique Name "Demo_Flow"" for flow with Unique Name "Other_Flow"'
            )
        );
        Assert.areEqual(
            'trib__Demo_Flow',
            FlowGovernanceService.uniqueName(
                'Deactivated flow version #2 "Demo" for flow with Unique Name "trib__Demo_Flow"'
            )
        );
        Assert.isNull(FlowGovernanceService.uniqueName('Unique Name "Demo_Flow" somewhere in a label'));
        Assert.isNull(FlowGovernanceService.uniqueName('Something else'));
        Assert.isNull(FlowGovernanceService.uniqueName(null));
        Assert.areEqual(UserInfo.getUserId(), FlowGovernanceService.toUserId(UserInfo.getUserId()));
        Assert.isNull(FlowGovernanceService.toUserId('00Dxx0000000001'));
    }
}
