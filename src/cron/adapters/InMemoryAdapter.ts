import { ICronAdapter } from '../interfaces/ICronAdapter';

interface CacheItem {
  value: string;
  expiresAt: number;
}

/**
 * 内存适配器：专门用于单元测试
 * 完全解耦 ioredis，避免 E2E 依赖
 */
export class InMemoryAdapter implements ICronAdapter {
  private store: Map<string, CacheItem> = new Map();

  private cleanup() {
    const now = Date.now();
    for (const [key, item] of this.store.entries()) {
      if (now > item.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  async acquireLock(key: string, ttl: number): Promise<boolean> {
    this.cleanup();
    if (this.store.has(key)) {
      return false;
    }
    this.store.set(key, { value: 'LOCKED', expiresAt: Date.now() + ttl });
    return true;
  }

  async releaseLock(key: string): Promise<void> {
    this.store.delete(key);
  }

  async getAllocatedSlots(jobName: string): Promise<number[]> {
    this.cleanup();
    const prefix = `cron:slots:${jobName}:`;
    const slots: number[] = [];
    
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        const slotId = parseInt(key.replace(prefix, ''), 10);
        if (!isNaN(slotId)) {
          slots.push(slotId);
        }
      }
    }
    return slots;
  }

  async registerSlot(jobName: string, slotId: number, ttl: number): Promise<boolean> {
    this.cleanup();
    const key = `cron:slots:${jobName}:${slotId}`;
    if (this.store.has(key)) {
      return false;
    }
    this.store.set(key, { value: Date.now().toString(), expiresAt: Date.now() + ttl });
    return true;
  }

  async releaseSlot(jobName: string, slotId: number): Promise<void> {
    const key = `cron:slots:${jobName}:${slotId}`;
    this.store.delete(key);
  }
}
