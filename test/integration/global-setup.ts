/**
 * Starts one Redis container for the integration suite and removes it afterwards.
 *
 * - **Unique name** (`strutvane-redis-test-<pid>-<random>`), so parallel runs never collide, and
 *   only that container is ever removed (never anyone else's).
 * - **No host files mounted:** the TLS certificates are copied in with `docker cp` before start.
 * - **Ports** are published on 127.0.0.1 only, on free ports Docker picks.
 * - **ACL users:** `default` (no password), `app` (password), `limited` (only `limited:*` keys).
 * - **TLS** on a second port with a throwaway CA made by `openssl`; skipped (not failed) when
 *   `openssl` is missing.
 *
 * `REDIS_TEST_URL` uses an existing server instead (TLS and ACL tests then skip).
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { TestProject } from 'vitest/node'

const run = promisify(execFile)
const IMAGE = process.env['REDIS_TEST_IMAGE'] ?? 'redis:8.2.10-alpine'

declare module 'vitest' {
  export interface ProvidedContext {
    redis: {
      readonly skip: string | undefined
      readonly host: string
      readonly port: number
      readonly tlsPort: number | undefined
      readonly caPem: string | undefined
      readonly acl: boolean
      readonly image: string
    }
  }
}

async function docker(args: readonly string[], timeout = 60_000): Promise<string> {
  const { stdout } = await run('docker', [...args], { timeout, windowsHide: true })
  return stdout.trim()
}

async function makeCertificates(dir: string): Promise<boolean> {
  const openssl = async (args: readonly string[]): Promise<void> => {
    await run('openssl', [...args], { cwd: dir, timeout: 30_000, windowsHide: true })
  }
  try {
    await openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=strutvane-test-ca',
      '-keyout',
      'ca.key',
      '-out',
      'ca.crt',
    ])
    writeFileSync(join(dir, 'san.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
    await openssl([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      '/CN=localhost',
      '-keyout',
      'server.key',
      '-out',
      'server.csr',
    ])
    await openssl([
      'x509',
      '-req',
      '-in',
      'server.csr',
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-days',
      '2',
      '-extfile',
      'san.cnf',
      '-out',
      'server.crt',
    ])
    return true
  } catch {
    return false
  }
}

function hostPort(mapping: string): number {
  // "127.0.0.1:49153" (possibly several lines, IPv4 first)
  const port = Number(mapping.split('\n')[0]?.split(':').at(-1))
  if (!Number.isSafeInteger(port)) throw new Error(`Unexpected docker port output: ${mapping}`)
  return port
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env['REDIS_TEST_URL']
  if (external !== undefined && external !== '') {
    const url = new URL(external)
    project.provide('redis', {
      skip: undefined,
      host: url.hostname,
      port: Number(url.port || '6379'),
      tlsPort: undefined,
      caPem: undefined,
      acl: false,
      image: 'external',
    })
    return async () => {}
  }

  let osType: string
  try {
    osType = await docker(['info', '--format', '{{.OSType}}'], 20_000)
  } catch {
    osType = ''
  }
  if (osType !== 'linux') {
    project.provide('redis', {
      skip: 'Docker is not available or cannot run Linux containers (set REDIS_TEST_URL to use your own Redis).',
      host: '',
      port: 0,
      tlsPort: undefined,
      caPem: undefined,
      acl: false,
      image: IMAGE,
    })
    return async () => {}
  }

  const name = `strutvane-redis-test-${process.pid}-${randomBytes(4).toString('hex')}`
  const certs = mkdtempSync(join(tmpdir(), 'strutvane-redis-tls-'))
  const tls = await makeCertificates(certs)
  const args = [
    'create',
    '--name',
    name,
    '-p',
    '127.0.0.1::6379',
    ...(tls ? ['-p', '127.0.0.1::6380'] : []),
    IMAGE,
    'redis-server',
    '--port',
    '6379',
    '--save',
    '',
    '--appendonly',
    'no',
    '--user',
    'default',
    'on',
    'nopass',
    '~*',
    '&*',
    '+@all',
    '--user',
    'app',
    'on',
    '>app-secret',
    '~*',
    '&*',
    '+@all',
    '--user',
    'limited',
    'on',
    '>limited-secret',
    '~limited:*',
    '+@all',
    ...(tls
      ? [
          '--tls-port',
          '6380',
          '--tls-cert-file',
          '/tls/server.crt',
          '--tls-key-file',
          '/tls/server.key',
          '--tls-ca-cert-file',
          '/tls/ca.crt',
          '--tls-auth-clients',
          'no',
        ]
      : []),
  ]
  const cleanup = async (): Promise<void> => {
    await docker(['rm', '-f', name], 60_000).catch(() => undefined)
    rmSync(certs, { recursive: true, force: true })
  }
  try {
    await docker(args, 300_000)
    if (tls) await docker(['cp', `${certs}${'/'}.`, `${name}:/tls`])
    await docker(['start', name])
    const deadline = Date.now() + 60_000
    for (;;) {
      const pong = await docker(['exec', name, 'redis-cli', 'ping'], 10_000).catch(() => '')
      if (pong === 'PONG') break
      if (Date.now() > deadline) throw new Error(`Redis container ${name} did not answer PING`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    project.provide('redis', {
      skip: undefined,
      host: '127.0.0.1',
      port: hostPort(await docker(['port', name, '6379/tcp'])),
      tlsPort: tls ? hostPort(await docker(['port', name, '6380/tcp'])) : undefined,
      caPem: tls ? readFileSync(join(certs, 'ca.crt'), 'utf8') : undefined,
      acl: true,
      image: IMAGE,
    })
  } catch (error) {
    await cleanup()
    throw error
  }
  return cleanup
}
