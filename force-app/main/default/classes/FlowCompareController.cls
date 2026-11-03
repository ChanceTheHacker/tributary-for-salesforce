/**
 * Server side of the Tributary app: lists connections, flows and versions,
 * reads version metadata, and saves merged results as a new version or flow.
 *
 * Results are plain DTOs so the components never depend on field names that
 * change with the package namespace.
 */
public with sharing class FlowCompareController {
    public static final String BUILDER_PATH = '/builder_platform_interaction/flowBuilder.app?flowId=';

    public class UserContext {
        @AuraEnabled
        public Id userId;
        @AuraEnabled
        public String userName;
        @AuraEnabled
        public Boolean isAdmin;
        @AuraEnabled
        public Boolean canSave;
        @AuraEnabled
        public Boolean canRequest;
    }

    public class Connection {
        @AuraEnabled
        public String name;
        @AuraEnabled
        public String label;
        @AuraEnabled
        public String description;
        @AuraEnabled
        public Boolean isLocal;
        @AuraEnabled
        public Boolean isProduction;
        @AuraEnabled
        public Boolean canSave;
    }

    public class FlowSummary {
        @AuraEnabled
        public String definitionId;
        @AuraEnabled
        public String apiName;
        @AuraEnabled
        public String label;
        @AuraEnabled
        public String processType;
        @AuraEnabled
        public Integer activeVersion;
        @AuraEnabled
        public Integer latestVersion;
        @AuraEnabled
        public String activeVersionId;
        @AuraEnabled
        public String latestVersionId;
        @AuraEnabled
        public Datetime lastModifiedDate;
        @AuraEnabled
        public String lastModifiedBy;
        @AuraEnabled
        public Boolean managed;
        @AuraEnabled
        public String governanceMode;
        @AuraEnabled
        public String ownerName;
    }

    public class VersionSummary {
        @AuraEnabled
        public String id;
        @AuraEnabled
        public String definitionId;
        @AuraEnabled
        public Integer versionNumber;
        @AuraEnabled
        public String status;
        @AuraEnabled
        public String label;
        @AuraEnabled
        public String processType;
        @AuraEnabled
        public String description;
        @AuraEnabled
        public Decimal apiVersion;
        @AuraEnabled
        public Datetime lastModifiedDate;
        @AuraEnabled
        public String lastModifiedBy;
        @AuraEnabled
        public Datetime createdDate;
        @AuraEnabled
        public String createdBy;
    }

    public class SaveResult {
        @AuraEnabled
        public String versionId;
        @AuraEnabled
        public String definitionId;
        @AuraEnabled
        public String apiName;
        @AuraEnabled
        public Integer versionNumber;
        @AuraEnabled
        public String builderUrl;
        /** When the org saved the version: an activation is checked against it. */
        @AuraEnabled
        public Datetime lastModifiedDate;
        /** SHA-256, in hex, of the metadata saved. */
        @AuraEnabled
        public String candidate;
        /** What was written to the flow's history, receipt and all. */
        @AuraEnabled
        public String receipt;
        /**
         * Why nothing was saved: what changed since the merge was compared.
         * Empty when the version was saved.
         */
        @AuraEnabled
        public List<String> stale = new List<String>();
    }

    /**
     * What was reviewed before saving, sent with every save: the candidate's
     * fingerprint, the sources it was made from and the receipt's text.
     */
    public class SaveReview {
        /**
         * SHA-256, in hex, of the metadata JSON exactly as sent. What's sent
         * is what's saved, draft status and label included.
         */
        public String candidate;
        /** The target flow's latest version when the merge was compared; null when unknown. */
        public Integer latestVersion;
        public List<SaveReviewSource> sources;
        /** Sources, decisions and the checks made before saving, as lines. */
        public String receipt;
    }

    public class SaveReviewSource {
        public String connection;
        public String versionId;
        /** The version's LastModifiedDate when it was compared. */
        public String lastModifiedDate;
        public String label;
    }

    @AuraEnabled(cacheable=true)
    public static UserContext getUserContext() {
        UserContext context = new UserContext();
        context.userId = UserInfo.getUserId();
        context.userName = UserInfo.getName();
        context.isAdmin = FlowGovernanceService.isAdmin();
        context.canSave = FlowGovernanceService.canSave(FlowToolingClient.LOCAL);
        context.canRequest = FlowGovernanceService.canRequest();
        return context;
    }

    @AuraEnabled(cacheable=true)
    public static List<Connection> listConnections() {
        List<Connection> connections = new List<Connection>();
        Connection local = new Connection();
        local.name = FlowToolingClient.LOCAL;
        local.label = 'This org';
        local.isLocal = true;
        Organization org = [SELECT IsSandbox, OrganizationType FROM Organization WITH SYSTEM_MODE LIMIT 1];
        local.isProduction = !org.IsSandbox && org.OrganizationType != 'Developer Edition';
        local.canSave = FlowGovernanceService.canSave(FlowToolingClient.LOCAL);
        connections.add(local);
        List<Flow_Connection__mdt> records = Flow_Connection__mdt.getAll().values();
        List<String> names = new List<String>();
        Map<String, Flow_Connection__mdt> byName = new Map<String, Flow_Connection__mdt>();
        for (Flow_Connection__mdt record : records) {
            names.add(record.MasterLabel.toLowerCase() + '\n' + record.DeveloperName);
            byName.put(record.DeveloperName, record);
        }
        names.sort();
        for (String sortKey : names) {
            Flow_Connection__mdt record = byName.get(sortKey.substringAfter('\n'));
            Connection connection = new Connection();
            connection.name = record.DeveloperName;
            connection.label = record.MasterLabel;
            connection.description = record.Description__c;
            connection.isLocal = false;
            connection.isProduction = record.Is_Production__c;
            connection.canSave = FlowGovernanceService.canSave(record.DeveloperName);
            connections.add(connection);
        }
        return connections;
    }

    @AuraEnabled
    public static List<FlowSummary> listFlows(String connection) {
        try {
            FlowToolingClient client = new FlowToolingClient(connection);
            List<Map<String, Object>> definitions = client.toolingQuery(
                'SELECT Id, DeveloperName, NamespacePrefix, ManageableState, ActiveVersionId, LatestVersionId,' +
                    ' ActiveVersion.VersionNumber, LatestVersion.VersionNumber, LatestVersion.MasterLabel,' +
                    ' LatestVersion.ProcessType, LastModifiedDate, LastModifiedBy.Name' +
                    ' FROM FlowDefinition ORDER BY DeveloperName'
            );
            // Governance is looked up by each flow's own keys, so however many
            // flows are governed, every one listed finds its record.
            Map<String, List<String>> keysByName = new Map<String, List<String>>();
            Set<String> keys = new Set<String>();
            for (Map<String, Object> definition : definitions) {
                String apiName = FlowToolingClient.apiNameOf(definition);
                List<String> flowKeys = FlowGovernanceService.flowKeys(connection, apiName);
                keysByName.put(apiName, flowKeys);
                keys.addAll(flowKeys);
            }
            Map<String, Flow_Governance__c> governed = new Map<String, Flow_Governance__c>();
            for (Flow_Governance__c record : [
                SELECT Flow_Key__c, Mode__c, Owner_User__r.Name
                FROM Flow_Governance__c
                WHERE Flow_Key__c IN :keys
                WITH USER_MODE
            ]) {
                governed.put(record.Flow_Key__c, record);
            }
            List<FlowSummary> flows = new List<FlowSummary>();
            for (Map<String, Object> definition : definitions) {
                FlowSummary flow = new FlowSummary();
                flow.definitionId = (String) definition.get('Id');
                flow.apiName = FlowToolingClient.apiNameOf(definition);
                flow.label = (String) FlowToolingClient.path(definition, 'LatestVersion.MasterLabel');
                if (String.isBlank(flow.label)) {
                    flow.label = flow.apiName;
                }
                flow.processType = (String) FlowToolingClient.path(definition, 'LatestVersion.ProcessType');
                flow.activeVersion = FlowToolingClient.intPath(definition, 'ActiveVersion.VersionNumber');
                flow.latestVersion = FlowToolingClient.intPath(definition, 'LatestVersion.VersionNumber');
                flow.activeVersionId = (String) definition.get('ActiveVersionId');
                flow.latestVersionId = (String) definition.get('LatestVersionId');
                flow.lastModifiedDate = toDatetime(definition.get('LastModifiedDate'));
                flow.lastModifiedBy = (String) FlowToolingClient.path(definition, 'LastModifiedBy.Name');
                // Flows a package installed can't be changed; saving refuses them
                // by the same test.
                flow.managed = !FlowToolingClient.isOwned(definition);
                Flow_Governance__c governance;
                for (String key : keysByName.get(flow.apiName)) {
                    governance = governed.get(key);
                    if (governance != null) {
                        break;
                    }
                }
                if (governance != null) {
                    flow.governanceMode = governance.Mode__c;
                    flow.ownerName = governance.Owner_User__r?.Name;
                }
                flows.add(flow);
            }
            return flows;
        } catch (Exception e) {
            throw auraError(e);
        }
    }

    @AuraEnabled
    public static List<VersionSummary> listVersions(String connection, String definitionId) {
        try {
            FlowToolingClient client = new FlowToolingClient(connection);
            List<VersionSummary> versions = new List<VersionSummary>();
            for (
                Map<String, Object> record : client.toolingQuery(
                    'SELECT Id, DefinitionId, VersionNumber, Status, MasterLabel, ProcessType, Description,' +
                        ' ApiVersion, LastModifiedDate, LastModifiedBy.Name, CreatedDate, CreatedBy.Name' +
                        ' FROM Flow WHERE DefinitionId = \'' +
                        FlowToolingClient.checkId(definitionId) +
                        '\' ORDER BY VersionNumber DESC'
                )
            ) {
                VersionSummary version = new VersionSummary();
                version.id = (String) record.get('Id');
                version.definitionId = (String) record.get('DefinitionId');
                version.versionNumber = FlowToolingClient.intPath(record, 'VersionNumber');
                version.status = (String) record.get('Status');
                version.label = (String) record.get('MasterLabel');
                version.processType = (String) record.get('ProcessType');
                version.description = (String) record.get('Description');
                Object apiVersion = record.get('ApiVersion');
                version.apiVersion = apiVersion == null ? null : Decimal.valueOf(String.valueOf(apiVersion));
                version.lastModifiedDate = toDatetime(record.get('LastModifiedDate'));
                version.lastModifiedBy = (String) FlowToolingClient.path(record, 'LastModifiedBy.Name');
                version.createdDate = toDatetime(record.get('CreatedDate'));
                version.createdBy = (String) FlowToolingClient.path(record, 'CreatedBy.Name');
                versions.add(version);
            }
            return versions;
        } catch (Exception e) {
            throw auraError(e);
        }
    }

    /**
     * The Tooling API record for a flow version, including its Metadata, as
     * JSON. A version's content changes only with its LastModifiedDate, which
     * the caller passes as `modified`, so the browser can keep each answer.
     */
    @AuraEnabled(cacheable=true)
    public static String getVersion(String connection, String versionId, String modified) {
        try {
            return new FlowToolingClient(connection).getFlowJson(versionId);
        } catch (Exception e) {
            throw auraError(e);
        }
    }

    /** A version read by flow name and number, with what it was read as. */
    public class NamedVersion {
        @AuraEnabled
        public String id;
        @AuraEnabled
        public Integer versionNumber;
        @AuraEnabled
        public Datetime lastModifiedDate;
        /** The Tooling API record, as getVersion returns it. */
        @AuraEnabled
        public String record;
    }

    /**
     * A version named as a link names it, read before the flow and version
     * lists arrive. The name resolves as saving resolves it: "ns__Name", or an
     * unqualified name in the org's own namespace. The stamp is read before
     * the record, so an edit in between leaves the record newer than its
     * stamp, never older. The caller uses the record only when the stamp and
     * id match its version list. Null when there's no such version.
     */
    @AuraEnabled(cacheable=true)
    public static NamedVersion getVersionByName(String connection, String apiName, Integer versionNumber) {
        try {
            if (versionNumber == null) {
                return null;
            }
            FlowToolingClient client = new FlowToolingClient(connection);
            FlowToolingClient.FlowName name = new FlowToolingClient.FlowName(apiName);
            // One query finds the flow the name means and its version, as
            // findDefinition would: an unqualified name means the flow without
            // a namespace even when it hasn't this version, so all of that
            // flow's versions come too.
            List<Map<String, Object>> records = client.toolingQuery(
                'SELECT Id, DefinitionId, VersionNumber, LastModifiedDate,' +
                    ' Definition.NamespacePrefix, Definition.ManageableState FROM Flow' +
                    ' WHERE Definition.DeveloperName = \'' +
                    name.developerName +
                    '\' AND ' +
                    (name.namespacePrefix == null
                        ? '(VersionNumber = ' + versionNumber + ' OR Definition.NamespacePrefix = null)'
                        : 'VersionNumber = ' + versionNumber)
            );
            Map<String, Object> meant = name.pick(records, 'Definition');
            if (meant == null) {
                return null;
            }
            for (Map<String, Object> record : records) {
                if (
                    (String) record.get('DefinitionId') == (String) meant.get('DefinitionId') &&
                    FlowToolingClient.intPath(record, 'VersionNumber') == versionNumber
                ) {
                    NamedVersion version = new NamedVersion();
                    version.id = (String) record.get('Id');
                    version.versionNumber = versionNumber;
                    version.lastModifiedDate = toDatetime(record.get('LastModifiedDate'));
                    version.record = client.getFlowJson(version.id);
                    return version;
                }
            }
            return null;
        } catch (Exception e) {
            throw auraError(e);
        }
    }

    /**
     * Saves metadata as a new draft version of an existing flow. Activation is
     * separate, so it goes through the flow's approval rules. The review
     * says what was compared and decided; the save is refused when the
     * metadata isn't what was reviewed, and nothing is saved when a source
     * or the flow itself changed since it was compared.
     */
    @AuraEnabled
    public static SaveResult saveVersion(String connection, String apiName, String metadataJson, String review) {
        String createdId;
        try {
            requireSave(connection);
            Map<String, Object> metadata = draft(metadataJson);
            SaveReview reviewed = reviewOf(review, metadataJson);
            List<String> stale = staleSources(reviewed, connection);
            FlowToolingClient client = new FlowToolingClient(connection);
            new FlowToolingClient.FlowName(apiName);
            SaveResult result;
            for (Integer attempt = 0; result == null; attempt++) {
                Map<String, Object> definition = client.findDefinition(apiName);
                if (definition == null) {
                    throw new FlowToolingClient.ToolingException(
                        'There is no flow named ' + apiName + ' to add a version to.'
                    );
                }
                if (!FlowToolingClient.isOwned(definition)) {
                    throw new FlowToolingClient.ToolingException(
                        'Installed package flows cannot receive merged versions. Save as a new flow instead.'
                    );
                }
                Integer latest = FlowToolingClient.intPath(definition, 'LatestVersion.VersionNumber');
                // A version saved since the merge was compared (a collision
                // included) would be left out of it.
                if (reviewed.latestVersion != null && latest != null && latest > reviewed.latestVersion) {
                    stale.add(
                        'Version ' +
                            latest +
                            ' of ' +
                            apiName +
                            ' was saved after this merge was compared, so saving now would leave its changes out. Compare again with it as one side, or save as a new flow.'
                    );
                }
                if (!stale.isEmpty()) {
                    return refused(stale, reviewed);
                }
                Integer next = (latest == null ? 0 : latest) + 1;
                try {
                    createdId = client.createFlow(FlowToolingClient.apiNameOf(definition) + '-' + next, metadata);
                } catch (FlowToolingClient.ToolingException e) {
                    // Someone saved a version at the same moment; take the next number.
                    if (e.errorCode != 'DUPLICATE_VALUE' || attempt > 0) {
                        throw e;
                    }
                    continue;
                }
                result = saved(client, createdId, apiName, connection);
            }
            result.candidate = reviewed.candidate;
            result.receipt = saveDetails(
                'Saved from Tributary as inactive version ' + result.versionNumber + '. Saving doesn\'t activate it.',
                result,
                reviewed
            );
            FlowGovernanceService.recordSave(connection, result.apiName, result.versionNumber, false, result.receipt);
            return result;
        } catch (Exception e) {
            throw saveError(e, createdId);
        }
    }

    /** Saves metadata as the first version of a new flow, with its review as for saveVersion. */
    @AuraEnabled
    public static SaveResult saveAsNewFlow(
        String connection,
        String apiName,
        String label,
        String metadataJson,
        String review
    ) {
        String createdId;
        try {
            requireSave(connection);
            FlowToolingClient.FlowName name = new FlowToolingClient.FlowName(apiName);
            if (name.namespacePrefix != null) {
                throw new FlowToolingClient.ToolingException('A new flow\'s API name can\'t include a namespace.');
            }
            Map<String, Object> metadata = draft(metadataJson);
            // The label is part of what was reviewed, so it's checked, not set.
            if (String.isNotBlank(label) && !label.equals(metadata.get('label'))) {
                throw new FlowToolingClient.ToolingException(
                    'The new flow\'s label isn\'t the one in the flow that was reviewed, so it wasn\'t saved. Save it from the merge again.'
                );
            }
            SaveReview reviewed = reviewOf(review, metadataJson);
            List<String> stale = staleSources(reviewed, connection);
            if (!stale.isEmpty()) {
                return refused(stale, reviewed);
            }
            FlowToolingClient client = new FlowToolingClient(connection);
            if (client.findDefinition(apiName) != null) {
                throw new FlowToolingClient.ToolingException(
                    'A flow named ' + apiName + ' already exists. Choose another API name.'
                );
            }
            createdId = client.createFlow(apiName, metadata);
            SaveResult result = saved(client, createdId, apiName, connection);
            result.candidate = reviewed.candidate;
            result.receipt = saveDetails(
                'Created from Tributary as a new flow, inactive version ' +
                    result.versionNumber +
                    '. Saving doesn\'t activate it.',
                result,
                reviewed
            );
            FlowGovernanceService.recordSave(connection, result.apiName, result.versionNumber, true, result.receipt);
            return result;
        } catch (Exception e) {
            throw saveError(e, createdId);
        }
    }

    // An API write survives failures in the later readback or local audit DML.
    private static AuraHandledException saveError(Exception error, String createdId) {
        if (createdId == null) {
            return auraError(error);
        }
        return auraError(
            new FlowToolingClient.ToolingException(
                'The org created draft ' +
                    createdId +
                    ', but Tributary could not finish confirming or recording the save. ' +
                    'Check the flow\'s versions and history in the destination org before retrying. ' +
                    error.getMessage()
            )
        );
    }

    /** SHA-256, in hex, of text's UTF-8 bytes: what Tributary computes before saving. */
    public static String fingerprint(String text) {
        return EncodingUtil.convertToHex(Crypto.generateDigest('SHA-256', Blob.valueOf(text)));
    }

    // The review sent with a save. What's saved is what was reviewed, or
    // nothing is.
    private static SaveReview reviewOf(String review, String metadataJson) {
        SaveReview reviewed;
        try {
            reviewed = String.isBlank(review) ? null : (SaveReview) JSON.deserialize(review, SaveReview.class);
        } catch (Exception e) {
            reviewed = null;
        }
        if (reviewed == null || String.isBlank(reviewed.candidate)) {
            throw new FlowToolingClient.ToolingException(
                'The flow was sent without its review, so it wasn\'t saved. Save it from the merge again.'
            );
        }
        reviewed.candidate = reviewed.candidate.toLowerCase();
        if (reviewed.candidate != fingerprint(metadataJson)) {
            throw new FlowToolingClient.ToolingException(
                'The flow sent isn\'t the one that was reviewed, so it wasn\'t saved. Save it from the merge again.'
            );
        }
        if (reviewed.sources == null) {
            reviewed.sources = new List<SaveReviewSource>();
        }
        return reviewed;
    }

    // Sources deleted or changed since they were compared. A draft can be
    // saved over in Flow Builder, so its id alone doesn't say it's the same.
    private static List<String> staleSources(SaveReview reviewed, String saveConnection) {
        Map<String, List<SaveReviewSource>> byConnection = new Map<String, List<SaveReviewSource>>();
        for (SaveReviewSource source : reviewed.sources) {
            if (String.isBlank(source.versionId)) {
                continue;
            }
            FlowToolingClient.checkId(source.versionId);
            String connection = String.isBlank(source.connection) ? saveConnection : source.connection;
            if (!byConnection.containsKey(connection)) {
                byConnection.put(connection, new List<SaveReviewSource>());
            }
            byConnection.get(connection).add(source);
        }
        List<String> stale = new List<String>();
        for (String connection : byConnection.keySet()) {
            List<SaveReviewSource> sources = byConnection.get(connection);
            List<String> ids = new List<String>();
            for (SaveReviewSource source : sources) {
                ids.add('\'' + source.versionId + '\'');
            }
            Map<String, Map<String, Object>> found = new Map<String, Map<String, Object>>();
            for (
                Map<String, Object> record : new FlowToolingClient(connection)
                    .toolingQuery(
                        'SELECT Id, LastModifiedDate, LastModifiedBy.Name FROM Flow WHERE Id IN (' +
                            String.join(ids, ',') +
                            ')'
                    )
            ) {
                found.put(((String) record.get('Id')).left(15), record);
            }
            for (SaveReviewSource source : sources) {
                String label = String.isBlank(source.label) ? source.versionId : source.label;
                Map<String, Object> record = found.get(source.versionId.left(15));
                if (record == null) {
                    stale.add(label + ' no longer exists.');
                    continue;
                }
                Datetime compared = toDatetime(source.lastModifiedDate);
                Datetime now = toDatetime(record.get('LastModifiedDate'));
                if (compared == null || now == null || compared.getTime() != now.getTime()) {
                    String editor = (String) FlowToolingClient.path(record, 'LastModifiedBy.Name');
                    stale.add(
                        label +
                            ' no longer has a verifiable matching modification timestamp' +
                            (String.isBlank(editor) ? '' : ' (last modified by ' + editor + ')') +
                            '. An edit or activation can update this timestamp. Compare again to verify the current version.'
                    );
                }
            }
        }
        return stale;
    }

    private static SaveResult refused(List<String> stale, SaveReview reviewed) {
        SaveResult result = new SaveResult();
        result.stale = stale;
        result.candidate = reviewed.candidate;
        return result;
    }

    private static void requireSave(String connection) {
        if (!FlowGovernanceService.canSave(connection)) {
            throw new FlowGovernanceService.GovernanceException(
                FlowToolingClient.isLocal(connection)
                    ? 'Saving flows needs the Tributary Save permission and Manage Flow.'
                    : 'Saving flows needs the Tributary Save permission.'
            );
        }
        // A connection that reaches this org by another name saves here, so
        // this org's rule applies. Only a user who couldn't save locally is
        // asked, with one callout, made before any DML.
        if (
            !FlowToolingClient.isLocal(connection) &&
            !FlowGovernanceService.canSave(FlowToolingClient.LOCAL) &&
            reachesThisOrg(connection)
        ) {
            throw new FlowGovernanceService.GovernanceException(
                'This connection saves to this org, and saving flows here needs the Tributary Save permission and Manage Flow.'
            );
        }
    }

    // Whether a connection reaches this org. One that can't say isn't used.
    private static Boolean reachesThisOrg(String connection) {
        try {
            return new FlowToolingClient(connection).reachesThisOrg();
        } catch (Exception e) {
            throw new FlowToolingClient.ToolingException(
                'Tributary couldn\'t check which org this connection saves to, so nothing was saved. ' + e.getMessage()
            );
        }
    }

    // The history for a save: what the app did and checked itself, the
    // receipt the reviewer saw, then what the org accepted.
    private static String saveDetails(String action, SaveResult result, SaveReview reviewed) {
        List<String> lines = new List<String>{
            action,
            'Candidate: SHA-256 ' +
            reviewed.candidate +
            ' of the metadata saved, draft status and label included, checked by the org before saving.'
        };
        Integer checked = 0;
        for (SaveReviewSource source : reviewed.sources) {
            if (String.isNotBlank(source.versionId)) {
                checked++;
            }
        }
        if (checked > 0) {
            lines.add(
                'Sources unchanged since they were compared: ' +
                    checked +
                    (checked == 1 ? ' version' : ' versions') +
                    ' checked when saving.'
            );
        }
        String receipt = tidyLines(reviewed.receipt);
        if (String.isNotBlank(receipt)) {
            lines.add(receipt);
        }
        lines.add(
            'Checked by the org: accepted as inactive version ' +
                result.versionNumber +
                '. The org found the metadata valid. That isn\'t proof the flow does what was intended.'
        );
        return String.join(lines, '\n');
    }

    // Each line's spacing tidied and blank lines dropped, kept well inside
    // the history's 32,768 characters.
    private static String tidyLines(String text) {
        if (String.isBlank(text)) {
            return '';
        }
        List<String> lines = new List<String>();
        for (String line : text.split('\n')) {
            String tidy = line.normalizeSpace();
            if (String.isNotBlank(tidy)) {
                lines.add(tidy);
            }
        }
        return String.join(lines, '\n').abbreviate(30000);
    }

    // Parses metadata for saving: always a draft, and never carrying a name.
    // The fingerprint covers what's saved, so metadata that isn't already in
    // that form is refused rather than changed.
    private static Map<String, Object> draft(String metadataJson) {
        if (String.isBlank(metadataJson)) {
            throw new FlowToolingClient.ToolingException('No flow was sent to save.');
        }
        Object parsed;
        try {
            parsed = JSON.deserializeUntyped(metadataJson);
        } catch (Exception e) {
            throw new FlowToolingClient.ToolingException('The flow metadata isn\'t valid JSON.');
        }
        if (!(parsed instanceof Map<String, Object>)) {
            throw new FlowToolingClient.ToolingException('The flow metadata must be a JSON object.');
        }
        Map<String, Object> metadata = (Map<String, Object>) parsed;
        if (metadata.containsKey('Metadata') && metadata.get('Metadata') instanceof Map<String, Object>) {
            metadata = (Map<String, Object>) metadata.get('Metadata');
        }
        if (metadata.containsKey('fullName') || !'Draft'.equals(metadata.get('status'))) {
            throw new FlowToolingClient.ToolingException(
                'The flow wasn\'t sent as a draft without an API name inside, as it\'s saved, so it wasn\'t saved. Save it from the merge again.'
            );
        }
        return metadata;
    }

    private static SaveResult saved(FlowToolingClient client, String versionId, String apiName, String connection) {
        List<Map<String, Object>> records = client.toolingQuery(
            'SELECT Id, DefinitionId, Definition.DeveloperName, Definition.NamespacePrefix, VersionNumber, LastModifiedDate FROM Flow WHERE Id = \'' +
                FlowToolingClient.checkId(versionId) +
                '\''
        );
        SaveResult result = new SaveResult();
        result.versionId = versionId;
        result.apiName = apiName;
        if (!records.isEmpty()) {
            Map<String, Object> definition = (Map<String, Object>) records[0].get('Definition');
            if (definition != null && definition.get('DeveloperName') != null) {
                result.apiName = FlowToolingClient.apiNameOf(definition);
            }
            result.definitionId = (String) records[0].get('DefinitionId');
            result.versionNumber = FlowToolingClient.intPath(records[0], 'VersionNumber');
            result.lastModifiedDate = toDatetime(records[0].get('LastModifiedDate'));
        }
        if (result.versionNumber == null || result.definitionId == null || result.lastModifiedDate == null) {
            throw new FlowToolingClient.ToolingException('The saved version could not be read back completely.');
        }
        result.builderUrl = FlowToolingClient.isLocal(connection) ? BUILDER_PATH + versionId : null;
        return result;
    }

    private static Datetime toDatetime(Object value) {
        if (value == null || String.isBlank(String.valueOf(value))) {
            return null;
        }
        return (Datetime) JSON.deserialize('"' + value + '"', Datetime.class);
    }

    /** Turns any exception into one the components can show. */
    public static AuraHandledException auraError(Exception e) {
        if (e instanceof AuraHandledException) {
            return (AuraHandledException) e;
        }
        String message = e.getMessage();
        if (message != null && message.contains('Unable to find the named credential')) {
            message = 'The Tributary connection isn\'t set up yet. Ask an admin to open Tributary Setup.';
        }
        AuraHandledException error = new AuraHandledException(message);
        error.setMessage(message);
        return error;
    }
}
