import { waitForCheck, waitForOperation } from "c/flowOperation";
import getOperation from "@salesforce/apex/FlowGovernanceController.getOperation";

jest.mock(
  "@salesforce/apex/FlowGovernanceController.getOperation",
  () => ({ default: jest.fn() }),
  { virtual: true }
);

afterEach(() => {
  jest.resetAllMocks();
  jest.useRealTimers();
});

it("passes through an already completed synchronous response", async () => {
  const result = { status: "Activated" };
  expect(await waitForOperation(result)).toBe(result);
  expect(getOperation).not.toHaveBeenCalled();
});

it("waits for completion instead of treating queued acceptance as success", async () => {
  jest.useFakeTimers();
  getOperation
    .mockResolvedValueOnce({ state: "Queued" })
    .mockResolvedValueOnce({
      state: "Completed",
      result: '{"status":"Activated"}'
    });
  const promise = waitForOperation({ operationId: "op1" });
  await jest.advanceTimersByTimeAsync(1000);
  expect(await promise).toEqual({ status: "Activated" });
  expect(getOperation).toHaveBeenCalledTimes(2);
});

it("unwraps check results and reports a failed worker", async () => {
  getOperation
    .mockResolvedValueOnce({ state: "Completed", result: '[{"outcome":"ok"}]' })
    .mockResolvedValueOnce({ state: "Failed", error: "Access changed" });
  expect(await waitForOperation([{ operationId: "op1" }])).toEqual([
    { outcome: "ok" }
  ]);
  await expect(waitForOperation({ operationId: "op2" })).rejects.toThrow(
    "Access changed"
  );
});

it("does not claim a network error cancelled the operation", async () => {
  getOperation.mockRejectedValue(new Error("offline"));
  await expect(waitForOperation({ operationId: "op1" })).rejects.toThrow(
    "It may still run"
  );
});

it("bounds polling without declaring a queued job failed", async () => {
  jest.useFakeTimers();
  getOperation.mockResolvedValue({ state: "Queued" });
  const outcome = waitForOperation({ operationId: "op1" }).catch(
    (error) => error
  );
  await jest.advanceTimersByTimeAsync(180000);
  expect(await outcome).toEqual(
    expect.objectContaining({
      message: expect.stringContaining("this is not a failure")
    })
  );
  expect(getOperation).toHaveBeenCalledTimes(180);
});

it("stops polling when no one is waiting, without calling it a failure", async () => {
  jest.useFakeTimers();
  getOperation.mockResolvedValue({ state: "Queued" });
  let gone = false;
  const outcome = waitForOperation({ operationId: "op1" }, () => gone).catch(
    (error) => error
  );
  await jest.advanceTimersByTimeAsync(1000);
  gone = true;
  await jest.advanceTimersByTimeAsync(10000);
  const error = await outcome;
  expect(error.message).toContain("It carries on");
  expect(getOperation).toHaveBeenCalledTimes(2);
});

it("gives a check's exact counts with the results it kept", async () => {
  getOperation.mockResolvedValueOnce({
    state: "Completed",
    result: '[{"outcome":"reverted"}]',
    attempted: 120,
    succeeded: 117,
    failed: 1,
    remaining: 3
  });
  expect(await waitForCheck([{ operationId: "op1" }])).toEqual({
    results: [{ outcome: "reverted" }],
    attempted: 120,
    succeeded: 117,
    failed: 1,
    remaining: 3
  });
  // Results answered at once have no counts.
  expect(await waitForCheck([{ outcome: "ok" }])).toEqual({
    results: [{ outcome: "ok" }]
  });
});
