/**
 * Calls the Tooling and REST APIs through a Named Credential: this org's own
 * (Flow_Tooling_API), or another org's, set up as a Flow Connection.
 *
 * Only Named Credentials listed in Flow_Connection__mdt can be reached, so a
 * caller can't point the app at an arbitrary endpoint. "local" means this
 * org: its credential is used only while it points here.
 */
public with sharing class FlowToolingClient {
    public static final String LOCAL = 'local';
    @TestVisible
    private static final String DEFAULT_CREDENTIAL = 'Flow_Tooling_API';
    private static final String API = '/services/data/v67.0';
    private static final Integer TIMEOUT_MS = 120000;
    public static final String TOKEN_PATH = '/services/oauth2/token';

    public class ToolingException extends Exception {
        public Integer statusCode;
        public String errorCode;
    }

    // Tests add connections here, since they can't insert custom metadata.
    @TestVisible
    private static Map<String, Flow_Connection__mdt> testConnections = new Map<String, Flow_Connection__mdt>();

    // Where this org's credential calls and where it signs in, read once a
    // transaction. ConnectApi reads them without a callout, but can't run in
    // tests, so they start here.
    @TestVisible
    private static String localEndpoint = Test.isRunningTest() ? Url.getOrgDomainUrl().toExternalForm() : null;
    @TestVisible
    private static String localTokenUrl = Test.isRunningTest()
        ? Url.getOrgDomainUrl().toExternalForm() + TOKEN_PATH
        : null;
    // An unreadable credential must fail before OAuth can send any secrets.
    private static String localReadFailure;
    private static final String UNREADABLE_CREDENTIAL =
        'Tributary cannot verify the Flow Tooling API credential before signing in, so no call was made. ' +
        'Ask an admin to verify both credentials in Tributary Setup and, if appropriate, grant you View Setup and Configuration. ' +
        'Tributary does not grant that broader setup access automatically.';
    // The org each connection reaches, asked at most once a transaction.
    private static Map<String, String> orgIds = new Map<String, String>();

    public final String connection;
    private final String credential;

    public FlowToolingClient() {
        this(LOCAL);
    }

    public FlowToolingClient(String connection) {
        this.connection = normalizeConnection(connection);
        this.credential = credentialFor(this.connection);
    }

    public static String normalizeConnection(String connection) {
        return String.isBlank(connection) ? LOCAL : connection;
    }

    public static Boolean isLocal(String connection) {
        return normalizeConnection(connection) == LOCAL;
    }

    public static String credentialFor(String connection) {
        if (isLocal(connection)) {
            requireThisOrg();
            return DEFAULT_CREDENTIAL;
        }
        Flow_Connection__mdt record = testConnections.containsKey(connection)
            ? testConnections.get(connection)
            : Flow_Connection__mdt.getInstance(connection);
        if (record == null || String.isBlank(record.Named_Credential__c)) {
            throw new ToolingException('There is no Flow Connection named ' + connection + '.');
        }
        // A Flow Connection alias must not bypass the packaged credential's guard.
        if (isPackagedCredential(record.Named_Credential__c)) {
            requireThisOrg();
        }
        return record.Named_Credential__c;
    }

    private static Boolean isPackagedCredential(String name) {
        return name == DEFAULT_CREDENTIAL || name == FlowGovernanceService.NAMESPACE_PREFIX + DEFAULT_CREDENTIAL;
    }

    /** Reads this org's credential. ConnectApi can't run in tests, so tests replace this. */
    public virtual class LocalCredential {
        public virtual ConnectApi.NamedCredential getNamed() {
            return ConnectApi.NamedCredentials.getNamedCredential(DEFAULT_CREDENTIAL);
        }
        public virtual ConnectApi.ExternalCredential getExternal() {
            return ConnectApi.NamedCredentials.getExternalCredential(DEFAULT_CREDENTIAL);
        }
    }

    @TestVisible
    private static LocalCredential reader = new LocalCredential();

    // Saves, governance and history all take "local" to be this org, so a
    // credential pointed anywhere else isn't used at all, and the key and
    // secret are only sent to this org's own token URL.
    private static void requireThisOrg() {
        if (localEndpoint == null && localReadFailure == null) {
            readLocalCredential();
        }
        if (localReadFailure != null) {
            throw new ToolingException(localReadFailure);
        }
        if (!isThisOrg(localEndpoint)) {
            throw new ToolingException(
                'The Flow Tooling API credential calls ' +
                    (String.isBlank(localEndpoint) ? 'nowhere' : localEndpoint) +
                    ', not this org, so Tributary won\'t use it. Ask an admin to open Tributary Setup and point it at this org.'
            );
        }
        if (!isThisOrgsTokenUrl(localTokenUrl)) {
            throw new ToolingException(
                'The Flow Tooling API credential doesn\'t sign in at this org\'s own token URL' +
                    (String.isBlank(localTokenUrl) ? '' : ' (it uses ' + localTokenUrl + ')') +
                    ', so Tributary won\'t send it this org\'s key and secret. Ask an admin to open Tributary Setup and point it at this org.'
            );
        }
    }

    // No post-authentication probe can protect a secret sent during OAuth.
    // Both setup reads must succeed before the credential can be used.
    private static void readLocalCredential() {
        ConnectApi.NamedCredential named;
        try {
            named = reader.getNamed();
        } catch (Exception e) {
            localReadFailure = UNREADABLE_CREDENTIAL;
            return;
        }
        if (named == null) {
            localReadFailure = UNREADABLE_CREDENTIAL;
            return;
        }
        localEndpoint = named.calloutUrl == null ? '' : named.calloutUrl;
        localTokenUrl = null;
        // Refused in requireThisOrg, whatever the next read would say.
        if (!isThisOrg(localEndpoint)) {
            return;
        }
        ConnectApi.ExternalCredential external;
        try {
            external = reader.getExternal();
        } catch (Exception e) {
            localReadFailure = UNREADABLE_CREDENTIAL;
            return;
        }
        if (external == null) {
            localReadFailure = UNREADABLE_CREDENTIAL;
            return;
        }
        if (linksLocalCredential(named, external)) {
            localTokenUrl = tokenUrlOf(external);
        }
    }

    /** The Id of the org this connection's calls reach, asked at most once a transaction. */
    public String orgId() {
        if (!orgIds.containsKey(connection)) {
            List<Map<String, Object>> found = records(
                call(request('GET', queryPath('SELECT Id FROM Organization', false), null))
            );
            if (found.isEmpty()) {
                throw new ToolingException('The org didn\'t say which org it is.');
            }
            orgIds.put(connection, (String) found[0].get('Id'));
        }
        return orgIds.get(connection);
    }

    /** Whether this connection reaches this org, whatever it's called. */
    public Boolean reachesThisOrg() {
        return sameOrg(orgId(), UserInfo.getOrganizationId());
    }

    /** Whether two org Ids are the same org. */
    public static Boolean sameOrg(String a, String b) {
        // Ids are case-sensitive; == on strings isn't.
        return String.isNotBlank(a) && String.isNotBlank(b) && a.left(15).equals(b.left(15));
    }

    /** Whether a URL is this org's My Domain, over HTTPS. */
    public static Boolean isThisOrg(String address) {
        return isHttps(address) && sameHost(address, Url.getOrgDomainUrl().toExternalForm());
    }

    /** Whether a URL is this org's OAuth token endpoint: its HTTPS My Domain and /services/oauth2/token. */
    public static Boolean isThisOrgsTokenUrl(String address) {
        if (!isThisOrg(address)) {
            return false;
        }
        Url parsed = new Url(address);
        return parsed.getPath() == TOKEN_PATH && parsed.getQuery() == null && parsed.getRef() == null;
    }

    private static Boolean isHttps(String address) {
        try {
            return String.isNotBlank(address) && new Url(address).getProtocol().equalsIgnoreCase('https');
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Whether a named credential signs in with this package's own Flow Tooling
     * API external credential, as read: the same record by Id, or when either
     * Id is missing, by its exact name with this package's namespace. A
     * credential of the same name in another namespace doesn't count.
     */
    public static Boolean linksLocalCredential(ConnectApi.NamedCredential named, ConnectApi.ExternalCredential own) {
        if (named.externalCredentials == null || named.externalCredentials.size() != 1) {
            return false;
        }
        ConnectApi.ExternalCredential link = named.externalCredentials[0];
        if (String.isNotBlank(link.id) && own != null && String.isNotBlank(own.id)) {
            // Ids are case-sensitive; == on strings isn't.
            return link.id.left(15).equals(own.id.left(15));
        }
        return link.developerName == FlowGovernanceService.NAMESPACE_PREFIX + DEFAULT_CREDENTIAL;
    }

    /** An external credential's OAuth token URL, or null. */
    public static String tokenUrlOf(ConnectApi.ExternalCredential external) {
        for (
            ConnectApi.ExternalCredentialParameter parameter : external.parameters == null
                ? new List<ConnectApi.ExternalCredentialParameter>()
                : external.parameters
        ) {
            if (parameter.parameterName == 'AuthProviderUrl') {
                return parameter.parameterValue;
            }
        }
        return null;
    }

    /** Whether two URLs name the same host. */
    public static Boolean sameHost(String a, String b) {
        if (String.isBlank(a) || String.isBlank(b)) {
            return false;
        }
        try {
            return new Url(a).getHost().equalsIgnoreCase(new Url(b).getHost());
        } catch (Exception e) {
            return false;
        }
    }

    /** Runs a SOQL query against the Tooling API (or the REST API), following every page. */
    public List<Map<String, Object>> query(String soql, Boolean tooling) {
        List<Map<String, Object>> records = new List<Map<String, Object>>();
        String path = queryPath(soql, tooling);
        while (path != null) {
            Map<String, Object> page = (Map<String, Object>) JSON.deserializeUntyped(send('GET', path, null).getBody());
            for (Object record : (List<Object>) page.get('records')) {
                records.add((Map<String, Object>) record);
            }
            Boolean done = page.get('done') != false;
            path = done ? null : (String) page.get('nextRecordsUrl');
        }
        return records;
    }

    public List<Map<String, Object>> toolingQuery(String soql) {
        return query(soql, true);
    }

    /** GETs a Salesforce API path, such as /services/oauth2/userinfo, and parses the JSON. */
    public Map<String, Object> getJson(String apiPath) {
        if (apiPath == null || !apiPath.startsWith('/services/')) {
            throw new ToolingException('Not a Salesforce API path: ' + apiPath);
        }
        return (Map<String, Object>) JSON.deserializeUntyped(send('GET', apiPath, null).getBody());
    }

    /** A Tooling API Flow record (Id, FullName, VersionNumber, Status, Metadata...) as JSON. */
    public String getFlowJson(String flowVersionId) {
        return send('GET', API + '/tooling/sobjects/Flow/' + checkId(flowVersionId), null).getBody();
    }

    /**
     * Creates a flow version. fullName is the flow's API name for a new flow,
     * or "<API name>-<version number>" for a new version of an existing one.
     */
    public String createFlow(String fullName, Map<String, Object> metadata) {
        Map<String, Object> body = new Map<String, Object>{ 'FullName' => fullName, 'Metadata' => metadata };
        HttpResponse response = send('POST', API + '/tooling/sobjects/Flow', JSON.serialize(body, true));
        Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
        return (String) result.get('id');
    }

    /** Makes a version the active one; version 0 deactivates the flow. */
    public void activate(String definitionId, Integer versionNumber) {
        Map<String, Object> body = new Map<String, Object>{
            'Metadata' => new Map<String, Object>{ 'activeVersionNumber' => versionNumber }
        };
        send('PATCH', API + '/tooling/sobjects/FlowDefinition/' + checkId(definitionId), JSON.serialize(body));
    }

    /** The FlowDefinition for a flow API name ("Name" or "ns__Name"), or null. */
    public Map<String, Object> findDefinition(String apiName) {
        FlowName name = new FlowName(apiName);
        String soql =
            'SELECT Id, DeveloperName, NamespacePrefix, ManageableState, ActiveVersionId, LatestVersionId,' +
            ' ActiveVersion.VersionNumber, LatestVersion.VersionNumber,' +
            ' LatestVersion.MasterLabel, LatestVersion.ProcessType,' +
            ' LastModifiedById, LastModifiedDate FROM FlowDefinition' +
            ' WHERE DeveloperName = \'' +
            name.developerName +
            '\'';
        return name.pick(toolingQuery(soql), null);
    }

    /** Whether a FlowDefinition is the org's own rather than an installed package's. */
    public static Boolean isOwned(Map<String, Object> definition) {
        String state = (String) definition.get('ManageableState');
        return state == null || state == 'unmanaged' || state == 'beta' || state == 'released';
    }

    /** The first query request, also checked before a Continuation can sign in. */
    public HttpRequest queryRequest(String soql, Boolean tooling) {
        return request('GET', queryPath(soql, tooling), null);
    }

    private static String queryPath(String soql, Boolean tooling) {
        return API + (tooling ? '/tooling' : '') + '/query/?q=' + EncodingUtil.urlEncode(soql, 'UTF-8');
    }

    /** The records in the answer to a queryRequest. A failed call throws, as it does here. */
    public static List<Map<String, Object>> records(HttpResponse response) {
        Integer status = response.getStatusCode();
        // A Continuation reports a call it couldn't finish as 2000 and up, with no body.
        if (status >= 2000) {
            throw new ToolingException(
                status == 2000
                    ? 'The org didn\'t answer in time.'
                    : 'The call failed before the org answered (' + status + ').'
            );
        }
        if (status >= 300) {
            throw errorFor(response);
        }
        List<Map<String, Object>> records = new List<Map<String, Object>>();
        Map<String, Object> page = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
        for (Object record : (List<Object>) page.get('records')) {
            records.add((Map<String, Object>) record);
        }
        return records;
    }

    private HttpResponse send(String method, String path, String body) {
        return call(request(method, path, body));
    }

    private static HttpResponse call(HttpRequest request) {
        if (Limits.getCallouts() >= Limits.getLimitCallouts()) {
            throw new ToolingException('The API call limit was reached. Try again in the next transaction.');
        }
        HttpResponse response = new Http().send(request);
        if (response.getStatusCode() >= 300) {
            throw errorFor(response);
        }
        return response;
    }

    private HttpRequest request(String method, String path, String body) {
        if (isPackagedCredential(credential)) {
            requireThisOrg();
        }
        HttpRequest request = new HttpRequest();
        // Apex can't send PATCH; the REST API accepts it as an override.
        if (method == 'PATCH') {
            path += (path.contains('?') ? '&' : '?') + '_HttpMethod=PATCH';
            method = 'POST';
        }
        request.setMethod(method);
        request.setEndpoint('callout:' + credential + path);
        request.setTimeout(TIMEOUT_MS);
        request.setHeader('Accept', 'application/json');
        if (body != null) {
            request.setHeader('Content-Type', 'application/json');
            request.setBody(body);
        }
        return request;
    }

    @TestVisible
    private static ToolingException errorFor(HttpResponse response) {
        String message = 'HTTP ' + response.getStatusCode();
        String code;
        try {
            Object parsed = JSON.deserializeUntyped(response.getBody());
            List<Object> errors = parsed instanceof List<Object> ? (List<Object>) parsed : new List<Object>{ parsed };
            List<String> messages = new List<String>();
            for (Object error : errors) {
                Map<String, Object> fields = (Map<String, Object>) error;
                String text = (String) fields.get('message');
                String errorCode = (String) fields.get('errorCode');
                // OAuth endpoints answer {"error": ..., "error_description": ...}.
                if (text == null && fields.get('error') != null) {
                    errorCode = (String) fields.get('error');
                    text =
                        errorCode +
                        (fields.get('error_description') == null ? '' : ': ' + fields.get('error_description'));
                }
                if (text != null) {
                    messages.add(text);
                }
                code = code == null ? errorCode : code;
            }
            if (!messages.isEmpty()) {
                message = String.join(messages, ' ');
            }
        } catch (Exception e) {
            if (String.isNotBlank(response.getBody())) {
                message += ': ' + response.getBody().abbreviate(500);
            }
        }
        ToolingException error = new ToolingException(message);
        error.statusCode = response.getStatusCode();
        error.errorCode = code;
        return error;
    }

    public static String checkId(String value) {
        if (value == null || !Pattern.matches('[a-zA-Z0-9]{15}|[a-zA-Z0-9]{18}', value)) {
            throw new ToolingException('Not a record id: ' + value);
        }
        return value;
    }

    /** A flow API name split into its namespace and developer name. */
    public class FlowName {
        public final String namespacePrefix;
        public final String developerName;

        public FlowName(String apiName) {
            if (apiName == null || !Pattern.matches('([A-Za-z][A-Za-z0-9_]*__)?[A-Za-z][A-Za-z0-9_]*', apiName)) {
                throw new ToolingException('Not a flow API name: ' + apiName);
            }
            // API names can't contain "__", so the first one ends the namespace.
            Integer split = apiName.indexOf('__');
            namespacePrefix = split > 0 ? apiName.left(split) : null;
            developerName = split > 0 ? apiName.substring(split + 2) : apiName;
        }

        /**
         * Of records for flows with this developer name, one of the flow this
         * name means. definition names the field holding each record's
         * FlowDefinition, or is null when the records are FlowDefinitions.
         */
        public Map<String, Object> pick(List<Map<String, Object>> records, String definition) {
            // An unqualified name prefers the flow without a namespace, then one in
            // the org's own namespace; never a flow an installed package brought.
            Map<String, Object> fallback;
            for (Map<String, Object> record : records) {
                Map<String, Object> fields = definition == null ? record : (Map<String, Object>) record.get(definition);
                String prefix = (String) fields.get('NamespacePrefix');
                if (namespacePrefix == prefix || (namespacePrefix == null && String.isBlank(prefix))) {
                    return record;
                }
                if (fallback == null && namespacePrefix == null && FlowToolingClient.isOwned(fields)) {
                    fallback = record;
                }
            }
            return fallback;
        }
    }

    /** The API name of a FlowDefinition record: "ns__Name" when it has a namespace. */
    public static String apiNameOf(Map<String, Object> definition) {
        String prefix = (String) definition.get('NamespacePrefix');
        String name = (String) definition.get('DeveloperName');
        return String.isBlank(prefix) ? name : prefix + '__' + name;
    }

    /** Reads a relationship field such as ActiveVersion.VersionNumber. */
    public static Object path(Map<String, Object> record, String dotted) {
        Object current = record;
        for (String part : dotted.split('\\.')) {
            if (!(current instanceof Map<String, Object>)) {
                return null;
            }
            current = ((Map<String, Object>) current).get(part);
        }
        return current;
    }

    public static Integer intPath(Map<String, Object> record, String dotted) {
        Object value = path(record, dotted);
        return value == null ? null : Integer.valueOf(value);
    }
}
