/**
 * Rate limiting in Redis: fixed and sliding windows, each one atomic Lua script, so limits hold
 * across every process and server of the app even under bursts of parallel requests.
 *
 * - **Fixed window** (`algorithm: 'fixed'`, the default; what the framework's `throttle` does):
 *   one counter per window. Cheap (one key, one integer), but a client can send `2 × max` around
 *   a window boundary.
 * - **Sliding window** (`'sliding'`): a sorted set of the accepted hits in the last window.
 *   Exact: never more than `max` hits in any `windowSeconds` span. Costs one entry per accepted
 *   hit (bounded by `max`); refused hits are not recorded, so a client hammering a closed limit
 *   can't grow memory.
 *
 * Time comes from the Redis server (`TIME` inside the script), so app servers with skewed clocks
 * still share one window.
 *
 * The framework's `throttle` middleware counts in the default cache store, so with
 * `CACHE_STORE=redis` it already uses Redis (fixed windows). This class is for limits in your own
 * code (`await limiter.hit(\`export:${user.id}\`, { max: 5, windowSeconds: 3600 })`).
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { asArray, asInteger, defineLua, type RedisDriver } from './driver.ts'
import type { KeySpace } from './keys.ts'

/**
 * A limit: at most `max` hits per `windowSeconds`.
 *
 * @example
 * const limit: RateLimit = { max: 60, windowSeconds: 60, algorithm: 'sliding' }
 */
export interface RateLimit {
  readonly max: number
  readonly windowSeconds: number
  /** Default `fixed`. */
  readonly algorithm?: 'fixed' | 'sliding'
}

/**
 * The outcome of one hit.
 *
 * @example
 * if (!result.allowed) throw new RateLimitedError({ retryAfter: result.retryAfterSeconds })
 */
export interface RateLimitResult {
  readonly allowed: boolean
  readonly limit: number
  /** Hits left in the current window (0 when refused). */
  readonly remaining: number
  /** Seconds until a hit can succeed again (0 when allowed). */
  readonly retryAfterSeconds: number
}

// Returns {count, pttl}. A key that somehow lost its expiry gets it back (never a permanent ban).
const FIXED = defineLua(`
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`)

// Returns {allowed (1/0), count after, retry ms}.
const SLIDING = defineLua(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, count + 1, 0}
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retry = window
if oldest[2] then retry = tonumber(oldest[2]) + window - now end
if retry < 1 then retry = 1 end
return {0, count, retry}
`)

/**
 * A rate limiter in one key space.
 *
 * @example
 * const limiter = new RedisRateLimiter({ driver: redis, space: KeySpace.root('blog:prod:').area('rate') })
 * const result = await limiter.hit(`login:${email}`, { max: 5, windowSeconds: 60, algorithm: 'sliding' })
 */
export class RedisRateLimiter {
  readonly #driver: RedisDriver
  readonly #space: KeySpace

  constructor(options: { readonly driver: RedisDriver; readonly space: KeySpace }) {
    this.#driver = options.driver
    this.#space = options.space
  }

  /**
   * The same limiter, scoped to one tenant.
   *
   * @example
   * limiter.forTenant('acme').hit('exports', { max: 10, windowSeconds: 3600 })
   */
  forTenant(tenantId: string): RedisRateLimiter {
    return new RedisRateLimiter({ driver: this.#driver, space: this.#space.tenant(tenantId) })
  }

  /**
   * Count one hit and say whether it is within the limit.
   *
   * @example
   * const { allowed, retryAfterSeconds } = await limiter.hit('api:42', { max: 60, windowSeconds: 60 })
   */
  async hit(key: string, limit: RateLimit): Promise<RateLimitResult> {
    const { max, windowMs } = check(limit)
    if (limit.algorithm === 'sliding') {
      const [allowed, count, retry] = asArray(
        await this.#driver.script(
          SLIDING,
          [this.#space.key(`s:${key}`)],
          [String(max), String(windowMs), randomBytes(9).toString('base64url')],
        ),
      ).map(asInteger)
      const ok = allowed === 1
      return {
        allowed: ok,
        limit: max,
        remaining: ok ? Math.max(0, max - (count ?? max)) : 0,
        retryAfterSeconds: ok ? 0 : Math.max(1, Math.ceil((retry ?? windowMs) / 1000)),
      }
    }
    const [count, ttl] = asArray(
      await this.#driver.script(FIXED, [this.#space.key(`f:${key}`)], [String(windowMs)]),
    ).map(asInteger)
    const hits = count ?? max + 1
    const ok = hits <= max
    return {
      allowed: ok,
      limit: max,
      remaining: Math.max(0, max - hits),
      retryAfterSeconds: ok ? 0 : Math.max(1, Math.ceil((ttl ?? windowMs) / 1000)),
    }
  }

  /**
   * Run `work` only when the hit is allowed; returns the result, or `undefined` when limited.
   *
   * @example
   * await limiter.attempt(`digest:${user.id}`, { max: 1, windowSeconds: 3600 }, () => sendDigest(user))
   */
  async attempt<TResult>(
    key: string,
    limit: RateLimit,
    work: () => TResult | Promise<TResult>,
  ): Promise<TResult | undefined> {
    return (await this.hit(key, limit)).allowed ? work() : undefined
  }

  /**
   * Reset a key's counters (both algorithms), for example after a successful login.
   *
   * @example
   * await limiter.clear(`login:${email}`)
   */
  async clear(key: string): Promise<void> {
    await this.#driver.command(['UNLINK', this.#space.key(`f:${key}`), this.#space.key(`s:${key}`)])
  }
}

function check(limit: RateLimit): { readonly max: number; readonly windowMs: number } {
  if (!Number.isSafeInteger(limit.max) || limit.max < 1)
    throw new RangeError('A rate limit needs max to be a whole number of at least 1.')
  if (!Number.isFinite(limit.windowSeconds) || limit.windowSeconds <= 0)
    throw new RangeError('A rate limit needs windowSeconds above 0.')
  if (limit.algorithm !== undefined && limit.algorithm !== 'fixed' && limit.algorithm !== 'sliding')
    throw new RangeError('A rate limit algorithm is "fixed" or "sliding".')
  return { max: limit.max, windowMs: Math.max(1, Math.round(limit.windowSeconds * 1000)) }
}
