"""
AbortController - 可复用的中断控制器模块

用于强制中断长时间运行的 handler，解决 Graceful Shutdown 时的状态不一致问题。
"""

import threading
import time
import logging
from typing import Optional, Callable, Any, Dict
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


class AbortSignal:
    """
    中断信号类，用于通知 handler 需要中断执行
    
    用法：
        signal = AbortSignal()
        
        # 在 handler 中检查信号
        def my_handler(signal):
            for item in work_items:
                if signal.is_aborted:
                    # 清理资源并退出
                    cleanup()
                    return
                process(item)
        
        # 触发中断
        signal.abort()
    """
    
    def __init__(self):
        self._event = threading.Event()
        self._reason: Optional[str] = None
        self._callbacks: list = []
    
    @property
    def is_aborted(self) -> bool:
        return self._event.is_set()
    
    @property
    def reason(self) -> Optional[str]:
        return self._reason
    
    def abort(self, reason: str = "Operation aborted"):
        """触发中断信号"""
        if not self.is_aborted:
            self._reason = reason
            self._event.set()
            for callback in self._callbacks:
                try:
                    callback(reason)
                except Exception as e:
                    logger.error(f"Error in abort callback: {e}")
    
    def on_abort(self, callback: Callable[[str], None]):
        """注册中断回调"""
        self._callbacks.append(callback)
    
    def wait(self, timeout: Optional[float] = None) -> bool:
        """等待中断信号，返回是否被中断"""
        return self._event.wait(timeout=timeout)
    
    def reset(self):
        """重置信号（谨慎使用）"""
        self._event.clear()
        self._reason = None


class AbortController:
    """
    中断控制器，用于创建和管理 AbortSignal
    
    用法：
        controller = AbortController()
        signal = controller.signal
        
        # 启动 handler
        thread = threading.Thread(target=my_handler, args=(signal,))
        thread.start()
        
        # 需要中断时
        controller.abort("Timeout")
    """
    
    def __init__(self):
        self.signal = AbortSignal()
    
    def abort(self, reason: str = "Operation aborted"):
        self.signal.abort(reason)


@dataclass
class TaskContext:
    """任务执行上下文，包含中断信号和状态管理"""
    task_id: str
    signal: AbortSignal = field(default_factory=AbortSignal)
    result: Any = None
    error: Optional[Exception] = None
    start_time: float = field(default_factory=time.time)
    
    @property
    def is_aborted(self) -> bool:
        return self.signal.is_aborted
    
    @property
    def elapsed(self) -> float:
        return time.time() - self.start_time
    
    def abort(self, reason: str = "Task aborted"):
        self.signal.abort(reason)
    
    def check_timeout(self, timeout: float) -> bool:
        """检查是否超时，如果超时则自动中断"""
        if self.elapsed > timeout:
            self.abort(f"Task timed out after {self.elapsed:.2f}s (limit: {timeout}s)")
            return True
        return False
    
    def sleep(self, seconds: float) -> bool:
        """可中断的睡眠，返回是否被中断"""
        return self.signal.wait(timeout=seconds)


class TaskManager:
    """
    任务管理器，用于管理多个可中断的任务
    
    用法：
        manager = TaskManager()
        
        # 提交任务
        manager.submit("task-1", my_handler, timeout=10.0)
        
        # 中断单个任务
        manager.abort_task("task-1")
        
        # Graceful Shutdown
        manager.shutdown(timeout=30.0)
    """
    
    def __init__(self, default_timeout: float = 30.0, shutdown_timeout: float = 10.0):
        self.default_timeout = default_timeout
        self.shutdown_timeout = shutdown_timeout
        self._tasks: Dict[str, TaskContext] = {}
        self._threads: Dict[str, threading.Thread] = {}
        self._lock = threading.Lock()
        self._running = True
    
    def submit(self, task_id: str, handler: Callable, timeout: Optional[float] = None, **kwargs) -> TaskContext:
        """提交一个可中断的任务"""
        ctx = TaskContext(task_id=task_id)
        timeout = timeout or self.default_timeout
        
        thread = threading.Thread(
            target=self._run_task,
            args=(ctx, handler, timeout),
            kwargs=kwargs,
            daemon=True,
            name=f"task-{task_id}"
        )
        
        with self._lock:
            self._tasks[task_id] = ctx
            self._threads[task_id] = thread
        
        thread.start()
        return ctx
    
    def _run_task(self, ctx: TaskContext, handler: Callable, timeout: float, **kwargs):
        try:
            result = handler(ctx, **kwargs)
            if not ctx.is_aborted:
                ctx.result = result
        except Exception as e:
            if not ctx.is_aborted:
                ctx.error = e
                logger.error(f"Task {ctx.task_id} failed: {e}")
    
    def abort_task(self, task_id: str, reason: str = "Task aborted"):
        """中断指定任务"""
        with self._lock:
            ctx = self._tasks.get(task_id)
            if ctx:
                ctx.abort(reason)
                logger.info(f"Abort signal sent to task {task_id}")
    
    def get_task(self, task_id: str) -> Optional[TaskContext]:
        with self._lock:
            return self._tasks.get(task_id)
    
    @property
    def active_tasks(self) -> list:
        with self._lock:
            return [
                (task_id, ctx) 
                for task_id, ctx in self._tasks.items()
                if self._threads.get(task_id) and self._threads[task_id].is_alive()
            ]
    
    def shutdown(self, timeout: Optional[float] = None, reason: str = "Shutdown"):
        """
        Graceful Shutdown，强制中断所有活跃任务
        
        步骤：
            1. 标记停止状态
            2. 向所有活跃任务发送 abort 信号
            3. 等待任务结束（带超时）
            4. 记录未响应的任务
        """
        self._running = False
        timeout = timeout or self.shutdown_timeout
        
        logger.info(f"Graceful shutdown initiated (timeout: {timeout}s)")
        
        with self._lock:
            active = [
                (task_id, ctx, self._threads[task_id])
                for task_id, ctx in self._tasks.items()
                if self._threads.get(task_id) and self._threads[task_id].is_alive()
            ]
        
        if not active:
            logger.info("No active tasks, shutdown complete")
            return
        
        logger.info(f"Found {len(active)} active tasks, sending abort signals...")
        
        # 发送 abort 信号
        for task_id, ctx, _ in active:
            ctx.abort(reason)
        
        # 等待任务结束
        deadline = time.time() + timeout
        for task_id, ctx, thread in active:
            remaining = max(0, deadline - time.time())
            if remaining > 0:
                thread.join(timeout=remaining)
            
            if thread.is_alive():
                logger.error(
                    f"Task {task_id} did not respond to abort signal, "
                    f"forcing termination"
                )
            else:
                logger.info(f"Task {task_id} terminated gracefully")
        
        logger.info("Shutdown complete")
    
    def wait_all(self, timeout: Optional[float] = None) -> bool:
        """等待所有任务完成，返回是否全部完成"""
        with self._lock:
            threads = list(self._threads.values())
        
        deadline = time.time() + (timeout or float('inf'))
        for thread in threads:
            remaining = max(0, deadline - time.time())
            if remaining > 0:
                thread.join(timeout=remaining)
            if thread.is_alive():
                return False
        return True
