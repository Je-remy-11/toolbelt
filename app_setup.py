"""
app_setup.py - 基于 Dispose Pattern / Async Resource Manager 重构

================================================================================
一、原始代码 try...catch 资源清理漏洞分析
================================================================================

原始代码结构（嵌套 try...catch 模式）：

    async def setup():
        try:
            db = await init_db()
            try:
                hsm = await init_hsm()
                try:
                    redis = await init_redis()
                    try:
                        await run_migrations(db)
                        await run_seeds(db)
                        server = await start_server(db, hsm, redis)
                        await main(server)
                    except Exception:
                        await redis.close()       # 仅清理 redis
                        raise
                except Exception:
                    await hsm.close()             # 仅清理 hsm
                    raise
            except Exception:
                await db.close()                  # 仅清理 db
                raise
        except Exception as e:
            logger.error(f"Setup failed: {e}")

漏洞清单：

1. 【部分清理 / 资源泄漏】
   - 若 init_hsm() 抛异常，db 已初始化但 hsm 的 except 块不会执行，
     db.close() 仅在外层 except 中被调用——但如果外层没有 finally，
     db 连接将泄漏。
   - 若 run_migrations() 抛异常，hsm 和 db 已初始化，但内层 except
     只清理 redis，hsm 和 db 依赖外层逐级传播——任何一级遗漏即泄漏。

2. 【清理异常中断链】
   - 若 redis.close() 本身抛出异常，hsm.close() 和 db.close() 将被跳过。
   - Python 的 except 块中若 raise 新异常，原始异常上下文丢失，
     导致调试困难。

3. 【非 LIFO 释放顺序】
   - 初始化顺序：DB → HSM → Redis → Server
   - 期望释放顺序：Server → Redis → HSM → DB（后进先出）
   - 但 except 块按层级捕获，内层异常只触发内层清理，
     外层资源可能先于内层被释放，违反 LIFO。

4. 【bootstrapCheck() 异常无兜底】
   - 若 bootstrapCheck() 在 main() 之后调用并抛异常，
     没有任何 finally 块保证 server.stop() 被调用。

5. 【无超时保护】
   - 清理操作本身可能挂起（如 Redis 连接超时），
     没有超时机制会导致整个进程阻塞。

================================================================================
二、重构方案：AsyncResourceStack（异步资源栈）
================================================================================

核心思想：
  - 使用栈结构管理所有已初始化的异步资源
  - 每个资源实现 AsyncDisposable 协议（__aenter__ / __aexit__）
  - AsyncResourceStack 保证 LIFO 顺序释放
  - 单个资源清理失败不阻断后续资源清理
  - 收集所有清理异常，最终统一报告
"""

from __future__ import annotations

import asyncio
import logging
import traceback
from abc import ABC, abstractmethod
from contextlib import asynccontextmanager
from typing import Any, List, Optional

logger = logging.getLogger(__name__)


class AsyncDisposable(ABC):
    """
    异步可处置资源基类，类似 Rust 的 Drop trait 或 Python 的 async with 协议。

    所有受管资源必须实现此接口，并保证 dispose() 满足：
      - 幂等：多次调用安全
      - 不抛异常：内部吞掉异常并记录日志
    """

    @abstractmethod
    async def dispose(self) -> None:
        ...


class ResourceDisposalError(Exception):
    """资源释放过程中发生错误时抛出。"""

    def __init__(self, message: str, errors: List[Exception]):
        super().__init__(message)
        self.errors = errors

    def __str__(self):
        base = super().__str__()
        details = "\n".join(
            f"  [{i}] {type(e).__name__}: {e}" for i, e in enumerate(self.errors)
        )
        return f"{base}\nDisposal errors:\n{details}"


class AsyncResourceStack:
    """
    异步资源栈，确保所有资源按 LIFO（后进先出）顺序安全释放。

    用法：
        async with AsyncResourceStack() as stack:
            db = await stack.push_auto(init_db(), "DB")
            hsm = await stack.push_auto(init_hsm(), "HSM")
            redis = await stack.push_auto(init_redis(), "Redis")
            # ... 使用资源 ...
        # 退出 with 块时，自动按 Redis → HSM → DB 顺序释放

    保证：
      1. LIFO 释放顺序
      2. 单个资源 dispose 失败不阻断后续清理
      3. 所有清理异常被收集并汇总报告
      4. dispose 操作有超时保护
    """

    DEFAULT_DISPOSE_TIMEOUT = 10.0

    def __init__(self, dispose_timeout: float = DEFAULT_DISPOSE_TIMEOUT):
        self._stack: List[tuple[str, AsyncDisposable]] = []
        self._disposed = False
        self._dispose_timeout = dispose_timeout

    async def push(self, resource: AsyncDisposable, name: str = "unnamed") -> AsyncDisposable:
        """将已初始化的资源压入栈并返回该资源。"""
        if self._disposed:
            raise RuntimeError("Cannot push resource into a disposed AsyncResourceStack")
        self._stack.append((name, resource))
        return resource

    async def push_auto(self, coro: Any, name: str = "unnamed") -> Any:
        """
        执行协程初始化资源，成功则压栈，失败则先释放已压栈资源再抛异常。
        返回资源对象本身。
        """
        try:
            resource = await coro
            await self.push(resource, name)
            return resource
        except Exception:
            logger.error(
                f"Failed to initialize resource '{name}', "
                f"disposing already-registered resources..."
            )
            await self.dispose_all()
            raise

    @asynccontextmanager
    async def push_context(self, coro: Any, name: str = "unnamed"):
        """
        上下文管理器方式压入资源。
        若协程抛异常，资源不会被压栈，已压栈资源不受影响。
        """
        resource = await coro
        await self.push(resource, name)
        try:
            yield resource
        finally:
            pass

    async def dispose_all(self) -> List[Exception]:
        """
        按 LIFO 顺序释放所有资源。
        返回清理过程中收集的所有异常列表。
        单个资源清理失败不阻断后续资源清理。
        """
        if self._disposed:
            return []
        self._disposed = True

        errors: List[Exception] = []

        while self._stack:
            name, resource = self._stack.pop()
            try:
                await asyncio.wait_for(
                    resource.dispose(),
                    timeout=self._dispose_timeout,
                )
                logger.info(f"Resource disposed: {name}")
            except asyncio.TimeoutError:
                err = TimeoutError(
                    f"Dispose timeout ({self._dispose_timeout}s) for resource: {name}"
                )
                errors.append(err)
                logger.error(str(err))
            except Exception as e:
                errors.append(e)
                logger.error(
                    f"Error disposing resource '{name}': {e}\n{traceback.format_exc()}"
                )

        if errors:
            logger.error(
                f"AsyncResourceStack: {len(errors)} error(s) during disposal:\n"
                + "\n".join(f"  - {e}" for e in errors)
            )

        return errors

    async def __aenter__(self) -> "AsyncResourceStack":
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> bool:
        errors = await self.dispose_all()
        if errors and exc_type is None:
            raise ResourceDisposalError(
                "Errors occurred during resource disposal", errors
            )
        return False


# ==============================================================================
# 具体资源实现
# ==============================================================================


class DatabaseService(AsyncDisposable):
    """数据库连接服务。"""

    def __init__(self, connection_url: str):
        self.connection_url = connection_url
        self._connection: Any = None
        self._disposed = False

    async def connect(self) -> "DatabaseService":
        logger.info(f"DB: Connecting to {self.connection_url}")
        self._connection = f"DBConnection({self.connection_url})"
        return self

    async def run_migrations(self) -> None:
        logger.info("DB: Running migrations...")
        await asyncio.sleep(0.1)
        logger.info("DB: Migrations complete")

    async def run_seeds(self) -> None:
        logger.info("DB: Running seeds...")
        await asyncio.sleep(0.1)
        logger.info("DB: Seeds complete")

    async def dispose(self) -> None:
        if self._disposed:
            return
        self._disposed = True
        logger.info(f"DB: Closing connection {self._connection}")
        self._connection = None


class HsmService(AsyncDisposable):
    """HSM（硬件安全模块）服务。"""

    def __init__(self, hsm_endpoint: str):
        self.hsm_endpoint = hsm_endpoint
        self._session: Any = None
        self._disposed = False

    async def connect(self) -> "HsmService":
        logger.info(f"HSM: Connecting to {self.hsm_endpoint}")
        self._session = f"HSMSession({self.hsm_endpoint})"
        return self

    async def sign(self, data: bytes) -> bytes:
        return b"signed:" + data

    async def dispose(self) -> None:
        if self._disposed:
            return
        self._disposed = True
        logger.info(f"HSM: Closing session {self._session}")
        self._session = None


class RedisService(AsyncDisposable):
    """Redis 缓存服务。"""

    def __init__(self, redis_url: str):
        self.redis_url = redis_url
        self._client: Any = None
        self._disposed = False

    async def connect(self) -> "RedisService":
        logger.info(f"Redis: Connecting to {self.redis_url}")
        self._client = f"RedisClient({self.redis_url})"
        return self

    async def get(self, key: str) -> Optional[str]:
        return None

    async def set(self, key: str, value: str) -> None:
        pass

    async def dispose(self) -> None:
        if self._disposed:
            return
        self._disposed = True
        logger.info(f"Redis: Closing client {self._client}")
        self._client = None


class ServerService(AsyncDisposable):
    """应用服务器。"""

    def __init__(
        self,
        host: str,
        port: int,
        db: DatabaseService,
        hsm: HsmService,
        redis: RedisService,
    ):
        self.host = host
        self.port = port
        self.db = db
        self.hsm = hsm
        self.redis = redis
        self._running = False
        self._disposed = False

    async def start(self) -> "ServerService":
        logger.info(f"Server: Starting on {self.host}:{self.port}")
        self._running = True
        return self

    async def serve(self) -> None:
        logger.info(f"Server: Serving requests on {self.host}:{self.port}")
        await asyncio.sleep(0.5)

    async def dispose(self) -> None:
        if self._disposed:
            return
        self._disposed = True
        self._running = False
        logger.info(f"Server: Stopped on {self.host}:{self.port}")


# ==============================================================================
# 重构后的 setup() —— 使用 AsyncResourceStack（push 方式）
# ==============================================================================


async def bootstrap_check(
    db: DatabaseService, hsm: HsmService, redis: RedisService
) -> None:
    """启动后健康检查。"""
    logger.info("Bootstrap check: verifying all services...")
    if db._connection is None:
        raise RuntimeError("Bootstrap check failed: DB not connected")
    if hsm._session is None:
        raise RuntimeError("Bootstrap check failed: HSM not connected")
    if redis._client is None:
        raise RuntimeError("Bootstrap check failed: Redis not connected")
    logger.info("Bootstrap check: all services healthy")


async def main(server: ServerService) -> None:
    """主业务逻辑入口。"""
    await server.serve()


async def setup() -> None:
    """
    应用启动入口 —— 使用 AsyncResourceStack 确保所有资源按 LIFO 顺序安全释放。

    初始化顺序：DB → HSM → Redis → Migrations → Seeds → Server
    释放顺序：  Server → Redis → HSM → DB（后进先出）

    无论 main() 或 bootstrap_check() 是否抛异常，
    AsyncResourceStack.__aexit__ 都保证执行 dispose_all()。
    """
    async with AsyncResourceStack(dispose_timeout=10.0) as stack:

        db = await DatabaseService("postgresql://localhost:5432/app").connect()
        await stack.push(db, "DatabaseService")

        hsm = await HsmService("hsm://localhost:9000").connect()
        await stack.push(hsm, "HsmService")

        redis = await RedisService("redis://localhost:6379").connect()
        await stack.push(redis, "RedisService")

        await db.run_migrations()
        await db.run_seeds()

        server = await ServerService("0.0.0.0", 8080, db, hsm, redis).start()
        await stack.push(server, "ServerService")

        await bootstrap_check(db, hsm, redis)

        await main(server)

    logger.info("Setup: all resources disposed successfully")


# ==============================================================================
# 更优雅的写法：使用 push_auto 自动管理初始化异常
# ==============================================================================


async def setup_concise() -> None:
    """
    最简洁写法：push_auto 自动处理初始化失败场景。
    任何一步初始化失败，已注册资源自动 LIFO 释放。

    与 setup() 的区别：
      - push_auto 将初始化和压栈合为一步
      - 初始化失败时自动释放已注册资源
    """
    async with AsyncResourceStack(dispose_timeout=10.0) as stack:

        db = await stack.push_auto(
            DatabaseService("postgresql://localhost:5432/app").connect(),
            "DatabaseService",
        )
        hsm = await stack.push_auto(
            HsmService("hsm://localhost:9000").connect(),
            "HsmService",
        )
        redis = await stack.push_auto(
            RedisService("redis://localhost:6379").connect(),
            "RedisService",
        )

        await db.run_migrations()
        await db.run_seeds()

        server = await stack.push_auto(
            ServerService("0.0.0.0", 8080, db, hsm, redis).start(),
            "ServerService",
        )

        await bootstrap_check(db, hsm, redis)
        await main(server)


# ==============================================================================
# 更结构化的写法：使用 push_context 嵌套管理
# ==============================================================================


async def setup_structured() -> None:
    """
    结构化写法：每个资源用 push_context 包裹，
    若中间某步初始化失败，已压栈资源自动按 LIFO 释放。
    """
    async with AsyncResourceStack(dispose_timeout=10.0) as stack:

        async with stack.push_context(
            DatabaseService("postgresql://localhost:5432/app").connect(),
            "DatabaseService",
        ) as db:

            async with stack.push_context(
                HsmService("hsm://localhost:9000").connect(),
                "HsmService",
            ) as hsm:

                async with stack.push_context(
                    RedisService("redis://localhost:6379").connect(),
                    "RedisService",
                ) as redis:

                    await db.run_migrations()
                    await db.run_seeds()

                    async with stack.push_context(
                        ServerService("0.0.0.0", 8080, db, hsm, redis).start(),
                        "ServerService",
                    ) as server:

                        await bootstrap_check(db, hsm, redis)
                        await main(server)


# ==============================================================================
# 测试 / 演示
# ==============================================================================


async def demo_normal_flow():
    """演示正常流程：所有资源初始化成功，按 LIFO 释放。"""
    print("=" * 60)
    print("Demo 1: Normal flow - all resources init OK, LIFO disposal")
    print("=" * 60)
    await setup()
    print()


async def demo_bootstrap_check_failure():
    """演示 bootstrap_check 失败：所有资源仍按 LIFO 释放。"""
    print("=" * 60)
    print("Demo 2: bootstrap_check failure - LIFO disposal guaranteed")
    print("=" * 60)

    async with AsyncResourceStack(dispose_timeout=10.0) as stack:
        db = await stack.push_auto(
            DatabaseService("postgresql://localhost:5432/app").connect(),
            "DatabaseService",
        )
        hsm = await stack.push_auto(
            HsmService("hsm://localhost:9000").connect(),
            "HsmService",
        )
        redis = await stack.push_auto(
            RedisService("redis://localhost:6379").connect(),
            "RedisService",
        )

        await db.run_migrations()
        await db.run_seeds()

        server = await stack.push_auto(
            ServerService("0.0.0.0", 8080, db, hsm, redis).start(),
            "ServerService",
        )

        raise RuntimeError("Bootstrap check: HSM key verification failed!")

    print()


async def demo_hsm_init_failure():
    """演示 HSM 初始化失败：DB 自动释放，HSM 未入栈不参与清理。"""
    print("=" * 60)
    print("Demo 3: HSM init failure - DB auto-released via push_auto")
    print("=" * 60)

    class FailingHsmService(HsmService):
        async def connect(self):
            logger.info(f"HSM: Attempting to connect to {self.hsm_endpoint}")
            raise ConnectionError(f"HSM: Cannot reach {self.hsm_endpoint}")

    try:
        async with AsyncResourceStack(dispose_timeout=10.0) as stack:
            db = await stack.push_auto(
                DatabaseService("postgresql://localhost:5432/app").connect(),
                "DatabaseService",
            )
            hsm = await stack.push_auto(
                FailingHsmService("hsm://unreachable:9000").connect(),
                "HsmService",
            )
    except ConnectionError as e:
        print(f"  Caught expected error: {e}")

    print()


async def demo_dispose_error_resilience():
    """演示某个资源 dispose 失败不阻断其他资源清理。"""
    print("=" * 60)
    print("Demo 4: Dispose error resilience - one failure doesn't block others")
    print("=" * 60)

    class LeakyRedisService(RedisService):
        async def dispose(self):
            if self._disposed:
                return
            self._disposed = True
            raise IOError("Redis: Connection refused during close!")

    try:
        async with AsyncResourceStack(dispose_timeout=10.0) as stack:
            db = await stack.push_auto(
                DatabaseService("postgresql://localhost:5432/app").connect(),
                "DatabaseService",
            )
            hsm = await stack.push_auto(
                HsmService("hsm://localhost:9000").connect(),
                "HsmService",
            )
            redis = await stack.push_auto(
                LeakyRedisService("redis://localhost:6379").connect(),
                "RedisService (leaky)",
            )

            server = await stack.push_auto(
                ServerService("0.0.0.0", 8080, db, hsm, redis).start(),
                "ServerService",
            )

            await main(server)
    except ResourceDisposalError as e:
        print(f"  Caught expected disposal error: {e}")

    print()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")

    print("\n" + "#" * 60)
    print("# AsyncResourceStack - Dispose Pattern Demo")
    print("#" * 60 + "\n")

    asyncio.run(demo_normal_flow())
    asyncio.run(demo_bootstrap_check_failure())
    asyncio.run(demo_hsm_init_failure())
    asyncio.run(demo_dispose_error_resilience())
