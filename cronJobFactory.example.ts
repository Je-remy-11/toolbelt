import { createCronJobFactory, CronJobConfig } from './cronJobFactory';

const factory = createCronJobFactory({
  checkIntervalMs: 30_000,
  defaultTimezone: 'UTC',
  onError: (jobId, error) => {
    console.error(`[${new Date().toISOString()}] Job ${jobId} failed:`, error.message);
  },
  onRun: (jobId) => {
    console.log(`[${new Date().toISOString()}] Job ${jobId} started`);
  },
});

const job1Config: CronJobConfig = {
  name: 'daily-report',
  cronExpression: '0 9 * * *',
  timezone: 'America/New_York',
  handler: async () => {
    console.log('Running daily report at 9 AM New York time');
  },
  maxRetries: 3,
  retryDelayMs: 5000,
};

const job2Config: CronJobConfig = {
  name: 'weekly-cleanup',
  cronExpression: '30 2 * * 0',
  timezone: 'Asia/Shanghai',
  handler: () => {
    console.log('Running weekly cleanup at 2:30 AM Shanghai time on Sunday');
  },
};

const job3Config: CronJobConfig = {
  name: 'every-5-minutes',
  cronExpression: '*/5 * * * *',
  handler: () => {
    console.log('Running every 5 minutes (UTC)');
  },
};

const job1 = factory.createJob(job1Config);
const job2 = factory.createJob(job2Config);
const job3 = factory.createJob(job3Config);

console.log('Created jobs:');
console.log(`- ${job1.id}: next run at ${job1.nextRunTime?.toISOString()}`);
console.log(`- ${job2.id}: next run at ${job2.nextRunTime?.toISOString()}`);
console.log(`- ${job3.id}: next run at ${job3.nextRunTime?.toISOString()}`);

factory.start();

console.log('Scheduler started. Press Ctrl+C to stop.');

process.on('SIGINT', () => {
  console.log('Stopping scheduler...');
  factory.destroy();
  process.exit(0);
});
