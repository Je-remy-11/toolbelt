export interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

export interface ParsedCronExpression {
  fields: CronFields;
  timezone: string;
  raw: string;
}

export interface CronJobConfig {
  pattern: string;
  callback: () => void | Promise<void>;
  name?: string;
  runOnInit?: boolean;
  errorHandler?: (err: Error) => void;
}

export interface CronJobInstance {
  start: () => void;
  stop: () => void;
  nextRun: () => Date | null;
  isRunning: () => boolean;
}