import { planSlotRebalance } from '../../src/cron/core/slotAllocator';
import type { SlotRebalanceInput } from '../../src/cron/core/types';

function assertDeepEqual<T>(actual: T, expected: T, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson) {
    throw new Error(`${label}\nexpected: ${expectedJson}\nactual:   ${actualJson}`);
  }
}

function runCase(input: SlotRebalanceInput, expected: ReturnType<typeof planSlotRebalance>, label: string): void {
  const actual = planSlotRebalance(input);
  assertDeepEqual(actual, expected, label);
}

runCase(
  {
    jobName: 'email-digest',
    workerId: 'worker-b',
    totalSlots: 6,
    activeWorkers: ['worker-a', 'worker-b', 'worker-c'],
    currentLeases: [
      { jobName: 'email-digest', slotId: 0, ownerId: 'worker-a', leaseUntil: 10_000 },
      { jobName: 'email-digest', slotId: 1, ownerId: 'worker-b', leaseUntil: 10_000 },
      { jobName: 'email-digest', slotId: 4, ownerId: 'worker-c', leaseUntil: 10_000 },
    ],
  },
  {
    desiredSlots: [1, 4],
    slotsToAcquire: [],
    slotsToRenew: [1],
    slotsToRelease: [],
    blockedSlots: [4],
  },
  'worker-b should renew owned slots and skip slots owned by other workers',
);

runCase(
  {
    jobName: 'email-digest',
    workerId: 'worker-a',
    totalSlots: 5,
    activeWorkers: ['worker-a', 'worker-b'],
    currentLeases: [
      { jobName: 'email-digest', slotId: 0, ownerId: 'worker-a', leaseUntil: 10_000 },
      { jobName: 'email-digest', slotId: 2, ownerId: 'worker-a', leaseUntil: 10_000 },
      { jobName: 'email-digest', slotId: 4, ownerId: 'worker-a', leaseUntil: 10_000 },
    ],
  },
  {
    desiredSlots: [0, 2, 4],
    slotsToAcquire: [],
    slotsToRenew: [0, 2, 4],
    slotsToRelease: [],
    blockedSlots: [],
  },
  'single worker ownership remains stable when partition already matches desired slots',
);

runCase(
  {
    jobName: 'email-digest',
    workerId: 'worker-c',
    totalSlots: 4,
    activeWorkers: ['worker-a', 'worker-b', 'worker-c'],
    currentLeases: [
      { jobName: 'email-digest', slotId: 2, ownerId: 'worker-c', leaseUntil: 10_000 },
      { jobName: 'email-digest', slotId: 3, ownerId: 'worker-c', leaseUntil: 10_000 },
    ],
  },
  {
    desiredSlots: [2],
    slotsToAcquire: [],
    slotsToRenew: [2],
    slotsToRelease: [3],
    blockedSlots: [],
  },
  'worker-c should release slots that no longer belong to it after membership changes',
);
