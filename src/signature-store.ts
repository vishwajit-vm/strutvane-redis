/**
 * One-time signed URLs across processes: a Redis implementation of the framework's
 * `UsedSignatureStore` (`claim` = "record this signature as used; `true` only the first time").
 *
 * `SET <sha256(signature)> 1 NX PXAT <expiresAt>`: only one claim can win, and the record expires
 * with the URL itself, so the set never grows past the live signatures.
 *
 * The framework does not export `UsedSignatureStoreToken` from its public entry yet, so an app
 * can't bind this store through the container today (see NEXT.md, framework proposals). It is
 * shipped and tested so the binding is one line once the token is public.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import type { RedisDriver } from './driver.ts'
import type { KeySpace } from './keys.ts'

/**
 * The framework's `UsedSignatureStore` shape.
 *
 * @example
 * const store: UsedSignatureStoreLike = new RedisUsedSignatureStore({ driver, space })
 */
export interface UsedSignatureStoreLike {
  claim(signature: string, expiresAt: number): Promise<boolean>
}

/**
 * Used-signature records in Redis.
 *
 * @example
 * const first = await store.claim(signature, expiresAtMs) // true, then false for a replay
 */
export class RedisUsedSignatureStore implements UsedSignatureStoreLike {
  readonly #driver: RedisDriver
  readonly #space: KeySpace

  constructor(options: { readonly driver: RedisDriver; readonly space: KeySpace }) {
    this.#driver = options.driver
    this.#space = options.space
  }

  async claim(signature: string, expiresAt: number): Promise<boolean> {
    // An expired (or nonsensical) expiry is refused: fail closed, never "first use".
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false
    const key = this.#space.key(createHash('sha256').update(signature).digest('hex'))
    const reply = await this.#driver.command(['SET', key, '1', 'NX', 'PXAT', String(expiresAt)])
    return reply !== null && reply !== undefined
  }
}
