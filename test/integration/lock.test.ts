import { setTimeout as sleep } from 'node:timers/promises'
import { StrutvaneError } from '@strutvane/framework/core'
import { afterAll, describe, expect, it } from 'vitest'
import { RedisLocks } from '../../src/lock.ts'
import { closeAll, connect, skip, space, title } from '../support/redis.ts'

afterAll(closeAll)

describe.skipIf(skip)(title('RedisLocks'), () => {
  const locksOn = (driver = connect(), root = space()): RedisLocks =>
    new RedisLocks({ driver, space: root.area('lock') })

  it('only one of many parallel contenders (on separate connections) gets the lock', async () => {
    const root = space()
    const contenders = Array.from({ length: 20 }, () => locksOn(connect(), root).create('job', 10))
    const won = await Promise.all(contenders.map((lock) => lock.acquire()))
    expect(won.filter(Boolean)).toHaveLength(1)
    const winner = contenders[won.indexOf(true)]
    expect(await winner?.isOwned()).toBe(true)
    expect(await winner?.release()).toBe(true)
    expect(await contenders[(won.indexOf(true) + 1) % 20]?.acquire()).toBe(true)
  })

  it('serialises read-modify-write sections across connections (mutual exclusion)', async () => {
    const root = space()
    const redis = connect()
    const counter = `${root.prefix}counter`
    await redis.command(['SET', counter, '0'])
    const worker = async (): Promise<void> => {
      const locks = locksOn(connect(), root)
      for (let i = 0; i < 5; i++) {
        await locks.create('counter', 5).block(20, async () => {
          const value = Number(await redis.command(['GET', counter]))
          await sleep(2) // widen the race window: without the lock, updates would be lost
          await redis.command(['SET', counter, String(value + 1)])
        })
      }
    }
    await Promise.all(Array.from({ length: 8 }, worker))
    expect(await redis.command(['GET', counter])).toBe('40')
  })

  it('never releases or extends a lock held by someone else', async () => {
    const locks = locksOn()
    const a = locks.create('report', 0.2)
    expect(await a.acquire()).toBe(true)
    await sleep(300) // a's lock expired
    const b = locks.create('report', 10)
    expect(await b.acquire()).toBe(true)
    expect(await a.release()).toBe(false) // the unsafe-DEL bug: must not delete b's lock
    expect(await a.extend(10)).toBe(false)
    expect(await b.isOwned()).toBe(true)
    expect(await a.isOwned()).toBe(false)
    expect(await b.extend(30)).toBe(true)
    expect(await b.release()).toBe(true)
  })

  it('is not re-entrant, and acquire after release works', async () => {
    const lock = locksOn().create('once', 10)
    expect(await lock.acquire()).toBe(true)
    expect(await lock.acquire()).toBe(false)
    expect(await lock.release()).toBe(true)
    expect(await lock.acquire()).toBe(true)
    await lock.forceRelease()
  })

  it('block() waits for the holder and throws lock_timeout when time runs out', async () => {
    const locks = locksOn()
    const holder = locks.create('busy', 10)
    await holder.acquire()
    const waiter = locks.create('busy', 10)
    const error = await waiter.block(0.2).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StrutvaneError)
    expect((error as StrutvaneError).code).toBe('lock_timeout')
    expect((error as StrutvaneError).status).toBe(503)
    setTimeout(() => void holder.release(), 100)
    expect(await waiter.block(5, () => 'ran')).toBe('ran')
    expect(await waiter.isOwned()).toBe(false) // released after the work
    expect(await locks.create('free', 5).block(1)).toBeUndefined()
  })

  it('releases even when the work throws, and run() skips when taken', async () => {
    const locks = locksOn()
    const lock = locks.create('throws', 10)
    await expect(
      lock.block(1, () => {
        throw new Error('work failed')
      }),
    ).rejects.toThrow('work failed')
    expect(await lock.acquire()).toBe(true)
    expect(await locks.create('throws', 10).run(() => 'never')).toBeUndefined()
    await lock.release()
    expect(await locks.create('throws', 10).run(() => 'ran')).toBe('ran')
  })

  it('another process can release with the owner token (restore)', async () => {
    const root = space()
    const lock = locksOn(connect(), root).create('handoff', 30)
    await lock.acquire()
    const elsewhere = locksOn(connect(), root)
    expect(await elsewhere.create('handoff', 30).release()).toBe(false) // a different owner
    expect(await elsewhere.restore('handoff', lock.owner).release()).toBe(true)
  })

  it('a crashed holder never blocks forever: the lock expires', async () => {
    const locks = locksOn()
    await locks.create('crash', 0.15).acquire()
    expect(await locks.create('crash', 10).block(2, () => 'recovered')).toBe('recovered')
  })

  it('tenants have separate locks', async () => {
    const locks = locksOn()
    expect(await locks.forTenant('acme').create('import', 10).acquire()).toBe(true)
    expect(await locks.forTenant('globex').create('import', 10).acquire()).toBe(true)
    expect(await locks.forTenant('acme').create('import', 10).acquire()).toBe(false)
  })

  it('validates lifetimes and owners', () => {
    const locks = locksOn()
    expect(() => locks.create('x', 0)).toThrow(RangeError)
    expect(() => locks.create('x', Number.NaN)).toThrow(RangeError)
    expect(() => locks.create('x', 1, 'short')).toThrow(TypeError)
    expect(() => locks.create('x', 1, 'has spaces in it!!')).toThrow(TypeError)
    expect(() => locks.restore('x', 'bad owner')).toThrow(TypeError)
    return expect(locks.create('x', 1).extend(0)).rejects.toThrow(RangeError)
  })
})
