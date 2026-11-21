/**
 * Whether a Redis host is this machine (the loopback interface), for the production checks in
 * `config.ts`: plain text and a missing password are only acceptable without a network in between.
 *
 * **Why normalise first:** the same loopback address has many spellings (`::1`,
 * `0:0:0:0:0:0:0:1`, `[::1]`, `::ffff:127.0.0.1`, `::ffff:7f00:1`), and a string comparison that
 * misses one either refuses a safe setup or, worse, treats a remote host as local. Addresses are
 * read with `node:net`'s `isIP` and compared as numbers. Anything that is not an IP address is
 * only loopback when it is literally `localhost`; other names (`127.1`, `localhost.example.com`,
 * a DNS name that happens to resolve to 127.0.0.1) count as remote, which fails closed.
 *
 * @module
 */
import { isIP } from 'node:net'

/**
 * `true` for `localhost`, `127.0.0.0/8`, `::1` and IPv4-mapped `::ffff:127.x.y.z`, in any
 * spelling (brackets, a trailing dot on `localhost`, upper case, expanded IPv6 groups).
 *
 * @example
 * isLoopbackHost('[0:0:0:0:0:0:0:1]') // true
 * isLoopbackHost('::ffff:127.0.0.1')  // true
 * isLoopbackHost('cache.internal')    // false
 */
export function isLoopbackHost(host: string): boolean {
  let bare = host.trim().toLowerCase()
  if (bare.startsWith('[') && bare.endsWith(']')) bare = bare.slice(1, -1)
  if (bare === 'localhost' || bare === 'localhost.') return true
  const family = isIP(bare)
  if (family === 4) return bare.startsWith('127.')
  // A zone id (`fe80::1%eth0`) names a link, never loopback.
  if (family !== 6 || bare.includes('%')) return false
  const value = ipv6Value(bare)
  if (value === 1n) return true
  return value >> 32n === 0xffffn && (value & 0xffffffffn) >> 24n === 127n
}

/** A valid IPv6 address (`isIP` said so) as a 128-bit integer, an embedded IPv4 tail included. */
function ipv6Value(text: string): bigint {
  let head = text
  let tail: bigint | undefined
  const lastColon = text.lastIndexOf(':')
  if (text.slice(lastColon + 1).includes('.')) {
    tail = text
      .slice(lastColon + 1)
      .split('.')
      .reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n)
    head = `${text.slice(0, lastColon + 1)}0:0`
  }
  const [left = '', right] = head.split('::')
  const leftGroups = left === '' ? [] : left.split(':')
  const rightGroups = right === undefined || right === '' ? [] : right.split(':')
  const groups =
    right === undefined
      ? leftGroups
      : [
          ...leftGroups,
          ...Array<string>(8 - leftGroups.length - rightGroups.length).fill('0'),
          ...rightGroups,
        ]
  const value = groups.reduce(
    (total, group) => (total << 16n) | BigInt(Number.parseInt(group, 16)),
    0n,
  )
  return tail === undefined ? value : (value & ~0xffffffffn) | tail
}
