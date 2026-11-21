/**
 * The narrow seam between this package's stores and a Redis client: one command, one Lua script,
 * a ping and a close. Every store (cache, locks, sessions, rate limits, queue) is written against
 * {@link RedisDriver}, never against the client library, so:
 *
 * - the client can be swapped (node-redis today, see `connection.ts`) without touching the stores;
 * - every multi-step operation is a Lua script, which Redis and Valkey run atomically: no other
 *   command interleaves, so "check then set" races can't happen;
 * - replies are `unknown` and narrowed by the helpers below, so a surprising reply (a server bug,
 *   a proxy, a different engine) fails loudly instead of being mis-typed.
 *
 * @module
 */
import { createHash } from 'node:crypto'

/**
 * A Lua script with its SHA-1, for `EVALSHA` (the script body is sent only once per server).
 *
 * @example
 * const GET_DEL = defineLua("local v = redis.call('GET', KEYS[1]) redis.call('DEL', KEYS[1]) return v")
 */
export interface LuaScript {
  readonly source: string
  readonly sha1: string
}

/**
 * Define a Lua script.
 *
 * @example
 * const script = defineLua("return redis.call('GET', KEYS[1])")
 */
export function defineLua(source: string): LuaScript {
  return Object.freeze({ source, sha1: createHash('sha1').update(source).digest('hex') })
}

/**
 * What the stores need from a Redis connection.
 *
 * @example
 * const value = await driver.command(['GET', 'blog:prod:cache:posts'])
 */
export interface RedisDriver {
  /** Run one command. Errors are the 503 `redis_unavailable` problem when the server is unreachable. */
  command(args: readonly string[]): Promise<unknown>
  /** Run a Lua script atomically (`EVALSHA`, loading it with `EVAL` on `NOSCRIPT`). */
  script(script: LuaScript, keys: readonly string[], args: readonly string[]): Promise<unknown>
  /** Round-trip time of a `PING`, in milliseconds. */
  ping(): Promise<number>
  /** Close the connection gracefully (pending replies are awaited, bounded by a timeout). */
  close(): Promise<void>
}

/**
 * Narrow a reply to a string or `null` (bulk string or nil). Numbers become strings.
 *
 * @example
 * asNullableString(await driver.command(['GET', key]))
 */
export function asNullableString(reply: unknown): string | null {
  if (reply === null || reply === undefined) return null
  if (typeof reply === 'string') return reply
  if (typeof reply === 'number' || typeof reply === 'bigint') return String(reply)
  if (Buffer.isBuffer(reply)) return reply.toString('utf8')
  throw unexpected('a string', reply)
}

/**
 * Narrow a reply to a safe integer (integer reply, or a numeric string from Lua).
 *
 * @example
 * asInteger(await driver.command(['PTTL', key]))
 */
export function asInteger(reply: unknown): number {
  const value =
    typeof reply === 'bigint' ? Number(reply) : typeof reply === 'string' ? Number(reply) : reply
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw unexpected('an integer', reply)
}

/**
 * Narrow a reply to an array.
 *
 * @example
 * const [cursor, keys] = asArray(await driver.command(['SCAN', '0']))
 */
export function asArray(reply: unknown): readonly unknown[] {
  if (Array.isArray(reply)) return reply
  throw unexpected('an array', reply)
}

function unexpected(expected: string, reply: unknown): TypeError {
  const kind = reply === null ? 'null' : Array.isArray(reply) ? 'array' : typeof reply
  return new TypeError(`Redis replied with ${kind} where ${expected} was expected.`)
}

/**
 * Delete every key matching a `SCAN` pattern, in batches (`UNLINK`, so large values are freed in
 * the background). Never `FLUSHDB`: other apps may share the database. Returns how many keys were
 * removed.
 *
 * @example
 * await deleteMatching(driver, space.pattern())
 */
export async function deleteMatching(
  driver: RedisDriver,
  pattern: string,
  batch = 500,
): Promise<number> {
  let cursor = '0'
  let removed = 0
  do {
    const [next, keys] = asArray(
      await driver.command(['SCAN', cursor, 'MATCH', pattern, 'COUNT', String(batch)]),
    )
    cursor = asNullableString(next) ?? '0'
    const found = asArray(keys).map((key) => asNullableString(key) ?? '')
    if (found.length > 0) removed += asInteger(await driver.command(['UNLINK', ...found]))
  } while (cursor !== '0')
  return removed
}
