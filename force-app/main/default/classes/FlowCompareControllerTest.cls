@IsTest
private class FlowCompareControllerTest {
    // A merge as the save dialog sends it: in the form it's saved in.
    private static final String METADATA = '{"label":"Demo","status":"Draft","processType":"AutoLaunchedFlow"}';
    private static final String COPY = '{"label":"Demo copy","status":"Draft","processType":"AutoLaunchedFlow"}';

    @TestSetup
    static void setup() {
        FlowCompareTestMock.grantRunningUser(new List<String>{ 'Flow_Compare_Admin' });
        FlowCompareTestMock.user('fcsaver', new List<String>{ 'Flow_Compare_User' });
        FlowCompareTestMock.user('fcnone', new List<String>());
    }

    // What the save dialog sends with a save.
    private static String review(Integer latestVersion, List<Object> sources, String receipt) {
        return review(METADATA, latestVersion, sources, receipt);
    }

    private static String review(String metadata, Integer latestVersion, List<Object> sources, String receipt) {
        return JSON.serialize(
            new Map<String, Object>{
                'candidate' => FlowCompareController.fingerprint(metadata),
                'latestVersion' => latestVersion,
                'sources' => sources,
                'receipt' => receipt
            }
        );
    }

    private static Map<String, Object> source(String versionId, String lastModifiedDate, String label) {
        return new Map<String, Object>{
            'connection' => 'local',
            'versionId' => versionId,
            'lastModifiedDate' => lastModifiedDate,
            'label' => label
        };
    }

    private static String candidateLine(String metadata) {
        return 'Candidate: SHA-256 ' +
            FlowCompareController.fingerprint(metadata) +
            ' of the metadata saved, draft status and label included, checked by the org before saving.';
    }

    private static Map<String, Object> savedVersion(Integer version) {
        return FlowCompareTestMock.page(
            new List<Object>{
                new Map<String, Object>{
                    'Id' => FlowCompareTestMock.VERSION_ID,
                    'DefinitionId' => FlowCompareTestMock.DEFINITION_ID,
                    'VersionNumber' => version,
                    'LastModifiedDate' => '2026-09-27T12:00:00.000+0000'
                }
            }
        );
    }

    @IsTest
    static void rejectsInstalledPackageSaveTargets() {
        Map<String, Object> definition = FlowCompareTestMock.definition('Demo_Flow', 2, 3, null);
        definition.put('NamespacePrefix', 'vendor');
        definition.put('ManageableState', 'installed');
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route('GET', 'FROM FlowDefinition', 200, FlowCompareTestMock.page(new List<Object>{ definition }));
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcsaver')) {
            try {
                FlowCompareController.saveVersion(
                    'local',
                    'vendor__Demo_Flow',
                    METADATA,
                    review(3, new List<Object>(), null)
                );
                Assert.fail('The server must reject installed package targets too');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('Installed package'), e.getMessage());
            }
        }
        Test.stopTest();
        Assert.areEqual(0, mock.count('POST', '/'));
    }

    @IsTest
    static void usesCanonicalNamesForNewVersionsAndSaveResults() {
        Map<String, Object> definition = FlowCompareTestMock.definition('Demo_Flow', 2, 3, null);
        definition.put('NamespacePrefix', 'home');
        definition.put('ManageableState', 'unmanaged');
        Map<String, Object> version = savedVersion(4);
        ((Map<String, Object>) ((List<Object>) version.get('records'))[0]).put('Definition', definition);
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route('GET', 'FROM FlowDefinition', 200, FlowCompareTestMock.page(new List<Object>{ definition }))
            .route(
                'POST',
                '/tooling/sobjects/Flow',
                201,
                new Map<String, Object>{ 'id' => FlowCompareTestMock.VERSION_ID }
            )
            .route('GET', 'FROM Flow WHERE Id', 200, version);
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcsaver')) {
            FlowCompareController.SaveResult result = FlowCompareController.saveVersion(
                'local',
                'Demo_Flow',
                METADATA,
                review(3, new List<Object>(), null)
            );
            Assert.areEqual('home__Demo_Flow', result.apiName);
            Assert.areEqual(
                'home__Demo_Flow-4',
                ((Map<String, Object>) JSON.deserializeUntyped(mock.requests[1].getBody())).get('FullName')
            );
            Assert.areEqual(
                'home__Demo_Flow',
                [SELECT Flow_Api_Name__c FROM Flow_Audit_Event__c WITH SYSTEM_MODE].Flow_Api_Name__c
            );
        }
        Test.stopTest();
    }

    @IsTest
    static void describesTheUserAndConnections() {
        System.runAs(FlowCompareTestMock.find('fcsaver')) {
            FlowCompareController.UserContext context = FlowCompareController.getUserContext();
            Assert.isFalse(context.isAdmin);
            Assert.isTrue(context.canSave);
            Assert.isTrue(context.canRequest);
            FlowCompareController.Connection local = FlowCompareController.listConnections()[0];
            Assert.areEqual('local', local.name);
            Assert.isTrue(local.isLocal);
            Assert.isTrue(local.canSave);
        }
        System.runAs(FlowCompareTestMock.find('fcnone')) {
            Assert.isFalse(FlowCompareController.getUserContext().canSave);
        }
    }

    @IsTest
    static void listsFlowsWithTheirGovernance() {
        System.runAs(FlowCompareTestMock.installer()) {
            insert new Flow_Governance__c(
                Name = 'Demo',
                Flow_Api_Name__c = 'Demo_Flow',
                Flow_Key__c = 'local:Demo_Flow',
                Mode__c = FlowGovernanceService.MODE_LOCKED,
                Owner_User__c = UserInfo.getUserId()
            );
            Map<String, Object> installed = FlowCompareTestMock.definition('Their_Flow', null, 1, null);
            installed.put('NamespacePrefix', 'vendor');
            installed.put('ManageableState', 'installed');
            Test.setMock(
                HttpCalloutMock.class,
                new FlowCompareTestMock()
                    .route(
                        'GET',
                        'FROM FlowDefinition',
                        200,
                        FlowCompareTestMock.page(
                            new List<Object>{ FlowCompareTestMock.definition('Demo_Flow', 2, 3, null), installed }
                        )
                    )
            );
            List<FlowCompareController.FlowSummary> flows;
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcsaver')) {
                flows = FlowCompareController.listFlows(null);
            }
            Test.stopTest();
            Assert.areEqual(2, flows.size());
            Assert.areEqual('Demo_Flow', flows[0].apiName);
            Assert.areEqual('Demo Flow', flows[0].label);
            Assert.areEqual(2, flows[0].activeVersion);
            Assert.areEqual(3, flows[0].latestVersion);
            Assert.areEqual(FlowGovernanceService.MODE_LOCKED, flows[0].governanceMode);
            Assert.areEqual(UserInfo.getName(), flows[0].ownerName);
            Assert.isFalse(flows[0].managed);
            Assert.areEqual(Datetime.newInstanceGmt(2026, 9, 1, 10, 0, 0), flows[0].lastModifiedDate);
            Assert.areEqual('vendor__Their_Flow', flows[1].apiName);
            Assert.isTrue(flows[1].managed);
            Assert.isNull(flows[1].activeVersion);
        }
    }

    @IsTest
    static void listsGovernanceUnderEitherLocalNamespaceAlias() {
        String home = [SELECT NamespacePrefix FROM Organization LIMIT 1].NamespacePrefix;
        if (String.isBlank(home))
            return;
        System.runAs(FlowCompareTestMock.installer()) {
            insert new List<Flow_Governance__c>{
                new Flow_Governance__c(
                    Name = 'Demo',
                    Flow_Api_Name__c = 'Demo_Flow',
                    Flow_Key__c = 'local:Demo_Flow',
                    Mode__c = 'Locked',
                    Owner_User__c = UserInfo.getUserId()
                ),
                new Flow_Governance__c(
                    Name = 'Other',
                    Flow_Api_Name__c = home + '__Other_Flow',
                    Flow_Key__c = 'local:' + home + '__Other_Flow',
                    Mode__c = 'Watch',
                    Owner_User__c = UserInfo.getUserId()
                )
            };
            Map<String, Object> local = FlowCompareTestMock.definition('Demo_Flow', 2, 3, null);
            local.put('NamespacePrefix', home);
            Map<String, Object> installed = FlowCompareTestMock.definition('Demo_Flow', 2, 3, null);
            installed.put('NamespacePrefix', 'vendor');
            installed.put('ManageableState', 'installed');
            Test.setMock(
                HttpCalloutMock.class,
                new FlowCompareTestMock()
                    .route(
                        'GET',
                        'FROM FlowDefinition',
                        200,
                        FlowCompareTestMock.page(
                            new List<Object>{
                                local,
                                FlowCompareTestMock.definition('Other_Flow', 1, 2, null),
                                installed
                            }
                        )
                    )
            );
            Test.startTest();
            List<FlowCompareController.FlowSummary> flows;
            System.runAs(FlowCompareTestMock.find('fcsaver')) {
                flows = FlowCompareController.listFlows('local');
            }
            Test.stopTest();
            Assert.areEqual('Locked', flows[0].governanceMode);
            Assert.areEqual(UserInfo.getName(), flows[0].ownerName);
            Assert.areEqual('Watch', flows[1].governanceMode);
            Assert.isNull(flows[2].governanceMode, 'Installed packages do not share the local alias');
        }
    }

    @IsTest
    static void listsAndReadsVersions() {
        Test.setMock(
            HttpCalloutMock.class,
            new FlowCompareTestMock()
                .route(
                    'GET',
                    'FROM Flow WHERE DefinitionId = \'' + FlowCompareTestMock.DEFINITION_ID + '\'',
                    200,
                    FlowCompareTestMock.page(
                        new List<Object>{
                            new Map<String, Object>{
                                'Id' => FlowCompareTestMock.VERSION_ID,
                                'DefinitionId' => FlowCompareTestMock.DEFINITION_ID,
                                'VersionNumber' => 2,
                                'Status' => 'Active',
                                'MasterLabel' => 'Demo',
                                'ProcessType' => 'Flow',
                                'ApiVersion' => 62.0,
                                'CreatedDate' => '2026-09-01T10:00:00.000+0000',
                                'CreatedBy' => new Map<String, Object>{ 'Name' => 'Creator' }
                            }
                        }
                    )
                )
                .route('GET', '/tooling/sobjects/Flow/' + FlowCompareTestMock.VERSION_ID, 200, METADATA)
        );
        Test.startTest();
        List<FlowCompareController.VersionSummary> versions = FlowCompareController.listVersions(
            'local',
            FlowCompareTestMock.DEFINITION_ID
        );
        String json = FlowCompareController.getVersion('local', FlowCompareTestMock.VERSION_ID, null);
        Test.stopTest();
        Assert.areEqual(2, versions[0].versionNumber);
        Assert.areEqual(62.0, versions[0].apiVersion);
        Assert.areEqual('Creator', versions[0].createdBy);
        Assert.isNull(versions[0].lastModifiedDate);
        Assert.areEqual(METADATA, json);
        try {
            FlowCompareController.listVersions('local', 'nope');
            Assert.fail('Bad ids are refused');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().startsWith('Not a record id'));
        }
    }

    @IsTest
    static void readsAVersionByFlowNameAndNumber() {
        // The org's own namespace is on the flow; a link names it without. An
        // installed package's namesake is never the one meant.
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route(
                'GET',
                'Definition.DeveloperName = \'Demo_Flow\' AND (VersionNumber = 2 OR Definition.NamespacePrefix = null)',
                200,
                FlowCompareTestMock.page(
                    new List<Object>{
                        flowVersion('301000000000009AAA', '300000000000009AAA', 2, 'pkg', 'installed'),
                        flowVersion(
                            FlowCompareTestMock.VERSION_ID,
                            FlowCompareTestMock.DEFINITION_ID,
                            2,
                            'cllc',
                            'unmanaged'
                        )
                    }
                )
            )
            .route('GET', 'VersionNumber = 9', 200, FlowCompareTestMock.page(new List<Object>()))
            .route('GET', '/tooling/sobjects/Flow/' + FlowCompareTestMock.VERSION_ID, 200, METADATA);
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest();
        FlowCompareController.NamedVersion version = FlowCompareController.getVersionByName('local', 'Demo_Flow', 2);
        Integer calls = mock.requests.size();
        FlowCompareController.NamedVersion missing = FlowCompareController.getVersionByName('local', 'Demo_Flow', 9);
        Test.stopTest();
        Assert.areEqual(2, calls, 'One query finds the version, one call reads it');
        Assert.areEqual(FlowCompareTestMock.VERSION_ID, version.id);
        Assert.areEqual(2, version.versionNumber);
        Assert.areEqual(Datetime.newInstanceGmt(2026, 9, 27, 12, 0, 0), version.lastModifiedDate);
        Assert.areEqual(METADATA, version.record);
        Assert.isNull(missing, 'A version the flow does not have is not an error');
        Assert.isNull(FlowCompareController.getVersionByName('local', 'Demo_Flow', null));
        try {
            FlowCompareController.getVersionByName('local', 'not a name', 1);
            Assert.fail('Bad names are refused');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().startsWith('Not a flow API name'));
        }
    }

    @IsTest
    static void readsTheVersionOfTheFlowANameMeans() {
        // Unqualified, the name means the flow without a namespace, which
        // hasn't version 2; qualified, it means the org's own flow, which has.
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route(
                'GET',
                '(VersionNumber = 2 OR Definition.NamespacePrefix = null)',
                200,
                FlowCompareTestMock.page(
                    new List<Object>{
                        flowVersion(
                            FlowCompareTestMock.VERSION_ID,
                            FlowCompareTestMock.DEFINITION_ID,
                            2,
                            'cllc',
                            'unmanaged'
                        ),
                        flowVersion('301000000000008AAA', '300000000000008AAA', 1, null, null)
                    }
                )
            )
            .route(
                'GET',
                'Definition.DeveloperName = \'Demo_Flow\' AND VersionNumber = 2',
                200,
                FlowCompareTestMock.page(
                    new List<Object>{
                        flowVersion('301000000000008AAA', '300000000000008AAA', 2, 'pkg', 'installed'),
                        flowVersion(
                            FlowCompareTestMock.VERSION_ID,
                            FlowCompareTestMock.DEFINITION_ID,
                            2,
                            'cllc',
                            'unmanaged'
                        )
                    }
                )
            )
            .route('GET', '/tooling/sobjects/Flow/' + FlowCompareTestMock.VERSION_ID, 200, METADATA);
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest();
        Assert.isNull(FlowCompareController.getVersionByName('local', 'Demo_Flow', 2));
        FlowCompareController.NamedVersion version = FlowCompareController.getVersionByName(
            'local',
            'cllc__Demo_Flow',
            2
        );
        Test.stopTest();
        Assert.areEqual(FlowCompareTestMock.VERSION_ID, version.id);
        Assert.areEqual(METADATA, version.record);
        Assert.areEqual(3, mock.requests.size(), 'Nothing is read for the version that is not there');
    }

    @IsTest
    static void readsNoVersionOfAFlowThatIsNotThere() {
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route(
                'GET',
                'FROM Flow WHERE Definition.DeveloperName',
                200,
                FlowCompareTestMock.page(new List<Object>())
            );
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest();
        Assert.isNull(FlowCompareController.getVersionByName('local', 'Gone_Flow', 1));
        Test.stopTest();
        Assert.areEqual(1, mock.requests.size());
    }

    // A Flow row as the Tooling API answers a query naming its definition's fields.
    private static Map<String, Object> flowVersion(
        String id,
        String definitionId,
        Integer versionNumber,
        String namespacePrefix,
        String manageableState
    ) {
        return new Map<String, Object>{
            'Id' => id,
            'DefinitionId' => definitionId,
            'VersionNumber' => versionNumber,
            'LastModifiedDate' => '2026-09-27T12:00:00.000+0000',
            'Definition' => new Map<String, Object>{
                'NamespacePrefix' => namespacePrefix,
                'ManageableState' => manageableState
            }
        };
    }

    @IsTest
    static void savesANewVersionAfterACollision() {
        System.runAs(FlowCompareTestMock.installer()) {
            FlowCompareTestMock mock = new FlowCompareTestMock()
                .route(
                    'GET',
                    'FROM FlowDefinition',
                    200,
                    FlowCompareTestMock.page(
                        new List<Object>{ FlowCompareTestMock.definition('Demo_Flow', 2, 3, null) }
                    )
                )
                .route(
                    'POST',
                    '/tooling/sobjects/Flow',
                    400,
                    FlowCompareTestMock.error('Duplicate', 'DUPLICATE_VALUE'),
                    1
                )
                .route(
                    'POST',
                    '/tooling/sobjects/Flow',
                    201,
                    new Map<String, Object>{ 'id' => FlowCompareTestMock.VERSION_ID }
                )
                .route('GET', 'FROM Flow WHERE Id', 200, savedVersion(4));
            Test.setMock(HttpCalloutMock.class, mock);
            FlowCompareController.SaveResult result;
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcsaver')) {
                result = FlowCompareController.saveVersion(
                    'local',
                    'Demo_Flow',
                    METADATA,
                    review(null, new List<Object>(), 'Decided:\n\n-   4 differences:  2 from Version 2.\r\n')
                );
            }
            Test.stopTest();
            Assert.areEqual(2, mock.count('POST', '/tooling/sobjects/Flow'));
            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(mock.requests[3].getBody());
            Assert.areEqual('Demo_Flow-4', body.get('FullName'));
            Map<String, Object> sentMetadata = (Map<String, Object>) body.get('Metadata');
            Assert.areEqual('Draft', sentMetadata.get('status'));
            Assert.isFalse(sentMetadata.containsKey('fullName'));
            Assert.areEqual(4, result.versionNumber);
            Assert.areEqual(FlowCompareController.BUILDER_PATH + FlowCompareTestMock.VERSION_ID, result.builderUrl);
            Flow_Audit_Event__c event = [
                SELECT Event_Type__c, Version_Number__c, Actor__c, Details__c
                FROM Flow_Audit_Event__c
            ];
            Assert.areEqual('Version Saved', event.Event_Type__c);
            // What was saved and checked, then the receipt, a line at a time.
            Assert.areEqual(
                String.join(
                    new List<String>{
                        'Saved from Tributary as inactive version 4. Saving doesn\'t activate it.',
                        candidateLine(METADATA),
                        'Decided:',
                        '- 4 differences: 2 from Version 2.',
                        'Checked by the org: accepted as inactive version 4. The org found the metadata valid. That isn\'t proof the flow does what was intended.'
                    },
                    '\n'
                ),
                event.Details__c
            );
            Assert.areEqual(event.Details__c, result.receipt);
            Assert.areEqual(FlowCompareController.fingerprint(METADATA), result.candidate);
            Assert.isTrue(result.stale.isEmpty());
            // When the org saved it: approval later refuses a version changed since.
            Assert.areEqual(Datetime.newInstanceGmt(2026, 9, 27, 12, 0, 0), result.lastModifiedDate);
            // Saved as a draft, and nothing asked the org to activate it.
            Assert.areEqual(0, mock.count('POST', '_HttpMethod=PATCH'));
            Assert.areEqual(4, event.Version_Number__c);
            Assert.areEqual(FlowCompareTestMock.find('fcsaver').Id, event.Actor__c);
        }
    }

    @IsTest
    static void savesFromSourcesStillAsCompared() {
        String sourceId = '301000000000002AAA';
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route(
                'GET',
                'FROM Flow WHERE Id IN',
                200,
                FlowCompareTestMock.page(
                    new List<Object>{
                        new Map<String, Object>{
                            'Id' => sourceId,
                            'LastModifiedDate' => '2026-09-01T10:00:00.000+0000',
                            'LastModifiedBy' => new Map<String, Object>{ 'Name' => 'Ada' }
                        }
                    }
                )
            )
            .route(
                'GET',
                'FROM FlowDefinition',
                200,
                FlowCompareTestMock.page(new List<Object>{ FlowCompareTestMock.definition('Demo_Flow', 2, 3, null) })
            )
            .route(
                'POST',
                '/tooling/sobjects/Flow',
                201,
                new Map<String, Object>{ 'id' => FlowCompareTestMock.VERSION_ID }
            )
            .route('GET', 'FROM Flow WHERE Id', 200, savedVersion(4));
        Test.setMock(HttpCalloutMock.class, mock);
        FlowCompareController.SaveResult result;
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcsaver')) {
            // The same moment, as the app and the Tooling API each write it.
            result = FlowCompareController.saveVersion(
                'local',
                'Demo_Flow',
                METADATA,
                review(
                    3,
                    new List<Object>{ source(sourceId, '2026-09-01T10:00:00.000Z', 'Version 3') },
                    'From:\n- Version 3: Demo_Flow v3'
                )
            );
        }
        Test.stopTest();
        Assert.areEqual(4, result.versionNumber);
        Assert.isTrue(
            result.receipt.contains(
                '\nSources unchanged since they were compared: 1 version checked when saving.\nFrom:\n- Version 3: Demo_Flow v3\n'
            )
        );
        Assert.areEqual(1, mock.count('GET', 'FROM Flow WHERE Id IN'));
        Assert.areEqual(0, mock.count('POST', '_HttpMethod=PATCH'));
    }

    @IsTest
    static void savesNothingWhenWhatWasComparedHasChanged() {
        String changedId = '301000000000002AAA';
        String goneId = '301000000000003AAA';
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route(
                'GET',
                'FROM Flow WHERE Id IN',
                200,
                FlowCompareTestMock.page(
                    new List<Object>{
                        new Map<String, Object>{
                            'Id' => changedId,
                            'LastModifiedDate' => '2026-09-02T09:00:00.000+0000',
                            'LastModifiedBy' => new Map<String, Object>{ 'Name' => 'Ada' }
                        }
                    }
                )
            )
            .route(
                'GET',
                'FROM FlowDefinition',
                200,
                FlowCompareTestMock.page(new List<Object>{ FlowCompareTestMock.definition('Demo_Flow', 2, 4, null) })
            );
        Test.setMock(HttpCalloutMock.class, mock);
        List<Object> sources = new List<Object>{
            source(changedId, '2026-09-01T10:00:00.000Z', 'Version 2'),
            source(goneId, '2026-09-01T10:00:00.000Z', 'Version 3')
        };
        FlowCompareController.SaveResult asVersion;
        FlowCompareController.SaveResult asFlow;
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcsaver')) {
            asVersion = FlowCompareController.saveVersion('local', 'Demo_Flow', METADATA, review(3, sources, null));
            asFlow = FlowCompareController.saveAsNewFlow(
                'local',
                'Demo_Copy',
                null,
                METADATA,
                review(null, sources, null)
            );
        }
        Test.stopTest();
        Assert.areEqual(
            new List<String>{
                'Version 2 no longer has a verifiable matching modification timestamp (last modified by Ada). An edit or activation can update this timestamp. Compare again to verify the current version.',
                'Version 3 no longer exists.',
                'Version 4 of Demo_Flow was saved after this merge was compared, so saving now would leave its changes out. Compare again with it as one side, or save as a new flow.'
            },
            asVersion.stale
        );
        Assert.isNull(asVersion.versionId);
        Assert.isNull(asVersion.receipt);
        // A new flow has no newer version to leave out, but its sources count.
        Assert.areEqual(2, asFlow.stale.size());
        Assert.areEqual(0, mock.count('POST', '/'));
        Assert.areEqual(0, [SELECT COUNT() FROM Flow_Audit_Event__c]);
    }

    @IsTest
    static void savesOnlyWhatWasReviewed() {
        FlowCompareTestMock mock = new FlowCompareTestMock();
        Test.setMock(HttpCalloutMock.class, mock);
        String other = JSON.serialize(
            new Map<String, Object>{ 'candidate' => FlowCompareController.fingerprint('{"label":"Something else"}') }
        );
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcsaver')) {
            for (String sent : new List<String>{ null, '', 'not json', '{}', other }) {
                try {
                    FlowCompareController.saveVersion('local', 'Demo_Flow', METADATA, sent);
                    Assert.fail('Saved without a matching review: ' + sent);
                } catch (AuraHandledException e) {
                    Assert.isTrue(e.getMessage().contains('review'), e.getMessage());
                }
            }
            try {
                FlowCompareController.saveAsNewFlow('local', 'Demo_Copy', null, METADATA, other);
                Assert.fail('Saved a flow that wasn\'t reviewed');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('isn\'t the one that was reviewed'), e.getMessage());
            }
        }
        Test.stopTest();
        Assert.areEqual(0, mock.requests.size());
    }

    @IsTest
    static void savesOnlyTheFormThatWasReviewed() {
        FlowCompareTestMock mock = new FlowCompareTestMock();
        Test.setMock(HttpCalloutMock.class, mock);
        // Each is fingerprinted as sent, but saving would have changed it.
        List<String> unsaved = new List<String>{
            '{"fullName":"Demo_Flow","label":"Demo","status":"Draft"}',
            '{"label":"Demo","status":"Active"}',
            '{"label":"Demo"}',
            '{"Metadata":{"fullName":"Demo_Flow","label":"Demo","status":"Draft"}}'
        };
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcsaver')) {
            for (String metadata : unsaved) {
                try {
                    FlowCompareController.saveVersion(
                        'local',
                        'Demo_Flow',
                        metadata,
                        review(metadata, 3, new List<Object>(), null)
                    );
                    Assert.fail('Saved a flow that isn\'t in its saved form: ' + metadata);
                } catch (AuraHandledException e) {
                    Assert.isTrue(e.getMessage().contains('as a draft'), e.getMessage());
                }
            }
        }
        Test.stopTest();
        Assert.areEqual(0, mock.requests.size());
    }

    @IsTest
    static void savesOnlyTheLabelThatWasReviewed() {
        FlowCompareTestMock mock = new FlowCompareTestMock();
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcsaver')) {
            // A new flow's label is in its fingerprint; a different one isn't put in.
            for (String label : new List<String>{ 'Demo copy (2)', 'demo copy' }) {
                try {
                    FlowCompareController.saveAsNewFlow(
                        'local',
                        'Demo_Copy',
                        label,
                        COPY,
                        review(COPY, null, new List<Object>(), null)
                    );
                    Assert.fail('Saved a label that wasn\'t reviewed: ' + label);
                } catch (AuraHandledException e) {
                    Assert.isTrue(e.getMessage().contains('label'), e.getMessage());
                }
            }
        }
        Test.stopTest();
        Assert.areEqual(0, mock.requests.size());
    }

    @IsTest
    static void fingerprintsLikeTheApp() {
        // The same digests flowReceipt's tests check against Node's.
        Assert.areEqual(
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            FlowCompareController.fingerprint('')
        );
        Assert.areEqual(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
            FlowCompareController.fingerprint('abc')
        );
    }

    @IsTest
    static void refusesToSaveWithoutPermissionOrValidMetadata() {
        System.runAs(FlowCompareTestMock.find('fcnone')) {
            try {
                FlowCompareController.saveVersion('local', 'Demo_Flow', METADATA, null);
                Assert.fail('Saving needs permission');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('Tributary Save'));
            }
        }
        System.runAs(FlowCompareTestMock.find('fcsaver')) {
            for (String bad : new List<String>{ 'not json', '[1]' }) {
                try {
                    FlowCompareController.saveVersion('local', 'Demo_Flow', bad, null);
                    Assert.fail('Accepted ' + bad);
                } catch (AuraHandledException e) {
                    Assert.isTrue(e.getMessage().contains('metadata'));
                }
            }
            try {
                FlowCompareController.saveAsNewFlow('local', 'ns__Copy', null, METADATA, null);
                Assert.fail('New flows have no namespace');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('namespace'));
            }
        }
    }

    @IsTest
    static void refusesToAddAVersionToAMissingFlow() {
        Test.setMock(
            HttpCalloutMock.class,
            new FlowCompareTestMock()
                .route('GET', 'FROM FlowDefinition', 200, FlowCompareTestMock.page(new List<Object>()))
        );
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcsaver')) {
            try {
                FlowCompareController.saveVersion('local', 'Gone', METADATA, review(1, new List<Object>(), null));
                Assert.fail('The flow must exist');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('no flow named Gone'));
            }
        }
        Test.stopTest();
    }

    @IsTest
    static void savesAsANewFlow() {
        System.runAs(FlowCompareTestMock.installer()) {
            FlowCompareTestMock mock = new FlowCompareTestMock()
                .route('GET', 'FROM FlowDefinition', 200, FlowCompareTestMock.page(new List<Object>()))
                .route(
                    'POST',
                    '/tooling/sobjects/Flow',
                    201,
                    new Map<String, Object>{ 'id' => FlowCompareTestMock.VERSION_ID }
                )
                .route('GET', 'FROM Flow WHERE Id', 200, savedVersion(1));
            Test.setMock(HttpCalloutMock.class, mock);
            FlowCompareController.SaveResult result;
            Test.startTest();
            System.runAs(FlowCompareTestMock.find('fcsaver')) {
                result = FlowCompareController.saveAsNewFlow(
                    'local',
                    'Demo_Copy',
                    'Demo copy',
                    COPY,
                    review(COPY, null, new List<Object>(), '  ')
                );
            }
            Test.stopTest();
            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(mock.requests[1].getBody());
            Assert.areEqual('Demo_Copy', body.get('FullName'));
            Assert.areEqual('Demo copy', ((Map<String, Object>) body.get('Metadata')).get('label'));
            Assert.areEqual(1, result.versionNumber);
            Flow_Audit_Event__c event = [SELECT Event_Type__c, Details__c FROM Flow_Audit_Event__c];
            Assert.areEqual('Flow Created', event.Event_Type__c);
            Assert.areEqual(
                String.join(
                    new List<String>{
                        'Created from Tributary as a new flow, inactive version 1. Saving doesn\'t activate it.',
                        candidateLine(COPY),
                        'Checked by the org: accepted as inactive version 1. The org found the metadata valid. That isn\'t proof the flow does what was intended.'
                    },
                    '\n'
                ),
                event.Details__c
            );
            Map<String, Object> sentMetadata = (Map<String, Object>) body.get('Metadata');
            Assert.areEqual('Draft', sentMetadata.get('status'));
            Assert.areEqual(0, mock.count('POST', '_HttpMethod=PATCH'));
        }
    }

    @IsTest
    static void explainsWhenADraftWasCreatedButConfirmationFailed() {
        Test.startTest();
        for (Boolean newFlow : new List<Boolean>{ false, true }) {
            FlowCompareTestMock mock = new FlowCompareTestMock()
                .route(
                    'GET',
                    'FROM FlowDefinition',
                    200,
                    FlowCompareTestMock.page(
                        newFlow
                            ? new List<Object>()
                            : new List<Object>{ FlowCompareTestMock.definition('Demo_Flow', 2, 3, null) }
                    )
                )
                .route(
                    'POST',
                    '/tooling/sobjects/Flow',
                    201,
                    new Map<String, Object>{ 'id' => FlowCompareTestMock.VERSION_ID }
                )
                .route(
                    'GET',
                    'FROM Flow WHERE Id',
                    newFlow ? 200 : 503,
                    newFlow
                        ? (Object) FlowCompareTestMock.page(new List<Object>())
                        : (Object) FlowCompareTestMock.error('Readback unavailable', 'SERVER_UNAVAILABLE')
                );
            Test.setMock(HttpCalloutMock.class, mock);
            System.runAs(FlowCompareTestMock.find('fcsaver')) {
                try {
                    if (newFlow) {
                        FlowCompareController.saveAsNewFlow(
                            'local',
                            'Demo_Copy',
                            'Demo copy',
                            COPY,
                            review(COPY, null, new List<Object>(), null)
                        );
                    } else {
                        FlowCompareController.saveVersion(
                            'local',
                            'Demo_Flow',
                            METADATA,
                            review(3, new List<Object>(), null)
                        );
                    }
                    Assert.fail('A failed confirmation must not look like a fully recorded save');
                } catch (AuraHandledException e) {
                    Assert.isTrue(
                        e.getMessage().contains('created draft ' + FlowCompareTestMock.VERSION_ID),
                        e.getMessage()
                    );
                    Assert.isTrue(e.getMessage().contains('before retrying'), e.getMessage());
                }
            }
            Assert.areEqual(1, mock.count('POST', '/tooling/sobjects/Flow'));
            Assert.areEqual(0, mock.count('POST', '_HttpMethod=PATCH'));
        }
        Test.stopTest();
    }

    @IsTest
    static void refusesToReplaceAnExistingFlow() {
        Test.setMock(
            HttpCalloutMock.class,
            new FlowCompareTestMock()
                .route(
                    'GET',
                    'FROM FlowDefinition',
                    200,
                    FlowCompareTestMock.page(
                        new List<Object>{ FlowCompareTestMock.definition('Demo_Flow', 1, 1, null) }
                    )
                )
        );
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcsaver')) {
            try {
                FlowCompareController.saveAsNewFlow(
                    'local',
                    'Demo_Flow',
                    null,
                    METADATA,
                    review(null, new List<Object>(), null)
                );
                Assert.fail('The name is taken');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('already exists'));
            }
        }
        Test.stopTest();
    }

    @IsTest
    static void readsAndSavesLocallyOnlyInThisOrg() {
        FlowToolingClient.localEndpoint = 'https://other.my.salesforce.com';
        FlowCompareTestMock mock = new FlowCompareTestMock();
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest();
        System.runAs(FlowCompareTestMock.find('fcsaver')) {
            for (Integer i = 0; i < 4; i++) {
                try {
                    switch on i {
                        when 0 {
                            FlowCompareController.listFlows('local');
                        }
                        when 1 {
                            FlowCompareController.listVersions(null, FlowCompareTestMock.DEFINITION_ID);
                        }
                        when 2 {
                            FlowCompareController.getVersion('local', FlowCompareTestMock.VERSION_ID, null);
                        }
                        when else {
                            FlowCompareController.saveVersion(
                                'local',
                                'Demo_Flow',
                                METADATA,
                                review(3, new List<Object>(), null)
                            );
                        }
                    }
                    Assert.fail('Call ' + i + ' used a local credential that points at another org');
                } catch (AuraHandledException e) {
                    Assert.isTrue(e.getMessage().contains('not this org'), e.getMessage());
                }
            }
        }
        Test.stopTest();
        Assert.areEqual(0, mock.requests.size());
    }

    @IsTest
    static void savesToThisOrgUnderItsRuleWhateverTheConnectionIsCalled() {
        User plain = FlowCompareTestMock.plainUser('fcplain', new List<String>{ 'Flow_Compare_User' });
        for (String name : new List<String>{ 'Loopback', 'Acme', 'Broken' }) {
            FlowToolingClient.testConnections.put(
                name,
                new Flow_Connection__mdt(DeveloperName = name, Named_Credential__c = name + '_Tooling')
            );
        }
        String orgQuery = '_Tooling/services/data/v67.0/query/?q=SELECT Id FROM Organization';
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route(
                'GET',
                'Loopback' + orgQuery,
                200,
                FlowCompareTestMock.page(
                    new List<Object>{ new Map<String, Object>{ 'Id' => UserInfo.getOrganizationId() } }
                )
            )
            .route(
                'GET',
                'Acme' + orgQuery,
                200,
                FlowCompareTestMock.page(new List<Object>{ new Map<String, Object>{ 'Id' => '00D000000000001AAA' } })
            )
            .route('GET', 'Broken' + orgQuery, 500, FlowCompareTestMock.error('Down', 'SERVER_ERROR'))
            .route('GET', 'FROM FlowDefinition', 200, FlowCompareTestMock.page(new List<Object>()));
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest();
        // No Manage Flow: not here by any name. Another org is still fine.
        System.runAs(plain) {
            Map<String, String> expected = new Map<String, String>{
                'local' => 'Tributary Save permission and Manage Flow',
                'Loopback' => 'saves to this org',
                'Broken' => 'couldn\'t check which org',
                'Acme' => 'There is no flow named Demo_Flow'
            };
            for (String connection : expected.keySet()) {
                try {
                    FlowCompareController.saveVersion(
                        connection,
                        'Demo_Flow',
                        METADATA,
                        review(3, new List<Object>(), null)
                    );
                    Assert.fail('Saved through ' + connection);
                } catch (AuraHandledException e) {
                    Assert.isTrue(
                        e.getMessage().contains(expected.get(connection)),
                        connection + ': ' + e.getMessage()
                    );
                }
            }
            try {
                FlowCompareController.saveAsNewFlow(
                    'Loopback',
                    'New_Flow',
                    'Demo',
                    METADATA,
                    review(null, new List<Object>(), null)
                );
                Assert.fail('Saved a new flow through Loopback');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('saves to this org'), e.getMessage());
            }
        }
        // Someone who could save here anyway isn't asked where it goes.
        System.runAs(FlowCompareTestMock.find('fcsaver')) {
            try {
                FlowCompareController.saveVersion(
                    'Loopback',
                    'Demo_Flow',
                    METADATA,
                    review(3, new List<Object>(), null)
                );
                Assert.fail('There is no such flow');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('There is no flow named Demo_Flow'), e.getMessage());
            }
        }
        Test.stopTest();
        // The plain user's org check, once a transaction; none for local or for fcsaver.
        Assert.areEqual(1, mock.count('GET', 'Loopback' + orgQuery));
        Assert.areEqual(0, mock.count('GET', 'Flow_Tooling_API'));
    }

    @IsTest
    static void explainsAMissingCredential() {
        AuraHandledException error = FlowCompareController.auraError(
            new CalloutException('Unable to find the named credential Flow_Tooling_API')
        );
        Assert.isTrue(error.getMessage().contains('Tributary Setup'));
        Assert.areEqual(error, FlowCompareController.auraError(error));
    }
}
