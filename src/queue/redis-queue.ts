/**
 * **Experimental.** A Redis implementation of the proposed {@link QueueDriver}, laid out like
 * Laravel's Redis queue:
 *
 * - `<prefix>queue:<name>`: a list of waiting jobs;
 * - `<prefix>queue:<name>:delayed`: a sorted set of delayed jobs, scored by when they are due;
 * - `<prefix>queue:<name>:reserved`: a sorted set of reserved jobs, scored by when the
 *   reservation runs out.
 *
 * `pop` is one Lua script: it moves due delayed jobs and expired reservations back to the list,
 * then reserves the head, so two workers never get the same job, and a crashed worker's job comes
 * back by itself. Time is the server's (`TIME`), so workers with skewed clocks agree.
 *
 * Polling only (no `BLPOP`): a blocking pop would hold the app's shared connection. The framework's
 * future worker decides how often to poll.
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { asArray, asInteger, asNullableString, defineLua, type RedisDriver } from '../driver.ts'
import type { KeySpace } from '../keys.ts'
import type { PushOptions, QueueDriver, ReservedJob } from './contract.ts'

const QUEUE_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const MAX_PAYLOAD_BYTES = 1024 * 1024

const PUSH_DELAYED = defineLua(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
return 1
`)

const POP = defineLua(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
for _, set in ipairs({KEYS[2], KEYS[3]}) do
  local due = redis.call('ZRANGEBYSCORE', set, '-inf', now, 'LIMIT', 0, 100)
  for _, job in ipairs(due) do
    redis.call('ZREM', set, job)
    redis.call('RPUSH', KEYS[1], job)
  end
end
local job = redis.call('LPOP', KEYS[1])
if not job then return false end
local decoded = cjson.decode(job)
decoded['attempts'] = (tonumber(decoded['attempts']) or 0) + 1
local reserved = cjson.encode(decoded)
local until_ms = now + tonumber(ARGV[1])
redis.call('ZADD', KEYS[3], until_ms, reserved)
return {reserved, tostring(until_ms)}
`)

const RELEASE = defineLua(`
if redis.call('ZREM', KEYS[2], ARGV[1]) == 0 then return 0 end
if tonumber(ARGV[2]) <= 0 then
  redis.call('RPUSH', KEYS[1], ARGV[1])
else
  local t = redis.call('TIME')
  local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  redis.call('ZADD', KEYS[3], now + tonumber(ARGV[2]), ARGV[1])
end
return 1
`)

interface Envelope {
  readonly id: string
  readonly attempts: number
  readonly payload: string
}

/**
 * The Redis queue driver.
 *
 * @experimental
 * @example
 * const queue = new RedisQueueDriver({ driver: redis, space: KeySpace.root('blog:prod:').area('queue') })
 * await queue.push('emails', JSON.stringify({ to: 'a@example.com' }))
 */
export class RedisQueueDriver implements QueueDriver {
  readonly #driver: RedisDriver
  readonly #space: KeySpace
  readonly #visibilityMs: number

  constructor(options: {
    readonly driver: RedisDriver
    readonly space: KeySpace
    /** Default reservation length. Default 90 s (Laravel's `retry_after`). */
    readonly visibilitySeconds?: number
  }) {
    this.#driver = options.driver
    this.#space = options.space
    this.#visibilityMs = seconds(options.visibilitySeconds ?? 90, 'visibilitySeconds')
  }

  async push(queue: string, payload: string, options: PushOptions = {}): Promise<string> {
    const keys = this.#keys(queue)
    if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES)
      throw new RangeError(`A job payload must be a string of at most ${MAX_PAYLOAD_BYTES} bytes.`)
    const id = randomBytes(12).toString('base64url')
    const envelope = JSON.stringify({ id, attempts: 0, payload } satisfies Envelope)
    const delayMs =
      options.delaySeconds === undefined ? 0 : seconds(options.delaySeconds, 'delaySeconds', true)
    if (delayMs > 0)
      await this.#driver.script(PUSH_DELAYED, [keys.delayed], [envelope, String(delayMs)])
    else await this.#driver.command(['RPUSH', keys.ready, envelope])
    return id
  }

  async pop(
    queue: string,
    options: { readonly visibilitySeconds?: number } = {},
  ): Promise<ReservedJob | undefined> {
    const keys = this.#keys(queue)
    const visibility =
      options.visibilitySeconds === undefined
        ? this.#visibilityMs
        : seconds(options.visibilitySeconds, 'visibilitySeconds')
    const reply = await this.#driver.script(
      POP,
      [keys.ready, keys.delayed, keys.reserved],
      [String(visibility)],
    )
    if (reply === null || reply === undefined) return undefined
    const [receiptReply, untilReply] = asArray(reply)
    const receipt = asNullableString(receiptReply)
    if (receipt === null) return undefined
    const envelope = parseEnvelope(receipt)
    return {
      id: envelope.id,
      queue,
      payload: envelope.payload,
      attempts: envelope.attempts,
      reservedUntil: asInteger(untilReply),
      receipt,
    }
  }

  async ack(job: ReservedJob): Promise<boolean> {
    const keys = this.#keys(job.queue)
    return asInteger(await this.#driver.command(['ZREM', keys.reserved, job.receipt])) === 1
  }

  async release(job: ReservedJob, delaySeconds = 0): Promise<boolean> {
    const keys = this.#keys(job.queue)
    const delayMs = seconds(delaySeconds, 'delaySeconds', true)
    return (
      asInteger(
        await this.#driver.script(
          RELEASE,
          [keys.ready, keys.reserved, keys.delayed],
          [job.receipt, String(delayMs)],
        ),
      ) === 1
    )
  }

  async size(queue: string): Promise<number> {
    const keys = this.#keys(queue)
    const [ready, delayed, reserved] = await Promise.all([
      this.#driver.command(['LLEN', keys.ready]),
      this.#driver.command(['ZCARD', keys.delayed]),
      this.#driver.command(['ZCARD', keys.reserved]),
    ])
    return asInteger(ready) + asInteger(delayed) + asInteger(reserved)
  }

  async clear(queue: string): Promise<number> {
    const size = await this.size(queue)
    const keys = this.#keys(queue)
    await this.#driver.command(['UNLINK', keys.ready, keys.delayed, keys.reserved])
    return size
  }

  #keys(queue: string): {
    readonly ready: string
    readonly delayed: string
    readonly reserved: string
  } {
    if (!QUEUE_NAME.test(queue))
      throw new TypeError(
        'A queue name may only contain letters, digits, _ . and - (1 to 64 characters).',
      )
    const ready = this.#space.key(queue)
    return { ready, delayed: `${ready}:delayed`, reserved: `${ready}:reserved` }
  }
}

function seconds(value: number, name: string, allowZero = false): number {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0))
    throw new RangeError(
      `${name} must be a number of seconds ${allowZero ? '(0 or more)' : 'above 0'}.`,
    )
  return Math.round(value * 1000)
}

function parseEnvelope(raw: string): Envelope {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null) throw new TypeError('A queued job is corrupt.')
  const { id, attempts, payload } = value as Record<string, unknown>
  if (typeof id !== 'string' || typeof payload !== 'string' || typeof attempts !== 'number')
    throw new TypeError('A queued job is corrupt.')
  return { id, attempts, payload }
}
