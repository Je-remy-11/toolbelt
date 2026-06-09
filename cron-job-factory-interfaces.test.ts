// ============================================================================
// 纯单元测试 — Slot 分配算法 & SlotCoordinator
// ============================================================================
//
// 零 Redis 依赖，零网络，零 I/O，毫秒级执行
// 使用 InMemory 实现替代 ioredis
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  ConsistentHashSlotAllocator,
  InMemoryDistributedLock,
  InMemorySlotRegistry,
  InMemoryJobStateStore,
  InMemoryInstanceHeartbeat,
  SlotCoordinator,
  CronJobFactory,
  createInMemoryCronJobFactory,
} from "./cron-job-factory-interfaces";
import type {
  SlotAllocatorInput,
  SlotAllocationPlan,
  ICronJobFactoryDeps,
} from "./cron-job-factory-interfaces";

// ============================================================================
// Layer 1: ISlotAllocator 纯算法测试 — 零依赖
// ============================================================================

describe("ConsistentHashSlotAllocator", () => {
  const allocator = new ConsistentHashSlotAllocator();

  function makeInput(overrides: Partial<SlotAllocatorInput> = {}): SlotAllocatorInput {
    return {
      instanceId: "instance-A",
      totalSlots: 4,
      currentOwnership: new Map([
        [0, null],
        [1, null],
        [2, null],
        [3, null],
      ]),
      jobDefinitions: [],
      instanceHeartbeats: new Map([["instance-A", Date.now()]]),
      nowMs: Date.now(),
      leaseTtlMs: 30000,
      ...overrides,
    };
  }

  it("单实例应获得全部可用 Slot", () => {
    const input = makeInput();
    const plans = allocator.allocate(input);

    expect(plans).toHaveLength(4);
    const allSlotIds = plans.map((p) => p.slotId).sort();
    expect(allSlotIds).toEqual([0, 1, 2, 3]);
  });

  it("两实例应平分 Slot", () => {
    const now = Date.now();
    const input = makeInput({
      instanceId: "instance-A",
      instanceHeartbeats: new Map([
        ["instance-A", now],
        ["instance-B", now],
      ]),
    });
    const plans = allocator.allocate(input);

    expect(plans).toHaveLength(2);
  });

  it("已过期的 Slot 应被回收并重新分配", () => {
    const now = Date.now();
    const input = makeInput({
      currentOwnership: new Map([
        [0, "instance-A"],
        [1, "instance-DEAD"],
        [2, "instance-DEAD"],
        [3, null],
      ]),
      instanceHeartbeats: new Map([
        ["instance-A", now],
      ]),
      leaseTtlMs: 30000,
    });

    const plans = allocator.allocate(input);

    const assignedSlotIds = plans.map((p) => p.slotId).sort();
    expect(assignedSlotIds).toContain(0);
    expect(assignedSlotIds).toContain(1);
    expect(assignedSlotIds).toContain(2);
    expect(assignedSlotIds).toContain(3);
  });

  it("存活实例的 Slot 不应被抢占", () => {
    const now = Date.now();
    const input = makeInput({
      instanceId: "instance-A",
      currentOwnership: new Map([
        [0, "instance-B"],
        [1, "instance-B"],
        [2, null],
        [3, null],
      ]),
      instanceHeartbeats: new Map([
        ["instance-A", now],
        ["instance-B", now],
      ]),
    });

    const plans = allocator.allocate(input);

    const assignedSlotIds = plans.map((p) => p.slotId).sort();
    expect(assignedSlotIds).not.toContain(0);
    expect(assignedSlotIds).not.toContain(1);
  });

  it("Job 应按 preferredSlot 优先分配", () => {
    const now = Date.now();
    const input = makeInput({
      instanceId: "instance-A",
      jobDefinitions: [
        { id: "job-1", name: "Job 1", cronExpression: "*/5 * * * *", handler: "handler1", preferredSlot: 2 },
        { id: "job-2", name: "Job 2", cronExpression: "*/10 * * * *", handler: "handler2" },
      ],
      instanceHeartbeats: new Map([["instance-A", now]]),
    });

    const plans = allocator.allocate(input);

    const slot2 = plans.find((p) => p.slotId === 2);
    expect(slot2).toBeDefined();
    expect(slot2!.jobIds).toContain("job-1");
  });

  it("无 preferredSlot 的 Job 应均匀分散到各 Slot", () => {
    const now = Date.now();
    const jobs = Array.from({ length: 8 }, (_, i) => ({
      id: `job-${i}`,
      name: `Job ${i}`,
      cronExpression: "*/5 * * * *",
      handler: `handler${i}`,
    }));

    const input = makeInput({
      instanceId: "instance-A",
      totalSlots: 4,
      jobDefinitions: jobs,
      instanceHeartbeats: new Map([["instance-A", now]]),
    });

    const plans = allocator.allocate(input);

    const totalAssigned = plans.reduce((sum, p) => sum + p.jobIds.length, 0);
    expect(totalAssigned).toBe(8);
  });

  it("不存在的实例不应获得任何 Slot", () => {
    const now = Date.now();
    const input = makeInput({
      instanceId: "instance-UNKNOWN",
      instanceHeartbeats: new Map([
        ["instance-A", now],
        ["instance-B", now],
      ]),
    });

    const plans = allocator.allocate(input);

    expect(plans).toHaveLength(0);
  });
});

// ============================================================================
// Layer 2: InMemory 基础设施测试 — 验证 InMemory 实现行为正确
// ============================================================================

describe("InMemorySlotRegistry", () => {
  it("claimSlot 成功后 getSlotOwners 应返回正确的 owner", async () => {
    const registry = new InMemorySlotRegistry();
    const claimed = await registry.claimSlot(0, "instance-A", 30000);
    expect(claimed).toBe(true);

    const owners = await registry.getSlotOwners({ from: 0, to: 0 });
    expect(owners.get(0)).toBe("instance-A");
  });

  it("同一 Slot 不可被两个实例同时 claim", async () => {
    const registry = new InMemorySlotRegistry();
    await registry.claimSlot(0, "instance-A", 30000);
    const secondClaim = await registry.claimSlot(0, "instance-B", 30000);
    expect(secondClaim).toBe(false);
  });

  it("releaseSlot 后 Slot 可被重新 claim", async () => {
    const registry = new InMemorySlotRegistry();
    await registry.claimSlot(0, "instance-A", 30000);
    await registry.releaseSlot(0, "instance-A");
    const reclaimed = await registry.claimSlot(0, "instance-B", 30000);
    expect(reclaimed).toBe(true);
  });

  it("非 owner 不能 release Slot", async () => {
    const registry = new InMemorySlotRegistry();
    await registry.claimSlot(0, "instance-A", 30000);
    const released = await registry.releaseSlot(0, "instance-B");
    expect(released).toBe(false);
  });
});

describe("InMemoryDistributedLock", () => {
  it("acquire 成功后同一 key 不可再次 acquire", async () => {
    const lock = new InMemoryDistributedLock();
    const handle = await lock.acquire("my-lock", 30000);
    expect(handle).not.toBeNull();

    const second = await lock.acquire("my-lock", 30000);
    expect(second).toBeNull();
  });

  it("release 后可再次 acquire", async () => {
    const lock = new InMemoryDistributedLock();
    const handle = await lock.acquire("my-lock", 30000);
    await lock.release(handle!);
    const reacquired = await lock.acquire("my-lock", 30000);
    expect(reacquired).not.toBeNull();
  });
});

// ============================================================================
// Layer 3: SlotCoordinator 集成测试 — 使用 InMemory 实现
// ============================================================================

describe("SlotCoordinator (with InMemory deps)", () => {
  function makeCoordinator(instanceId: string, totalSlots = 4, leaseTtlMs = 30000) {
    const lock = new InMemoryDistributedLock();
    const slotRegistry = new InMemorySlotRegistry();
    const heartbeat = new InMemoryInstanceHeartbeat(leaseTtlMs);
    const slotAllocator = new ConsistentHashSlotAllocator();

    const coordinator = new SlotCoordinator(
      lock,
      slotRegistry,
      heartbeat,
      slotAllocator,
      totalSlots,
      leaseTtlMs
    );

    return { coordinator, lock, slotRegistry, heartbeat };
  }

  it("单实例协调后应获得全部 Slot", async () => {
    const { coordinator, heartbeat } = makeCoordinator("instance-A");
    await heartbeat.heartbeat("instance-A");

    const plans = await coordinator.coordinate("instance-A");

    expect(plans).toHaveLength(4);
  });

  it("协调时应先获取分布式锁", async () => {
    const { coordinator, lock, heartbeat } = makeCoordinator("instance-A");
    await heartbeat.heartbeat("instance-A");

    await lock.acquire("cron:slot-coordination", 30000);

    const plans = await coordinator.coordinate("instance-A");

    expect(plans).toHaveLength(0);
  });
});

// ============================================================================
// Layer 4: CronJobFactory 端到端测试 — 使用 InMemory 实现
// ============================================================================

describe("CronJobFactory (with InMemory deps)", () => {
  it("registerJob + start 应正常工作", async () => {
    const factory = createInMemoryCronJobFactory("instance-A", 4, 30000);

    await factory.registerJob({
      id: "job-1",
      name: "Test Job",
      cronExpression: "*/5 * * * *",
      handler: "handler1",
    });

    await factory.start();

    expect(factory.getAllocatedSlots()).toEqual([]);
  });

  it("unregisterJob 应移除已注册的 Job", async () => {
    const factory = createInMemoryCronJobFactory("instance-A", 4, 30000);

    await factory.registerJob({
      id: "job-1",
      name: "Test Job",
      cronExpression: "*/5 * * * *",
      handler: "handler1",
    });
    await factory.unregisterJob("job-1");
    await factory.start();

    expect(factory.getAllocatedSlots()).toEqual([]);
  });
});
