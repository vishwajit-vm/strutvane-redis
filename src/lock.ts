/**
 * Atomic locks (Laravel's `Cache::lock`): only one process at a time may hold a named lock.
 *
 * **How:** acquiring is `SET key <owner> NX PX <ttl>`: Redis guarantees only one caller creates
 * the key. The owner is a random 128-bit token, and releasing or extending runs a Lua script that
 * checks the token first, so:
 *
 * - a process can never release a lock someone else holds (for example after its own lock expired
 *   and another process took it), the classic "unsafe DEL" bug;
 * - a crashed holder never blocks forever: every lock expires after its TTL;
 * - a long job can {@link RedisLock.extend} its lock while it still owns it.
 *
 * Another process can release a lock it was handed the owner token of
 * (`locks.restore(name, owner)`), as Laravel does for queued jobs.
 *
 * This is a single-instance lock (one Redis primary). It is not Redlock: during a primary
 * failover, a lock written to the old primary may be lost before it replicated. Use it to avoid
 * duplicate work, not as the only guard for correctness-critical money movements; those belong in a
 * database transaction.
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { asInteger, defineLua, type RedisDriver } from './driver.ts'
import { lockTimeout } from './errors.ts'
import type { KeySpace } from './keys.ts'

const RELEASE = defineLua(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`)

const EXTEND = defineLua(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`)

const OWNER = /^[A-Za-z0-9_-]{16,128}$/

/**
 * Creates and restores locks in one key space.
 *
 * @example
 * const locks = new RedisLocks({ driver: redis, space: KeySpace.root('blog:').area('lock') })
 * await locks.create('reports:build', 120).block(10, () => buildReports())
 */
export class RedisLocks {
  readonly #driver: RedisDriver
  readonly #space: KeySpace

  constructor(options: { readonly driver: RedisDriver; readonly space: KeySpace }) {
    this.#driver = options.driver
    this.#space = options.space
  }

  /**
   * The same locks, scoped to one tenant (tenant A's `import` lock never blocks tenant B's).
   *
   * @example
   * locks.forTenant('acme').create('import', 60)
   */
  forTenant(tenantId: string): RedisLocks {
    return new RedisLocks({ driver: this.#driver, space: this.#space.tenant(tenantId) })
  }

  /**
   * A lock handle (not acquired yet) that expires `seconds` after it is acquired.
   *
   * @example
   * const lock = locks.create('invoices:send', 30)
   * if (await lock.acquire()) try { … } finally { await lock.release() }
   */
  create(name: string, seconds: number, owner?: string): RedisLock {
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw new RangeError(
        'A lock needs a lifetime in seconds above 0 (it expires if its holder crashes).',
      )
    if (owner !== undefined && !OWNER.test(owner))
      throw new TypeError('A lock owner must be 16 to 128 characters of A-Z, a-z, 0-9, _ or -.')
    return new RedisLock(
      this.#driver,
      name,
      this.#space.key(name),
      Math.max(1, Math.round(seconds * 1000)),
      owner ?? randomBytes(16).toString('base64url'),
    )
  }

  /**
   * A handle for a lock acquired elsewhere (another process) with a known owner token, so it can
   * be released or extended here.
   *
   * @example
   * await locks.restore('invoices:send', job.lockOwner).release()
   */
  restore(name: string, owner: string): RedisLock {
    return this.create(name, 1, owner)
  }
}

/**
 * One named lock and this handle's owner token.
 *
 * @example
 * const lock = locks.create('export', 60)
 * await lock.block(5, () => runExport())
 */
export class RedisLock {
  /** The lock's name (the caller's, without prefix). */
  readonly name: string
  /** This handle's owner token: pass it to another process to release the lock there. */
  readonly owner: string
  readonly #driver: RedisDriver
  readonly #key: string
  readonly #ttlMs: number

  /** @internal Use {@link RedisLocks.create}. */
  constructor(driver: RedisDriver, name: string, key: string, ttlMs: number, owner: string) {
    this.#driver = driver
    this.name = name
    this.#key = key
    this.#ttlMs = ttlMs
    this.owner = owner
  }

  /**
   * Try once; `true` when this handle now holds the lock. Re-acquiring a lock this owner already
   * holds is `false` (locks are not re-entrant).
   *
   * @example
   * if (await lock.acquire()) { … }
   */
  async acquire(): Promise<boolean> {
    const reply = await this.#driver.command([
      'SET',
      this.#key,
      this.owner,
      'NX',
      'PX',
      String(this.#ttlMs),
    ])
    return reply !== null && reply !== undefined
  }

  /**
   * Wait up to `seconds` for the lock (polling with jittered backoff), then, when `work` is given,
   * run it and always release afterwards. Throws the 503 `lock_timeout` problem when the wait
   * runs out.
   *
   * @example
   * const total = await lock.block(5, () => recalculate())
   */
  async block<TResult>(
    seconds: number,
    work?: () => TResult | Promise<TResult>,
  ): Promise<TResult | undefined> {
    const deadline = Date.now() + Math.max(0, seconds) * 1000
    for (let attempt = 0; ; attempt++) {
      if (await this.acquire()) break
      const left = deadline - Date.now()
      if (left <= 0) throw lockTimeout(this.name, seconds)
      await sleep(
        Math.min(left, Math.min(250, 10 * 2 ** Math.min(attempt, 5)) + Math.random() * 10),
      )
    }
    if (work === undefined) return undefined
    try {
      return await work()
    } finally {
      await this.release()
    }
  }

  /**
   * Run `work` only if the lock is free right now (no waiting); `undefined` when it was taken.
   *
   * @example
   * await lock.run(() => sendDigest()) // skipped if another worker is sending it
   */
  async run<TResult>(work: () => TResult | Promise<TResult>): Promise<TResult | undefined> {
    if (!(await this.acquire())) return undefined
    try {
      return await work()
    } finally {
      await this.release()
    }
  }

  /**
   * Release the lock if this owner still holds it; `false` when it had expired or belongs to
   * someone else (nothing is removed then).
   *
   * @example
   * await lock.release()
   */
  async release(): Promise<boolean> {
    return asInteger(await this.#driver.script(RELEASE, [this.#key], [this.owner])) === 1
  }

  /**
   * Reset the lifetime to `seconds` from now if this owner still holds the lock.
   *
   * @example
   * await lock.extend(60) // a long import keeps its lock
   */
  async extend(seconds: number): Promise<boolean> {
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw new RangeError('extend() needs seconds above 0.')
    const ms = String(Math.max(1, Math.round(seconds * 1000)))
    return asInteger(await this.#driver.script(EXTEND, [this.#key], [this.owner, ms])) === 1
  }

  /**
   * Remove the lock whoever holds it (an operator's escape hatch).
   *
   * @example
   * await locks.create('stuck-job', 1).forceRelease()
   */
  async forceRelease(): Promise<void> {
    await this.#driver.command(['UNLINK', this.#key])
  }

  /**
   * Whether this owner holds the lock right now.
   *
   * @example
   * if (!(await lock.isOwned())) throw new Error('lost the lock')
   */
  async isOwned(): Promise<boolean> {
    return (await this.#driver.command(['GET', this.#key])) === this.owner
  }
}
