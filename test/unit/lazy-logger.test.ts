import { describe, expect, it } from 'vitest'
import { lazyLogger } from '../../src/lazy-logger.ts'
import { MemoryLogger } from '../support/logger.ts'

describe('lazyLogger', () => {
  it('resolves the real logger once, on first use, and forwards every call', async () => {
    const real = new MemoryLogger()
    let resolved = 0
    const logger = lazyLogger(() => {
      resolved += 1
      return real
    })
    expect(resolved).toBe(0)
    logger.trace('t')
    logger.debug('d')
    logger.info('i', { a: 1 })
    logger.warn('w')
    logger.error('e')
    logger.fatal('f')
    expect(logger.child({ b: 2 })).toBe(real)
    expect(logger.isLevelEnabled('info')).toBe(true)
    await logger.flush()
    expect(resolved).toBe(1)
    expect(real.entries.map((entry) => `${entry.level}:${entry.message}`)).toEqual([
      'trace:t',
      'debug:d',
      'info:i',
      'warn:w',
      'error:e',
      'fatal:f',
    ])
    expect(real.entries[2]?.fields).toEqual({ a: 1 })
  })
})
