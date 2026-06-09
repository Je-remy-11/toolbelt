import type Redis from "ioredis";
import type {
  JobRegistry,
  SlotRepository,
} from "../ports";
import type { CronJob, SlotAssignment } from "../types";
import { SLOT_COUNT } from "../types";

export interface RedisCronOptions {
  keyPrefix?: string;
  slotCount?: number;
}

const DEFAULT_PREFIX = "cron";

function slotKey(prefix: string, slotIndex: number): string {
  return `${prefix}:slot:${slotIndex}`;
}

function jobKey(prefix: string, jobId: string): string {
  return `${prefix}:job:${jobId}`;
}

function jobsIndexKey(prefix: string): string {
  return `${prefix}:jobs`;
}

export function createRedisJobRegistry(
  client: Redis,
  options: RedisCronOptions = {},
): JobRegistry {
  const prefix = options.keyPrefix ?? DEFAULT_PREFIX;

  return {
    async get(jobId: string): Promise<CronJob | undefined> {
      const raw = await client.get(jobKey(prefix, jobId));
      if (!raw) return undefined;
      return JSON.parse(raw) as CronJob;
    },

    async set(job: CronJob): Promise<void> {
      await client
        .multi()
        .set(jobKey(prefix, job.id), JSON.stringify(job))
        .sadd(jobsIndexKey(prefix), job.id)
        .exec();
    },

    async remove(jobId: string): Promise<void> {
      await client
        .multi()
        .del(jobKey(prefix, jobId))
        .srem(jobsIndexKey(prefix), jobId)
        .exec();
    },

    async list(): Promise<CronJob[]> {
      const ids = await client.smembers(jobsIndexKey(prefix));
      if (ids.length === 0) return [];
      const keys = ids.map((id) => jobKey(prefix, id));
      const raws = await client.mget(...keys);
      return raws
        .filter((r): r is string => r !== null)
        .map((r) => JSON.parse(r) as CronJob);
    },
  };
}

export function createRedisSlotRepository(
  client: Redis,
  options: RedisCronOptions = {},
): SlotRepository {
  const prefix = options.keyPrefix ?? DEFAULT_PREFIX;
  const slotCount = options.slotCount ?? SLOT_COUNT;
  const jobRegistry = createRedisJobRegistry(client, options);

  async function readSlot(slotIndex: number): Promise<SlotAssignment> {
    const members = await client.smembers(slotKey(prefix, slotIndex));
    return { slotIndex, jobIds: members.sort() };
  }

  return {
    jobRegistry,

    readSlot,

    async readAllSlots(): Promise<SlotAssignment[]> {
      const pipeline = client.pipeline();
      for (let i = 0; i < slotCount; i += 1) {
        pipeline.smembers(slotKey(prefix, i));
      }
      const results = await pipeline.exec();
      return (results ?? []).map(([err, members], idx) => {
        if (err || !Array.isArray(members)) {
          return { slotIndex: idx, jobIds: [] };
        }
        return {
          slotIndex: idx,
          jobIds: (members as string[]).slice().sort(),
        };
      });
    },

    async writeSlot(assignment: SlotAssignment): Promise<void> {
      const key = slotKey(prefix, assignment.slotIndex);
      await client
        .multi()
        .del(key)
        .sadd(
          key,
          ...(assignment.jobIds.length > 0 ? assignment.jobIds : [""]),
        )
        .exec();
      if (assignment.jobIds.length === 0) {
        await client.srem(key, "");
      }
    },

    async clearSlot(slotIndex: number): Promise<void> {
      await client.del(slotKey(prefix, slotIndex));
    },
  };
}

export { DEFAULT_PREFIX as defaultKeyPrefix };
