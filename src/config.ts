/**
 * Connection settings: `config/redis.ts` (or Laravel's spot, `config/database.ts` → `redis`) plus
 * the `REDIS_*` variables in `.env`.
 *
 * | Setting | Config key | Variable | Default |
 * |---|---|---|---|
 * | Full URL (`redis://` or `rediss://`) | none (secret) | `REDIS_URL` | not set |
 * | Host | `host` | `REDIS_HOST` | `127.0.0.1` |
 * | Port | `port` | `REDIS_PORT` | `6379` |
 * | ACL user | `username` | `REDIS_USERNAME` | not set (the `default` user) |
 * | Password | none (secret) | `REDIS_PASSWORD` | not set |
 * | Database number | `database` | `REDIS_DB` | `0` |
 * | TLS | `tls` | `REDIS_TLS` | `false` (`true` for `rediss://`) |
 * | CA file for TLS | `tls_ca` | `REDIS_TLS_CA` | the system CAs |
 * | TLS server name | `tls_servername` | `REDIS_TLS_SERVERNAME` | the host |
 * | Key prefix | `prefix` | `REDIS_PREFIX` | the app name as a slug, then `:` |
 * | Connect timeout | `connect_timeout` | `REDIS_CONNECT_TIMEOUT` | `5000` ms |
 * | Command timeout | `command_timeout` | `REDIS_COMMAND_TIMEOUT` | `5000` ms |
 *
 * **Why the password and URL are never config keys:** the config tree is kept for every request,
 * written to `bootstrap/cache` by `node strut config:cache` and easy to dump while debugging (the
 * same reason `config/database.ts` leaves out `DB_PASSWORD`). They are read from the environment
 * only when the connection opens.
 *
 * **Fail closed:** a bad value (a port of `abc`, an unknown URL scheme, `REDIS_TLS=false` with a
 * `rediss://` URL) stops boot with `invalid_redis_config` instead of connecting somewhere
 * unexpected or in plain text. TLS always verifies the server certificate; there is no switch to
 * turn verification off.
 *
 * @module
 */
import { BootError } from '@strutvane/framework'
import { prefixProblem } from './keys.ts'

/**
 * The resolved connection settings. `password` and `url` came from the environment and must never
 * be logged; use {@link describeSettings} for logs.
 *
 * @example
 * const settings = resolveRedisSettings({ env: { REDIS_HOST: 'cache.internal' } })
 */
export interface RedisSettings {
  readonly host: string
  readonly port: number
  readonly username: string | undefined
  readonly password: string | undefined
  readonly database: number
  readonly tls: boolean
  readonly tlsCaFile: string | undefined
  readonly tlsServername: string | undefined
  readonly prefix: string
  readonly connectTimeoutMs: number
  readonly commandTimeoutMs: number
}

/**
 * The non-secret settings an app may keep in `config/redis.ts`.
 *
 * @example
 * export default defineConfig((env) => ({ host: env.string('REDIS_HOST', '127.0.0.1') }) satisfies RedisConfig)
 */
export interface RedisConfig {
  readonly host?: string
  readonly port?: number | string
  readonly username?: string
  readonly database?: number | string
  readonly tls?: boolean | string
  readonly tls_ca?: string
  readonly tls_servername?: string
  readonly prefix?: string
  readonly connect_timeout?: number | string
  readonly command_timeout?: number | string
}

/**
 * What {@link resolveRedisSettings} reads.
 *
 * @example
 * resolveRedisSettings({ config: app.config('redis'), env, appName: 'Blog' })
 */
export interface ResolveOptions {
  /** The `redis` config tree (unchecked: it is validated here). */
  readonly config?: unknown
  /** The environment (`.env` merged under the process environment). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The app's name, for the default prefix. */
  readonly appName?: string
}

const DEFAULT_TIMEOUT_MS = 5000
const MAX_TIMEOUT_MS = 600_000
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'host',
  'port',
  'username',
  'database',
  'tls',
  'tls_ca',
  'tls_servername',
  'prefix',
  'connect_timeout',
  'command_timeout',
])
const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set(['password', 'url'])

/**
 * Resolve and check the settings. Config keys win over variables (the config file usually reads
 * the same variables); `REDIS_URL` wins over the separate host, port, user, password and database.
 *
 * @example
 * resolveRedisSettings({ env: { REDIS_URL: 'rediss://app:secret@cache.example.com:6380/2' } })
 * // { host: 'cache.example.com', port: 6380, username: 'app', database: 2, tls: true, … }
 */
export function resolveRedisSettings(options: ResolveOptions): RedisSettings {
  const config = readConfig(options.config)
  const env = options.env
  const pick = (key: keyof RedisConfig, variable: string): string | undefined => {
    const fromConfig = config[key]
    if (fromConfig !== undefined && String(fromConfig).trim() !== '') return String(fromConfig)
    const fromEnv = env[variable]
    return fromEnv === undefined || fromEnv.trim() === '' ? undefined : fromEnv.trim()
  }

  let host = pick('host', 'REDIS_HOST') ?? '127.0.0.1'
  let port = integer(pick('port', 'REDIS_PORT'), 'REDIS_PORT', 6379, 1, 65_535)
  let username = pick('username', 'REDIS_USERNAME')
  let password = nonEmpty(env['REDIS_PASSWORD'])
  let database = integer(pick('database', 'REDIS_DB'), 'REDIS_DB', 0, 0, 1023)
  const tlsSetting = pick('tls', 'REDIS_TLS')
  let tls = tlsSetting === undefined ? false : flag(tlsSetting, 'REDIS_TLS')

  const url = nonEmpty(env['REDIS_URL'])
  if (url !== undefined) {
    const parsed = parseUrl(url)
    if (parsed.tls === true && tlsSetting !== undefined && !tls)
      throw invalid(
        'REDIS_TLS is false but REDIS_URL uses rediss:// (TLS).',
        'Remove REDIS_TLS, or set it to true. A TLS URL is never downgraded to plain text.',
      )
    host = parsed.host
    port = parsed.port
    username = parsed.username ?? username
    password = parsed.password ?? password
    database = parsed.database ?? database
    tls = tls || parsed.tls
  }

  const prefix = pick('prefix', 'REDIS_PREFIX') ?? defaultPrefix(options.appName ?? env['APP_NAME'])
  const problem = prefixProblem(prefix)
  if (problem !== undefined)
    throw invalid(`REDIS_PREFIX ${problem}.`, 'Example: REDIS_PREFIX=blog: (one prefix per app).')

  return Object.freeze({
    host,
    port,
    username,
    password,
    database,
    tls,
    tlsCaFile: pick('tls_ca', 'REDIS_TLS_CA'),
    tlsServername: pick('tls_servername', 'REDIS_TLS_SERVERNAME'),
    prefix,
    connectTimeoutMs: integer(
      pick('connect_timeout', 'REDIS_CONNECT_TIMEOUT'),
      'REDIS_CONNECT_TIMEOUT',
      DEFAULT_TIMEOUT_MS,
      1,
      MAX_TIMEOUT_MS,
    ),
    commandTimeoutMs: integer(
      pick('command_timeout', 'REDIS_COMMAND_TIMEOUT'),
      'REDIS_COMMAND_TIMEOUT',
      DEFAULT_TIMEOUT_MS,
      1,
      MAX_TIMEOUT_MS,
    ),
  })
}

/**
 * A log-safe description of the settings: no password, no URL.
 *
 * @example
 * logger.info('redis.connecting', describeSettings(settings))
 */
export function describeSettings(settings: RedisSettings): Readonly<Record<string, unknown>> {
  return {
    host: settings.host,
    port: settings.port,
    database: settings.database,
    tls: settings.tls,
    acl_user: settings.username ?? 'default',
    authenticated: settings.password !== undefined,
    prefix: settings.prefix,
  }
}

/**
 * The default key prefix: the app name as a lowercase slug, then `:` (`My Blog` → `my_blog:`).
 *
 * @example
 * defaultPrefix('My Blog') // 'my_blog:'
 */
export function defaultPrefix(appName: string | undefined): string {
  const slug = (appName ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  return `${slug === '' ? 'strutvane' : slug}:`
}

interface ParsedUrl {
  readonly host: string
  readonly port: number
  readonly username: string | undefined
  readonly password: string | undefined
  readonly database: number | undefined
  readonly tls: boolean
}

function parseUrl(text: string): ParsedUrl {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    // Never echo the value: it may hold the password.
    throw invalid(
      'REDIS_URL is not a valid URL.',
      'Example: REDIS_URL=redis://user:pass@host:6379/0',
    )
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:')
    throw invalid(
      `REDIS_URL must start with redis:// or rediss:// (it starts with ${url.protocol}//).`,
      'Use rediss:// for TLS. Unix sockets and Sentinel/cluster URLs are not supported yet.',
    )
  if (url.hostname === '')
    throw invalid('REDIS_URL has no host.', 'Example: REDIS_URL=redis://127.0.0.1:6379/0')
  const path = url.pathname.replace(/^\//, '')
  const database =
    path === '' ? undefined : integer(path, 'the database number in REDIS_URL', 0, 0, 1023)
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: integer(url.port === '' ? undefined : url.port, 'the port in REDIS_URL', 6379, 1, 65_535),
    username: url.username === '' ? undefined : safeDecode(url.username),
    password: url.password === '' ? undefined : safeDecode(url.password),
    database,
    tls: url.protocol === 'rediss:',
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw invalid(
      'REDIS_URL has a badly encoded user name or password.',
      'Percent-encode special characters in the user name and password (encodeURIComponent).',
    )
  }
}

function readConfig(value: unknown): RedisConfig {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw invalid(
      'The redis config must be an object such as { host, port, prefix }.',
      "Example: defineConfig((env) => ({ host: env.string('REDIS_HOST', '127.0.0.1') }))",
    )
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (SECRET_CONFIG_KEYS.has(key))
      throw invalid(
        `The redis config must not contain "${key}".`,
        `Keep secrets out of the config tree: set ${key === 'url' ? 'REDIS_URL' : 'REDIS_PASSWORD'} in .env; it is read when the connection opens.`,
      )
    if (!CONFIG_KEYS.has(key))
      throw invalid(
        `The redis config has an unknown key "${key}".`,
        `Known keys: ${[...CONFIG_KEYS].join(', ')}.`,
      )
    const item = record[key]
    if (item !== undefined && !['string', 'number', 'boolean'].includes(typeof item))
      throw invalid(
        `redis.${key} must be a string, number or boolean.`,
        'Read it with env.string(...).',
      )
  }
  return record as RedisConfig
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

function integer(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback
  const trimmed = value.trim()
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw invalid(
      `${name} must be a whole number from ${min} to ${max}.`,
      `It is ${JSON.stringify(trimmed.slice(0, 20))}.`,
    )
  return parsed
}

function flag(value: string, name: string): boolean {
  const normalised = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalised)) return true
  if (['false', '0', 'no', 'off'].includes(normalised)) return false
  throw invalid(`${name} must be true or false.`, `It is ${JSON.stringify(value.slice(0, 10))}.`)
}

function invalid(message: string, hint: string): BootError {
  return new BootError('invalid_redis_config', message, hint)
}
