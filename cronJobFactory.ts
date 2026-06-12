import * as cronParser from 'cron-parser';

export interface JobOptions {
  name: string;
  patternWithTz: string; // e.g. "0 9 * * * America/New_York"
  task: () => void | Promise<void>;
}

export interface CronJob {
  name: string;
  cronExpression: string;
  timezone: string;
  nextRunTime: number; // timestamp in milliseconds
  task: () => void | Promise<void>;
}

export class CronJobFactory {
  private jobs: Map<string, CronJob> = new Map();
  private timer: NodeJS.Timeout | null = null;

  /**
   * 解析带有内置时区的 FAST_PATTERN
   * 支持格式: "* * * * * America/New_York" 或标准的 "* * * * *" (默认 UTC)
   */
  private parsePattern(patternWithTz: string): { cronExpression: string; timezone: string } {
    const parts = patternWithTz.trim().split(/\s+/);
    
    // 假设标准 cron 为 5 或 6 位，如果最后一位包含字母或斜杠（如 America/New_York），则将其视为时区
    let cronExpression = patternWithTz;
    let timezone = 'UTC'; // 默认 UTC

    if (parts.length > 5) {
      const lastPart = parts[parts.length - 1];
      if (/[a-zA-Z\/]+/.test(lastPart)) {
        timezone = lastPart;
        cronExpression = parts.slice(0, parts.length - 1).join(' ');
      }
    }

    return { cronExpression, timezone };
  }

  /**
   * 计算下一次执行的时间戳
   */
  private calculateNextRun(cronExpression: string, timezone: string): number {
    try {
      const interval = cronParser.parseExpression(cronExpression, { tz: timezone });
      return interval.next().getTime();
    } catch (err) {
      throw new Error(`Invalid cron expression or timezone: ${cronExpression} ${timezone}`);
    }
  }

  /**
   * 创建并注册一个新任务
   */
  public createJob(options: JobOptions): void {
    const { cronExpression, timezone } = this.parsePattern(options.patternWithTz);
    
    const job: CronJob = {
      name: options.name,
      cronExpression,
      timezone,
      nextRunTime: this.calculateNextRun(cronExpression, timezone),
      task: options.task
    };

    this.jobs.set(options.name, job);
    console.log(`[Job Created] ${job.name} - Pattern: ${job.cronExpression}, TZ: ${job.timezone}, Next Run: ${new Date(job.nextRunTime).toISOString()}`);
  }

  /**
   * 启动核心调度逻辑
   */
  public start(): void {
    if (this.timer) {
      return; // 已经启动
    }

    console.log('Cron scheduler started...');
    
    this.timer = setInterval(async () => {
      const now = Date.now();

      for (const [name, job] of this.jobs.entries()) {
        if (now >= job.nextRunTime) {
          console.log(`[Job Triggered] ${job.name} at ${new Date().toISOString()}`);
          
          Promise.resolve(job.task()).catch(err => {
            console.error(`[Job Error] ${job.name}:`, err);
          });

          job.nextRunTime = this.calculateNextRun(job.cronExpression, job.timezone);
          console.log(`[Job Next Run] ${job.name} scheduled for ${new Date(job.nextRunTime).toISOString()}`);
        }
      }
    }, 1000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('Cron scheduler stopped.');
    }
  }
}
