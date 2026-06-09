import type { JobName, SlotId, SlotLease, SlotRebalanceInput, SlotRebalancePlan, WorkerId } from './types';

export interface ClockPort {
  now(): number;
}

export interface ClusterMembershipPort {
  heartbeat(params: {
    readonly jobName: JobName;
    readonly workerId: WorkerId;
    readonly ttlMs: number;
    readonly now: number;
  }): Promise<void>;

  listActiveWorkers(jobName: JobName, now: number): Promise<readonly WorkerId[]>;
}

export interface SlotLeasePort {
  listLeases(jobName: JobName, now: number): Promise<readonly SlotLease[]>;

  claimLease(params: {
    readonly jobName: JobName;
    readonly slotId: SlotId;
    readonly ownerId: WorkerId;
    readonly leaseUntil: number;
    readonly now: number;
  }): Promise<boolean>;

  renewLease(params: {
    readonly jobName: JobName;
    readonly slotId: SlotId;
    readonly ownerId: WorkerId;
    readonly leaseUntil: number;
    readonly now: number;
  }): Promise<boolean>;

  releaseLease(params: {
    readonly jobName: JobName;
    readonly slotId: SlotId;
    readonly ownerId: WorkerId;
  }): Promise<void>;
}

export interface CriticalSectionPort {
  runExclusive<T>(key: string, ttlMs: number, task: () => Promise<T>): Promise<T>;
}

export interface SlotAllocatorPort {
  plan(input: SlotRebalanceInput): SlotRebalancePlan;
}
