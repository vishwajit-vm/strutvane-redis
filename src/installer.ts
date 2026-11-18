/**
 * The installer (`node strut install:redis`, today `node strut add redis`): sets Redis up in an
 * app completely and idempotently (running it twice changes nothing the second time).
 *
 * 1. `config/redis.ts`: the non-secret connection settings, read from `.env`;
 * 2. `config/index.ts`: registers that file (`config('redis.host')`);
 * 3. `.env` and `.env.example`: the `REDIS_*` keys (empty secrets; never overwrites a value);
 * 4. `bootstrap/providers.ts`: adds `RedisServiceProvider`;
 * 5. `config/session.ts`: allows `SESSION_DRIVER=redis` (the skeleton only lists `file`).
 *
 * It does **not** switch `CACHE_STORE` or `SESSION_DRIVER`: the app keeps working exactly as
 * before until you choose Redis in `.env` (a running app must never start depending on a server
 * nobody set up yet).
 *
 * The app files are edited as text, only when they have the skeleton's shape; any other shape
 * is left untouched and the step is printed for you to do by hand (never a half-edited file).
 * Uninstall reverses each edit and keeps a `config/redis.ts` you changed.
 *
 * @module
 */
import type { InstallContext, Installer } from '@strutvane/framework/contracts'

const PROVIDER = 'RedisServiceProvider'
const PROVIDER_IMPORT = `import { ${PROVIDER} } from '@strutvane/redis/provider'`
const CONFIG_IMPORT = "import redis from './redis.ts'"
const SESSION_FILE_ONLY = "env.oneOf('SESSION_DRIVER', ['file'],"
const SESSION_WITH_REDIS = "env.oneOf('SESSION_DRIVER', ['file', 'redis'],"

/** The `config/redis.ts` the installer writes. */
export const CONFIG_FILE: string = `// Redis / Valkey connection settings (@strutvane/redis), read from .env.
//
// REDIS_URL and REDIS_PASSWORD are deliberately not here: the config tree is cached and easy to
// dump, so the package reads secrets from the environment only when it connects. REDIS_URL, when
// set, wins over host, port, user, password and database (rediss:// means TLS).
import { defineConfig } from '@strutvane/framework'
import type { RedisConfig } from '@strutvane/redis'

export default defineConfig(
  (env) =>
    ({
      /** The server. */
      host: env.string('REDIS_HOST', '127.0.0.1'),
      port: env.integer('REDIS_PORT', 6379),
      /** An ACL user (Redis 6+); empty means the default user. */
      username: env.string('REDIS_USERNAME', ''),
      /** The database number (0-15 on a default server). */
      database: env.integer('REDIS_DB', 0),
      /** TLS: true or false; empty follows REDIS_URL (rediss:// = TLS). Always verified. */
      tls: env.string('REDIS_TLS', ''),
      /** A PEM CA file for a private CA. */
      tls_ca: env.string('REDIS_TLS_CA', ''),
      /** Prefix for every key, so apps can share one server. Empty: the app name. */
      prefix: env.string('REDIS_PREFIX', ''),
    }) satisfies RedisConfig,
)
`

/** The `.env` keys the installer adds (and uninstall removes). */
export const ENV_KEYS: readonly string[] = [
  'REDIS_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_USERNAME',
  'REDIS_PASSWORD',
  'REDIS_DB',
  'REDIS_TLS',
  'REDIS_TLS_CA',
  'REDIS_PREFIX',
]

/**
 * Add the provider to `bootstrap/providers.ts` source; `undefined` when the file doesn't have the
 * skeleton's shape (`const providers … = [ … ]`). Unchanged source when already present.
 *
 * @example
 * addProvider("import x from 'y'\nconst providers: readonly AnyProvider[] = [AppServiceProvider]\n")
 */
export function addProvider(source: string): string | undefined {
  const array = /(const\s+providers\b[^=]*=\s*\[)([\s\S]*?)(\])/.exec(source)
  if (array === null) return undefined
  if (new RegExp(`\\b${PROVIDER}\\b`).test(array[2] ?? '')) return source
  const items = array[2] ?? ''
  const multiline = items.includes('\n')
  let replaced: string
  if (multiline) {
    const indent = /\n([ \t]+)\S/.exec(items)?.[1] ?? '  '
    const trimmed = items.replace(/\s*$/, '')
    const comma = trimmed === '' || trimmed.endsWith(',') ? '' : ','
    replaced = `${trimmed}${comma}\n${indent}${PROVIDER},\n`
  } else {
    const trimmed = items.trim().replace(/,$/, '')
    replaced = trimmed === '' ? PROVIDER : `${trimmed}, ${PROVIDER}`
  }
  const start = array.index + (array[1] ?? '').length
  const withItem = source.slice(0, start) + replaced + source.slice(start + items.length)
  return addImport(withItem, PROVIDER_IMPORT)
}

/**
 * Remove what {@link addProvider} added.
 *
 * @example
 * removeProvider(addProvider(source) ?? source) === source
 */
export function removeProvider(source: string): string {
  return removeImport(source, PROVIDER_IMPORT)
    .replace(new RegExp(`,\\n[ \\t]*${PROVIDER},?(?=\\n)`), '')
    .replace(new RegExp(`\\n[ \\t]*${PROVIDER},`), '')
    .replace(new RegExp(`,\\s*${PROVIDER}\\b`), '')
    .replace(new RegExp(`\\[\\s*${PROVIDER}\\s*\\]`), '[]')
}

/**
 * Register `config/redis.ts` in `config/index.ts` source; `undefined` when the file doesn't have the
 * skeleton's shape (`export default { … }`).
 *
 * @example
 * addConfigFile("import app from './app.ts'\nexport default { app } satisfies ConfigFiles\n")
 */
export function addConfigFile(source: string): string | undefined {
  const object = /export\s+default\s+\{([^{}]*)\}/.exec(source)
  if (object === null) return undefined
  const items = object[1] ?? ''
  if (/\bredis\b/.test(items)) return source
  const names = items
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  names.push('redis')
  names.sort()
  const start = object.index + object[0].indexOf('{') + 1
  const rebuilt = ` ${names.join(', ')} `
  return addImport(
    source.slice(0, start) + rebuilt + source.slice(start + items.length),
    CONFIG_IMPORT,
  )
}

/**
 * Remove what {@link addConfigFile} added.
 *
 * @example
 * removeConfigFile(source)
 */
export function removeConfigFile(source: string): string {
  const withoutImport = removeImport(source, CONFIG_IMPORT)
  return withoutImport.replace(/export\s+default\s+\{([^{}]*)\}/, (whole, items: string) => {
    const names = items
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '' && name !== 'redis')
    return whole.replace(`{${items}}`, `{ ${names.join(', ')} }`)
  })
}

/**
 * Let `SESSION_DRIVER` be `redis` in `config/session.ts` source; `undefined` when the skeleton's
 * line isn't there (already edited, or a different file).
 *
 * @example
 * allowRedisSessions("driver: env.oneOf('SESSION_DRIVER', ['file'], 'file'),")
 */
export function allowRedisSessions(source: string): string | undefined {
  if (source.includes(SESSION_WITH_REDIS)) return source
  return source.includes(SESSION_FILE_ONLY)
    ? source.replace(SESSION_FILE_ONLY, SESSION_WITH_REDIS)
    : undefined
}

/**
 * The Redis installer.
 *
 * @example
 * // package.json: "strutvane": { "installer": "./dist/installer.mjs" }
 * export { installer } from '@strutvane/redis/installer'
 */
export const installer: Installer = {
  name: 'redis',
  description:
    'Redis / Valkey: cache store, locks, sessions, rate limits and an experimental queue driver.',
  async install(context: InstallContext): Promise<void> {
    const { fs, log } = context
    if (!(await fs.exists('config/redis.ts'))) await fs.write('config/redis.ts', CONFIG_FILE)

    await edit(
      context,
      'config/index.ts',
      addConfigFile,
      "add `redis` (import redis from './redis.ts') to the object",
    )
    await edit(
      context,
      'bootstrap/providers.ts',
      addProvider,
      `add ${PROVIDER} (${PROVIDER_IMPORT}) to the providers`,
    )
    if (await fs.exists('config/session.ts')) {
      const source = await fs.read('config/session.ts')
      const changed = allowRedisSessions(source)
      if (changed === undefined)
        log.warn(
          "config/session.ts: allow 'redis' in the SESSION_DRIVER choices to use Redis sessions.",
        )
      else if (changed !== source) await fs.write('config/session.ts', changed, { overwrite: true })
    }

    await context.env.add('Redis (@strutvane/redis)', [
      {
        key: 'REDIS_URL',
        value: '',
        comment:
          'A full URL instead of the keys below (holds the password: .env only). rediss:// = TLS.',
      },
      { key: 'REDIS_HOST', value: '127.0.0.1' },
      { key: 'REDIS_PORT', value: '6379' },
      {
        key: 'REDIS_USERNAME',
        value: '',
        comment: 'An ACL user (Redis 6+); empty = the default user.',
      },
      { key: 'REDIS_PASSWORD', value: '' },
      { key: 'REDIS_DB', value: '0' },
      { key: 'REDIS_TLS', value: '', comment: 'true for TLS; empty follows REDIS_URL.' },
      {
        key: 'REDIS_TLS_CA',
        value: '',
        comment: 'A PEM CA file for a private CA (TLS is always verified).',
      },
      {
        key: 'REDIS_PREFIX',
        value: '',
        comment: 'Key prefix so apps can share one server; empty = the app name.',
      },
    ])
    log.info('Redis is set up. Choose it in .env: CACHE_STORE=redis and/or SESSION_DRIVER=redis.')
  },

  async uninstall(context: InstallContext): Promise<void> {
    const { fs, log } = context
    for (const [path, undo] of [
      ['bootstrap/providers.ts', removeProvider],
      ['config/index.ts', removeConfigFile],
    ] as const) {
      if (!(await fs.exists(path))) continue
      const source = await fs.read(path)
      const changed = undo(source)
      if (changed !== source) await fs.write(path, changed, { overwrite: true })
    }
    if (await fs.exists('config/redis.ts')) {
      if ((await fs.read('config/redis.ts')).replace(/\r\n/g, '\n') === CONFIG_FILE)
        await fs.remove('config/redis.ts')
      else
        log.warn('config/redis.ts was changed, so it was kept. Delete it if you no longer need it.')
    }
    await context.env.remove(ENV_KEYS)
    log.info(
      'Redis was removed. Set CACHE_STORE and SESSION_DRIVER back to file if they were redis.',
    )
  },
}

async function edit(
  context: InstallContext,
  path: string,
  change: (source: string) => string | undefined,
  manual: string,
): Promise<void> {
  if (!(await context.fs.exists(path))) {
    context.log.warn(`${path} not found: ${manual} by hand.`)
    return
  }
  const source = await context.fs.read(path)
  const changed = change(source)
  if (changed === undefined) context.log.warn(`${path} has an unexpected shape: ${manual} by hand.`)
  else if (changed !== source) await context.fs.write(path, changed, { overwrite: true })
}

/** Add an import line after the last import (or at the top). Idempotent. */
function addImport(source: string, line: string): string {
  if (source.includes(line)) return source
  const imports = [...source.matchAll(/^import[^\n]*\n/gm)]
  const last = imports.at(-1)
  if (last === undefined) return `${line}\n${source}`
  const at = last.index + last[0].length
  return `${source.slice(0, at)}${line}\n${source.slice(at)}`
}

function removeImport(source: string, line: string): string {
  return source.replace(`${line}\n`, '')
}
