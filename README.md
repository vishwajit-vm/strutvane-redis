# strutvane-redis

> **Status: `0.2.0-next.0`, not on npm yet.** Built and tested against the published
> `@strutvane/framework` `0.2.0-next.1`. The queue driver is
> **experimental** until framework queues land (0.3).

**`@strutvane/redis`**: Redis and Valkey for [Strutvane](https://github.com/vishwajit-vm/strutvane)
apps: a cache store, atomic locks, a session store, rate limiting, an idempotency store, and a
queue-driver interface ready for framework queues. Every key lives under the app's prefix, and can
be scoped to a tenant.

| | |
|---|---|
| Package | `@strutvane/redis` |
| Needs | Node 24.3+, npm 11.19+, `@strutvane/framework` `^0.2.0-next.0` (peer), Redis 6.2+ or Valkey 7.2+ |
| Client | [`@redis/client`](https://www.npmjs.com/package/@redis/client) (MIT, official, no runtime dependencies) |
| License | MIT |

## Install

```bash
node strut install:redis      # today: node strut add redis
```

The installer (idempotent; `node strut remove redis` reverses it):

- writes `config/redis.ts` (non-secret settings, read from `.env`) and registers it in `config/index.ts`;
- adds the `REDIS_*` keys to `.env` and `.env.example` (secrets empty, existing values never overwritten);
- adds `RedisServiceProvider` to `bootstrap/providers.ts`;
- allows `SESSION_DRIVER=redis` in `config/session.ts`.

It does **not** switch your app to Redis. Choose it in `.env` when the server is ready:

```dotenv
CACHE_STORE=redis
SESSION_DRIVER=redis
REDIS_URL=rediss://app:secret@cache.example.com:6380/0   # or REDIS_HOST/PORT/USERNAME/PASSWORD/DB
```

A file the installer doesn't recognise (you changed its shape) is left alone, and the step is printed
for you to do by hand.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `REDIS_URL` | | `redis://` or `rediss://` (TLS). Wins over the keys below. Holds the password: `.env` only. |
| `REDIS_HOST` / `REDIS_PORT` | `127.0.0.1` / `6379` | |
| `REDIS_USERNAME` / `REDIS_PASSWORD` | | ACL user (Redis 6+) and password. |
| `REDIS_DB` | `0` | |
| `REDIS_TLS` | `false` | `true` for TLS. A `rediss://` URL can't be downgraded with `REDIS_TLS=false` (boot fails). In production, a Redis on another machine needs an explicit choice: `true` (or `rediss://`), or `false` to accept plain text on purpose; unset stops boot. |
| `REDIS_ALLOW_NO_PASSWORD` | `false` | In production, a Redis on another machine needs `REDIS_PASSWORD`; set this to `true` when the server is protected another way. |
| `REDIS_TLS_CA` / `REDIS_TLS_SERVERNAME` | | A PEM CA file for a private CA; the name the certificate must carry. |
| `REDIS_PREFIX` | `<app>:<environment>:` | The app name and `APP_ENV` as slugs (`my_blog:production:`). A custom value must be exactly two parts, each ending with `:` (`blog:production:`), so no app's prefix starts another's. In production an app with no `APP_NAME` is refused rather than share `strutvane:`. |
| `REDIS_CONNECT_TIMEOUT` / `REDIS_COMMAND_TIMEOUT` | `5000` ms | |

`config/redis.ts` (or Laravel's spot, `config/database.ts` → `redis`) may set the non-secret keys;
`password` and `url` are refused there, because the config tree is cached and easy to dump. TLS
always verifies the server certificate; there is no switch to turn that off. A bad value stops boot
with `invalid_redis_config`.

## Use

```ts
import { Cache } from '@strutvane/framework/facades'
import { RedisLocksToken, RedisRateLimiterToken } from '@strutvane/redis'

// Cache (CACHE_STORE=redis, or by name)
await Cache.store('redis').put('stats', { posts: 3 }, 60)

// Laravel's extras live on the store itself
const store = app.make(CacheManagerToken).store('redis') as RedisCacheStore
await store.flexible('dashboard', [5, 60], () => buildDashboard())   // stale-while-revalidate
await store.forTenant(tenant.id).remember('report', 300, () => buildReport(tenant))

// Atomic locks: owner tokens, safe release, expiry if the holder crashes
await app.make(RedisLocksToken).create('reports:build', 120).block(10, () => buildReports())

// Rate limits in your own code (fixed or sliding window)
const limit = await app.make(RedisRateLimiterToken).hit(`export:${user.id}`, {
  max: 5,
  windowSeconds: 3600,
  algorithm: 'sliding',
})
if (!limit.allowed) throw new RateLimitedError({ retryAfter: limit.retryAfterSeconds })
```

### What the provider binds

| Token | What | When |
|---|---|---|
| `RedisConnectionToken` | the shared, lazily opened connection (`health()` for readiness probes) | always |
| `RedisKeySpaceToken`, `RedisLocksToken`, `RedisRateLimiterToken` | key prefixes, locks, limiter | always |
| `CacheManagerToken` | the framework's stores plus `redis` and any `driver: 'redis'` store | always (a superset of the framework's) |
| `SessionStoreToken` | `RedisSessionStore` | `SESSION_DRIVER=redis` |
| `IdempotencyStoreToken` | `RedisIdempotencyStore` | the default cache store is a Redis store |

With `CACHE_STORE=redis`, the framework's `throttle` middleware counts in Redis, so `throttle:api`
holds across every server.

### Upgrading from 0.2.0-next.0: the key prefix changed

The default prefix is now `<app>:<environment>:` (it was `<app>:`), and a custom `REDIS_PREFIX`
must have two parts (`blog:` becomes, say, `blog:production:`). After the upgrade the app doesn't
see its old keys:

- caches start empty and refill as they're used;
- signed-in users are signed out once (sessions stored in Redis);
- held locks, rate-limit counters and idempotency records start over.

The old keys expire on their own TTLs. To remove them sooner, delete `<old prefix>*` with `SCAN` +
`UNLINK` (never `FLUSHDB` on a shared server).

### Keys and tenants

Every key is `<prefix><area>:<key>`; a tenant scope adds `t:<tenant>:`. Tenant ids may only contain
letters, digits, `_` and `-` (anything else is refused, so a tenant can't reach into another's
namespace), global keys can't start with `t:`, and flushes match the prefix literally (`SCAN` +
`UNLINK`, never `FLUSHDB`). Session ids and idempotency keys are stored as SHA-256 hashes.

### Failure behaviour

- Redis down: commands fail fast with the 503 `redis_unavailable` problem (no in-memory pile-up);
  after a failed connect, new attempts wait a second (circuit breaker); the log says why, never the
  password.
- A wrong password or a missing ACL permission: also `redis_unavailable` (fail closed), logged as
  `redis.access_denied`.
- `lock.block()` running out of time: 503 `lock_timeout`.
- Shutdown closes the connection gracefully (pending replies awaited, bounded).
- In production, a Redis on another machine (anything but `localhost`, `127.0.0.0/8`, `::1` and
  `::ffff:127.x.y.z`, in any spelling) stops boot with `invalid_redis_config` unless TLS is chosen
  explicitly and a password is set (or `REDIS_ALLOW_NO_PASSWORD=true`). Plain text or no password
  chosen on purpose is still logged as a warning at boot.

## Queue (experimental)

```ts
import { RedisQueueDriver } from '@strutvane/redis/queue'
```

`QueueDriver` (push, pop with a visibility timeout, ack, release with delay, size, clear) and a
Redis implementation laid out like Laravel's. Not wired into the app until the framework defines
queues; expect breaking changes.

## Not built yet

- Sentinel and cluster (node-redis supports both; they plug in behind the same driver seam).
- Cache tags (the framework's cache contract has none).
- Binding the used-signature store and the rate-limit store separately from the cache: the framework
  doesn't export those tokens yet (see `NEXT.md`).
- Broadcasting (pub/sub) for realtime.

## Development

```bash
npm install
npm run ci                 # lint, typecheck, unit tests + coverage, build (no Redis needed)
npm run test:integration   # real Redis in Docker: every suite, coverage over all files
```

The integration suite starts one uniquely named container (`redis:8.2.10-alpine`; set
`REDIS_TEST_IMAGE=valkey/valkey:8-alpine` to try Valkey, or `REDIS_TEST_URL` to use your own server)
with ACL users and a TLS port, and removes it afterwards. Without Docker running Linux containers,
it skips with the reason printed.
