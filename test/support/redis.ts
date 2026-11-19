/**
 * Helpers for the integration tests: connections to the test container and unique prefixes, so
 * test files running in parallel never see each other's keys.
 */
import { randomBytes } from 'node:crypto'
import { inject, type ProvidedContext } from 'vitest'
import { type RedisSettings, resolveRedisSettings } from '../../src/config.ts'
import { RedisConnection, type RedisConnectionOptions } from '../../src/connection.ts'
import { KeySpace } from '../../src/keys.ts'

/** What the global setup started (or why it couldn't). */
export const server: ProvidedContext['redis'] = inject('redis')

/** `describe.skipIf(skip)` with the reason in the title. */
export const skip: boolean = server.skip !== undefined

/** The suite title, with the skip reason when skipped. */
export function title(name: string): string {
  return server.skip === undefined ? name : `${name} (skipped: ${server.skip})`
}

/** A fresh app prefix, unique per call. */
export function uniquePrefix(): string {
  return `t${randomBytes(5).toString('hex')}:`
}

/** Settings for the test server, plus overrides. */
export function testSettings(env: Readonly<Record<string, string>> = {}): RedisSettings {
  return resolveRedisSettings({
    env: {
      REDIS_HOST: server.host,
      // A skipped suite still builds its connections at collection time; they are never used.
      REDIS_PORT: String(server.port || 6379),
      REDIS_PREFIX: uniquePrefix(),
      REDIS_CONNECT_TIMEOUT: '3000',
      REDIS_COMMAND_TIMEOUT: '5000',
      ...env,
    },
  })
}

const open: RedisConnection[] = []

/** A connection to the test server; closed by {@link closeAll}. */
export function connect(
  env: Readonly<Record<string, string>> = {},
  options: RedisConnectionOptions = {},
): RedisConnection {
  const connection = new RedisConnection(testSettings(env), options)
  open.push(connection)
  return connection
}

/** A root key space with a unique prefix. */
export function space(): KeySpace {
  return KeySpace.root(uniquePrefix())
}

/** Close every connection opened by {@link connect} (call in `afterAll`). */
export async function closeAll(): Promise<void> {
  await Promise.all(open.splice(0).map((connection) => connection.close()))
}
