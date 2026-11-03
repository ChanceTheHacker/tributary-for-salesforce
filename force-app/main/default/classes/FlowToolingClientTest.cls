@IsTest
private class FlowToolingClientTest {
    @IsTest
    static void followsEveryPageOfAQuery() {
        Map<String, Object> first = FlowCompareTestMock.page(
            new List<Object>{ new Map<String, Object>{ 'Id' => '1' } }
        );
        first.put('done', false);
        first.put('nextRecordsUrl', '/services/data/v67.0/tooling/query/01gNEXT-2000');
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route(
                'GET',
                'query/01gNEXT',
                200,
                FlowCompareTestMock.page(new List<Object>{ new Map<String, Object>{ 'Id' => '2' } })
            )
            .route('GET', 'FROM FlowDefinition', 200, first);
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest();
        List<Map<String, Object>> records = new FlowToolingClient().toolingQuery('SELECT Id FROM FlowDefinition');
        Test.stopTest();
        Assert.areEqual(2, records.size());
        Assert.areEqual('2', records[1].get('Id'));
        Assert.isTrue(
            mock.requests[0].getEndpoint().startsWith('callout:Flow_Tooling_API/services/data/v67.0/tooling/query/?q=')
        );
    }

    @IsTest
    static void failsCatchablyBeforeExhaustingTheCalloutBudget() {
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route('GET', '/query', 200, FlowCompareTestMock.page(new List<Object>()));
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest();
        FlowToolingClient client = new FlowToolingClient();
        for (Integer i = 0; i < Limits.getLimitCallouts(); i++)
            client.toolingQuery('SELECT Id FROM FlowDefinition');
        try {
            client.toolingQuery('SELECT Id FROM FlowDefinition');
            Assert.fail('The 101st call must be refused before a governor exception');
        } catch (FlowToolingClient.ToolingException e) {
            Assert.isTrue(e.getMessage().contains('API call limit'));
        }
        Assert.areEqual(100, mock.requests.size());
        Test.stopTest();
    }

    @IsTest
    static void createsActivatesAndReadsFlows() {
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route('POST', '_HttpMethod=PATCH', 204, null)
            .route(
                'POST',
                '/tooling/sobjects/Flow',
                201,
                new Map<String, Object>{ 'id' => FlowCompareTestMock.VERSION_ID }
            )
            .route('GET', '/tooling/sobjects/Flow/' + FlowCompareTestMock.VERSION_ID, 200, '{"Id":"x"}')
            .route(
                'GET',
                '/services/oauth2/userinfo',
                200,
                new Map<String, Object>{ 'preferred_username' => 'me@example.com' }
            );
        Test.setMock(HttpCalloutMock.class, mock);
        FlowToolingClient client = new FlowToolingClient(null);
        Test.startTest();
        Assert.areEqual(
            FlowCompareTestMock.VERSION_ID,
            client.createFlow('Demo-2', new Map<String, Object>{ 'label' => 'Demo', 'description' => null })
        );
        client.activate(FlowCompareTestMock.DEFINITION_ID, 2);
        Assert.areEqual('{"Id":"x"}', client.getFlowJson(FlowCompareTestMock.VERSION_ID));
        Assert.areEqual('me@example.com', client.getJson('/services/oauth2/userinfo').get('preferred_username'));
        Test.stopTest();

        Map<String, Object> created = (Map<String, Object>) JSON.deserializeUntyped(mock.requests[0].getBody());
        Assert.areEqual('Demo-2', created.get('FullName'));
        Assert.areEqual('Demo', ((Map<String, Object>) created.get('Metadata')).get('label'));
        Assert.isTrue(
            mock.requests[1]
                .getEndpoint()
                .endsWith('FlowDefinition/' + FlowCompareTestMock.DEFINITION_ID + '?_HttpMethod=PATCH')
        );
        Assert.areEqual('{"Metadata":{"activeVersionNumber":2}}', mock.requests[1].getBody());
    }

    @IsTest
    static void findsDefinitionsByNamespace() {
        Map<String, Object> other = FlowCompareTestMock.definition('Demo', 1, 1, null);
        other.put('NamespacePrefix', 'other');
        other.put('Id', '300000000000002AAA');
        Map<String, Object> own = FlowCompareTestMock.definition('Demo', 1, 1, null);
        Test.setMock(
            HttpCalloutMock.class,
            new FlowCompareTestMock()
                .route('GET', 'FROM FlowDefinition', 200, FlowCompareTestMock.page(new List<Object>{ other, own }))
        );
        FlowToolingClient client = new FlowToolingClient();
        Test.startTest();
        Assert.areEqual(FlowCompareTestMock.DEFINITION_ID, client.findDefinition('Demo').get('Id'));
        Assert.areEqual('300000000000002AAA', client.findDefinition('other__Demo').get('Id'));
        Assert.isNull(client.findDefinition('third__Demo'));
        Test.stopTest();
    }

    @IsTest
    static void fallsBackOnlyToTheOrgsOwnNamespace() {
        // In an org with a namespace, its own flows carry it; an installed package's never stand in.
        Map<String, Object> installed = FlowCompareTestMock.definition('Demo', 1, 1, null);
        installed.put('NamespacePrefix', 'pkg');
        installed.put('ManageableState', 'installed');
        installed.put('Id', '300000000000002AAA');
        Map<String, Object> own = FlowCompareTestMock.definition('Demo', 1, 1, null);
        own.put('NamespacePrefix', 'home');
        own.put('ManageableState', 'unmanaged');
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route('GET', 'FROM FlowDefinition', 200, FlowCompareTestMock.page(new List<Object>{ installed, own }), 1)
            .route('GET', 'FROM FlowDefinition', 200, FlowCompareTestMock.page(new List<Object>{ installed }));
        Test.setMock(HttpCalloutMock.class, mock);
        FlowToolingClient client = new FlowToolingClient();
        Test.startTest();
        Assert.areEqual(FlowCompareTestMock.DEFINITION_ID, client.findDefinition('Demo').get('Id'));
        Assert.isNull(client.findDefinition('Demo'));
        Test.stopTest();
        Assert.isTrue(FlowToolingClient.isOwned(own));
        Assert.isFalse(FlowToolingClient.isOwned(installed));
    }

    @IsTest
    static void explainsFailures() {
        HttpResponse response = new HttpResponse();
        response.setStatusCode(400);
        response.setBody(JSON.serialize(FlowCompareTestMock.error('Bad field', 'INVALID_FIELD')));
        FlowToolingClient.ToolingException error = FlowToolingClient.errorFor(response);
        Assert.areEqual('Bad field', error.getMessage());
        Assert.areEqual('INVALID_FIELD', error.errorCode);
        Assert.areEqual(400, error.statusCode);

        response.setBody('{"message":"Single","errorCode":"ONE"}');
        Assert.areEqual('ONE', FlowToolingClient.errorFor(response).errorCode);

        response.setStatusCode(502);
        response.setBody('<html>Bad gateway</html>');
        Assert.areEqual('HTTP 502: <html>Bad gateway</html>', FlowToolingClient.errorFor(response).getMessage());

        // Answers to a query sent some other way, as a Continuation sends it.
        response.setStatusCode(200);
        response.setBody(
            JSON.serialize(FlowCompareTestMock.page(new List<Object>{ new Map<String, Object>{ 'Id' => '1' } }))
        );
        Assert.areEqual('1', FlowToolingClient.records(response)[0].get('Id'));
        response.setStatusCode(403);
        response.setBody(JSON.serialize(FlowCompareTestMock.error('No access', 'INSUFFICIENT_ACCESS')));
        try {
            FlowToolingClient.records(response);
            Assert.fail('A 403 is an error');
        } catch (FlowToolingClient.ToolingException e) {
            Assert.areEqual('No access', e.getMessage());
        }
        // A Continuation's own codes for a call that didn't finish.
        for (Integer status : new List<Integer>{ 2000, 2001 }) {
            response.setStatusCode(status);
            response.setBody('');
            try {
                FlowToolingClient.records(response);
                Assert.fail('Code ' + status + ' is an error');
            } catch (FlowToolingClient.ToolingException e) {
                Assert.isTrue(e.getMessage().contains(status == 2000 ? 'in time' : '(2001)'), e.getMessage());
            }
        }
        HttpRequest request = new FlowToolingClient().queryRequest('SELECT Id FROM FlowDefinition', true);
        Assert.areEqual('GET', request.getMethod());
        Assert.isTrue(
            request.getEndpoint().startsWith('callout:Flow_Tooling_API/services/data/v67.0/tooling/query/?q=SELECT')
        );

        Test.setMock(HttpCalloutMock.class, new FlowCompareTestMock());
        try {
            new FlowToolingClient().getFlowJson(FlowCompareTestMock.VERSION_ID);
            Assert.fail('A 404 is an error');
        } catch (FlowToolingClient.ToolingException e) {
            Assert.areEqual('NOT_FOUND', e.errorCode);
        }
    }

    @IsTest
    static void validatesInput() {
        FlowToolingClient.FlowName name = new FlowToolingClient.FlowName('ns__My_Flow');
        Assert.areEqual('ns', name.namespacePrefix);
        Assert.areEqual('My_Flow', name.developerName);
        for (String bad : new List<String>{ null, '', '1Flow', 'My Flow', 'x\' OR Id != \'' }) {
            try {
                new FlowToolingClient.FlowName(bad);
                Assert.fail('Accepted ' + bad);
            } catch (FlowToolingClient.ToolingException e) {
                Assert.isTrue(e.getMessage().startsWith('Not a flow API name'));
            }
        }
        try {
            FlowToolingClient.checkId('301\' OR Id != \'');
            Assert.fail('Accepted a bad id');
        } catch (FlowToolingClient.ToolingException e) {
            Assert.isTrue(e.getMessage().startsWith('Not a record id'));
        }
        try {
            new FlowToolingClient().getJson('https://example.com/steal');
            Assert.fail('Accepted a foreign URL');
        } catch (FlowToolingClient.ToolingException e) {
            Assert.isTrue(e.getMessage().startsWith('Not a Salesforce API path'));
        }
        try {
            new FlowToolingClient('No_Such_Connection');
            Assert.fail('Accepted an unknown connection');
        } catch (FlowToolingClient.ToolingException e) {
            Assert.isTrue(e.getMessage().contains('No_Such_Connection'));
        }
    }

    @IsTest
    static void usesThisOrgsCredentialOnlyWhileItPointsHere() {
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route('GET', '/query', 200, FlowCompareTestMock.page(new List<Object>()));
        Test.setMock(HttpCalloutMock.class, mock);
        FlowToolingClient.localEndpoint = 'https://other.my.salesforce.com';
        for (String connection : new List<String>{ null, 'local' }) {
            try {
                new FlowToolingClient(connection);
                Assert.fail('Used a local credential that points at another org');
            } catch (FlowToolingClient.ToolingException e) {
                Assert.isTrue(e.getMessage().contains('https://other.my.salesforce.com, not this org'), e.getMessage());
                Assert.isTrue(e.getMessage().contains('Tributary Setup'), e.getMessage());
            }
        }
        // Another org is reached through a Flow Connection.
        FlowToolingClient.testConnections.put(
            'Other',
            new Flow_Connection__mdt(DeveloperName = 'Other', Named_Credential__c = 'Other_Org')
        );
        Assert.isTrue(new FlowToolingClient('Other').toolingQuery('SELECT Id FROM FlowDefinition').isEmpty());
        // A credential that calls this org but signs in elsewhere isn't used either.
        FlowToolingClient.localEndpoint = Url.getOrgDomainUrl().toExternalForm();
        FlowToolingClient.localTokenUrl = 'https://other.my.salesforce.com/services/oauth2/token';
        try {
            new FlowToolingClient();
            Assert.fail('Used a local credential that signs in at another org');
        } catch (FlowToolingClient.ToolingException e) {
            Assert.isTrue(
                e.getMessage().contains('(it uses https://other.my.salesforce.com/services/oauth2/token)'),
                e.getMessage()
            );
        }
        FlowToolingClient.localTokenUrl = Url.getOrgDomainUrl().toExternalForm() + '/services/oauth2/token';
        FlowToolingClient.localEndpoint = Url.getOrgDomainUrl().toExternalForm() + '/';
        Assert.isTrue(new FlowToolingClient().toolingQuery('SELECT Id FROM FlowDefinition').isEmpty());
        Assert.areEqual(2, mock.requests.size());
        Assert.isTrue(mock.requests[0].getEndpoint().startsWith('callout:Other_Org/'));
        Assert.isTrue(mock.requests[1].getEndpoint().startsWith('callout:Flow_Tooling_API/'));
    }

    @IsTest
    static void acceptsOnlyThisOrgsHttpsMyDomain() {
        String domain = Url.getOrgDomainUrl().toExternalForm();
        String host = Url.getOrgDomainUrl().getHost();
        Assert.isTrue(FlowToolingClient.isThisOrg(domain));
        Assert.isTrue(FlowToolingClient.isThisOrg(domain + '/'));
        Assert.isFalse(FlowToolingClient.isThisOrg('http://' + host));
        Assert.isFalse(FlowToolingClient.isThisOrg('https://other.my.salesforce.com'));
        Assert.isFalse(FlowToolingClient.isThisOrg(null));
        Assert.isTrue(FlowToolingClient.isThisOrgsTokenUrl(domain + '/services/oauth2/token'));
        Assert.isFalse(FlowToolingClient.isThisOrgsTokenUrl('http://' + host + '/services/oauth2/token'));
        Assert.isFalse(FlowToolingClient.isThisOrgsTokenUrl(domain + '/services/oauth2/authorize'));
        Assert.isFalse(FlowToolingClient.isThisOrgsTokenUrl(domain));
        Assert.isFalse(FlowToolingClient.isThisOrgsTokenUrl(domain + '/services/oauth2/token?x=1'));
        Assert.isFalse(FlowToolingClient.isThisOrgsTokenUrl('https://login.salesforce.com/services/oauth2/token'));
    }

    @IsTest
    static void refusesUnreadableCredentialsBeforeAnyCall() {
        FlowCompareTestMock mock = thisOrgMock();
        FakeCredential credential = new FakeCredential();
        credential.namedReadable = false;
        FlowToolingClient.reader = credential;
        FlowToolingClient.localEndpoint = null;
        for (Integer i = 0; i < 2; i++) {
            Assert.isTrue(refusal().contains('no call was made'));
        }
        Assert.areEqual(0, mock.requests.size(), 'Even an org-identity probe could send the client secret');
    }

    @IsTest
    static void plainUsersFailClosedWithoutCredentialVisibility() {
        User reviewer = FlowCompareTestMock.plainUser('fcverify', new List<String>{ 'Flow_Compare_User' });
        FlowCompareTestMock mock = thisOrgMock();
        FlowToolingClient.localEndpoint = null;
        // Unlike other tests, use the real reader: ConnectApi cannot run in
        // tests. Its refusal must not silently trigger a callout as this user.
        System.runAs(reviewer) {
            Assert.isTrue(refusal().contains('View Setup and Configuration'));
        }
        Assert.areEqual(0, mock.requests.size());
    }

    @IsTest
    static void aliasesCannotBypassThePackagedCredentialGuard() {
        FlowCompareTestMock mock = thisOrgMock();
        FlowToolingClient.localEndpoint = 'https://other.my.salesforce.com';
        for (
            String name : new Set<String>{
                'Flow_Tooling_API',
                FlowGovernanceService.NAMESPACE_PREFIX + 'Flow_Tooling_API'
            }
        ) {
            FlowToolingClient.testConnections.put(
                'Alias',
                new Flow_Connection__mdt(DeveloperName = 'Alias', Named_Credential__c = name)
            );
            try {
                new FlowToolingClient('Alias').toolingQuery('SELECT Id FROM FlowDefinition');
                Assert.fail('An alias bypassed the local credential guard');
            } catch (FlowToolingClient.ToolingException e) {
                Assert.isTrue(e.getMessage().contains('not this org'));
            }
        }
        Assert.areEqual(0, mock.requests.size());
    }

    @IsTest
    static void refusesUnreadableExternalCredentialBeforeAnyCall() {
        FlowCompareTestMock mock = thisOrgMock();
        FakeCredential credential = new FakeCredential();
        credential.externalReadable = false;
        // Even the correct name is not proof of the token URL.
        credential.linkedName = FlowGovernanceService.NAMESPACE_PREFIX + 'Flow_Tooling_API';
        FlowToolingClient.reader = credential;
        FlowToolingClient.localEndpoint = null;
        Assert.isTrue(refusal().contains('no call was made'));
        Assert.areEqual(0, mock.requests.size());
    }

    @IsTest
    static void continuationsCannotSkipCredentialVerification() {
        FlowCompareTestMock mock = thisOrgMock();
        FlowToolingClient client = new FlowToolingClient();
        FakeCredential credential = new FakeCredential();
        credential.namedReadable = false;
        FlowToolingClient.reader = credential;
        FlowToolingClient.localEndpoint = null;
        try {
            client.queryRequest('SELECT Id FROM Organization', false);
            Assert.fail('Constructed a request without verifying where OAuth sends secrets');
        } catch (FlowToolingClient.ToolingException e) {
            Assert.isTrue(e.getMessage().contains('no call was made'));
        }
        Assert.areEqual(0, mock.requests.size());
    }

    @IsTest
    static void refusesMissingNamedCredential() {
        FlowCompareTestMock mock = thisOrgMock();
        FakeCredential credential = new FakeCredential();
        credential.namedMissing = true;
        FlowToolingClient.reader = credential;
        FlowToolingClient.localEndpoint = null;
        Assert.isTrue(refusal().contains('no call was made'));
        Assert.areEqual(0, mock.requests.size());
    }

    @IsTest
    static void refusesMissingExternalCredential() {
        FlowCompareTestMock mock = thisOrgMock();
        FakeCredential credential = new FakeCredential();
        credential.externalMissing = true;
        FlowToolingClient.reader = credential;
        FlowToolingClient.localEndpoint = null;
        Assert.isTrue(refusal().contains('no call was made'));
        Assert.areEqual(0, mock.requests.size());
    }

    @IsTest
    static void orgIdentityRequestsCannotSkipCredentialVerification() {
        FlowCompareTestMock mock = thisOrgMock();
        FlowToolingClient client = new FlowToolingClient();
        FlowToolingClient.localEndpoint = 'https://other.my.salesforce.com';
        try {
            client.orgId();
            Assert.fail('The identity probe bypassed credential verification');
        } catch (FlowToolingClient.ToolingException e) {
            Assert.isTrue(e.getMessage().contains('not this org'));
        }
        Assert.areEqual(0, mock.requests.size());
    }

    /** Stands in for ConnectApi's reads of this org's credential. */
    private class FakeCredential extends FlowToolingClient.LocalCredential {
        String calloutUrl = Url.getOrgDomainUrl().toExternalForm();
        String linked = '0pt000000000001AAA';
        String linkedName = 'other__Flow_Tooling_API';
        Boolean namedReadable = true;
        Boolean externalReadable = true;
        Boolean namedMissing = false;
        Boolean externalMissing = false;

        public override ConnectApi.NamedCredential getNamed() {
            if (!namedReadable) {
                throw new FlowToolingClient.ToolingException('Insufficient privileges');
            }
            if (namedMissing) {
                return null;
            }
            ConnectApi.ExternalCredential link = new ConnectApi.ExternalCredential();
            link.id = linked;
            link.developerName = linkedName;
            ConnectApi.NamedCredential named = new ConnectApi.NamedCredential();
            named.calloutUrl = calloutUrl;
            named.externalCredentials = new List<ConnectApi.ExternalCredential>{ link };
            return named;
        }

        public override ConnectApi.ExternalCredential getExternal() {
            if (!externalReadable) {
                throw new FlowToolingClient.ToolingException('Insufficient privileges');
            }
            if (externalMissing) {
                return null;
            }
            ConnectApi.ExternalCredentialParameter tokenUrl = new ConnectApi.ExternalCredentialParameter();
            tokenUrl.parameterName = 'AuthProviderUrl';
            tokenUrl.parameterValue = Url.getOrgDomainUrl().toExternalForm() + '/services/oauth2/token';
            ConnectApi.ExternalCredential external = new ConnectApi.ExternalCredential();
            external.id = '0pt000000000001AAA';
            external.parameters = new List<ConnectApi.ExternalCredentialParameter>{ tokenUrl };
            return external;
        }
    }

    // Answers that the credential reaches this org, so only a refusal made
    // before any call keeps the secret home.
    private static FlowCompareTestMock thisOrgMock() {
        FlowCompareTestMock mock = new FlowCompareTestMock()
            .route(
                'GET',
                'FROM Organization',
                200,
                FlowCompareTestMock.page(
                    new List<Object>{ new Map<String, Object>{ 'Id' => UserInfo.getOrganizationId() } }
                )
            )
            .route('GET', 'FROM FlowDefinition', 200, FlowCompareTestMock.page(new List<Object>()));
        Test.setMock(HttpCalloutMock.class, mock);
        return mock;
    }

    private static String refusal() {
        try {
            new FlowToolingClient().toolingQuery('SELECT Id FROM FlowDefinition');
        } catch (FlowToolingClient.ToolingException e) {
            return e.getMessage();
        }
        return null;
    }

    @IsTest
    static void usesOnlyThePackagesOwnExternalCredential() {
        FlowCompareTestMock mock = thisOrgMock();
        FakeCredential credential = new FakeCredential();
        // Linked to another external credential of the same name, in another namespace.
        credential.linked = '0pt000000000002AAA';
        FlowToolingClient.reader = credential;
        FlowToolingClient.localEndpoint = null;
        Assert.isTrue(refusal().contains('doesn\'t sign in at this org\'s own token URL'), refusal());
        Assert.areEqual(0, mock.requests.size());
    }

    @IsTest
    static void usesThePackagesOwnExternalCredential() {
        FlowCompareTestMock mock = thisOrgMock();
        FlowToolingClient.reader = new FakeCredential();
        FlowToolingClient.localEndpoint = null;
        Assert.isNull(refusal());
        // Read, not asked: no call to find out which org it is.
        Assert.areEqual(0, mock.count('GET', 'FROM Organization'));
        Assert.areEqual(1, mock.count('GET', 'FROM FlowDefinition'));
    }

    @IsTest
    static void keepsWhatItReadWhenTheNextReadFails() {
        FlowCompareTestMock mock = thisOrgMock();
        FakeCredential credential = new FakeCredential();
        credential.calloutUrl = 'https://other.my.salesforce.com';
        credential.externalReadable = false;
        FlowToolingClient.reader = credential;
        FlowToolingClient.localEndpoint = null;
        for (Integer i = 0; i < 2; i++) {
            Assert.isTrue(refusal().contains('calls https://other.my.salesforce.com, not this org'), refusal());
        }
        Assert.areEqual(0, mock.requests.size(), 'Asked the org after reading that the credential goes elsewhere');
    }

    @IsTest
    static void keepsAnotherLinkItReadWhenTheNextReadFails() {
        FlowCompareTestMock mock = thisOrgMock();
        FakeCredential credential = new FakeCredential();
        credential.linked = '0pt000000000002AAA';
        credential.externalReadable = false;
        FlowToolingClient.reader = credential;
        FlowToolingClient.localEndpoint = null;
        Assert.isTrue(refusal().contains('no call was made'), refusal());
        Assert.areEqual(0, mock.requests.size(), 'Asked the org after reading that it links another credential');
    }

    @IsTest
    static void knowsThePackagesOwnExternalCredentialByName() {
        // Without an Id to compare, only the exact name with this package's namespace counts.
        String prefix = FlowGovernanceService.NAMESPACE_PREFIX;
        Assert.isTrue(links(prefix + 'Flow_Tooling_API'));
        Assert.isFalse(links('other__Flow_Tooling_API'));
        Assert.isFalse(links('Other_Credential'));
        // Unprefixed, it's the subscriber's own, unless the package has no namespace.
        Assert.areEqual(String.isBlank(prefix), links('Flow_Tooling_API'));
    }

    private static Boolean links(String developerName) {
        ConnectApi.ExternalCredential link = new ConnectApi.ExternalCredential();
        link.developerName = developerName;
        ConnectApi.NamedCredential named = new ConnectApi.NamedCredential();
        named.externalCredentials = new List<ConnectApi.ExternalCredential>{ link };
        return FlowToolingClient.linksLocalCredential(named, new ConnectApi.ExternalCredential());
    }

    @IsTest
    static void readsNestedFields() {
        Map<String, Object> definition = FlowCompareTestMock.definition('Demo', 3, 4, null);
        Assert.areEqual(3, FlowToolingClient.intPath(definition, 'ActiveVersion.VersionNumber'));
        Assert.isNull(FlowToolingClient.path(definition, 'ActiveVersion.VersionNumber.Deeper'));
        Assert.isNull(FlowToolingClient.intPath(definition, 'Missing.VersionNumber'));
        definition.put('NamespacePrefix', 'ns');
        Assert.areEqual('ns__Demo', FlowToolingClient.apiNameOf(definition));
        Assert.isTrue(FlowToolingClient.isLocal(' '));
        Assert.isFalse(FlowToolingClient.isLocal('Production'));
    }
}
