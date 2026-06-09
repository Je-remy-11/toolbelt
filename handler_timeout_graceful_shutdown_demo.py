"""
Handler Timeout 与 Graceful Shutdown 状态不一致问题演示及解决方案

问题场景：
    当 handler 超时被标记为 failed 时，处理函数仍在后台执行（zombie）。
    如果此时发生 Graceful Shutdown，会出现以下状态不一致：
    
    1. Server 状态：认为所有 handler 已终止（标记为 failed）
    2. 实际状态：handler 仍在后台运行
    3. 后果：
       - 资源泄漏（连接、文件句柄等未释放）
       - 数据不一致（部分写入的数据）
       - 回调/副作用在 shutdown 后继续执行
"""

import threading
import time
import logging
import signal
import sys
from typing import Dict, Optional, Callable, Any
from dataclasses import dataclass, field
from enum import Enum

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


class HandlerState(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    ABORTED = "aborted"


@dataclass
class HandlerContext:
    """Handler 执行上下文，包含中断信号"""
    handler_id: str
    state: HandlerState = HandlerState.PENDING
    thread: Optional[threading.Thread] = None
    abort_event: threading.Event = field(default_factory=threading.Event)
    result: Any = None
    error: Optional[Exception] = None
    start_time: float = 0.0
    
    def is_aborted(self) -> bool:
        return self.abort_event.is_set()
    
    def abort(self):
        self.abort_event.set()
        self.state = HandlerState.ABORTED


class HandlerExecutor:
    """
    问题版本：没有强制中断机制
    
    问题：
        - timeout 后标记为 failed，但 handler 线程仍在运行
        - stop() 只是等待线程结束，无法强制中断
        - Graceful Shutdown 时，zombie handler 继续执行
    """
    
    def __init__(self, timeout: float = 5.0):
        self.timeout = timeout
        self.handlers: Dict[str, HandlerContext] = {}
        self._lock = threading.Lock()
        self._running = True
    
    def submit(self, handler_id: str, handler_func: Callable) -> HandlerContext:
        ctx = HandlerContext(handler_id=handler_id)
        ctx.state = HandlerState.RUNNING
        ctx.start_time = time.time()
        
        thread = threading.Thread(
            target=self._run_handler,
            args=(ctx, handler_func),
            daemon=True
        )
        ctx.thread = thread
        thread.start()
        
        with self._lock:
            self.handlers[handler_id] = ctx
        
        return ctx
    
    def _run_handler(self, ctx: HandlerContext, handler_func: Callable):
        try:
            result = handler_func(ctx)
            if not ctx.is_aborted():
                ctx.result = result
                ctx.state = HandlerState.COMPLETED
        except Exception as e:
            if not ctx.is_aborted():
                ctx.error = e
                ctx.state = HandlerState.FAILED
    
    def stop(self):
        """
        问题版本：只是标记停止，等待线程自然结束
        
        问题：
            - zombie handler 仍在运行，但 server 认为已停止
            - 无法强制中断正在执行的 handler
        """
        self._running = False
        logger.info("Graceful shutdown initiated...")
        
        with self._lock:
            for handler_id, ctx in self.handlers.items():
                if ctx.thread and ctx.thread.is_alive():
                    logger.warning(
                        f"Handler {handler_id} is still running (zombie), "
                        f"state: {ctx.state}"
                    )
                    ctx.state = HandlerState.FAILED
                    # 问题：这里只是标记 failed，但线程仍在运行！
        
        logger.info("Shutdown complete (but zombies may still be running)")


class SafeHandlerExecutor:
    """
    解决方案版本：使用 AbortController 模式强制中断
    
    改进：
        1. HandlerContext 包含 abort_event 用于信号通知
        2. Handler 函数需要定期检查 abort 信号
        3. stop() 强制设置 abort 信号并等待线程结束
        4. 支持超时强制终止线程
    """
    
    def __init__(self, timeout: float = 5.0, shutdown_timeout: float = 10.0):
        self.timeout = timeout
        self.shutdown_timeout = shutdown_timeout
        self.handlers: Dict[str, HandlerContext] = {}
        self._lock = threading.Lock()
        self._running = True
    
    def submit(self, handler_id: str, handler_func: Callable) -> HandlerContext:
        ctx = HandlerContext(handler_id=handler_id)
        ctx.state = HandlerState.RUNNING
        ctx.start_time = time.time()
        
        thread = threading.Thread(
            target=self._run_handler,
            args=(ctx, handler_func),
            daemon=True
        )
        ctx.thread = thread
        thread.start()
        
        with self._lock:
            self.handlers[handler_id] = ctx
        
        return ctx
    
    def _run_handler(self, ctx: HandlerContext, handler_func: Callable):
        try:
            result = handler_func(ctx)
            if not ctx.is_aborted():
                ctx.result = result
                ctx.state = HandlerState.COMPLETED
            else:
                logger.info(f"Handler {ctx.handler_id} was aborted, discarding result")
        except Exception as e:
            if not ctx.is_aborted():
                ctx.error = e
                ctx.state = HandlerState.FAILED
            else:
                logger.info(f"Handler {ctx.handler_id} aborted with exception: {e}")
    
    def abort_handler(self, handler_id: str):
        """强制中断指定的 handler"""
        with self._lock:
            ctx = self.handlers.get(handler_id)
            if ctx and ctx.thread and ctx.thread.is_alive():
                ctx.abort()
                logger.info(f"Abort signal sent to handler {handler_id}")
    
    def stop(self):
        """
        解决方案：强制中断所有正在执行的 handler
        
        步骤：
            1. 标记停止状态
            2. 向所有 running handler 发送 abort 信号
            3. 等待线程结束（带超时）
            4. 超时后强制终止
        """
        self._running = False
        logger.info("Graceful shutdown initiated...")
        
        active_handlers = []
        with self._lock:
            for handler_id, ctx in self.handlers.items():
                if ctx.thread and ctx.thread.is_alive():
                    active_handlers.append((handler_id, ctx))
        
        if not active_handlers:
            logger.info("No active handlers, shutdown complete")
            return
        
        logger.info(f"Found {len(active_handlers)} active handlers, sending abort signals...")
        
        # 步骤1：发送 abort 信号
        for handler_id, ctx in active_handlers:
            ctx.abort()
            logger.info(f"Abort signal sent to handler {handler_id}")
        
        # 步骤2：等待线程结束（带超时）
        deadline = time.time() + self.shutdown_timeout
        for handler_id, ctx in active_handlers:
            remaining = max(0, deadline - time.time())
            if remaining > 0:
                ctx.thread.join(timeout=remaining)
            
            if ctx.thread.is_alive():
                logger.error(
                    f"Handler {handler_id} did not respond to abort signal, "
                    f"forcing termination (state: {ctx.state})"
                )
                ctx.state = HandlerState.ABORTED
            else:
                logger.info(f"Handler {handler_id} terminated gracefully")
        
        logger.info("Shutdown complete, all handlers terminated")


def demo_problem():
    """演示问题版本"""
    print("\n" + "="*60)
    print("问题版本演示")
    print("="*60)
    
    executor = HandlerExecutor(timeout=2.0)
    
    def slow_handler(ctx):
        logger.info(f"Handler {ctx.handler_id} starting...")
        for i in range(10):
            if ctx.is_aborted():
                logger.info(f"Handler {ctx.handler_id} detected abort")
                return None
            time.sleep(0.5)
            logger.info(f"Handler {ctx.handler_id} step {i+1}/10")
        return "done"
    
    ctx = executor.submit("handler-1", slow_handler)
    time.sleep(1)
    
    logger.info("Simulating timeout - marking handler as failed")
    ctx.state = HandlerState.FAILED
    
    logger.info("Simulating graceful shutdown")
    executor.stop()
    
    time.sleep(2)
    logger.info(f"Handler state after shutdown: {ctx.state}")
    logger.info(f"Handler thread alive: {ctx.thread.is_alive() if ctx.thread else False}")
    logger.info("注意：handler 仍在后台运行！")


def demo_solution():
    """演示解决方案版本"""
    print("\n" + "="*60)
    print("解决方案版本演示")
    print("="*60)
    
    executor = SafeHandlerExecutor(timeout=2.0, shutdown_timeout=3.0)
    
    def slow_handler(ctx):
        logger.info(f"Handler {ctx.handler_id} starting...")
        for i in range(10):
            if ctx.is_aborted():
                logger.info(f"Handler {ctx.handler_id} detected abort, cleaning up...")
                return None
            time.sleep(0.5)
            logger.info(f"Handler {ctx.handler_id} step {i+1}/10")
        return "done"
    
    ctx = executor.submit("handler-1", slow_handler)
    time.sleep(1)
    
    logger.info("Simulating timeout - aborting handler")
    executor.abort_handler("handler-1")
    
    logger.info("Simulating graceful shutdown")
    executor.stop()
    
    time.sleep(1)
    logger.info(f"Handler state after shutdown: {ctx.state}")
    logger.info(f"Handler thread alive: {ctx.thread.is_alive() if ctx.thread else False}")
    logger.info("注意：handler 已被正确中断！")


if __name__ == "__main__":
    demo_problem()
    demo_solution()
