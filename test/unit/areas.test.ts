/**
 * The reserved key areas: a cache store may not use an area this package's own stores write to,
 * and the list can't fall behind the code (the guard below reads every source file).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { INTERNAL_AREAS, RESERVED_AREAS } from '../../src/areas.ts'
import { createRedisCacheManager } from '../../src/cache-manager.ts'
import { KeySpace } from '../../src/keys.ts'

const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

/** Every `.area(…)` argument in the package's code (comments and docs left out). */
function areaArguments(): { readonly file: string; readonly argument: string }[] {
  const found: { file: string; argument: string }[] = []
  for (const entry of readdirSync(SRC, { recursive: true })) {
    const file = String(entry)
    // keys.ts defines KeySpace.area itself (its messages mention it).
    if (!file.endsWith('.ts') || file === 'keys.ts') continue
    const code = readFileSync(join(SRC, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
    for (const match of code.matchAll(/\.area\(\s*([^)]*?)\s*\)/g))
      found.push({ file: file.replaceAll('\\', '/'), argument: match[1] ?? '' })
  }
  return found
}

describe('reserved key areas', () => {
  it('lists every area the package writes to (guard: fails when a store adds an unlisted one)', () => {
    const calls = areaArguments()
    expect(calls.length).toBeGreaterThan(0)
    for (const { file, argument } of calls) {
      // The cache manager passes the configured (and checked) store area through.
      if (file === 'cache-manager.ts' && argument === 'area') continue
      const named = /^INTERNAL_AREAS\.(\w+)$/.exec(argument)
      if (named !== null) {
        expect(Object.keys(INTERNAL_AREAS), `${file}: ${argument}`).toContain(named[1])
        continue
      }
      const literal = /^(['"`])([^'"`]*)\1$/.exec(argument)
      expect(
        literal !== null && RESERVED_AREAS.has(literal[2] ?? ''),
        `${file}: .area(${argument}) is not in INTERNAL_AREAS (src/areas.ts); add it there`,
      ).toBe(true)
    }
  })

  it('reserves exactly the internal areas', () => {
    expect([...RESERVED_AREAS].sort()).toEqual(Object.values(INTERNAL_AREAS).sort())
    for (const area of ['session', 'idempotency', 'lock', 'rate', 'queue'])
      expect(RESERVED_AREAS.has(area)).toBe(true)
    expect(RESERVED_AREAS.has('cache')).toBe(false)
  })

  it('refuses a reserved area as a cache store area, and accepts others', () => {
    const make = (area: string) =>
      createRedisCacheManager({
        basePath: '.',
        clock: { now: () => Date.now() },
        config: { default: 'redis', stores: { shared: { driver: 'redis', area } } },
        driver: () => {
          throw new Error('not connected in this test')
        },
        root: KeySpace.root('app:test:'),
      })
    for (const area of RESERVED_AREAS) {
      let error: unknown
      try {
        make(area)
      } catch (caught) {
        error = caught
      }
      expect((error as { code?: string } | undefined)?.code, area).toBe('invalid_cache_config')
      expect(String((error as Error).message)).toContain(area)
    }
    expect(make('reports').storeNames).toContain('shared')
  })
})
