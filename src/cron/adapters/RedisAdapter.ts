import { Redis } from 'ioredis';
import { ICronAdapter } from '../interfaces/ICronAdapter';

export class RedisCronAdapter implements ICronAdapter {
  constructor(private readonly redis: Redis) {}

  async acquireLock(key: string, ttl: number): Promise<boolean> {
    const result = await this.redis.set(key, 'LOCKED', 'PX', ttl, 'NX');
    return result === 'OK';
  }

  async releaseLock(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async getAllocatedSlots(jobName: string): Promise<number[]> {
    const pattern = `cron:slots:${jobName}:*`;
    const keys = await this.redis.keys(pattern);
    return keys.map((key) => parseInt(key.split(':').pop() || '0', 10));
  }

  async registerSlot(jobName: string, slotId: number, ttl: number): Promise<boolean> {
    const key = `cron:slots:${jobName}:${slotId}`;
    const result = await this.redis.set(key, Date.now().toString(), 'PX', ttl, 'NX');
    return result === 'OK';
  }

  async releaseSlot(jobName: string, slotId: number): Promise<void> {
    const key = `cron:slots:${jobName}:${slotId}`;
    await this.redis.del(key);
  }
}
