/**
 * The Redis cache store: the framework's `CacheStore` contract (what `Cache`, `throttle` and
 * `node strut cache:clear` use) plus Laravel's extras: `many`, `putMany`, `forever`, `decrement`,
 * `remember` and `flexible` (stale-while-revalidate).
 *
 * - **Values are JSON.** `undefined`, functions and symbols can't be stored (a `TypeError`, not a
 *   silent `null`); a stored value that isn't JSON (written by something else) reads as a miss.
 * - **Atomic:** `add` is `SET NX`, `increment` is one Lua script, `putMany` is one script, so
 *   concurrent workers never lose an update.
 * - **Expiry is Redis's clock**, not the app's: every process agrees on it. A `ttlSeconds` of 0
 *   or less removes the key (Laravel's behaviour); omitted means forever.
 * - **`flush` only removes this store's keys** (by prefix, with `SCAN` + `UNLINK`), never the
 *   whole database: other apps and this app's sessions, locks and queues are untouched.
 * - **Tenants:** `store.forTenant(id)` is a store whose keys live under that tenant's namespace;
 *   its `flush` clears only that tenant (see `keys.ts`).
 *
 * @module
 */
import { createHash } from 'node:crypto'
import type { CacheStore } from '@strutvane/framework'
import type { Logger } from '@strutvane/framework/contracts'
import {
  asArray,
  asInteger,
  asNullableString,
  defineLua,
  deleteMatching,
  type RedisDriver,
} from './driver.ts'
import type { KeySpace } from './keys.ts'

/**
 * Options for {@link RedisCacheStore}.
 *
 * @example
 * new RedisCacheStore({ driver: redis, space: KeySpace.root('blog:prod:').area('cache') })
 */
export interface RedisCacheStoreOptions {
  readonly driver: RedisDriver
  /** The key space (`<prefix>cache:` for the default store). */
  readonly space: KeySpace
  /** Where failed background refreshes (`flexible`) are reported. */
  readonly logger?: Logger
}

// A counter starts at `by` when missing or not an integer; an existing one keeps its expiry.
const INCREMENT = defineLua(`
local current = redis.call('GET', KEYS[1])
if current and string.match(current, '^%-?%d+$') then
  return redis.call('INCRBY', KEYS[1], ARGV[1])
end
if ARGV[2] == '' then
  redis.call('SET', KEYS[1], ARGV[1])
else
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
end
return tonumber(ARGV[1])
`)

// ARGV[1] = ttl in ms ('' = forever), then one value per key.
const PUT_MANY = defineLua(`
for i, key in ipairs(KEYS) do
  if ARGV[1] == '' then
    redis.call('SET', key, ARGV[i + 1])
  else
    redis.call('SET', key, ARGV[i + 1], 'PX', ARGV[1])
  end
end
return #KEYS
`)

/** A value stored by `flexible`: the value and when it was computed (ms since the epoch). */
interface FlexibleEntry {
  readonly v: unknown
  readonly t: number
}

/**
 * A cache store in Redis or Valkey.
 *
 * @example
 * const cache = new RedisCacheStore({ driver: redis, space: KeySpace.root('blog:prod:').area('cache') })
 * await cache.put('stats', { posts: 3 }, 60)
 * await cache.forTenant('acme').get('stats') // undefined: another namespace
 */
export class RedisCacheStore implements CacheStore {
  readonly #driver: RedisDriver
  readonly #space: KeySpace
  readonly #logger: Logger | undefined

  constructor(options: RedisCacheStoreOptions) {
    this.#driver = options.driver
    this.#space = options.space
    this.#logger = options.logger
  }

  /** The key prefix of this store (for diagnostics). */
  get prefix(): string {
    return this.#space.prefix
  }

  /**
   * The same store, scoped to one tenant.
   *
   * @example
   * await Cache.store('redis').forTenant(tenant.id).remember('dashboard', 60, build)
   */
  forTenant(tenantId: string): RedisCacheStore {
    return new RedisCacheStore({
      driver: this.#driver,
      space: this.#space.tenant(tenantId),
      ...(this.#logger === undefined ? {} : { logger: this.#logger }),
    })
  }

  async get(key: string): Promise<unknown> {
    return decode(asNullableString(await this.#driver.command(['GET', this.#space.key(key)])))
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined
  }

  async put(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const full = this.#space.key(key)
    const encoded = encode(value)
    const px = expiry(ttlSeconds)
    if (px === 'expired') {
      await this.#driver.command(['UNLINK', full])
      return
    }
    await this.#driver.command(
      px === undefined ? ['SET', full, encoded] : ['SET', full, encoded, 'PX', px],
    )
  }

  async add(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    const full = this.#space.key(key)
    const encoded = encode(value)
    const px = expiry(ttlSeconds)
    if (px === 'expired') return false
    const reply = await this.#driver.command(
      px === undefined ? ['SET', full, encoded, 'NX'] : ['SET', full, encoded, 'NX', 'PX', px],
    )
    return reply !== null && reply !== undefined
  }

  async increment(key: string, by = 1, ttlSeconds?: number): Promise<number> {
    if (!Number.isSafeInteger(by))
      throw new TypeError('increment() takes a whole number (Redis counters are integers).')
    const px = expiry(ttlSeconds)
    if (px === 'expired') throw new RangeError('increment() needs a ttlSeconds above 0, or none.')
    return asInteger(
      await this.#driver.script(INCREMENT, [this.#space.key(key)], [String(by), px ?? '']),
    )
  }

  /**
   * Subtract from a counter (see {@link RedisCacheStore.increment}).
   *
   * @example
   * await cache.decrement('seats', 1)
   */
  async decrement(key: string, by = 1, ttlSeconds?: number): Promise<number> {
    return this.increment(key, -by, ttlSeconds)
  }

  async ttl(key: string): Promise<number | undefined> {
    const ms = asInteger(await this.#driver.command(['PTTL', this.#space.key(key)]))
    return ms < 0 ? undefined : Math.ceil(ms / 1000)
  }

  async forget(key: string): Promise<boolean> {
    return asInteger(await this.#driver.command(['UNLINK', this.#space.key(key)])) > 0
  }

  async flush(): Promise<void> {
    await deleteMatching(this.#driver, this.#space.pattern())
  }

  /**
   * Several values at once (`MGET`); missing keys are `undefined`. The result has no prototype,
   * so keys such as `__proto__` or `constructor` are plain entries, never inherited members.
   *
   * @example
   * const { a, b } = await cache.many(['a', 'b'])
   */
  async many(keys: readonly string[]): Promise<Record<string, unknown>> {
    const result = Object.create(null) as Record<string, unknown>
    if (keys.length === 0) return result
    const replies = asArray(
      await this.#driver.command(['MGET', ...keys.map((key) => this.#space.key(key))]),
    )
    keys.forEach((key, index) => {
      result[key] = decode(asNullableString(replies[index]))
    })
    return result
  }

  /**
   * Store several values atomically with one expiry.
   *
   * @example
   * await cache.putMany({ a: 1, b: 2 }, 60)
   */
  async putMany(values: Readonly<Record<string, unknown>>, ttlSeconds?: number): Promise<void> {
    const entries = Object.entries(values)
    if (entries.length === 0) return
    const keys = entries.map(([key]) => this.#space.key(key))
    const encoded = entries.map(([, value]) => encode(value))
    const px = expiry(ttlSeconds)
    if (px === 'expired') {
      await this.#driver.command(['UNLINK', ...keys])
      return
    }
    await this.#driver.script(PUT_MANY, keys, [px ?? '', ...encoded])
  }

  /**
   * Store a value with no expiry.
   *
   * @example
   * await cache.forever('settings', { theme: 'dark' })
   */
  async forever(key: string, value: unknown): Promise<void> {
    await this.put(key, value)
  }

  /**
   * The cached value, or compute, store and return it. `undefined` results are not cached.
   *
   * @example
   * const posts = await cache.remember('posts:count', 60, () => Post.query().count())
   */
  async remember<TValue>(
    key: string,
    ttlSeconds: number | undefined,
    compute: () => TValue | Promise<TValue>,
  ): Promise<TValue> {
    const cached = await this.get(key)
    if (cached !== undefined) return cached as TValue
    const value = await compute()
    if (value !== undefined) await this.put(key, value, ttlSeconds)
    return value
  }

  /**
   * Stale-while-revalidate (Laravel's `Cache::flexible`): a value younger than `freshSeconds` is
   * returned as is; one younger than `staleSeconds` is returned at once and refreshed in the
   * background (one refresher at a time, across processes); an older or missing one is computed
   * now.
   *
   * @example
   * const stats = await cache.flexible('stats', [5, 60], () => computeStats())
   */
  async flexible<TValue>(
    key: string,
    [freshSeconds, staleSeconds]: readonly [number, number],
    compute: () => TValue | Promise<TValue>,
  ): Promise<TValue> {
    if (!(freshSeconds > 0 && staleSeconds > freshSeconds))
      throw new RangeError('flexible() needs [fresh, stale] seconds with 0 < fresh < stale.')
    const entry = asFlexible(await this.get(key))
    const now = Date.now()
    if (entry !== undefined) {
      const age = now - entry.t
      if (age < freshSeconds * 1000) return entry.v as TValue
      if (age < staleSeconds * 1000) {
        void this.#refresh(key, staleSeconds, compute)
        return entry.v as TValue
      }
    }
    const value = await compute()
    await this.put(key, { v: value, t: Date.now() } satisfies FlexibleEntry, staleSeconds)
    return value
  }

  async #refresh<TValue>(
    key: string,
    staleSeconds: number,
    compute: () => TValue | Promise<TValue>,
  ): Promise<void> {
    const guard = `${key}:refreshing`
    try {
      if (!(await this.add(guard, 1, Math.min(staleSeconds, 30)))) return
      try {
        const value = await compute()
        await this.put(key, { v: value, t: Date.now() } satisfies FlexibleEntry, staleSeconds)
      } finally {
        await this.forget(guard)
      }
    } catch (error) {
      // A background refresh must never crash the process; the stale value keeps being served.
      // Keys can carry user data (an e-mail, a search), so the log gets a digest, not the key.
      this.#logger?.warn('redis.cache.refresh_failed', { key_digest: keyDigest(key), error })
    }
  }
}

/** A short, stable digest of a cache key, to tell keys apart in logs without showing them. */
function keyDigest(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)
}

/** Milliseconds for `PX`, `undefined` for "forever", or `'expired'` for a ttl of 0 or less. */
function expiry(ttlSeconds: number | undefined): string | 'expired' | undefined {
  if (ttlSeconds === undefined) return undefined
  if (!Number.isFinite(ttlSeconds)) throw new RangeError('ttlSeconds must be a finite number.')
  if (ttlSeconds <= 0) return 'expired'
  return String(Math.max(1, Math.round(ttlSeconds * 1000)))
}

function encode(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined)
    throw new TypeError(
      'Cache values must be JSON-serialisable (not undefined, a function or a symbol).',
    )
  return encoded
}

function decode(raw: string | null): unknown {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function asFlexible(value: unknown): FlexibleEntry | undefined {
  if (typeof value !== 'object' || value === null || !('t' in value) || !('v' in value))
    return undefined
  const t = (value as { t: unknown }).t
  return typeof t === 'number' ? (value as FlexibleEntry) : undefined
}
