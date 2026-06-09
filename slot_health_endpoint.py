import json
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Callable, Dict, Iterable, Optional, Tuple
from urllib.parse import parse_qs


@dataclass(frozen=True)
class SlotHealthSnapshot:
    active_slots: int
    draining: bool
    accepting_traffic: bool
    safe_to_terminate: bool
    drain_timeout_ms: int
    drain_started_at_ms: Optional[int]
    drain_deadline_at_ms: Optional[int]
    remaining_drain_ms: Optional[int]


class SlotRegistry:
    def __init__(self, drain_timeout_ms: int, now: Optional[Callable[[], float]] = None) -> None:
        self._drain_timeout_ms = drain_timeout_ms
        self._now = now or time.time
        self._slots: Dict[str, int] = {}
        self._draining = False
        self._drain_started_at_ms: Optional[int] = None
        self._lock = threading.Lock()

    def acquire(self, slot_id: Optional[str] = None) -> str:
        with self._lock:
            if self._draining:
                raise RuntimeError("pod is draining and cannot acquire new slots")
            resolved_slot_id = slot_id or str(uuid.uuid4())
            self._slots[resolved_slot_id] = self._now_ms()
            return resolved_slot_id

    def release(self, slot_id: str) -> bool:
        with self._lock:
            return self._slots.pop(slot_id, None) is not None

    def begin_drain(self) -> None:
        with self._lock:
            if self._draining:
                return
            self._draining = True
            self._drain_started_at_ms = self._now_ms()

    def snapshot(self) -> SlotHealthSnapshot:
        with self._lock:
            active_slots = len(self._slots)
            drain_started_at_ms = self._drain_started_at_ms
            draining = self._draining

        drain_deadline_at_ms = None
        remaining_drain_ms = None
        if drain_started_at_ms is not None:
            drain_deadline_at_ms = drain_started_at_ms + self._drain_timeout_ms
            remaining_drain_ms = max(0, drain_deadline_at_ms - self._now_ms())

        accepting_traffic = not draining
        safe_to_terminate = draining and active_slots == 0
        return SlotHealthSnapshot(
            active_slots=active_slots,
            draining=draining,
            accepting_traffic=accepting_traffic,
            safe_to_terminate=safe_to_terminate,
            drain_timeout_ms=self._drain_timeout_ms,
            drain_started_at_ms=drain_started_at_ms,
            drain_deadline_at_ms=drain_deadline_at_ms,
            remaining_drain_ms=remaining_drain_ms,
        )

    def _now_ms(self) -> int:
        return int(self._now() * 1000)


class SlotDrainController:
    def __init__(self, registry: SlotRegistry) -> None:
        self._registry = registry

    def begin_drain(self) -> None:
        self._registry.begin_drain()

    def wait_until_safe_to_terminate(self, timeout_ms: Optional[int] = None, poll_interval_ms: int = 200) -> bool:
        deadline = None if timeout_ms is None else time.time() + (timeout_ms / 1000.0)
        while True:
            snapshot = self._registry.snapshot()
            if snapshot.safe_to_terminate:
                return True
            if deadline is not None and time.time() >= deadline:
                return False
            time.sleep(poll_interval_ms / 1000.0)


HTTP_STATUS_TEXT = {
    200: "200 OK",
    404: "404 Not Found",
    503: "503 Service Unavailable",
}


def create_health_app(registry: SlotRegistry):
    def application(environ, start_response):
        path = environ.get("PATH_INFO", "")
        if path != "/health":
            payload = json.dumps({"error": "not_found"}).encode("utf-8")
            start_response(
                HTTP_STATUS_TEXT[404],
                [
                    ("Content-Type", "application/json"),
                    ("Content-Length", str(len(payload))),
                ],
            )
            return [payload]

        query = parse_qs(environ.get("QUERY_STRING", ""), keep_blank_values=True)
        probe = query.get("probe", ["liveness"])[0]
        snapshot = registry.snapshot()
        status_code = _resolve_status_code(snapshot, probe)
        payload_dict = asdict(snapshot)
        payload_dict.update({
            "probe": probe,
            "status": _resolve_status_name(snapshot, probe),
        })
        payload = json.dumps(payload_dict, separators=(",", ":")).encode("utf-8")
        start_response(
            HTTP_STATUS_TEXT[status_code],
            [
                ("Content-Type", "application/json"),
                ("Cache-Control", "no-store"),
                ("Content-Length", str(len(payload))),
                ("X-Slot-Active-Count", str(snapshot.active_slots)),
                ("X-Slot-Draining", _bool_text(snapshot.draining)),
                ("X-Slot-Accepting-Traffic", _bool_text(snapshot.accepting_traffic)),
                ("X-Slot-Safe-To-Terminate", _bool_text(snapshot.safe_to_terminate)),
            ],
        )
        return [payload]

    return application


def request_health(app, path: str) -> Tuple[int, Dict[str, str], Dict[str, object]]:
    captured = {}

    def start_response(status: str, headers: Iterable[Tuple[str, str]]) -> None:
        captured["status"] = status
        captured["headers"] = dict(headers)

    body = b"".join(
        app(
            {
                "PATH_INFO": path.split("?", 1)[0],
                "QUERY_STRING": path.split("?", 1)[1] if "?" in path else "",
            },
            start_response,
        )
    )
    return (
        int(str(captured["status"]).split(" ", 1)[0]),
        captured["headers"],
        json.loads(body.decode("utf-8")),
    )


def _resolve_status_code(snapshot: SlotHealthSnapshot, probe: str) -> int:
    if probe == "readiness":
        return 200 if snapshot.accepting_traffic else 503
    if probe == "shutdown":
        return 200 if snapshot.safe_to_terminate else 503
    return 200


def _resolve_status_name(snapshot: SlotHealthSnapshot, probe: str) -> str:
    if probe == "readiness":
        return "ready" if snapshot.accepting_traffic else "draining"
    if probe == "shutdown":
        return "safe_to_terminate" if snapshot.safe_to_terminate else "waiting_for_slot_release"
    if snapshot.draining:
        return "draining"
    return "live"


def _bool_text(value: bool) -> str:
    return "true" if value else "false"
