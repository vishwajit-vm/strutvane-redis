/**
 * The key areas this package's own stores write under the app prefix (`<prefix><area>:…`).
 *
 * **Why they are reserved:** a cache store configured with one of these as its `area` would share
 * keys with sessions, locks or rate-limit counters, so `cache:clear` on that store would sign
 * everyone out or release locks, and cache entries could collide with them. `config/cache.ts` may
 * not use them (see `cache-manager.ts`). Every store in this package takes its area from here;
 * `test/unit/areas.test.ts` fails when code names an area that is not listed.
 *
 * @module
 */

/**
 * The internal areas, by use.
 *
 * @example
 * root.area(INTERNAL_AREAS.lock).key('reports') // '<prefix>lock:reports'
 */
export const INTERNAL_AREAS: Readonly<{
  lock: 'lock'
  rate: 'rate'
  session: 'session'
  idempotency: 'idempotency'
  queue: 'queue'
  signature: 'signature'
}> = Object.freeze({
  lock: 'lock',
  rate: 'rate',
  session: 'session',
  idempotency: 'idempotency',
  queue: 'queue',
  signature: 'signature',
} as const)

/**
 * Areas a cache store may not use.
 *
 * @example
 * RESERVED_AREAS.has('session') // true
 */
export const RESERVED_AREAS: ReadonlySet<string> = new Set(Object.values(INTERNAL_AREAS))
