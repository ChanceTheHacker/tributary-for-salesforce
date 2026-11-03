/**
 * Checks governed flows on a schedule. Scheduled Apex can't make callouts,
 * so each scheduled run queues FlowGovernanceCheckJob, which can.
 */
public with sharing class FlowGovernanceMonitor implements Schedulable {
    public static final String JOB_PREFIX = 'Tributary governance check';
    public static final Set<Integer> INTERVALS = new Set<Integer>{ 5, 10, 15, 20, 30, 60 };
    /** A check that finished, but couldn't check or revert some flows. */
    public static final String COMPLETED_WITH_ERRORS = 'Completed with errors';

    /** Whether checks are scheduled, and how the scheduled checks have gone. */
    public class Status {
        @AuraEnabled
        public Boolean scheduled;
        @AuraEnabled
        public Integer intervalMinutes;
        @AuraEnabled
        public Datetime nextRun;
        @AuraEnabled
        public Datetime lastRun;
        @AuraEnabled
        public String lastStatus;
        @AuraEnabled
        public String lastError;
        // A successful check finished, and read and enforced every flow it
        // tried: see FlowGovernanceService.FAILED_CHECKS.
        @AuraEnabled
        public Datetime lastSuccess;
        // How many flows the last check tried, and how many of those failed.
        @AuraEnabled
        public Integer lastChecked;
        @AuraEnabled
        public Integer lastFailed;
        // Governed flows the last check left for the next: another operation
        // held them, or they kept changing. 0 when it reached every flow.
        @AuraEnabled
        public Integer lastRemaining;
        @AuraEnabled
        public Boolean running;
        @AuraEnabled
        public String runningAs;
    }

    public void execute(SchedulableContext context) {
        FlowGovernanceOperation.scheduledCheck();
    }

    /** Schedules a check every intervalMinutes, replacing any existing schedule. */
    public static void start(Integer intervalMinutes) {
        FlowGovernanceService.requireAdmin();
        if (!INTERVALS.contains(intervalMinutes)) {
            throw new FlowGovernanceService.GovernanceException(
                'Choose an interval of 5, 10, 15, 20, 30 or 60 minutes.'
            );
        }
        stop();
        for (Integer minute = 0; minute < 60; minute += intervalMinutes) {
            System.schedule(
                JOB_PREFIX + ' :' + String.valueOf(minute).leftPad(2, '0'),
                '0 ' + minute + ' * * * ?',
                new FlowGovernanceMonitor()
            );
        }
    }

    public static void stop() {
        FlowGovernanceService.requireAdmin();
        for (CronTrigger job : scheduled()) {
            System.abortJob(job.Id);
        }
    }

    public static List<CronTrigger> scheduled() {
        String pattern = JOB_PREFIX + '%';
        return [
            SELECT Id, CronJobDetail.Name, NextFireTime, PreviousFireTime, State, OwnerId
            FROM CronTrigger
            WHERE CronJobDetail.Name LIKE :pattern
            WITH SYSTEM_MODE
            ORDER BY NextFireTime
        ];
    }

    public static Status status() {
        Status status = new Status();
        List<CronTrigger> jobs = scheduled();
        status.scheduled = !jobs.isEmpty();
        status.running = false;
        if (status.scheduled) {
            status.intervalMinutes = 60 / jobs.size();
            status.nextRun = jobs[0].NextFireTime;
            List<User> owners = [SELECT Name FROM User WHERE Id = :jobs[0].OwnerId WITH SYSTEM_MODE];
            status.runningAs = owners.isEmpty() ? null : owners[0].Name;
        }
        // Each check is an operation, whose counts say how it went.
        for (Flow_Operation__c operation : [
            SELECT State__c, Error__c, Job_Id__c, Attempted__c, Failed__c, Remaining__c, CreatedDate, LastModifiedDate
            FROM Flow_Operation__c
            WHERE Action__c = 'check' AND Key__c = NULL
            WITH SYSTEM_MODE
            ORDER BY CreatedDate DESC
            LIMIT 50
        ]) {
            Integer failed = operation.Failed__c == null ? 0 : operation.Failed__c.intValue();
            if (status.lastStatus == null) {
                describeLast(status, operation, failed);
            }
            if (operation.State__c == 'Completed' && failed == 0) {
                status.lastSuccess = operation.LastModifiedDate;
                break;
            }
        }
        return status;
    }

    private static void describeLast(Status status, Flow_Operation__c operation, Integer failed) {
        status.lastChecked = operation.Attempted__c?.intValue();
        status.lastFailed = operation.Attempted__c == null ? null : failed;
        status.lastRemaining = operation.Remaining__c?.intValue();
        if (operation.State__c == 'Queued') {
            // A job stopped outright leaves its operation queued until someone looks.
            List<AsyncApexJob> jobs = [
                SELECT Status, ExtendedStatus
                FROM AsyncApexJob
                WHERE Id = :operation.Job_Id__c
                WITH SYSTEM_MODE
            ];
            String job = jobs.isEmpty() ? null : jobs[0].Status;
            if (job == 'Aborted' || job == 'Failed') {
                status.lastRun = operation.LastModifiedDate;
                status.lastStatus = job;
                status.lastError = jobs[0].ExtendedStatus;
            } else {
                status.lastRun = operation.CreatedDate;
                status.lastStatus = 'Queued';
                status.running = true;
            }
            return;
        }
        status.lastRun = operation.LastModifiedDate;
        if (operation.State__c == 'Completed' && failed > 0) {
            status.lastStatus = COMPLETED_WITH_ERRORS;
            status.lastError =
                failed +
                ' of ' +
                operation.Attempted__c.intValue() +
                ' flows couldn\'t be checked or kept to their approved version. Governed Flows shows which.';
        } else {
            status.lastStatus = operation.State__c;
            status.lastError = operation.Error__c;
        }
    }
}
