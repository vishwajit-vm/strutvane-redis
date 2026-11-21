import { isBootError } from '@strutvane/framework'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  defaultPrefix,
  describeSettings,
  type ResolveOptions,
  resolveRedisSettings,
} from '../../src/config.ts'
import { KeySpace } from '../../src/keys.ts'
import { globMatch } from '../support/glob.ts'

const failure = (run: () => unknown): { code: string; message: string } => {
  try {
    run()
  } catch (error) {
    expect(isBootError(error)).toBe(true)
    return { code: (error as { code: string }).code, message: String((error as Error).message) }
  }
  throw new Error('expected a BootError')
}

/** Resolve outside production (the production rules have their own tests). */
const resolve = (options: ResolveOptions) =>
  resolveRedisSettings({ environment: 'local', ...options })

describe('resolveRedisSettings', () => {
  it('has safe defaults', () => {
    expect(resolve({ env: {} })).toEqual({
      host: '127.0.0.1',
      port: 6379,
      username: undefined,
      password: undefined,
      database: 0,
      tls: false,
      tlsCaFile: undefined,
      tlsServername: undefined,
      prefix: 'strutvane:local:',
      connectTimeoutMs: 5000,
      commandTimeoutMs: 5000,
    })
  })

  it('reads the REDIS_* variables', () => {
    const settings = resolve({
      env: {
        REDIS_HOST: 'cache.internal',
        REDIS_PORT: '6380',
        REDIS_USERNAME: 'app',
        REDIS_PASSWORD: 's3cret',
        REDIS_DB: '3',
        REDIS_TLS: 'yes',
        REDIS_TLS_CA: '/etc/ca.pem',
        REDIS_TLS_SERVERNAME: 'cache.example.com',
        REDIS_PREFIX: 'blog:local:',
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
      prefix: 'blog:local:',
      connectTimeoutMs: 100,
      commandTimeoutMs: 200,
    })
  })

  it('lets config keys win over variables, and treats empty values as unset', () => {
    const settings = resolve({
      config: { host: 'from-config', port: 7000, tls: false, prefix: '', username: '' },
      env: {
        REDIS_HOST: 'from-env',
        REDIS_PORT: '6000',
        REDIS_PREFIX: 'env:local:',
        REDIS_USERNAME: 'u',
      },
      appName: 'Ignored',
    })
    expect(settings).toMatchObject({
      host: 'from-config',
      port: 7000,
      prefix: 'env:local:',
      username: 'u',
      tls: false,
    })
    expect(resolve({ config: null, env: { REDIS_PASSWORD: '' } }).password).toBeUndefined()
  })

  it('derives the default prefix from the app name', () => {
    expect(resolve({ env: {}, appName: 'My Blög!' }).prefix).toBe('my_blog:local:')
    expect(resolve({ env: { APP_NAME: 'Shop' } }).prefix).toBe('shop:local:')
    expect(defaultPrefix('---')).toBe('strutvane:production:')
    expect(defaultPrefix(undefined, 'Staging 2')).toBe('strutvane:staging_2:')
    expect(defaultPrefix('x'.repeat(200), 'y'.repeat(200))).toHaveLength(130)
  })

  it('reads the environment from APP_ENV, else production, for the default prefix', () => {
    const named = { APP_NAME: 'Shop' }
    expect(resolveRedisSettings({ env: { ...named, APP_ENV: 'staging' } }).prefix).toBe(
      'shop:staging:',
    )
    expect(resolveRedisSettings({ env: named }).prefix).toBe('shop:production:')
    expect(
      resolveRedisSettings({ env: { ...named, APP_ENV: 'local' }, environment: 'testing' }).prefix,
    ).toBe('shop:testing:')
  })

  it('refuses the shared fallback prefix in production, with a hint', () => {
    for (const env of [{}, { APP_NAME: '' }, { APP_NAME: '---' }, { APP_NAME: 'Strutvane' }]) {
      const error = failure(() => resolveRedisSettings({ env, environment: 'production' }))
      expect(error.code).toBe('invalid_redis_config')
      expect(error.message).toMatch(/APP_NAME/)
    }
    // A custom prefix, or a named app, is fine.
    expect(resolveRedisSettings({ env: { REDIS_PREFIX: 'strutvane:production:' } }).prefix).toBe(
      'strutvane:production:',
    )
    expect(resolve({ env: {} }).prefix).toBe('strutvane:local:')
  })

  it('refuses a REDIS_PREFIX that is not two parts ending with ":"', () => {
    for (const REDIS_PREFIX of ['blog', 'blog:', 'blog:prod', 'a:b:c:', ':prod:', 'a b:prod:'])
      expect(failure(() => resolve({ env: { REDIS_PREFIX } })).message).toMatch(/two parts/)
  })

  it('no two configurations get overlapping prefixes or flush each other (property)', () => {
    const text = fc.oneof(
      fc.constantFrom('Blog', 'blog', 'Blog 2', 'Strutvane', '', 'a:b', 'shop', 'Shop!'),
      fc.string({ maxLength: 12 }),
    )
    const part = fc.stringMatching(/^[A-Za-z0-9_.-]{1,8}$/)
    const configuration = fc.record({
      prefix: fc.option(
        fc.tuple(part, part).map(([app, env]) => `${app}:${env}:`),
        { nil: undefined },
      ),
      appName: fc.option(text, { nil: undefined }),
      environment: fc.oneof(fc.constantFrom('local', 'testing', 'staging', 'production'), text),
    })
    const settle = (config: {
      prefix: string | undefined
      appName: string | undefined
      environment: string
    }): string | undefined => {
      try {
        return resolveRedisSettings({
          env: config.prefix === undefined ? {} : { REDIS_PREFIX: config.prefix },
          environment: config.environment,
          ...(config.appName === undefined ? {} : { appName: config.appName }),
        }).prefix
      } catch {
        return undefined // refused (the production fallback): nothing to compare
      }
    }
    const area = fc.constantFrom('cache', 'lock', 'session', 'rate', 'queue', 'reports')
    const key = fc.string({ minLength: 1, maxLength: 12 }).filter((k) => !k.startsWith('t:'))
    fc.assert(
      fc.property(configuration, configuration, area, area, key, (one, two, areaA, areaB, k) => {
        const a = settle(one)
        const b = settle(two)
        if (a === undefined || b === undefined || a === b) return
        expect(a.startsWith(b) || b.startsWith(a)).toBe(false)
        const spaceA = KeySpace.root(a)
        const spaceB = KeySpace.root(b)
        expect(globMatch(spaceA.area(areaA).pattern(), spaceB.area(areaB).key(k))).toBe(false)
        expect(globMatch(spaceB.area(areaB).pattern(), spaceA.area(areaA).key(k))).toBe(false)
      }),
      { numRuns: 2000 },
    )
  })

  it('parses REDIS_URL, which wins over the separate keys', () => {
    const settings = resolve({
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
    const plain = resolve({
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
    expect(resolve({ env: { REDIS_URL: 'redis://h', REDIS_TLS: 'true' } }).tls).toBe(true)
  })

  it('never downgrades a rediss:// URL to plain text', () => {
    expect(
      failure(() => resolve({ env: { REDIS_URL: 'rediss://h:1', REDIS_TLS: 'false' } })).code,
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
      expect(failure(() => resolve({ env })).code).toBe('invalid_redis_config')
  })

  it('refuses secrets and unknown keys in the config tree', () => {
    expect(failure(() => resolve({ config: { password: 'x' }, env: {} })).message).toMatch(
      /password/,
    )
    expect(failure(() => resolve({ config: { url: 'redis://h' }, env: {} })).message).toMatch(/url/)
    expect(failure(() => resolve({ config: { hots: 'x' }, env: {} })).message).toMatch(/hots/)
    expect(failure(() => resolve({ config: 'redis://h', env: {} })).code).toBe(
      'invalid_redis_config',
    )
    expect(failure(() => resolve({ config: [], env: {} })).code).toBe('invalid_redis_config')
    expect(failure(() => resolve({ config: { host: { a: 1 } }, env: {} })).code).toBe(
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
              resolve({ env: { REDIS_URL: url } })
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
    const settings = resolve({ env: { REDIS_URL: 'redis://app:topsecret@h:1/2' } })
    const described = JSON.stringify(describeSettings(settings))
    expect(described).not.toContain('topsecret')
    expect(describeSettings(settings)).toMatchObject({
      acl_user: 'app',
      authenticated: true,
      database: 2,
    })
    expect(describeSettings(resolve({ env: {} }))).toMatchObject({
      acl_user: 'default',
      authenticated: false,
    })
  })
})
