import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileCacheStore, isBootError } from '@strutvane/framework'
import { createTestClock } from '@strutvane/framework/core'
import { afterAll, describe, expect, it } from 'vitest'
import { createRedisCacheManager } from '../../src/cache-manager.ts'
import { RedisCacheStore } from '../../src/cache-store.ts'
import type { RedisDriver } from '../../src/driver.ts'
import { KeySpace } from '../../src/keys.ts'

const base = mkdtempSync(join(tmpdir(), 'strutvane-redis-manager-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let resolved = 0
const driver: RedisDriver = {
  command: async () => null,
  script: async () => null,
  ping: async () => 0,
  close: async () => {},
}
const manager = (config: unknown) =>
  createRedisCacheManager({
    basePath: base,
    clock: createTestClock(0),
    config,
    driver: () => {
      resolved += 1
      return driver
    },
    root: KeySpace.root('app:test:'),
  })

const bootCode = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    expect(isBootError(error)).toBe(true)
    return (error as { code: string }).code
  }
  throw new Error('expected a BootError')
}

describe('createRedisCacheManager', () => {
  it('always has memory, file and redis stores; memory is the default without config', () => {
    const cache = manager(undefined)
    expect(cache.defaultStore).toBe('memory')
    expect(cache.storeNames).toEqual(['file', 'memory', 'redis'])
    expect(cache.store().constructor.name).toBe('MemoryCacheStore')
    expect(cache.store('file')).toBeInstanceOf(FileCacheStore)
    expect(manager(null).defaultStore).toBe('memory')
  })

  it('creates Redis stores lazily, once, under their areas', () => {
    resolved = 0
    const cache = manager({
      default: 'redis',
      stores: { file: { driver: 'file' }, reports: { driver: 'redis', area: 'reports' } },
    })
    expect(resolved).toBe(0)
    const store = cache.store()
    expect(store).toBeInstanceOf(RedisCacheStore)
    expect((store as RedisCacheStore).prefix).toBe('app:test:cache:')
    expect(cache.store('redis')).toBe(store)
    expect((cache.store('reports') as RedisCacheStore).prefix).toBe('app:test:reports:')
    expect(resolved).toBe(2)
    expect(cache.storeNames).toEqual(['file', 'memory', 'redis', 'reports'])
  })

  it('accepts a bare driver name for a redis store', () => {
    expect(manager({ default: 'shared', stores: { shared: 'redis' } }).store()).toBeInstanceOf(
      RedisCacheStore,
    )
  })

  it('lets the app repoint the redis name to another driver', () => {
    const cache = manager({ default: 'redis', stores: { redis: { driver: 'memory' } } })
    expect(cache.store().constructor.name).toBe('MemoryCacheStore')
  })

  it('stops boot on bad config, with a friendly code', () => {
    expect(bootCode(() => manager('file'))).toBe('invalid_cache_config')
    expect(bootCode(() => manager({ default: 3 }))).toBe('invalid_cache_config')
    expect(bootCode(() => manager({ stores: [] }))).toBe('invalid_cache_config')
    expect(bootCode(() => manager({ stores: { r: { driver: 'redis', area: 'Bad Area' } } }))).toBe(
      'invalid_cache_config',
    )
    expect(bootCode(() => manager({ stores: { r: { driver: 'redis', host: 'x' } } }))).toBe(
      'invalid_cache_config',
    )
    expect(bootCode(() => manager({ default: 'redsi' }))).toBe('unknown_cache_store')
    expect(bootCode(() => manager({ stores: { x: { driver: 'mongo' } } }))).toBe(
      'unknown_cache_driver',
    )
    expect(bootCode(() => manager(undefined).store('nope'))).toBe('unknown_cache_store')
  })
})
