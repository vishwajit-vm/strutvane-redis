/**
 * The provider's wiring in a real Application, without a Redis server: the connection is lazy, so
 * booting, binding and shutting down never connect. Behaviour against a server is in
 * test/integration/app.test.ts.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Application,
  CacheManagerToken,
  type ConfigFiles,
  defineConfig,
  IdempotencyStoreToken,
  isBootError,
  SessionStoreToken,
} from '@strutvane/framework'
import { ErrorRegistryToken, LoggerToken } from '@strutvane/framework/core'
import { afterAll, describe, expect, it } from 'vitest'
import { RedisCacheStore } from '../../src/cache-store.ts'
import { RedisIdempotencyStore } from '../../src/idempotency-store.ts'
import { RedisLocks } from '../../src/lock.ts'
import { name, RedisServiceProvider, redisProvider } from '../../src/provider.ts'
import { RedisRateLimiter } from '../../src/rate-limiter.ts'
import { RedisSessionStore } from '../../src/session-store.ts'
import {
  RedisConnectionToken,
  RedisKeySpaceToken,
  RedisLocksToken,
  RedisRateLimiterToken,
} from '../../src/tokens.ts'
import { MemoryLogger } from '../support/logger.ts'

const base = mkdtempSync(join(tmpdir(), 'strutvane-redis-provider-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

function makeApp(
  config: ConfigFiles,
  redisEnv: Record<string, string> = {},
  appEnv: Record<string, string> = {},
): { app: Application; logger: MemoryLogger } {
  const env = {
    APP_NAME: 'Provider Test',
    APP_ENV: 'testing',
    APP_KEY: `base64:${randomBytes(32).toString('base64')}`,
    APP_URL: 'http://localhost',
    ...appEnv,
  }
  const app = Application.configure({ basePath: base, env })
    .withConfig({
      app: defineConfig((e) => ({
        name: e.string('APP_NAME', 'x'),
        env: e.string('APP_ENV', 'testing'),
      })),
      ...config,
    })
    .withProviders([redisProvider({ env: { REDIS_PORT: '1', ...redisEnv } })])
    .create()
  const logger = new MemoryLogger()
  app.container.value(LoggerToken, logger)
  return { app, logger }
}

describe('RedisServiceProvider', () => {
  it('binds the Redis services without connecting', async () => {
    const { app } = makeApp({
      cache: defineConfig(() => ({ default: 'redis' })),
      session: defineConfig(() => ({ driver: 'redis', lifetime: 30 })),
    })
    await app.boot()
    expect(app.make(RedisKeySpaceToken).prefix).toBe('provider_test:testing:')
    expect(app.make(RedisLocksToken)).toBeInstanceOf(RedisLocks)
    expect(app.make(RedisRateLimiterToken)).toBeInstanceOf(RedisRateLimiter)
    expect(app.make(CacheManagerToken).store()).toBeInstanceOf(RedisCacheStore)
    expect(app.make(SessionStoreToken)).toBeInstanceOf(RedisSessionStore)
    expect(app.make(IdempotencyStoreToken)).toBeInstanceOf(RedisIdempotencyStore)
    const connection = app.make(RedisConnectionToken)
    expect(connection.closed).toBe(false)
    expect(app.make(ErrorRegistryToken).get('redis_unavailable')?.status).toBe(503)
    expect(app.make(ErrorRegistryToken).get('lock_timeout')?.owner).toBe(name)
    await app.shutdown()
    expect(connection.closed).toBe(true)
  })

  it('leaves sessions and idempotency to the framework unless Redis is chosen', async () => {
    const { app } = makeApp({ cache: defineConfig(() => ({ default: 'file' })) })
    await app.boot()
    expect(app.make(CacheManagerToken).store()).not.toBeInstanceOf(RedisCacheStore)
    expect(app.make(CacheManagerToken).store('redis')).toBeInstanceOf(RedisCacheStore)
    // The file store reads the app clock for expiry (through the provider's lazy clock).
    await app.make(CacheManagerToken).store('file').put('clock-check', 1, 60)
    expect(await app.make(CacheManagerToken).store('file').ttl('clock-check')).toBe(60)
    expect(app.make(SessionStoreToken)).not.toBeInstanceOf(RedisSessionStore)
    expect(app.make(IdempotencyStoreToken)).not.toBeInstanceOf(RedisIdempotencyStore)
    await app.shutdown() // never connected: nothing to close
  })

  it('treats a named redis store (object or bare driver) as the shared state', async () => {
    for (const store of [{ driver: 'redis', area: 'shared' }, 'redis'] as const) {
      const { app } = makeApp({
        cache: defineConfig(() => ({ default: 'shared', stores: { shared: store } })),
      })
      await app.boot()
      expect(app.make(IdempotencyStoreToken)).toBeInstanceOf(RedisIdempotencyStore)
      await app.shutdown()
    }
  })

  it('reads settings from config/redis.ts, or Laravel’s database.redis', async () => {
    const own = makeApp({ redis: defineConfig(() => ({ prefix: 'own:x:' })) })
    await own.app.boot()
    expect(own.app.make(RedisKeySpaceToken).prefix).toBe('own:x:')
    const laravel = makeApp({ database: defineConfig(() => ({ redis: { prefix: 'db:x:' } })) })
    await laravel.app.boot()
    expect(laravel.app.make(RedisKeySpaceToken).prefix).toBe('db:x:')
  })

  it('stops boot on a bad setting (fail closed)', async () => {
    const { app } = makeApp({}, { REDIS_PORT: 'abc' })
    const error = await app.boot().catch((caught: unknown) => caught)
    expect(isBootError(error)).toBe(true)
    expect((error as { code: string }).code).toBe('invalid_redis_config')
  })

  it('stops boot in production for a remote host without an explicit TLS choice', async () => {
    const remote = makeApp({}, { REDIS_HOST: 'cache.internal' }, { APP_ENV: 'production' })
    const error = await remote.app.boot().catch((caught: unknown) => caught)
    expect(isBootError(error)).toBe(true)
    expect((error as { code: string }).code).toBe('invalid_redis_config')
  })

  it('warns in production when plain text or no password was chosen on purpose', async () => {
    const remote = makeApp(
      {},
      { REDIS_HOST: 'cache.internal', REDIS_TLS: 'false', REDIS_ALLOW_NO_PASSWORD: 'true' },
      { APP_ENV: 'production' },
    )
    await remote.app.boot()
    expect(remote.logger.messages('warn')).toEqual(
      expect.arrayContaining(['redis.plaintext', 'redis.no_password']),
    )
    const safe = makeApp(
      {},
      { REDIS_HOST: '127.0.0.1', REDIS_PASSWORD: 'secret-value' },
      { APP_ENV: 'production' },
    )
    await safe.app.boot()
    expect(safe.logger.messages('warn')).not.toContain('redis.plaintext')
    expect(safe.logger.messages('warn')).not.toContain('redis.no_password')
    expect(JSON.stringify(safe.logger.entries)).not.toContain('secret-value')
  })

  it('is a plain provider class too (bootstrap/providers.ts lists it as is)', () => {
    expect(new RedisServiceProvider()).toBeInstanceOf(RedisServiceProvider)
    expect(new (redisProvider({}))()).toBeInstanceOf(RedisServiceProvider)
  })
})
