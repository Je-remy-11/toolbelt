"""Tests demonstrating the zombie-handler problem and the abortable fix.

The first test reproduces the state inconsistency described in the question:

    * a slow handler is launched inside a worker,
    * the caller times it out and marks it failed,
    * the handler is *still* executing in the background (the "zombie"),
    * graceful shutdown without force-abort would hang or leak.

The second test proves that :meth:`HandlerRunner.abort` /
:meth:`HandlerPool.stop` actually interrupt the live handler.
"""

import threading
import time
import unittest
import unittest.mock

from requests_toolbelt.threaded.abortable import (
    HandlerPool,
    HandlerRunner,
    ProcessHandlerRunner,
)


class _SlowHandler(object):
    """Simulates a handler that ignores a "cancel please" flag on its own."""

    def __init__(self, sleep_for=10.0):
        self.sleep_for = sleep_for
        self.called = False
        self.finished = False
        self._lock = threading.Lock()

    def __call__(self, request_kwargs):
        with self._lock:
            self.called = True
        # Intentional plain time.sleep -- like a blocking C extension call
        # that does not poll a threading.Event.
        time.sleep(self.sleep_for)
        with self._lock:
            self.finished = True
        return "ok"


class TestHandlerTimeoutZombie(unittest.TestCase):
    """Reproduce the zombie-handler scenario from the question."""

    def test_timeout_marks_failed_but_handler_still_runs(self):
        """Without abort logic the handler keeps going AFTER a timeout."""
        slow = _SlowHandler(sleep_for=5.0)
        runner = HandlerRunner(slow, handler_timeout=0.1)

        result = runner.run({"url": "slow"})

        self.assertTrue(result.timed_out, "caller must see a failed result")
        self.assertFalse(result.ok)
        # This is the inconsistency: the caller thinks it failed, yet the
        # underlying thread is still alive and will finish its work.
        self.assertTrue(
            runner.is_running or slow.called,
            "zombie handler must still be running in the process",
        )
        # Clean up for real so the test suite doesn't leak threads.
        runner.abort(grace=0.2)


class TestStopAbortsZombie(unittest.TestCase):
    """stop() must force-interrupt the zombie handler."""

    def test_abort_kills_the_worker_thread(self):
        slow = _SlowHandler(sleep_for=30.0)
        runner = HandlerRunner(slow, handler_timeout=0.05,
                               allow_async_exc=True)
        runner.run({"url": "slow"})
        self.assertTrue(runner.is_running, "sanity: worker must still be alive")

        stopped = runner.abort(grace=0.2)

        self.assertTrue(stopped, "worker must have been forced down")
        self.assertFalse(runner.is_running, "worker must not be alive")

    def test_pool_stop_uses_two_phase_shutdown(self):
        slow = _SlowHandler(sleep_for=30.0)
        pool = HandlerPool(slow, handler_timeout=0.05, size=2,
                           allow_async_exc=True)
        for _ in range(4):
            pool.submit({"url": "zombie-{}".format(_)})

        # Kick off a few jobs, then stop *before* they would naturally finish.
        thread = threading.Thread(target=pool.run_until_complete, daemon=True)
        thread.start()
        time.sleep(0.2)  # let at least one worker pick up a slow job

        graceful, forced = pool.stop(grace=0.3)
        thread.join(timeout=1.0)

        self.assertEqual(graceful + forced, 2,
                         "both workers must be accounted for at stop time")
        self.assertFalse(thread.is_alive(),
                         "pool thread must return; stop() must not hang")

    def test_process_runner_is_guaranteed_killed(self):
        slow = _SlowHandler(sleep_for=30.0)
        runner = ProcessHandlerRunner(slow, handler_timeout=0.1)
        result = runner.run({"url": "slow"})
        self.assertTrue(result.timed_out)
        self.assertFalse(runner.is_running, "subprocess must be terminated")


class TestPoolHappyPath(unittest.TestCase):
    def test_run_fast_handlers_and_stop_cleanly(self):
        calls = []

        def handler(kwargs):
            calls.append(kwargs)
            return "reply"

        with HandlerPool(handler, handler_timeout=2.0, size=2) as pool:
            for i in range(4):
                pool.submit({"n": i})
            results = pool.run_until_complete()

        self.assertEqual(len(calls), 4)
        self.assertTrue(all(r.ok for r in results))


if __name__ == "__main__":
    unittest.main()
