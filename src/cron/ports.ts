import type { CronJob, SlotAssignment } from "./types";

export interface SlotReader {
  readSlot(slotIndex: number): Promise<SlotAssignment>;
  readAllSlots(): Promise<SlotAssignment[]>;
}

export interface SlotWriter {
  writeSlot(assignment: SlotAssignment): Promise<void>;
  clearSlot(slotIndex: number): Promise<void>;
}

export interface SlotRepository extends SlotReader, SlotWriter {
  jobRegistry: JobRegistry;
}

export interface JobRegistry {
  get(jobId: string): Promise<CronJob | undefined>;
  set(job: CronJob): Promise<void>;
  remove(jobId: string): Promise<void>;
  list(): Promise<CronJob[]>;
}

export interface SlotHasher {
  hash(jobId: string, slotCount: number): number;
}

export interface TimeProvider {
  now(): Date;
  currentMinuteOfHour(now?: Date): number;
}
