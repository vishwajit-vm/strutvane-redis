/**
 * The environment the connection settings are read from: `<app>/.env` merged under the process
 * environment (values set by the shell, Docker or CI win), the same rule the framework follows.
 *
 * **Why this package reads `.env` itself:** the framework keeps its merged environment private
 * (providers get the config tree, not the variables), and the Redis password must not be copied
 * into the config tree (see `config.ts`). Node's own `util.parseEnv` does the parsing, so there is
 * no hand-written parser here. Proposal in NEXT.md: the framework exposes the environment to
 * providers, and this file goes away.
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

/**
 * Read `<basePath>/.env` (when present) under `process.env`.
 *
 * @example
 * const env = loadRedisEnv('/srv/blog')
 * env['REDIS_HOST'] // from the process environment, else from .env
 */
export function loadRedisEnv(
  basePath: string,
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string | undefined>> {
  const file = join(basePath, '.env')
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
  return { ...fromFile, ...processEnv }
}
