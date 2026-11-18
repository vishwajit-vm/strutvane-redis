/**
 * `Idempotency-Key` storage in Redis: the framework's `IdempotencyStore`, shared by every process
 * so a retried request is replayed (not run twice) whichever server it reaches.
 *
 * Each claim is a hash `{ f: fingerprint, r: stored response }`:
 * - `begin` is one Lua script (`HSETNX` + expiry, else read the hash), so two parallel first
 *   requests with the same key can't both run;
 * - `complete` stores the response only while the claim still exists (a released or expired claim
 *   is not resurrected) and restarts the 24-hour replay window;
 * - an unfinished claim expires too, so a crashed request can't block its key forever.
 *
 * The framework's key already scopes claims to the caller; it is hashed (SHA-256) before it
 * reaches Redis, so actor ids and keys don't show up in dumps.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import {
  type BeginOutcome,
  IDEMPOTENCY_TTL_MS,
  type IdempotencyStore,
  type StoredResponse,
} from '@strutvane/framework'
import { asArray, asNullableString, defineLua, type RedisDriver } from './driver.ts'
import type { KeySpace } from './keys.ts'

const BEGIN = defineLua(`
if redis.call('HSETNX', KEYS[1], 'f', ARGV[1]) == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return {}
end
return redis.call('HMGET', KEYS[1], 'f', 'r')
`)

const COMPLETE = defineLua(`
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'r', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`)

/**
 * The idempotency store in Redis.
 *
 * @example
 * app.container.value(IdempotencyStoreToken, new RedisIdempotencyStore({ driver: redis, space }))
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  readonly #driver: RedisDriver
  readonly #space: KeySpace
  readonly #ttlMs: number

  constructor(options: {
    readonly driver: RedisDriver
    readonly space: KeySpace
    /** How long a claim and its response live. Default 24 h (the framework's). */
    readonly ttlMs?: number
  }) {
    const ttl = options.ttlMs ?? IDEMPOTENCY_TTL_MS
    if (!Number.isSafeInteger(ttl) || ttl < 1)
      throw new RangeError('idempotency ttlMs must be a positive integer')
    this.#driver = options.driver
    this.#space = options.space
    this.#ttlMs = ttl
  }

  async begin(key: string, fingerprint: string, _now: number): Promise<BeginOutcome> {
    const reply = asArray(
      await this.#driver.script(BEGIN, [this.#key(key)], [fingerprint, String(this.#ttlMs)]),
    )
    if (reply.length === 0) return { kind: 'new' }
    const stored = asNullableString(reply[0])
    if (stored !== fingerprint) return { kind: 'mismatch' }
    const response = parseResponse(asNullableString(reply[1] ?? null))
    return response === undefined ? { kind: 'in_progress' } : { kind: 'replay', response }
  }

  async complete(key: string, response: StoredResponse, _now: number): Promise<void> {
    await this.#driver.script(
      COMPLETE,
      [this.#key(key)],
      [JSON.stringify(response), String(this.#ttlMs)],
    )
  }

  async release(key: string): Promise<void> {
    await this.#driver.command(['UNLINK', this.#key(key)])
  }

  #key(key: string): string {
    return this.#space.key(createHash('sha256').update(key).digest('hex'))
  }
}

function parseResponse(raw: string | null): StoredResponse | undefined {
  if (raw === null) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const { status, headers, body } = value as Record<string, unknown>
    if (typeof status !== 'number' || typeof body !== 'string' || !Array.isArray(headers))
      return undefined
    const pairs = headers.filter(
      (pair): pair is [string, string] =>
        Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string',
    )
    return { status, headers: pairs, body }
  } catch {
    return undefined
  }
}
