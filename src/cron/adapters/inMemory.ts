import type {
  JobRegistry,
  SlotHasher,
  SlotRepository,
  TimeProvider,
} from "./ports";
import type { CronJob, SlotAssignment } from "./types";
import { SLOT_COUNT } from "./types";

export function createInMemoryJobRegistry(): JobRegistry {
  const jobs = new Map<string, CronJob>();

  return {
    get: async (id) => jobs.get(id),
    set: async (job) => {
      jobs.set(job.id, job);
    },
    remove: async (id) => {
      jobs.delete(id);
    },
    list: async () => Array.from(jobs.values()),
  };
}

export function createInMemorySlotRepository(
  slotCount: number = SLOT_COUNT,
  registry?: JobRegistry,
): SlotRepository {
  const slots = new Map<number, SlotAssignment>();
  for (let i = 0; i < slotCount; i += 1) {
    slots.set(i, { slotIndex: i, jobIds: [] });
  }

  return {
    jobRegistry: registry ?? createInMemoryJobRegistry(),

    async readSlot(slotIndex: number): Promise<SlotAssignment> {
      const slot = slots.get(slotIndex);
      if (!slot) return { slotIndex, jobIds: [] };
      return { slotIndex: slot.slotIndex, jobIds: [...slot.jobIds] };
    },

    async readAllSlots(): Promise<SlotAssignment[]> {
      return Array.from(slots.values()).map((s) => ({
        slotIndex: s.slotIndex,
        jobIds: [...s.jobIds],
      }));
    },

    async writeSlot(assignment: SlotAssignment): Promise<void> {
      slots.set(assignment.slotIndex, {
        slotIndex: assignment.slotIndex,
        jobIds: [...assignment.jobIds],
      });
    },

    async clearSlot(slotIndex: number): Promise<void> {
      slots.set(slotIndex, { slotIndex, jobIds: [] });
    },
  };
}

export function createDeterministicHasher(): SlotHasher {
  return {
    hash(jobId: string, slotCount: number): number {
      let h = 0;
      for (let i = 0; i < jobId.length; i += 1) {
        h = (h * 31 + jobId.charCodeAt(i)) >>> 0;
      }
      return h % slotCount;
    },
  };
}

export function createFixedClock(initial: Date): TimeProvider & {
  set(now: Date): void;
} {
  let current = initial;
  return {
    now: () => current,
    set: (now: Date) => {
      current = now;
    },
    currentMinuteOfHour: (now?: Date) => (now ?? current).getMinutes(),
  };
}
