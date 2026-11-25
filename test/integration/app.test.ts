/**
 * The provider in a real Strutvane application: the cache manager, sessions and idempotency are
 * Redis-backed, and the framework's `throttle` middleware shares one budget across two app
 * instances (two "servers").
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Application,
  CacheManagerToken,
  defineConfig,
  defineRoutes,
  IdempotencyStoreToken,
  isBootError,
  Route,
  SessionStoreToken,
} from '@strutvane/framework'
import { afterAll, describe, expect, it } from 'vitest'
import { RedisCacheStore } from '../../src/cache-store.ts'
import { RedisIdempotencyStore } from '../../src/idempotency-store.ts'
import { redisProvider } from '../../src/provider.ts'
import { RedisSessionStore } from '../../src/session-store.ts'
import { RedisConnectionToken, RedisLocksToken, RedisRateLimiterToken } from '../../src/tokens.ts'
import { server, skip, title } from '../support/redis.ts'

const base = mkdtempSync(join(tmpdir(), 'strutvane-redis-app-'))
const apps: Application[] = []
afterAll(async () => {
  for (const app of apps.splice(0)) await app.shutdown()
  rmSync(base, { recursive: true, force: true })
})

function makeApp(prefix: string, options: { readonly session?: string } = {}): Application {
  const env = {
    APP_NAME: 'Redis Test',
    APP_ENV: 'testing',
    APP_KEY: `base64:${randomBytes(32).toString('base64')}`,
    APP_URL: 'http://localhost',
  }
  const app = Application.configure({ basePath: base, env })
    .withConfig({
      app: defineConfig((e) => ({
        name: e.string('APP_NAME', 'x'),
        env: e.string('APP_ENV', 'testing'),
        key: e.string('APP_KEY', ''),
      })),
      cache: defineConfig(() => ({ default: 'redis', stores: { file: { driver: 'file' } } })),
      session: defineConfig(() => ({ driver: options.session ?? 'redis', lifetime: 30 })),
    })
    .withProviders([
      redisProvider({
        env: { REDIS_HOST: server.host, REDIS_PORT: String(server.port), REDIS_PREFIX: prefix },
      }),
    ])
    .withRouting({ api: defineRoutes([Route.get('/ping', (ctx) => ctx.json({ ok: true }))]) })
    .withMiddleware((m) => {
      m.rateLimiter('api', { maxAttempts: 5, decaySeconds: 60 })
    })
    .create()
  apps.push(app)
  return app
}

describe.skipIf(skip)(title('RedisServiceProvider in an application'), () => {
  it('binds Redis stores; throttle limits hold across two app servers', async () => {
    // REDIS_PREFIX is two parts, the app then the environment (decision #135).
    const prefix = `app${randomBytes(4).toString('hex')}:test:`
    const one = makeApp(prefix)
    const two = makeApp(prefix)
    await one.boot()
    await two.boot()

    const cache = one.make(CacheManagerToken)
    expect(cache.defaultStore).toBe('redis')
    expect(cache.store()).toBeInstanceOf(RedisCacheStore)
    expect(one.make(SessionStoreToken)).toBeInstanceOf(RedisSessionStore)
    expect(one.make(IdempotencyStoreToken)).toBeInstanceOf(RedisIdempotencyStore)
    await cache.store().put('shared', 'from-one')
    expect(await two.make(CacheManagerToken).store().get('shared')).toBe('from-one')
    expect(await cache.store('file').get('shared')).toBeUndefined()

    const statuses: number[] = []
    for (let i = 0; i < 8; i++) {
      const app = i % 2 === 0 ? one : two
      const response = await app.handle(new Request('http://localhost/api/ping'), {
        ip: '203.0.113.9',
      })
      statuses.push(response.status)
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(5)
    expect(statuses.filter((status) => status === 429)).toHaveLength(3)

    const locks = one.make(RedisLocksToken)
    expect(await locks.create('boot', 5).acquire()).toBe(true)
    expect(await two.make(RedisLocksToken).create('boot', 5).acquire()).toBe(false)
    expect(
      (await one.make(RedisRateLimiterToken).hit('x', { max: 1, windowSeconds: 5 })).allowed,
    ).toBe(true)
    await cache.store().flush()
  })

  it('stops boot on a one-part REDIS_PREFIX, before any key is written (fail closed)', async () => {
    const app = makeApp(`app${randomBytes(4).toString('hex')}:`)
    const error = await app.boot().catch((caught: unknown) => caught)
    expect(isBootError(error)).toBe(true)
    expect((error as { code: string }).code).toBe('invalid_redis_config')
    expect(String((error as Error).message)).toMatch(/two parts/)
    apps.splice(apps.indexOf(app), 1)
  })

  it('closes its connection on shutdown', async () => {
    const app = makeApp(`app${randomBytes(4).toString('hex')}:test:`, { session: 'file' })
    await app.boot()
    const connection = app.make(RedisConnectionToken)
    await connection.command(['PING'])
    apps.splice(apps.indexOf(app), 1)
    await app.shutdown()
    expect(connection.closed).toBe(true)
  })
})
