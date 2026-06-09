"""
AbortController 单元测试

验证中断控制器在 handler timeout 和 graceful shutdown 场景下的正确性。
"""

import pytest
import threading
import time
from abort_controller import AbortSignal, AbortController, TaskContext, TaskManager


class TestAbortSignal:
    def test_initial_state(self):
        signal = AbortSignal()
        assert not signal.is_aborted
        assert signal.reason is None
    
    def test_abort_sets_state(self):
        signal = AbortSignal()
        signal.abort("Test reason")
        assert signal.is_aborted
        assert signal.reason == "Test reason"
    
    def test_abort_is_idempotent(self):
        signal = AbortSignal()
        signal.abort("First reason")
        signal.abort("Second reason")
        assert signal.reason == "First reason"
    
    def test_callback_is_called(self):
        signal = AbortSignal()
        callback_called = []
        
        def callback(reason):
            callback_called.append(reason)
        
        signal.on_abort(callback)
        signal.abort("Test")
        assert callback_called == ["Test"]
    
    def test_multiple_callbacks(self):
        signal = AbortSignal()
        results = []
        
        signal.on_abort(lambda r: results.append(1))
        signal.on_abort(lambda r: results.append(2))
        signal.on_abort(lambda r: results.append(3))
        
        signal.abort()
        assert results == [1, 2, 3]
    
    def test_wait_returns_true_on_abort(self):
        signal = AbortSignal()
        
        def abort_after_delay():
            time.sleep(0.1)
            signal.abort()
        
        threading.Thread(target=abort_after_delay).start()
        result = signal.wait(timeout=1.0)
        assert result is True
    
    def test_wait_returns_false_on_timeout(self):
        signal = AbortSignal()
        result = signal.wait(timeout=0.1)
        assert result is False
    
    def test_reset(self):
        signal = AbortSignal()
        signal.abort()
        signal.reset()
        assert not signal.is_aborted


class TestAbortController:
    def test_controller_creates_signal(self):
        controller = AbortController()
        assert controller.signal is not None
        assert not controller.signal.is_aborted
    
    def test_controller_abort(self):
        controller = AbortController()
        controller.abort("Test")
        assert controller.signal.is_aborted
        assert controller.signal.reason == "Test"


class TestTaskContext:
    def test_initial_state(self):
        ctx = TaskContext("test-task")
        assert not ctx.is_aborted
        assert ctx.result is None
        assert ctx.error is None
    
    def test_abort(self):
        ctx = TaskContext("test-task")
        ctx.abort("Test reason")
        assert ctx.is_aborted
    
    def test_elapsed_time(self):
        ctx = TaskContext("test-task")
        time.sleep(0.1)
        assert ctx.elapsed >= 0.1
    
    def test_check_timeout_no_timeout(self):
        ctx = TaskContext("test-task")
        assert not ctx.check_timeout(timeout=10.0)
        assert not ctx.is_aborted
    
    def test_check_timeout_triggers(self):
        ctx = TaskContext("test-task")
        ctx.start_time = time.time() - 5  # Simulate 5 seconds elapsed
        assert ctx.check_timeout(timeout=1.0)
        assert ctx.is_aborted
    
    def test_sleep_interruptible(self):
        ctx = TaskContext("test-task")
        
        def abort_after_delay():
            time.sleep(0.1)
            ctx.abort()
        
        threading.Thread(target=abort_after_delay).start()
        interrupted = ctx.sleep(seconds=1.0)
        assert interrupted is True
    
    def test_sleep_completes(self):
        ctx = TaskContext("test-task")
        interrupted = ctx.sleep(seconds=0.1)
        assert interrupted is False


class TestTaskManager:
    def test_submit_and_complete(self):
        manager = TaskManager()
        
        def quick_task(ctx):
            return "done"
        
        ctx = manager.submit("task-1", quick_task)
        assert manager.wait_all(timeout=5.0)
        assert ctx.result == "done"
    
    def test_submit_with_error(self):
        manager = TaskManager()
        
        def failing_task(ctx):
            raise ValueError("Test error")
        
        ctx = manager.submit("task-1", failing_task)
        manager.wait_all(timeout=5.0)
        assert ctx.error is not None
        assert isinstance(ctx.error, ValueError)
    
    def test_abort_task(self):
        manager = TaskManager()
        
        def long_task(ctx):
            while not ctx.is_aborted:
                time.sleep(0.1)
            return "aborted"
        
        ctx = manager.submit("task-1", long_task)
        time.sleep(0.1)
        manager.abort_task("task-1")
        assert manager.wait_all(timeout=5.0)
    
    def test_graceful_shutdown(self):
        manager = TaskManager()
        completed_tasks = []
        
        def long_task(ctx, task_num):
            for i in range(100):
                if ctx.is_aborted:
                    completed_tasks.append(f"task-{task_num}-aborted")
                    return
                time.sleep(0.1)
            completed_tasks.append(f"task-{task_num}-completed")
        
        manager.submit("task-1", long_task, task_num=1)
        manager.submit("task-2", long_task, task_num=2)
        manager.submit("task-3", long_task, task_num=3)
        
        time.sleep(0.5)
        manager.shutdown(timeout=2.0)
        
        assert all("aborted" in t for t in completed_tasks)
    
    def test_shutdown_with_unresponsive_task(self):
        manager = TaskManager(shutdown_timeout=0.5)
        
        def unresponsive_task(ctx):
            while True:
                time.sleep(10)
        
        manager.submit("task-1", unresponsive_task)
        time.sleep(0.1)
        
        manager.shutdown(timeout=0.5)
        ctx = manager.get_task("task-1")
        assert ctx is not None
    
    def test_active_tasks(self):
        manager = TaskManager()
        
        def long_task(ctx):
            time.sleep(10)
        
        manager.submit("task-1", long_task)
        manager.submit("task-2", long_task)
        
        time.sleep(0.1)
        active = manager.active_tasks
        assert len(active) == 2
        
        manager.abort_task("task-1")
        manager.abort_task("task-2")
        manager.wait_all(timeout=5.0)
        
        assert len(manager.active_tasks) == 0
    
    def test_concurrent_submit_and_abort(self):
        manager = TaskManager()
        
        def long_task(ctx):
            while not ctx.is_aborted:
                time.sleep(0.1)
        
        threads = []
        for i in range(10):
            t = threading.Thread(target=lambda: manager.submit(f"task-{i}", long_task))
            threads.append(t)
            t.start()
        
        for t in threads:
            t.join()
        
        time.sleep(0.1)
        assert len(manager.active_tasks) == 10
        
        manager.shutdown(timeout=2.0)
        assert len(manager.active_tasks) == 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
