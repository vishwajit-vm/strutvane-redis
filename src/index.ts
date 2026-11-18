/**
 * `@strutvane/redis`: Redis and Valkey for Strutvane apps.
 *
 * - a cache store (`CACHE_STORE=redis`), which also makes the framework's `throttle` limits hold
 *   across servers;
 * - atomic locks with owner tokens and safe release;
 * - a session store (`SESSION_DRIVER=redis`);
 * - fixed- and sliding-window rate limiting;
 * - an idempotency store and a used-signature store for multi-server apps;
 * - an experimental queue driver (`@strutvane/redis/queue`).
 *
 * Every key lives under the app's prefix (`REDIS_PREFIX`), optionally scoped to a tenant. Install
 * with `node strut install:redis`; the provider is `@strutvane/redis/provider`.
 *
 * @packageDocumentation
 */
export {
  createRedisCacheManager,
  type RedisCacheManagerOptions,
  type RedisCacheStoreConfig,
} from './cache-manager.ts'
export { RedisCacheStore, type RedisCacheStoreOptions } from './cache-store.ts'
export {
  defaultPrefix,
  describeSettings,
  type RedisConfig,
  type RedisSettings,
  type ResolveOptions,
  resolveRedisSettings,
} from './config.ts'
export {
  type RedisClientLike,
  type RedisClientOptionsLike,
  RedisConnection,
  type RedisConnectionOptions,
} from './connection.ts'
export {
  asArray,
  asInteger,
  asNullableString,
  defineLua,
  deleteMatching,
  type LuaScript,
  type RedisDriver,
} from './driver.ts'
export { loadRedisEnv } from './env.ts'
export { lockTimeout, REDIS_ERRORS, REDIS_MESSAGES_EN, redisUnavailable } from './errors.ts'
export { RedisIdempotencyStore } from './idempotency-store.ts'
export { globEscape, isValidTenantId, KeySpace, MAX_KEY_BYTES, prefixProblem } from './keys.ts'
export { RedisLock, RedisLocks } from './lock.ts'
export { type RateLimit, type RateLimitResult, RedisRateLimiter } from './rate-limiter.ts'
export { RedisSessionStore, type RedisSessionStoreOptions } from './session-store.ts'
export { RedisUsedSignatureStore, type UsedSignatureStoreLike } from './signature-store.ts'
export {
  RedisConnectionToken,
  RedisKeySpaceToken,
  RedisLocksToken,
  RedisRateLimiterToken,
} from './tokens.ts'
