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
    await queue.push('later', 'x', { delaySeconds: 0.2 })
    expect(await queue.pop('later')).toBeUndefined()
    await sleep(300)
    const job = await queue.pop('later')
    expect(job?.payload).toBe('x')
    if (job === undefined) throw new Error('expected a job')
    expect(await queue.release(job, 0.1)).toBe(true)
    expect(await queue.release(job)).toBe(false) // no longer reserved
    expect(await queue.pop('later')).toBeUndefined()
    await sleep(200)
    const retried = await queue.pop('later')
    expect(retried?.attempts).toBe(2)
    if (retried === undefined) throw new Error('expected a job')
    expect(await queue.release(retried)).toBe(true) // immediately back
    expect((await queue.pop('later'))?.attempts).toBe(3)
  })

  it("a crashed worker's job comes back after its reservation expires", async () => {
    const queue = queueOn(space(), 0.2)
    await queue.push('crashy', 'payload')
    const lost = await queue.pop('crashy')
    expect(lost).toBeDefined()
    expect(await queue.pop('crashy')).toBeUndefined()
    await sleep(300)
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

  it('refuses a corrupt job envelope loudly', async () => {
    const root = space()
    const redis = connect()
    const queue = new RedisQueueDriver({ driver: redis, space: root.area('queue') })
    await redis.command(['RPUSH', `${root.prefix}queue:broken`, '{"attempts":0}'])
    await expect(queue.pop('broken')).rejects.toThrow('corrupt')
  })
})
