import type { EnvVar, InstallContext } from '@strutvane/framework/contracts'
import { describe, expect, it } from 'vitest'
import {
  addConfigFile,
  addProvider,
  allowRedisSessions,
  CONFIG_FILE,
  ENV_KEYS,
  installer,
  removeConfigFile,
  removeProvider,
} from '../../src/installer.ts'

const PROVIDERS = `// The service providers that run at boot.
import type { AnyProvider } from '@strutvane/framework'
import { AppServiceProvider } from '../app/providers/app.provider.ts'

const providers: readonly AnyProvider[] = [AppServiceProvider]

export default providers
`

const CONFIG_INDEX = `import type { ConfigFiles } from '@strutvane/framework'
import app from './app.ts'
import cache from './cache.ts'

export default { app, cache } satisfies ConfigFiles
`

const SESSION = `export default defineConfig((env) => ({
  driver: env.oneOf('SESSION_DRIVER', ['file'], 'file'),
}))
`

/** An in-memory project, recording env changes and log lines like the devkit context. */
function project(files: Record<string, string>) {
  const fs = new Map(Object.entries(files))
  const env = new Map<string, EnvVar>()
  const lines: string[] = []
  const context: InstallContext = {
    projectRoot: '/app',
    answers: {},
    dryRun: false,
    has: () => false,
    fs: {
      exists: async (path) => fs.has(path),
      read: async (path) => {
        const content = fs.get(path)
        if (content === undefined) throw new Error(`missing ${path}`)
        return content
      },
      write: async (path, content, options) => {
        if (fs.has(path) && options?.overwrite !== true) throw new Error(`exists ${path}`)
        fs.set(path, content)
      },
      remove: async (path) => {
        fs.delete(path)
      },
    },
    env: {
      add: async (_section, vars) => {
        for (const variable of vars) if (!env.has(variable.key)) env.set(variable.key, variable)
      },
      remove: async (keys) => {
        for (const key of keys) env.delete(key)
      },
    },
    deps: { add: async () => {}, remove: async () => {} },
    config: { registerProvider: async () => {}, unregisterProvider: async () => {} },
    log: {
      info: (line) => void lines.push(`info: ${line}`),
      warn: (line) => void lines.push(`warn: ${line}`),
    },
  }
  return { context, fs, env, lines }
}

describe('provider registration', () => {
  it('adds the provider and its import, idempotently, and removes exactly that', () => {
    const added = addProvider(PROVIDERS) ?? ''
    expect(added).toContain(
      "import { RedisServiceProvider } from '@strutvane/redis/provider'\n\nconst",
    )
    expect(added).toContain('[AppServiceProvider, RedisServiceProvider]')
    expect(addProvider(added)).toBe(added)
    expect(removeProvider(added)).toBe(PROVIDERS)
  })

  it('follows a multi-line array and an empty one', () => {
    const multi = PROVIDERS.replace(
      '[AppServiceProvider]',
      '[\n  AppServiceProvider,\n  OtherProvider\n]',
    )
    const added = addProvider(multi) ?? ''
    expect(added).toContain(
      '[\n  AppServiceProvider,\n  OtherProvider,\n  RedisServiceProvider,\n]',
    )
    expect(removeProvider(added)).toContain('[\n  AppServiceProvider,\n  OtherProvider\n]')
    const empty = addProvider(PROVIDERS.replace('[AppServiceProvider]', '[]')) ?? ''
    expect(empty).toContain('= [RedisServiceProvider]')
    expect(removeProvider(empty)).toContain('= []')
    const trailing = PROVIDERS.replace('[AppServiceProvider]', '[\n  AppServiceProvider,\n]')
    expect(addProvider(trailing)).toContain('[\n  AppServiceProvider,\n  RedisServiceProvider,\n]')
    expect(addProvider('const providers = [A,]')).toContain('[A, RedisServiceProvider]')
    expect(addProvider('const providers = [A]')).toBe(
      "import { RedisServiceProvider } from '@strutvane/redis/provider'\nconst providers = [A, RedisServiceProvider]",
    )
  })

  it('leaves an unexpected file shape alone', () => {
    expect(addProvider('export default [AppServiceProvider]')).toBeUndefined()
  })
})

describe('config/index.ts registration', () => {
  it('adds redis in sorted order with its import, idempotently, and removes it', () => {
    const added = addConfigFile(CONFIG_INDEX) ?? ''
    expect(added).toContain("import redis from './redis.ts'\n")
    expect(added).toContain('export default { app, cache, redis } satisfies ConfigFiles')
    expect(addConfigFile(added)).toBe(added)
    expect(removeConfigFile(added)).toBe(CONFIG_INDEX)
    expect(addConfigFile('export default {}')).toBe(
      "import redis from './redis.ts'\nexport default { redis }",
    )
    expect(addConfigFile('module.exports = {}')).toBeUndefined()
  })
})

describe('session driver choices', () => {
  it("allows 'redis' once and recognises an edited file", () => {
    const allowed = allowRedisSessions(SESSION) ?? ''
    expect(allowed).toContain("['file', 'redis']")
    expect(allowRedisSessions(allowed)).toBe(allowed)
    expect(allowRedisSessions("driver: 'file'")).toBeUndefined()
  })
})

describe('installer', () => {
  it('sets up a skeleton app completely; a second run changes nothing', async () => {
    const app = project({
      'bootstrap/providers.ts': PROVIDERS,
      'config/index.ts': CONFIG_INDEX,
      'config/session.ts': SESSION,
    })
    await installer.install(app.context)
    expect(app.fs.get('config/redis.ts')).toBe(CONFIG_FILE)
    expect(app.fs.get('bootstrap/providers.ts')).toContain('RedisServiceProvider]')
    expect(app.fs.get('config/index.ts')).toContain('{ app, cache, redis }')
    expect(app.fs.get('config/session.ts')).toContain("['file', 'redis']")
    expect([...app.env.keys()]).toEqual(ENV_KEYS)
    for (const secret of ['REDIS_URL', 'REDIS_PASSWORD'])
      expect(app.env.get(secret)?.value).toBe('')
    expect(app.lines.filter((line) => line.startsWith('warn'))).toEqual([])
    const snapshot = new Map(app.fs)
    await installer.install(app.context)
    expect(app.fs).toEqual(snapshot)
  })

  it('keeps an existing config/redis.ts and warns about files it cannot edit', async () => {
    const app = project({
      'config/redis.ts': 'mine',
      'config/index.ts': 'module.exports = {}',
      'config/session.ts': "driver: 'file'",
    })
    await installer.install(app.context)
    expect(app.fs.get('config/redis.ts')).toBe('mine')
    expect(app.lines.filter((line) => line.startsWith('warn'))).toEqual([
      "warn: config/index.ts has an unexpected shape: add `redis` (import redis from './redis.ts') to the object by hand.",
      "warn: bootstrap/providers.ts not found: add RedisServiceProvider (import { RedisServiceProvider } from '@strutvane/redis/provider') to the providers by hand.",
      "warn: config/session.ts: allow 'redis' in the SESSION_DRIVER choices to use Redis sessions.",
    ])
  })

  it('uninstall reverses the edits and keeps a changed config file', async () => {
    const app = project({
      'bootstrap/providers.ts': PROVIDERS,
      'config/index.ts': CONFIG_INDEX,
      'config/session.ts': SESSION,
    })
    await installer.install(app.context)
    await installer.uninstall?.(app.context)
    expect(app.fs.get('bootstrap/providers.ts')).toBe(PROVIDERS)
    expect(app.fs.get('config/index.ts')).toBe(CONFIG_INDEX)
    expect(app.fs.has('config/redis.ts')).toBe(false)
    expect(app.env.size).toBe(0)

    await installer.install(app.context)
    app.fs.set('config/redis.ts', `${CONFIG_FILE}// edited\n`)
    await installer.uninstall?.(app.context)
    expect(app.fs.has('config/redis.ts')).toBe(true)
    expect(app.lines.at(-2)).toMatch(/config\/redis.ts was changed/)

    const bare = project({})
    await installer.uninstall?.(bare.context)
    expect(bare.fs.size).toBe(0)
  })

  it('names itself for the CLI', () => {
    expect(installer.name).toBe('redis')
    expect(installer.description).toMatch(/Redis/)
  })
})
