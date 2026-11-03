/**
 * Stands in for the Tooling and REST APIs in tests. Routes match on method
 * and a fragment of the decoded endpoint, in the order they were added.
 */
@IsTest
public class FlowCompareTestMock implements HttpCalloutMock {
    public static final String DEFINITION_ID = '300000000000001AAA';
    public static final String VERSION_ID = '301000000000001AAA';

    private class Route {
        String method;
        String fragment;
        Integer status;
        String body;
        Integer times;
    }

    private final List<Route> routes = new List<Route>();
    public final List<HttpRequest> requests = new List<HttpRequest>();

    public FlowCompareTestMock route(String method, String fragment, Integer status, Object body) {
        return route(method, fragment, status, body, -1);
    }

    /** A route used at most times times; -1 means always. */
    public FlowCompareTestMock route(String method, String fragment, Integer status, Object body, Integer times) {
        Route route = new Route();
        route.method = method;
        route.fragment = fragment;
        route.status = status;
        route.body = body == null ? '' : body instanceof String ? (String) body : JSON.serialize(body);
        route.times = times;
        routes.add(route);
        return this;
    }

    public HttpResponse respond(HttpRequest request) {
        requests.add(request);
        String endpoint = EncodingUtil.urlDecode(request.getEndpoint(), 'UTF-8');
        HttpResponse response = new HttpResponse();
        response.setHeader('Content-Type', 'application/json');
        for (Route route : routes) {
            if (route.method == request.getMethod() && endpoint.contains(route.fragment) && route.times != 0) {
                route.times--;
                response.setStatusCode(route.status);
                response.setBody(route.body);
                return response;
            }
        }
        response.setStatusCode(404);
        response.setBody(
            JSON.serialize(
                new List<Object>{
                    new Map<String, Object>{
                        'message' => 'No mock for ' +
                        request.getMethod() +
                        ' ' +
                        endpoint,
                        'errorCode' => 'NOT_FOUND'
                    }
                }
            )
        );
        return response;
    }

    public Integer count(String method, String fragment) {
        Integer n = 0;
        for (HttpRequest request : requests) {
            if (
                request.getMethod() == method &&
                EncodingUtil.urlDecode(request.getEndpoint(), 'UTF-8').contains(fragment)
            ) {
                n++;
            }
        }
        return n;
    }

    public static Map<String, Object> page(List<Object> records) {
        return new Map<String, Object>{ 'done' => true, 'totalSize' => records.size(), 'records' => records };
    }

    public static Map<String, Object> definition(
        String developerName,
        Integer active,
        Integer latest,
        Id lastModifiedBy
    ) {
        return new Map<String, Object>{
            'Id' => DEFINITION_ID,
            'DeveloperName' => developerName,
            'NamespacePrefix' => null,
            'ActiveVersionId' => active == null ? null : VERSION_ID,
            'LatestVersionId' => VERSION_ID,
            'ActiveVersion' => active == null ? null : new Map<String, Object>{ 'VersionNumber' => active },
            'LatestVersion' => new Map<String, Object>{
                'VersionNumber' => latest,
                'MasterLabel' => developerName.replace('_', ' '),
                'ProcessType' => 'AutoLaunchedFlow'
            },
            'LastModifiedById' => lastModifiedBy,
            'LastModifiedDate' => '2026-09-01T10:00:00.000+0000',
            'LastModifiedBy' => new Map<String, Object>{ 'Name' => 'Someone' }
        };
    }

    public static Map<String, Object> auditEntry(String developerName, Integer version, Id actor) {
        return new Map<String, Object>{
            'Action' => 'activatedinteractiondefversion',
            'Display' => 'Activated flow version #' +
            version +
            ' "' +
            developerName +
            '" for flow with Unique Name "' +
            developerName +
            '"',
            'CreatedById' => actor,
            'CreatedBy' => actor == null
                ? null
                : new Map<String, Object>{ 'Name' => [SELECT Name FROM User WHERE Id = :actor WITH SYSTEM_MODE].Name },
            'CreatedDate' => '2026-09-01T10:00:00.000+0000'
        };
    }

    public static List<Object> error(String message, String code) {
        return new List<Object>{ new Map<String, Object>{ 'message' => message, 'errorCode' => code } };
    }

    /** A System Administrator with the named Tributary permission sets. */
    public static User user(String alias, List<String> permissionSets) {
        Profile admin = [
            SELECT Id
            FROM Profile
            WHERE PermissionsModifyAllData = TRUE AND UserType = 'Standard'
            ORDER BY CreatedDate
            LIMIT 1
        ];
        return user(alias, admin.Id, permissionSets);
    }

    /**
     * An ordinary user with the named permission sets: no View All Data and
     * no Manage Flow, so tests see what the permission sets alone allow.
     */
    public static User plainUser(String alias, List<String> permissionSets) {
        Profile standard = [
            SELECT Id
            FROM Profile
            WHERE Name IN ('Standard User', 'Minimum Access - Salesforce')
            ORDER BY Name DESC
            LIMIT 1
        ];
        return user(alias, standard.Id, permissionSets);
    }

    private static User user(String alias, Id profileId, List<String> permissionSets) {
        User u = new User(
            Alias = alias,
            LastName = 'Tributary ' + alias,
            Email = alias + '@example.com',
            Username = alias + '.' + UserInfo.getOrganizationId() + '@flowcompare.test',
            ProfileId = profileId,
            TimeZoneSidKey = 'America/Los_Angeles',
            LocaleSidKey = 'en_US',
            EmailEncodingKey = 'UTF-8',
            LanguageLocaleKey = 'en_US'
        );
        insert u;
        List<PermissionSetAssignment> assignments = new List<PermissionSetAssignment>();
        for (PermissionSet permissionSet : [SELECT Id FROM PermissionSet WHERE Name IN :permissionSets]) {
            assignments.add(new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = permissionSet.Id));
        }
        insert assignments;
        return u;
    }

    /**
     * Gives the user running the tests the named permission sets, as the admin
     * who installed Tributary has. A new org, like a package build org, grants
     * its admin nothing on Tributary's fields. The grant only takes effect
     * inside System.runAs(installer()).
     */
    public static void grantRunningUser(List<String> permissionSets) {
        Id me = UserInfo.getUserId();
        List<PermissionSetAssignment> assignments = new List<PermissionSetAssignment>();
        for (PermissionSet permissionSet : [
            SELECT Id
            FROM PermissionSet
            WHERE
                Name IN :permissionSets
                AND Id NOT IN (SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = :me)
        ]) {
            assignments.add(new PermissionSetAssignment(AssigneeId = me, PermissionSetId = permissionSet.Id));
        }
        insert assignments;
    }

    /** The user running the tests, with what grantRunningUser gave them. */
    public static User installer() {
        return new User(Id = UserInfo.getUserId());
    }

    public static User find(String alias) {
        return [SELECT Id, Name FROM User WHERE Alias = :alias AND LastName LIKE 'Tributary %' LIMIT 1];
    }
}
