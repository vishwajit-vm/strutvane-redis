import { isBootError } from '@strutvane/framework'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { defaultPrefix, describeSettings, resolveRedisSettings } from '../../src/config.ts'

const failure = (run: () => unknown): { code: string; message: string } => {
  try {
    run()
  } catch (error) {
    expect(isBootError(error)).toBe(true)
    return { code: (error as { code: string }).code, message: String((error as Error).message) }
  }
  throw new Error('expected a BootError')
}

describe('resolveRedisSettings', () => {
  it('has safe defaults', () => {
    expect(resolveRedisSettings({ env: {} })).toEqual({
      host: '127.0.0.1',
      port: 6379,
      username: undefined,
      password: undefined,
      database: 0,
      tls: false,
      tlsCaFile: undefined,
      tlsServername: undefined,
      prefix: 'strutvane:',
      connectTimeoutMs: 5000,
      commandTimeoutMs: 5000,
    })
  })

  it('reads the REDIS_* variables', () => {
    const settings = resolveRedisSettings({
      env: {
        REDIS_HOST: 'cache.internal',
        REDIS_PORT: '6380',
        REDIS_USERNAME: 'app',
        REDIS_PASSWORD: 's3cret',
        REDIS_DB: '3',
        REDIS_TLS: 'yes',
        REDIS_TLS_CA: '/etc/ca.pem',
        REDIS_TLS_SERVERNAME: 'cache.example.com',
        REDIS_PREFIX: 'blog:',
        REDIS_CONNECT_TIMEOUT: '100',
        REDIS_COMMAND_TIMEOUT: '200',
      },
    })
    expect(settings).toMatchObject({
      host: 'cache.internal',
      port: 6380,
      username: 'app',
      password: 's3cret',
      database: 3,
      tls: true,
      tlsCaFile: '/etc/ca.pem',
      tlsServername: 'cache.example.com',
      prefix: 'blog:',
      connectTimeoutMs: 100,
      commandTimeoutMs: 200,
    })
  })

  it('lets config keys win over variables, and treats empty values as unset', () => {
    const settings = resolveRedisSettings({
      config: { host: 'from-config', port: 7000, tls: false, prefix: '', username: '' },
      env: {
        REDIS_HOST: 'from-env',
        REDIS_PORT: '6000',
        REDIS_PREFIX: 'env:',
        REDIS_USERNAME: 'u',
      },
      appName: 'Ignored',
    })
    expect(settings).toMatchObject({
      host: 'from-config',
      port: 7000,
      prefix: 'env:',
      username: 'u',
      tls: false,
    })
    expect(
      resolveRedisSettings({ config: null, env: { REDIS_PASSWORD: '' } }).password,
    ).toBeUndefined()
  })

  it('derives the default prefix from the app name', () => {
    expect(resolveRedisSettings({ env: {}, appName: 'My Blög!' }).prefix).toBe('my_blog:')
    expect(resolveRedisSettings({ env: { APP_NAME: 'Shop' } }).prefix).toBe('shop:')
    expect(defaultPrefix('---')).toBe('strutvane:')
    expect(defaultPrefix(undefined)).toBe('strutvane:')
    expect(defaultPrefix('x'.repeat(200))).toHaveLength(65)
  })

  it('parses REDIS_URL, which wins over the separate keys', () => {
    const settings = resolveRedisSettings({
      env: {
        REDIS_URL: 'rediss://app:p%40ss%3Aw0rd@cache.example.com:6390/4',
        REDIS_HOST: 'ignored',
        REDIS_PASSWORD: 'ignored',
      },
    })
    expect(settings).toMatchObject({
      host: 'cache.example.com',
      port: 6390,
      username: 'app',
      password: 'p@ss:w0rd',
      database: 4,
      tls: true,
    })
    const plain = resolveRedisSettings({
      env: {
        REDIS_URL: 'redis://[::1]',
        REDIS_PASSWORD: 'kept',
        REDIS_DB: '2',
        REDIS_USERNAME: 'u',
      },
    })
    expect(plain).toMatchObject({
      host: '::1',
      port: 6379,
      password: 'kept',
      database: 2,
      username: 'u',
      tls: false,
    })
    expect(resolveRedisSettings({ env: { REDIS_URL: 'redis://h', REDIS_TLS: 'true' } }).tls).toBe(
      true,
    )
  })

  it('never downgrades a rediss:// URL to plain text', () => {
    expect(
      failure(() =>
        resolveRedisSettings({ env: { REDIS_URL: 'rediss://h:1', REDIS_TLS: 'false' } }),
      ).code,
    ).toBe('invalid_redis_config')
  })

  it('refuses bad values with invalid_redis_config', () => {
    const cases: Record<string, string>[] = [
      { REDIS_PORT: 'abc' },
      { REDIS_PORT: '0' },
      { REDIS_PORT: '65536' },
      { REDIS_PORT: '-1' },
      { REDIS_DB: '1.5' },
      { REDIS_DB: '1024' },
      { REDIS_TLS: 'maybe' },
      { REDIS_PREFIX: 'has space' },
      { REDIS_CONNECT_TIMEOUT: '0' },
      { REDIS_COMMAND_TIMEOUT: '600001' },
      { REDIS_URL: 'not a url' },
      { REDIS_URL: 'http://example.com' },
      { REDIS_URL: 'redis://h/abc' },
      { REDIS_URL: 'redis://h:99999' },
      { REDIS_URL: 'redis://u:%E0%A4%A@h' },
    ]
    for (const env of cases)
      expect(failure(() => resolveRedisSettings({ env })).code).toBe('invalid_redis_config')
  })

  it('refuses secrets and unknown keys in the config tree', () => {
    expect(
      failure(() => resolveRedisSettings({ config: { password: 'x' }, env: {} })).message,
    ).toMatch(/password/)
    expect(
      failure(() => resolveRedisSettings({ config: { url: 'redis://h' }, env: {} })).message,
    ).toMatch(/url/)
    expect(failure(() => resolveRedisSettings({ config: { hots: 'x' }, env: {} })).message).toMatch(
      /hots/,
    )
    expect(failure(() => resolveRedisSettings({ config: 'redis://h', env: {} })).code).toBe(
      'invalid_redis_config',
    )
    expect(failure(() => resolveRedisSettings({ config: [], env: {} })).code).toBe(
      'invalid_redis_config',
    )
    expect(failure(() => resolveRedisSettings({ config: { host: { a: 1 } }, env: {} })).code).toBe(
      'invalid_redis_config',
    )
  })

  it('never echoes a URL or password in an error (fuzzed)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 6, maxLength: 40 }),
        fc.string({ maxLength: 30 }),
        (secret, junk) => {
          const marker = `S3CR3T${secret.replace(/[^A-Za-z0-9]/g, '')}`
          for (const url of [
            `redis://u:${marker}@${junk}`,
            `${junk}://${marker}`,
            `redis://u:${marker}@h:${junk}`,
          ]) {
            try {
              resolveRedisSettings({ env: { REDIS_URL: url } })
            } catch (error) {
              expect(isBootError(error)).toBe(true)
              const text = `${(error as Error).message} ${JSON.stringify(error)}`
              expect(text).not.toContain(marker)
            }
          }
        },
      ),
      { numRuns: 300 },
    )
  })

  it('describes settings without secrets', () => {
    const settings = resolveRedisSettings({ env: { REDIS_URL: 'redis://app:topsecret@h:1/2' } })
    const described = JSON.stringify(describeSettings(settings))
    expect(described).not.toContain('topsecret')
    expect(describeSettings(settings)).toMatchObject({
      acl_user: 'app',
      authenticated: true,
      database: 2,
    })
    expect(describeSettings(resolveRedisSettings({ env: {} }))).toMatchObject({
      acl_user: 'default',
      authenticated: false,
    })
  })
})
