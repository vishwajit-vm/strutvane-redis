import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { deleteMatching } from '../../src/driver.ts'
import { RedisIdempotencyStore } from '../../src/idempotency-store.ts'
import { RedisSessionStore } from '../../src/session-store.ts'
import { RedisUsedSignatureStore } from '../../src/signature-store.ts'
import { closeAll, connect, skip, space, title } from '../support/redis.ts'

afterAll(closeAll)

const sessionId = (): string => randomBytes(32).toString('base64url')

describe.skipIf(skip)(title('RedisSessionStore'), () => {
  const redis = connect()

  it('writes, reads, touches and destroys sessions with an idle expiry', async () => {
    const sessions = new RedisSessionStore({
      driver: redis,
      space: space().area('session'),
      lifetimeSeconds: 60,
    })
    const id = sessionId()
    expect(await sessions.read(id)).toBeUndefined()
    await sessions.write(id, { userId: 7, csrf: 'abc' })
    expect(await sessions.read(id)).toEqual({ userId: 7, csrf: 'abc' })
    expect(await sessions.touch(id)).toBe(true)
    expect(await sessions.destroy(id)).toBe(true)
    expect(await sessions.destroy(id)).toBe(false)
    expect(await sessions.touch(id)).toBe(false)
    expect(await sessions.read(id)).toBeUndefined()
  })

  it('expires idle sessions', async () => {
    const sessions = new RedisSessionStore({
      driver: redis,
      space: space().area('session'),
      lifetimeSeconds: 1,
    })
    const id = sessionId()
    await sessions.write(id, { a: 1 })
    await sleep(1150)
    expect(await sessions.read(id)).toBeUndefined()
  })

  it('never stores the session id itself (keys are SHA-256 hashes)', async () => {
    const root = space()
    const sessions = new RedisSessionStore({ driver: redis, space: root.area('session') })
    const id = sessionId()
    await sessions.write(id, { userId: 1 })
    const keys = (await redis.command(['KEYS', `${root.prefix}*`])) as string[]
    expect(keys).toEqual([`${root.prefix}session:${createHash('sha256').update(id).digest('hex')}`])
    expect(keys.join('')).not.toContain(id)
  })

  it('refuses malformed ids and oversized sessions before touching Redis', async () => {
    const sessions = new RedisSessionStore({
      driver: redis,
      space: space().area('session'),
      maxBytes: 100,
    })
    for (const bad of ['short', 'has space in the id 1234567', '*'.repeat(30), 'x'.repeat(257), ''])
      expect(await sessions.read(bad)).toBeUndefined()
    await expect(sessions.write('short', {})).rejects.toThrow(TypeError)
    expect(await sessions.destroy('*')).toBe(false)
    expect(await sessions.touch('*')).toBe(false)
    await expect(sessions.write(sessionId(), { blob: 'x'.repeat(200) })).rejects.toThrow(RangeError)
  })

  it('reads a corrupt or non-object session as missing', async () => {
    const root = space()
    const sessions = new RedisSessionStore({ driver: redis, space: root.area('session') })
    const id = sessionId()
    const key = `${root.prefix}session:${createHash('sha256').update(id).digest('hex')}`
    await redis.command(['SET', key, '{broken'])
    expect(await sessions.read(id)).toBeUndefined()
    await redis.command(['SET', key, '[1,2]'])
    expect(await sessions.read(id)).toBeUndefined()
  })

  it('flushes every session of this app only and reports the count', async () => {
    const root = space()
    const sessions = new RedisSessionStore({ driver: redis, space: root.area('session') })
    const otherApp = new RedisSessionStore({ driver: redis, space: space().area('session') })
    const keep = sessionId()
    await otherApp.write(keep, { x: 1 })
    for (let i = 0; i < 5; i++) await sessions.write(sessionId(), { i })
    expect(await sessions.flush()).toBe(5)
    expect(await otherApp.read(keep)).toEqual({ x: 1 })
  })

  it('validates its options', () => {
    expect(
      () => new RedisSessionStore({ driver: redis, space: space(), lifetimeSeconds: 0 }),
    ).toThrow(RangeError)
    expect(() => new RedisSessionStore({ driver: redis, space: space(), maxBytes: 0 })).toThrow(
      RangeError,
    )
  })
})

describe.skipIf(skip)(title('RedisIdempotencyStore'), () => {
  const redis = connect()
  const response = {
    status: 201,
    headers: [['content-type', 'application/json']] as const,
    body: '{"id":1}',
  }

  it('claims once, reports in-progress and mismatch, then replays', async () => {
    const store = new RedisIdempotencyStore({ driver: redis, space: space().area('idempotency') })
    const key = 'actor:user:7\nacme\nkey-1'
    expect(await store.begin(key, 'fp', Date.now())).toEqual({ kind: 'new' })
    expect(await store.begin(key, 'fp', Date.now())).toEqual({ kind: 'in_progress' })
    expect(await store.begin(key, 'other', Date.now())).toEqual({ kind: 'mismatch' })
    await store.complete(key, { ...response, headers: [...response.headers] }, Date.now())
    expect(await store.begin(key, 'fp', Date.now())).toEqual({
      kind: 'replay',
      response: { status: 201, headers: [['content-type', 'application/json']], body: '{"id":1}' },
    })
  })

  it('only one of many parallel first requests runs', async () => {
    const root = space()
    const stores = Array.from(
      { length: 5 },
      () => new RedisIdempotencyStore({ driver: connect(), space: root.area('idempotency') }),
    )
    const outcomes = await Promise.all(
      Array.from({ length: 40 }, (_, i) => stores[i % 5]?.begin('same', 'fp', Date.now())),
    )
    expect(outcomes.filter((outcome) => outcome?.kind === 'new')).toHaveLength(1)
  })

  it('release lets a retry run; complete after release does not resurrect the claim', async () => {
    const store = new RedisIdempotencyStore({ driver: redis, space: space().area('idempotency') })
    await store.begin('k', 'fp', 0)
    await store.release('k')
    await store.complete('k', { ...response, headers: [] }, 0)
    expect(await store.begin('k', 'fp', 0)).toEqual({ kind: 'new' })
  })

  it('expires claims, hashes keys and treats a corrupt response as in progress', async () => {
    const root = space()
    const store = new RedisIdempotencyStore({
      driver: redis,
      space: root.area('idempotency'),
      ttlMs: 200,
    })
    await store.begin('secret-actor-key', 'fp', 0)
    const keys = (await redis.command(['KEYS', `${root.prefix}*`])) as string[]
    expect(keys.join('')).not.toContain('secret-actor-key')
    await redis.command(['HSET', keys[0] ?? '', 'r', '{"status":"nope"}'])
    expect(await store.begin('secret-actor-key', 'fp', 0)).toEqual({ kind: 'in_progress' })
    await redis.command(['HSET', keys[0] ?? '', 'r', 'not json'])
    expect(await store.begin('secret-actor-key', 'fp', 0)).toEqual({ kind: 'in_progress' })
    await sleep(300)
    expect(await store.begin('secret-actor-key', 'fp', 0)).toEqual({ kind: 'new' })
    expect(() => new RedisIdempotencyStore({ driver: redis, space: root, ttlMs: 0 })).toThrow(
      RangeError,
    )
  })
})

describe.skipIf(skip)(title('RedisUsedSignatureStore'), () => {
  const redis = connect()

  it('claims a signature once, across connections, until it expires', async () => {
    const root = space()
    const a = new RedisUsedSignatureStore({ driver: redis, space: root.area('signature') })
    const b = new RedisUsedSignatureStore({ driver: connect(), space: root.area('signature') })
    const expiresAt = Date.now() + 300
    const claims = await Promise.all([a, b, a, b].map((store) => store.claim('sig-1', expiresAt)))
    expect(claims.filter(Boolean)).toHaveLength(1)
    await sleep(400)
    expect(await a.claim('sig-1', Date.now() + 1000)).toBe(true)
  })

  it('fails closed for expired or invalid expiries', async () => {
    const store = new RedisUsedSignatureStore({ driver: redis, space: space().area('signature') })
    expect(await store.claim('sig', Date.now() - 1)).toBe(false)
    expect(await store.claim('sig', Number.NaN)).toBe(false)
    expect(await store.claim('sig', 1.5)).toBe(false)
  })
})

describe.skipIf(skip)(title('deleteMatching'), () => {
  it('removes every matching key in batches and nothing else', async () => {
    const redis = connect()
    const root = space()
    const keep = space()
    for (let i = 0; i < 30; i++) await redis.command(['SET', `${root.prefix}x:${i}`, '1'])
    await redis.command(['SET', `${keep.prefix}x:1`, '1'])
    expect(await deleteMatching(redis, root.pattern(), 7)).toBe(30)
    expect(await redis.command(['EXISTS', `${keep.prefix}x:1`])).toBe(1)
    await deleteMatching(redis, keep.pattern())
  })
})
