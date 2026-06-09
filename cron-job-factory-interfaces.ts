// ============================================================================
// cronJobFactory 解耦设计 — Interface Segregation Principle (ISP)
// ============================================================================
//
// 目标：将 cronJobFactory 对 ioredis 的直接依赖拆解为细粒度接口，
//       使得核心逻辑（Slot 分配算法）可在无 Redis 环境下进行纯单元测试。
//
// 设计原则：
//   1. 依赖倒置 (DIP) — 高层模块依赖抽象，不依赖 ioredis 具体实现
//   2. 接口隔离 (ISP) — 每个接口只承担单一职责，客户端不被迫依赖不需要的方法
//   3. 可替换性 (LSP) — InMemory 实现与 Redis 实现可互换，行为等价
//
// 架构分层：
//   Layer 0: Domain Values      — 纯值对象，无 I/O
//   Layer 1: Pure Algorithm     — ISlotAllocator，零副作用
//   Layer 2: Infra Abstractions — IDistributedLock / ISlotRegistry / IJobStateStore / IInstanceHeartbeat
//   Layer 3: Orchestration      — ISlotCoordinator，组合 Layer 1 + Layer 2
//   Layer 4: Factory            — ICronJobFactory，面向使用者的入口
// ============================================================================

// ============================================================================
// Layer 0: Domain Value Objects
// ============================================================================

export type InstanceId = string;

export type SlotId = number;

export enum JobState {
  Pending = "pending",
  Running = "running",
  Succeeded = "succeeded",
  Failed = "failed",
}

export interface Slot {
  id: SlotId;
  totalSlots: number;
  owner: InstanceId | null;
  leasedAt: number | null;
  leaseTtlMs: number;
}

export interface CronJobDefinition {
  id: string;
  name: string;
  cronExpression: string;
  handler: string;
  preferredSlot?: SlotId;
  timeoutMs?: number;
  retryLimit?: number;
}

export interface JobExecution {
  jobId: string;
  slotId: SlotId;
  state: JobState;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  attempt: number;
}

export interface SlotAllocationPlan {
  slotId: SlotId;
  jobIds: string[];
}

// ============================================================================
// Layer 1: ISlotAllocator — 纯算法接口（零 I/O，零副作用）
// ============================================================================
//
// 这是解耦的核心：Slot 分配算法被完全抽离为纯函数式接口。
// 输入 = 当前快照，输出 = 分配方案，无任何副作用。
// ============================================================================

export interface ISlotAllocator {
  allocate(params: SlotAllocatorInput): SlotAllocationPlan[];
}

export interface SlotAllocatorInput {
  instanceId: InstanceId;
  totalSlots: number;
  currentOwnership: Map<SlotId, InstanceId | null>;
  jobDefinitions: CronJobDefinition[];
  instanceHeartbeats: Map<InstanceId, number>;
  nowMs: number;
  leaseTtlMs: number;
}

// ============================================================================
// Layer 2: Infrastructure Abstractions — I/O 边界接口
// ============================================================================
//
// 每个 Interface 遵循 ISP，只暴露 cronJobFactory 真正需要的操作，
// 而非 ioredis 的全部 API（如 scan / info / config 等）。
// ============================================================================

// ---- 2a: IDistributedLock ----
// 只需"获取锁 / 释放锁"，不需要暴露 Redis 的 SETNX / Lua 脚本细节

export interface IDistributedLock {
  acquire(key: string, ttlMs: number): Promise<LockHandle | null>;
  release(handle: LockHandle): Promise<boolean>;
}

export interface LockHandle {
  id: string;
  key: string;
  token: string;
  acquiredAt: number;
  ttlMs: number;
}

// ---- 2b: ISlotRegistry ----
// Slot 所有权读写，替代直接操作 Redis HASH

export interface ISlotRegistry {
  getSlotOwners(slotRange: { from: SlotId; to: SlotId }): Promise<Map<SlotId, InstanceId | null>>;
  claimSlot(slotId: SlotId, instanceId: InstanceId, ttlMs: number): Promise<boolean>;
  releaseSlot(slotId: SlotId, instanceId: InstanceId): Promise<boolean>;
  renewSlotLease(slotId: SlotId, instanceId: InstanceId, ttlMs: number): Promise<boolean>;
}

// ---- 2c: IJobStateStore ----
// Job 执行状态持久化，替代直接操作 Redis STRING / HASH

export interface IJobStateStore {
  getExecution(jobId: string): Promise<JobExecution | null>;
  saveExecution(execution: JobExecution): Promise<void>;
  getLastRunTime(jobId: string): Promise<number | null>;
  setLastRunTime(jobId: string, timestampMs: number): Promise<void>;
}

// ---- 2d: IInstanceHeartbeat ----
// 实例心跳 / 存活检测，替代直接操作 Redis KEY + TTL

export interface IInstanceHeartbeat {
  heartbeat(instanceId: InstanceId): Promise<void>;
  getActiveInstances(): Promise<Map<InstanceId, number>>;
  isAlive(instanceId: InstanceId): Promise<boolean>;
}

// ---- 2e: IPubSub (可选) ----
// 跨实例通知，替代 Redis PUB/SUB

export interface IPubSub {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
}

// ============================================================================
// Layer 3: ISlotCoordinator — 编排层
// ============================================================================
//
// 组合 ISlotAllocator（纯算法）+ ISlotRegistry / IDistributedLock / IInstanceHeartbeat
// 负责完整的 Slot 协调流程：加锁 → 读取状态 → 算法分配 → 写回状态 → 释放锁
// ============================================================================

export interface ISlotCoordinator {
  coordinate(instanceId: InstanceId): Promise<SlotAllocationPlan[]>;
}

// ============================================================================
// Layer 4: ICronJobFactory — 面向使用者的工厂接口
// ============================================================================

export interface ICronJobFactory {
  registerJob(definition: CronJobDefinition): Promise<void>;
  unregisterJob(jobId: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getAllocatedSlots(): SlotAllocationPlan[];
}

// ============================================================================
// 依赖注入容器 — ICronJobFactoryDeps
// ============================================================================
//
// 工厂的所有外部依赖通过此接口注入，而非在内部 new Redis()
// 这使得测试时可以传入 InMemory 实现，生产时传入 Redis 实现
// ============================================================================

export interface ICronJobFactoryDeps {
  lock: IDistributedLock;
  slotRegistry: ISlotRegistry;
  jobStateStore: IJobStateStore;
  heartbeat: IInstanceHeartbeat;
  slotAllocator: ISlotAllocator;
  pubsub?: IPubSub;
}

// ============================================================================
// 纯算法实现示例 — ConsistentHashSlotAllocator
// ============================================================================
//
// 这个实现完全不依赖任何 I/O，可以 100% 纯单元测试
// ============================================================================

export class ConsistentHashSlotAllocator implements ISlotAllocator {
  allocate(params: SlotAllocatorInput): SlotAllocationPlan[] {
    const { instanceId, totalSlots, currentOwnership, jobDefinitions, instanceHeartbeats, nowMs, leaseTtlMs } = params;

    const activeInstances = this.getActiveInstances(instanceHeartbeats, nowMs, leaseTtlMs);
    const expiredSlots = this.findExpiredSlots(currentOwnership, activeInstances);
    const availableSlots = this.collectAvailableSlots(totalSlots, currentOwnership, instanceId, expiredSlots);
    const mySlots = this.computeMySlots(availableSlots, instanceId, activeInstances);
    const plans = this.assignJobsToSlots(mySlots, jobDefinitions);

    return plans;
  }

  private getActiveInstances(
    heartbeats: Map<InstanceId, number>,
    nowMs: number,
    leaseTtlMs: number
  ): Set<InstanceId> {
    const active = new Set<InstanceId>();
    for (const [instanceId, lastBeat] of heartbeats) {
      if (nowMs - lastBeat < leaseTtlMs) {
        active.add(instanceId);
      }
    }
    return active;
  }

  private findExpiredSlots(
    ownership: Map<SlotId, InstanceId | null>,
    activeInstances: Set<InstanceId>
  ): SlotId[] {
    const expired: SlotId[] = [];
    for (const [slotId, owner] of ownership) {
      if (owner !== null && !activeInstances.has(owner)) {
        expired.push(slotId);
      }
    }
    return expired;
  }

  private collectAvailableSlots(
    totalSlots: number,
    ownership: Map<SlotId, InstanceId | null>,
    instanceId: InstanceId,
    expiredSlots: SlotId[]
  ): SlotId[] {
    const available: SlotId[] = [];
    for (let i = 0; i < totalSlots; i++) {
      const owner = ownership.get(i) ?? null;
      if (owner === null || owner === instanceId || expiredSlots.includes(i)) {
        available.push(i);
      }
    }
    return available;
  }

  private computeMySlots(
    availableSlots: SlotId[],
    instanceId: InstanceId,
    activeInstances: Set<InstanceId>
  ): SlotId[] {
    const sortedInstances = Array.from(activeInstances).sort();
    const myIndex = sortedInstances.indexOf(instanceId);
    if (myIndex === -1) return [];

    const slotsPerInstance = Math.floor(availableSlots.length / sortedInstances.length);
    const remainder = availableSlots.length % sortedInstances.length;
    const start = myIndex * slotsPerInstance + Math.min(myIndex, remainder);
    const count = slotsPerInstance + (myIndex < remainder ? 1 : 0);

    return availableSlots.slice(start, start + count);
  }

  private assignJobsToSlots(
    mySlots: SlotId[],
    jobDefinitions: CronJobDefinition[]
  ): SlotAllocationPlan[] {
    const plans: SlotAllocationPlan[] = mySlots.map((slotId) => ({
      slotId,
      jobIds: [] as string[],
    }));

    const sortedJobs = [...jobDefinitions].sort((a, b) => {
      if (a.preferredSlot !== undefined && b.preferredSlot === undefined) return -1;
      if (a.preferredSlot === undefined && b.preferredSlot !== undefined) return 1;
      return a.id.localeCompare(b.id);
    });

    for (const job of sortedJobs) {
      let assigned = false;
      if (job.preferredSlot !== undefined) {
        const plan = plans.find((p) => p.slotId === job.preferredSlot);
        if (plan) {
          plan.jobIds.push(job.id);
          assigned = true;
        }
      }
      if (!assigned) {
        const targetIndex = this.simpleHash(job.id) % plans.length;
        plans[targetIndex].jobIds.push(job.id);
      }
    }

    return plans;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return Math.abs(hash);
  }
}

// ============================================================================
// Redis 实现示例 — RedisSlotRegistry
// ============================================================================
//
// 只有这一层才真正 import ioredis，实现 ISlotRegistry 接口
// ============================================================================

export class RedisSlotRegistry implements ISlotRegistry {
  // private redis: Redis;  // ioredis 实例，仅在此处出现

  constructor(private redis: any) {}

  async getSlotOwners(range: { from: SlotId; to: SlotId }): Promise<Map<SlotId, InstanceId | null>> {
    const result = new Map<SlotId, InstanceId | null>();
    const pipeline = this.redis.pipeline();
    for (let i = range.from; i <= range.to; i++) {
      pipeline.hget("cron:slots", String(i));
    }
    const replies = await pipeline.exec();
    for (let i = 0; i < replies.length; i++) {
      const [, value] = replies[i];
      result.set(range.from + i, value ?? null);
    }
    return result;
  }

  async claimSlot(slotId: SlotId, instanceId: InstanceId, ttlMs: number): Promise<boolean> {
    const key = `cron:slot:${slotId}:lock`;
    const acquired = await this.redis.set(key, instanceId, "PX", ttlMs, "NX");
    if (acquired === "OK") {
      await this.redis.hset("cron:slots", String(slotId), instanceId);
      return true;
    }
    return false;
  }

  async releaseSlot(slotId: SlotId, instanceId: InstanceId): Promise<boolean> {
    const key = `cron:slot:${slotId}:lock`;
    const lua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        redis.call("del", KEYS[1])
        redis.call("hdel", "cron:slots", ARGV[2])
        return 1
      end
      return 0
    `;
    const result = await this.redis.eval(lua, 1, key, instanceId, String(slotId));
    return result === 1;
  }

  async renewSlotLease(slotId: SlotId, instanceId: InstanceId, ttlMs: number): Promise<boolean> {
    const key = `cron:slot:${slotId}:lock`;
    const lua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        redis.call("pexpire", KEYS[1], ARGV[2])
        return 1
      end
      return 0
    `;
    const result = await this.redis.eval(lua, 1, key, instanceId, String(ttlMs));
    return result === 1;
  }
}

// ============================================================================
// InMemory 实现示例 — InMemorySlotRegistry（用于单元测试）
// ============================================================================

export class InMemorySlotRegistry implements ISlotRegistry {
  private owners = new Map<SlotId, InstanceId>();
  private leases = new Map<SlotId, { instanceId: InstanceId; expiresAt: number }>();

  async getSlotOwners(range: { from: SlotId; to: SlotId }): Promise<Map<SlotId, InstanceId | null>> {
    const result = new Map<SlotId, InstanceId | null>();
    for (let i = range.from; i <= range.to; i++) {
      result.set(i, this.owners.get(i) ?? null);
    }
    return result;
  }

  async claimSlot(slotId: SlotId, instanceId: InstanceId, ttlMs: number): Promise<boolean> {
    const existing = this.leases.get(slotId);
    if (existing && existing.expiresAt > Date.now()) {
      return false;
    }
    this.owners.set(slotId, instanceId);
    this.leases.set(slotId, { instanceId, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async releaseSlot(slotId: SlotId, instanceId: InstanceId): Promise<boolean> {
    const lease = this.leases.get(slotId);
    if (lease && lease.instanceId === instanceId) {
      this.leases.delete(slotId);
      this.owners.delete(slotId);
      return true;
    }
    return false;
  }

  async renewSlotLease(slotId: SlotId, instanceId: InstanceId, ttlMs: number): Promise<boolean> {
    const lease = this.leases.get(slotId);
    if (lease && lease.instanceId === instanceId) {
      lease.expiresAt = Date.now() + ttlMs;
      return true;
    }
    return false;
  }
}

// ============================================================================
// InMemory 实现示例 — InMemoryDistributedLock（用于单元测试）
// ============================================================================

export class InMemoryDistributedLock implements IDistributedLock {
  private locks = new Map<string, { token: string; expiresAt: number }>();
  private counter = 0;

  async acquire(key: string, ttlMs: number): Promise<LockHandle | null> {
    const existing = this.locks.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      return null;
    }
    const token = `lock-${++this.counter}`;
    this.locks.set(key, { token, expiresAt: Date.now() + ttlMs });
    return {
      id: `handle-${this.counter}`,
      key,
      token,
      acquiredAt: Date.now(),
      ttlMs,
    };
  }

  async release(handle: LockHandle): Promise<boolean> {
    const lock = this.locks.get(handle.key);
    if (lock && lock.token === handle.token) {
      this.locks.delete(handle.key);
      return true;
    }
    return false;
  }
}

// ============================================================================
// InMemory 实现示例 — InMemoryJobStateStore（用于单元测试）
// ============================================================================

export class InMemoryJobStateStore implements IJobStateStore {
  private executions = new Map<string, JobExecution>();
  private lastRunTimes = new Map<string, number>();

  async getExecution(jobId: string): Promise<JobExecution | null> {
    return this.executions.get(jobId) ?? null;
  }

  async saveExecution(execution: JobExecution): Promise<void> {
    this.executions.set(execution.jobId, execution);
  }

  async getLastRunTime(jobId: string): Promise<number | null> {
    return this.lastRunTimes.get(jobId) ?? null;
  }

  async setLastRunTime(jobId: string, timestampMs: number): Promise<void> {
    this.lastRunTimes.set(jobId, timestampMs);
  }
}

// ============================================================================
// InMemory 实现示例 — InMemoryInstanceHeartbeat（用于单元测试）
// ============================================================================

export class InMemoryInstanceHeartbeat implements IInstanceHeartbeat {
  private beats = new Map<InstanceId, number>();
  private ttlMs: number;

  constructor(ttlMs = 30000) {
    this.ttlMs = ttlMs;
  }

  async heartbeat(instanceId: InstanceId): Promise<void> {
    this.beats.set(instanceId, Date.now());
  }

  async getActiveInstances(): Promise<Map<InstanceId, number>> {
    const now = Date.now();
    const result = new Map<InstanceId, number>();
    for (const [id, lastBeat] of this.beats) {
      if (now - lastBeat < this.ttlMs) {
        result.set(id, lastBeat);
      }
    }
    return result;
  }

  async isAlive(instanceId: InstanceId): Promise<boolean> {
    const lastBeat = this.beats.get(instanceId);
    if (!lastBeat) return false;
    return Date.now() - lastBeat < this.ttlMs;
  }
}

// ============================================================================
// 编排层实现 — SlotCoordinator
// ============================================================================
//
// 依赖注入：不直接 new Redis()，而是通过构造函数接收抽象接口
// ============================================================================

export class SlotCoordinator implements ISlotCoordinator {
  constructor(
    private lock: IDistributedLock,
    private slotRegistry: ISlotRegistry,
    private heartbeat: IInstanceHeartbeat,
    private slotAllocator: ISlotAllocator,
    private totalSlots: number,
    private leaseTtlMs: number
  ) {}

  async coordinate(instanceId: InstanceId): Promise<SlotAllocationPlan[]> {
    const handle = await this.lock.acquire("cron:slot-coordination", this.leaseTtlMs);
    if (!handle) {
      return [];
    }

    try {
      const [ownership, activeInstances] = await Promise.all([
        this.slotRegistry.getSlotOwners({ from: 0, to: this.totalSlots - 1 }),
        this.heartbeat.getActiveInstances(),
      ]);

      const instanceHeartbeats = new Map<InstanceId, number>();
      for (const [id, ts] of activeInstances) {
        instanceHeartbeats.set(id, ts);
      }

      const plans = this.slotAllocator.allocate({
        instanceId,
        totalSlots: this.totalSlots,
        currentOwnership: ownership,
        jobDefinitions: [],
        instanceHeartbeats,
        nowMs: Date.now(),
        leaseTtlMs: this.leaseTtlMs,
      });

      for (const plan of plans) {
        await this.slotRegistry.claimSlot(plan.slotId, instanceId, this.leaseTtlMs);
      }

      return plans;
    } finally {
      await this.lock.release(handle);
    }
  }
}

// ============================================================================
// 工厂实现 — CronJobFactory
// ============================================================================
//
// 通过 ICronJobFactoryDeps 注入所有依赖，内部零 ioredis 引用
// ============================================================================

export class CronJobFactory implements ICronJobFactory {
  private jobs = new Map<string, CronJobDefinition>();
  private allocatedSlots: SlotAllocationPlan[] = [];
  private running = false;

  constructor(
    private deps: ICronJobFactoryDeps,
    private instanceId: InstanceId,
    private totalSlots: number,
    private leaseTtlMs: number
  ) {}

  async registerJob(definition: CronJobDefinition): Promise<void> {
    this.jobs.set(definition.id, definition);
  }

  async unregisterJob(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
  }

  async start(): Promise<void> {
    this.running = true;
    await this.deps.heartbeat.heartbeat(this.instanceId);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  getAllocatedSlots(): SlotAllocationPlan[] {
    return this.allocatedSlots;
  }
}

// ============================================================================
// 组装示例 — 生产环境（使用 Redis）
// ============================================================================

export function createRedisCronJobFactory(
  instanceId: InstanceId,
  totalSlots: number,
  leaseTtlMs: number
): ICronJobFactory {
  // const redis = new Redis({ host: "localhost", port: 6379 });
  // const deps: ICronJobFactoryDeps = {
  //   lock: new RedisDistributedLock(redis),
  //   slotRegistry: new RedisSlotRegistry(redis),
  //   jobStateStore: new RedisJobStateStore(redis),
  //   heartbeat: new RedisInstanceHeartbeat(redis),
  //   slotAllocator: new ConsistentHashSlotAllocator(),
  //   pubsub: new RedisPubSub(redis),
  // };
  // return new CronJobFactory(deps, instanceId, totalSlots, leaseTtlMs);
  throw new Error("需要传入 ioredis 实例，此处仅为示意");
}

// ============================================================================
// 组装示例 — 测试环境（使用 InMemory）
// ============================================================================

export function createInMemoryCronJobFactory(
  instanceId: InstanceId,
  totalSlots: number,
  leaseTtlMs: number
): ICronJobFactory {
  const deps: ICronJobFactoryDeps = {
    lock: new InMemoryDistributedLock(),
    slotRegistry: new InMemorySlotRegistry(),
    jobStateStore: new InMemoryJobStateStore(),
    heartbeat: new InMemoryInstanceHeartbeat(leaseTtlMs),
    slotAllocator: new ConsistentHashSlotAllocator(),
  };
  return new CronJobFactory(deps, instanceId, totalSlots, leaseTtlMs);
}
