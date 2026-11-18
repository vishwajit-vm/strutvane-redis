/**
 * The Redis connection: node-redis (`@redis/client`) behind the {@link RedisDriver} seam.
 *
 * **Why `@redis/client`:** it is the official, MIT-licensed client maintained by Redis Inc., works
 * with Valkey (same protocol), supports TLS, ACL users, RESP3, Sentinel and cluster, and has **no
 * runtime dependencies** (its two peers, OpenTelemetry and a hash library, are optional), so it
 * adds nothing to the supply chain beyond itself. `ioredis` is in maintenance mode and pulls six
 * dependencies.
 *
 * **Behaviour (and the failure scenarios it handles):**
 * - **Lazy:** nothing connects until the first command, so `node strut make:*` and other commands
 *   that never touch Redis work while it is down.
 * - **Fails fast while down:** the offline queue is off, so a command during an outage fails at
 *   once with the 503 `redis_unavailable` problem instead of piling up in memory. After a failed
 *   connect, new attempts wait `retryAfterMs` (a small circuit breaker), so a dead server doesn't
 *   make every request wait the full connect timeout.
 * - **Reconnects:** once connected, a dropped socket reconnects with capped, jittered backoff.
 * - **Bounded commands:** every command has a timeout (`REDIS_COMMAND_TIMEOUT`).
 * - **Login failures fail closed:** a wrong password or a missing ACL permission is
 *   `redis_unavailable` for the caller and an error in the log (never the password).
 * - **Graceful shutdown:** {@link RedisConnection.close} waits for pending replies, at most
 *   `closeTimeoutMs`, then drops the socket. Commands after close fail with `redis_unavailable`.
 * - **TLS** always verifies the certificate (system CAs, or `REDIS_TLS_CA`).
 *
 * Sentinel and cluster are not wired yet (see README, "Not built yet"): node-redis supports both,
 * and they will plug in behind the same {@link RedisDriver}.
 *
 * @module
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@redis/client'
import { BootError } from '@strutvane/framework'
import type { Logger } from '@strutvane/framework/contracts'
import { describeSettings, type RedisSettings } from './config.ts'
import type { LuaScript, RedisDriver } from './driver.ts'
import { redisUnavailable } from './errors.ts'

/**
 * The parts of a node-redis client this module uses (a seam for tests).
 *
 * @example
 * const client: RedisClientLike = createClient({ url })
 */
export interface RedisClientLike {
  connect(): Promise<unknown>
  sendCommand(args: readonly string[], options?: { readonly timeout?: number }): Promise<unknown>
  close(): Promise<void>
  destroy(): void
  readonly isOpen: boolean
  readonly isReady: boolean
  on(event: 'error', listener: (error: unknown) => void): unknown
}

/** The options node-redis gets (a subset of its `RedisClientOptions`). */
export interface RedisClientOptionsLike {
  readonly socket: Readonly<Record<string, unknown>>
  readonly username?: string
  readonly password?: string
  readonly database: number
  readonly disableOfflineQueue: boolean
}

/**
 * Options for {@link RedisConnection}.
 *
 * @example
 * new RedisConnection(settings, { logger: app.make(LoggerToken).child({ component: 'redis' }) })
 */
export interface RedisConnectionOptions {
  /** Where connection events go (never `console`). Omitted: silent. */
  readonly logger?: Logger
  /** How long {@link RedisConnection.close} waits for pending replies. Default 2000 ms. */
  readonly closeTimeoutMs?: number
  /** After a failed connect, fail fast for this long before trying again. Default 1000 ms. */
  readonly retryAfterMs?: number
  /** Build the client (tests). Default: node-redis `createClient`. */
  readonly createClient?: (options: RedisClientOptionsLike) => RedisClientLike
}

/** Server error prefixes that mean "you may not": wrong login or missing ACL permission. */
const AUTH_ERRORS = /^(WRONGPASS|NOAUTH|NOPERM)\b/
/** Client-side error names that mean "the server is not reachable right now". */
const UNREACHABLE = new Set([
  'ClientClosedError',
  'ClientOfflineError',
  'ConnectionTimeoutError',
  'SocketTimeoutError',
  'TimeoutError',
  'SocketClosedUnexpectedlyError',
  'DisconnectsClientError',
  'ReconnectStrategyError',
  'AbortError',
])

/**
 * One lazily opened connection, shared by every store of an app.
 *
 * @example
 * const redis = new RedisConnection(resolveRedisSettings({ env: process.env }))
 * await redis.command(['SET', 'k', 'v'])
 * await redis.close()
 */
export class RedisConnection implements RedisDriver {
  readonly settings: RedisSettings
  readonly #logger: Logger | undefined
  readonly #closeTimeoutMs: number
  readonly #retryAfterMs: number
  readonly #createClient: (options: RedisClientOptionsLike) => RedisClientLike
  #client: RedisClientLike | undefined
  #connecting: Promise<RedisClientLike> | undefined
  #everReady = false
  #closed = false
  #failedAt: number | undefined
  #down = false

  constructor(settings: RedisSettings, options: RedisConnectionOptions = {}) {
    this.settings = settings
    this.#logger = options.logger
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 2000
    this.#retryAfterMs = options.retryAfterMs ?? 1000
    this.#createClient =
      options.createClient ?? ((clientOptions) => createClient(clientOptions) as RedisClientLike)
  }

  /** Whether {@link RedisConnection.close} has been called. */
  get closed(): boolean {
    return this.#closed
  }

  async command(args: readonly string[]): Promise<unknown> {
    const client = await this.#ready()
    try {
      return await client.sendCommand(args, { timeout: this.settings.commandTimeoutMs })
    } catch (error) {
      throw this.#translate(error, args[0] ?? 'command')
    }
  }

  async script(
    script: LuaScript,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<unknown> {
    const tail = [String(keys.length), ...keys, ...args]
    try {
      return await this.command(['EVALSHA', script.sha1, ...tail])
    } catch (error) {
      // First use on this server (or after SCRIPT FLUSH / a failover): send the body once.
      if (error instanceof Error && error.message.startsWith('NOSCRIPT'))
        return this.command(['EVAL', script.source, ...tail])
      throw error
    }
  }

  async ping(): Promise<number> {
    const started = performance.now()
    await this.command(['PING'])
    return Math.max(0, Math.round((performance.now() - started) * 100) / 100)
  }

  /**
   * A health check for readiness probes: never throws.
   *
   * @example
   * const health = await redis.health() // { status: 'up', latency_ms: 0.4 }
   */
  async health(): Promise<
    | { readonly status: 'up'; readonly latency_ms: number }
    | { readonly status: 'down'; readonly error: string }
  > {
    try {
      return { status: 'up', latency_ms: await this.ping() }
    } catch (error) {
      const code = (error as { code?: unknown }).code
      return { status: 'down', error: typeof code === 'string' ? code : 'redis_unavailable' }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const pending = this.#connecting
    let client = this.#client
    if (client === undefined && pending !== undefined) client = await pending.catch(() => undefined)
    this.#client = undefined
    if (client === undefined || !client.isOpen) return
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.#closeTimeoutMs)
    })
    try {
      const outcome = await Promise.race([client.close().then(() => 'closed' as const), timedOut])
      if (outcome === 'timeout') {
        this.#logger?.warn('redis.close_timeout', { timeout_ms: this.#closeTimeoutMs })
        client.destroy()
      }
    } catch {
      client.destroy()
    } finally {
      clearTimeout(timer)
    }
    this.#logger?.debug('redis.closed')
  }

  async #ready(): Promise<RedisClientLike> {
    if (this.#closed) throw redisUnavailable('closed')
    const client = this.#client
    if (client?.isReady === true) return client
    if (client?.isOpen === true) {
      // Open but reconnecting: fail fast instead of queueing (the offline queue is off).
      throw redisUnavailable('reconnecting')
    }
    if (this.#connecting !== undefined) return this.#connecting
    if (this.#failedAt !== undefined && Date.now() - this.#failedAt < this.#retryAfterMs)
      throw redisUnavailable('connect')
    this.#connecting = this.#open().finally(() => {
      this.#connecting = undefined
    })
    return this.#connecting
  }

  async #open(): Promise<RedisClientLike> {
    const client = this.#createClient(this.#clientOptions())
    client.on('error', (error) => this.#onError(error))
    try {
      await client.connect()
    } catch (error) {
      this.#failedAt = Date.now()
      try {
        client.destroy()
      } catch {
        // Already closed by the failed connect; nothing left to release.
      }
      this.#markDown(error)
      throw this.#translate(error, 'connect')
    }
    if (this.#closed) {
      // close() ran while we were connecting: don't leak the socket.
      client.destroy()
      throw redisUnavailable('closed')
    }
    this.#client = client
    this.#everReady = true
    this.#failedAt = undefined
    if (this.#down) this.#logger?.info('redis.reconnected', describeSettings(this.settings))
    else this.#logger?.debug('redis.connected', describeSettings(this.settings))
    this.#down = false
    return client
  }

  #clientOptions(): RedisClientOptionsLike {
    const s = this.settings
    const socket: Record<string, unknown> = {
      host: s.host,
      port: s.port,
      connectTimeout: s.connectTimeoutMs,
      // Before the first successful connect, don't retry inside node-redis: the caller gets a
      // fast 503 and the next call tries again (after retryAfterMs). Once connected, a dropped
      // socket reconnects with capped, jittered backoff.
      reconnectStrategy: (retries: number, cause: Error): number | Error =>
        this.#everReady && !this.#closed
          ? Math.min(2000, 50 * 2 ** Math.min(retries, 6)) + Math.floor(Math.random() * 50)
          : cause,
    }
    if (s.tls) {
      socket['tls'] = true
      socket['rejectUnauthorized'] = true
      if (s.tlsServername !== undefined) socket['servername'] = s.tlsServername
      if (s.tlsCaFile !== undefined) socket['ca'] = readCa(s.tlsCaFile)
    }
    return {
      socket,
      ...(s.username === undefined ? {} : { username: s.username }),
      ...(s.password === undefined ? {} : { password: s.password }),
      database: s.database,
      disableOfflineQueue: true,
    }
  }

  #onError(error: unknown): void {
    // node-redis emits every socket problem here; without a listener it would crash the process.
    this.#markDown(error)
  }

  #markDown(error: unknown): void {
    if (this.#down) return
    this.#down = true
    this.#logger?.error('redis.unavailable', {
      ...describeSettings(this.settings),
      reason: reasonOf(error),
    })
  }

  #translate(error: unknown, operation: string): unknown {
    if (!(error instanceof Error)) return redisUnavailable(operation, error)
    if (AUTH_ERRORS.test(error.message)) {
      this.#logger?.error('redis.access_denied', {
        ...describeSettings(this.settings),
        reason: error.message.split(' ')[0],
      })
      return redisUnavailable(operation, error)
    }
    const code = (error as { code?: unknown }).code
    if (
      UNREACHABLE.has(error.name) ||
      (typeof code === 'string' && /^E[A-Z]+$/.test(code)) ||
      /certificate|self[- ]signed|TLS|SSL/i.test(error.message)
    )
      return redisUnavailable(operation, error)
    // A server error reply (WRONGTYPE, a script error): a bug in the caller, so it stays loud.
    return error
  }
}

function readCa(path: string): Buffer {
  try {
    return readFileSync(path)
  } catch {
    throw new BootError(
      'invalid_redis_config',
      `REDIS_TLS_CA points to a file that can't be read (${path}).`,
      'Set REDIS_TLS_CA to the path of the PEM file with your CA certificate, or remove it to use the system CAs.',
    )
  }
}

/** A short, secret-free reason for the log. */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown'
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  return error.name === 'Error' ? (error.message.split(' ')[0] ?? 'Error') : error.name
}
