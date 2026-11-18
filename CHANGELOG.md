# @strutvane/redis

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
