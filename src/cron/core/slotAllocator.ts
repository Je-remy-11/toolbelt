import type { SlotAllocatorPort } from './ports';
import type { SlotId, SlotLease, SlotRebalanceInput, SlotRebalancePlan, WorkerId } from './types';

function uniqueSortedWorkers(workers: readonly WorkerId[]): WorkerId[] {
  return [...new Set(workers)].sort((left, right) => left.localeCompare(right));
}

function buildDesiredSlots(workerId: WorkerId, workers: readonly WorkerId[], totalSlots: number): SlotId[] {
  const orderedWorkers = uniqueSortedWorkers(workers);
  const workerIndex = orderedWorkers.indexOf(workerId);

  if (workerIndex === -1 || totalSlots <= 0) {
    return [];
  }

  const desiredSlots: SlotId[] = [];

  for (let slotId = 0; slotId < totalSlots; slotId += 1) {
    if (slotId % orderedWorkers.length === workerIndex) {
      desiredSlots.push(slotId);
    }
  }

  return desiredSlots;
}

function buildLeaseIndex(currentLeases: readonly SlotLease[]): Map<SlotId, SlotLease> {
  return new Map(currentLeases.map((lease) => [lease.slotId, lease]));
}

export function planSlotRebalance(input: SlotRebalanceInput): SlotRebalancePlan {
  const desiredSlots = buildDesiredSlots(input.workerId, input.activeWorkers, input.totalSlots);
  const desiredSlotSet = new Set(desiredSlots);
  const leaseIndex = buildLeaseIndex(input.currentLeases);

  const slotsToAcquire: SlotId[] = [];
  const slotsToRenew: SlotId[] = [];
  const blockedSlots: SlotId[] = [];

  for (const slotId of desiredSlots) {
    const lease = leaseIndex.get(slotId);

    if (!lease) {
      slotsToAcquire.push(slotId);
      continue;
    }

    if (lease.ownerId === input.workerId) {
      slotsToRenew.push(slotId);
      continue;
    }

    blockedSlots.push(slotId);
  }

  const slotsToRelease = input.currentLeases
    .filter((lease) => lease.ownerId === input.workerId)
    .map((lease) => lease.slotId)
    .filter((slotId) => !desiredSlotSet.has(slotId))
    .sort((left, right) => left - right);

  return {
    desiredSlots,
    slotsToAcquire,
    slotsToRenew,
    slotsToRelease,
    blockedSlots,
  };
}

export const roundRobinSlotAllocator: SlotAllocatorPort = {
  plan: planSlotRebalance,
};
