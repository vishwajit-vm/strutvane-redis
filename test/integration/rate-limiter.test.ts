import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { RedisRateLimiter } from '../../src/rate-limiter.ts'
import { closeAll, connect, skip, space, title } from '../support/redis.ts'

afterAll(closeAll)

describe.skipIf(skip)(title('RedisRateLimiter'), () => {
  for (const algorithm of ['fixed', 'sliding'] as const) {
    it(`${algorithm}: exactly max of 100 parallel hits from several servers are allowed`, async () => {
      const root = space()
      const servers = Array.from(
        { length: 4 },
        () => new RedisRateLimiter({ driver: connect(), space: root.area('rate') }),
      )
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          servers[i % 4]?.hit('login:a@example.com', { max: 10, windowSeconds: 60, algorithm }),
        ),
      )
      const allowed = results.filter((result) => result?.allowed)
      expect(allowed).toHaveLength(10)
      const refused = results.find((result) => result?.allowed === false)
      expect(refused?.remaining).toBe(0)
      expect(refused?.limit).toBe(10)
      expect(refused?.retryAfterSeconds).toBeGreaterThan(0)
      expect(refused?.retryAfterSeconds).toBeLessThanOrEqual(60)
    })

    it(`${algorithm}: opens again after the window, and clear() resets`, async () => {
      const limiter = new RedisRateLimiter({ driver: connect(), space: space().area('rate') })
      const limit = { max: 2, windowSeconds: 1.5, algorithm }
      expect((await limiter.hit('k', limit)).remaining).toBe(1)
      expect((await limiter.hit('k', limit)).allowed).toBe(true)
      expect((await limiter.hit('k', limit)).allowed).toBe(false)
      await sleep(1600)
      expect((await limiter.hit('k', limit)).allowed).toBe(true)
      await limiter.hit('k', limit)
      expect((await limiter.hit('k', limit)).allowed).toBe(false)
      await limiter.clear('k')
      expect((await limiter.hit('k', limit)).allowed).toBe(true)
    })
  }

  it('sliding: hits from the last window still count (no burst at a fixed boundary)', async () => {
    const limiter = new RedisRateLimiter({ driver: connect(), space: space().area('rate') })
    const limit = { max: 5, windowSeconds: 2, algorithm: 'sliding' as const }
    for (let i = 0; i < 3; i++) expect((await limiter.hit('burst', limit)).allowed).toBe(true)
    const start = Date.now() // the first three are in by now
    await sleep(800)
    for (let i = 0; i < 2; i++) expect((await limiter.hit('burst', limit)).allowed).toBe(true)
    expect((await limiter.hit('burst', limit)).allowed).toBe(false)
    // After the first three expire (t ≥ 2 s) only three slots open: the two hits from t ≈ 0.8 s
    // still count. A fixed window would have reset and allowed five.
    await sleep(Math.max(0, start + 2050 - Date.now()))
    const after = []
    for (let i = 0; i < 5; i++) after.push((await limiter.hit('burst', limit)).allowed)
    expect(after).toEqual([true, true, true, false, false])
  })

  it('refused sliding hits are not recorded (memory stays bounded by max)', async () => {
    const redis = connect()
    const root = space()
    const limiter = new RedisRateLimiter({ driver: redis, space: root.area('rate') })
    for (let i = 0; i < 50; i++)
      await limiter.hit('flood', { max: 3, windowSeconds: 60, algorithm: 'sliding' })
    expect(await redis.command(['ZCARD', `${root.prefix}rate:s:flood`])).toBe(3)
    expect(Number(await redis.command(['PTTL', `${root.prefix}rate:s:flood`]))).toBeGreaterThan(0)
  })

  it('a fixed counter that lost its expiry gets it back (never a permanent ban)', async () => {
    const redis = connect()
    const root = space()
    const limiter = new RedisRateLimiter({ driver: redis, space: root.area('rate') })
    await redis.command(['SET', `${root.prefix}rate:f:stuck`, '99'])
    const result = await limiter.hit('stuck', { max: 5, windowSeconds: 2 })
    expect(result.allowed).toBe(false)
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(2)
    expect(Number(await redis.command(['PTTL', `${root.prefix}rate:f:stuck`]))).toBeGreaterThan(0)
  })

  it('attempt() runs only when allowed; tenants have separate budgets', async () => {
    const limiter = new RedisRateLimiter({ driver: connect(), space: space().area('rate') })
    const limit = { max: 1, windowSeconds: 60 }
    expect(await limiter.attempt('digest', limit, () => 'sent')).toBe('sent')
    expect(await limiter.attempt('digest', limit, () => 'sent')).toBeUndefined()
    expect((await limiter.forTenant('acme').hit('digest', limit)).allowed).toBe(true)
    expect((await limiter.forTenant('globex').hit('digest', limit)).allowed).toBe(true)
    expect((await limiter.forTenant('acme').hit('digest', limit)).allowed).toBe(false)
  })

  it('validates limits', async () => {
    const limiter = new RedisRateLimiter({ driver: connect(), space: space().area('rate') })
    await expect(limiter.hit('k', { max: 0, windowSeconds: 1 })).rejects.toThrow(RangeError)
    await expect(limiter.hit('k', { max: 1.5, windowSeconds: 1 })).rejects.toThrow(RangeError)
    await expect(limiter.hit('k', { max: 1, windowSeconds: 0 })).rejects.toThrow(RangeError)
    await expect(
      limiter.hit('k', { max: 1, windowSeconds: 1, algorithm: 'leaky' as 'fixed' }),
    ).rejects.toThrow(RangeError)
  })
})
