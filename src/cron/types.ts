export type CronExpression = string;

export interface CronJob {
  id: string;
  expression: CronExpression;
  payload: Record<string, unknown>;
}

export interface SlotAssignment {
  slotIndex: number;
  jobIds: string[];
}

export interface AllocationResult {
  slotIndex: number;
  added: string[];
  removed: string[];
}

export const SLOT_COUNT = 60;
