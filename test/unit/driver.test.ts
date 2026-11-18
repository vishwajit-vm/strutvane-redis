import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StrutvaneError } from '@strutvane/framework/core'
import { describe, expect, it } from 'vitest'
import {
  asArray,
  asInteger,
  asNullableString,
  defineLua,
  deleteMatching,
  type RedisDriver,
} from '../../src/driver.ts'
import { loadRedisEnv } from '../../src/env.ts'
import { lockTimeout, REDIS_ERRORS, REDIS_MESSAGES_EN, redisUnavailable } from '../../src/errors.ts'

describe('reply narrowing', () => {
  it('narrows strings, integers and arrays, and fails loudly on surprises', () => {
    expect(asNullableString(null)).toBeNull()
    expect(asNullableString(undefined)).toBeNull()
    expect(asNullableString('a')).toBe('a')
    expect(asNullableString(5)).toBe('5')
    expect(asNullableString(5n)).toBe('5')
    expect(asNullableString(Buffer.from('b'))).toBe('b')
    expect(() => asNullableString([1])).toThrow(/array where a string/)
    expect(asInteger(3)).toBe(3)
    expect(asInteger('4')).toBe(4)
    expect(asInteger(6n)).toBe(6)
    expect(() => asInteger('x')).toThrow(TypeError)
    expect(() => asInteger(1.5)).toThrow(TypeError)
    expect(() => asInteger(null)).toThrow(/null where an integer/)
    expect(asArray([1])).toEqual([1])
    expect(() => asArray('x')).toThrow(/string where an array/)
  })

  it('defines Lua scripts with their SHA-1', () => {
    expect(defineLua('return 1').sha1).toBe('e0e1f9fabfc9d4800c877a703b823ac0578ff8db')
  })
})

describe('deleteMatching', () => {
  it('scans with the pattern and unlinks each batch until the cursor is 0', async () => {
    const calls: (readonly string[])[] = []
    const pages: unknown[] = [
      ['7', ['a', 'b']],
      ['3', []],
      ['0', ['c']],
    ]
    const driver: RedisDriver = {
      command: async (args) => {
        calls.push(args)
        if (args[0] === 'SCAN') return pages.shift()
        return args.length - 1
      },
      script: async () => null,
      ping: async () => 0,
      close: async () => {},
    }
    expect(await deleteMatching(driver, 'p:*', 2)).toBe(3)
    expect(calls).toEqual([
      ['SCAN', '0', 'MATCH', 'p:*', 'COUNT', '2'],
      ['UNLINK', 'a', 'b'],
      ['SCAN', '7', 'MATCH', 'p:*', 'COUNT', '2'],
      ['SCAN', '3', 'MATCH', 'p:*', 'COUNT', '2'],
      ['UNLINK', 'c'],
    ])
  })
})

describe('errors', () => {
  it('builds 503 problems with Retry-After and registers catalog messages', () => {
    const unavailable = redisUnavailable('get', new Error('cause'))
    expect(unavailable).toBeInstanceOf(StrutvaneError)
    expect(unavailable).toMatchObject({
      code: 'redis_unavailable',
      status: 503,
      params: { operation: 'get' },
    })
    expect(unavailable.cause).toBeInstanceOf(Error)
    expect(redisUnavailable('x').cause).toBeUndefined()
    expect(lockTimeout('reports', 5)).toMatchObject({
      code: 'lock_timeout',
      status: 503,
      headers: { 'Retry-After': '1' },
      params: { lock: 'reports', waited_seconds: 5 },
    })
    for (const definition of REDIS_ERRORS) {
      expect(definition.code).toMatch(/^[a-z_]+$/)
      expect(REDIS_MESSAGES_EN[`errors.${definition.code}.title`]).toBe(definition.title)
      expect(REDIS_MESSAGES_EN[`errors.${definition.code}.detail`]).toBeTypeOf('string')
    }
  })
})

describe('loadRedisEnv', () => {
  it('reads .env under the process environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strutvane-redis-env-'))
    try {
      expect(loadRedisEnv(dir, { A: '1' })).toEqual({ A: '1' })
      writeFileSync(
        join(dir, '.env'),
        'REDIS_HOST=from-file\nREDIS_PASSWORD="quoted # not a comment"\nA=file\n',
      )
      expect(loadRedisEnv(dir, { A: 'process' })).toEqual({
        REDIS_HOST: 'from-file',
        REDIS_PASSWORD: 'quoted # not a comment',
        A: 'process',
      })
      expect(loadRedisEnv(dir)['REDIS_HOST']).toBe(process.env['REDIS_HOST'] ?? 'from-file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
