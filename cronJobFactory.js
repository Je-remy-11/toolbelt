'use strict';

// ---------- 工具：基于 Intl.DateTimeFormat 的时区本地时间分解 / 组装 ----------

function _dtPartsFor(utcMs, tz) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(utcMs));
  const out = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    year: parseInt(out.year, 10),
    month: parseInt(out.month, 10),
    day: parseInt(out.day, 10),
    hour: parseInt(out.hour, 10) === 24 ? 0 : parseInt(out.hour, 10),
    minute: parseInt(out.minute, 10),
    second: parseInt(out.second, 10),
  };
}

function _offsetMinutes(utcMs, tz) {
  const p = _dtPartsFor(utcMs, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUTC - utcMs) / 60000);
}

function _localToUtcMs(year, month, day, hour, minute, second, tz) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const off0 = _offsetMinutes(guess, tz);
  guess -= off0 * 60000;
  const off1 = _offsetMinutes(guess, tz);
  if (off0 === off1) return guess;
  const off2 = _offsetMinutes(guess - off1 * 60000, tz);
  return off1 === off2 ? guess - off1 * 60000 : guess - off1 * 60000;
}

// ---------- cron 字段解析 ----------

const FIELD_RANGES = [
  { name: 'second', min: 0, max: 59 },
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
];

const MONTH_NAMES = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const DOW_NAMES = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

function _expandToken(token, range) {
  const set = new Set();
  const { min, max } = range;
  const nameMap = range.name === 'month' ? MONTH_NAMES : range.name === 'dayOfWeek' ? DOW_NAMES : null;

  const replaceNames = (s) => {
    if (!nameMap) return s;
    let out = s.toUpperCase();
    for (const k of Object.keys(nameMap)) {
      out = out.split(k).join(String(nameMap[k]));
    }
    return out;
  };

  for (const rawItem of replaceNames(token).split(',')) {
    let item = rawItem;
    let step = 1;
    const slashIdx = item.indexOf('/');
    if (slashIdx !== -1) {
      step = parseInt(item.slice(slashIdx + 1), 10);
      item = item.slice(0, slashIdx);
    }
    let start, end;
    if (item === '*') {
      start = min; end = max;
    } else {
      const dash = item.indexOf('-');
      if (dash !== -1) {
        start = parseInt(item.slice(0, dash), 10);
        end = parseInt(item.slice(dash + 1), 10);
      } else {
        start = parseInt(item, 10);
        end = slashIdx !== -1 ? max : start;
      }
    }
    if (isNaN(start) || isNaN(step) || start < min || end > max) {
      throw new Error(`Invalid cron field "${token}" in ${range.name}`);
    }
    for (let v = start; v <= end; v += step) set.add(v);
  }
  return set;
}

function parseCronExpression(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) throw new Error('Cron expression requires at least 5 fields');

  let fields, timezone = 'UTC';
  if (parts.length === 6 || parts.length === 5) {
    fields = parts.slice(0, parts.length === 6 ? 6 : 5);
    const tail = parts[parts.length - 1];
    if (parts.length === 6 && /[A-Za-z]/.test(tail) && tail.includes('/')) {
      timezone = tail;
      fields = parts.slice(0, 5);
    } else if (parts.length === 6 && /^[A-Za-z_\/]+$/.test(tail)) {
      timezone = tail;
      fields = parts.slice(0, 5);
    }
  } else if (parts.length === 7) {
    fields = parts.slice(0, 6);
    timezone = parts[6];
  } else {
    throw new Error(`Unrecognized cron expression: ${expr}`);
  }

  if (fields.length === 5) fields.unshift('0');

  const expanded = fields.map((tok, i) => _expandToken(tok, FIELD_RANGES[i]));

  try {
    _offsetMinutes(Date.now(), timezone);
  } catch (e) {
    throw new Error(`Invalid timezone: ${timezone}`);
  }

  return {
    seconds: expanded[0],
    minutes: expanded[1],
    hours: expanded[2],
    daysOfMonth: expanded[3],
    months: expanded[4],
    daysOfWeek: expanded[5],
    timezone,
  };
}

// ---------- 计算"下一次运行"（按时区本地时间匹配 cron 字段） ----------

function nextRunAfter(pattern, fromUtcMs) {
  const tz = pattern.timezone;
  const startParts = _dtPartsFor(fromUtcMs, tz);

  let y = startParts.year;
  let mo = startParts.month;
  let d = startParts.day;
  let h = startParts.hour;
  let mi = startParts.minute;
  let s = startParts.second + 1;

  const limit = y + 5;

  while (y < limit) {
    if (!pattern.months.has(mo)) {
      mo += 1; if (mo > 12) { mo = 1; y += 1; }
      d = 1; h = 0; mi = 0; s = 0;
      continue;
    }
    if (s > 59) { s = 0; mi += 1; }
    if (mi > 59) { mi = 0; h += 1; }
    if (h > 23) { h = 0; d += 1; }

    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (d > daysInMonth) { d = 1; mo += 1; if (mo > 12) { mo = 1; y += 1; } continue; }

    const jsDow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    const domOk = pattern.daysOfMonth.has(d);
    const dowOk = pattern.daysOfWeek.has(jsDow);

    const restrictiveDom = pattern.daysOfMonth.size < 31;
    const restrictiveDow = pattern.daysOfWeek.size < 7;
    let dayOk;
    if (restrictiveDom && restrictiveDow) dayOk = domOk || dowOk;
    else if (restrictiveDom) dayOk = domOk;
    else if (restrictiveDow) dayOk = dowOk;
    else dayOk = true;

    if (!dayOk) { d += 1; h = 0; mi = 0; s = 0; continue; }
    if (!pattern.hours.has(h)) { h += 1; mi = 0; s = 0; continue; }
    if (!pattern.minutes.has(mi)) { mi += 1; s = 0; continue; }
    if (!pattern.seconds.has(s)) { s += 1; continue; }

    const candidate = _localToUtcMs(y, mo, d, h, mi, s, tz);
    if (candidate <= fromUtcMs) { s += 1; continue; }
    return candidate;
  }
  throw new Error('Could not find next run within 5 years');
}

// ---------- CronJob + factory ----------

class CronJob {
  constructor(name, pattern, handler, options = {}) {
    this.name = name;
    this.pattern = typeof pattern === 'string' ? parseCronExpression(pattern) : pattern;
    this.handler = handler;
    this.lastRunAt = null;
    this.nextRunAt = null;
    this.running = false;
    this.onError = options.onError || null;
    this.onTick = options.onTick || null;
  }

  refreshNext(fromUtcMs) {
    const base = this.lastRunAt && this.lastRunAt > fromUtcMs ? this.lastRunAt : fromUtcMs;
    this.nextRunAt = nextRunAfter(this.pattern, base);
    return this.nextRunAt;
  }
}

function createCronJobFactory(options = {}) {
  const tickMs = options.tickMs || 1000;
  const jobs = [];
  let timer = null;
  let stopped = false;

  function add(name, expr, handler, jobOptions = {}) {
    const job = new CronJob(name, expr, handler, jobOptions);
    job.refreshNext(Date.now());
    jobs.push(job);
    return job;
  }

  function remove(name) {
    const i = jobs.findIndex(j => j.name === name);
    if (i !== -1) jobs.splice(i, 1);
  }

  function tick() {
    if (stopped) return;
    const now = Date.now();
    for (const job of jobs) {
      if (!job.nextRunAt) job.refreshNext(now);
      if (job.nextRunAt <= now) {
        job.lastRunAt = now;
        const context = {
          job: job.name,
          timezone: job.pattern.timezone,
          firedAt: new Date(now),
          firedAtLocal: new Date(now).toLocaleString('en-US', { timeZone: job.pattern.timezone }),
        };
        if (job.onTick) try { job.onTick(context); } catch (_) {}
        Promise.resolve().then(() => {
          try { return job.handler(context); }
          catch (err) { if (job.onError) job.onError(err, context); }
        }).then(
          () => job.refreshNext(now),
          (err) => { if (job.onError) job.onError(err, context); job.refreshNext(now); }
        );
      }
    }
  }

  function start() {
    if (timer) return;
    stopped = false;
    jobs.forEach(j => j.nextRunAt || j.refreshNext(Date.now()));
    timer = setInterval(tick, tickMs);
  }

  function stop() {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
  }

  function list() {
    return jobs.map(j => ({
      name: j.name,
      timezone: j.pattern.timezone,
      lastRunAt: j.lastRunAt ? new Date(j.lastRunAt) : null,
      nextRunAt: j.nextRunAt ? new Date(j.nextRunAt) : null,
      nextRunAtLocal: j.nextRunAt
        ? new Date(j.nextRunAt).toLocaleString('en-US', { timeZone: j.pattern.timezone })
        : null,
    }));
  }

  return { add, remove, start, stop, list, parse: parseCronExpression, nextRunAfter };
}

module.exports = {
  createCronJobFactory,
  parseCronExpression,
  nextRunAfter,
  CronJob,
};
