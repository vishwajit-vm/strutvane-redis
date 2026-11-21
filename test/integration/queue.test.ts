import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { RedisQueueDriver } from '../../src/queue/redis-queue.ts'
import { closeAll, connect, skip, space, title } from '../support/redis.ts'

afterAll(closeAll)

describe.skipIf(skip)(title('RedisQueueDriver (experimental)'), () => {
  const queueOn = (root = space(), visibilitySeconds?: number): RedisQueueDriver =>
    new RedisQueueDriver({
      driver: connect(),
      space: root.area('queue'),
      ...(visibilitySeconds === undefined ? {} : { visibilitySeconds }),
    })

  it('pushes and pops in order, acks, and reports size', async () => {
    const queue = queueOn()
    const first = await queue.push('emails', JSON.stringify({ to: 'a' }))
    await queue.push('emails', JSON.stringify({ to: 'b' }))
    expect(await queue.size('emails')).toBe(2)
    const job = await queue.pop('emails')
    expect(job?.id).toBe(first)
    expect(job?.payload).toBe('{"to":"a"}')
    expect(job?.attempts).toBe(1)
    expect(job?.reservedUntil).toBeGreaterThan(Date.now() - 5000)
    expect(await queue.size('emails')).toBe(2) // one waiting, one reserved
    if (job === undefined) throw new Error('expected a job')
    expect(await queue.ack(job)).toBe(true)
    expect(await queue.ack(job)).toBe(false)
    expect(await queue.size('emails')).toBe(1)
    expect(await queue.clear('emails')).toBe(1)
    expect(await queue.pop('emails')).toBeUndefined()
  })

  it('never hands one job to two parallel workers', async () => {
    const root = space()
    const producer = queueOn(root)
    for (let i = 0; i < 30; i++) await producer.push('work', String(i))
    const workers = Array.from({ length: 6 }, () => queueOn(root))
    const popped = await Promise.all(
      Array.from({ length: 40 }, (_, i) => workers[i % 6]?.pop('work')),
    )
    const ids = popped.filter((job) => job !== undefined).map((job) => job?.id)
    expect(ids).toHaveLength(30)
    expect(new Set(ids).size).toBe(30)
  })

  it('delays jobs and releases them for another attempt', async () => {
    const queue = queueOn()
    await queue.push('later', 'x', { delaySeconds: 1 })
    expect(await queue.pop('later')).toBeUndefined()
    await sleep(1200)
    const job = await queue.pop('later')
    expect(job?.payload).toBe('x')
    if (job === undefined) throw new Error('expected a job')
    expect(await queue.release(job, 1)).toBe(true)
    expect(await queue.release(job)).toBe(false) // no longer reserved
    expect(await queue.pop('later')).toBeUndefined()
    await sleep(1200)
    const retried = await queue.pop('later')
    expect(retried?.attempts).toBe(2)
    if (retried === undefined) throw new Error('expected a job')
    expect(await queue.release(retried)).toBe(true) // immediately back
    expect((await queue.pop('later'))?.attempts).toBe(3)
  })

  it("a crashed worker's job comes back after its reservation expires", async () => {
    const queue = queueOn(space(), 1)
    await queue.push('crashy', 'payload')
    const lost = await queue.pop('crashy')
    expect(lost).toBeDefined()
    expect(await queue.pop('crashy')).toBeUndefined()
    await sleep(1200)
    const again = await queue.pop('crashy', { visibilitySeconds: 10 })
    expect(again?.id).toBe(lost?.id)
    expect(again?.attempts).toBe(2)
  })

  it('validates names, payloads and times', async () => {
    const queue = queueOn()
    await expect(queue.push('bad name', 'x')).rejects.toThrow(TypeError)
    await expect(queue.push('a:b', 'x')).rejects.toThrow(TypeError)
    await expect(queue.push('ok', 'x'.repeat(1024 * 1024 + 1))).rejects.toThrow(RangeError)
    await expect(queue.push('ok', 'x', { delaySeconds: -1 })).rejects.toThrow(RangeError)
    await expect(queue.pop('ok', { visibilitySeconds: 0 })).rejects.toThrow(RangeError)
    expect(
      () => new RedisQueueDriver({ driver: connect(), space: space(), visibilitySeconds: 0 }),
    ).toThrow(RangeError)
  })

  it('moves entries that are not jobs to :failed, as they were, and keeps serving real jobs', async () => {
    const root = space()
    const redis = connect()
    const queue = new RedisQueueDriver({ driver: redis, space: root.area('queue') })
    const ready = `${root.prefix}queue:mixed`
    const junk = [
      'not json at all',
      '{"attempts":0}',
      '"a string"',
      '42',
      '[1,2,3]',
      '{"id":1,"payload":"x"}',
      '{"id":"x","payload":{"nested":true}}',
      `${'['.repeat(2000)}${']'.repeat(2000)}`,
      '{"id":"x","payload":"y"',
    ]
    await redis.command(['RPUSH', ready, ...junk])
    const id = await queue.push('mixed', 'real job')
    // One pop moves every bad entry aside and reserves the real job behind them.
    const job = await queue.pop('mixed')
    expect(job?.id).toBe(id)
    expect(job?.payload).toBe('real job')
    expect(await redis.command(['LRANGE', `${ready}:failed`, '0', '-1'])).toEqual(junk)
    expect(await queue.size('mixed')).toBe(1)
    expect(job === undefined ? false : await queue.ack(job)).toBe(true)
    // Only bad entries: pop answers "nothing to do", never an error.
    await redis.command(['RPUSH', ready, 'still not json'])
    expect(await queue.pop('mixed')).toBeUndefined()
    expect(await redis.command(['LLEN', `${ready}:failed`])).toBe(junk.length + 1)
    // clear removes the failed entries too.
    await queue.clear('mixed')
    expect(await redis.command(['EXISTS', `${ready}:failed`])).toBe(0)
  })

  it('gives up for one call after many bad entries in a row, and goes on at the next', async () => {
    const root = space()
    const redis = connect()
    const queue = new RedisQueueDriver({ driver: redis, space: root.area('queue') })
    const ready = `${root.prefix}queue:flood`
    await redis.command(['RPUSH', ready, ...Array.from({ length: 150 }, (_, i) => `junk ${i}`)])
    const id = await queue.push('flood', 'after the flood')
    expect(await queue.pop('flood')).toBeUndefined()
    expect((await queue.pop('flood'))?.id).toBe(id)
    expect(await redis.command(['LLEN', `${ready}:failed`])).toBe(150)
  })
})
