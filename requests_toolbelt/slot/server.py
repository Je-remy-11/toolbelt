"""Expose :class:`SlotManager` state as HTTP /health and /ready endpoints.

Kubernetes defines three well-known probes:

* ``livenessProbe``  – "is the process still running?"
* ``readinessProbe`` – "should the process receive traffic right now?"
* ``startupProbe``   – "did the process finish bootstrapping?"

The natural mapping for Slot occupancy is to drive the **readinessProbe**:
while the process holds at least one Slot we consider it "unready" from a
*scale-down safety* point of view and return HTTP 503. Once every Slot is
released we return HTTP 200 and the Pod is a candidate for immediate
termination.

We expose three paths:

* ``GET /health``  – 200 when *no* Slot is held, 503 otherwise.
* ``GET /ready``   – alias for ``/health``.
* ``GET /status``  – 200 always, returning :meth:`SlotManager.snapshot` as
  JSON so operators / dashboards can inspect what is actually held.

The implementation uses the stdlib :mod:`http.server` module so the
dependency footprint stays minimal. A dedicated background thread runs the
server; :meth:`HealthServer.stop` shuts it down cleanly.
"""
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .manager import SlotManager


_STATUS_OK = 200
_STATUS_SERVICE_UNAVAILABLE = 503
_STATUS_NOT_FOUND = 404
_STATUS_METHOD_NOT_ALLOWED = 405

_CONTENT_TYPE_JSON = "application/json; charset=utf-8"
_CONTENT_TYPE_TEXT = "text/plain; charset=utf-8"


class HealthServer(object):
    """Run a tiny HTTP server that exposes :class:`SlotManager` occupancy.

    :param slot_manager: A :class:`SlotManager` instance whose state will be
        inspected on every request.
    :param host: Interface to bind to. Defaults to ``0.0.0.0`` so the server
        is reachable from inside a Kubernetes Pod.
    :param port: Port to bind to. Defaults to ``8080``.
    :param drain_timeout_seconds: Advertised value of *drainTimeoutMs* – the
        upper bound the kubelet is expected to wait for outstanding slots to
        be released. The value is echoed in ``/status`` responses so tooling
        can sanity-check the configured grace period.
    """

    def __init__(self, slot_manager, host="0.0.0.0", port=8080,
                 drain_timeout_seconds=30):
        if not isinstance(slot_manager, SlotManager):
            raise TypeError(
                "slot_manager must be a SlotManager, got {!r}".format(
                    type(slot_manager).__name__
                )
            )
        if not isinstance(port, int) or port < 0:
            raise ValueError("port must be a non-negative integer")

        self._slot_manager = slot_manager
        self._host = host
        self._port = port
        self._drain_timeout_seconds = float(drain_timeout_seconds)

        # Capture these by closure in the handler factory.
        server_ref = self

        class _Handler(BaseHTTPRequestHandler):
            # Silence default per-request access logs while keeping errors.
            def log_message(self, format, *args):  # noqa: A002
                return

            def do_GET(self):
                server_ref._handle(self)

            def do_HEAD(self):
                server_ref._handle(self, head_only=True)

        server = ThreadingHTTPServer((host, port), _Handler)
        # Allow quick rebinds in tests / restart loops.
        server.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server = server
        self._thread = None

    # ---------------------------------------------------------------- access

    @property
    def host(self):
        return self._host

    @property
    def port(self):
        return self._server.server_address[1]

    @property
    def url(self):
        host = self._host if self._host else "127.0.0.1"
        if host == "0.0.0.0":
            host = "127.0.0.1"
        return "http://{host}:{port}/".format(host=host, port=self.port)

    # ---------------------------------------------------------------- lifecycle

    def start(self):
        """Start serving health requests in a background thread.

        Safe to call multiple times – subsequent calls are no-ops.
        """
        if self._thread is not None and self._thread.is_alive():
            return
        t = threading.Thread(target=self._server.serve_forever,
                             name="SlotHealthServer")
        t.daemon = True
        t.start()
        self._thread = t
        return self

    def stop(self):
        """Cleanly shut down the health server. Idempotent."""
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
            self._thread = None

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop()
        return False

    # ---------------------------------------------------------------- handler

    def _handle(self, handler, head_only=False):
        path = handler.path.split("?", 1)[0]

        if path in ("/health", "/ready"):
            self._write_health(handler, head_only)
        elif path == "/status":
            self._write_status(handler, head_only)
        else:
            self._write_text(handler, _STATUS_NOT_FOUND, "not found",
                             head_only)

    def _write_health(self, handler, head_only):
        """Return 200 when empty, 503 when any Slot is held.

        The body is a small JSON document with ``is_holding`` and
        ``occupied`` so tooling that chooses to parse the response has the
        data it needs without issuing a second request to ``/status``.
        """
        snapshot = self._slot_manager.snapshot()
        holding = snapshot["is_holding"]
        status = _STATUS_SERVICE_UNAVAILABLE if holding else _STATUS_OK
        body = {
            "status": "holding" if holding else "empty",
            "is_holding": holding,
            "occupied": snapshot["occupied"],
            "total": snapshot["total"],
            "available": snapshot["available"],
            "drain_timeout_seconds": self._drain_timeout_seconds,
        }
        self._write_json(handler, status, body, head_only)

    def _write_status(self, handler, head_only):
        """Full machine-readable snapshot, always returns 200."""
        snapshot = self._slot_manager.snapshot()
        snapshot["drain_timeout_seconds"] = self._drain_timeout_seconds
        self._write_json(handler, _STATUS_OK, snapshot, head_only)

    # ---------------------------------------------------------------- helpers

    def _write_json(self, handler, status, body, head_only):
        payload = json.dumps(body, ensure_ascii=False, sort_keys=True)
        data = payload.encode("utf-8")
        handler.send_response(status)
        handler.send_header("Content-Type", _CONTENT_TYPE_JSON)
        handler.send_header("Content-Length", str(len(data)))
        handler.send_header("Connection", "close")
        handler.end_headers()
        if not head_only:
            handler.wfile.write(data)

    def _write_text(self, handler, status, text, head_only):
        data = text.encode("utf-8")
        handler.send_response(status)
        handler.send_header("Content-Type", _CONTENT_TYPE_TEXT)
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        if not head_only:
            handler.wfile.write(data)


__all__ = ["HealthServer"]
