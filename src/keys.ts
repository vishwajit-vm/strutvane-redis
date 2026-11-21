/**
 * Key spaces: every key this package writes is `<app prefix><area>:<key>`, optionally with a
 * tenant segment, `<app prefix><area>:t:<tenant>:<key>`.
 *
 * **Why:** one Redis is often shared by several apps (and several environments of one app), and a
 * multi-tenant app must never let tenant A read, overwrite or flush tenant B's entries. Prefixes
 * are how Redis users isolate data; this module makes them impossible to get wrong:
 *
 * - **App prefixes never overlap.** The app prefix is always exactly two parts, the app and its
 *   environment, each followed by `:` (`blog:production:`), and a part can't contain `:`. So no
 *   two different prefixes start one another (`blog:` could otherwise flush `blog:production:`).
 * - **Tenant ids are validated, not escaped.** A tenant id may only contain letters, digits, `_`
 *   and `-` (UUIDs, ULIDs, slugs and numbers fit). A tenant called `a:t:b` could otherwise reach
 *   into another tenant's namespace, so anything else is refused (fail closed).
 * - **The tenant marker can't be forged from a key.** The tenant segment is `t:<id>:`, and a
 *   global (non-tenant) key may not start with `t:`, so a global key can never alias a tenant key.
 * - **Flushing matches the prefix literally.** `SCAN MATCH` takes a glob, so `*`, `?`, `[`, `]`
 *   and `\` in a prefix are escaped; an app prefixed `a*` can't flush app `ab`'s keys.
 * - **Keys are bounded.** Empty keys and keys over 1 KiB are refused: long keys are almost always
 *   a bug (a whole payload used as a key) and cost memory on every lookup.
 *
 * Keys travel as RESP bulk strings (length-prefixed), so a key containing CR/LF or spaces cannot
 * inject a command; such keys are stored literally.
 *
 * @module
 */

/** The longest key (in UTF-8 bytes) this package accepts from callers. */
export const MAX_KEY_BYTES = 1024

const TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/
const SEGMENT = /^[a-z][a-z0-9_-]{0,31}$/
/** An app prefix: two parts of letters, digits and `_ . -` (never `:`), each ending with `:`. */
const PREFIX = /^[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,64}:$/
const TENANT_MARKER = 't:'

/**
 * Check an app prefix (`REDIS_PREFIX`): exactly two parts, the app then the environment, each
 * followed by `:`; a part is 1 to 64 letters, digits, `_`, `.` or `-`. Returns an error message,
 * or `undefined` when it is fine.
 *
 * **Why exactly two parts:** with a fixed number of `:`-terminated parts, no valid prefix is the
 * start of another (`blog:` vs `blog:production:`), so one app's flush pattern can never match
 * another app's keys on a shared Redis.
 *
 * @example
 * prefixProblem('blog:production:') // undefined
 * prefixProblem('blog:')            // 'must be two parts …'
 */
export function prefixProblem(prefix: string): string | undefined {
  return PREFIX.test(prefix)
    ? undefined
    : 'must be two parts, the app then the environment, each ending with ":" (letters, digits, _ . - only; up to 64 characters each), such as blog:production:'
}

/**
 * Whether a tenant id can be used in a key (letters, digits, `_` and `-`; 1 to 128 characters).
 *
 * @example
 * isValidTenantId('acme-1') // true
 * isValidTenantId('a:t:b')  // false
 */
export function isValidTenantId(id: string): boolean {
  return TENANT_ID.test(id)
}

/**
 * Escape a literal string for a Redis glob pattern (`SCAN MATCH`, `KEYS`).
 *
 * @example
 * globEscape('app*[1]') // 'app\\*\\[1\\]'
 */
export function globEscape(literal: string): string {
  return literal.replace(/[*?[\]\\]/g, (char) => `\\${char}`)
}

/**
 * A namespace of keys. Immutable: {@link KeySpace.area} and {@link KeySpace.tenant} return new
 * spaces.
 *
 * @example
 * const cache = KeySpace.root('blog:prod:').area('cache')
 * cache.key('posts')                 // 'blog:prod:cache:posts'
 * cache.tenant('acme').key('posts')  // 'blog:prod:cache:t:acme:posts'
 */
export class KeySpace {
  /** The full prefix every key of this space starts with. */
  readonly prefix: string
  /** The tenant this space is scoped to, if any. */
  readonly tenantId: string | undefined
  readonly #areaPrefix: string

  private constructor(areaPrefix: string, tenantId: string | undefined) {
    this.#areaPrefix = areaPrefix
    this.tenantId = tenantId
    this.prefix = tenantId === undefined ? areaPrefix : `${areaPrefix}${TENANT_MARKER}${tenantId}:`
  }

  /**
   * The app-wide root (no area yet). Throws a `TypeError` for an invalid prefix.
   *
   * @example
   * KeySpace.root('blog:prod:')
   */
  static root(appPrefix: string): KeySpace {
    const problem = prefixProblem(appPrefix)
    if (problem !== undefined) throw new TypeError(`The Redis key prefix ${problem}.`)
    return new KeySpace(appPrefix, undefined)
  }

  /**
   * A sub-area (`cache`, `lock`, `session`, …): lowercase, starting with a letter.
   *
   * @example
   * KeySpace.root('blog:prod:').area('lock').key('reports') // 'blog:prod:lock:reports'
   */
  area(name: string): KeySpace {
    if (!SEGMENT.test(name))
      throw new TypeError(
        `"${name}" is not a valid key area: use lowercase letters, digits, _ and - (starting with a letter).`,
      )
    if (this.tenantId !== undefined)
      throw new TypeError('Choose the area before the tenant: space.area(name).tenant(id).')
    return new KeySpace(`${this.#areaPrefix}${name}:`, undefined)
  }

  /**
   * The same area scoped to one tenant. Throws a `TypeError` for an id that could escape its
   * namespace (see the module notes); re-scoping a tenant space is refused too.
   *
   * @example
   * space.tenant('acme').key('stats') // '<prefix>t:acme:stats'
   */
  tenant(id: string): KeySpace {
    if (this.tenantId !== undefined)
      throw new TypeError('This key space is already scoped to a tenant.')
    if (!isValidTenantId(id))
      throw new TypeError(
        'A tenant id used in Redis keys may only contain letters, digits, _ and - (1 to 128 characters).',
      )
    return new KeySpace(this.#areaPrefix, id)
  }

  /**
   * The full key for `key`. Throws a `TypeError` for an empty or over-long key, or (in the global
   * space) a key that starts with the tenant marker `t:`.
   *
   * @example
   * KeySpace.root('blog:prod:').area('cache').key('posts:1') // 'blog:prod:cache:posts:1'
   */
  key(key: string): string {
    if (typeof key !== 'string' || key.length === 0)
      throw new TypeError('A Redis key must be a non-empty string.')
    if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES)
      throw new TypeError(`A Redis key may be at most ${MAX_KEY_BYTES} bytes.`)
    if (this.tenantId === undefined && key.startsWith(TENANT_MARKER))
      throw new TypeError(
        'Keys starting with "t:" are reserved for tenant scopes; use space.tenant(id).key(...).',
      )
    return `${this.prefix}${key}`
  }

  /**
   * The `SCAN MATCH` pattern for every key in this space (and, for a global space, every tenant's
   * keys under it too: flushing an area clears it for all tenants).
   *
   * @example
   * KeySpace.root('blog:prod:').area('cache').pattern() // 'blog:prod:cache:*'
   */
  pattern(): string {
    return `${globEscape(this.prefix)}*`
  }
}
