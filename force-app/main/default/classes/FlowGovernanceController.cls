/**
 * Server side of the Approvals and Governed Flows pages, and of the Request
 * Activation action in Tributary.
 */
public with sharing class FlowGovernanceController {
    // What a list reads of a request. Its long text is REQUEST_TEXT, which
    // pages cut to PREVIEW_LENGTH characters; a request read alone has it all.
    private static final String REQUEST_SUMMARY =
        'Id, Name, Flow_Api_Name__c, Flow_Label__c, Connection__c, Version_Number__c, Flow_Version_Id__c,' +
        ' Status__c, Approver__r.Name, Decided_By__r.Name, Decided_At__c, Compared_Version__c, Replaces_Version__c,' +
        ' Reviewed_At__c, Governance__c, CreatedById, CreatedBy.Name, CreatedDate';
    private static final String REQUEST_TEXT = 'Request_Comments__c, Decision_Comments__c, Change_Summary__c, Error__c';
    private static final Integer PREVIEW_LENGTH = 1000;
    private static final Integer REQUEST_PAGE = 25;
    private static final Integer MAX_PAGE = 100;
    // Newest first; Id breaks ties, since many rows can share a second.
    private static final String NEWEST_FIRST = ' ORDER BY CreatedDate DESC, Id DESC';
    private static final String BEFORE_CURSOR = '(CreatedDate < :beforeDate OR (CreatedDate = :beforeDate AND Id < :beforeId))';

    private enum RequestText {
        NONE,
        PREVIEW,
        ALL
    }

    public class Governance {
        @AuraEnabled
        public Id id;
        @AuraEnabled
        public String label;
        @AuraEnabled
        public String apiName;
        @AuraEnabled
        public String connection;
        @AuraEnabled
        public Id ownerId;
        @AuraEnabled
        public String ownerName;
        @AuraEnabled
        public String mode;
        @AuraEnabled
        public Integer approvedVersion;
        @AuraEnabled
        public Integer activeVersion;
        @AuraEnabled
        public Datetime lastChecked;
        @AuraEnabled
        public String lastCheckOutcome;
        @AuraEnabled
        public String lastCheckMessage;
        @AuraEnabled
        public Boolean isOwner;
    }

    public class FlowStatus {
        @AuraEnabled
        public Governance governance;
        @AuraEnabled
        public Boolean canActivate;
        @AuraEnabled
        public Boolean canRequest;
        @AuraEnabled
        public Boolean canGovern;
        @AuraEnabled
        public List<Request> pending;
        @AuraEnabled
        public FlowGovernanceMonitor.Status monitor;
    }

    public class Request {
        @AuraEnabled
        public Id operationId;
        @AuraEnabled
        public Id id;
        @AuraEnabled
        public String name;
        @AuraEnabled
        public String apiName;
        @AuraEnabled
        public String label;
        @AuraEnabled
        public String connection;
        @AuraEnabled
        public Integer versionNumber;
        @AuraEnabled
        public String versionId;
        @AuraEnabled
        public String status;
        @AuraEnabled
        public String requestedBy;
        @AuraEnabled
        public Id requestedById;
        @AuraEnabled
        public Datetime requestedAt;
        @AuraEnabled
        public String approverName;
        @AuraEnabled
        public String decidedBy;
        @AuraEnabled
        public Datetime decidedAt;
        @AuraEnabled
        public String comments;
        @AuraEnabled
        public String decisionComments;
        @AuraEnabled
        public String changeSummary;
        /** The version of the same flow the change summary compares with. */
        @AuraEnabled
        public Integer comparedVersion;
        /** The version that was active when this was requested (0 for none). */
        @AuraEnabled
        public Integer replacesVersion;
        /** When the version was saved from the merge the summary describes; approving refuses one changed since. */
        @AuraEnabled
        public Datetime reviewedAt;
        @AuraEnabled
        public String error;
        @AuraEnabled
        public Boolean canDecide;
        @AuraEnabled
        public Boolean canCancel;
        /** Deciding would be a Tributary admin acting in place of the flow's owner. */
        @AuraEnabled
        public Boolean overrides;
        /** A list cut some of its text short; getRequest has all of it. */
        @AuraEnabled
        public Boolean truncated;
        // Whether it's the user's to decide, as the owner or in place of none,
        // whatever its status: 'mine' is these. Not sent or stored.
        public transient Boolean decides;
    }

    /** Requests a page at a time, newest first. */
    public class RequestPage {
        @AuraEnabled
        public List<Request> requests;
        /** The last request this page read, to start the next one before; null when there are no more. */
        @AuraEnabled
        public Datetime nextBefore;
        @AuraEnabled
        public Id nextBeforeId;
    }

    public class AuditEvent {
        @AuraEnabled
        public Id id;
        @AuraEnabled
        public String name;
        @AuraEnabled
        public String type;
        @AuraEnabled
        public String apiName;
        @AuraEnabled
        public String connection;
        @AuraEnabled
        public Integer versionNumber;
        @AuraEnabled
        public Integer previousVersion;
        @AuraEnabled
        public String actor;
        @AuraEnabled
        public String details;
        @AuraEnabled
        public Id requestId;
        @AuraEnabled
        public Datetime createdDate;
    }

    public class CheckResult {
        @AuraEnabled
        public Id operationId;
        @AuraEnabled
        public Id governanceId;
        @AuraEnabled
        public String apiName;
        @AuraEnabled
        public String connection;
        @AuraEnabled
        public String outcome;
        @AuraEnabled
        public Integer activeVersion;
        @AuraEnabled
        public Integer approvedVersion;
        @AuraEnabled
        public String message;
    }

    /** Governance, permissions and pending requests for one flow. */
    @AuraEnabled
    public static FlowStatus getFlowStatus(String connection, String apiName) {
        try {
            FlowStatus status = new FlowStatus();
            Flow_Governance__c record = FlowGovernanceService.findGovernance(connection, apiName);
            status.governance = record == null ? null : visible(record.Id);
            status.canActivate = FlowGovernanceService.canApprove(connection, record);
            status.canRequest = FlowGovernanceService.canRequest();
            status.canGovern = FlowGovernanceService.isAdmin();
            status.monitor = record == null ? null : monitorStatus();
            status.pending = new List<Request>();
            if (!Schema.sObjectType.Flow_Activation_Request__c.isAccessible()) {
                return status;
            }
            // Activation cards name each pending version and who asked; they
            // don't show its text, so it isn't read.
            List<String> names = FlowGovernanceService.flowNames(connection, apiName);
            status.pending = toRequests(
                [
                    SELECT
                        Id,
                        Name,
                        Flow_Api_Name__c,
                        Flow_Label__c,
                        Connection__c,
                        Version_Number__c,
                        Flow_Version_Id__c,
                        Status__c,
                        Approver__r.Name,
                        Decided_By__r.Name,
                        Decided_At__c,
                        Compared_Version__c,
                        Replaces_Version__c,
                        Reviewed_At__c,
                        Governance__c,
                        CreatedById,
                        CreatedBy.Name,
                        CreatedDate
                    FROM Flow_Activation_Request__c
                    WHERE
                        Flow_Api_Name__c IN :names
                        AND Connection__c = :stored(connection)
                        AND Status__c = :FlowGovernanceService.PENDING
                    WITH USER_MODE
                    ORDER BY CreatedDate DESC
                    LIMIT 50
                ],
                RequestText.NONE
            );
            return status;
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    /** Whether governed flows are checked on a schedule, for the Governed Flows page. */
    @AuraEnabled
    public static FlowGovernanceMonitor.Status getMonitor() {
        try {
            return monitorStatus();
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    // Anyone may see whether checks run; who they run as and why one failed
    // are for admins.
    private static FlowGovernanceMonitor.Status monitorStatus() {
        FlowGovernanceMonitor.Status monitor = FlowGovernanceMonitor.status();
        if (!FlowGovernanceService.isAdmin()) {
            monitor.runningAs = null;
            monitor.lastError = null;
        }
        return monitor;
    }

    @AuraEnabled
    public static List<Governance> listGoverned() {
        List<Governance> result = new List<Governance>();
        for (Flow_Governance__c record : [
            SELECT
                Id,
                Name,
                Flow_Api_Name__c,
                Connection__c,
                Owner_User__c,
                Owner_User__r.Name,
                Mode__c,
                Approved_Version__c,
                Active_Version__c,
                Last_Checked__c,
                Last_Check_Outcome__c,
                Last_Check_Message__c
            FROM Flow_Governance__c
            WITH USER_MODE
            ORDER BY Name
            LIMIT 2000
        ]) {
            result.add(toGovernance(record));
        }
        return result;
    }

    @AuraEnabled
    public static Governance saveGovernance(
        Id id,
        String connection,
        String apiName,
        String label,
        Id ownerId,
        String mode
    ) {
        try {
            FlowGovernanceService.GovernanceInput input = new FlowGovernanceService.GovernanceInput();
            input.id = id;
            input.connection = connection;
            input.apiName = apiName;
            input.label = label;
            input.ownerId = ownerId;
            input.mode = mode;
            return visible(FlowGovernanceService.saveGovernance(input).Id);
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    @AuraEnabled
    public static void removeGovernance(Id id) {
        try {
            FlowGovernanceService.removeGovernance(id);
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    /**
     * Scope: 'mine' (the user's to decide), 'submitted' (made by me) or 'all'. Status blank means any,
     * so 'mine' with Pending is what awaits the user's decision. Requests an admin could only decide
     * in place of their owner are left out of 'mine'. The newest 500, with all their text.
     */
    @AuraEnabled
    public static List<Request> listRequests(String scope, String status) {
        try {
            return findRequests(scope, status, null, null, 500, RequestText.ALL).requests;
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    /**
     * listRequests a page at a time, for the Approvals page: from before beforeDate and beforeId,
     * the page's nextBefore and nextBeforeId, when given. Comments, summaries and errors are cut
     * short and marked truncated; getRequest reads a request in full.
     */
    @AuraEnabled
    public static RequestPage listRequestPage(
        String scope,
        String status,
        Datetime beforeDate,
        Id beforeId,
        Integer pageSize
    ) {
        try {
            Integer rows = pageSize == null || pageSize < 1 || pageSize > MAX_PAGE ? REQUEST_PAGE : pageSize;
            return findRequests(scope, status, beforeDate, beforeId, rows, RequestText.PREVIEW);
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    /**
     * One request in full, whatever its status or age, as the user may see it: the one a
     * notification links to, or one whose text a list cut short.
     */
    @AuraEnabled
    public static Request getRequest(Id requestId) {
        try {
            List<Flow_Activation_Request__c> records;
            try {
                records = Database.queryWithBinds(
                    'SELECT ' +
                        REQUEST_SUMMARY +
                        ', ' +
                        REQUEST_TEXT +
                        ' FROM Flow_Activation_Request__c' +
                        ' WHERE Id = :requestId',
                    new Map<String, Object>{ 'requestId' => requestId },
                    AccessLevel.USER_MODE
                );
            } catch (QueryException e) {
                records = new List<Flow_Activation_Request__c>();
            }
            if (records.isEmpty()) {
                throw new FlowGovernanceService.GovernanceException(
                    'That activation request isn\'t there any more, or you don\'t have access to it.'
                );
            }
            return toRequests(records, RequestText.ALL)[0];
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    private static RequestPage findRequests(
        String scope,
        String status,
        Datetime beforeDate,
        Id beforeId,
        Integer rows,
        RequestText text
    ) {
        Id me = UserInfo.getUserId();
        String soql =
            'SELECT ' +
            REQUEST_SUMMARY +
            (text == RequestText.NONE ? '' : ', ' + REQUEST_TEXT) +
            ' FROM Flow_Activation_Request__c';
        List<String> filters = new List<String>();
        Map<String, Object> bindings = new Map<String, Object>{
            'status' => status,
            'me' => me,
            'beforeDate' => beforeDate,
            'beforeId' => beforeId
        };
        if (scope == 'mine') {
            filters.add(FlowGovernanceService.isAdmin() ? unoverriddenFilter(bindings) : decisionFilter(bindings));
        }
        if (String.isNotBlank(status)) {
            filters.add('Status__c = :status');
        }
        if (scope == 'submitted') {
            filters.add('CreatedById = :me');
        }
        if (beforeDate != null && beforeId != null) {
            filters.add(BEFORE_CURSOR);
        }
        if (!filters.isEmpty()) {
            soql += ' WHERE ' + String.join(filters, ' AND ');
        }
        // One more than a page says whether there's another.
        soql += NEWEST_FIRST + ' LIMIT ' + (rows + 1);
        List<Flow_Activation_Request__c> records = Database.queryWithBinds(soql, bindings, AccessLevel.USER_MODE);
        RequestPage page = new RequestPage();
        if (records.size() > rows) {
            records.remove(rows);
            page.nextBefore = records[rows - 1].CreatedDate;
            page.nextBeforeId = records[rows - 1].Id;
        }
        page.requests = new List<Request>();
        for (Request request : toRequests(records, text)) {
            if (scope != 'mine' || request.decides) {
                page.requests.add(request);
            }
        }
        return page;
    }

    // An admin may decide on any request, but 'mine' leaves out those they'd
    // decide in the owner's place, before LIMIT as for everyone else, so older
    // requests that are theirs aren't lost behind newer ones that aren't. Each
    // request is matched to governance as toRequests matches it: by its link,
    // or when it has none, by its name or the name's alias in this org.
    private static String unoverriddenFilter(Map<String, Object> bindings) {
        Id me = UserInfo.getUserId();
        Map<String, Flow_Governance__c> byKey = new Map<String, Flow_Governance__c>();
        Set<Id> overridden = new Set<Id>();
        for (Flow_Governance__c record : FlowGovernanceService.allGovernance()) {
            byKey.put(record.Flow_Key__c, record);
            if (FlowGovernanceService.overridesOwner(record, me)) {
                overridden.add(record.Id);
            }
        }
        Map<String, Set<String>> overriddenNames = new Map<String, Set<String>>();
        for (Flow_Governance__c record : byKey.values()) {
            String connection = FlowToolingClient.normalizeConnection(record.Connection__c);
            for (String name : FlowGovernanceService.flowNames(connection, record.Flow_Api_Name__c)) {
                Flow_Governance__c current;
                for (String key : FlowGovernanceService.flowKeys(connection, name)) {
                    if (current == null)
                        current = byKey.get(key);
                }
                if (current != null && overridden.contains(current.Id)) {
                    if (!overriddenNames.containsKey(connection))
                        overriddenNames.put(connection, new Set<String>());
                    overriddenNames.get(connection).add(name);
                }
            }
        }
        bindings.put('overridden', overridden);
        List<String> unlinked = new List<String>{ 'Governance__c = null' };
        for (String connection : overriddenNames.keySet()) {
            String suffix = String.valueOf(unlinked.size());
            bindings.put('overriddenConnection' + suffix, stored(connection));
            bindings.put('overriddenNames' + suffix, overriddenNames.get(connection));
            unlinked.add(
                '(Connection__c != :overriddenConnection' +
                    suffix +
                    ' OR Flow_Api_Name__c NOT IN :overriddenNames' +
                    suffix +
                    ')'
            );
        }
        return '((Governance__c != null AND Governance__c NOT IN :overridden) OR (' +
            String.join(unlinked, ' AND ') +
            '))';
    }

    // Apply decision scope before LIMIT: unrelated recent requests cannot hide mine.
    private static String decisionFilter(Map<String, Object> bindings) {
        Boolean localSave = FlowGovernanceService.canSave('local');
        Map<String, Set<String>> allowed = new Map<String, Set<String>>();
        Set<String> blockedLocal = new Set<String>();
        String home = [SELECT NamespacePrefix FROM Organization WITH SYSTEM_MODE LIMIT 1].NamespacePrefix;
        for (Flow_Governance__c record : FlowGovernanceService.allGovernance()) {
            String connection = FlowToolingClient.normalizeConnection(record.Connection__c);
            Set<String> names = new Set<String>{ record.Flow_Api_Name__c };
            if (connection == 'local' && String.isNotBlank(home)) {
                FlowToolingClient.FlowName name = new FlowToolingClient.FlowName(record.Flow_Api_Name__c);
                if (name.namespacePrefix == home)
                    names.add(name.developerName);
                else if (name.namespacePrefix == null)
                    names.add(home + '__' + name.developerName);
            }
            if (FlowGovernanceService.canApprove(connection, record)) {
                if (!allowed.containsKey(connection))
                    allowed.put(connection, new Set<String>());
                allowed.get(connection).addAll(names);
            } else if (connection == 'local') {
                blockedLocal.addAll(names);
            }
        }
        List<String> clauses = new List<String>();
        if (localSave) {
            bindings.put('blockedLocal', blockedLocal);
            clauses.add('(Connection__c = null AND Flow_Api_Name__c NOT IN :blockedLocal)');
        }
        for (String connection : allowed.keySet()) {
            if (localSave && connection == 'local')
                continue;
            String suffix = String.valueOf(clauses.size());
            bindings.put('connection' + suffix, stored(connection));
            bindings.put('names' + suffix, allowed.get(connection));
            clauses.add('(Connection__c = :connection' + suffix + ' AND Flow_Api_Name__c IN :names' + suffix + ')');
        }
        return clauses.isEmpty() ? 'Id = null' : '(' + String.join(clauses, ' OR ') + ')';
    }

    @AuraEnabled
    public static Request requestActivation(
        String connection,
        String apiName,
        String label,
        Integer versionNumber,
        String versionId,
        String comments,
        String changeSummary,
        Integer comparedVersion,
        Datetime reviewedAt,
        Integer replacesVersion
    ) {
        try {
            FlowGovernanceService.RequestInput input = new FlowGovernanceService.RequestInput();
            input.connection = connection;
            input.apiName = apiName;
            input.label = label;
            input.versionNumber = versionNumber;
            input.versionId = versionId;
            input.comments = comments;
            input.changeSummary = changeSummary;
            input.comparedVersion = comparedVersion;
            input.reviewedAt = reviewedAt;
            input.replacesVersion = replacesVersion;
            return load(FlowGovernanceService.requestActivation(input));
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    /** Activates a version now, for the flow's owner or an admin; recorded as a request decided at once. */
    @AuraEnabled
    public static Request activateVersion(
        String connection,
        String apiName,
        String label,
        Integer versionNumber,
        String versionId,
        String comments,
        String changeSummary,
        Integer comparedVersion,
        Datetime reviewedAt,
        Integer replacesVersion
    ) {
        try {
            FlowGovernanceService.RequestInput input = new FlowGovernanceService.RequestInput();
            input.connection = connection;
            input.apiName = apiName;
            input.label = label;
            input.versionNumber = versionNumber;
            input.versionId = versionId;
            input.comments = comments;
            input.changeSummary = changeSummary;
            input.comparedVersion = comparedVersion;
            input.reviewedAt = reviewedAt;
            input.replacesVersion = replacesVersion;
            Request queued = new Request();
            queued.operationId = FlowGovernanceOperation.activate(input);
            queued.status = 'Queued';
            return queued;
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    @AuraEnabled
    public static Request approveRequest(Id requestId, String comments) {
        try {
            Request queued = new Request();
            queued.operationId = FlowGovernanceOperation.approve(requestId, comments);
            queued.status = 'Queued';
            return queued;
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    @AuraEnabled
    public static Request rejectRequest(Id requestId, String comments) {
        try {
            return load(FlowGovernanceService.reject(requestId, comments));
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    @AuraEnabled
    public static Request cancelRequest(Id requestId) {
        try {
            return load(FlowGovernanceService.cancel(requestId));
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    /** Audit history, newest first; for one flow when apiName is given. */
    @AuraEnabled
    public static List<AuditEvent> listAuditEvents(String connection, String apiName, Integer maxRows) {
        try {
            Integer rows = maxRows == null || maxRows < 1 || maxRows > 2000 ? 200 : maxRows;
            return findEvents(connection, apiName, null, null, rows);
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    /**
     * Audit history a page at a time, newest first: from before the event with
     * beforeDate and beforeId, the last one shown, when given. Asking for one
     * more than a page says whether there's another.
     */
    @AuraEnabled
    public static List<AuditEvent> listAuditEventsBefore(
        String connection,
        String apiName,
        Datetime beforeDate,
        Id beforeId,
        Integer pageSize
    ) {
        try {
            Integer rows = pageSize == null || pageSize < 1 || pageSize > MAX_PAGE ? MAX_PAGE : pageSize;
            return findEvents(connection, apiName, beforeDate, beforeId, rows);
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    private static List<AuditEvent> findEvents(
        String connection,
        String apiName,
        Datetime beforeDate,
        Id beforeId,
        Integer rows
    ) {
        String soql =
            'SELECT Id, Name, Event_Type__c, Flow_Api_Name__c, Connection__c, Version_Number__c,' +
            ' Previous_Version__c, Actor__r.Name, Details__c, Request__c, CreatedDate FROM Flow_Audit_Event__c';
        List<String> filters = new List<String>();
        List<String> names = new List<String>();
        if (String.isNotBlank(apiName)) {
            names = FlowGovernanceService.flowNames(connection, apiName);
            filters.add('Flow_Api_Name__c IN :names AND Connection__c = :connection');
        }
        if (beforeDate != null && beforeId != null) {
            filters.add(BEFORE_CURSOR);
        }
        if (!filters.isEmpty()) {
            soql += ' WHERE ' + String.join(filters, ' AND ');
        }
        soql += NEWEST_FIRST + ' LIMIT ' + rows;
        List<Flow_Audit_Event__c> records = Database.queryWithBinds(
            soql,
            new Map<String, Object>{
                'names' => names,
                'connection' => stored(connection),
                'beforeDate' => beforeDate,
                'beforeId' => beforeId
            },
            AccessLevel.USER_MODE
        );
        List<AuditEvent> events = new List<AuditEvent>();
        for (Flow_Audit_Event__c record : records) {
            AuditEvent event = new AuditEvent();
            event.id = record.Id;
            event.name = record.Name;
            event.type = record.Event_Type__c;
            event.apiName = record.Flow_Api_Name__c;
            event.connection = FlowToolingClient.normalizeConnection(record.Connection__c);
            event.versionNumber = toInt(record.Version_Number__c);
            event.previousVersion = toInt(record.Previous_Version__c);
            event.actor = record.Actor__r?.Name;
            event.details = record.Details__c;
            event.requestId = record.Request__c;
            event.createdDate = record.CreatedDate;
            events.add(event);
        }
        return events;
    }

    /** Checks every governed flow now, reverting unapproved activations. */
    @AuraEnabled
    public static List<CheckResult> runCheck() {
        try {
            FlowGovernanceService.requireAdmin();
            CheckResult queued = new CheckResult();
            queued.operationId = FlowGovernanceOperation.check();
            queued.outcome = 'queued';
            return new List<CheckResult>{ queued };
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    @AuraEnabled
    public static FlowGovernanceOperation.Status getOperation(Id operationId) {
        try {
            return FlowGovernanceOperation.status(operationId);
        } catch (Exception e) {
            throw FlowCompareController.auraError(e);
        }
    }

    /**
     * A request the user has just changed, as they may read it. The service
     * works on its own copy in system mode; what goes back is read with the
     * user's sharing and restriction rules, less the fields they can't read,
     * so acting on a request shows no more of it than getRequest would. One
     * they can't read at all comes back as its Id and status, which their own
     * action already told them.
     */
    public static Request load(Flow_Activation_Request__c changed) {
        List<Flow_Activation_Request__c> found = new List<Flow_Activation_Request__c>();
        if (
            Schema.sObjectType.Flow_Activation_Request__c.isAccessible() &&
            // Restriction rules apply only to a user-mode read, so this one
            // says whether the user may see the request at all.
            ![SELECT Id FROM Flow_Activation_Request__c WHERE Id = :changed.Id WITH USER_MODE].isEmpty()
        ) {
            // Sharing applies too: this class is with sharing.
            found = [
                SELECT
                    Id,
                    Name,
                    Flow_Api_Name__c,
                    Flow_Label__c,
                    Connection__c,
                    Version_Number__c,
                    Flow_Version_Id__c,
                    Status__c,
                    Approver__r.Name,
                    Decided_By__r.Name,
                    Decided_At__c,
                    Request_Comments__c,
                    Decision_Comments__c,
                    Change_Summary__c,
                    Compared_Version__c,
                    Replaces_Version__c,
                    Reviewed_At__c,
                    Error__c,
                    Governance__c,
                    CreatedById,
                    CreatedBy.Name,
                    CreatedDate
                FROM Flow_Activation_Request__c
                WHERE Id = :changed.Id
                WITH SYSTEM_MODE
            ];
            // A field stripped from a queried record can't be read at all; one
            // rebuilt from JSON reads as null, as toRequests expects.
            found = (List<Flow_Activation_Request__c>) JSON.deserialize(
                JSON.serialize(Security.stripInaccessible(AccessType.READABLE, found).getRecords()),
                List<Flow_Activation_Request__c>.class
            );
        }
        if (found.isEmpty()) {
            Request request = new Request();
            request.id = changed.Id;
            request.status = changed.Status__c;
            return request;
        }
        Request request = toRequests(found, RequestText.ALL)[0];
        // The outcome of their own action, even when they can't read the
        // status field; nothing else they can't read is filled back in.
        if (request.status == null) {
            request.status = changed.Status__c;
        }
        return request;
    }

    // Requests as the user sees them, with their text as read: none, cut short, or all of it.
    private static List<Request> toRequests(List<Flow_Activation_Request__c> records, RequestText text) {
        // A request links the governance it was made under; older ones are matched by name.
        Set<Id> ids = new Set<Id>();
        Set<String> keys = new Set<String>();
        for (Flow_Activation_Request__c record : records) {
            ids.add(record.Governance__c);
            keys.addAll(FlowGovernanceService.flowKeys(record.Connection__c, record.Flow_Api_Name__c));
        }
        Map<String, Flow_Governance__c> governance = new Map<String, Flow_Governance__c>();
        for (Flow_Governance__c record : FlowGovernanceService.governanceFor(ids, keys)) {
            governance.put(record.Id, record);
            governance.put(record.Flow_Key__c, record);
        }
        Boolean admin = FlowGovernanceService.isAdmin();
        Id me = UserInfo.getUserId();
        List<Request> requests = new List<Request>();
        for (Flow_Activation_Request__c record : records) {
            Request request = new Request();
            request.id = record.Id;
            request.name = record.Name;
            request.apiName = record.Flow_Api_Name__c;
            request.label = String.isBlank(record.Flow_Label__c) ? record.Flow_Api_Name__c : record.Flow_Label__c;
            request.connection = FlowToolingClient.normalizeConnection(record.Connection__c);
            request.versionNumber = toInt(record.Version_Number__c);
            request.versionId = record.Flow_Version_Id__c;
            request.status = record.Status__c;
            request.requestedBy = record.CreatedBy?.Name;
            request.requestedById = record.CreatedById;
            request.requestedAt = record.CreatedDate;
            request.approverName = record.Approver__r?.Name;
            request.decidedBy = record.Decided_By__r?.Name;
            request.decidedAt = record.Decided_At__c;
            if (text != RequestText.NONE) {
                Integer shown = text == RequestText.PREVIEW ? PREVIEW_LENGTH : null;
                request.comments = cut(record.Request_Comments__c, shown);
                request.decisionComments = cut(record.Decision_Comments__c, shown);
                request.changeSummary = cut(record.Change_Summary__c, shown);
                request.error = cut(record.Error__c, shown);
                request.truncated = false;
                for (
                    String value : new List<String>{
                        record.Request_Comments__c,
                        record.Decision_Comments__c,
                        record.Change_Summary__c,
                        record.Error__c
                    }
                ) {
                    request.truncated |= shown != null && value != null && value.length() > shown;
                }
            }
            request.comparedVersion = toInt(record.Compared_Version__c);
            request.replacesVersion = toInt(record.Replaces_Version__c);
            request.reviewedAt = record.Reviewed_At__c;
            Boolean pending = record.Status__c == FlowGovernanceService.PENDING;
            Flow_Governance__c current = governance.get(record.Governance__c);
            for (String key : FlowGovernanceService.flowKeys(record.Connection__c, record.Flow_Api_Name__c)) {
                if (current == null)
                    current = governance.get(key);
            }
            Boolean approves = FlowGovernanceService.canApprove(record.Connection__c, current);
            Boolean overrides = FlowGovernanceService.overridesOwner(current, me);
            request.canDecide = pending && approves;
            request.canCancel = pending && (record.CreatedById == me || admin);
            request.overrides = request.canDecide && overrides;
            request.decides = approves && !overrides;
            requests.add(request);
        }
        return requests;
    }

    private static Governance toGovernance(Flow_Governance__c record) {
        Governance governance = new Governance();
        governance.id = record.Id;
        governance.label = record.Name;
        governance.apiName = record.Flow_Api_Name__c;
        governance.connection = FlowToolingClient.normalizeConnection(record.Connection__c);
        governance.ownerId = record.Owner_User__c;
        governance.ownerName = record.Owner_User__r?.Name;
        governance.mode = record.Mode__c;
        governance.approvedVersion = toInt(record.Approved_Version__c);
        governance.activeVersion = toInt(record.Active_Version__c);
        governance.lastChecked = record.Last_Checked__c;
        governance.lastCheckOutcome = record.Last_Check_Outcome__c;
        governance.lastCheckMessage = record.Last_Check_Message__c;
        governance.isOwner = record.Owner_User__c == UserInfo.getUserId();
        return governance;
    }

    // A flow's governance as the user may see it: none when they can't read it.
    private static Governance visible(Id governanceId) {
        try {
            List<Flow_Governance__c> records = [
                SELECT
                    Id,
                    Name,
                    Flow_Api_Name__c,
                    Connection__c,
                    Owner_User__c,
                    Owner_User__r.Name,
                    Mode__c,
                    Approved_Version__c,
                    Active_Version__c,
                    Last_Checked__c,
                    Last_Check_Outcome__c,
                    Last_Check_Message__c
                FROM Flow_Governance__c
                WHERE Id = :governanceId
                WITH USER_MODE
            ];
            return records.isEmpty() ? null : toGovernance(records[0]);
        } catch (QueryException e) {
            return null;
        }
    }

    // Text cut to a length, ending in "..." when it's cut; all of it when there's no length.
    private static String cut(String value, Integer shown) {
        return value == null || shown == null ? value : value.abbreviate(shown);
    }

    private static String stored(String connection) {
        return FlowToolingClient.isLocal(connection) ? null : connection;
    }

    private static Integer toInt(Decimal value) {
        return value == null ? null : value.intValue();
    }
}
