from slot_health_endpoint import SlotRegistry, create_health_app, request_health


class FakeClock:
    def __init__(self, start_seconds=1000.0):
        self.current = start_seconds

    def now(self):
        return self.current

    def advance(self, seconds):
        self.current += seconds


def test_readiness_stays_healthy_while_slots_are_in_use_before_drain():
    clock = FakeClock()
    registry = SlotRegistry(drain_timeout_ms=30000, now=clock.now)
    app = create_health_app(registry)

    registry.acquire("slot-a")
    status_code, headers, body = request_health(app, "/health?probe=readiness")

    assert status_code == 200
    assert headers["X-Slot-Active-Count"] == "1"
    assert headers["X-Slot-Draining"] == "false"
    assert body["accepting_traffic"] is True
    assert body["active_slots"] == 1
    assert body["safe_to_terminate"] is False
    assert body["status"] == "ready"


def test_readiness_fails_immediately_after_drain_begins():
    clock = FakeClock()
    registry = SlotRegistry(drain_timeout_ms=30000, now=clock.now)
    app = create_health_app(registry)

    registry.acquire("slot-a")
    registry.begin_drain()
    status_code, headers, body = request_health(app, "/health?probe=readiness")

    assert status_code == 503
    assert headers["X-Slot-Draining"] == "true"
    assert headers["X-Slot-Safe-To-Terminate"] == "false"
    assert body["accepting_traffic"] is False
    assert body["active_slots"] == 1
    assert body["safe_to_terminate"] is False
    assert body["status"] == "draining"


def test_shutdown_probe_reports_not_safe_until_all_slots_are_released():
    clock = FakeClock()
    registry = SlotRegistry(drain_timeout_ms=30000, now=clock.now)
    app = create_health_app(registry)

    registry.acquire("slot-a")
    registry.acquire("slot-b")
    registry.begin_drain()

    waiting_status, _, waiting_body = request_health(app, "/health?probe=shutdown")
    registry.release("slot-a")
    registry.release("slot-b")
    clock.advance(1.5)
    ready_status, ready_headers, ready_body = request_health(app, "/health?probe=shutdown")

    assert waiting_status == 503
    assert waiting_body["status"] == "waiting_for_slot_release"
    assert waiting_body["remaining_drain_ms"] == 30000
    assert ready_status == 200
    assert ready_headers["X-Slot-Safe-To-Terminate"] == "true"
    assert ready_body["active_slots"] == 0
    assert ready_body["safe_to_terminate"] is True
    assert ready_body["status"] == "safe_to_terminate"
    assert ready_body["remaining_drain_ms"] == 28500


def test_new_slot_acquisition_is_rejected_after_drain_begins():
    clock = FakeClock()
    registry = SlotRegistry(drain_timeout_ms=30000, now=clock.now)

    registry.begin_drain()

    try:
        registry.acquire("slot-a")
    except RuntimeError as error:
        assert str(error) == "pod is draining and cannot acquire new slots"
    else:
        raise AssertionError("expected slot acquisition to be rejected during drain")
