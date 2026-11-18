/**
 * The cache manager with Redis stores: the framework's manager (memory and file stores, from
 * `config/cache.ts`) plus every store whose driver is `redis`. The provider binds it as
 * `CacheManagerToken`, so `Cache`, `node strut cache:clear --store=redis` and (with
 * `CACHE_STORE=redis`) the `throttle` middleware all use Redis.
 *
 * ```ts
 * // config/cache.ts
 * stores: {
 *   file: { driver: 'file', path: 'storage/framework/cache' },
 *   redis: { driver: 'redis' },                      // keys: <prefix>cache:…
 *   reports: { driver: 'redis', area: 'reports' },   // keys: <prefix>reports:…
 * }
 * ```
 *
 * A `redis` store always exists (like `memory` and `file`), so `CACHE_STORE=redis` works without
 * editing `config/cache.ts`. A bad store entry stops boot with a friendly error.
 *
 * @module
 */
import {
  BootError,
  type CacheManager,
  type CacheStore,
  createCacheManager,
} from '@strutvane/framework'
import type { Logger } from '@strutvane/framework/contracts'
import type { Clock } from '@strutvane/framework/core'
import { RedisCacheStore } from './cache-store.ts'
import type { RedisDriver } from './driver.ts'
import type { KeySpace } from './keys.ts'

/**
 * One Redis store in `config/cache.ts`.
 *
 * @example
 * const store: RedisCacheStoreConfig = { driver: 'redis', area: 'reports' }
 */
export interface RedisCacheStoreConfig {
  readonly driver: 'redis'
  /** The key area after the app prefix. Default `cache`. */
  readonly area?: string
}

/**
 * What {@link createRedisCacheManager} needs.
 *
 * @example
 * createRedisCacheManager({ basePath, clock, config: app.config('cache'), driver: () => redis, root })
 */
export interface RedisCacheManagerOptions {
  readonly basePath: string
  readonly clock: Clock
  /** The `cache` config tree (unchecked). */
  readonly config?: unknown
  /** The shared connection (resolved on first use of a Redis store). */
  readonly driver: () => RedisDriver
  /** The app's root key space (`REDIS_PREFIX`). */
  readonly root: KeySpace
  readonly logger?: Logger
}

/**
 * Build the cache manager with Redis stores.
 *
 * @example
 * const cache = createRedisCacheManager(options)
 * await cache.store('redis').put('k', 1, 60)
 */
export function createRedisCacheManager(options: RedisCacheManagerOptions): CacheManager {
  const { defaultStore, frameworkStores, redisStores } = split(options.config)
  const framework = createCacheManager({
    basePath: options.basePath,
    clock: options.clock,
    config: { default: 'memory', stores: frameworkStores },
  })
  const names = [...new Set([...framework.storeNames, ...redisStores.keys()])].sort()
  if (!names.includes(defaultStore)) throw unknownStore(defaultStore, names)
  const created = new Map<string, CacheStore>()
  return {
    defaultStore,
    storeNames: names,
    store(name: string = defaultStore): CacheStore {
      const area = redisStores.get(name)
      if (area === undefined) {
        if (!names.includes(name)) throw unknownStore(name, names)
        return framework.store(name)
      }
      let store = created.get(name)
      if (store === undefined) {
        store = new RedisCacheStore({
          driver: options.driver(),
          space: options.root.area(area),
          ...(options.logger === undefined ? {} : { logger: options.logger }),
        })
        created.set(name, store)
      }
      return store
    },
  }
}

interface Split {
  readonly defaultStore: string
  readonly frameworkStores: Record<string, unknown>
  readonly redisStores: ReadonlyMap<string, string>
}

function split(value: unknown): Split {
  if (value === undefined || value === null)
    return {
      defaultStore: 'memory',
      frameworkStores: {},
      redisStores: new Map([['redis', 'cache']]),
    }
  if (typeof value !== 'object' || Array.isArray(value))
    throw invalid('config/cache.ts must export an object such as { default, stores }.')
  const record = value as Record<string, unknown>
  const name = record['default']
  if (name !== undefined && typeof name !== 'string')
    throw invalid('cache.default must be a store name.')
  const raw = record['stores'] ?? {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw invalid('cache.stores must map store names to { driver }.')
  const frameworkStores: Record<string, unknown> = {}
  const redisStores = new Map<string, string>([['redis', 'cache']])
  for (const [store, entry] of Object.entries(raw as Record<string, unknown>)) {
    const driver =
      typeof entry === 'object' && entry !== null ? (entry as { driver?: unknown }).driver : entry
    if (driver !== 'redis') {
      redisStores.delete(store)
      frameworkStores[store] = entry
      continue
    }
    const area = (entry as { area?: unknown }).area ?? 'cache'
    if (typeof area !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(area))
      throw invalid(
        `cache.stores.${store}.area must be a short lowercase name (letters, digits, _ and -, starting with a letter).`,
      )
    for (const key of Object.keys(entry as object))
      if (key !== 'driver' && key !== 'area')
        throw invalid(
          `cache.stores.${store} has an unknown key "${key}" (a redis store takes driver and area).`,
        )
    redisStores.set(store, area)
  }
  return { defaultStore: name ?? 'memory', frameworkStores, redisStores }
}

function invalid(message: string): BootError {
  return new BootError(
    'invalid_cache_config',
    message,
    "Example: stores: { redis: { driver: 'redis' }, file: { driver: 'file' } } and CACHE_STORE=redis in .env.",
  )
}

function unknownStore(name: string, names: readonly string[]): BootError {
  return new BootError(
    'unknown_cache_store',
    `There is no "${name}" cache store.`,
    `The stores are: ${names.join(', ')} (config/cache.ts).`,
  )
}
