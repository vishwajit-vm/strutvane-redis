/**
 * Sessions in Redis: the framework's `SessionStore` (`flush`, for `node strut session:flush`) plus
 * the read / write / touch / destroy operations a session driver needs.
 *
 * - **Session ids never reach Redis in clear text.** The key is the SHA-256 of the id, so a dump,
 *   a replica, `MONITOR` or a slow log never reveals a usable session cookie.
 * - **Ids are checked:** 22 to 256 characters of `A-Z a-z 0-9 _ -` (at least 128 bits of a
 *   base64url id). Anything else is refused before Redis is asked, so a forged cookie can't
 *   probe keys.
 * - **Bounded:** a session over `maxBytes` (default 256 KiB) is refused instead of stored, so a
 *   bug or an attacker can't fill the server through one session.
 * - **Idle expiry** is Redis's TTL: `write` and `touch` reset it to `SESSION_LIFETIME`.
 *
 * Sessions belong to `@strutvane/auth`. It can use this store through the framework's session
 * contract once that contract has these operations (see NEXT.md, framework proposals); until then
 * the provider binds it under the framework's `SessionStoreToken` (`flush`) when
 * `SESSION_DRIVER=redis`.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import type { SessionStore } from '@strutvane/framework'
import { asInteger, asNullableString, deleteMatching, type RedisDriver } from './driver.ts'
import type { KeySpace } from './keys.ts'

const SESSION_ID = /^[A-Za-z0-9_-]{22,256}$/

/**
 * Options for {@link RedisSessionStore}.
 *
 * @example
 * new RedisSessionStore({ driver: redis, space: KeySpace.root('blog:prod:').area('session'), lifetimeSeconds: 7200 })
 */
export interface RedisSessionStoreOptions {
  readonly driver: RedisDriver
  readonly space: KeySpace
  /** Idle lifetime (`SESSION_LIFETIME` minutes × 60). Default 7200 s. */
  readonly lifetimeSeconds?: number
  /** The largest session accepted, in bytes of JSON. Default 256 KiB. */
  readonly maxBytes?: number
}

/**
 * A session store in Redis.
 *
 * @example
 * await sessions.write(id, { userId: 7 })
 * const data = await sessions.read(id) // { userId: 7 }
 */
export class RedisSessionStore implements SessionStore {
  readonly #driver: RedisDriver
  readonly #space: KeySpace
  readonly #lifetimeMs: number
  readonly #maxBytes: number

  constructor(options: RedisSessionStoreOptions) {
    const lifetime = options.lifetimeSeconds ?? 7200
    const maxBytes = options.maxBytes ?? 256 * 1024
    if (!Number.isSafeInteger(lifetime) || lifetime < 1)
      throw new RangeError('The session lifetime must be a whole number of seconds, at least 1.')
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new RangeError('The session size limit must be a whole number of bytes, at least 1.')
    this.#driver = options.driver
    this.#space = options.space
    this.#lifetimeMs = lifetime * 1000
    this.#maxBytes = maxBytes
  }

  /**
   * The session's data, or `undefined` when it doesn't exist, expired, or the id is malformed.
   *
   * @example
   * const data = await sessions.read(cookieValue)
   */
  async read(id: string): Promise<Record<string, unknown> | undefined> {
    const key = this.#key(id)
    if (key === undefined) return undefined
    const raw = asNullableString(await this.#driver.command(['GET', key]))
    if (raw === null) return undefined
    try {
      const parsed: unknown = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Store the session's data and reset its idle expiry. Throws a `TypeError` for a malformed id and
   * a `RangeError` for data over the size limit.
   *
   * @example
   * await sessions.write(id, { userId: 7, csrf: token })
   */
  async write(id: string, data: Readonly<Record<string, unknown>>): Promise<void> {
    const key = this.#key(id)
    if (key === undefined) throw new TypeError('Refusing to write a session with a malformed id.')
    const encoded = JSON.stringify(data)
    if (Buffer.byteLength(encoded, 'utf8') > this.#maxBytes)
      throw new RangeError(
        `The session is larger than ${this.#maxBytes} bytes; keep large data in the database and its id in the session.`,
      )
    await this.#driver.command(['SET', key, encoded, 'PX', String(this.#lifetimeMs)])
  }

  /**
   * Reset the idle expiry without rewriting the data; `false` when the session is gone.
   *
   * @example
   * await sessions.touch(id)
   */
  async touch(id: string): Promise<boolean> {
    const key = this.#key(id)
    if (key === undefined) return false
    return asInteger(await this.#driver.command(['PEXPIRE', key, String(this.#lifetimeMs)])) === 1
  }

  /**
   * Remove one session (sign-out, id rotation); `true` when it existed.
   *
   * @example
   * await sessions.destroy(oldId)
   */
  async destroy(id: string): Promise<boolean> {
    const key = this.#key(id)
    if (key === undefined) return false
    return asInteger(await this.#driver.command(['UNLINK', key])) > 0
  }

  /** Remove every session of this app; returns how many were removed. */
  async flush(): Promise<number> {
    return deleteMatching(this.#driver, this.#space.pattern())
  }

  #key(id: string): string | undefined {
    if (typeof id !== 'string' || !SESSION_ID.test(id)) return undefined
    return this.#space.key(createHash('sha256').update(id).digest('hex'))
  }
}
