/**
 * Flow ownership and activation approvals.
 *
 * Each governed flow has an owner and a mode:
 *   Off     no enforcement; requests are still recorded.
 *   Watch   activations by anyone but the owner are reverted to the approved
 *           version, and the owner is told.
 *   Locked  every activation must come through an approved request; any
 *           other activation, even the owner's, is reverted.
 *
 * Activations happen through the Tooling API as the app's integration user,
 * after the checks here. Callouts always come before DML in a transaction.
 * A committed FlowGovernanceOperation claim on a flow serializes decisions
 * and checks of that flow. Row locks alone cannot do this: Salesforce
 * releases them on callouts.
 *
 * A flow is governed under its full API name. A flow in the org's own
 * namespace may also be governed under its bare name, so lookups try both.
 *
 * Authorization decisions read governance records through Policy, which
 * ignores sharing, so a user who can't see a record can't slip past its
 * owner. Audit events are written in system mode: users can read them but
 * never write them.
 */
public with sharing class FlowGovernanceService {
    public static final String MODE_OFF = 'Off';
    public static final String MODE_WATCH = 'Watch';
    public static final String MODE_LOCKED = 'Locked';

    public static final String PENDING = 'Pending';
    public static final String APPROVED = 'Approved';
    public static final String REJECTED = 'Rejected';
    public static final String CANCELLED = 'Cancelled';
    public static final String ACTIVATED = 'Activated';
    public static final String FAILED = 'Failed';

    private static final String ACTIVATED_ACTION = 'activatedinteractiondefversion';
    private static final String DEACTIVATED_ACTION = 'deactivatedinteractiondefversion';
    private static final String NOTIFICATION_TYPE = 'Flow_Governance_Alert';
    // Another org's clock may differ a little from this one's, so an audit
    // entry this close before a checkpoint still counts. Its version must
    // match the active one too, so an older activation is never credited.
    private static final Integer CHECKPOINT_OVERLAP_SECONDS = 60;
    // Flows per Tooling API query, so the query string stays well under URL limits.
    private static final Integer NAMES_PER_QUERY = 100;
    private static final String BUSY = 'Someone else is changing this flow\'s governance right now. Try again in a moment.';
    private static final String REQUEST_FIELDS =
        'Id, Name, Flow_Api_Name__c, Flow_Label__c, Connection__c, Version_Number__c, Flow_Version_Id__c,' +
        ' Status__c, Approver__c, Decided_By__c, Decided_At__c, Request_Comments__c, Decision_Comments__c,' +
        ' Change_Summary__c, Compared_Version__c, Replaces_Version__c, Reviewed_At__c, Reviewed_Millis__c, Error__c, Governance__c, CreatedById, CreatedDate';
    private static final String GOVERNANCE_FIELDS =
        'Id, Name, Flow_Api_Name__c, Flow_Key__c, Connection__c, Owner_User__c, Owner_User__r.Name, Mode__c,' +
        ' Approved_Version__c, Active_Version__c, Last_Checked__c, Last_Check_Outcome__c, Last_Check_Message__c';

    /** The prefix this package's namespace gives API names ("ns__"), or '' when unpackaged. */
    public static final String NAMESPACE_PREFIX = String.valueOf(Flow_Governance__c.SObjectType)
        .removeEnd('Flow_Governance__c');
    /** This package's namespace, or null when unpackaged; for binding against NamespacePrefix. */
    public static final String NAMESPACE = String.isBlank(NAMESPACE_PREFIX) ? null : NAMESPACE_PREFIX.removeEnd('__');

    public class GovernanceException extends Exception {
    }

    // Tests set this to check what would have been sent.
    @TestVisible
    private static List<Map<String, Object>> sentNotifications = new List<Map<String, Object>>();

    public static String flowKey(String connection, String apiName) {
        return FlowToolingClient.normalizeConnection(connection) + ':' + apiName;
    }

    private static String storedConnection(String connection) {
        return FlowToolingClient.isLocal(connection) ? null : connection;
    }

    public static Boolean canRequest() {
        return Schema.sObjectType.Flow_Activation_Request__c.isCreateable();
    }

    public static Boolean isAdmin() {
        return FeatureManagement.checkPermission('Flow_Compare_Admin');
    }

    /**
     * Saving versions and activating ungoverned flows needs Tributary Save.
     * In this org it also needs Manage Flow, so the app never lets anyone
     * change flows they couldn't change in Flow Builder.
     */
    public static Boolean canSave(String connection) {
        if (!isAdmin() && !FeatureManagement.checkPermission('Flow_Compare_Save')) {
            return false;
        }
        return !FlowToolingClient.isLocal(connection) || hasManageFlow();
    }

    // Every user is assigned their profile's own permission set as well, so
    // this finds Manage Flow granted by a profile too.
    public static Boolean hasManageFlow() {
        Id me = UserInfo.getUserId();
        if (!manageFlow.containsKey(me)) {
            manageFlow.put(
                me,
                ![
                        SELECT Id
                        FROM PermissionSetAssignment
                        WHERE AssigneeId = :me AND PermissionSet.PermissionsManageInteraction = TRUE
                        WITH SYSTEM_MODE
                        LIMIT 1
                    ]
                    .isEmpty()
            );
        }
        return manageFlow.get(me);
    }
    private static Map<Id, Boolean> manageFlow = new Map<Id, Boolean>();

    /**
     * A flow's governance, found from its name alone. In this org a name with
     * or without the org's namespace is the same flow, so both are tried.
     * Decisions look governance up again from the flow the name resolves to.
     */
    public static Flow_Governance__c findGovernance(String connection, String apiName) {
        return findGovernance(connection, apiName, false);
    }

    private static Flow_Governance__c findGovernance(String connection, String apiName, Boolean lock) {
        return findGovernance(flowKeys(connection, apiName), lock);
    }

    public static List<String> flowKeys(String connection, String apiName) {
        List<String> keys = new List<String>();
        for (String name : flowNames(connection, apiName)) {
            keys.add(flowKey(connection, name));
        }
        return keys;
    }

    public static List<String> flowNames(String connection, String apiName) {
        FlowToolingClient.FlowName name = new FlowToolingClient.FlowName(apiName);
        List<String> names = new List<String>{ apiName };
        String home = FlowToolingClient.isLocal(connection) ? orgNamespace() : '';
        if (String.isNotBlank(home) && name.namespacePrefix == null) {
            names.add(home + '__' + apiName);
        } else if (String.isNotBlank(home) && name.namespacePrefix == home) {
            names.add(name.developerName);
        }
        return names;
    }

    // The governance of the flow a FlowDefinition describes. A flow of the
    // org's own may be governed under its bare name as well as its full one.
    private static Flow_Governance__c findGovernance(String connection, Map<String, Object> definition, Boolean lock) {
        List<String> keys = new List<String>{ flowKey(connection, FlowToolingClient.apiNameOf(definition)) };
        if (FlowToolingClient.isOwned(definition)) {
            keys.add(flowKey(connection, (String) definition.get('DeveloperName')));
        }
        return findGovernance(keys, lock);
    }

    // Locks protect DML-only decisions; the operation claim protects callouts. First key wins.
    private static Flow_Governance__c findGovernance(List<String> keys, Boolean lock) {
        List<Flow_Governance__c> found = new Policy().find(keys, lock);
        for (String key : keys) {
            for (Flow_Governance__c record : found) {
                if (record.Flow_Key__c == key) {
                    return record;
                }
            }
        }
        return null;
    }

    /**
     * The governance of requests or flows, to work out who may decide on
     * them, whatever the user's sharing: never to show. Found by the
     * governance a request links, or by flow key.
     */
    public static List<Flow_Governance__c> governanceFor(Set<Id> ids, Set<String> keys) {
        return new Policy().linked(ids, keys);
    }

    /** Every governed flow, to work out who may decide on what: never to show. */
    public static List<Flow_Governance__c> allGovernance() {
        return new Policy().all();
    }

    /**
     * Governance as policy. Authorization, and the decisions it allows, must
     * see and write every governance record whatever sharing a subscriber
     * sets on it: a flow whose record the user can't see would otherwise look
     * ungoverned, and an owner it isn't shared with would lose their say over
     * it. Nothing read here reaches the user: screens read governance again in
     * user mode. Writes here set the app's own fields on a request or its
     * governance, after the running user has been authorized.
     */
    @TestVisible
    private without sharing class Policy {
        public List<Flow_Governance__c> find(List<String> keys, Boolean lock) {
            try {
                return Database.queryWithBinds(
                    'SELECT ' +
                        GOVERNANCE_FIELDS +
                        ' FROM Flow_Governance__c WHERE Flow_Key__c IN :keys' +
                        (lock ? ' FOR UPDATE' : ''),
                    new Map<String, Object>{ 'keys' => keys },
                    AccessLevel.SYSTEM_MODE
                );
            } catch (QueryException e) {
                throw new GovernanceException(lock ? BUSY : e.getMessage());
            }
        }

        public List<Flow_Governance__c> linked(Set<Id> ids, Set<String> keys) {
            return [
                SELECT Id, Flow_Key__c, Owner_User__c, Mode__c
                FROM Flow_Governance__c
                WHERE Id IN :ids OR Flow_Key__c IN :keys
                WITH SYSTEM_MODE
            ];
        }

        public List<Flow_Governance__c> all() {
            return [
                SELECT Id, Connection__c, Flow_Api_Name__c, Flow_Key__c, Owner_User__c, Mode__c
                FROM Flow_Governance__c
                WITH SYSTEM_MODE
            ];
        }

        public void save(SObject record) {
            if (record.Id == null) {
                Database.insert(record, AccessLevel.SYSTEM_MODE);
            } else {
                Database.update(record, AccessLevel.SYSTEM_MODE);
            }
        }

        // A successful admin policy change invalidates the old pending reviews,
        // including requests sharing hides. The caller holds the flow gate and
        // has already written governance in user mode. These writes and that
        // change commit together; no callout or notification is made here.
        public void cancelPending(Flow_Governance__c governance) {
            List<String> names = flowNames(governance.Connection__c, governance.Flow_Api_Name__c);
            Set<String> connections = new Set<String>{ storedConnection(governance.Connection__c) };
            if (FlowToolingClient.isLocal(governance.Connection__c)) {
                connections.add('local');
            }
            List<Flow_Activation_Request__c> pending = [
                SELECT Id, Flow_Api_Name__c, Connection__c, Version_Number__c
                FROM Flow_Activation_Request__c
                WHERE Status__c = :PENDING AND Connection__c IN :connections AND Flow_Api_Name__c IN :names
                WITH SYSTEM_MODE
                LIMIT 2001
                FOR UPDATE
            ];
            if (pending.size() > 2000) {
                throw new GovernanceException(
                    'Too many pending requests to change governance at once. Cancel older requests and try again.'
                );
            }
            String reason = 'Governance changed. Compare again and make a new request under the current owner and mode.';
            List<Flow_Audit_Event__c> events = new List<Flow_Audit_Event__c>();
            for (Flow_Activation_Request__c request : pending) {
                request.Status__c = CANCELLED;
                request.Decided_By__c = UserInfo.getUserId();
                request.Decided_At__c = System.now();
                request.Decision_Comments__c = reason;
                events.add(event(request, 'Cancelled', UserInfo.getUserId(), reason));
            }
            if (!pending.isEmpty()) {
                Database.update(pending, AccessLevel.SYSTEM_MODE);
                audit(events);
            }
        }

        // The check sweep's reads and result writes. A check must see every
        // governed flow, or one hidden from the admin who runs it would never
        // be enforced and the check would still report itself complete. Only
        // a check a Tributary admin started, and its queued jobs, reach these
        // (FlowGovernanceOperation checks the admin and the worker), and
        // what they read isn't shown to that user: the Governed page reads
        // the results again in user mode, and polling a check tells the admin
        // only about the flows they can see (FlowGovernanceOperation.status).
        public List<Flow_Governance__c> due(Datetime since, Integer max, List<Id> excluded) {
            Datetime before = since == null ? Datetime.newInstanceGmt(4000, 1, 1) : since;
            List<Flow_Governance__c> due = [
                SELECT Id, Connection__c, Flow_Api_Name__c
                FROM Flow_Governance__c
                WHERE
                    Mode__c != :MODE_OFF
                    AND (Last_Attempt__c = NULL
                    OR Last_Attempt__c < :before)
                    AND Id NOT IN :excluded
                WITH SYSTEM_MODE
                ORDER BY Last_Attempt__c ASC NULLS FIRST, Name
                LIMIT :max
            ];
            Integer room = max - due.size();
            if (room > 0) {
                due.addAll(
                    [
                        SELECT Id, Connection__c, Flow_Api_Name__c
                        FROM Flow_Governance__c
                        WHERE
                            Mode__c = :MODE_OFF
                            AND (Last_Attempt__c = NULL
                            OR Last_Attempt__c < :before)
                            AND Id NOT IN :excluded
                        WITH SYSTEM_MODE
                        ORDER BY Last_Attempt__c ASC NULLS FIRST, Name
                        LIMIT :room
                    ]
                );
            }
            return due;
        }

        public Integer countDue(Datetime since, List<Id> excluded) {
            return [
                SELECT COUNT()
                FROM Flow_Governance__c
                WHERE (Last_Attempt__c = NULL OR Last_Attempt__c < :since) AND Id NOT IN :excluded
                WITH SYSTEM_MODE
            ];
        }

        public List<Flow_Governance__c> toCheck(List<Id> ids) {
            return [
                SELECT
                    Id,
                    Name,
                    Flow_Api_Name__c,
                    Connection__c,
                    Approved_Version__c,
                    Active_Version__c,
                    Last_Checked__c
                FROM Flow_Governance__c
                WHERE Id IN :ids
                WITH SYSTEM_MODE
                ORDER BY Last_Attempt__c ASC NULLS FIRST, Name
            ];
        }

        // Throws a QueryException when a decision holds one of them.
        public Map<Id, Flow_Governance__c> lockToEnforce(Set<Id> ids) {
            return new Map<Id, Flow_Governance__c>(
                [
                    SELECT
                        Id,
                        Name,
                        Flow_Api_Name__c,
                        Connection__c,
                        Owner_User__c,
                        Mode__c,
                        Approved_Version__c,
                        Last_Checked__c,
                        Active_Version__c
                    FROM Flow_Governance__c
                    WHERE Id IN :ids
                    WITH SYSTEM_MODE
                    FOR UPDATE
                ]
            );
        }

        public Set<Id> stillGoverned(Set<Id> ids) {
            return new Map<Id, Flow_Governance__c>(
                    [SELECT Id FROM Flow_Governance__c WHERE Id IN :ids WITH SYSTEM_MODE]
                )
                .keySet();
        }

        // Each flow's result is saved on its own, so one flow that stopped
        // being governed doesn't lose the others'.
        public List<Database.SaveResult> saveResults(List<Flow_Governance__c> records) {
            return Database.update(records, false, AccessLevel.SYSTEM_MODE);
        }
    }

    // The org's own namespace, which in a subscriber org isn't this package's; '' when none.
    private static String orgNamespace() {
        if (orgNamespace == null) {
            String prefix = [SELECT NamespacePrefix FROM Organization WITH SYSTEM_MODE LIMIT 1].NamespacePrefix;
            orgNamespace = prefix == null ? '' : prefix;
        }
        return orgNamespace;
    }
    private static String orgNamespace;

    /**
     * Who may activate a version or decide on a request: admins, and the owner
     * of a governed flow in any mode. When a flow isn't governed (or governance
     * is off), anyone who could activate it in Flow Builder may in this org;
     * other orgs are activated as the integration user, so only admins may.
     */
    public static Boolean canApprove(String connection, Flow_Governance__c governance) {
        if (isAdmin()) {
            return true;
        }
        if (governance != null && governance.Owner_User__c == UserInfo.getUserId()) {
            return true;
        }
        if (governance != null && governance.Mode__c != MODE_OFF) {
            return false;
        }
        return FlowToolingClient.isLocal(connection) && canSave(connection);
    }

    public static Flow_Activation_Request__c loadRequest(Id requestId) {
        return loadRequest(requestId, false);
    }

    // A decision locks the request, so a second decision waits and then finds it decided.
    private static Flow_Activation_Request__c loadRequest(Id requestId, Boolean lock) {
        List<Flow_Activation_Request__c> found;
        try {
            found = Database.queryWithBinds(
                'SELECT ' +
                    REQUEST_FIELDS +
                    ' FROM Flow_Activation_Request__c WHERE Id = :requestId LIMIT 1' +
                    (lock ? ' FOR UPDATE' : ''),
                new Map<String, Object>{ 'requestId' => requestId },
                AccessLevel.SYSTEM_MODE
            );
        } catch (QueryException e) {
            throw new GovernanceException(
                lock ? 'Someone else is deciding on this request right now. Try again in a moment.' : e.getMessage()
            );
        }
        if (found.isEmpty()) {
            throw new GovernanceException('That activation request no longer exists.');
        }
        return found[0];
    }

    public class RequestInput {
        public String connection;
        public String apiName;
        public String label;
        public Integer versionNumber;
        public String versionId;
        public String comments;
        public String changeSummary;
        public Integer comparedVersion;
        // The version the requester saw active (0 for none), or null when unknown.
        public Integer replacesVersion;
        // When the version was saved from the merge the summary describes.
        public Datetime reviewedAt;
    }

    /** Records a request to activate a version and tells the approver. */
    public static Flow_Activation_Request__c requestActivation(RequestInput input) {
        if (!canRequest()) {
            throw new GovernanceException('You don\'t have access to request flow activations.');
        }
        validate(input);
        // No callouts follow: hold the same gate as governance changes before
        // reading the owner, so a new request cannot outlive a stale policy.
        FlowGovernanceOperation.guardWrite(FlowGovernanceOperation.gateKey(input.connection, input.apiName), null);
        Flow_Governance__c governance = findGovernance(input.connection, input.apiName);
        Flow_Activation_Request__c request = newRequest(input, governance);
        // Status, approver and governance are the app's to set, so users can't
        // write them; the checks above stand in for the user's own access. It
        // links governance the user may not be able to see.
        new Policy().save(request);
        audit(new List<Flow_Audit_Event__c>{ event(request, 'Requested', UserInfo.getUserId(), input.comments) });
        if (request.Approver__c != null && request.Approver__c != UserInfo.getUserId()) {
            notify(
                new Set<String>{ request.Approver__c },
                'Activation requested: ' + describe(request),
                UserInfo.getName() + ' asked to activate this version.' + suffix(input.comments),
                appPage('Flow_Approvals', new Map<String, String>{ 'c__scope' => 'mine', 'c__request' => request.Id })
            );
        }
        return request;
    }

    public static void authorizeActivation(RequestInput input) {
        validate(input);
        authorize(input.connection, findGovernance(input.connection, input.apiName), ACTIVATE_REFUSED);
    }

    /** The request, once the running user may decide on it. */
    public static Flow_Activation_Request__c authorizeApproval(Id requestId) {
        Flow_Activation_Request__c request = loadRequest(requestId);
        decidable(request);
        return request;
    }

    /** Activates the requested version, then records the outcome. */
    public static Flow_Activation_Request__c approve(Id requestId, String comments) {
        FlowGovernanceOperation.requireWorker();
        validateComments(comments);
        Flow_Activation_Request__c request = loadRequest(requestId, true);
        return decide(request, decidable(request), comments, DECIDE_REFUSED);
    }

    /**
     * Activates a version straight away for someone who may approve it. It is
     * recorded as a request decided at once, so both paths are audited alike.
     */
    public static Flow_Activation_Request__c activateNow(RequestInput input) {
        FlowGovernanceOperation.requireWorker();
        validate(input);
        Flow_Governance__c governance = findGovernance(input.connection, input.apiName);
        authorize(input.connection, governance, ACTIVATE_REFUSED);
        return decide(newRequest(input, governance), governance, input.comments, ACTIVATE_REFUSED);
    }

    // An admin deciding for a governed flow someone else owns overrides the
    // owner, and the history says so.
    public static Boolean overridesOwner(Flow_Governance__c governance, Id actor) {
        return governance != null &&
            governance.Mode__c != MODE_OFF &&
            governance.Owner_User__c != null &&
            governance.Owner_User__c != actor;
    }

    private static String asOverride(String comments, Boolean overridden) {
        if (!overridden) {
            return comments;
        }
        return String.isBlank(comments) ? 'Admin override.' : ('Admin override: ' + comments).abbreviate(32768);
    }

    private static final String ACTIVATE_REFUSED = 'Only the flow\'s owner or a Tributary admin can activate it here. Request activation instead.';
    private static final String DECIDE_REFUSED = 'Only the flow\'s owner or a Tributary admin can decide on this request.';

    private static void authorize(String connection, Flow_Governance__c governance, String refusal) {
        if (!canApprove(connection, governance)) {
            throw new GovernanceException(refusal);
        }
    }

    public static void validateComments(String comments) {
        if (comments != null && comments.length() > 32768) {
            throw new GovernanceException('Keep comments to 32,768 characters or fewer.');
        }
    }

    // Version 0 asks to deactivate the flow.
    private static void validate(RequestInput input) {
        validateComments(input.comments);
        new FlowToolingClient.FlowName(input.apiName);
        if (input.versionNumber == null || input.versionNumber < 0) {
            throw new GovernanceException('Choose a version to activate.');
        }
    }

    private static Flow_Activation_Request__c newRequest(RequestInput input, Flow_Governance__c governance) {
        return new Flow_Activation_Request__c(
            Flow_Api_Name__c = input.apiName,
            Flow_Label__c = input.label == null ? null : input.label.abbreviate(255),
            Connection__c = storedConnection(input.connection),
            Version_Number__c = input.versionNumber,
            Flow_Version_Id__c = input.versionId == null ? null : FlowToolingClient.checkId(input.versionId),
            Status__c = PENDING,
            Approver__c = governance == null ? null : governance.Owner_User__c,
            Request_Comments__c = input.comments,
            Change_Summary__c = input.changeSummary == null ? null : input.changeSummary.abbreviate(32768),
            Compared_Version__c = input.comparedVersion,
            Replaces_Version__c = input.replacesVersion,
            Reviewed_At__c = input.reviewedAt,
            Reviewed_Millis__c = input.reviewedAt == null ? null : input.reviewedAt.getTime(),
            Governance__c = governance == null ? null : governance.Id
        );
    }

    // Activates a request's version and records the outcome. A request not
    // yet saved is a direct activation. The caller has already checked the
    // running user against the governance found by name; once the name is
    // resolved to a flow, that flow's own governance is locked and checked.
    // Every callout comes before any write.
    private static Flow_Activation_Request__c decide(
        Flow_Activation_Request__c request,
        Flow_Governance__c governance,
        String comments,
        String refusal
    ) {
        Boolean requested = request.Id != null;
        Integer version = request.Version_Number__c.intValue();
        Id me = UserInfo.getUserId();
        String error;
        Integer previous;
        FlowToolingClient client;
        Map<String, Object> definition;
        try {
            client = new FlowToolingClient(request.Connection__c);
            definition = client.findDefinition(request.Flow_Api_Name__c);
            if (definition == null) {
                throw new GovernanceException('The flow ' + request.Flow_Api_Name__c + ' no longer exists.');
            }
        } catch (Exception e) {
            error = e.getMessage();
        }
        if (definition != null) {
            request.Flow_Api_Name__c = FlowToolingClient.apiNameOf(definition);
            governance = findGovernance(request.Connection__c, definition, true);
            authorize(request.Connection__c, governance, refusal);
            request.Governance__c = governance?.Id;
            if (!requested) {
                request.Approver__c = governance?.Owner_User__c;
            }
            try {
                if (version > 0 && (requested || request.Reviewed_At__c != null)) {
                    checkUnchanged(client, (String) definition.get('Id'), request);
                }
                previous = FlowToolingClient.intPath(definition, 'ActiveVersion.VersionNumber');
                checkActiveUnchanged(request, previous == null ? 0 : previous);
                client.activate((String) definition.get('Id'), version);
            } catch (Exception e) {
                error = e.getMessage();
            }
        }

        Boolean overridden = overridesOwner(governance, me);
        request.Status__c = error == null ? ACTIVATED : FAILED;
        request.Decided_By__c = me;
        request.Decided_At__c = System.now();
        request.Decision_Comments__c = asOverride(requested ? comments : null, overridden);
        request.Error__c = error;
        // The flow may already be activated, so the user's sharing on the
        // request or its governance mustn't stop the outcome being recorded.
        new Policy().save(request);
        if (error == null && governance != null) {
            new Policy()
                .save(
                    new Flow_Governance__c(
                        Id = governance.Id,
                        Approved_Version__c = version,
                        Active_Version__c = version
                    )
                );
        }

        List<Flow_Audit_Event__c> events = new List<Flow_Audit_Event__c>();
        if (requested) {
            events.add(event(request, 'Approved', me, asOverride(comments, overridden)));
        }
        Flow_Audit_Event__c outcome = event(
            request,
            error == null ? 'Activated' : 'Activation Failed',
            me,
            error != null ? error : requested ? null : asOverride(request.Request_Comments__c, overridden)
        );
        outcome.Previous_Version__c = previous;
        events.add(outcome);
        audit(events);

        String page = appPage(
            'Flow_Approvals',
            new Map<String, String>{ 'c__scope' => 'submitted', 'c__request' => request.Id }
        );
        if (requested && request.CreatedById != me) {
            notify(
                new Set<String>{ request.CreatedById },
                (error == null ? 'Activated: ' : 'Activation failed: ') + describe(request),
                error == null ? UserInfo.getName() + ' approved your request.' + suffix(comments) : error,
                page
            );
        } else if (!requested && error == null && governance?.Owner_User__c != null && governance.Owner_User__c != me) {
            notify(
                new Set<String>{ governance.Owner_User__c },
                'Activated: ' + describe(request),
                UserInfo.getName() + ' activated this version.' + suffix(request.Request_Comments__c),
                governedPage(governance)
            );
        }
        return request;
    }

    // A draft can still be edited after it's requested, or after it was
    // saved from the merge a request describes. Activating it activates what
    // was asked for or nothing, so a version changed since is refused.
    private static void checkUnchanged(
        FlowToolingClient client,
        String definitionId,
        Flow_Activation_Request__c request
    ) {
        Integer version = request.Version_Number__c.intValue();
        List<Map<String, Object>> found = client.toolingQuery(
            'SELECT Id, LastModifiedDate FROM Flow WHERE DefinitionId = \'' +
                FlowToolingClient.checkId(definitionId) +
                '\' AND VersionNumber = ' +
                version
        );
        if (found.isEmpty()) {
            throw new GovernanceException('Version ' + version + ' no longer exists.');
        }
        String id = (String) found[0].get('Id');
        Object modified = found[0].get('LastModifiedDate');
        Boolean replaced =
            request.Flow_Version_Id__c != null &&
            id != null &&
            id.left(15) != request.Flow_Version_Id__c.left(15);
        Datetime cutoff = request.CreatedDate;
        Boolean sinceReview = request.Reviewed_At__c != null && (cutoff == null || request.Reviewed_At__c < cutoff);
        if (sinceReview) {
            cutoff = request.Reviewed_At__c;
        }
        Long changedAt = modified == null
            ? null
            : ((Datetime) JSON.deserialize('"' + modified + '"', Datetime.class)).getTime();
        // Preserve exact milliseconds for new reviews; old records only stored seconds.
        Boolean edited =
            changedAt != null &&
            ((request.Reviewed_Millis__c != null && changedAt > request.Reviewed_Millis__c.longValue()) ||
            (cutoff != null &&
            changedAt / 1000 >
            cutoff.getTime() / 1000));
        if (replaced || edited) {
            throw new GovernanceException(
                'Version ' +
                    version +
                    (sinceReview
                        ? ' was changed after its merge was reviewed, so it isn\'t what the summary describes.'
                        : ' was changed after it was requested.') +
                    (request.Id == null
                        ? ' Compare it again before activating it.'
                        : ' Compare it again and make a new request.')
            );
        }
    }

    // Someone may activate another version while a request waits. Approving
    // the old request then would silently roll that choice back, so it is
    // refused unless the flow is still on the version the requester saw.
    private static void checkActiveUnchanged(Flow_Activation_Request__c request, Integer active) {
        if (request.Replaces_Version__c == null) {
            return;
        }
        Integer seen = request.Replaces_Version__c.intValue();
        Integer version = request.Version_Number__c.intValue();
        if (active == seen || active == version) {
            return;
        }
        throw new GovernanceException(
            'The active version changed from ' +
                describeActive(seen) +
                ' to ' +
                describeActive(active) +
                (request.Id == null
                    ? ' since this page loaded. Refresh and compare again before activating.'
                    : ' after this was requested, so approving it would undo that. Compare again and make a new request.')
        );
    }

    private static String describeActive(Integer version) {
        return version == 0 ? 'none' : 'version ' + version;
    }

    public static Flow_Activation_Request__c reject(Id requestId, String comments) {
        validateComments(comments);
        Flow_Activation_Request__c request = loadRequest(requestId, true);
        String gate = FlowGovernanceOperation.gateKey(request.Connection__c, request.Flow_Api_Name__c);
        Decimal revision = FlowGovernanceOperation.revision(gate);
        decidable(request);
        FlowGovernanceOperation.guardWrite(gate, revision);
        request.Status__c = REJECTED;
        request.Decided_By__c = UserInfo.getUserId();
        request.Decided_At__c = System.now();
        request.Decision_Comments__c = comments;
        // Deciding is the owner's or an admin's, as decidable found, whether
        // or not the request is shared with them for editing.
        new Policy().save(request);
        audit(new List<Flow_Audit_Event__c>{ event(request, 'Rejected', UserInfo.getUserId(), comments) });
        if (request.CreatedById != UserInfo.getUserId()) {
            notify(
                new Set<String>{ request.CreatedById },
                'Not approved: ' + describe(request),
                UserInfo.getName() + ' rejected your request.' + suffix(comments),
                appPage(
                    'Flow_Approvals',
                    new Map<String, String>{ 'c__scope' => 'submitted', 'c__request' => request.Id }
                )
            );
        }
        return request;
    }

    public static Flow_Activation_Request__c cancel(Id requestId) {
        Flow_Activation_Request__c request = loadRequest(requestId, true);
        if (request.Status__c != PENDING) {
            throw new GovernanceException('This request is already ' + request.Status__c.toLowerCase() + '.');
        }
        if (request.CreatedById != UserInfo.getUserId() && !isAdmin()) {
            throw new GovernanceException('Only the person who made a request can cancel it.');
        }
        FlowGovernanceOperation.guardWrite(
            FlowGovernanceOperation.gateKey(request.Connection__c, request.Flow_Api_Name__c),
            null
        );
        // Status and who decided are the app's fields, which users can't edit;
        // only the requester or an admin gets here.
        request.Status__c = CANCELLED;
        request.Decided_By__c = UserInfo.getUserId();
        request.Decided_At__c = System.now();
        new Policy().save(request);
        audit(new List<Flow_Audit_Event__c>{ event(request, 'Cancelled', UserInfo.getUserId(), null) });
        return request;
    }

    // A pending request the running user may decide on; returns its governance.
    private static Flow_Governance__c decidable(Flow_Activation_Request__c request) {
        if (request.Status__c != PENDING) {
            throw new GovernanceException('This request is already ' + request.Status__c.toLowerCase() + '.');
        }
        Flow_Governance__c governance = findGovernance(request.Connection__c, request.Flow_Api_Name__c);
        authorize(request.Connection__c, governance, DECIDE_REFUSED);
        return governance;
    }

    public class GovernanceInput {
        public Id id;
        public String connection;
        public String apiName;
        public String label;
        public Id ownerId;
        public String mode;
    }

    // Only a person who can sign in can approve; system users such as
    // Automated Process, and API-only integration users, would leave every
    // request waiting forever.
    private static void checkOwner(Id ownerId) {
        List<User> found = [
            SELECT Id
            FROM User
            WHERE
                Id = :ownerId
                AND IsActive = TRUE
                AND UserType = 'Standard'
                AND (NOT Profile.UserLicense.Name LIKE '%Integration%')
            WITH SYSTEM_MODE
            LIMIT 1
        ];
        if (found.isEmpty()) {
            throw new GovernanceException(
                'Choose an active Salesforce user as the owner, not a system, integration or inactive user.'
            );
        }
        // API Only User from a profile too: each profile has a permission set of its own.
        if (
            ![
                    SELECT Id
                    FROM PermissionSetAssignment
                    WHERE AssigneeId = :ownerId AND PermissionSet.PermissionsApiUserOnly = TRUE
                    WITH SYSTEM_MODE
                    LIMIT 1
                ]
                .isEmpty()
        ) {
            throw new GovernanceException(
                'Choose an owner who can sign in to Salesforce. API-only users can\'t review or approve activations.'
            );
        }
    }

    /**
     * Creates or updates a governed flow. A flow starts from the version active
     * now when it's first governed, and again when enforcement is turned on:
     * an approved version from while it was off may be long out of date.
     */
    public static Flow_Governance__c saveGovernance(GovernanceInput input) {
        requireAdmin();
        // Before the active version is read, so an activation during the read isn't skipped.
        Datetime readAt = System.now();
        String gate = gateOf(input);
        Decimal revision = FlowGovernanceOperation.revision(gate);
        if (input.mode != MODE_OFF && input.mode != MODE_WATCH && input.mode != MODE_LOCKED) {
            throw new GovernanceException('Unknown mode: ' + input.mode);
        }
        if (input.ownerId == null && input.mode != MODE_OFF) {
            throw new GovernanceException('Choose an owner to approve this flow\'s activations.');
        }
        if (input.ownerId != null) {
            checkOwner(input.ownerId);
        }
        // The revision checkpoint is rechecked after any callouts; a row lock
        // alone would be released by those callouts.
        Flow_Governance__c existing;
        Map<String, Object> definition;
        if (input.id != null) {
            // Editing keeps the flow and org; only owner, mode and label change.
            List<Flow_Governance__c> found;
            try {
                found = [
                    SELECT Id, Name, Flow_Api_Name__c, Connection__c, Owner_User__c, Mode__c, Approved_Version__c
                    FROM Flow_Governance__c
                    WHERE Id = :input.id
                    WITH USER_MODE
                    FOR UPDATE
                ];
            } catch (QueryException e) {
                throw new GovernanceException(BUSY);
            }
            if (found.isEmpty()) {
                throw new GovernanceException('That flow is no longer governed.');
            }
            existing = found[0];
        } else {
            existing = findGovernance(input.connection, input.apiName, true);
            if (existing == null) {
                // A new flow is governed under the full name of the flow its name resolves to.
                definition = definitionOf(input.connection, input.apiName);
                existing = findGovernance(input.connection, definition, true);
            }
        }
        Boolean created = existing == null;
        String apiName = created ? FlowToolingClient.apiNameOf(definition) : existing.Flow_Api_Name__c;
        String connection = FlowToolingClient.normalizeConnection(created ? input.connection : existing.Connection__c);
        Flow_Governance__c record = new Flow_Governance__c(
            Id = created ? null : existing.Id,
            Flow_Api_Name__c = apiName,
            Connection__c = storedConnection(connection),
            Flow_Key__c = flowKey(connection, apiName),
            Name = String.isNotBlank(input.label) ? input.label.abbreviate(80) : created ? apiName : existing.Name,
            Owner_User__c = input.ownerId,
            Mode__c = input.mode
        );

        Boolean baseline =
            created ||
            existing.Approved_Version__c == null ||
            (existing.Mode__c == MODE_OFF &&
            input.mode != MODE_OFF);
        if (baseline) {
            // The gate revision check below rejects a concurrent Tributary write.
            if (!created) {
                definition = definitionOf(connection, apiName);
            }
            Integer active = FlowToolingClient.intPath(definition, 'ActiveVersion.VersionNumber');
            record.Approved_Version__c = active == null ? 0 : active;
            record.Active_Version__c = record.Approved_Version__c;
            record.Last_Checked__c = readAt;
        }
        FlowGovernanceOperation.guardWrite(gate, revision);
        Database.upsert(record, AccessLevel.USER_MODE);
        if (created || existing.Owner_User__c != record.Owner_User__c || existing.Mode__c != record.Mode__c) {
            new Policy().cancelPending(record);
        }

        Flow_Audit_Event__c changed = new Flow_Audit_Event__c(
            Flow_Api_Name__c = record.Flow_Api_Name__c,
            Connection__c = record.Connection__c,
            Event_Type__c = 'Governance Changed',
            Actor__c = UserInfo.getUserId(),
            Version_Number__c = baseline ? record.Approved_Version__c : existing.Approved_Version__c,
            Details__c = (created ? 'Now governed. ' : '') +
                'Mode: ' +
                modeLabel(record.Mode__c) +
                '. Owner: ' +
                ownerName(record.Owner_User__c) +
                '.' +
                (baseline && !created ? ' Approved version reset to the active one.' : '')
        );
        audit(new List<Flow_Audit_Event__c>{ changed });
        return record;
    }

    // The gate of the flow a change to governance is for; editing keeps its flow.
    private static String gateOf(GovernanceInput input) {
        if (input.id == null) {
            return FlowGovernanceOperation.gateKey(input.connection, input.apiName);
        }
        for (Flow_Governance__c record : [
            SELECT Connection__c, Flow_Api_Name__c
            FROM Flow_Governance__c
            WHERE Id = :input.id
            WITH SYSTEM_MODE
        ]) {
            return FlowGovernanceOperation.gateKey(record.Connection__c, record.Flow_Api_Name__c);
        }
        throw new GovernanceException('That flow is no longer governed.');
    }

    private static Map<String, Object> definitionOf(String connection, String apiName) {
        Map<String, Object> definition = new FlowToolingClient(connection).findDefinition(apiName);
        if (definition == null) {
            throw new GovernanceException('There is no flow named ' + apiName + '.');
        }
        return definition;
    }

    public static void removeGovernance(Id governanceId) {
        requireAdmin();
        List<Flow_Governance__c> found = governanceId == null
            ? new List<Flow_Governance__c>()
            : [
                  SELECT Id, Flow_Api_Name__c, Connection__c
                  FROM Flow_Governance__c
                  WHERE Id = :governanceId
                  WITH USER_MODE
              ];
        if (found.isEmpty()) {
            throw new GovernanceException('That flow is no longer governed.');
        }
        Flow_Governance__c record = found[0];
        FlowGovernanceOperation.guardWrite(
            FlowGovernanceOperation.gateKey(record.Connection__c, record.Flow_Api_Name__c),
            null
        );
        // User mode checks the user may delete it, as well as the admin check above.
        Database.delete(record, AccessLevel.USER_MODE);
        new Policy().cancelPending(record);
        audit(
            new List<Flow_Audit_Event__c>{
                new Flow_Audit_Event__c(
                    Flow_Api_Name__c = record.Flow_Api_Name__c,
                    Connection__c = record.Connection__c,
                    Event_Type__c = 'Governance Changed',
                    Actor__c = UserInfo.getUserId(),
                    Details__c = 'No longer governed.'
                )
            }
        );
    }

    public static void requireAdmin() {
        if (!isAdmin()) {
            throw new GovernanceException('This needs the Tributary Admin permission.');
        }
    }

    /**
     * Outcomes where a check couldn't read a flow or keep it to its approved
     * version. A check succeeds when none of the flows it tried ends in one.
     * A flow skipped because it was changing, or missing from its org, isn't
     * a failure of the check.
     */
    public static final Set<String> FAILED_CHECKS = new Set<String>{ 'error', 'revertFailed' };

    public class CheckResult {
        public Id governanceId;
        public String apiName;
        public String connection;
        public String outcome;
        public Integer activeVersion;
        public Integer approvedVersion;
        public String message;
    }

    /**
     * Governed flows a check hasn't tried since a time (any, when null):
     * enforced flows first, then those with governance off, each least
     * recently tried first. Failures rotate too, without discarding the last
     * successful audit-trail checkpoint.
     */
    public static List<Flow_Governance__c> dueForCheck(Datetime since, Integer max) {
        return dueForCheck(since, max, new List<Id>());
    }

    /** As dueForCheck, leaving out flows a check has already given up on. */
    public static List<Flow_Governance__c> dueForCheck(Datetime since, Integer max, List<Id> excluded) {
        return new Policy().due(since, max, excluded);
    }

    /**
     * How many governed flows a check hasn't tried since it began, beyond
     * those it tried and couldn't save the result of.
     */
    public static Integer countDue(Datetime since, List<Id> excluded) {
        return new Policy().countDue(since, excluded);
    }

    // One slice of a check, as its first job takes it.
    @TestVisible
    private static List<CheckResult> checkAll() {
        return checkFlows(new List<Id>(new Map<Id, Flow_Governance__c>(dueForCheck(null, 25)).keySet()));
    }

    /**
     * Compares these governed flows' active versions with their approved ones
     * and reverts activations the mode doesn't allow. Flows with governance
     * off are only brought up to date. FlowGovernanceOperation runs a check
     * as a sweep of these, 25 flows per job, until every flow is tried.
     */
    public static List<CheckResult> checkFlows(List<Id> governanceIds) {
        FlowGovernanceOperation.requireWorker();
        List<Flow_Governance__c> governed = new Policy().toCheck(governanceIds);
        Map<String, List<Flow_Governance__c>> byConnection = new Map<String, List<Flow_Governance__c>>();
        for (Flow_Governance__c record : governed) {
            String connection = FlowToolingClient.normalizeConnection(record.Connection__c);
            if (!byConnection.containsKey(connection)) {
                byConnection.put(connection, new List<Flow_Governance__c>());
            }
            byConnection.get(connection).add(record);
        }

        Check check = new Check();
        for (String connection : byConnection.keySet()) {
            check.read(connection, byConnection.get(connection));
        }
        check.enforce();

        // Every callout is done; now write. Only what the check found is
        // written, so a flow that stopped being governed is skipped rather
        // than failing the run.
        check.saved(new Policy().saveResults(check.updates));
        audit(check.events);
        for (Map<String, Object> alert : check.alerts) {
            notify(
                (Set<String>) alert.get('to'),
                (String) alert.get('title'),
                (String) alert.get('body'),
                (String) alert.get('target')
            );
        }
        return check.results;
    }

    // What one org's queries found.
    private class OrgState {
        public String connection;
        public List<Flow_Governance__c> records;
        public FlowToolingClient client;
        public final Map<String, Map<String, Object>> byApiName = new Map<String, Map<String, Object>>();
        // The org's own namespaced flows, for names stored without the namespace.
        public final Map<String, Map<String, Object>> byDeveloperName = new Map<String, Map<String, Object>>();
        public final Map<String, Map<String, Object>> latestChange = new Map<String, Map<String, Object>>();
        // When the definitions were read: a successful check's checkpoint. An
        // activation after this wasn't seen, so its audit entry must still count.
        public Datetime readAt;
        // Set when the Setup Audit Trail couldn't be read.
        public String auditError;

        // The flow a governance record names, as this org describes it.
        public Map<String, Object> definitionFor(Flow_Governance__c record) {
            FlowToolingClient.FlowName name = new FlowToolingClient.FlowName(record.Flow_Api_Name__c);
            Map<String, Object> definition = byApiName.get(record.Flow_Api_Name__c);
            if (definition == null && name.namespacePrefix == null) {
                definition = byDeveloperName.get(name.developerName);
            }
            return definition;
        }
    }

    // One run of checkAll: what it found, and what to write once the callouts are done.
    private with sharing class Check {
        public final List<CheckResult> results = new List<CheckResult>();
        public final List<Flow_Audit_Event__c> events = new List<Flow_Audit_Event__c>();
        public final List<Map<String, Object>> alerts = new List<Map<String, Object>>();
        public final List<Flow_Governance__c> updates = new List<Flow_Governance__c>();
        private final List<OrgState> orgs = new List<OrgState>();

        // A result that couldn't be saved keeps the old checkpoint, so the check
        // says it failed. A flow no longer governed has nothing to save.
        public void saved(List<Database.SaveResult> saves) {
            Map<Id, String> failures = new Map<Id, String>();
            for (Integer i = 0; i < saves.size(); i++) {
                if (!saves[i].isSuccess()) {
                    failures.put(updates[i].Id, saves[i].getErrors()[0].getMessage());
                }
            }
            if (failures.isEmpty()) {
                return;
            }
            Set<Id> governed = new Policy().stillGoverned(failures.keySet());
            for (CheckResult result : results) {
                if (governed.contains(result.governanceId) && failures.containsKey(result.governanceId)) {
                    result.message =
                        (result.message == null ? '' : result.message + ' ') +
                        'The result couldn\'t be saved: ' +
                        failures.get(result.governanceId);
                    result.outcome = 'error';
                }
            }
        }

        // Reads an org's flows and recent activations. Nothing is locked yet.
        public void read(String connection, List<Flow_Governance__c> records) {
            OrgState org = new OrgState();
            org.connection = connection;
            org.records = records;
            org.readAt = System.now();
            Datetime since = org.readAt.addDays(-1);
            try {
                org.client = new FlowToolingClient(connection);
                List<String> names = new List<String>();
                Set<String> seen = new Set<String>();
                for (Flow_Governance__c record : records) {
                    String name = new FlowToolingClient.FlowName(record.Flow_Api_Name__c).developerName;
                    if (seen.add(name)) {
                        names.add('\'' + name + '\'');
                    }
                    if (record.Last_Checked__c != null && record.Last_Checked__c.addMinutes(-5) < since) {
                        since = record.Last_Checked__c.addMinutes(-5);
                    }
                }
                for (Integer i = 0; i < names.size(); i += NAMES_PER_QUERY) {
                    List<String> chunk = new List<String>();
                    for (Integer j = i; j < Math.min(i + NAMES_PER_QUERY, names.size()); j++) {
                        chunk.add(names[j]);
                    }
                    for (
                        Map<String, Object> definition : org.client.toolingQuery(
                            'SELECT Id, DeveloperName, NamespacePrefix, ManageableState, ActiveVersion.VersionNumber' +
                                ' FROM FlowDefinition WHERE DeveloperName IN (' +
                                String.join(chunk, ',') +
                                ')'
                        )
                    ) {
                        org.byApiName.put(FlowToolingClient.apiNameOf(definition), definition);
                        String developerName = (String) definition.get('DeveloperName');
                        if (
                            String.isNotBlank((String) definition.get('NamespacePrefix')) &&
                            FlowToolingClient.isOwned(definition) &&
                            !org.byDeveloperName.containsKey(developerName)
                        ) {
                            org.byDeveloperName.put(developerName, definition);
                        }
                    }
                }
            } catch (Exception e) {
                for (Flow_Governance__c record : records) {
                    finish(record, result(record, 'error', 'Couldn\'t reach the org: ' + e.getMessage()), null);
                }
                return;
            }
            // Only a flow no longer on its approved version needs to know who
            // activated it, so an org where every flow is as approved skips
            // the audit trail. Mode isn't considered: it may change before enforcing.
            Set<String> drifting = new Set<String>();
            for (Flow_Governance__c record : records) {
                Map<String, Object> definition = org.definitionFor(record);
                if (definition == null || record.Approved_Version__c == null) {
                    continue;
                }
                Integer active = FlowToolingClient.intPath(definition, 'ActiveVersion.VersionNumber');
                if ((active == null ? 0 : active) != record.Approved_Version__c.intValue()) {
                    drifting.add(FlowToolingClient.apiNameOf(definition));
                    drifting.add((String) definition.get('DeveloperName'));
                }
            }
            if (drifting.isEmpty()) {
                orgs.add(org);
                return;
            }
            try {
                for (
                    Map<String, Object> entry : org.client.query(
                        'SELECT Action, Display, CreatedById, CreatedBy.Name, CreatedDate FROM SetupAuditTrail' +
                            ' WHERE CreatedDate >= ' +
                            since.formatGmt('yyyy-MM-dd\'T\'HH:mm:ss\'Z\'') +
                            ' AND Action IN (\'' +
                            ACTIVATED_ACTION +
                            '\', \'' +
                            DEACTIVATED_ACTION +
                            '\') ORDER BY CreatedDate DESC LIMIT 2000',
                        false
                    )
                ) {
                    String name = uniqueName((String) entry.get('Display'));
                    if (drifting.contains(name) && !org.latestChange.containsKey(name)) {
                        org.latestChange.put(name, entry);
                    }
                }
            } catch (Exception e) {
                // Locked flows are still enforced; only Watch needs to know who activated.
                org.auditError = e.getMessage();
            }
            orgs.add(org);
        }

        // Reread current governance before enforcing. The committed operation
        // claim, not these row locks, spans the reversion callouts.
        public void enforce() {
            Set<Id> ids = new Set<Id>();
            for (OrgState org : orgs) {
                for (Flow_Governance__c record : org.records) {
                    ids.add(record.Id);
                }
            }
            Map<Id, Flow_Governance__c> current;
            try {
                current = new Policy().lockToEnforce(ids);
            } catch (QueryException e) {
                for (OrgState org : orgs) {
                    for (Flow_Governance__c record : org.records) {
                        results.add(
                            result(
                                record,
                                'skipped',
                                'A decision on this flow was in progress. The next check covers it.'
                            )
                        );
                    }
                }
                return;
            }
            for (OrgState org : orgs) {
                for (Flow_Governance__c original : org.records) {
                    Flow_Governance__c record = current.get(original.Id);
                    if (record == null) {
                        continue;
                    }
                    if (record.Approved_Version__c != original.Approved_Version__c) {
                        // Approved while the org was being read, so what was read may predate it.
                        results.add(result(record, 'skipped', 'Changed during the check. The next check covers it.'));
                        continue;
                    }
                    Map<String, Object> definition = org.definitionFor(record);
                    Map<String, Object> change;
                    if (definition != null) {
                        change = org.latestChange.get(FlowToolingClient.apiNameOf(definition));
                        if (change == null) {
                            change = org.latestChange.get((String) definition.get('DeveloperName'));
                        }
                    }
                    Decimal approvedBefore = record.Approved_Version__c;
                    CheckResult outcome = flow(org, record, definition, change);
                    Flow_Governance__c changes = finish(
                        record,
                        outcome,
                        outcome.outcome != 'error' ? org.readAt : null
                    );
                    changes.Active_Version__c = record.Active_Version__c;
                    if (record.Approved_Version__c != approvedBefore) {
                        changes.Approved_Version__c = record.Approved_Version__c;
                    }
                }
            }
        }

        // Records a flow's result and what to save. An error leaves Last
        // Checked alone, so the next check reads activations from before it.
        Flow_Governance__c finish(Flow_Governance__c record, CheckResult outcome, Datetime checkedAt) {
            results.add(outcome);
            Flow_Governance__c changes = new Flow_Governance__c(
                Id = record.Id,
                Last_Attempt__c = System.now(),
                Last_Check_Outcome__c = outcome.outcome,
                Last_Check_Message__c = outcome.message == null ? null : outcome.message.abbreviate(255)
            );
            if (checkedAt != null) {
                changes.Last_Checked__c = checkedAt;
            }
            updates.add(changes);
            return changes;
        }

        CheckResult flow(
            OrgState org,
            Flow_Governance__c record,
            Map<String, Object> definition,
            Map<String, Object> change
        ) {
            if (definition == null) {
                return result(record, 'missing', 'The flow no longer exists.');
            }
            Integer active = FlowToolingClient.intPath(definition, 'ActiveVersion.VersionNumber');
            active = active == null ? 0 : active;
            Integer approved = record.Approved_Version__c == null ? null : record.Approved_Version__c.intValue();
            record.Active_Version__c = active;

            if (record.Mode__c == MODE_OFF) {
                // Nothing is enforced; the approved version follows the active one.
                record.Approved_Version__c = active;
                return result(record, 'off', null);
            }
            if (approved == null) {
                record.Approved_Version__c = active;
                events.add(
                    governanceEvent(
                        record,
                        'Baseline Recorded',
                        null,
                        active,
                        null,
                        'Approved version set to the active one.'
                    )
                );
                return result(record, 'baseline', null);
            }
            if (active == approved) {
                return result(record, 'ok', null);
            }
            if (record.Mode__c == MODE_WATCH && org.auditError != null) {
                // Without the audit trail there's no telling whether the owner activated it.
                return result(
                    record,
                    'error',
                    'Version ' +
                        active +
                        ' is active, but who activated it couldn\'t be read from the Setup Audit Trail: ' +
                        org.auditError
                );
            }

            // An older activation (or a different version/action) cannot name
            // the actor responsible for the state we just read.
            if (!matchesActivation(change, active, record.Last_Checked__c))
                change = null;
            // Only this org's users can be the owner. In another org the actor
            // is someone there, known by name only, and never the owner.
            Boolean local = FlowToolingClient.isLocal(org.connection);
            Id actor = local && change != null ? toUserId((String) change.get('CreatedById')) : null;
            String actorName = change == null ? null : (String) FlowToolingClient.path(change, 'CreatedBy.Name');
            if (record.Mode__c == MODE_WATCH && actor != null && actor == record.Owner_User__c) {
                record.Approved_Version__c = active;
                events.add(governanceEvent(record, 'Owner Activation Accepted', actor, active, approved, null));
                return result(record, 'accepted', 'The owner activated version ' + active + '.');
            }

            String actorText = actorName == null ? '' : ' by ' + actorName;
            events.add(
                governanceEvent(
                    record,
                    'Unapproved Activation',
                    actor,
                    active,
                    approved,
                    (active == 0
                            ? 'The flow was deactivated'
                            : 'Version ' + active + ' was activated without approval') +
                        (actor == null ? actorText : '') +
                        '.'
                )
            );
            try {
                if (Limits.getCallouts() >= Limits.getLimitCallouts()) {
                    throw new GovernanceException('Too many flows to revert in one check. The next check continues.');
                }
                org.client.activate((String) definition.get('Id'), approved);
                record.Active_Version__c = approved;
                events.add(governanceEvent(record, 'Reverted', null, approved, active, null));
                alert(
                    record,
                    'Reverted an unapproved activation: ' + record.Name,
                    (active == 0 ? 'The flow was deactivated' : 'Version ' + active + ' was activated') +
                        ' without approval' +
                        actorText +
                        '. Version ' +
                        approved +
                        ' is active again.'
                );
                return result(record, 'reverted', 'Reverted version ' + active + ' to version ' + approved + '.');
            } catch (Exception e) {
                events.add(governanceEvent(record, 'Revert Failed', null, approved, active, e.getMessage()));
                alert(
                    record,
                    'Couldn\'t revert an unapproved activation: ' + record.Name,
                    'Version ' + active + ' is active without approval. ' + e.getMessage()
                );
                return result(record, 'revertFailed', e.getMessage());
            }
        }

        void alert(Flow_Governance__c record, String title, String body) {
            if (record.Owner_User__c != null) {
                alerts.add(
                    new Map<String, Object>{
                        'to' => new Set<String>{ record.Owner_User__c },
                        'title' => title,
                        'body' => body,
                        'target' => governedPage(record)
                    }
                );
            }
        }
    }

    private static Boolean matchesActivation(Map<String, Object> change, Integer active, Datetime checkedAt) {
        if (change == null)
            return false;
        if (checkedAt != null) {
            Object created = change.get('CreatedDate');
            if (
                created == null ||
                (Datetime) JSON.deserialize(JSON.serialize(created), Datetime.class) <
                checkedAt.addSeconds(-CHECKPOINT_OVERLAP_SECONDS)
            )
                return false;
        }
        if (active == 0)
            return change.get('Action') == DEACTIVATED_ACTION;
        String display = (String) change.get('Display');
        return change.get('Action') == ACTIVATED_ACTION &&
            display != null &&
            display.startsWith('Activated flow version #' + active + ' ');
    }

    // 'Activated flow version #2 "Label" for flow with Unique Name "Name"' → Name
    @TestVisible
    private static String uniqueName(String display) {
        if (display == null) {
            return null;
        }
        // Labels are user-controlled and can contain a forged marker. Only the
        // final API-name suffix belongs to Salesforce's audit-entry structure.
        Matcher m = Pattern.compile(' for flow with Unique Name "([A-Za-z][A-Za-z0-9_]*)"$').matcher(display);
        return m.find() ? m.group(1) : null;
    }

    @TestVisible
    private static Id toUserId(String value) {
        return value != null && Pattern.matches('005[A-Za-z0-9]{12}([A-Za-z0-9]{3})?', value)
            ? Id.valueOf(value)
            : null;
    }

    private static CheckResult result(Flow_Governance__c record, String outcome, String message) {
        CheckResult r = new CheckResult();
        r.governanceId = record.Id;
        r.apiName = record.Flow_Api_Name__c;
        r.connection = FlowToolingClient.normalizeConnection(record.Connection__c);
        r.outcome = outcome;
        r.activeVersion = record.Active_Version__c == null ? null : record.Active_Version__c.intValue();
        r.approvedVersion = record.Approved_Version__c == null ? null : record.Approved_Version__c.intValue();
        r.message = message;
        return r;
    }

    private static Flow_Audit_Event__c governanceEvent(
        Flow_Governance__c record,
        String type,
        Id actor,
        Integer version,
        Integer previous,
        String details
    ) {
        return new Flow_Audit_Event__c(
            Flow_Api_Name__c = record.Flow_Api_Name__c,
            Connection__c = record.Connection__c,
            Event_Type__c = type,
            Actor__c = actor,
            Version_Number__c = version,
            Previous_Version__c = previous,
            Details__c = details
        );
    }

    private static Flow_Audit_Event__c event(
        Flow_Activation_Request__c request,
        String type,
        Id actor,
        String details
    ) {
        return new Flow_Audit_Event__c(
            Flow_Api_Name__c = request.Flow_Api_Name__c,
            Connection__c = request.Connection__c,
            Event_Type__c = type,
            Actor__c = actor,
            Version_Number__c = request.Version_Number__c,
            Request__c = request.Id,
            Details__c = details
        );
    }

    /** Records that a version or flow was saved by the app. */
    public static void recordSave(String connection, String apiName, Integer version, Boolean newFlow, String details) {
        audit(
            new List<Flow_Audit_Event__c>{
                new Flow_Audit_Event__c(
                    Flow_Api_Name__c = apiName,
                    Connection__c = storedConnection(connection),
                    Event_Type__c = newFlow ? 'Flow Created' : 'Version Saved',
                    Actor__c = UserInfo.getUserId(),
                    Version_Number__c = version,
                    Details__c = details
                )
            }
        );
    }

    // Audit events are the app's record of what happened, so no user may
    // write them, not even an admin (both permission sets grant read only).
    // They're written in system mode for every action that makes one.
    private static void audit(List<Flow_Audit_Event__c> events) {
        if (!events.isEmpty()) {
            Database.insert(events, AccessLevel.SYSTEM_MODE);
        }
    }

    private static String describe(Flow_Activation_Request__c request) {
        return (String.isBlank(request.Flow_Label__c) ? request.Flow_Api_Name__c : request.Flow_Label__c) +
            ' v' +
            request.Version_Number__c.intValue();
    }

    private static String suffix(String comments) {
        return String.isBlank(comments) ? '' : ' "' + comments.abbreviate(300) + '"';
    }

    // Modes as the app names them; the stored values stay the same.
    private static String modeLabel(String mode) {
        return mode == MODE_WATCH ? 'Owner only' : mode == MODE_LOCKED ? 'Approval required' : mode;
    }

    private static String ownerName(Id userId) {
        return userId == null ? 'none' : userName(userId);
    }

    private static String userName(Id userId) {
        if (!userNames.containsKey(userId)) {
            List<User> users = [SELECT Name FROM User WHERE Id = :userId WITH SYSTEM_MODE LIMIT 1];
            userNames.put(userId, users.isEmpty() ? String.valueOf(userId) : users[0].Name);
        }
        return userNames.get(userId);
    }
    private static Map<Id, String> userNames = new Map<Id, String>();

    // The notification opens a Compare Flows tab (named with this package's namespace).
    private static String appPage(String tab, Map<String, String> state) {
        return JSON.serialize(
            new Map<String, Object>{
                'type' => 'standard__navItemPage',
                'attributes' => new Map<String, Object>{ 'apiName' => NAMESPACE_PREFIX + tab },
                'state' => state
            }
        );
    }

    private static String governedPage(Flow_Governance__c record) {
        return appPage(
            'Governed_Flows',
            new Map<String, String>{ 'c__flow' => record.Flow_Api_Name__c, 'c__conn' => record.Connection__c }
        );
    }

    private static void notify(Set<String> recipients, String title, String body, String pageRef) {
        sentNotifications.add(
            new Map<String, Object>{ 'to' => recipients, 'title' => title, 'body' => body, 'target' => pageRef }
        );
        Id typeId = notificationTypeId();
        if (typeId == null || recipients.isEmpty()) {
            return;
        }
        Messaging.CustomNotification notification = new Messaging.CustomNotification();
        notification.setNotificationTypeId(typeId);
        notification.setTitle(title.abbreviate(250));
        notification.setBody(body.abbreviate(750));
        notification.setTargetPageRef(pageRef);
        try {
            notification.send(recipients);
        } catch (Exception e) {
            // A failed notification must not undo the decision it reports.
            System.debug(LoggingLevel.WARN, 'Flow governance notification failed: ' + e.getMessage());
        }
    }

    // The package's own notification type, looked up once per transaction.
    private static Id notificationTypeId() {
        if (notificationType == null) {
            for (CustomNotificationType type : [
                SELECT Id
                FROM CustomNotificationType
                WHERE DeveloperName = :NOTIFICATION_TYPE AND NamespacePrefix = :NAMESPACE
                WITH SYSTEM_MODE
                LIMIT 1
            ]) {
                notificationType = type.Id;
            }
        }
        return notificationType;
    }
    private static Id notificationType;
}
