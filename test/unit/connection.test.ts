/**
 * The connection's failure handling, against a scripted client (no server): error translation,
 * the circuit breaker, close timeouts, reconnect logging and the options node-redis receives.
 * The same paths run against a real server in test/integration/connection.test.ts.
 */
import { isBootError } from '@strutvane/framework'
import { StrutvaneError } from '@strutvane/framework/core'
import { describe, expect, it } from 'vitest'
import { resolveRedisSettings } from '../../src/config.ts'
import {
  type RedisClientLike,
  type RedisClientOptionsLike,
  RedisConnection,
} from '../../src/connection.ts'
import { defineLua } from '../../src/driver.ts'
import { MemoryLogger } from '../support/logger.ts'

interface Behaviour {
  connect?: () => Promise<void>
  send?: (args: readonly string[]) => Promise<unknown>
  close?: () => Promise<void>
}

class FakeClient implements RedisClientLike {
  isOpen = false
  isReady = false
  destroyed = false
  closed = false
  listener: ((error: unknown) => void) | undefined
  readonly sent: (readonly string[])[] = []
  readonly options: RedisClientOptionsLike
  readonly behaviour: Behaviour
  constructor(options: RedisClientOptionsLike, behaviour: Behaviour = {}) {
    this.options = options
    this.behaviour = behaviour
  }
  async connect(): Promise<unknown> {
    await this.behaviour.connect?.()
    this.isOpen = true
    this.isReady = true
    return this
  }
  async sendCommand(args: readonly string[]): Promise<unknown> {
    this.sent.push(args)
    return this.behaviour.send === undefined ? 'OK' : this.behaviour.send(args)
  }
  async close(): Promise<void> {
    await this.behaviour.close?.()
    this.closed = true
    this.isOpen = false
    this.isReady = false
  }
  destroy(): void {
    this.destroyed = true
    this.isOpen = false
    this.isReady = false
  }
  on(_event: 'error', listener: (error: unknown) => void): unknown {
    this.listener = listener
    return this
  }
}

const named = (name: string, message = name, code?: string): Error => {
  const error = new Error(message)
  error.name = name
  if (code !== undefined) Object.assign(error, { code })
  return error
}

const settings = (env: Record<string, string> = {}) =>
  resolveRedisSettings({ env: { REDIS_PREFIX: 'u:', ...env } })

function harness(
  behaviour: Behaviour = {},
  options: { retryAfterMs?: number; closeTimeoutMs?: number; env?: Record<string, string> } = {},
) {
  const clients: FakeClient[] = []
  const logger = new MemoryLogger()
  const connection = new RedisConnection(settings(options.env), {
    logger,
    retryAfterMs: options.retryAfterMs ?? 1000,
    closeTimeoutMs: options.closeTimeoutMs ?? 2000,
    createClient: (clientOptions) => {
      const client = new FakeClient(clientOptions, behaviour)
      clients.push(client)
      return client
    },
  })
  return { connection, clients, logger }
}

const codeOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error as { code?: unknown }).code,
  )

describe('RedisConnection (scripted client)', () => {
  it('connects once, lazily, and passes the command timeout', async () => {
    const { connection, clients } = harness()
    expect(clients).toHaveLength(0)
    await Promise.all([connection.command(['PING']), connection.command(['PING'])])
    expect(clients).toHaveLength(1)
    expect(clients[0]?.sent).toEqual([['PING'], ['PING']])
    expect(clients[0]?.options.disableOfflineQueue).toBe(true)
    expect(await connection.ping()).toBeGreaterThanOrEqual(0)
  })

  it('builds TLS, ACL and database options, and never turns verification off', () => {
    const { connection, clients } = harness(
      {},
      {
        env: { REDIS_URL: 'rediss://app:pw@h.example:6390/2', REDIS_TLS_SERVERNAME: 'h.example' },
      },
    )
    void connection.command(['PING'])
    const options = clients[0]?.options
    expect(options).toMatchObject({ username: 'app', password: 'pw', database: 2 })
    expect(options?.socket).toMatchObject({
      host: 'h.example',
      port: 6390,
      tls: true,
      rejectUnauthorized: true,
      servername: 'h.example',
    })
    const plain = harness()
    void plain.connection.command(['PING'])
    expect(plain.clients[0]?.options.socket['tls']).toBeUndefined()
    expect(plain.clients[0]?.options).not.toHaveProperty('password')
  })

  it('refuses an unreadable CA file with invalid_redis_config', async () => {
    const { connection } = harness(
      {},
      { env: { REDIS_TLS: 'true', REDIS_TLS_CA: '/no/such/ca.pem' } },
    )
    const error = await connection.command(['PING']).catch((caught: unknown) => caught)
    expect(isBootError(error)).toBe(true)
  })

  it('reconnect strategy: no retries before the first connect, capped backoff after', async () => {
    const { connection, clients } = harness()
    const strategy = (): ((retries: number, cause: Error) => number | Error) =>
      clients.at(-1)?.options.socket['reconnectStrategy'] as (
        retries: number,
        cause: Error,
      ) => number | Error
    const pending = connection.command(['PING'])
    const cause = new Error('refused')
    expect(strategy()(1, cause)).toBe(cause)
    await pending
    const delay = strategy()(20, cause)
    expect(typeof delay).toBe('number')
    expect(delay as number).toBeLessThan(2100)
    await connection.close()
    expect(strategy()(1, cause)).toBe(cause)
  })

  it('a failed connect is a 503, logged once, then the circuit breaker answers at once', async () => {
    let attempts = 0
    const { connection, clients, logger } = harness(
      {
        connect: async () => {
          attempts += 1
          throw named('Error', 'connect ECONNREFUSED 127.0.0.1:6379', 'ECONNREFUSED')
        },
      },
      { retryAfterMs: 50 },
    )
    const error = await connection.command(['GET', 'k']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StrutvaneError)
    expect((error as StrutvaneError).code).toBe('redis_unavailable')
    expect((error as StrutvaneError).headers['Retry-After']).toBe('1')
    expect(clients[0]?.destroyed).toBe(true)
    expect(await codeOf(connection.command(['GET', 'k']))).toBe('redis_unavailable')
    expect(attempts).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 70))
    await connection.command(['GET', 'k']).catch(() => undefined)
    expect(attempts).toBe(2)
    expect(logger.messages('error')).toEqual(['redis.unavailable'])
    expect(JSON.stringify(logger.entries)).toContain('ECONNREFUSED')
  })

  it('logs a reconnect after an outage', async () => {
    let fail = true
    const { connection, logger } = harness(
      {
        connect: async () => {
          if (fail) throw named('ConnectionTimeoutError')
        },
      },
      { retryAfterMs: 0 },
    )
    await connection.command(['PING']).catch(() => undefined)
    fail = false
    await connection.command(['PING'])
    expect(logger.messages('info')).toEqual(['redis.reconnected'])
  })

  it('fails fast while the socket is reconnecting (offline queue off)', async () => {
    const { connection, clients } = harness()
    await connection.command(['PING'])
    const client = clients[0]
    if (client === undefined) throw new Error('no client')
    client.isReady = false
    expect(await codeOf(connection.command(['PING']))).toBe('redis_unavailable')
    client.listener?.(named('SocketClosedUnexpectedlyError'))
    client.isReady = true
    expect(await connection.command(['PING'])).toBe('OK')
  })

  it('translates errors: unreachable and auth problems are 503, server replies stay loud', async () => {
    const replies: Record<string, unknown> = {
      TIMEOUT: named('TimeoutError'),
      OFFLINE: named('ClientOfflineError'),
      SOCKET: named('Error', 'read ECONNRESET', 'ECONNRESET'),
      TLS: named('Error', 'self-signed certificate in certificate chain'),
      WRONGPASS: named('SimpleError', 'WRONGPASS invalid username-password pair'),
      NOPERM: named('SimpleError', "NOPERM User x has no permissions to access the 'k' key"),
      WRONGTYPE: named(
        'SimpleError',
        'WRONGTYPE Operation against a key holding the wrong kind of value',
      ),
      ODD: 'not an error object',
    }
    const { connection, logger } = harness({
      send: async (args) => {
        throw replies[args[0] ?? '']
      },
    })
    for (const command of ['TIMEOUT', 'OFFLINE', 'SOCKET', 'TLS', 'WRONGPASS', 'NOPERM', 'ODD'])
      expect(await codeOf(connection.command([command]))).toBe('redis_unavailable')
    const loud = await connection.command(['WRONGTYPE']).catch((caught: unknown) => caught)
    expect(loud).not.toBeInstanceOf(StrutvaneError)
    expect(logger.messages('error')).toEqual(['redis.access_denied', 'redis.access_denied'])
  })

  it('runs scripts with EVALSHA and falls back to EVAL on NOSCRIPT only', async () => {
    const script = defineLua('return 1')
    let loaded = false
    const { connection, clients } = harness({
      send: async (args) => {
        if (args[0] === 'EVALSHA' && !loaded)
          throw named('SimpleError', 'NOSCRIPT No matching script')
        if (args[0] === 'EVAL') loaded = true
        if (args[0] === 'EVALSHA' && args[1] === 'boom') throw named('SimpleError', 'ERR boom')
        return 1
      },
    })
    expect(await connection.script(script, ['k'], ['a'])).toBe(1)
    expect(await connection.script(script, ['k'], ['a'])).toBe(1)
    expect(clients[0]?.sent.map((args) => args[0])).toEqual(['EVALSHA', 'EVAL', 'EVALSHA'])
    expect(clients[0]?.sent[1]).toEqual(['EVAL', 'return 1', '1', 'k', 'a'])
    await expect(connection.script({ source: 'x', sha1: 'boom' }, [], [])).rejects.toThrow(
      'ERR boom',
    )
  })

  it('health() never throws', async () => {
    const down = harness({ connect: async () => Promise.reject(named('ConnectionTimeoutError')) })
    expect(await down.connection.health()).toEqual({ status: 'down', error: 'redis_unavailable' })
    const odd = harness({ send: async () => Promise.reject(named('SimpleError', 'ERR odd')) })
    expect(await odd.connection.health()).toEqual({ status: 'down', error: 'redis_unavailable' })
    const up = harness()
    expect(await up.connection.health()).toMatchObject({ status: 'up' })
  })

  it('closes gracefully, drops a hung socket after the timeout, and refuses later commands', async () => {
    const graceful = harness()
    await graceful.connection.close() // never connected: nothing to do
    const used = harness()
    await used.connection.command(['PING'])
    await used.connection.close()
    expect(used.clients[0]?.closed).toBe(true)
    expect(await codeOf(used.connection.command(['PING']))).toBe('redis_unavailable')

    const hung = harness({ close: () => new Promise(() => {}) }, { closeTimeoutMs: 20 })
    await hung.connection.command(['PING'])
    await hung.connection.close()
    expect(hung.clients[0]?.destroyed).toBe(true)
    expect(hung.logger.messages('warn')).toEqual(['redis.close_timeout'])

    const failing = harness({ close: () => Promise.reject(new Error('close failed')) })
    await failing.connection.command(['PING'])
    await failing.connection.close()
    expect(failing.clients[0]?.destroyed).toBe(true)
  })

  it('close() during connect destroys the new socket', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { connection, clients } = harness({ connect: () => gate })
    const pending = connection.command(['PING']).catch((caught: unknown) => caught)
    const closing = connection.close()
    release()
    await closing
    expect(((await pending) as { code?: unknown }).code).toBe('redis_unavailable')
    expect(clients[0]?.destroyed).toBe(true)
  })

  it('close() waits for a failing first connect', async () => {
    const { connection } = harness({
      connect: () => Promise.reject(named('ConnectionTimeoutError')),
    })
    const pending = connection.command(['PING']).catch(() => undefined)
    await connection.close()
    await pending
    expect(connection.closed).toBe(true)
  })
})
