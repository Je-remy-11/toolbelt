import type {
  AllocationResult,
  CronJob,
  SlotAssignment,
} from "./types";
import { SLOT_COUNT } from "./types";
import type {
  JobRegistry,
  SlotHasher,
  SlotRepository,
  TimeProvider,
} from "./ports";

export interface CronJobFactoryDeps {
  slotRepository: SlotRepository;
  hasher: SlotHasher;
  clock: TimeProvider;
  slotCount?: number;
}

export interface CronJobHandle {
  job: CronJob;
  slotIndex: number;
  stop: () => Promise<AllocationResult>;
}

export interface CronJobFactory {
  register(job: CronJob): Promise<CronJobHandle>;
  deregister(jobId: string): Promise<AllocationResult | null>;
  pickCurrentSlotJobs(): Promise<CronJob[]>;
  getSlot(slotIndex: number): Promise<SlotAssignment>;
}

export function cronJobFactory(deps: CronJobFactoryDeps): CronJobFactory {
  const {
    slotRepository,
    hasher,
    clock,
    slotCount = SLOT_COUNT,
  } = deps;
  const { jobRegistry } = slotRepository;

  async function assignToSlot(
    job: CronJob,
  ): Promise<AllocationResult> {
    const slotIndex = hasher.hash(job.id, slotCount);
    const current = await slotRepository.readSlot(slotIndex);

    if (current.jobIds.includes(job.id)) {
      return { slotIndex, added: [], removed: [] };
    }

    const next: SlotAssignment = {
      slotIndex,
      jobIds: [...current.jobIds, job.id],
    };
    await slotRepository.writeSlot(next);
    return { slotIndex, added: [job.id], removed: [] };
  }

  async function removeFromSlot(
    jobId: string,
  ): Promise<AllocationResult | null> {
    const job = await jobRegistry.get(jobId);
    if (!job) return null;

    const slotIndex = hasher.hash(jobId, slotCount);
    const current = await slotRepository.readSlot(slotIndex);

    if (!current.jobIds.includes(jobId)) {
      return { slotIndex, added: [], removed: [] };
    }

    const next: SlotAssignment = {
      slotIndex,
      jobIds: current.jobIds.filter((id) => id !== jobId),
    };
    await slotRepository.writeSlot(next);
    return { slotIndex, added: [], removed: [jobId] };
  }

  async function register(job: CronJob): Promise<CronJobHandle> {
    await jobRegistry.set(job);
    const { slotIndex } = await assignToSlot(job);

    return {
      job,
      slotIndex,
      stop: async () => {
        await jobRegistry.remove(job.id);
        const result = await removeFromSlot(job.id);
        return result ?? { slotIndex, added: [], removed: [] };
      },
    };
  }

  async function deregister(
    jobId: string,
  ): Promise<AllocationResult | null> {
    await jobRegistry.remove(jobId);
    return removeFromSlot(jobId);
  }

  async function pickCurrentSlotJobs(): Promise<CronJob[]> {
    const slotIndex = clock.currentMinuteOfHour(clock.now()) % slotCount;
    const assignment = await slotRepository.readSlot(slotIndex);

    const jobs: CronJob[] = [];
    for (const jobId of assignment.jobIds) {
      const j = await jobRegistry.get(jobId);
      if (j) jobs.push(j);
    }
    return jobs;
  }

  async function getSlot(slotIndex: number): Promise<SlotAssignment> {
    return slotRepository.readSlot(slotIndex);
  }

  return { register, deregister, pickCurrentSlotJobs, getSlot };
}

export { JobRegistry };
