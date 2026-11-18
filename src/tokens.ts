/**
 * Container tokens this package binds (integration-map connection 2: container tokens). Other
 * packages and apps resolve the Redis services through these, never by importing this package's
 * classes directly.
 *
 * @module
 */
import { type Token, token } from '@strutvane/framework/core'
import type { RedisConnection } from './connection.ts'
import type { KeySpace } from './keys.ts'
import type { RedisLocks } from './lock.ts'
import type { RedisRateLimiter } from './rate-limiter.ts'

/**
 * The app's shared Redis connection (lazily connected; closed on shutdown).
 *
 * @example
 * const health = await app.make(RedisConnectionToken).health()
 */
export const RedisConnectionToken: Token<RedisConnection> = token<RedisConnection>(
  'strutvane.redis.connection',
)

/**
 * The app's root key space (`REDIS_PREFIX`).
 *
 * @example
 * app.make(RedisKeySpaceToken).area('reports').key('daily')
 */
export const RedisKeySpaceToken: Token<KeySpace> = token<KeySpace>('strutvane.redis.keys')

/**
 * Atomic locks (`<prefix>lock:…`).
 *
 * @example
 * await app.make(RedisLocksToken).create('reports:build', 120).block(10, build)
 */
export const RedisLocksToken: Token<RedisLocks> = token<RedisLocks>('strutvane.redis.locks')

/**
 * The rate limiter (`<prefix>rate:…`).
 *
 * @example
 * await app.make(RedisRateLimiterToken).hit(`export:${user.id}`, { max: 5, windowSeconds: 3600 })
 */
export const RedisRateLimiterToken: Token<RedisRateLimiter> = token<RedisRateLimiter>(
  'strutvane.redis.rateLimiter',
)
