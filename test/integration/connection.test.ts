import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StrutvaneError } from '@strutvane/framework/core'
import { afterAll, describe, expect, it } from 'vitest'
import { RedisCacheStore } from '../../src/cache-store.ts'
import { RedisConnection } from '../../src/connection.ts'
import { defineLua } from '../../src/driver.ts'
import { KeySpace } from '../../src/keys.ts'
import { closeAll, connect, server, skip, testSettings, title } from '../support/redis.ts'

afterAll(closeAll)

const code = (error: unknown): unknown => (error as { code?: unknown }).code

describe.skipIf(skip)(title('RedisConnection against a real server'), () => {
  it('connects lazily, answers PING and reports health', async () => {
    const redis = connect()
    expect(await redis.ping()).toBeGreaterThanOrEqual(0)
    expect(await redis.health()).toMatchObject({ status: 'up' })
  })

  it('reloads a Lua script after SCRIPT FLUSH (NOSCRIPT fallback)', async () => {
    const redis = connect()
    const script = defineLua(`return ARGV[1] .. '-${Date.now()}'`)
    expect(String(await redis.script(script, [], ['a']))).toMatch(/^a-/)
    await redis.command(['SCRIPT', 'FLUSH'])
    expect(String(await redis.script(script, [], ['b']))).toMatch(/^b-/)
  })

  it('keeps server error replies loud (a caller bug), not a 503', async () => {
    const redis = connect()
    const key = `wrongtype:${Date.now()}`
    await redis.command(['LPUSH', key, 'x'])
    const error = await redis.command(['GET', key]).catch((caught: unknown) => caught)
    expect(error).not.toBeInstanceOf(StrutvaneError)
    expect(String((error as Error).message)).toMatch(/WRONGTYPE/)
    await redis.command(['DEL', key])
    await expect(redis.script(defineLua("return redis.call('NOPE')"), [], [])).rejects.toThrow()
  })

  it('fails fast with redis_unavailable when nothing listens, then retries after the pause', async () => {
    const dead = new RedisConnection(
      // testSettings gives a unique two-part test prefix: without APP_ENV the settings are
      // production's, which refuse the shared fallback prefix of an unnamed app.
      testSettings({ REDIS_HOST: '127.0.0.1', REDIS_PORT: '1', REDIS_CONNECT_TIMEOUT: '1000' }),
      { retryAfterMs: 200 },
    )
    const first = await dead.command(['PING']).catch((caught: unknown) => caught)
    expect(code(first)).toBe('redis_unavailable')
    expect((first as StrutvaneError).status).toBe(503)
    const started = Date.now()
    expect(code(await dead.command(['PING']).catch((caught: unknown) => caught))).toBe(
      'redis_unavailable',
    )
    expect(Date.now() - started).toBeLessThan(100) // the circuit breaker answered at once
    expect(await dead.health()).toEqual({ status: 'down', error: 'redis_unavailable' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(code(await dead.command(['PING']).catch((caught: unknown) => caught))).toBe(
      'redis_unavailable',
    )
    await dead.close()
  })

  it('refuses commands after close, and close is idempotent', async () => {
    const redis = connect()
    await redis.command(['PING'])
    await redis.close()
    await redis.close()
    expect(redis.closed).toBe(true)
    expect(code(await redis.command(['PING']).catch((caught: unknown) => caught))).toBe(
      'redis_unavailable',
    )
  })

  it('close() during the first connect does not leak the socket', async () => {
    const redis = connect()
    const pending = redis.command(['PING']).catch((caught: unknown) => caught)
    await redis.close()
    const outcome = await pending
    expect(outcome === 'PONG' || code(outcome) === 'redis_unavailable').toBe(true)
  })
})

describe.skipIf(skip || !server.acl)(title('ACL users'), () => {
  it('logs in as an ACL user with a password', async () => {
    const redis = connect({ REDIS_USERNAME: 'app', REDIS_PASSWORD: 'app-secret' })
    expect(await redis.command(['ACL', 'WHOAMI'])).toBe('app')
  })

  it('logs in through REDIS_URL with percent-encoded credentials', async () => {
    const redis = connect({
      REDIS_URL: `redis://app:${encodeURIComponent('app-secret')}@${server.host}:${server.port}/1`,
    })
    expect(await redis.command(['ACL', 'WHOAMI'])).toBe('app')
    await redis.command(['SET', 'db-check', '1'])
    expect(await redis.command(['EXISTS', 'db-check'])).toBe(1)
    await redis.command(['DEL', 'db-check'])
  })

  it('a wrong password fails closed (503) and the log never contains it', async () => {
    const lines: string[] = []
    const logger = {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string, fields?: unknown) => void lines.push(`${msg} ${JSON.stringify(fields)}`),
      fatal: () => {},
      child() {
        return logger
      },
      isLevelEnabled: () => true,
      flush: async () => {},
    }
    const redis = connect(
      { REDIS_USERNAME: 'app', REDIS_PASSWORD: 'definitely-wrong-pw' },
      { logger },
    )
    const error = await redis.command(['PING']).catch((caught: unknown) => caught)
    expect(code(error)).toBe('redis_unavailable')
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).not.toContain('definitely-wrong-pw')
    expect(JSON.stringify((error as StrutvaneError).params)).not.toContain('definitely-wrong-pw')
  })

  it('a key outside the ACL user’s pattern is denied (NOPERM → 503), inside is fine', async () => {
    const redis = connect({ REDIS_USERNAME: 'limited', REDIS_PASSWORD: 'limited-secret' })
    const allowed = new RedisCacheStore({
      driver: redis,
      space: KeySpace.root('limited:test:').area('cache'),
    })
    await allowed.put('k', 1)
    expect(await allowed.get('k')).toBe(1)
    await allowed.forget('k')
    const denied = new RedisCacheStore({
      driver: redis,
      space: KeySpace.root('other:test:').area('cache'),
    })
    expect(code(await denied.put('k', 1).catch((caught: unknown) => caught))).toBe(
      'redis_unavailable',
    )
  })
})

describe.skipIf(skip || server.tlsPort === undefined)(title('TLS'), () => {
  const dir = mkdtempSync(join(tmpdir(), 'strutvane-redis-ca-'))
  const caFile = join(dir, 'ca.pem')
  writeFileSync(caFile, server.caPem ?? '')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const tlsEnv = { REDIS_PORT: String(server.tlsPort), REDIS_TLS: 'true' }

  it('connects over TLS with the CA from REDIS_TLS_CA', async () => {
    const redis = connect({ ...tlsEnv, REDIS_TLS_CA: caFile, REDIS_TLS_SERVERNAME: 'localhost' })
    expect(await redis.command(['PING'])).toBe('PONG')
  })

  it('connects with a rediss:// URL', async () => {
    const redis = connect({
      REDIS_URL: `rediss://${server.host}:${server.tlsPort}`,
      REDIS_TLS_CA: caFile,
    })
    expect(await redis.command(['PING'])).toBe('PONG')
  })

  it('refuses an untrusted certificate (no CA): verification is always on', async () => {
    const redis = connect(tlsEnv)
    expect(code(await redis.command(['PING']).catch((caught: unknown) => caught))).toBe(
      'redis_unavailable',
    )
  })

  it('refuses a certificate for another host name', async () => {
    const redis = connect({
      ...tlsEnv,
      REDIS_TLS_CA: caFile,
      REDIS_TLS_SERVERNAME: 'evil.example.com',
    })
    expect(code(await redis.command(['PING']).catch((caught: unknown) => caught))).toBe(
      'redis_unavailable',
    )
  })

  it('a plain-text client cannot talk to the TLS port', async () => {
    const redis = connect({
      REDIS_PORT: String(server.tlsPort),
      REDIS_CONNECT_TIMEOUT: '1500',
      REDIS_COMMAND_TIMEOUT: '1500',
    })
    expect(code(await redis.command(['PING']).catch((caught: unknown) => caught))).toBe(
      'redis_unavailable',
    )
  })
})
