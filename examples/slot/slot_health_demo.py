"""Demonstration: expose Slot occupancy via HTTP /health so K8s can safely
drain the Pod.

In a real container image you would wire the ``/health`` endpoint into the
Deployment manifest like so::

    readinessProbe:
      httpGet:
        path: /health
        port: 8080
      periodSeconds: 2
      failureThreshold: 15
      # When the process keeps returning 503 (holding slots), the kubelet
      # marks the Pod NotReady and the endpoint controller removes it from
      # the Service endpoints. Meanwhile the Pod continues to finish the
      # in-flight requests it already accepted.

    terminationGracePeriodSeconds: 30  # matches drain_timeout_seconds

Run this example with::

    python examples/slot/slot_health_demo.py

It will print two ``curl`` invocations showing the /health state before and
after a Slot is acquired.
"""
import signal
import threading
import time

from requests_toolbelt.slot import HealthServer, SlotManager


def main():
    slots = SlotManager(total=8)
    server = HealthServer(slots, host="127.0.0.1", port=8080,
                          drain_timeout_seconds=30)
    server.start()
    print("Health server running at {}".format(server.url))
    print("  curl -i {}health    # expect 200 (empty)".format(server.url))

    held = threading.Event()
    release = threading.Event()

    def worker():
        with slots.acquire():
            held.set()
            release.wait(timeout=30)

    t = threading.Thread(target=worker)
    t.daemon = True
    t.start()

    held.wait()
    print("  curl -i {}health    # expect 503 (holding slots)".format(
        server.url))

    def stop(*args):
        release.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    try:
        while release.is_set() is False:
            time.sleep(0.5)
    finally:
        t.join(timeout=5)
        server.stop()


if __name__ == "__main__":
    main()
