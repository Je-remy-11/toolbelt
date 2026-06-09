import { parseCronPattern } from './cronParser';
import type { CronFields, CronJobConfig, CronJobInstance } from './types';

interface TzDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  toUTC(): Date;
  addMinutes(n: number): TzDateTime;
  clone(): TzDateTime;
}

class TzDateTimeImpl implements TzDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  private timezone: string;

  constructor(date: Date, timezone: string) {
    this.timezone = timezone;
    const parts = getTimezoneParts(date, timezone);
    this.year = parts.year;
    this.month = parts.month;
    this.day = parts.day;
    this.hour = parts.hour;
    this.minute = parts.minute;
    this.second = parts.second;
    this.weekday = parts.weekday;
  }

  clone(): TzDateTime {
    const d = new Date(this.toUTC().getTime());
    return new TzDateTimeImpl(d, this.timezone);
  }

  toUTC(): Date {
    const probeMs = Date.UTC(this.year, this.month - 1, this.day, 12, 0, 0);
    const probeDate = new Date(probeMs);
    const parts = getTimezoneParts(probeDate, this.timezone);

    const localInterp = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0
    );
    const offsetMs = localInterp - probeMs;

    const targetAsUtc = Date.UTC(
      this.year,
      this.month - 1,
      this.day,
      this.hour,
      this.minute,
      0
    );

    return new Date(targetAsUtc - offsetMs);
  }

  addMinutes(n: number): TzDateTime {
    let ms = this.toUTC().getTime();
    if (isNaN(ms)) return this;
    ms += n * 60000;
    return new TzDateTimeImpl(new Date(ms), this.timezone);
  }
}

function getTimezoneParts(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = p.value;
    }
  }

  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour: parseInt(map.hour, 10),
    minute: parseInt(map.minute, 10),
    second: parseInt(map.second, 10),
    weekday: weekdayMap[map.weekday] ?? 0,
  };
}

function createTzDateTime(date: Date, timezone: string): TzDateTime {
  return new TzDateTimeImpl(date, timezone);
}

function isCronMatch(dt: TzDateTime, fields: CronFields): boolean {
  if (!fields.minute.includes(dt.minute)) return false;
  if (!fields.hour.includes(dt.hour)) return false;
  if (!fields.month.includes(dt.month)) return false;

  const domMatch = fields.dayOfMonth.includes(dt.day);
  const dowMatch = fields.dayOfWeek.includes(dt.weekday);

  return domMatch && dowMatch;
}

function findNextMatchingMinute(from: TzDateTime, fields: CronFields): TzDateTime | null {
  let current = from.clone();

  for (let day = 0; day < 366; day++) {
    for (let minute = 0; minute < 1440; minute++) {
      if (isCronMatch(current, fields)) {
        return current;
      }
      current = current.addMinutes(1);
    }
  }

  return null;
}

function findNextRun(fields: CronFields, timezone: string, fromDate: Date): Date | null {
  const tzNow = createTzDateTime(fromDate, timezone);
  const nextMin = tzNow.addMinutes(1);

  const next = findNextMatchingMinute(nextMin, fields);
  if (!next) return null;

  return next.toUTC();
}

export function createCronJob(config: CronJobConfig): CronJobInstance {
  const { pattern, callback, runOnInit = false, errorHandler } = config;

  const parsed = parseCronPattern(pattern);
  const { fields, timezone } = parsed;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let nextRunDate: Date | null = null;

  const execute = async () => {
    try {
      await callback();
    } catch (err) {
      if (errorHandler) {
        errorHandler(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  const scheduleNext = () => {
    if (!running) return;

    const now = new Date();
    const next = findNextRun(fields, timezone, now);

    if (!next) {
      nextRunDate = null;
      return;
    }

    nextRunDate = next;
    const delay = next.getTime() - Date.now();

    timeoutId = setTimeout(async () => {
      await execute();
      scheduleNext();
    }, Math.max(0, delay));
  };

  const start = () => {
    if (running) return;
    running = true;

    if (runOnInit) {
      execute().then(() => scheduleNext());
    } else {
      scheduleNext();
    }
  };

  const stop = () => {
    running = false;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    nextRunDate = null;
  };

  const nextRun = (): Date | null => nextRunDate;
  const isRunning = (): boolean => running;

  return {
    start,
    stop,
    nextRun,
    isRunning,
  };
}