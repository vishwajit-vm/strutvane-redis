import { afterAll, describe, expect, it } from 'vitest'
import { RedisCacheStore } from '../../src/cache-store.ts'
import { KeySpace } from '../../src/keys.ts'
import { closeAll, connect, skip, space, title } from '../support/redis.ts'

afterAll(closeAll)

describe.skipIf(skip)(title('RedisCacheStore: the CacheStore contract'), () => {
  const redis = connect()
  const store = (): RedisCacheStore =>
    new RedisCacheStore({ driver: redis, space: space().area('cache') })

  it('puts, gets and checks JSON values', async () => {
    const cache = store()
    expect(await cache.get('missing')).toBeUndefined()
    expect(await cache.has('missing')).toBe(false)
    await cache.put('stats', { posts: 3, tags: ['a'], nested: { ok: true } }, 60)
    expect(await cache.get('stats')).toEqual({ posts: 3, tags: ['a'], nested: { ok: true } })
    expect(await cache.has('stats')).toBe(true)
    await cache.put('falsy', 0)
    expect(await cache.get('falsy')).toBe(0)
    await cache.put('null', null)
    expect(await cache.get('null')).toBeNull()
    expect(await cache.has('null')).toBe(true)
  })

  it('refuses values that are not JSON instead of storing null', async () => {
    const cache = store()
    await expect(cache.put('u', undefined)).rejects.toThrow(TypeError)
    await expect(cache.put('f', () => 1)).rejects.toThrow(TypeError)
    await expect(cache.put('b', 1n)).rejects.toThrow(TypeError)
  })

  it('expires values and reports ttl; ttl 0 or less removes the key', async () => {
    const cache = store()
    await cache.put('short', 'v', 60)
    const ttl = await cache.ttl('short')
    expect(ttl).toBeGreaterThan(55)
    expect(ttl).toBeLessThanOrEqual(60)
    await cache.put('forever', 'v')
    expect(await cache.ttl('forever')).toBeUndefined()
    expect(await cache.ttl('missing')).toBeUndefined()
    await cache.put('gone', 'v', 0)
    expect(await cache.has('gone')).toBe(false)
    await cache.put('short', 'v', -1)
    expect(await cache.has('short')).toBe(false)
    await cache.put('blink', 'v', 0.05)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(await cache.get('blink')).toBeUndefined()
    await expect(cache.put('x', 1, Number.POSITIVE_INFINITY)).rejects.toThrow(RangeError)
  })

  it('add stores only when absent, and only one of many parallel adds wins', async () => {
    const cache = store()
    expect(await cache.add('once', 1, 60)).toBe(true)
    expect(await cache.add('once', 2, 60)).toBe(false)
    expect(await cache.get('once')).toBe(1)
    expect(await cache.add('never', 1, 0)).toBe(false)
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => cache.add('race', i)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await cache.add('free', 'x')).toBe(true)
  })

  it('increments atomically under parallel load and keeps a fixed window', async () => {
    const cache = store()
    const other = new RedisCacheStore({
      driver: connect(),
      space: KeySpace.root(cache.prefix.replace(/cache:$/, '')).area('cache'),
    })
    expect(other.prefix).toBe(cache.prefix)
    await Promise.all(
      Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? cache : other).increment('hits', 1, 60)),
    )
    expect(await cache.get('hits')).toBe(200)
    const before = await cache.ttl('hits')
    await cache.increment('hits', 5, 1)
    expect(await cache.ttl('hits')).toBe(before) // an existing counter keeps its expiry
    expect(await cache.decrement('hits', 5)).toBe(200)
    await cache.put('text', 'abc')
    expect(await cache.increment('text', 2)).toBe(2) // not a counter: starts over
    await expect(cache.increment('hits', 1.5)).rejects.toThrow(TypeError)
    await expect(cache.increment('hits', 1, 0)).rejects.toThrow(RangeError)
  })

  it('forgets and flushes only its own keys', async () => {
    const root = space()
    const cache = new RedisCacheStore({ driver: redis, space: root.area('cache') })
    const reports = new RedisCacheStore({ driver: redis, space: root.area('reports') })
    await cache.put('a', 1)
    await reports.put('a', 2)
    expect(await cache.forget('a')).toBe(true)
    expect(await cache.forget('a')).toBe(false)
    // More keys than one SCAN batch, written in one script (1,200 round trips time out under load).
    await cache.putMany(
      Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`bulk:${i}`, i])),
    )
    await cache.flush()
    expect(await cache.get('bulk:5')).toBeUndefined()
    expect(await reports.get('a')).toBe(2)
  })

  it('reads and writes many keys at once', async () => {
    const cache = store()
    await cache.putMany({ a: 1, b: { c: 2 } }, 60)
    expect(await cache.many(['a', 'b', 'missing'])).toEqual({
      a: 1,
      b: { c: 2 },
      missing: undefined,
    })
    expect(await cache.ttl('a')).toBeGreaterThan(50)
    await cache.putMany({ forever: true })
    expect(await cache.ttl('forever')).toBeUndefined()
    await cache.putMany({ a: 9 }, 0)
    expect(await cache.has('a')).toBe(false)
    await cache.putMany({})
    expect(await cache.many([])).toEqual({})
  })

  it('returns many() results without a prototype, so any key is a plain entry', async () => {
    const cache = store()
    await cache.putMany(JSON.parse('{"__proto__":"p","constructor":"c","toString":"t"}'), 60)
    const result = await cache.many(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])
    expect(Object.getPrototypeOf(result)).toBeNull()
    expect(Object.keys(result).sort()).toEqual(
      ['__proto__', 'constructor', 'hasOwnProperty', 'toString'].sort(),
    )
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toBe('p')
    expect(result['constructor']).toBe('c')
    expect(result['toString']).toBe('t')
    expect(result['hasOwnProperty']).toBeUndefined()
    expect(Object.getPrototypeOf(await cache.many([]))).toBeNull()
  })

  it('remembers and stores forever', async () => {
    const cache = store()
    let calls = 0
    const compute = async (): Promise<number> => ++calls
    expect(await cache.remember('r', 60, compute)).toBe(1)
    expect(await cache.remember('r', 60, compute)).toBe(1)
    expect(calls).toBe(1)
    expect(await cache.remember('u', 60, () => undefined)).toBeUndefined()
    expect(await cache.has('u')).toBe(false)
    await cache.forever('f', 'x')
    expect(await cache.ttl('f')).toBeUndefined()
  })

  it('serves stale values while one refresher recomputes (flexible)', async () => {
    const cache = store()
    let version = 0
    const compute = async (): Promise<number> => {
      version += 1
      await new Promise((resolve) => setTimeout(resolve, 30))
      return version
    }
    expect(await cache.flexible('f', [1, 10], compute)).toBe(1)
    expect(await cache.flexible('f', [1, 10], compute)).toBe(1) // fresh
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const stale = await Promise.all([1, 2, 3].map(() => cache.flexible('f', [1, 10], compute)))
    expect(stale).toEqual([1, 1, 1]) // served stale, at once
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(version).toBe(2) // one refresh, not three
    expect(await cache.flexible('f', [1, 10], compute)).toBe(2)
    await expect(cache.flexible('bad', [10, 5], compute)).rejects.toThrow(RangeError)
  })

  it('a failing background refresh is logged and keeps serving the stale value', async () => {
    const warnings: string[] = []
    const contexts: unknown[] = []
    const logger = {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (msg: string, context?: unknown) => {
        warnings.push(msg)
        contexts.push(context)
      },
      error: () => {},
      fatal: () => {},
      child() {
        return logger
      },
      isLevelEnabled: () => true,
      flush: async () => {},
    }
    const cache = new RedisCacheStore({ driver: redis, space: space().area('cache'), logger })
    const key = 'user:alice@example.com'
    expect(await cache.flexible(key, [0.05, 10], () => 'first')).toBe('first')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(
      await cache.flexible(key, [0.05, 10], () => {
        throw new Error('boom')
      }),
    ).toBe('first')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(warnings).toEqual(['redis.cache.refresh_failed'])
    // The log tells keys apart by a digest and never shows the key itself.
    expect(JSON.stringify(contexts)).not.toContain('alice')
    expect(contexts[0]).toMatchObject({ key_digest: expect.stringMatching(/^[0-9a-f]{16}$/) })
  })

  it('treats a value it did not write (not JSON) as a miss', async () => {
    const cache = store()
    await redis.command(['SET', `${cache.prefix}raw`, '{not json'])
    expect(await cache.get('raw')).toBeUndefined()
  })
})

describe.skipIf(skip)(title('RedisCacheStore: tenants and key injection'), () => {
  const redis = connect()

  it('isolates tenants: same key, different values, and per-tenant flush', async () => {
    const cache = new RedisCacheStore({ driver: redis, space: space().area('cache') })
    const acme = cache.forTenant('acme')
    const globex = cache.forTenant('globex')
    await cache.put('stats', 'global')
    await acme.put('stats', 'acme')
    await globex.put('stats', 'globex')
    expect([await cache.get('stats'), await acme.get('stats'), await globex.get('stats')]).toEqual([
      'global',
      'acme',
      'globex',
    ])
    await acme.flush()
    expect(await acme.get('stats')).toBeUndefined()
    expect(await globex.get('stats')).toBe('globex')
    expect(await cache.get('stats')).toBe('global')
    await cache.flush() // the app-wide flush clears every tenant too
    expect(await globex.get('stats')).toBeUndefined()
  })

  it('a tenant id or key cannot reach another namespace', async () => {
    const cache = new RedisCacheStore({ driver: redis, space: space().area('cache') })
    const victim = cache.forTenant('b')
    await victim.put('secret', 'b-data')
    for (const id of ['a:t:b', 'b:', '../b', 'b*', '', 'x'.repeat(129), 'b\r\nFLUSHALL'])
      expect(() => cache.forTenant(id)).toThrow(TypeError)
    expect(() => cache.forTenant('a').forTenant('b')).toThrow(TypeError)
    await expect(cache.get('t:b:secret')).rejects.toThrow(TypeError)
    await expect(cache.put('t:b:secret', 'overwritten')).rejects.toThrow(TypeError)
    expect(await victim.get('secret')).toBe('b-data')
  })

  it('stores keys with CR/LF, spaces and glob characters literally (no command injection)', async () => {
    const cache = new RedisCacheStore({ driver: redis, space: space().area('cache') })
    const sentinel = new RedisCacheStore({ driver: redis, space: space().area('cache') })
    await sentinel.put('alive', true)
    const nasty = ['a\r\nFLUSHALL\r\n', '*', '[a-z]?', 'with space', '\\', 'ключ', '"quoted"']
    for (const key of nasty) await cache.put(key, key)
    for (const key of nasty) expect(await cache.get(key)).toBe(key)
    expect(await sentinel.get('alive')).toBe(true)
    await cache.forget('*')
    expect(await cache.get('[a-z]?')).toBe('[a-z]?') // '*' was one literal key, not a pattern
    await expect(cache.get('')).rejects.toThrow(TypeError)
    await expect(cache.get('k'.repeat(1025))).rejects.toThrow(TypeError)
  })

  it('refuses glob characters in prefixes, so every flush pattern is literal', async () => {
    expect(() => KeySpace.root('a*:test:')).toThrow(TypeError)
    expect(() => KeySpace.root('a?:test:')).toThrow(TypeError)
    expect(() => KeySpace.root('[ab]:test:')).toThrow(TypeError)
    // Neighbouring prefixes (app1: and app10:) never flush each other.
    const stamp = Date.now()
    const one = new RedisCacheStore({
      driver: redis,
      space: KeySpace.root(`app1${stamp}:test:`).area('cache'),
    })
    const ten = new RedisCacheStore({
      driver: redis,
      space: KeySpace.root(`app1${stamp}0:test:`).area('cache'),
    })
    await one.put('k', 1)
    await ten.put('k', 2)
    await one.flush()
    expect(await one.get('k')).toBeUndefined()
    expect(await ten.get('k')).toBe(2)
    await ten.flush()
  })
})
