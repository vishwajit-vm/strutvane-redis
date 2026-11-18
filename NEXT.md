# NEXT.md: strutvane-redis, branch `v2/redis`

Last updated 2026-11-18. Read with `CLAUDE.md`/`.claude/ECOSYSTEM.md` and the hub `STATE.md`.

## Done

- Scaffold: synced tooling files (library profile, via a scratch copy of `sync.mjs` with a `redis`
  target; see "Proposals" for the tooling manifest), `package.json` (`0.1.0` → `0.2.0-next.0` by
  changeset in pre mode `next`), configs, lockfile.
- `src/`: `config.ts` (REDIS_* + `config/redis.ts`/`database.redis`, fail closed, secrets never in
  the config tree), `keys.ts` (app/area/tenant key spaces), `driver.ts` (the client seam + Lua),
  `connection.ts` (`@redis/client`: lazy, fail-fast 503, circuit breaker, TLS verified, ACL,
  graceful close), `cache-store.ts`, `cache-manager.ts`, `lock.ts`, `rate-limiter.ts`,
  `session-store.ts`, `idempotency-store.ts`, `signature-store.ts`, `provider.ts`, `installer.ts`,
  `tokens.ts`, `env.ts`, `errors.ts`, `queue/` (experimental).
- Tests: `test/unit` (default gate, no server) and `test/integration` (real Redis container with
  ACL users and a TLS port; `npm run test:integration`).

## How to verify

```bash
# framework 0.2.0-next.0 is not on npm: pack it from fix/release-0.2 and install it without saving
npm install --no-save --ignore-scripts <path>/strutvane-framework-0.2.0-next.0.tgz
npm run ci
npm run test:integration    # needs Docker (Linux containers); removes its container afterwards
```

Never commit a `file:` spec or a lockfile pointing at the tarball; the lockfile's framework entry
has a registry URL and no integrity hash until the framework is published (same as auth).

## Stopped here (2026-11-18, usage-limit STOP)

- Versioned to `0.2.0-next.0` (changeset pre mode `next`, CHANGELOG written); lockfile version synced.
- `npx biome check .` reports errors (not looked at yet; likely formatting in new files): run
  `npx biome check --write .` and re-check.
- Last integration run (framework tarball from fix/release-0.2 f658430, installed with --no-save):
  2 files failed to load (`test/integration/cache-store.test.ts`, `test/integration/stores.test.ts`,
  a collection error, not an assertion: see the first lines of the run) and 5 files skipped as a
  consequence of the setup state; 55 passed. Earlier full run (before the timing fixes): 123/126
  passed, the 3 failures were timing-sensitive tests since widened. Unit gate: 55/55 passed once
  (agent-reported).
- No container left running.

## Half-done / next

1. Run the full gate 3× (unit `npm run ci` + `npm run test:integration`) and record results in
   `RELEASE-READINESS.md` (coordinator re-runs).
2. Valkey run: `REDIS_TEST_IMAGE=valkey/valkey:8-alpine npm run test:integration` (the image was not
   pulled on this machine; only Redis 8.2 is verified).
3. Security review (`security-reviewer` agent) of the connection, key spaces and installer.
4. Sentinel / cluster support behind `RedisDriver` (deferred; documented in README).
5. When the framework adds queues: move `QueueDriver` to the framework contract and drop
   "experimental".

## Proposals for the framework (not changed here)

1. **Export `RateLimitStoreToken`** (`src/http/app/throttle.ts`) from `@strutvane/framework`: today
   the limiter can only use Redis through the default cache store; an app with `CACHE_STORE=file`
   can't keep throttle counters in Redis.
2. **Export `UsedSignatureStoreToken`** (`src/security/signer.ts`): `RedisUsedSignatureStore` is
   built and tested but can't be bound, so one-time signed URLs stay per-process.
3. **Expose the merged environment to providers** (e.g. `app.env(name)` or an `EnvToken`): this
   package re-reads `.env` with `util.parseEnv` (`src/env.ts`) to get `REDIS_PASSWORD` without
   putting it in the config tree.
4. **A session driver contract** richer than `flush()` (`read/write/touch/destroy`), so
   `@strutvane/auth` can use `RedisSessionStore` without importing this package.
5. **Package message catalogs at boot**: `Messages` has no runtime registration, so
   `REDIS_MESSAGES_EN` is exported but not registered; the error titles come from the registry.
6. **`install:<name>` for v2 apps**: devkit's `config.registerProvider` edits `strutvane.config.ts`
   (v1). v2 apps list providers in `bootstrap/providers.ts`; this installer edits that file (and
   `config/index.ts`) as text. A devkit helper for both would remove the duplication.
7. **A cache driver registry**: `createCacheManager` rejects unknown drivers, so this package wraps
   the whole manager. A `registerCacheDriver('redis', factory)` hook would be smaller.
8. Skeleton: `config/session.ts` only allows `SESSION_DRIVER=file`; the installer adds `redis` by
   text edit.

## Proposals for other repos

- strutvane-tooling: add `{ "name": "redis", "profile": "library" }` to `manifest.json` targets.
- Hub catalogue (`spikes/21-package-catalogue/seed/catalogue.json`, `id: redis`): says
  `frameworkRange ^0.3`, version `0.1.0`, config `config/redis.ts`; this build is `0.2.0-next.0` for
  framework `^0.2.0-next.0`. The env list should add the `REDIS_*` keys (not `CACHE_STORE`/
  `QUEUE_CONNECTION`, which the installer deliberately leaves alone).
