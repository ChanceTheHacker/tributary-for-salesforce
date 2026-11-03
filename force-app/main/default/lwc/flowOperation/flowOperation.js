import getOperation from "@salesforce/apex/FlowGovernanceController.getOperation";

/**
 * Keep the original result shape; never mistake queue acceptance for activation.
 * `stopped` says when no one is waiting any more (the component went away):
 * polling ends, but the operation itself carries on.
 */
export async function waitForOperation(queued, stopped = () => false) {
  const marker = Array.isArray(queued) ? queued[0] : queued;
  if (!marker || !marker.operationId) {
    return queued;
  }
  const status = await finished(marker.operationId, stopped);
  return JSON.parse(status.result);
}

/**
 * A check's results and its counts. When a check covers many flows, its
 * results can leave out those that were fine; the counts are still exact:
 * flows attempted, succeeded and failed, and those left for the next check.
 */
export async function waitForCheck(queued, stopped = () => false) {
  const marker = Array.isArray(queued) ? queued[0] : queued;
  if (!marker || !marker.operationId) {
    return { results: queued || [] };
  }
  const status = await finished(marker.operationId, stopped);
  return {
    results: JSON.parse(status.result || "[]"),
    attempted: status.attempted,
    succeeded: status.succeeded,
    failed: status.failed,
    remaining: status.remaining
  };
}

// The operation's status once it has completed; its error if it failed.
async function finished(operationId, stopped) {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (stopped()) {
      throw new Error(
        `Stopped watching operation ${operationId}. It carries on; check activation history for its outcome.`
      );
    }
    let status;
    try {
      // Poll sequentially; overlapping requests would not advance the job.
      // eslint-disable-next-line no-await-in-loop
      status = await getOperation({ operationId });
    } catch (ignored) {
      throw new Error(
        `Cannot read the outcome of operation ${operationId}. It may still run. Check activation history or check results before submitting again.`
      );
    }
    if (status.state === "Completed") {
      return status;
    }
    if (status.state === "Failed") {
      throw new Error(status.error || "The governance operation failed.");
    }
    // eslint-disable-next-line no-await-in-loop, @lwc/lwc/no-async-operation
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `Operation ${operationId} is still queued or running; this is not a failure. Check activation history or check results before submitting again.`
  );
}
