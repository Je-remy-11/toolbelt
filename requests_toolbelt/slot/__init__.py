"""Slot occupancy management for Kubernetes graceful termination.

This package exposes a lightweight HTTP /health endpoint that reflects the
current in-flight Slot occupancy of the process. When Kubernetes scales down a
Pod it sends a SIGTERM signal; by inspecting /health the kubelet (or an
operator that drives the lifecycle) can delay the Pod shutdown until the Pod
has released every Slot it was holding, avoiding dropped traffic.

A typical setup looks like:

.. code-block:: python

    from requests_toolbelt.slot import SlotManager, HealthServer

    slots = SlotManager(total=8)
    server = HealthServer(slots, host="0.0.0.0", port=8080)
    server.start()

    with slots.acquire():
        # do some work that "holds" a Slot
        ...

    # /health returns 200 -> "empty" / 503 -> "holding" depending on occupancy
"""
from .manager import SlotManager
from .server import HealthServer

__all__ = ["SlotManager", "HealthServer"]
