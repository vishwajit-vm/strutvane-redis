# @strutvane/redis

## 0.2.0-next.1

### Minor Changes

- f557d58: **Minor, not patch, because the default key prefix changes what an upgraded app reads and writes.**
  
  - **Key prefix:** the default is now `<app>:<environment>:` (the `APP_NAME` and `APP_ENV` slugs, such as `my_blog:production:`); it was `<app>:`. A custom `REDIS_PREFIX` must be exactly two parts, each ending with `:` (`blog:production:`), so no app's prefix is the start of another's and one app's flush never touches another's keys. In production, an app without `APP_NAME` stops boot with `invalid_redis_config` instead of using the shared `strutvane:` prefix. After upgrading, the app no longer sees its old keys: caches refill, users stored in Redis sessions sign in once more, and locks, rate-limit counters and idempotency records start over (README, "Upgrading").
  - **Production, Redis on another machine:** boot stops with `invalid_redis_config` unless TLS is chosen explicitly (`REDIS_TLS=true` or `rediss://`, or `REDIS_TLS=false` to accept plain text on purpose) and a password is set (or `REDIS_ALLOW_NO_PASSWORD=true`). Loopback is recognised in every spelling (`::1`, `0:0:0:0:0:0:0:1`, `[::1]`, `127.0.0.0/8`, `::ffff:127.x.y.z`).
  - **Cache stores** may not use the package's own key areas (`session`, `idempotency`, `lock`, `rate`, `queue`, `signature`) as their `area`.
  - **Queue (experimental):** an entry that is not a job is moved to `<queue>:failed` and `pop` goes on with the next one.
  - `RedisCacheStore.many()` returns an object without a prototype; a failed background refresh logs a digest of the key, not the key.

## 0.2.0-next.0

### Minor Changes

- First implementation of `@strutvane/redis` (Redis and Valkey for Strutvane apps):
  
  - `RedisConnection` over `@redis/client`: lazy, fails fast with the 503 `redis_unavailable` problem while the server is down (circuit breaker, no offline queue), TLS always verified, ACL users, graceful shutdown, `health()`.
  - `RedisCacheStore` implementing the framework's `CacheStore` (atomic `add`/`increment`), plus `many`, `putMany`, `forever`, `decrement`, `remember`, `flexible` and `forTenant`; `createRedisCacheManager` adds `driver: 'redis'` stores to `config/cache.ts`.
  - `RedisLocks`: owner tokens, Lua compare-and-delete release and extend, `block` with `lock_timeout`, `restore` across processes.
  - `RedisRateLimiter`: atomic fixed and sliding windows on the server clock.
  - `RedisSessionStore` (hashed ids, bounded size), `RedisIdempotencyStore`, `RedisUsedSignatureStore`.
  - `KeySpace`: per-app and per-tenant prefixes with validated tenant ids and literal flush patterns.
  - `RedisServiceProvider` and the installer (`config/redis.ts`, `.env` keys, `bootstrap/providers.ts`, `config/index.ts`).
  - Experimental `QueueDriver` interface and `RedisQueueDriver` (`@strutvane/redis/queue`).
