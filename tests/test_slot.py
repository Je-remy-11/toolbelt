"""Tests for requests_toolbelt.slot.

These tests focus on the two contracts that matter for Kubernetes graceful
shutdown:

* :class:`SlotManager` must expose an atomic, thread-safe snapshot of the
  current occupancy (``is_holding`` / ``snapshot``).
* :class:`HealthServer` must translate that snapshot into HTTP status codes
  (200 when empty, 503 when at least one Slot is held).
"""
import json
import threading
import time

import pytest

try:
    from urllib.request import urlopen, Request
    from urllib.error import HTTPError
except ImportError:  # pragma: no cover - Python 2 compat
    from urllib2 import urlopen, Request, HTTPError  # type: ignore

from requests_toolbelt.slot import HealthServer, SlotManager, TooManySlots


# --------------------------------------------------------------------- utils

def _get(url):
    resp = urlopen(url)
    return resp.status, json.loads(resp.read().decode("utf-8"))


def _get_ignore_503(url):
    try:
        return _get(url)
    except HTTPError as err:
        return err.code, json.loads(err.read().decode("utf-8"))


# --------------------------------------------------------------------- SlotManager

def test_slot_manager_starts_empty():
    s = SlotManager(total=4)
    assert s.total == 4
    assert s.occupied() == 0
    assert s.available() == 4
    assert s.is_holding() is False
    assert s.snapshot()["is_holding"] is False


def test_acquire_increments_occupancy():
    s = SlotManager(total=4)
    token = s.acquire()
    assert s.occupied() == 1
    assert s.is_holding() is True
    assert s.snapshot()["occupied"] == 1
    s.release(token)
    assert s.is_holding() is False


def test_acquire_as_context_manager_releases_on_exit():
    s = SlotManager(total=4)
    with s.acquire():
        assert s.occupied() == 1
    assert s.occupied() == 0


def test_release_is_idempotent():
    s = SlotManager(total=4)
    token = s.acquire()
    s.release(token)
    s.release(token)  # must not raise / leak
    s.release(None)
    s.release("not-a-token")
    assert s.occupied() == 0


def test_too_many_slots_raises():
    s = SlotManager(total=2)
    t1 = s.acquire()
    t2 = s.acquire()
    with pytest.raises(TooManySlots):
        s.acquire()
    s.release(t1)
    s.release(t2)


def test_threaded_acquire_releases():
    s = SlotManager(total=100)
    errors = []

    def run():
        try:
            for _ in range(50):
                with s.acquire():
                    time.sleep(0.001)
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=run) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert s.occupied() == 0
    assert s.snapshot()["held_slots"] == []


def test_snapshot_contains_held_seconds():
    s = SlotManager(total=4)
    with s.acquire():
        snap = s.snapshot()
        assert snap["total"] == 4
        assert snap["available"] == 3
        assert len(snap["held_slots"]) == 1
        assert snap["held_slots"][0]["held_seconds"] >= 0


# --------------------------------------------------------------------- HealthServer

@pytest.fixture
def server():
    slots = SlotManager(total=4)
    srv = HealthServer(slots, host="127.0.0.1", port=0,
                       drain_timeout_seconds=5)
    srv.start()
    try:
        yield srv, slots
    finally:
        srv.stop()


def test_health_empty_returns_200(server):
    srv, _ = server
    status, body = _get("{}health".format(srv.url))
    assert status == 200
    assert body["status"] == "empty"
    assert body["is_holding"] is False
    assert body["occupied"] == 0


def test_health_holding_returns_503(server):
    srv, slots = server
    token = slots.acquire()
    try:
        status, body = _get_ignore_503("{}health".format(srv.url))
        assert status == 503
        assert body["status"] == "holding"
        assert body["is_holding"] is True
        assert body["occupied"] == 1
        assert body["drain_timeout_seconds"] == 5
    finally:
        slots.release(token)


def test_ready_alias_matches_health(server):
    srv, slots = server
    with slots.acquire():
        status, _ = _get_ignore_503("{}ready".format(srv.url))
        assert status == 503


def test_status_always_200_with_snapshot(server):
    srv, slots = server
    with slots.acquire():
        status, body = _get("{}status".format(srv.url))
        assert status == 200
        assert body["is_holding"] is True
        assert len(body["held_slots"]) == 1
        assert body["drain_timeout_seconds"] == 5


def test_unknown_path_returns_404(server):
    srv, _ = server
    status, _ = _get_ignore_503("{}does-not-exist".format(srv.url))
    assert status == 404


# --------------------------------------------------------------------- integration: k8s scale-down handshake

def test_scale_down_handshake_releases_slot_and_becomes_ready(server):
    """Simulate what happens during a Kubernetes graceful drain:

    1. The Pod is holding one Slot -> /health returns 503 (NotReady).
    2. The kubelet observes 503 and waits (keeps endpoints removed).
    3. The work finishes and the Slot is released.
    4. /health returns 200 and the Pod can be safely killed.
    """
    srv, slots = server
    release_at = threading.Event()
    done = threading.Event()

    def work():
        with slots.acquire():
            release_at.wait(timeout=5)
        done.set()

    threading.Thread(target=work, daemon=True).start()

    # Step 1+2: Pod still holds work -> 503
    status, body = _get_ignore_503("{}health".format(srv.url))
    assert status == 503, "should report holding while slot is held"
    assert body["is_holding"] is True

    # Step 3: finish work
    release_at.set()
    assert done.wait(timeout=5)

    # Step 4: slot released -> 200
    status, body = _get("{}health".format(srv.url))
    assert status == 200
    assert body["is_holding"] is False
    assert body["occupied"] == 0


def test_rejects_non_slotmanager():
    with pytest.raises(TypeError):
        HealthServer("not-a-slot-manager", port=0)


def test_rejects_invalid_total():
    with pytest.raises(ValueError):
        SlotManager(total=0)
    with pytest.raises(ValueError):
        SlotManager(total="foo")


def test_healthserver_context_manager():
    slots = SlotManager(total=2)
    with HealthServer(slots, host="127.0.0.1", port=0) as srv:
        status, body = _get("{}health".format(srv.url))
        assert status == 200
        assert body["occupied"] == 0
