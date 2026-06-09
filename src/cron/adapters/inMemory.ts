import type { ClusterMembershipPort, CriticalSectionPort, SlotLeasePort } from '../core/ports';
import type { JobName, SlotId, SlotLease, WorkerId } from '../core/types';

export class InMemoryCronCoordinator implements ClusterMembershipPort, SlotLeasePort, CriticalSectionPort {
  private readonly memberships = new Map<JobName, Map<WorkerId, number>>();
  private readonly leases = new Map<JobName, Map<SlotId, SlotLease>>();
  private readonly activeLocks = new Set<string>();

  async heartbeat(params: {
    readonly jobName: JobName;
    readonly workerId: WorkerId;
    readonly ttlMs: number;
    readonly now: number;
  }): Promise<void> {
    const members = this.memberships.get(params.jobName) ?? new Map<WorkerId, number>();
    members.set(params.workerId, params.now + params.ttlMs);
    this.memberships.set(params.jobName, members);
  }

  async listActiveWorkers(jobName: JobName, now: number): Promise<readonly WorkerId[]> {
    const members = this.memberships.get(jobName) ?? new Map<WorkerId, number>();
    const activeWorkers: WorkerId[] = [];

    for (const [workerId, expiresAt] of members.entries()) {
      if (expiresAt > now) {
        activeWorkers.push(workerId);
      }
    }

    return activeWorkers.sort((left, right) => left.localeCompare(right));
  }

  async listLeases(jobName: JobName, now: number): Promise<readonly SlotLease[]> {
    const leaseMap = this.leases.get(jobName) ?? new Map<SlotId, SlotLease>();
    const activeLeases: SlotLease[] = [];

    for (const lease of leaseMap.values()) {
      if (lease.leaseUntil > now) {
        activeLeases.push(lease);
      }
    }

    return activeLeases.sort((left, right) => left.slotId - right.slotId);
  }

  async claimLease(params: {
    readonly jobName: JobName;
    readonly slotId: SlotId;
    readonly ownerId: WorkerId;
    readonly leaseUntil: number;
    readonly now: number;
  }): Promise<boolean> {
    const leaseMap = this.leases.get(params.jobName) ?? new Map<SlotId, SlotLease>();
    const existingLease = leaseMap.get(params.slotId);

    if (existingLease && existingLease.leaseUntil > params.now && existingLease.ownerId !== params.ownerId) {
      return false;
    }

    leaseMap.set(params.slotId, {
      jobName: params.jobName,
      slotId: params.slotId,
      ownerId: params.ownerId,
      leaseUntil: params.leaseUntil,
    });
    this.leases.set(params.jobName, leaseMap);
    return true;
  }

  async renewLease(params: {
    readonly jobName: JobName;
    readonly slotId: SlotId;
    readonly ownerId: WorkerId;
    readonly leaseUntil: number;
    readonly now: number;
  }): Promise<boolean> {
    const leaseMap = this.leases.get(params.jobName) ?? new Map<SlotId, SlotLease>();
    const existingLease = leaseMap.get(params.slotId);

    if (!existingLease || existingLease.ownerId !== params.ownerId || existingLease.leaseUntil <= params.now) {
      return false;
    }

    leaseMap.set(params.slotId, {
      jobName: params.jobName,
      slotId: params.slotId,
      ownerId: params.ownerId,
      leaseUntil: params.leaseUntil,
    });
    this.leases.set(params.jobName, leaseMap);
    return true;
  }

  async releaseLease(params: {
    readonly jobName: JobName;
    readonly slotId: SlotId;
    readonly ownerId: WorkerId;
  }): Promise<void> {
    const leaseMap = this.leases.get(params.jobName) ?? new Map<SlotId, SlotLease>();
    const existingLease = leaseMap.get(params.slotId);

    if (existingLease && existingLease.ownerId === params.ownerId) {
      leaseMap.delete(params.slotId);
      this.leases.set(params.jobName, leaseMap);
    }
  }

  async runExclusive<T>(key: string, _ttlMs: number, task: () => Promise<T>): Promise<T> {
    if (this.activeLocks.has(key)) {
      throw new Error(`Lock already held: ${key}`);
    }

    this.activeLocks.add(key);
    try {
      return await task();
    } finally {
      this.activeLocks.delete(key);
    }
  }
}
