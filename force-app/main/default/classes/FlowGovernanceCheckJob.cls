/** Checks a slice of governed flows and queues the next; see FlowGovernanceOperation. */
public with sharing class FlowGovernanceCheckJob implements Queueable, Database.AllowsCallouts {
    private Id operationId;

    public FlowGovernanceCheckJob(Id operationId) {
        this.operationId = operationId;
    }

    public void execute(QueueableContext context) {
        FlowGovernanceOperation.executeOperation(operationId, context.getJobId());
    }
}
