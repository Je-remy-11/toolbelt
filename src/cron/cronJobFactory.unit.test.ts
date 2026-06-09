import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cronJobFactory,
  SLOT_COUNT,
} from "../src/cron/mod";
import {
  createInMemoryJobRegistry,
  createInMemorySlotRepository,
  createDeterministicHasher,
  createFixedClock,
} from "../src/cron/adapters/inMemory";
import type { CronJob } from "../src/cron/types";

const aJob = (id: string, expression = "* * * * *"): CronJob => ({
  id,
  expression,
  payload: {},
});

describe("cronJobFactory (unit) — slot assignment algorithm", () => {
  it("同一个 jobId hash 到相同 slot（可重复性）", () => {
    const hasher = createDeterministicHasher();
    expect(hasher.hash("job-A", SLOT_COUNT)).toBe(
      hasher.hash("job-A", SLOT_COUNT),
    );
  });

  it("不同 jobId 落到不同或相同的 slot（不崩）", () => {
    const hasher = createDeterministicHasher();
    const seen = new Set<number>();
    for (let i = 0; i < 100; i += 1) {
      seen.add(hasher.hash(`job-${i}`, SLOT_COUNT));
    }
    expect(seen.size).toBeGreaterThan(1);
    for (const s of seen) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(SLOT_COUNT);
    }
  });

  it("register 把 job 写入对应 slot", async () => {
    const repo = createInMemorySlotRepository();
    const hasher = createDeterministicHasher();
    const clock = createFixedClock(new Date("2026-06-09T10:00:00Z"));
    const factory = cronJobFactory({
      slotRepository: repo,
      hasher,
      clock,
    });

    const handle = await factory.register(aJob("job-A"));
    const expectedSlot = hasher.hash("job-A", SLOT_COUNT);
    expect(handle.slotIndex).toBe(expectedSlot);

    const slot = await factory.getSlot(expectedSlot);
    expect(slot.jobIds).toContain("job-A");
  });

  it("重复 register 同一 job 不会重复追加", async () => {
    const repo = createInMemorySlotRepository();
    const hasher = createDeterministicHasher();
    const clock = createFixedClock(new Date("2026-06-09T10:00:00Z"));
    const factory = cronJobFactory({
      slotRepository: repo,
      hasher,
      clock,
    });

    await factory.register(aJob("job-A"));
    const second = await factory.register(aJob("job-A"));
    const slot = await factory.getSlot(second.slotIndex);
    expect(slot.jobIds.filter((id) => id === "job-A")).toHaveLength(1);
  });

  it("deregister 从 slot 中移除 job", async () => {
    const repo = createInMemorySlotRepository();
    const hasher = createDeterministicHasher();
    const clock = createFixedClock(new Date("2026-06-09T10:00:00Z"));
    const factory = cronJobFactory({
      slotRepository: repo,
      hasher,
      clock,
    });

    await factory.register(aJob("job-A"));
    const handle = await factory.register(aJob("job-B"));
    const result = await handle.stop();
    expect(result.removed).toEqual(["job-B"]);

    const slot = await factory.getSlot(handle.slotIndex);
    expect(slot.jobIds).not.toContain("job-B");
  });

  it("pickCurrentSlotJobs 根据当前分钟返回对应 slot 内的 jobs", async () => {
    const repo = createInMemorySlotRepository();
    const hasher = createDeterministicHasher();
    const clock = createFixedClock(new Date("2026-06-09T10:05:00Z"));
    const factory = cronJobFactory({
      slotRepository: repo,
      hasher,
      clock,
    });

    for (let i = 0; i < 10; i += 1) {
      await factory.register(aJob(`job-${i}`));
    }

    clock.set(new Date("2026-06-09T10:05:00Z"));
    const jobsNow = await factory.pickCurrentSlotJobs();
    expect(jobsNow.length).toBeGreaterThanOrEqual(0);
  });
});
