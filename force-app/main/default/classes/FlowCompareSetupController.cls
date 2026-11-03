/**
 * Server side of the Tributary Setup page: checks that the app can reach
 * this org and every connected org, fixes the parts of the setup it can, and
 * starts or stops the governance monitor.
 */
public with sharing class FlowCompareSetupController {
    private static final String CREDENTIAL = 'Flow_Tooling_API';
    private static final String PRINCIPAL_NAME = 'AppIdentity';
    private static final List<String> PERMISSION_SETS = new List<String>{ 'Flow_Compare_User', 'Flow_Compare_Admin' };

    /** The credential calls the setup page makes. ConnectApi can't run in tests, so tests replace this. */
    public virtual class CredentialStore extends FlowToolingClient.LocalCredential {
        public virtual void updateNamed(ConnectApi.NamedCredentialInput input) {
            ConnectApi.NamedCredentials.updateNamedCredential(CREDENTIAL, input);
        }
        public virtual void updateExternal(ConnectApi.ExternalCredentialInput input) {
            ConnectApi.NamedCredentials.updateExternalCredential(CREDENTIAL, input);
        }
        public virtual ConnectApi.Credential getCredential() {
            return ConnectApi.NamedCredentials.getCredential(
                CREDENTIAL,
                PRINCIPAL_NAME,
                ConnectApi.CredentialPrincipalType.NamedPrincipal
            );
        }
        public virtual void saveCredential(ConnectApi.CredentialInput input, Boolean exists) {
            if (exists) {
                ConnectApi.NamedCredentials.updateCredential(input);
            } else {
                ConnectApi.NamedCredentials.createCredential(input);
            }
        }
    }

    @TestVisible
    private static CredentialStore store = new CredentialStore();

    public class Status {
        @AuraEnabled
        public Boolean isAdmin;
        @AuraEnabled
        public String orgDomainUrl;
        @AuraEnabled
        public String calloutUrl;
        @AuraEnabled
        public Boolean urlMatches;
        @AuraEnabled
        public String tokenUrl;
        @AuraEnabled
        public Boolean tokenUrlMatches;
        // Salesforce turns callouts off when an app changes the credential's
        // URL, until an admin turns them on again. Null when unknown.
        @AuraEnabled
        public Boolean calloutsEnabled;
        @AuraEnabled
        public String credentialStatus;
        @AuraEnabled
        public String credentialError;
        @AuraEnabled
        public List<PermissionSetInfo> permissionSets;
        @AuraEnabled
        public Boolean notificationType;
        @AuraEnabled
        public FlowGovernanceMonitor.Status monitor;
        @AuraEnabled
        public List<FlowCompareController.Connection> connections;
        @AuraEnabled
        public Integer governedCount;
        @AuraEnabled
        public Integer pendingCount;
        // What a connected org's named credential lists in Allowed Namespaces.
        @AuraEnabled
        public String packageNamespace;
    }

    public class PermissionSetInfo {
        @AuraEnabled
        public Id id;
        @AuraEnabled
        public String name;
        @AuraEnabled
        public String label;
        @AuraEnabled
        public Integer assigned;
        @AuraEnabled
        public Boolean hasPrincipalAccess;
    }

    public class Health {
        @AuraEnabled
        public String connection;
        @AuraEnabled
        public Boolean ok;
        @AuraEnabled
        public String orgId;
        @AuraEnabled
        public String orgName;
        @AuraEnabled
        public Boolean isSandbox;
        @AuraEnabled
        public Boolean flowAccess;
        @AuraEnabled
        public Boolean auditAccess;
        @AuraEnabled
        public String message;
    }

    @AuraEnabled
    public static Status getStatus() {
        try {
            Status status = new Status();
            status.isAdmin = FlowGovernanceService.isAdmin();
            status.orgDomainUrl = Url.getOrgDomainUrl().toExternalForm();
            String principalId;
            try {
                ConnectApi.NamedCredential named = store.getNamed();
                status.calloutUrl = named.calloutUrl;
                status.urlMatches = FlowToolingClient.isThisOrg(named.calloutUrl);
                status.calloutsEnabled = named.calloutStatus == null
                    ? null
                    : named.calloutStatus != ConnectApi.CalloutStatus.Disabled;
                ConnectApi.ExternalCredential external = store.getExternal();
                // Only the token URL of the external credential it uses counts.
                status.tokenUrl = FlowToolingClient.linksLocalCredential(named, external)
                    ? FlowToolingClient.tokenUrlOf(external)
                    : null;
                status.tokenUrlMatches = FlowToolingClient.isThisOrgsTokenUrl(status.tokenUrl);
                for (ConnectApi.ExternalCredentialPrincipal principal : external.principals) {
                    if (principal.principalName == PRINCIPAL_NAME) {
                        status.credentialStatus = String.valueOf(principal.authenticationStatus);
                        principalId = principal.id;
                    }
                }
            } catch (Exception e) {
                status.credentialError = e.getMessage();
            }

            status.permissionSets = new List<PermissionSetInfo>();
            Map<Id, PermissionSetInfo> byId = new Map<Id, PermissionSetInfo>();
            for (PermissionSet permissionSet : [
                SELECT Id, Name, Label
                FROM PermissionSet
                WHERE Name IN :PERMISSION_SETS AND NamespacePrefix = :FlowGovernanceService.NAMESPACE
                WITH SYSTEM_MODE
                ORDER BY Name DESC
            ]) {
                PermissionSetInfo info = new PermissionSetInfo();
                info.id = permissionSet.Id;
                info.name = permissionSet.Name;
                info.label = permissionSet.Label;
                info.assigned = 0;
                info.hasPrincipalAccess = false;
                status.permissionSets.add(info);
                byId.put(permissionSet.Id, info);
            }
            // Counted, not loaded: a permission set can have thousands of users.
            for (AggregateResult row : [
                SELECT PermissionSetId, COUNT(Id) assigned
                FROM PermissionSetAssignment
                WHERE PermissionSetId IN :byId.keySet()
                WITH SYSTEM_MODE
                GROUP BY PermissionSetId
            ]) {
                byId.get((Id) row.get('PermissionSetId')).assigned = (Integer) row.get('assigned');
            }
            if (principalId != null) {
                for (SetupEntityAccess access : [
                    SELECT ParentId
                    FROM SetupEntityAccess
                    WHERE SetupEntityId = :principalId AND ParentId IN :byId.keySet()
                    WITH SYSTEM_MODE
                ]) {
                    byId.get(access.ParentId).hasPrincipalAccess = true;
                }
            }

            status.notificationType = ![
                    SELECT Id
                    FROM CustomNotificationType
                    WHERE DeveloperName = 'Flow_Governance_Alert' AND NamespacePrefix = :FlowGovernanceService.NAMESPACE
                    WITH SYSTEM_MODE
                    LIMIT 1
                ]
                .isEmpty();
            status.monitor = FlowGovernanceMonitor.status();
            status.connections = FlowCompareController.listConnections();
            status.governedCount = [SELECT COUNT() FROM Flow_Governance__c WITH SYSTEM_MODE LIMIT 50000];
            status.pendingCount = [
                SELECT COUNT()
                FROM Flow_Activation_Request__c
                WHERE Status__c = :FlowGovernanceService.PENDING
                WITH SYSTEM_MODE
            ];
            status.packageNamespace = FlowGovernanceService.NAMESPACE;
            return status;
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    /**
     * Calls a connection's org to check it's reachable and the app can read
     * flows and the audit trail. The three calls go out together, in a
     * Continuation, and checked() reads the answers.
     */
    @AuraEnabled(continuation=true)
    public static Object testConnection(String connection) {
        FlowToolingClient client;
        try {
            client = new FlowToolingClient(connection);
        } catch (Exception e) {
            Health health = newHealth(connection);
            health.message = explain(connection, e.getMessage());
            return health;
        }
        Continuation checks = new Continuation(120);
        checks.continuationMethod = 'checked';
        // The connection, then each call's label: org, flows, audit trail.
        checks.state = new List<String>{
            client.connection,
            checks.addHttpRequest(client.queryRequest('SELECT Id, Name, IsSandbox FROM Organization', false)),
            checks.addHttpRequest(client.queryRequest('SELECT Id FROM FlowDefinition LIMIT 1', true)),
            checks.addHttpRequest(client.queryRequest('SELECT Id FROM SetupAuditTrail LIMIT 1', false))
        };
        return checks;
    }

    /** testConnection's answers, as its Health. */
    @AuraEnabled
    public static Object checked(List<String> labels, Object state) {
        List<Object> sent = (List<Object>) state;
        return healthOf(
            (String) sent[0],
            Continuation.getResponse((String) sent[1]),
            Continuation.getResponse((String) sent[2]),
            Continuation.getResponse((String) sent[3])
        );
    }

    private static Health healthOf(String connection, HttpResponse org, HttpResponse flows, HttpResponse audit) {
        Health health = newHealth(connection);
        try {
            Map<String, Object> record = FlowToolingClient.records(org)[0];
            health.orgId = (String) record.get('Id');
            health.orgName = (String) record.get('Name');
            health.isSandbox = (Boolean) record.get('IsSandbox');
        } catch (Exception e) {
            health.message = explain(connection, e.getMessage());
            return health;
        }
        // Saves, governance and history take "local" to be this org.
        if (
            FlowToolingClient.isLocal(connection) &&
            !FlowToolingClient.sameOrg(health.orgId, UserInfo.getOrganizationId())
        ) {
            health.message =
                'The Flow Tooling API credential signs in to ' +
                health.orgName +
                ' (' +
                health.orgId +
                '), not this org, so Tributary won\'t use it. Point it at this org and store this org\'s consumer key and secret.';
            return health;
        }
        List<String> problems = new List<String>();
        try {
            FlowToolingClient.records(flows);
            health.flowAccess = true;
        } catch (Exception e) {
            problems.add('It can\'t read flows: ' + e.getMessage());
        }
        try {
            FlowToolingClient.records(audit);
            health.auditAccess = true;
        } catch (Exception e) {
            problems.add(
                'It can\'t read the Setup Audit Trail, so it can\'t tell who activated a flow: ' + e.getMessage()
            );
        }
        health.ok = health.flowAccess;
        health.message = problems.isEmpty() ? null : String.join(problems, ' ');
        return health;
    }

    private static Health newHealth(String connection) {
        Health health = new Health();
        health.connection = FlowToolingClient.normalizeConnection(connection);
        health.ok = false;
        health.flowAccess = false;
        health.auditAccess = false;
        return health;
    }

    /**
     * The user a connection signs in as, or null when its org won't say. The
     * page asks once the checks are back, so they don't wait on it.
     */
    @AuraEnabled
    public static String connectionUser(String connection) {
        try {
            return (String) new FlowToolingClient(connection)
                .getJson('/services/oauth2/userinfo')
                .get('preferred_username');
        } catch (Exception e) {
            return null;
        }
    }

    @TestVisible
    private static String explain(String connection, String message) {
        if (message == null) {
            return 'The connection failed.';
        }
        if (message.contains('couldn\'t access the credential') || message.contains('principal')) {
            if (FlowToolingClient.isLocal(connection)) {
                return message +
                    ' Grant the Tributary permission sets access to the Flow Tooling API credential below.';
            }
            // The packaged permission sets can't be edited in an installed
            // package, so another org's principal goes in a set of the org's own.
            return message +
                ' Give its users a permission set of your own with access to this connection\'s principal, assigned' +
                ' alongside Tributary User or Tributary Admin, and list ' +
                (FlowGovernanceService.NAMESPACE == null ? 'Tributary\'s namespace' : FlowGovernanceService.NAMESPACE) +
                ' in the named credential\'s Allowed Namespaces.';
        }
        if (message.contains('Unable to find the named credential')) {
            return 'The named credential for this connection doesn\'t exist.';
        }
        if (message.contains('invalid_client') || message.contains('invalid_grant') || message.contains('OAuth')) {
            return message +
                ' Check the consumer key and secret, and that the app\'s client credentials flow has a Run As user.';
        }
        return message;
    }

    /** Points the Flow Tooling API credential at this org's My Domain. */
    @AuraEnabled
    public static Status pointToThisOrg() {
        try {
            FlowGovernanceService.requireAdmin();
            String domain = Url.getOrgDomainUrl().toExternalForm();
            ConnectApi.NamedCredential current = store.getNamed();
            ConnectApi.ExternalCredential external = store.getExternal();
            ConnectApi.NamedCredentialInput named = new ConnectApi.NamedCredentialInput();
            named.developerName = current.developerName;
            named.masterLabel = current.masterLabel;
            named.type = current.type;
            named.calloutUrl = domain;
            ConnectApi.ExternalCredentialInput link = new ConnectApi.ExternalCredentialInput();
            // Linked back to the package's own external credential, whatever
            // it was linked to, since that's the one given this org's token URL.
            link.developerName = external.developerName;
            named.externalCredentials = new List<ConnectApi.ExternalCredentialInput>{ link };
            ConnectApi.NamedCredentialCalloutOptionsInput options = new ConnectApi.NamedCredentialCalloutOptionsInput();
            options.generateAuthorizationHeader = true;
            options.allowMergeFieldsInHeader = false;
            options.allowMergeFieldsInBody = false;
            named.calloutOptions = options;
            // An update replaces the parameters, so keep the ones it doesn't
            // set, such as the packaged ManagedByNamespace flag that lets the
            // subscriber's org repoint this credential at all.
            named.parameters = new List<ConnectApi.NamedCredentialParameterInput>();
            for (
                ConnectApi.NamedCredentialParameter parameter : current.parameters == null
                    ? new List<ConnectApi.NamedCredentialParameter>()
                    : current.parameters
            ) {
                ConnectApi.NamedCredentialParameterInput kept = new ConnectApi.NamedCredentialParameterInput();
                kept.parameterName = parameter.parameterName;
                kept.parameterType = parameter.parameterType;
                kept.parameterValue = parameter.parameterValue;
                named.parameters.add(kept);
            }
            store.updateNamed(named);

            ConnectApi.ExternalCredentialInput changes = new ConnectApi.ExternalCredentialInput();
            changes.developerName = external.developerName;
            changes.masterLabel = external.masterLabel;
            changes.authenticationProtocol = external.authenticationProtocol;
            changes.authenticationProtocolVariant = external.authenticationProtocolVariant;
            ConnectApi.ExternalCredentialParameterInput tokenUrl = new ConnectApi.ExternalCredentialParameterInput();
            tokenUrl.parameterName = 'AuthProviderUrl';
            tokenUrl.parameterType = ConnectApi.ExternalCredentialParameterType.AuthProviderUrl;
            tokenUrl.parameterValue = domain + '/services/oauth2/token';
            changes.parameters = new List<ConnectApi.ExternalCredentialParameterInput>{ tokenUrl };
            List<ConnectApi.ExternalCredentialPrincipalInput> principals = new List<ConnectApi.ExternalCredentialPrincipalInput>();
            for (ConnectApi.ExternalCredentialPrincipal principal : external.principals) {
                ConnectApi.ExternalCredentialPrincipalInput input = new ConnectApi.ExternalCredentialPrincipalInput();
                input.principalName = principal.principalName;
                input.principalType = principal.principalType;
                input.sequenceNumber = principal.sequenceNumber;
                principals.add(input);
            }
            changes.principals = principals;
            store.updateExternal(changes);
            return getStatus();
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    /** Stores the connected app's consumer key and secret for the app's own org. */
    @AuraEnabled
    public static Status saveClientCredentials(String clientId, String clientSecret) {
        try {
            FlowGovernanceService.requireAdmin();
            if (String.isBlank(clientId) || String.isBlank(clientSecret)) {
                throw new FlowGovernanceService.GovernanceException(
                    'Enter both the consumer key and the consumer secret.'
                );
            }
            // The secret is sent to the token URL whenever the app signs in,
            // so it's only stored while that is this org's own.
            ConnectApi.NamedCredential named = store.getNamed();
            if (!FlowToolingClient.isThisOrg(named.calloutUrl)) {
                throw new FlowGovernanceService.GovernanceException(
                    'The Flow Tooling API credential calls ' +
                        named.calloutUrl +
                        ', not this org. Point it at this org before storing the key and secret.'
                );
            }
            ConnectApi.ExternalCredential external = store.getExternal();
            String tokenUrl = FlowToolingClient.linksLocalCredential(named, external)
                ? FlowToolingClient.tokenUrlOf(external)
                : null;
            if (!FlowToolingClient.isThisOrgsTokenUrl(tokenUrl)) {
                throw new FlowGovernanceService.GovernanceException(
                    'The Flow Tooling API credential doesn\'t sign in at this org\'s own token URL' +
                        (String.isBlank(tokenUrl) ? '' : ' (it uses ' + tokenUrl + ')') +
                        '. Point it at this org before storing the key and secret, so the secret is only ever sent to this org.'
                );
            }
            ConnectApi.CredentialInput input = new ConnectApi.CredentialInput();
            input.externalCredential = CREDENTIAL;
            input.principalName = PRINCIPAL_NAME;
            input.principalType = ConnectApi.CredentialPrincipalType.NamedPrincipal;
            input.authenticationProtocol = ConnectApi.CredentialAuthenticationProtocol.Oauth;
            input.authenticationProtocolVariant = ConnectApi.CredentialAuthenticationProtocolVariant.ClientCredentialsClientSecret;
            input.credentials = new Map<String, ConnectApi.CredentialValueInput>{
                'clientId' => secret(clientId.trim(), false),
                'clientSecret' => secret(clientSecret.trim(), true)
            };
            ConnectApi.Credential existing;
            try {
                existing = store.getCredential();
            } catch (Exception e) {
                existing = null;
            }
            store.saveCredential(
                input,
                existing != null && existing.credentials != null && !existing.credentials.isEmpty()
            );
            return getStatus();
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    private static ConnectApi.CredentialValueInput secret(String value, Boolean encrypted) {
        ConnectApi.CredentialValueInput input = new ConnectApi.CredentialValueInput();
        input.value = value;
        input.encrypted = encrypted;
        return input;
    }

    /** Lets both Tributary permission sets use the Flow Tooling API credential. */
    @AuraEnabled
    public static Status grantPrincipalAccess() {
        try {
            FlowGovernanceService.requireAdmin();
            String principalId;
            for (ConnectApi.ExternalCredentialPrincipal principal : store.getExternal().principals) {
                if (principal.principalName == PRINCIPAL_NAME) {
                    principalId = principal.id;
                }
            }
            if (principalId == null) {
                throw new FlowGovernanceService.GovernanceException(
                    'The Flow Tooling API credential has no AppIdentity principal.'
                );
            }
            Set<Id> granted = new Set<Id>();
            for (SetupEntityAccess access : [
                SELECT ParentId
                FROM SetupEntityAccess
                WHERE SetupEntityId = :principalId
                WITH SYSTEM_MODE
            ]) {
                granted.add(access.ParentId);
            }
            List<SetupEntityAccess> grants = new List<SetupEntityAccess>();
            for (PermissionSet permissionSet : [
                SELECT Id
                FROM PermissionSet
                WHERE Name IN :PERMISSION_SETS AND NamespacePrefix = :FlowGovernanceService.NAMESPACE
                WITH SYSTEM_MODE
            ]) {
                if (!granted.contains(permissionSet.Id)) {
                    grants.add(new SetupEntityAccess(ParentId = permissionSet.Id, SetupEntityId = principalId));
                }
            }
            if (!grants.isEmpty() && permissionSetsInstalled()) {
                // They ship with this grant, and an installed package's
                // permission sets can't be changed in the org.
                throw new FlowGovernanceService.GovernanceException(
                    'The Tributary permission sets come with access to the Flow Tooling API credential, and as part of' +
                    ' an installed package they can\'t be changed here. Reinstall or upgrade Tributary to restore it.'
                );
            }
            if (!grants.isEmpty()) {
                insert as system grants;
            }
            return getStatus();
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    // Whether the permission sets came with an installed package: they carry
    // its namespace, which isn't this org's own. Tests set it.
    @TestVisible
    private static Boolean installedSets;

    private static Boolean permissionSetsInstalled() {
        if (installedSets == null) {
            String prefix = [SELECT NamespacePrefix FROM Organization WITH SYSTEM_MODE LIMIT 1].NamespacePrefix;
            installedSets = FlowGovernanceService.NAMESPACE != null && FlowGovernanceService.NAMESPACE != prefix;
        }
        return installedSets;
    }

    @AuraEnabled
    public static Status startMonitor(Integer intervalMinutes) {
        try {
            FlowGovernanceMonitor.start(intervalMinutes);
            return getStatus();
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    @AuraEnabled
    public static Status stopMonitor() {
        try {
            FlowGovernanceMonitor.stop();
            return getStatus();
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }
}
