/**
 * `RedisServiceProvider`: wires Redis into a Strutvane app. The installer adds it to
 * `bootstrap/providers.ts`; nothing else is needed.
 *
 * **What it binds** (in `register()`, so it wins over the framework's defaults):
 * - `RedisConnectionToken`: one lazily opened connection for the whole app (closed on shutdown);
 * - `RedisKeySpaceToken`, `RedisLocksToken`, `RedisRateLimiterToken`;
 * - `CacheManagerToken`: the framework's stores plus `redis` (and any `driver: 'redis'` store in
 *   `config/cache.ts`). With `CACHE_STORE=redis`, `Cache` and the `throttle` middleware count in
 *   Redis, so limits hold across every server;
 * - `SessionStoreToken`: the Redis session store, when `SESSION_DRIVER=redis`;
 * - `IdempotencyStoreToken`: the Redis idempotency store, when the default cache store is a Redis
 *   store (the app has declared Redis its shared state; a memory store would let a retry that
 *   reaches another server run twice).
 *
 * **Fails closed at boot:** a bad `REDIS_*` value stops the app (`invalid_redis_config`). It does
 * not connect at boot: commands that never touch Redis keep working while it is down, and a
 * request that needs it gets a 503 `redis_unavailable` (see `connection.ts`).
 *
 * In production it warns (once, in the log) about a plain-text connection to a non-local host
 * and about a server without a password.
 *
 * @module
 */
import {
  type Application,
  CacheManagerToken,
  IdempotencyStoreToken,
  ServiceProvider,
  SessionStoreToken,
} from '@strutvane/framework'
import type { Logger } from '@strutvane/framework/contracts'
import { ClockToken, ErrorRegistryToken, LoggerToken } from '@strutvane/framework/core'
import { createRedisCacheManager } from './cache-manager.ts'
import { describeSettings, type RedisSettings, resolveRedisSettings } from './config.ts'
import { RedisConnection } from './connection.ts'
import { loadRedisEnv } from './env.ts'
import { PACKAGE_NAME, REDIS_ERRORS } from './errors.ts'
import { RedisIdempotencyStore } from './idempotency-store.ts'
import { KeySpace } from './keys.ts'
import { RedisLocks } from './lock.ts'
import { RedisRateLimiter } from './rate-limiter.ts'
import { RedisSessionStore } from './session-store.ts'
import {
  RedisConnectionToken,
  RedisKeySpaceToken,
  RedisLocksToken,
  RedisRateLimiterToken,
} from './tokens.ts'

/**
 * Options for {@link redisProvider} (tests and unusual setups; apps normally list the plain
 * {@link RedisServiceProvider}).
 *
 * @example
 * redisProvider({ env: { REDIS_URL: 'redis://127.0.0.1:6380' } })
 */
export interface RedisProviderOptions {
  /** The environment to read `REDIS_*` from. Default: `<app>/.env` under `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Passed to the connection: how long shutdown waits for pending replies. Default 2000 ms. */
  readonly closeTimeoutMs?: number
}

/**
 * The Redis service provider.
 *
 * @example
 * // bootstrap/providers.ts
 * import { RedisServiceProvider } from '@strutvane/redis/provider'
 * const providers: readonly AnyProvider[] = [AppServiceProvider, RedisServiceProvider]
 */
export class RedisServiceProvider extends ServiceProvider {
  readonly #options: RedisProviderOptions
  #connection: RedisConnection | undefined
  #settings: RedisSettings | undefined

  constructor(options: RedisProviderOptions = {}) {
    super()
    this.#options = options
  }

  override register(app: Application): void {
    const config = app.configRepository
    const read = (path: string): unknown => (config.has(path) ? config.get(path) : undefined)
    const env = this.#options.env ?? loadRedisEnv(app.basePath)
    const appName = read('app.name')
    const settings = resolveRedisSettings({
      config: read('redis') ?? read('database.redis'),
      env,
      ...(typeof appName === 'string' ? { appName } : {}),
    })
    this.#settings = settings
    const root = KeySpace.root(settings.prefix)
    const container = app.container
    const logger = (): Logger => container.make(LoggerToken).child({ component: 'redis' })
    const connection = (): RedisConnection => {
      this.#connection ??= new RedisConnection(settings, {
        logger: logger(),
        ...(this.#options.closeTimeoutMs === undefined
          ? {}
          : { closeTimeoutMs: this.#options.closeTimeoutMs }),
      })
      return this.#connection
    }

    container.singleton(RedisConnectionToken, connection)
    container.value(RedisKeySpaceToken, root)
    container.singleton(
      RedisLocksToken,
      () => new RedisLocks({ driver: connection(), space: root.area('lock') }),
    )
    container.singleton(
      RedisRateLimiterToken,
      () => new RedisRateLimiter({ driver: connection(), space: root.area('rate') }),
    )

    const cacheConfig = read('cache')
    const cache = createRedisCacheManagerLazily(app, cacheConfig, connection, root, logger)
    container.singleton(CacheManagerToken, cache.make)

    if (read('session.driver') === 'redis') {
      const lifetimeMinutes = read('session.lifetime')
      container.singleton(
        SessionStoreToken,
        () =>
          new RedisSessionStore({
            driver: connection(),
            space: root.area('session'),
            ...(typeof lifetimeMinutes === 'number'
              ? { lifetimeSeconds: lifetimeMinutes * 60 }
              : {}),
          }),
      )
    }

    if (cache.defaultIsRedis)
      container.singleton(
        IdempotencyStoreToken,
        () => new RedisIdempotencyStore({ driver: connection(), space: root.area('idempotency') }),
      )
  }

  override boot(app: Application): void {
    const registry = app.make(ErrorRegistryToken)
    for (const definition of REDIS_ERRORS)
      if (registry.get(definition.code) === undefined) registry.register(definition)
    const settings = this.#settings
    if (settings === undefined || app.environment !== 'production') return
    const logger = app.make(LoggerToken).child({ component: 'redis' })
    if (!settings.tls && !isLocalHost(settings.host))
      logger.warn('redis.plaintext', {
        ...describeSettings(settings),
        hint: 'Use rediss:// or REDIS_TLS=true for a Redis server on another machine.',
      })
    if (settings.password === undefined)
      logger.warn('redis.no_password', {
        ...describeSettings(settings),
        hint: 'Set REDIS_PASSWORD (and an ACL user with REDIS_USERNAME) in production.',
      })
  }

  override async shutdown(): Promise<void> {
    await this.#connection?.close()
  }
}

/**
 * A provider class with fixed options (for `bootstrap/providers.ts`, which lists classes).
 *
 * @example
 * const providers = [AppServiceProvider, redisProvider({ closeTimeoutMs: 5000 })]
 */
export function redisProvider(options: RedisProviderOptions): new () => RedisServiceProvider {
  return class ConfiguredRedisServiceProvider extends RedisServiceProvider {
    constructor() {
      super(options)
    }
  }
}

/** The package name, as `node strut doctor` shows it. */
export const name: string = PACKAGE_NAME

function createRedisCacheManagerLazily(
  app: Application,
  cacheConfig: unknown,
  connection: () => RedisConnection,
  root: KeySpace,
  logger: () => Logger,
): {
  readonly make: () => ReturnType<typeof createRedisCacheManager>
  readonly defaultIsRedis: boolean
} {
  // Built eagerly once to validate the config at register time (fail closed at boot), then
  // reused: stores inside it are still created on first use.
  const manager = createRedisCacheManager({
    basePath: app.basePath,
    clock: { now: () => app.make(ClockToken).now() },
    config: cacheConfig,
    driver: connection,
    root,
    logger: lazyLogger(logger),
  })
  const defaultIsRedis = isRedisStore(cacheConfig, manager.defaultStore)
  return { make: () => manager, defaultIsRedis }
}

function isRedisStore(cacheConfig: unknown, name: string): boolean {
  const stores =
    typeof cacheConfig === 'object' && cacheConfig !== null
      ? (cacheConfig as { stores?: unknown }).stores
      : undefined
  const entry =
    typeof stores === 'object' && stores !== null
      ? (stores as Record<string, unknown>)[name]
      : undefined
  if (entry === undefined) return name === 'redis'
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as { driver?: unknown }).driver === 'redis'
  )
}

/** A logger that resolves the app's logger on first use (it may not be bound at register time). */
function lazyLogger(resolve: () => Logger): Logger {
  let logger: Logger | undefined
  const get = (): Logger => {
    logger ??= resolve()
    return logger
  }
  return {
    trace: (msg, fields) => get().trace(msg, fields),
    debug: (msg, fields) => get().debug(msg, fields),
    info: (msg, fields) => get().info(msg, fields),
    warn: (msg, fields) => get().warn(msg, fields),
    error: (msg, fields) => get().error(msg, fields),
    fatal: (msg, fields) => get().fatal(msg, fields),
    child: (bindings) => get().child(bindings),
    isLevelEnabled: (level) => get().isLevelEnabled(level),
    flush: () => get().flush(),
  }
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}
