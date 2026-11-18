/**
 * The error codes this package raises, in the framework's one error model (RFC 9457 `Problem`
 * with a stable lowercase `code`, RFC-0003). The provider registers them with the app's error
 * registry at boot, and the English catalog below gives clients a friendly title and detail.
 *
 * - `redis_unavailable` (503): the server can't be reached, timed out, or refused the login. The
 *   caller learns nothing about the server (no host, no reply text); the log has the details.
 * - `lock_timeout` (503): `lock.block()` waited the full time and someone else still holds it.
 *
 * Boot-time problems (a bad `REDIS_*` value) are `BootError`s with the code `invalid_redis_config`,
 * because they stop the app before it serves anything.
 *
 * @module
 */

import type { ErrorDefinition } from '@strutvane/framework/core'
import { StrutvaneError } from '@strutvane/framework/core'

/** The package name, recorded as the owner of each error code. */
export const PACKAGE_NAME = '@strutvane/redis'

/**
 * The error definitions the provider registers.
 *
 * @example
 * for (const definition of REDIS_ERRORS) registry.register(definition)
 */
export const REDIS_ERRORS: readonly ErrorDefinition[] = Object.freeze([
  Object.freeze({
    code: 'redis_unavailable',
    status: 503,
    title: 'Service temporarily unavailable',
    owner: PACKAGE_NAME,
  }),
  Object.freeze({
    code: 'lock_timeout',
    status: 503,
    title: 'Resource busy',
    owner: PACKAGE_NAME,
  }),
])

/**
 * The English message catalog for the codes above (RFC-0003 keys).
 *
 * @example
 * REDIS_MESSAGES_EN['errors.lock_timeout.detail']
 */
export const REDIS_MESSAGES_EN: Readonly<Record<string, string>> = Object.freeze({
  'errors.redis_unavailable.title': 'Service temporarily unavailable',
  'errors.redis_unavailable.detail': 'The server is busy. Please try again in a moment.',
  'errors.lock_timeout.title': 'Resource busy',
  'errors.lock_timeout.detail': 'Someone else is working on this right now. Please try again.',
})

/**
 * A 503 `redis_unavailable` error. The cause stays on the error for the log, never for the client.
 *
 * @example
 * throw redisUnavailable('connect', cause)
 */
export function redisUnavailable(operation: string, cause?: unknown): StrutvaneError {
  return new StrutvaneError('redis_unavailable', {
    status: 503,
    params: { operation },
    headers: { 'Retry-After': '1' },
    ...(cause === undefined ? {} : { cause }),
  })
}

/**
 * A 503 `lock_timeout` error for the lock `name` (the name is the app's own key, never a secret).
 *
 * @example
 * throw lockTimeout('reports:build', 10)
 */
export function lockTimeout(name: string, waitedSeconds: number): StrutvaneError {
  return new StrutvaneError('lock_timeout', {
    status: 503,
    params: { lock: name, waited_seconds: waitedSeconds },
    headers: { 'Retry-After': '1' },
  })
}
