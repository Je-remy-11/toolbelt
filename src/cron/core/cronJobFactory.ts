import type { ClockPort, ClusterMembershipPort, CriticalSectionPort, SlotAllocatorPort, SlotLeasePort } from './ports';
import type { JobName, SlotId, TickPlanResult, WorkerId } from './types';

export interface CronJobFactoryDeps {
  readonly clock: ClockPort;
  readonly membership: ClusterMembershipPort;
  readonly leases: SlotLeasePort;
  readonly criticalSection: CriticalSectionPort;
  readonly slotAllocator: SlotAllocatorPort;
}

export interface CronJobDefinition {
  readonly jobName: JobName;
  readonly totalSlots: number;
  readonly workerId: WorkerId;
  readonly membershipTtlMs: number;
  readonly leaseTtlMs: number;
  readonly coordinationTtlMs: number;
  executeSlot(slotId: SlotId): Promise<void>;
}

export interface CronJobInstance {
  tick(): Promise<TickPlanResult>;
}

export function createCronJobFactory(deps: CronJobFactoryDeps) {
  return function createCronJob(definition: CronJobDefinition): CronJobInstance {
    return {
      async tick(): Promise<TickPlanResult> {
        const now = deps.clock.now();

        await deps.membership.heartbeat({
          jobName: definition.jobName,
          workerId: definition.workerId,
          ttlMs: definition.membershipTtlMs,
          now,
        });

        const coordinationResult = await deps.criticalSection.runExclusive(
          `${definition.jobName}:rebalance`,
          definition.coordinationTtlMs,
          async () => {
            const activeWorkers = await deps.membership.listActiveWorkers(definition.jobName, now);
            const currentLeases = await deps.leases.listLeases(definition.jobName, now);
            const plan = deps.slotAllocator.plan({
              jobName: definition.jobName,
              workerId: definition.workerId,
              totalSlots: definition.totalSlots,
              activeWorkers,
              currentLeases,
            });

            const releasedSlots: SlotId[] = [];
            for (const slotId of plan.slotsToRelease) {
              await deps.leases.releaseLease({
                jobName: definition.jobName,
                slotId,
                ownerId: definition.workerId,
              });
              releasedSlots.push(slotId);
            }

            const renewedSlots: SlotId[] = [];
            for (const slotId of plan.slotsToRenew) {
              const renewed = await deps.leases.renewLease({
                jobName: definition.jobName,
                slotId,
                ownerId: definition.workerId,
                leaseUntil: now + definition.leaseTtlMs,
                now,
              });
              if (renewed) {
                renewedSlots.push(slotId);
              }
            }

            const acquiredSlots: SlotId[] = [];
            for (const slotId of plan.slotsToAcquire) {
              const acquired = await deps.leases.claimLease({
                jobName: definition.jobName,
                slotId,
                ownerId: definition.workerId,
                leaseUntil: now + definition.leaseTtlMs,
                now,
              });
              if (acquired) {
                acquiredSlots.push(slotId);
              }
            }

            const runnableSlots = [...renewedSlots, ...acquiredSlots].sort((left, right) => left - right);

            return {
              desiredSlots: plan.desiredSlots,
              runnableSlots,
              acquiredSlots,
              renewedSlots,
              releasedSlots,
              blockedSlots: plan.blockedSlots,
            } satisfies TickPlanResult;
          },
        );

        for (const slotId of coordinationResult.runnableSlots) {
          await definition.executeSlot(slotId);
        }

        return coordinationResult;
      },
    };
  };
}
