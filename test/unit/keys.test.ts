import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  globEscape,
  isValidTenantId,
  KeySpace,
  MAX_KEY_BYTES,
  prefixProblem,
} from '../../src/keys.ts'

/** A minimal Redis-style glob matcher (`*`, `?`, `[...]`, `\` escapes), to check patterns. */
function globMatch(pattern: string, text: string): boolean {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? ''
    if (char === '\\') source += `\\${pattern[++i] ?? ''}`
    else if (char === '*') source += '[\\s\\S]*'
    else if (char === '?') source += '[\\s\\S]'
    else if (char === '[') {
      const end = pattern.indexOf(']', i + 1)
      source += end === -1 ? '\\[' : `[${pattern.slice(i + 1, end).replace(/\\/g, '\\\\')}]`
      if (end !== -1) i = end
    } else source += char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'u').test(text)
}

describe('KeySpace', () => {
  it('builds app, area and tenant keys', () => {
    const cache = KeySpace.root('blog:').area('cache')
    expect(cache.key('posts')).toBe('blog:cache:posts')
    expect(cache.tenant('acme').key('posts')).toBe('blog:cache:t:acme:posts')
    expect(cache.tenant('acme').tenantId).toBe('acme')
    expect(cache.tenantId).toBeUndefined()
    expect(KeySpace.root('').area('lock').key('x')).toBe('lock:x')
    expect(cache.pattern()).toBe('blog:cache:*')
  })

  it('refuses unsafe prefixes, areas, tenants and keys', () => {
    expect(() => KeySpace.root('a b')).toThrow(TypeError)
    expect(() => KeySpace.root('x'.repeat(129))).toThrow(TypeError)
    const root = KeySpace.root('app:')
    for (const area of ['', 'Cache', '1x', 'a:b', 'a*', 'x'.repeat(33)])
      expect(() => root.area(area)).toThrow(TypeError)
    expect(() => root.area('cache').tenant('a').area('x')).toThrow(TypeError)
    expect(() => root.area('cache').tenant('a').tenant('b')).toThrow(TypeError)
    const cache = root.area('cache')
    expect(() => cache.key('')).toThrow(TypeError)
    expect(() => cache.key('t:acme:x')).toThrow(TypeError)
    expect(() => cache.key(1 as unknown as string)).toThrow(TypeError)
    expect(() => cache.key('é'.repeat(MAX_KEY_BYTES / 2 + 1))).toThrow(TypeError)
    expect(cache.key('k'.repeat(MAX_KEY_BYTES))).toHaveLength(MAX_KEY_BYTES + 'app:cache:'.length)
    expect(cache.tenant('acme').key('t:fine-inside-a-tenant')).toBe(
      'app:cache:t:acme:t:fine-inside-a-tenant',
    )
  })

  it('validates tenant ids and prefixes', () => {
    expect(isValidTenantId('0190f2c4-5d1e-7a2b-9c3d-4e5f6a7b8c9d')).toBe(true)
    expect(isValidTenantId('01J9ZK5V8Q')).toBe(true)
    for (const id of ['', 'a:b', 'a b', 'a*', 'a/b', 'a\nb', 'é'])
      expect(isValidTenantId(id)).toBe(false)
    expect(prefixProblem('blog:v2.prod-1_')).toBeUndefined()
    expect(prefixProblem('a*b')).toMatch(/may only contain/)
  })

  it('escapes glob characters', () => {
    expect(globEscape('a*b?c[d]e\\f')).toBe('a\\*b\\?c\\[d\\]e\\\\f')
    expect(globMatch(`${globEscape('a*[x]?')}*`, 'a*[x]?:k')).toBe(true)
    expect(globMatch(`${globEscape('a*')}*`, 'ab:k')).toBe(false)
  })

  it('no two different (tenant, key) pairs share a full key (property)', () => {
    const tenant = fc.option(fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/), { nil: undefined })
    const key = fc.string({ minLength: 1, maxLength: 20 })
    const cache = KeySpace.root('app:').area('cache')
    const full = (t: string | undefined, k: string): string | undefined => {
      try {
        return (t === undefined ? cache : cache.tenant(t)).key(k)
      } catch {
        return undefined
      }
    }
    fc.assert(
      fc.property(tenant, key, tenant, key, (t1, k1, t2, k2) => {
        const a = full(t1, k1)
        const b = full(t2, k2)
        if (a === undefined || b === undefined) return
        if (t1 !== t2 || k1 !== k2) expect(a).not.toBe(b)
      }),
      { numRuns: 2000 },
    )
  })

  it("a tenant's flush pattern never matches another tenant's or a global key (property)", () => {
    const id = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/)
    const key = fc.string({ minLength: 1, maxLength: 12 })
    const prefix = fc.stringMatching(/^[A-Za-z0-9_.:*?-]{0,10}$/)
    fc.assert(
      fc.property(prefix, id, id, key, (rawPrefix, a, b, k) => {
        const safePrefix = rawPrefix.replace(/[*?]/g, '')
        const cache = KeySpace.root(safePrefix).area('cache')
        const pattern = cache.tenant(a).pattern()
        if (a !== b) expect(globMatch(pattern, cache.tenant(b).key(k))).toBe(false)
        expect(globMatch(pattern, cache.tenant(a).key(k))).toBe(true)
        // A key starting with "t:" is refused globally: nothing to compare then.
        const globalKey = k.startsWith('t:') ? undefined : cache.key(k)
        if (globalKey !== undefined) expect(globMatch(pattern, globalKey)).toBe(false)
        // The app-wide pattern covers every tenant of the area.
        expect(globMatch(cache.pattern(), cache.tenant(a).key(k))).toBe(true)
      }),
      { numRuns: 1000 },
    )
  })
})
