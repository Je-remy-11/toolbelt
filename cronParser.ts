import type { CronFields, ParsedCronExpression } from './types';

export const DEFAULT_TIMEZONE = 'UTC';

function expandWildcard(start: number, end: number, step = 1): number[] {
  const result: number[] = [];
  for (let i = start; i <= end; i += step) {
    result.push(i);
  }
  return result;
}

function parseField(field: string, min: number, max: number): number[] {
  if (field === '*') {
    return expandWildcard(min, max);
  }

  if (field.includes(',')) {
    const parts = field.split(',');
    return parts.flatMap(p => parseField(p, min, max));
  }

  if (field.includes('/')) {
    const [range, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (range === '*') {
      return expandWildcard(min, max, step);
    }
    const parts = range.split('-');
    const start = parseInt(parts[0], 10);
    const end = parts.length > 1 ? parseInt(parts[1], 10) : max;
    return expandWildcard(isNaN(start) ? min : start, isNaN(end) ? max : end, step);
  }

  if (field.includes('-')) {
    const [startStr, endStr] = field.split('-');
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    return expandWildcard(start, end);
  }

  const value = parseInt(field, 10);
  return [value];
}

function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function parseCronPattern(pattern: string): ParsedCronExpression {
  const parts = pattern.trim().split(/\s+/);

  let timezone = DEFAULT_TIMEZONE;
  let fields: string[];

  if (parts.length >= 6 && isValidTimezone(parts[5])) {
    timezone = parts[5];
    fields = parts.slice(0, 5);
  } else if (parts.length >= 5) {
    fields = parts.slice(0, 5);
  } else {
    throw new Error(
      `Invalid cron pattern: "${pattern}". Expected at least 5 fields (minute hour day month dow), optionally followed by a timezone.`
    );
  }

  const [minute, hour, dom, month, dow] = fields;

  const parsed: CronFields = {
    minute: Array.from(new Set(parseField(minute, 0, 59))).sort((a, b) => a - b),
    hour: Array.from(new Set(parseField(hour, 0, 23))).sort((a, b) => a - b),
    dayOfMonth: Array.from(new Set(parseField(dom, 1, 31))).sort((a, b) => a - b),
    month: Array.from(new Set(parseField(month, 0, 11))).sort((a, b) => a - b),
    dayOfWeek: Array.from(new Set(parseField(dow, 0, 6))).sort((a, b) => a - b),
  };

  return {
    fields: parsed,
    timezone,
    raw: pattern,
  };
}