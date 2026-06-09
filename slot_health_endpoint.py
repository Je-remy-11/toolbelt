# -*- coding: utf-8 -*-
"""
Slot 占用状态健康检查端点，用于 K8s Pod 缩容时的 Grace Period 判断。

K8s 在缩容 Pod 时会先发送 SIGTERM，然后等待 terminationGracePeriodSeconds。
在此期间，应用应停止接收新 Slot，并等待已有 Slot 释放完毕。
本模块通过 /health 端点暴露当前 Slot 占用状态，使得 K8s 的 preStop hook
或 readiness probe 能够准确判断 Pod 是否可以安全终止。

使用方式:

    from slot_health_endpoint import (
        SlotManager, SlotContext, HealthEndpoint, setup_drain_signal_handler
    )

    slot_mgr = SlotManager()

    # 启动健康检查端点 (默认监听 0.0.0.0:8080)
    endpoint = HealthEndpoint(slot_manager=slot_mgr, port=8080)
    endpoint.start()

    # 注册 SIGTERM 信号处理器，进入 Drain 模式
    setup_drain_signal_handler(slot_mgr, drain_timeout_ms=30000)

    # 在工作代码中使用 SlotContext 包裹 Slot 占用逻辑
    with SlotContext(slot_mgr):
        do_work()

K8s 配置示例:

    spec:
      terminationGracePeriodSeconds: 35
      containers:
      - name: app
        lifecycle:
          preStop:
            exec:
              command:
              - /bin/sh
              - -c
              - |
                while [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/health)" != "200" ]; do
                  sleep 0.5
                done
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          periodSeconds: 2
          failureThreshold: 2
"""

import json
import signal
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

_SLOT_MANAGER_INSTANCE = None
_SLOT_MANAGER_LOCK = threading.RLock()


class SlotManager(object):
    """线程安全的 Slot 占用状态管理器。

    用于追踪当前 Pod 内活跃的 Slot 数量以及是否处于 Drain 模式。
    在 K8s 缩容场景下，当 Pod 收到 SIGTERM 后进入 Drain 模式，
    停止接收新 Slot 并等待已有 Slot 释放完毕。

    :param drain_timeout_ms:
        Drain 最大等待时间 (毫秒)，应对 K8s terminationGracePeriodSeconds。
        超时后即使仍有活跃 Slot 也会标记为健康，避免 Pod 被强制终止时丢失状态。
    :type drain_timeout_ms: int
    """

    def __init__(self, drain_timeout_ms=30000):
        self._lock = threading.RLock()
        self._active_slots = 0
        self._draining = False
        self._drain_start_time = None
        self.drain_timeout_ms = drain_timeout_ms
        self._drain_callbacks = []

    @property
    def active_slots(self):
        with self._lock:
            return self._active_slots

    @property
    def draining(self):
        with self._lock:
            return self._draining

    @property
    def drain_elapsed_ms(self):
        with self._lock:
            if self._drain_start_time is None:
                return 0
            return int((time.monotonic() - self._drain_start_time) * 1000)

    def acquire(self):
        """尝试获取一个 Slot。

        在 Drain 模式下拒绝新的 Slot 获取。
        业务代码应使用 :class:`SlotContext` 上下文管理器代替直接调用。

        :returns: 是否成功获取 Slot
        :rtype: bool
        """
        with self._lock:
            if self._draining:
                return False
            self._active_slots += 1
            return True

    def release(self):
        """释放一个 Slot。"""
        with self._lock:
            if self._active_slots > 0:
                self._active_slots -= 1

    def start_drain(self):
        """进入 Drain 模式。

        此后所有 :meth:`acquire` 调用将返回 False，
        已有 Slot 应通过 :meth:`release` 正常释放。
        """
        with self._lock:
            if not self._draining:
                self._draining = True
                self._drain_start_time = time.monotonic()
        for callback in self._drain_callbacks:
            try:
                callback()
            except Exception:
                pass

    def add_drain_callback(self, callback):
        """注册 Drain 开始时的回调函数。

        :param callback: 回调函数，不接受参数
        :type callback: collections.Callable
        """
        self._drain_callbacks.append(callback)

    def is_healthy(self):
        """返回当前健康状态，供健康检查端点使用。

        健康条件:
        1. 未处于 Drain 模式 (正常服务中)，或
        2. 处于 Drain 模式且所有 Slot 已释放，或
        3. Drain 时间超过了 drain_timeout_ms (防止 K8s 强制终止)

        :returns: 是否健康
        :rtype: bool
        """
        with self._lock:
            if not self._draining:
                return True
            if self._active_slots == 0:
                return True
            elapsed = int((time.monotonic() - self._drain_start_time) * 1000)
            if self.drain_timeout_ms > 0 and elapsed >= self.drain_timeout_ms:
                return True
            return False

    def get_status(self):
        """获取完整的状态信息字典。

        :returns: 包含 active_slots, draining, healthy 等字段的字典
        :rtype: dict
        """
        healthy = self.is_healthy()
        with self._lock:
            elapsed = 0
            if self._drain_start_time is not None:
                elapsed = int((time.monotonic() - self._drain_start_time) * 1000)
            return {
                "active_slots": self._active_slots,
                "draining": self._draining,
                "drain_elapsed_ms": elapsed,
                "drain_timeout_ms": self.drain_timeout_ms,
                "healthy": healthy,
            }


class SlotContext(object):
    """Slot 占用的上下文管理器。

    使用 with 语句包裹需要占用 Slot 的代码块:

        slot_mgr = SlotManager()
        with SlotContext(slot_mgr) as acquired:
            if acquired:
                do_work()
            else:
                reject_request()

    :param slot_manager: SlotManager 实例
    :type slot_manager: SlotManager
    """

    def __init__(self, slot_manager):
        self._slot_manager = slot_manager
        self._acquired = False

    def __enter__(self):
        self._acquired = self._slot_manager.acquire()
        return self._acquired

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self._acquired:
            self._slot_manager.release()
        return False


class _HealthRequestHandler(BaseHTTPRequestHandler):
    """健康检查端点的 HTTP 请求处理器 (内部使用)。"""

    slot_manager = None

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.path in ("/health", "/healthz", "/readyz"):
            self._handle_health()
        else:
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "not found"}).encode("utf-8"))

    def _handle_health(self):
        status = self.slot_manager.get_status()
        if status["healthy"]:
            self.send_response(200)
        else:
            self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(status).encode("utf-8"))


class HealthEndpoint(object):
    """Slot 健康检查 HTTP 端点。

    在后台线程中运行一个轻量级 HTTP 服务器，暴露 /health 端点供 K8s 探测。
    仅使用 Python 标准库，无需额外依赖。

    :param slot_manager: SlotManager 实例
    :type slot_manager: SlotManager
    :param host: 监听地址，默认 0.0.0.0
    :type host: str
    :param port: 监听端口，默认 8080
    :type port: int
    """

    def __init__(self, slot_manager, host="0.0.0.0", port=8080):
        self._slot_manager = slot_manager
        self._host = host
        self._port = port
        self._server = None
        self._thread = None
        self._running = False

    @property
    def is_running(self):
        return self._running

    def start(self):
        """启动健康检查端点 (非阻塞，在后台线程中运行)。"""
        if self._running:
            return

        handler = type(
            "_BoundHealthHandler",
            (_HealthRequestHandler,),
            {"slot_manager": self._slot_manager},
        )

        self._server = HTTPServer((self._host, self._port), handler)
        self._server.timeout = 1.0
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._running = True
        self._thread.start()

    def _serve(self):
        while self._running:
            self._server.handle_request()

    def stop(self):
        """停止健康检查端点。"""
        self._running = False
        if self._thread is not None:
            self._thread.join(timeout=3.0)
        if self._server is not None:
            self._server.server_close()


def setup_drain_signal_handler(slot_manager, drain_timeout_ms=30000):
    """注册 SIGTERM 和 SIGINT 信号处理器，在收到信号时进入 Drain 模式。

    当 K8s 缩容 Pod 时发送 SIGTERM，此处理器会调用
    :meth:`SlotManager.start_drain` 进入 Drain 模式停止接收新 Slot。

    drain_timeout_ms 应略小于 K8s terminationGracePeriodSeconds (换算为毫秒)，
    为 /health 端点的轮询留出缓冲时间。

    :param slot_manager: SlotManager 实例
    :type slot_manager: SlotManager
    :param drain_timeout_ms: Drain 最大等待时间 (毫秒)
    :type drain_timeout_ms: int
    """
    slot_manager.drain_timeout_ms = drain_timeout_ms

    def _handler(signum, frame):
        slot_manager.start_drain()

    signal.signal(signal.SIGTERM, _handler)
    signal.signal(signal.SIGINT, _handler)


def get_global_slot_manager(drain_timeout_ms=30000):
    """获取全局单例 SlotManager。

    适用于简单场景无需手动传递 SlotManager 实例。

    :param drain_timeout_ms: Drain 最大等待时间 (毫秒)
    :type drain_timeout_ms: int
    :returns: 全局 SlotManager 实例
    :rtype: SlotManager
    """
    global _SLOT_MANAGER_INSTANCE
    with _SLOT_MANAGER_LOCK:
        if _SLOT_MANAGER_INSTANCE is None:
            _SLOT_MANAGER_INSTANCE = SlotManager(
                drain_timeout_ms=drain_timeout_ms
            )
        return _SLOT_MANAGER_INSTANCE