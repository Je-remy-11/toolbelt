"""
Application bootstrap with Async Resource Manager (LIFO dispose pattern).

问题代码（原始 setup() 伪代码）的资源清理漏洞：

    async def setup():
        try:
            db    = await DB.connect()        # 1
            hsm   = await HSM.init(db)         # 2
            redis = await Redis.connect()      # 3
            await run_migrations(db)           # 4
            await run_seeds(db)                # 5
            server = Server(hsm, redis, db)    # 6
            await main(server) or bootstrapCheck(server)
        except Exception as e:
            logger.error(e)
            # ❌ 漏洞 1: main() / bootstrapCheck() 抛异常时,
            #    下面的 hsm.close() / redis.close() 根本不在 try 内部,
            #    也不会被 except 之外的 finally 兜底 → 泄露连接.
        finally:
            # ❌ 漏洞 2: finally 只对最外层变量有效; 且 hsm / redis
            #    往往定义在 try 内部, 这里可能是 UnboundLocalError.
            # ❌ 漏洞 3: 关闭顺序如果写成 db→hsm→redis(先开先关),
            #    违背 LIFO, 会让后初始化的依赖项在关闭时引用
            #    已关闭的上游资源(例如 hsm 内部持有 db 连接).
            # ❌ 漏洞 4: 每个 .close() 本身也可能抛异常, 前一个抛异常
            #    会导致后续资源完全无法关闭.
            await hsm.close()      # 可能失败 / 未定义
            await redis.close()    # 可能失败 / 未定义
            await db.close()       # 可能失败 / 未定义

重构思路 (Dispose Pattern / Async Context Manager / LIFO):
    用 `async with` + 一个 Stack (AsyncExitStack), 按 "后进先出"
    顺序回收资源. 任何一步抛异常, 栈里所有已注册的资源都会被
    逆序关闭, 并且会抑制中间子异常, 抛出首因异常.
"""

from __future__ import annotations

import logging
from contextlib import AsyncExitStack, asynccontextmanager
from typing import (
    Any,
    AsyncIterator,
    Callable,
    List,
    Optional,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 依赖抽象 (示例接口, 真实项目请替换为你的 DB/HSM/Redis/Server SDK)
# ---------------------------------------------------------------------------


class DBService:
    async def close(self) -> None:
        logger.info("DB connection closed")

    async def run_migrations(self) -> None:
        logger.info("DB migrations applied")

    async def run_seeds(self) -> None:
        logger.info("DB seeds applied")


class HSMService:
    async def close(self) -> None:
        logger.info("HSM session closed")


class RedisService:
    async def close(self) -> None:
        logger.info("Redis connection closed")


class ApplicationServer:
    def __init__(self, db: DBService, hsm: HSMService, redis: RedisService) -> None:
        self.db = db
        self.hsm = hsm
        self.redis = redis

    async def close(self) -> None:
        logger.info("Application server stopped")


async def _connect_db() -> DBService:
    logger.info("DB connected")
    return DBService()


async def _init_hsm(db: DBService) -> HSMService:
    logger.info("HSM initialized (depends on DB)")
    return HSMService()


async def _connect_redis() -> RedisService:
    logger.info("Redis connected")
    return RedisService()


# ---------------------------------------------------------------------------
# Async Context Managers: 每个资源都是一个 self-disposing factory
# ---------------------------------------------------------------------------


@asynccontextmanager
async def managed_db() -> AsyncIterator[DBService]:
    """DB: 最先获得, 最后释放 (LIFO 栈底)."""
    resource = await _connect_db()
    try:
        yield resource
    finally:
        await safe_close(resource, "DB")


@asynccontextmanager
async def managed_hsm(db: DBService) -> AsyncIterator[HSMService]:
    """HSM: 依赖 DB, 先于 DB 关闭."""
    resource = await _init_hsm(db)
    try:
        yield resource
    finally:
        await safe_close(resource, "HSM")


@asynccontextmanager
async def managed_redis() -> AsyncIterator[RedisService]:
    """Redis: 独立服务."""
    resource = await _connect_redis()
    try:
        yield resource
    finally:
        await safe_close(resource, "Redis")


@asynccontextmanager
async def managed_server(
    db: DBService, hsm: HSMService, redis: RedisService
) -> AsyncIterator[ApplicationServer]:
    """App Server: 最后一个获得, 第一个释放 (LIFO 栈顶)."""
    server = ApplicationServer(db, hsm, redis)
    try:
        yield server
    finally:
        await safe_close(server, "Server")


# ---------------------------------------------------------------------------
# 安全关闭: 吞掉子异常, 避免一个失败导致其余资源泄露
# ---------------------------------------------------------------------------


async def safe_close(resource: Any, name: str) -> None:
    closer: Optional[Callable[[], Any]] = getattr(resource, "aclose", None)
    if closer is None:
        closer = getattr(resource, "close", None)
    if closer is None:
        return
    try:
        result = closer()
        # 兼容 sync/async close()
        if hasattr(result, "__await__"):
            await result
    except Exception:  # pragma: no cover - defensive
        logger.exception("Failed to close %s (suppressed to keep others releasing)", name)


# ---------------------------------------------------------------------------
# 主引导: 嵌套 async with → 天然 LIFO
# ---------------------------------------------------------------------------


async def main(server: ApplicationServer) -> None:
    """用户业务主循环 / 健康检查入口 (示例)."""
    logger.info("main() running with server=%r", server)


async def bootstrap_check(server: ApplicationServer) -> None:
    """启动自检 (示例)."""
    logger.info("bootstrapCheck() ok for server=%r", server)


async def setup() -> None:
    """
    重构后的 setup():

    资源获取顺序:  DB -> HSM -> Redis -> Migrations/Seeds -> Server
    资源释放顺序:  Server -> Redis -> HSM -> DB   (LIFO, 与获取逆序)

    任意一步抛异常, `async with` 会按逆序执行已进入上下文的 `finally`
    块, 因此 hsm/redis/db 永远不会泄漏 (与原始 try/except 的行为不同).
    """
    exit_stack: AsyncExitStack
    async with AsyncExitStack() as exit_stack:
        # 1) DB — 最先进入栈, 最后退出
        db: DBService = await exit_stack.enter_async_context(managed_db())

        # 2) HSM — 依赖 DB; 后于 DB 进入, 先于 DB 退出
        hsm: HSMService = await exit_stack.enter_async_context(managed_hsm(db))

        # 3) Redis
        redis: RedisService = await exit_stack.enter_async_context(managed_redis())

        # 4) Migrations / Seeds — 纯逻辑, 不注册到栈, 但在失败时栈仍会清理
        await db.run_migrations()
        await db.run_seeds()

        # 5) Application Server — 最后进入, 最先退出 (栈顶)
        server: ApplicationServer = await exit_stack.enter_async_context(
            managed_server(db, hsm, redis)
        )

        # 6) 业务入口 / 自检. 这里抛出异常也会被 AsyncExitStack 逆序释放
        await bootstrap_check(server)
        await main(server)


# ---------------------------------------------------------------------------
# 显式的"资源栈"版本: 便于理解 LIFO 顺序, 也便于向非 Python 读者演示
# ---------------------------------------------------------------------------


class AsyncResourceManager:
    """手工版 LIFO 栈: push 一个 (acquire, release) 对, close_all 逆序 release."""

    def __init__(self) -> None:
        self._items: List[Callable[[], Any]] = []

    async def __aenter__(self) -> "AsyncResourceManager":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close_all()

    def register(self, resource: Any, name: str = "resource") -> Any:
        """注册一个支持 close()/aclose() 的资源, 返回资源本身以便链式使用."""
        self._items.append(lambda res=resource, n=name: safe_close(res, n))
        return resource

    async def close_all(self) -> None:
        # 后进先出
        while self._items:
            closer = self._items.pop()
            try:
                result = closer()
                if hasattr(result, "__await__"):
                    await result
            except Exception:  # pragma: no cover
                logger.exception("Resource close failed (suppressed)")


async def setup_explicit_lifo() -> None:
    """与 setup() 等价, 但使用显式 LIFO 栈, 便于审查/调试."""
    async with AsyncResourceManager() as stack:
        db = stack.register(await _connect_db(), "DB")
        hsm = stack.register(await _init_hsm(db), "HSM")
        redis = stack.register(await _connect_redis(), "Redis")
        await db.run_migrations()
        await db.run_seeds()
        server = stack.register(ApplicationServer(db, hsm, redis), "Server")
        await bootstrap_check(server)
        await main(server)


if __name__ == "__main__":
    import asyncio

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    asyncio.run(setup())
