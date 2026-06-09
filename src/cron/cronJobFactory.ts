import { ICronAdapter } from './interfaces/ICronAdapter';

export class CronJobFactory {
  /**
   * 依赖注入（Dependency Injection）
   * 工厂不再直接依赖 ioredis，而是依赖 ICronAdapter 接口
   */
  constructor(private readonly adapter: ICronAdapter) {}

  /**
   * 核心逻辑：分配 Slot
   * 现在的逻辑可以直接通过传入 InMemoryAdapter 进行纯单元测试
   */
  async allocateSlot(jobName: string, maxSlots: number, ttl: number): Promise<number | null> {
    const lockKey = `cron:lock:${jobName}`;
    const locked = await this.adapter.acquireLock(lockKey, 2000);
    
    if (!locked) {
      return null; // 无法获取分配锁，可能其他节点正在分配
    }

    try {
      const allocatedSlots = await this.adapter.getAllocatedSlots(jobName);
      
      for (let i = 0; i < maxSlots; i++) {
        if (!allocatedSlots.includes(i)) {
          const success = await this.adapter.registerSlot(jobName, i, ttl);
          if (success) {
            return i; // 成功分配到槽位
          }
        }
      }
      
      return null; // 槽位已满
    } finally {
      await this.adapter.releaseLock(lockKey);
    }
  }

  // 其他任务调度逻辑...
}
