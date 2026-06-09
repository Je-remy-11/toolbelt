import { describe, it, expect, beforeEach } from "vitest";
import type Redis from "ioredis";
import { cronJobFactory } from "../src/cron/mod";
import {
  createRedisJobRegistry,
  createRedisSlotRepository,
} from "../src/cron/adapters/redis";
import {
  createDeterministicHasher,
  createFixedClock,
} from "../src/cron/adapters/inMemory";
import type { CronJob } from "../src/cron/types";

type StoredSet = Map<string, Set<string>>;
type StoredStrings = Map<string, string>;

interface FakeRedis {
  sets: StoredSet;
  strings: StoredStrings;
  client: Redis;
}

function createFakeRedis(): FakeRedis {
  const sets: StoredSet = new Map();
  const strings: StoredStrings = new Map();

  const getSet = (key: string) => {
    if (!sets.has(key)) sets.set(key, new Set());
    return sets.get(key)!;
  };

  const client = {
    get: async (k: string) => strings.get(k) ?? null,
    set: async (k: string, v: string) => {
      strings.set(k, v);
      return "OK";
    },
    del: async (...ks: string[]) => {
      let n = 0;
      for (const k of ks) {
        if (strings.delete(k)) n += 1;
        if (sets.delete(k)) n += 1;
      }
      return n;
    },
    sadd: async (k: string, ...members: string[]) => {
      const s = getSet(k);
      let added = 0;
      for (const m of members) {
        if (!s.has(m)) {
          s.add(m);
          added += 1;
        }
      }
      return added;
    },
    srem: async (k: string, ...members: string[]) => {
      const s = getSet(k);
      let removed = 0;
      for (const m of members) {
        if (s.delete(m)) removed += 1;
      }
      return removed;
    },
    smembers: async (k: string) => {
      const s = sets.get(k);
      return s ? Array.from(s) : [];
    },
    mget: async (...ks: string[]) => ks.map((k) => strings.get(k) ?? null),
    multi: () => ({
      _ops: [] as Array<{ fn: string; args: unknown[] }>,
      set(k: string, v: string) {
        this._ops.push({ fn: "set", args: [k, v] });
        return this;
      },
      del(k: string) {
        this._ops.push({ fn: "del", args: [k] });
        return this;
      },
      sadd(k: string, ...members: string[]) {
        this._ops.push({ fn: "sadd", args: [k, ...members] });
        return this;
      },
      srem(k: string, ...members: string[]) {
        this._ops.push({ fn: "srem", args: [k, ...members] });
        return this;
      },
      async exec() {
        const out: Array<[Error | null, unknown]> = [];
        for (const op of this._ops) {
          if (op.fn === "set") {
            // @ts-expect-error runtime-only object
            await client.set(op.args[0], op.args[1]);
            out.push([null, "OK"]);
          } else if (op.fn === "del") {
            // @ts-expect-error runtime-only object
            await client.del(op.args[0]);
            out.push([null, 1]);
          } else if (op.fn === "sadd") {
            const [k, ...rest] = op.args as [string, ...string[]];
            // @ts-expect-error runtime-only object
            await client.sadd(k, ...rest);
            out.push([null, rest.length]);
          } else if (op.fn === "srem") {
            const [k, ...rest] = op.args as [string, ...string[]];
            // @ts-expect-error runtime-only object
            await client.srem(k, ...rest);
            out.push([null, rest.length]);
          }
        }
        return out;
      },
    }),
    pipeline: () => ({
      _ops: [] as Array<{ fn: string; args: unknown[] }>,
      smembers(k: string) {
        this._ops.push({ fn: "smembers", args: [k] });
        return this;
      },
      async exec() {
        return Promise.all(
          this._ops.map(async (op) => {
            if (op.fn === "smembers") {
              // @ts-expect-error runtime-only object
              return [null, await client.smembers(op.args[0])];
            }
            return [null, null] as [null, null];
          }),
        );
      },
    }),
  } as unknown as Redis;

  return { sets, strings, client };
}

describe("cronJobFactory (integration) — Redis adapter contract", () => {
  let fake: FakeRedis;

  beforeEach(() => {
    fake = createFakeRedis();
  });

  it("register job 落库到 job key + 进入对应 slot 的 set", async () => {
    const repo = createRedisSlotRepository(fake.client, {
      keyPrefix: "cron",
    });
    const factory = cronJobFactory({
      slotRepository: repo,
      hasher: createDeterministicHasher(),
      clock: createFixedClock(new Date("2026-06-09T10:00:00Z")),
    });

    const handle = await factory.register({
      id: "job-X",
      expression: "*/5 * * * *",
      payload: { k: 1 },
    });

    const jobStr = fake.strings.get("cron:job:job-X");
    expect(jobStr).toBeTruthy();
    const parsed = JSON.parse(jobStr!) as CronJob;
    expect(parsed.id).toBe("job-X");

    const set = fake.sets.get(`cron:slot:${handle.slotIndex}`);
    expect(set).toBeTruthy();
    expect(set!.has("job-X")).toBe(true);
  });

  it("stop 后从 slot set 中移除", async () => {
    const repo = createRedisSlotRepository(fake.client, {
      keyPrefix: "cron",
    });
    const factory = cronJobFactory({
      slotRepository: repo,
      hasher: createDeterministicHasher(),
      clock: createFixedClock(new Date("2026-06-09T10:00:00Z")),
    });

    const handle = await factory.register({
      id: "job-Y",
      expression: "* * * * *",
      payload: {},
    });

    await handle.stop();
    const set = fake.sets.get(`cron:slot:${handle.slotIndex}`);
    expect(set?.has("job-Y")).toBe(false);
    expect(fake.strings.has("cron:job:job-Y")).toBe(false);
  });
});
