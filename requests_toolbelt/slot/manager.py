"""Thread-safe Slot occupancy tracker.

The :class:`SlotManager` models a bounded pool of "slots" that a process may
hold while it executes long-running or stateful work. The primary reason this
is interesting for Kubernetes is that, during a graceful shutdown (SIGTERM),
the Pod still needs to finish whatever work it has already started before it
is allowed to terminate. If the kubelet or the operator can observe the
current Slot occupancy via an HTTP endpoint, it can wait for occupancy to
drop to zero before removing the Pod from the service endpoints / target
group, eliminating the window in which traffic is routed to a Pod that is
about to exit.

The tracker is intentionally minimal:

* :meth:`SlotManager.acquire` / :meth:`SlotManager.release` move a counter
  under a :class:`threading.Lock` so that readers always observe a
  consistent snapshot of in-flight work.
* :meth:`SlotManager.snapshot` returns a JSON-serialisable dict that can be
  served directly from a :class:`HealthServer`.
* :meth:`SlotManager.is_holding` is the single boolean that drives the HTTP
  status code returned by /health.

Example::

    slots = SlotManager(total=8)

    token = slots.acquire()
    try:
        ...
    finally:
        slots.release(token)

    # -- or, as a context manager --
    with slots.acquire():
        ...
"""
import threading
import time


class _SlotToken(object):
    """Opaque token returned by :meth:`SlotManager.acquire`.

    Doubles as a context manager so callers can write::

        with slots.acquire() as token:
            ...
    """

    __slots__ = ("id", "acquired_at", "_manager")

    def __init__(self, slot_id, acquired_at, manager):
        self.id = slot_id
        self.acquired_at = acquired_at
        self._manager = manager

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self._manager.release(self)
        return False


class SlotManager(object):
    """Track the number of in-flight Slots held by the current process.

    :param total:
        Maximum number of concurrent Slots the process is allowed to hold.
        When *total* slots are held, subsequent :meth:`acquire` calls raise
        :class:`TooManySlots` so callers can apply explicit back-pressure.
    :type total: int
    """

    def __init__(self, total):
        if not isinstance(total, int) or total <= 0:
            raise ValueError("total must be a positive integer")
        self._total = total
        self._lock = threading.Lock()
        self._next_id = 0
        self._held = {}  # slot_id -> acquired_at monotonic timestamp

    # ------------------------------------------------------------------ state

    @property
    def total(self):
        return self._total

    def occupied(self):
        """Number of Slots currently held."""
        with self._lock:
            return len(self._held)

    def available(self):
        """Number of Slots that can still be acquired."""
        with self._lock:
            return self._total - len(self._held)

    def is_holding(self):
        """Return True if the process is holding at least one Slot.

        This is the predicate that drives the HTTP status code returned from
        :class:`HealthServer`'s /health endpoint. When it is ``True`` the
        Pod still has outstanding work and should not be killed yet; when
        it is ``False`` the Pod is idle and can be terminated safely.
        """
        with self._lock:
            return len(self._held) > 0

    def snapshot(self):
        """Return a JSON-serialisable snapshot of the current occupancy.

        The shape of the returned dict is stable and designed to be easy to
        parse by monitoring tooling. It contains:

        * ``total`` / ``occupied`` / ``available`` – counters
        * ``is_holding`` – boolean flag for quick checks
        * ``held_slots`` – list of ``{"id": <int>, "held_seconds": <float>}``
          so that operators can observe stuck / long-running requests and
          distinguish them from a harmless backlog.
        """
        now = time.monotonic()
        with self._lock:
            held_count = len(self._held)
            held_slots = [
                {"id": int(slot_id), "held_seconds": round(now - ts, 3)}
                for slot_id, ts in self._held.items()
            ]
        return {
            "total": self._total,
            "occupied": held_count,
            "available": self._total - held_count,
            "is_holding": held_count > 0,
            "held_slots": held_slots,
        }

    # ---------------------------------------------------------------- lifecycle

    def acquire(self):
        """Atomically claim one Slot.

        :returns: A :class:`_SlotToken` that must be passed back to
            :meth:`release`. Tokens are also context managers, so the common
            ``with slots.acquire():`` pattern is supported.
        :raises TooManySlots: If *total* slots are already held.
        """
        with self._lock:
            if len(self._held) >= self._total:
                raise TooManySlots(
                    "slot pool exhausted (total={}, occupied={})".format(
                        self._total, len(self._held)
                    )
                )
            slot_id = self._next_id
            self._next_id += 1
            acquired_at = time.monotonic()
            self._held[slot_id] = acquired_at

        return _SlotToken(slot_id, acquired_at, self)

    def release(self, token):
        """Release a Slot previously acquired via :meth:`acquire`.

        Duplicate releases or releases of unknown tokens are silently
        ignored: a buggy caller must not be able to leak a "held slot"
        forever or cause a crash in the health endpoint.
        """
        if token is None:
            return
        try:
            slot_id = int(token.id)
        except (AttributeError, TypeError, ValueError):
            return
        with self._lock:
            self._held.pop(slot_id, None)

    def clear(self):
        """Force-release every Slot. Only useful in tests or emergencies."""
        with self._lock:
            self._held.clear()


class TooManySlots(Exception):
    """Raised when :meth:`SlotManager.acquire` would exceed *total*."""
