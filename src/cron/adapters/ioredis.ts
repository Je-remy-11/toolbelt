import type { ClusterMembershipPort, CriticalSectionPort, SlotLeasePort } from '../core/ports';
import type { JobName, SlotId, SlotLease, WorkerId } from '../core/types';

export interface RedisLike {
  zadd(key: string, score: number, member: string): Promise<number>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  hgetall(key: string): Promise<Record<string, string>>;
  set(
    key: string,
    value: string,
    mode: 'PX',
    durationMs: number,
    condition: 'NX',
  ): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<number>;
}

const CLAIM_OR_STEAL_SCRIPT = `
local payload = ARGV[1]
local slotField = ARGV[2]
local now = tonumber(ARGV[3])
local current = redis.call('HGET', KEYS[1], slotField)
if not current then
  redis.call('HSET', KEYS[1], slotField, payload)
  return 1
end
local decoded = cjson.decode(current)
if decoded.ownerId == cjson.decode(payload).ownerId then
  redis.call('HSET', KEYS[1], slotField, payload)
  return 1
end
if tonumber(decoded.leaseUntil) <= now then
  redis.call('HSET', KEYS[1], slotField, payload)
  return 1
end
return 0
`;

const RENEW_IF_OWNER_SCRIPT = `
local payload = ARGV[1]
local slotField = ARGV[2]
local ownerId = ARGV[3]
local now = tonumber(ARGV[4])
local current = redis.call('HGET', KEYS[1], slotField)
if not current then
  return 0
end
local decoded = cjson.decode(current)
if decoded.ownerId ~= ownerId then
  return 0
end
if tonumber(decoded.leaseUntil) <= now then
  return 0
end
redis.call('HSET', KEYS[1], slotField, payload)
return 1
`;

const RELEASE_IF_OWNER_SCRIPT = `
local slotField = ARGV[1]
local ownerId = ARGV[2]
local current = redis.call('HGET', KEYS[1], slotField)
if not current then
  return 0
end
local decoded = cjson.decode(current)
if decoded.ownerId ~= ownerId then
  return 0
end
redis.call('HDEL', KEYS[1], slotField)
return 1
`;

const RELEASE_LOCK_SCRIPT = `
local expectedToken = ARGV[1]
local currentToken = redis.call('GET', KEYS[1])
if currentToken == expectedToken then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function serializeLease(lease: SlotLease): string {
  return JSON.stringify(lease);
}

function deserializeLease(payload: string): SlotLease {
  return JSON.parse(payload) as SlotLease;
}

export class IoredisCronCoordinator implements ClusterMembershipPort, SlotLeasePort, CriticalSectionPort {
  constructor(private readonly redis: RedisLike) {}

  async heartbeat(params: {
    readonly jobName: JobName;
    readonly workerId: WorkerId;
    readonly ttlMs: number;
    readonly now: number;
  }): Promise<void> {
    await this.redis.zadd(this.membersKey(params.jobName), params.now + params.ttlMs, params.workerId);
  }

  async listActiveWorkers(jobName: JobName, now: number): Promise<readonly WorkerId[]> {
    return this.redis.zrangebyscore(this.membersKey(jobName), now, '+inf');
  }

  async listLeases(jobName: JobName, now: number): Promise<readonly SlotLease[]> {
    const entries = await this.redis.hgetall(this.leasesKey(jobName));

    return Object.values(entries)
      .map((payload) => deserializeLease(payload))
      .filter((lease) => lease.leaseUntil > now)
      .sort((left, right) => left.slotId - right.slotId);
  }

  async claimLease(params: {
    readonly jobName: JobName;
    readonly slotId: SlotId;
    readonly ownerId: WorkerId;
    readonly leaseUntil: number;
    readonly now: number;
  }): Promise<boolean> {
    const lease = serializeLease({
      jobName: params.jobName,
      slotId: params.slotId,
      ownerId: params.ownerId,
      leaseUntil: params.leaseUntil,
    });

    const result = await this.redis.eval(
      CLAIM_OR_STEAL_SCRIPT,
      1,
      this.leasesKey(params.jobName),
      lease,
      String(params.slotId),
      params.now,
    );

    return result === 1;
  }

  async renewLease(params: {
    readonly jobName: JobName;
    readonly slotId: SlotId;
    readonly ownerId: WorkerId;
    readonly leaseUntil: number;
    readonly now: number;
  }): Promise<boolean> {
    const lease = serializeLease({
      jobName: params.jobName,
      slotId: params.slotId,
      ownerId: params.ownerId,
      leaseUntil: params.leaseUntil,
    });

    const result = await this.redis.eval(
      RENEW_IF_OWNER_SCRIPT,
      1,
      this.leasesKey(params.jobName),
      lease,
      String(params.slotId),
      params.ownerId,
      params.now,
    );

    return result === 1;
  }

  async releaseLease(params: {
    readonly jobName: JobName;
    readonly slotId: SlotId;
    readonly ownerId: WorkerId;
  }): Promise<void> {
    await this.redis.eval(
      RELEASE_IF_OWNER_SCRIPT,
      1,
      this.leasesKey(params.jobName),
      String(params.slotId),
      params.ownerId,
    );
  }

  async runExclusive<T>(key: string, ttlMs: number, task: () => Promise<T>): Promise<T> {
    const token = `${Date.now()}:${Math.random()}`;
    const acquired = await this.redis.set(this.lockKey(key), token, 'PX', ttlMs, 'NX');

    if (acquired !== 'OK') {
      throw new Error(`Failed to acquire lock: ${key}`);
    }

    try {
      return await task();
    } finally {
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, this.lockKey(key), token);
    }
  }

  private membersKey(jobName: JobName): string {
    return `cron:${jobName}:members`;
  }

  private leasesKey(jobName: JobName): string {
    return `cron:${jobName}:leases`;
  }

  private lockKey(key: string): string {
    return `cron:lock:${key}`;
  }
}
