export interface ILockProvider {
  /**
   * 尝试获取锁
   * @param key 锁的键名
   * @param ttl 锁的存活时间（毫秒）
   * @returns 获取成功返回 true，否则返回 false
   */
  acquireLock(key: string, ttl: number): Promise<boolean>;

  /**
   * 释放锁
   * @param key 锁的键名
   */
  releaseLock(key: string): Promise<void>;
}

export interface ISlotRegistry {
  /**
   * 获取当前任务已分配的槽位列表
   * @param jobName 任务名称
   * @returns 槽位 ID 数组
   */
  getAllocatedSlots(jobName: string): Promise<number[]>;

  /**
   * 为当前节点注册/占用一个槽位
   * @param jobName 任务名称
   * @param slotId 槽位 ID
   * @param ttl 槽位存活时间（毫秒）
   * @returns 注册成功返回 true，被其他节点抢占则返回 false
   */
  registerSlot(jobName: string, slotId: number, ttl: number): Promise<boolean>;

  /**
   * 释放槽位
   * @param jobName 任务名称
   * @param slotId 槽位 ID
   */
  releaseSlot(jobName: string, slotId: number): Promise<void>;
}

/**
 * 分布式 Cron 存储适配器
 * 遵循接口隔离原则，可根据需要拆分或组合
 */
export interface ICronAdapter extends ILockProvider, ISlotRegistry {}
