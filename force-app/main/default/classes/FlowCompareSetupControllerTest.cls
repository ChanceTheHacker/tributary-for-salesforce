@IsTest
private class FlowCompareSetupControllerTest {
    /** Stands in for ConnectApi, which tests can't call, and records what the page changes. */
    private class FakeStore extends FlowCompareSetupController.CredentialStore {
        // The package's own external credential, as ConnectApi gives it.
        final String externalId = '0pt000000000001AAA';
        String principalId;
        Boolean hasSecret = false;
        String linked = 'Flow_Tooling_API';
        String calloutUrl = 'https://old.my.salesforce.com';
        String tokenUrl = 'https://old.my.salesforce.com/services/oauth2/token';
        ConnectApi.CalloutStatus calloutStatus = ConnectApi.CalloutStatus.Enabled;
        ConnectApi.NamedCredentialInput namedInput;
        ConnectApi.ExternalCredentialInput externalInput;
        ConnectApi.CredentialInput credentialInput;
        Boolean updated;

        FakeStore(String principalId) {
            this.principalId = principalId;
        }

        public override ConnectApi.NamedCredential getNamed() {
            ConnectApi.ExternalCredential link = new ConnectApi.ExternalCredential();
            link.developerName = linked;
            // Another name is another external credential.
            link.id = linked == 'Flow_Tooling_API' ? externalId : '0pt000000000002AAA';
            ConnectApi.NamedCredential named = new ConnectApi.NamedCredential();
            named.developerName = 'Flow_Tooling_API';
            named.masterLabel = 'Flow Tooling API';
            named.type = ConnectApi.NamedCredentialType.SecuredEndpoint;
            named.calloutUrl = calloutUrl;
            named.calloutStatus = calloutStatus;
            named.externalCredentials = new List<ConnectApi.ExternalCredential>{ link };
            ConnectApi.NamedCredentialParameter managed = new ConnectApi.NamedCredentialParameter();
            managed.parameterName = 'ManagedByNamespace';
            managed.parameterType = ConnectApi.NamedCredentialParameterType.ManagedByNamespace;
            managed.parameterValue = '["SubscriberMode"]';
            named.parameters = new List<ConnectApi.NamedCredentialParameter>{ managed };
            return named;
        }

        public override ConnectApi.ExternalCredential getExternal() {
            ConnectApi.ExternalCredentialParameter tokenUrl = new ConnectApi.ExternalCredentialParameter();
            tokenUrl.parameterName = 'AuthProviderUrl';
            tokenUrl.parameterValue = this.tokenUrl;
            ConnectApi.ExternalCredential external = new ConnectApi.ExternalCredential();
            external.id = externalId;
            external.developerName = 'Flow_Tooling_API';
            external.masterLabel = 'Flow Tooling API';
            external.authenticationProtocol = ConnectApi.CredentialAuthenticationProtocol.Oauth;
            external.authenticationProtocolVariant = ConnectApi.CredentialAuthenticationProtocolVariant.ClientCredentialsClientSecret;
            external.parameters = new List<ConnectApi.ExternalCredentialParameter>{ tokenUrl };
            external.principals = new List<ConnectApi.ExternalCredentialPrincipal>();
            if (principalId != null) {
                ConnectApi.ExternalCredentialPrincipal principal = new ConnectApi.ExternalCredentialPrincipal();
                principal.id = principalId;
                principal.principalName = 'AppIdentity';
                principal.principalType = ConnectApi.CredentialPrincipalType.NamedPrincipal;
                principal.sequenceNumber = 1;
                principal.authenticationStatus = ConnectApi.CredentialAuthenticationStatus.Configured;
                external.principals.add(principal);
            }
            return external;
        }

        public override void updateNamed(ConnectApi.NamedCredentialInput input) {
            namedInput = input;
        }

        public override void updateExternal(ConnectApi.ExternalCredentialInput input) {
            externalInput = input;
        }

        public override ConnectApi.Credential getCredential() {
            ConnectApi.Credential credential = new ConnectApi.Credential();
            credential.credentials = new Map<String, ConnectApi.CredentialValue>();
            if (hasSecret) {
                credential.credentials.put('clientId', new ConnectApi.CredentialValue());
            }
            return credential;
        }

        public override void saveCredential(ConnectApi.CredentialInput input, Boolean exists) {
            credentialInput = input;
            updated = exists;
        }
    }

    /** The real AppIdentity principal, found through the grants the permission sets ship with. */
    private static String realPrincipalId() {
        List<SetupEntityAccess> grants = [
            SELECT SetupEntityId
            FROM SetupEntityAccess
            WHERE SetupEntityType = 'ExternalCredentialParameter' AND Parent.Name = 'Flow_Compare_Admin'
            LIMIT 1
        ];
        return grants.isEmpty() ? null : grants[0].SetupEntityId;
    }

    // Tests a connection as the page does: the mock answers the calls the
    // Continuation sends, then checked() reads the answers. Tests can't read
    // a Continuation's state or have Test.invokeContinuationMethod find a
    // Lightning callback, so the state is rebuilt from the calls and
    // checked() is called as the platform calls it.
    private static FlowCompareSetupController.Health checkConnection(String connection, FlowCompareTestMock mock) {
        Object started = FlowCompareSetupController.testConnection(connection);
        if (!(started instanceof Continuation)) {
            return (FlowCompareSetupController.Health) started;
        }
        Map<String, HttpRequest> requests = ((Continuation) started).getRequests();
        Assert.areEqual(3, requests.size());
        List<Object> state = new List<Object>{ FlowToolingClient.normalizeConnection(connection), null, null, null };
        List<String> checks = new List<String>{ 'FROM Organization', 'FROM FlowDefinition', 'FROM SetupAuditTrail' };
        for (String label : requests.keySet()) {
            HttpRequest request = requests.get(label);
            Test.setContinuationResponse(label, mock.respond(request));
            String endpoint = EncodingUtil.urlDecode(request.getEndpoint(), 'UTF-8');
            for (Integer i = 0; i < checks.size(); i++) {
                if (endpoint.contains(checks[i])) {
                    state[i + 1] = label;
                }
            }
        }
        return (FlowCompareSetupController.Health) FlowCompareSetupController.checked(
            new List<String>(requests.keySet()),
            state
        );
    }

    private static Map<String, Object> organization(String orgId) {
        return FlowCompareTestMock.page(
            new List<Object>{ new Map<String, Object>{ 'Id' => orgId, 'Name' => 'Acme', 'IsSandbox' => true } }
        );
    }
    @TestSetup
    static void setup() {
        FlowCompareTestMock.user('fcadmin', new List<String>{ 'Flow_Compare_Admin' });
        FlowCompareTestMock.user('fcother', new List<String>{ 'Flow_Compare_User' });
    }

    @IsTest
    static void reportsTheSetupStatus() {
        System.runAs(FlowCompareTestMock.find('fcadmin')) {
            FlowCompareSetupController.Status status = FlowCompareSetupController.getStatus();
            Assert.isTrue(status.isAdmin);
            Assert.isTrue(status.orgDomainUrl.startsWith('https://'));
            Assert.areEqual(2, status.permissionSets.size());
            Assert.areEqual('Flow_Compare_User', status.permissionSets[0].name);
            // Counted in full: fcother and fcadmin at least.
            for (FlowCompareSetupController.PermissionSetInfo info : status.permissionSets) {
                Assert.areEqual(
                    [SELECT COUNT() FROM PermissionSetAssignment WHERE PermissionSetId = :info.id],
                    info.assigned
                );
                Assert.isTrue(info.assigned > 0);
            }
            Assert.isFalse(status.monitor.scheduled);
            Assert.areEqual('local', status.connections[0].name);
            Assert.areEqual(0, status.pendingCount);
        }
    }

    @IsTest
    static void testsAConnection() {
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route('GET', 'FROM Organization', 200, organization(UserInfo.getOrganizationId()))
            .route('GET', 'FROM FlowDefinition', 200, FlowCompareTestMock.page(new List<Object>()))
            .route(
                'GET',
                'FROM SetupAuditTrail',
                403,
                FlowCompareTestMock.error('No View Setup', 'INSUFFICIENT_ACCESS')
            );
        FlowCompareSetupController.Health health = checkConnection(null, mock);
        Assert.isTrue(health.ok);
        Assert.areEqual('local', health.connection);
        Assert.areEqual('Acme', health.orgName);
        Assert.isTrue(health.isSandbox);
        Assert.isTrue(health.flowAccess);
        Assert.isFalse(health.auditAccess);
        Assert.isTrue(health.message.contains('Setup Audit Trail'));
        // The three checks, sent together; the user's name isn't waited for.
        Assert.areEqual(3, mock.requests.size());
        Assert.areEqual(0, mock.count('GET', 'userinfo'));
    }

    @IsTest
    static void refusesALocalCredentialThatReachesAnotherOrg() {
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route('GET', 'FROM Organization', 200, organization('00D000000000001AAA'))
            .route('GET', '/query', 200, FlowCompareTestMock.page(new List<Object>()));
        FlowCompareSetupController.Health health = checkConnection('local', mock);
        Assert.isFalse(health.ok);
        Assert.areEqual('00D000000000001AAA', health.orgId);
        Assert.isTrue(health.message.contains('not this org'), health.message);
        // Another org is what a Flow Connection is for.
        Flow_Connection__mdt acme = new Flow_Connection__mdt(
            DeveloperName = 'Acme',
            Named_Credential__c = 'Acme_Tooling'
        );
        FlowToolingClient.testConnections.put('Acme', acme);
        health = checkConnection('Acme', mock);
        Assert.isTrue(health.ok);
        Assert.isNull(health.message);
        Assert.areEqual('Acme', health.connection);
    }

    @IsTest
    static void refusesALocalCredentialPointedElsewhere() {
        FlowToolingClient.localEndpoint = 'https://elsewhere.my.salesforce.com';
        FlowCompareTestMock mock = new FlowCompareTestMock();
        FlowCompareSetupController.Health health = checkConnection('local', mock);
        Assert.isFalse(health.ok);
        Assert.isTrue(health.message.contains('elsewhere.my.salesforce.com'), health.message);
        Assert.isTrue(health.message.contains('Tributary Setup'), health.message);
        Assert.areEqual(0, mock.requests.size());
    }

    @IsTest
    static void namesTheUserAConnectionSignsInAs() {
        Test.setMock(
            HttpCalloutMock.class,
            new FlowCompareTestMock()
                .route(
                    'GET',
                    '/services/oauth2/userinfo',
                    200,
                    new Map<String, Object>{ 'preferred_username' => 'app@acme.test' },
                    1
                )
        );
        Test.startTest();
        Assert.areEqual('app@acme.test', FlowCompareSetupController.connectionUser('local'));
        // A name the org won't give is left out, not an error.
        Assert.isNull(FlowCompareSetupController.connectionUser('local'));
        Assert.isNull(FlowCompareSetupController.connectionUser('Nowhere'));
        Test.stopTest();
    }

    @IsTest
    static void explainsAFailedConnection() {
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route('GET', '/query', 400, '{"error":"invalid_client","error_description":"invalid client credentials"}');
        FlowCompareSetupController.Health health = checkConnection('local', mock);
        Assert.isFalse(health.ok);
        Assert.isTrue(health.message.contains('consumer key'), health.message);
        Assert.isTrue(checkConnection('Nowhere', mock).message.contains('Nowhere'));
    }

    @IsTest
    static void schedulesTheMonitor() {
        System.runAs(FlowCompareTestMock.find('fcadmin')) {
            FlowCompareSetupController.Status status = FlowCompareSetupController.startMonitor(15);
            Assert.isTrue(status.monitor.scheduled);
            Assert.areEqual(15, status.monitor.intervalMinutes);
            Assert.areEqual(4, FlowGovernanceMonitor.scheduled().size());
            FlowCompareSetupController.startMonitor(60);
            Assert.areEqual(1, FlowGovernanceMonitor.scheduled().size());
            try {
                FlowCompareSetupController.startMonitor(7);
                Assert.fail('Odd intervals are refused');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('interval'));
            }
            Assert.isFalse(FlowCompareSetupController.stopMonitor().monitor.scheduled);
        }
    }

    @IsTest
    static void runsTheCheckFromTheSchedule() {
        Test.startTest();
        new FlowGovernanceMonitor().execute((SchedulableContext) null);
        Test.stopTest();
        Assert.areEqual(
            1,
            [SELECT COUNT() FROM AsyncApexJob WHERE ApexClass.Name = 'FlowGovernanceCheckJob' AND JobType = 'Queueable']
        );
        FlowGovernanceMonitor.Status monitor = FlowCompareSetupController.getStatus().monitor;
        Assert.areEqual('Completed', monitor.lastStatus);
        Assert.isNotNull(monitor.lastRun);
        Assert.areEqual(monitor.lastRun, monitor.lastSuccess);
        Assert.isFalse(monitor.running);
    }

    @IsTest
    static void reportsTheCredential() {
        String principalId = realPrincipalId();
        FlowCompareSetupController.store = new FakeStore(principalId);
        FlowCompareSetupController.Status status = FlowCompareSetupController.getStatus();
        Assert.isNull(status.credentialError);
        Assert.areEqual('https://old.my.salesforce.com', status.calloutUrl);
        Assert.isFalse(status.urlMatches);
        Assert.areEqual('https://old.my.salesforce.com/services/oauth2/token', status.tokenUrl);
        Assert.isFalse(status.tokenUrlMatches);
        Assert.isTrue(status.calloutsEnabled);
        Assert.areEqual('Configured', status.credentialStatus);
        if (principalId != null) {
            Assert.isTrue(status.permissionSets[1].hasPrincipalAccess);
        }
    }

    @IsTest
    static void reportsCalloutsTurnedOff() {
        // As Salesforce leaves it once an app has changed the credential's URL.
        FakeStore store = new FakeStore(null);
        store.calloutUrl = Url.getOrgDomainUrl().toExternalForm();
        store.tokenUrl = store.calloutUrl + '/services/oauth2/token';
        store.calloutStatus = ConnectApi.CalloutStatus.Disabled;
        FlowCompareSetupController.store = store;
        FlowCompareSetupController.Status status = FlowCompareSetupController.getStatus();
        Assert.isTrue(status.urlMatches);
        Assert.isTrue(status.tokenUrlMatches);
        Assert.isFalse(status.calloutsEnabled);
    }

    @IsTest
    static void pointsTheCredentialAtThisOrg() {
        FakeStore store = new FakeStore('0pu000000000001AAA');
        // Linked to a credential of the same name in another namespace.
        store.linked = 'other__Flow_Tooling_API';
        FlowCompareSetupController.store = store;
        String domain = Url.getOrgDomainUrl().toExternalForm();
        System.runAs(FlowCompareTestMock.find('fcadmin')) {
            FlowCompareSetupController.pointToThisOrg();
        }
        Assert.areEqual(domain, store.namedInput.calloutUrl);
        // Linked back to the package's own, which gets this org's token URL.
        Assert.areEqual(1, store.namedInput.externalCredentials.size());
        Assert.areEqual('Flow_Tooling_API', store.namedInput.externalCredentials[0].developerName);
        Assert.isTrue(store.namedInput.calloutOptions.generateAuthorizationHeader);
        // Dropping this flag would lock the packaged credential against the next repoint.
        Assert.areEqual(1, store.namedInput.parameters.size());
        Assert.areEqual('ManagedByNamespace', store.namedInput.parameters[0].parameterName);
        Assert.areEqual('["SubscriberMode"]', store.namedInput.parameters[0].parameterValue);
        Assert.areEqual(domain + '/services/oauth2/token', store.externalInput.parameters[0].parameterValue);
        Assert.areEqual('AppIdentity', store.externalInput.principals[0].principalName);
    }

    @IsTest
    static void savesClientCredentials() {
        FakeStore store = new FakeStore(null);
        store.calloutUrl = Url.getOrgDomainUrl().toExternalForm();
        store.tokenUrl = store.calloutUrl + '/services/oauth2/token';
        FlowCompareSetupController.store = store;
        System.runAs(FlowCompareTestMock.find('fcadmin')) {
            FlowCompareSetupController.saveClientCredentials(' key ', ' secret ');
            Assert.isFalse(store.updated);
            Assert.areEqual('key', store.credentialInput.credentials.get('clientId').value);
            Assert.isFalse(store.credentialInput.credentials.get('clientId').encrypted);
            Assert.areEqual('secret', store.credentialInput.credentials.get('clientSecret').value);
            Assert.isTrue(store.credentialInput.credentials.get('clientSecret').encrypted);
            Assert.areEqual('AppIdentity', store.credentialInput.principalName);
            store.hasSecret = true;
            FlowCompareSetupController.saveClientCredentials('key2', 'secret2');
            Assert.isTrue(store.updated);
        }
    }

    @IsTest
    static void storesCredentialsOnlyWhileTheyGoToThisOrg() {
        FakeStore store = new FakeStore(null);
        FlowCompareSetupController.store = store;
        String domain = Url.getOrgDomainUrl().toExternalForm();
        System.runAs(FlowCompareTestMock.find('fcadmin')) {
            for (Integer i = 0; i < 4; i++) {
                // The callout URL elsewhere; then only the token URL; then linked to another external
                // credential; then to one of the same name in another namespace.
                store.calloutUrl = i == 0 ? 'https://old.my.salesforce.com' : domain;
                store.tokenUrl = i >= 2
                    ? domain + '/services/oauth2/token'
                    : 'https://old.my.salesforce.com/services/oauth2/token';
                store.linked = i == 2 ? 'Other_Credential' : i == 3 ? 'other__Flow_Tooling_API' : 'Flow_Tooling_API';
                try {
                    FlowCompareSetupController.saveClientCredentials('key', 'secret');
                    Assert.fail('Stored a secret that would go to another org, case ' + i);
                } catch (AuraHandledException e) {
                    Assert.isTrue(e.getMessage().contains('Point it at this org'), e.getMessage());
                    Assert.areEqual(i == 0, e.getMessage().contains('calls https://old'), e.getMessage());
                    Assert.areEqual(i == 1, e.getMessage().contains('it uses https://old'), e.getMessage());
                }
            }
            Assert.isNull(store.credentialInput);
        }
    }

    @IsTest
    static void grantsPrincipalAccess() {
        String principalId = realPrincipalId();
        System.runAs(FlowCompareTestMock.find('fcadmin')) {
            FlowCompareSetupController.store = new FakeStore(null);
            try {
                FlowCompareSetupController.grantPrincipalAccess();
                Assert.fail('There is no principal to grant');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('no AppIdentity principal'));
            }
            if (principalId == null) {
                return;
            }
            FlowCompareSetupController.store = new FakeStore(principalId);
            // Nothing to grant: nothing changes, installed or not.
            FlowCompareSetupController.installedSets = true;
            FlowCompareSetupController.grantPrincipalAccess();
            delete [
                SELECT Id
                FROM SetupEntityAccess
                WHERE SetupEntityId = :principalId AND Parent.Name = 'Flow_Compare_User'
            ];
            // An installed package's permission sets can't be changed, so it says so.
            try {
                FlowCompareSetupController.grantPrincipalAccess();
                Assert.fail('Tried to change an installed package\'s permission set');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('installed package'), e.getMessage());
            }
            FlowCompareSetupController.installedSets = false;
            FlowCompareSetupController.Status status = FlowCompareSetupController.grantPrincipalAccess();
            Assert.isTrue(status.permissionSets[0].hasPrincipalAccess);
            Assert.isTrue(status.permissionSets[1].hasPrincipalAccess);
        }
    }

    @IsTest
    static void reportsWhatAConnectionCantDo() {
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route('GET', 'FROM Organization', 200, organization(UserInfo.getOrganizationId()))
            .route(
                'GET',
                'FROM FlowDefinition',
                403,
                FlowCompareTestMock.error('No Manage Flow', 'INSUFFICIENT_ACCESS')
            )
            .route('GET', 'FROM SetupAuditTrail', 200, FlowCompareTestMock.page(new List<Object>()));
        FlowCompareSetupController.Health health = checkConnection('local', mock);
        Assert.isFalse(health.ok);
        Assert.isFalse(health.flowAccess);
        Assert.isTrue(health.auditAccess);
        Assert.isTrue(health.message.contains('can\'t read flows'));
    }

    @IsTest
    static void explainsEachKindOfFailure() {
        Assert.areEqual('The connection failed.', FlowCompareSetupController.explain('local', null));
        Assert.isTrue(
            FlowCompareSetupController.explain('local', 'No principal').contains('Grant the Tributary permission sets')
        );
        // Another org's principal goes in a permission set of the org's own, not a packaged one.
        String remote = FlowCompareSetupController.explain('Acme', 'No principal');
        Assert.isTrue(remote.contains('a permission set of your own'), remote);
        Assert.isTrue(remote.contains('Allowed Namespaces'), remote);
        Assert.isFalse(remote.contains('Grant the Tributary permission sets'), remote);
        Assert.isTrue(
            FlowCompareSetupController.explain('Acme', 'Unable to find the named credential X')
                .contains('doesn\'t exist')
        );
        Assert.areEqual('Other', FlowCompareSetupController.explain('Acme', 'Other'));
    }

    @IsTest
    static void keepsSetupChangesForAdmins() {
        System.runAs(FlowCompareTestMock.find('fcother')) {
            for (Integer i = 0; i < 5; i++) {
                try {
                    switch on i {
                        when 0 {
                            FlowCompareSetupController.pointToThisOrg();
                        }
                        when 1 {
                            FlowCompareSetupController.saveClientCredentials('key', 'secret');
                        }
                        when 2 {
                            FlowCompareSetupController.grantPrincipalAccess();
                        }
                        when 3 {
                            FlowCompareSetupController.startMonitor(15);
                        }
                        when else {
                            FlowCompareSetupController.stopMonitor();
                        }
                    }
                    Assert.fail('Call ' + i + ' needs the admin permission');
                } catch (AuraHandledException e) {
                    Assert.isTrue(e.getMessage().contains('Admin'), e.getMessage());
                }
            }
        }
        System.runAs(FlowCompareTestMock.find('fcadmin')) {
            try {
                FlowCompareSetupController.saveClientCredentials(' ', null);
                Assert.fail('Both values are required');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('Enter both'));
            }
        }
    }

    @IsTest
    static void comparesHosts() {
        Assert.isTrue(FlowToolingClient.sameHost('https://acme.my.salesforce.com', 'https://ACME.my.salesforce.com/'));
        Assert.isFalse(FlowToolingClient.sameHost('https://acme.my.salesforce.com', 'https://other.my.salesforce.com'));
        Assert.isFalse(FlowToolingClient.sameHost(null, 'https://acme.my.salesforce.com'));
        Assert.isFalse(FlowToolingClient.sameHost('not a url', 'https://acme.my.salesforce.com'));
    }
}
