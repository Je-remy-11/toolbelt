export type JobName = string;
export type WorkerId = string;
export type SlotId = number;

export interface SlotLease {
  readonly jobName: JobName;
  readonly slotId: SlotId;
  readonly ownerId: WorkerId;
  readonly leaseUntil: number;
}

export interface SlotRebalanceInput {
  readonly jobName: JobName;
  readonly workerId: WorkerId;
  readonly totalSlots: number;
  readonly activeWorkers: readonly WorkerId[];
  readonly currentLeases: readonly SlotLease[];
}

export interface SlotRebalancePlan {
  readonly desiredSlots: readonly SlotId[];
  readonly slotsToAcquire: readonly SlotId[];
  readonly slotsToRenew: readonly SlotId[];
  readonly slotsToRelease: readonly SlotId[];
  readonly blockedSlots: readonly SlotId[];
}

export interface TickPlanResult {
  readonly desiredSlots: readonly SlotId[];
  readonly runnableSlots: readonly SlotId[];
  readonly acquiredSlots: readonly SlotId[];
  readonly renewedSlots: readonly SlotId[];
  readonly releasedSlots: readonly SlotId[];
  readonly blockedSlots: readonly SlotId[];
}
