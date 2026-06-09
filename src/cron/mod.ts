import type Redis from "ioredis";
import { cronJobFactory, type CronJobFactory } from "./cronJobFactory";
import type {
  JobRegistry,
  SlotHasher,
  SlotRepository,
  TimeProvider,
} from "./ports";
import type { CronJob } from "./types";
import { SLOT_COUNT } from "./types";
import {
  createRedisSlotRepository,
  type RedisCronOptions,
} from "./adapters/redis";
import {
  createDeterministicHasher,
  createInMemoryJobRegistry,
  createInMemorySlotRepository,
  createFixedClock,
} from "./adapters/inMemory";

export function createCronJobFactoryWithRedis(
  client: Redis,
  options: RedisCronOptions & {
    hasher?: SlotHasher;
    clock?: TimeProvider;
  } = {},
): CronJobFactory {
  const slotRepository = createRedisSlotRepository(client, options);
  return cronJobFactory({
    slotRepository,
    hasher: options.hasher ?? createDeterministicHasher(),
    clock: options.clock ?? systemClock(),
    slotCount: options.slotCount ?? SLOT_COUNT,
  });
}

export function createInMemoryCronJobFactory(
  options: {
    slotCount?: number;
    hasher?: SlotHasher;
    clock?: TimeProvider;
    repository?: SlotRepository;
  } = {},
): CronJobFactory {
  const slotCount = options.slotCount ?? SLOT_COUNT;
  const slotRepository =
    options.repository ?? createInMemorySlotRepository(slotCount);
  return cronJobFactory({
    slotRepository,
    hasher: options.hasher ?? createDeterministicHasher(),
    clock: options.clock ?? systemClock(),
    slotCount,
  });
}

export function systemClock(): TimeProvider {
  return {
    now: () => new Date(),
    currentMinuteOfHour: (now?: Date) => (now ?? new Date()).getMinutes(),
  };
}

export type {
  CronJobFactory,
  CronJob,
  SlotRepository,
  JobRegistry,
  SlotHasher,
  TimeProvider,
};

export { cronJobFactory, SLOT_COUNT };
