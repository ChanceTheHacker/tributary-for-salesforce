import {
  cachedRead,
  forgetGovernance,
  governanceChange
} from "c/flowGovernanceCache";

afterEach(() => {
  forgetGovernance();
  jest.useRealTimers();
});

it("shares a read while it's out and for a minute after", async () => {
  jest.useFakeTimers({ now: 0 });
  const read = jest.fn(({ id }) => Promise.resolve({ id }));
  const first = cachedRead("thing", read, { id: 1 });
  expect(cachedRead("thing", read, { id: 1 })).toBe(first);
  expect(await first).toEqual({ id: 1 });
  jest.setSystemTime(59000);
  expect(cachedRead("thing", read, { id: 1 })).toBe(first);
  expect(read).toHaveBeenCalledTimes(1);

  // Other parameters, or another read, are asked for separately.
  cachedRead("thing", read, { id: 2 });
  cachedRead("other", read, { id: 1 });
  expect(read).toHaveBeenCalledTimes(3);

  // A minute on, it's read again.
  jest.setSystemTime(61000);
  expect(cachedRead("thing", read, { id: 1 })).not.toBe(first);
  expect(read).toHaveBeenCalledTimes(4);
});

it("reads afresh when asked, and keeps the new answer", async () => {
  const read = jest
    .fn()
    .mockResolvedValueOnce("old")
    .mockResolvedValueOnce("new");
  await cachedRead("thing", read, {});
  expect(await cachedRead("thing", read, {}, true)).toBe("new");
  expect(await cachedRead("thing", read, {})).toBe("new");
  expect(read).toHaveBeenCalledTimes(2);
});

it("doesn't keep a failure", async () => {
  const read = jest
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce("back");
  await expect(cachedRead("thing", read, {})).rejects.toThrow("offline");
  expect(await cachedRead("thing", read, {})).toBe("back");
});

it("forgets everything around a change, even one that fails", async () => {
  const read = jest.fn().mockResolvedValue("answer");
  await cachedRead("thing", read, {});
  let during;
  await expect(
    governanceChange(async () => {
      // A read made while the change is under way doesn't outlive it.
      during = cachedRead("thing", read, {});
      await during;
      throw new Error("refused");
    })
  ).rejects.toThrow("refused");
  expect(read).toHaveBeenCalledTimes(2);
  expect(cachedRead("thing", read, {})).not.toBe(during);
  expect(read).toHaveBeenCalledTimes(3);
  expect(await governanceChange(() => Promise.resolve(7))).toBe(7);
});

it("lets go of old reads, and keeps no more than fifty", () => {
  jest.useFakeTimers({ now: 0 });
  const read = jest.fn((params) => Promise.resolve(params));
  const first = cachedRead("history", read, { page: 0 });
  for (let page = 1; page <= 50; page++) {
    cachedRead("history", read, { page });
  }
  // The oldest of fifty-one went; the newest are still shared.
  expect(cachedRead("history", read, { page: 50 })).toBe(
    cachedRead("history", read, { page: 50 })
  );
  expect(cachedRead("history", read, { page: 0 })).not.toBe(first);
  expect(read).toHaveBeenCalledTimes(52);

  // A minute on, the next read lets go of everything older.
  const kept = cachedRead("history", read, { page: 1 });
  jest.setSystemTime(61000);
  cachedRead("other", read, {});
  // Wound back, a read still in the minute would be shared if it were kept.
  jest.setSystemTime(0);
  expect(cachedRead("history", read, { page: 1 })).not.toBe(kept);
});
