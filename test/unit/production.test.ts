/**
 * The production rules for a Redis on another machine: an explicit TLS choice and a password, with
 * loopback recognised in every spelling (so a remote host is never mistaken for a local one).
 */
import { isBootError } from '@strutvane/framework'
import { describe, expect, it } from 'vitest'
import { resolveRedisSettings } from '../../src/config.ts'
import { isLoopbackHost } from '../../src/loopback.ts'

const LOOPBACK = [
  'localhost',
  'LOCALHOST',
  'localhost.',
  '127.0.0.1',
  '127.10.20.30',
  '::1',
  '[::1]',
  '0:0:0:0:0:0:0:1',
  '[0:0:0:0:0:0:0:1]',
  '0000:0000:0000:0000:0000:0000:0000:0001',
  '::ffff:127.0.0.1',
  '[::ffff:127.0.0.1]',
  '::ffff:7f00:1',
  '0:0:0:0:0:ffff:127.1.2.3',
]
const REMOTE = [
  'cache.internal',
  '10.0.0.5',
  '0.0.0.0',
  '128.0.0.1',
  '::',
  '::2',
  '::ffff:10.0.0.5',
  '::ffff:8.8.8.8',
  '::127.0.0.1',
  '2001:db8::1',
  'fe80::1%eth0',
  '127.1',
  'localhost.example.com',
  '127.0.0.1.nip.io',
]

const outcome = (env: Record<string, string>, environment: string): string => {
  try {
    resolveRedisSettings({ env: { APP_NAME: 'Blog', ...env }, environment })
    return 'ok'
  } catch (error) {
    expect(isBootError(error)).toBe(true)
    const { code, message } = error as { code: string; message: string }
    return `${code}:${/TLS/.test(message) ? 'tls' : /password/.test(message) ? 'password' : '?'}`
  }
}

describe('isLoopbackHost', () => {
  it('recognises loopback in every spelling, and nothing else', () => {
    for (const host of LOOPBACK) expect(isLoopbackHost(host), host).toBe(true)
    for (const host of REMOTE) expect(isLoopbackHost(host), host).toBe(false)
  })
})

describe('production checks (host form × APP_ENV × REDIS_TLS)', () => {
  const tlsChoices: readonly (string | undefined)[] = [undefined, 'true', 'false']
  for (const environment of ['local', 'testing', 'staging', 'production'])
    for (const tls of tlsChoices)
      it(`APP_ENV=${environment}, REDIS_TLS=${tls ?? '(unset)'}`, () => {
        const tlsEnv: Record<string, string> = tls === undefined ? {} : { REDIS_TLS: tls }
        for (const host of [...LOOPBACK, ...REMOTE]) {
          // Brackets and zone ids are URL or socket spellings; the host variable takes the bare form.
          const env = { REDIS_HOST: host, REDIS_PASSWORD: 'pw-123456', ...tlsEnv }
          const expected =
            environment !== 'production' || isLoopbackHost(host) || tls !== undefined
              ? 'ok'
              : 'invalid_redis_config:tls'
          expect(outcome(env, environment), host).toBe(expected)
          // Without a password: refused only for a remote host in production (once TLS is chosen).
          const { REDIS_PASSWORD: _unused, ...withoutPassword } = env
          const remoteProduction = environment === 'production' && !isLoopbackHost(host)
          expect(outcome(withoutPassword, environment), host).toBe(
            !remoteProduction
              ? 'ok'
              : tls === undefined
                ? 'invalid_redis_config:tls'
                : 'invalid_redis_config:password',
          )
          // The explicit opt-out accepts a missing password.
          if (remoteProduction && tls !== undefined)
            expect(
              outcome({ ...withoutPassword, REDIS_ALLOW_NO_PASSWORD: 'true' }, environment),
            ).toBe('ok')
        }
      })

  it('treats a rediss:// URL as an explicit TLS choice, and redis:// as none', () => {
    expect(outcome({ REDIS_URL: 'rediss://app:pw@cache.internal:6380' }, 'production')).toBe('ok')
    expect(outcome({ REDIS_URL: 'redis://app:pw@cache.internal:6379' }, 'production')).toBe(
      'invalid_redis_config:tls',
    )
    expect(
      outcome(
        { REDIS_URL: 'redis://app:pw@cache.internal:6379', REDIS_TLS: 'false' },
        'production',
      ),
    ).toBe('ok')
    expect(outcome({ REDIS_URL: 'redis://[0:0:0:0:0:0:0:1]:6379' }, 'production')).toBe('ok')
    expect(outcome({ REDIS_URL: 'redis://[::ffff:127.0.0.1]:6379' }, 'production')).toBe('ok')
    expect(outcome({ REDIS_URL: 'redis://[::ffff:10.0.0.1]:6379' }, 'production')).toBe(
      'invalid_redis_config:tls',
    )
  })

  it('reads APP_ENV when no environment is given, defaulting to production', () => {
    const env = { APP_NAME: 'Blog', REDIS_HOST: 'cache.internal', REDIS_PASSWORD: 'pw-123456' }
    expect(() => resolveRedisSettings({ env })).toThrow(/explicit TLS choice/)
    expect(() => resolveRedisSettings({ env: { ...env, APP_ENV: 'staging' } })).not.toThrow()
  })

  it('refuses a REDIS_ALLOW_NO_PASSWORD that is not true or false', () => {
    expect(
      outcome(
        { REDIS_HOST: 'cache.internal', REDIS_TLS: 'true', REDIS_ALLOW_NO_PASSWORD: 'maybe' },
        'local',
      ),
    ).toBe('invalid_redis_config:?')
  })
})
