# NEXT.md: strutvane-redis, branch `fix/hardening-2026-11-20`

## Branch `fix/hardening-2026-11-20` (2026-11-21)

Changeset `redis-prefix-and-production.md` (minor). Commits, one per item:

1. **Key prefix** (`keys.ts`, `config.ts`): `<app>:<environment>:` by default; `REDIS_PREFIX` must be
   exactly two `:`-terminated parts; production refuses the `strutvane:` fallback. The fixed part
   count is what makes prefixes prefix-free (a one-part `blog:` would be the start of
   `blog:production:`). Property test in `test/unit/config.test.ts`. README upgrade note.
2. **Production checks** (`config.ts`, `loopback.ts`): a remote Redis needs an explicit TLS choice
   and a password (`REDIS_ALLOW_NO_PASSWORD=true` opts out). Table test `test/unit/production.test.ts`.
   The provider reads the environment from `app.env` (`app.environment` is only readable after boot).
3. **Reserved areas** (`areas.ts`, `cache-manager.ts`): guard test `test/unit/areas.test.ts`.
4. **Queue** (`queue/redis-queue.ts`): `pcall(cjson.decode)`, bad entries to `:failed`.
5. **Cache store:** `many()` with `Object.create(null)`; `#refresh` logs a key digest.

### Integration fix (2026-11-25)

The 2 integration tests that failed on every run (153 then) were older test setups, not the code;
the code matches decision #135 and its unit tests:

- `app.test.ts` "binds Redis stores; throttle limits hold across two app servers" passed a one-part
  `REDIS_PREFIX` (`app<hex>:`), which boot now refuses. It now uses `app<hex>:test:`, and a new test
  checks that a one-part prefix stops a real app's boot with `invalid_redis_config` (154 tests).
- `connection.test.ts` "fails fast with redis_unavailable…" built settings with no `APP_ENV` or
  `APP_NAME`, so they were production's and refused the shared `strutvane:` fallback prefix. It
  now uses `testSettings()` (a unique `<x>:test:` prefix), like every other suite.

Gate (2026-11-25, Windows, Node 24.21.0, npm 11.19.0, Redis 8.2.10-alpine, agent-reported):

- plain `npm ci`: OK.
- `npm run ci` 3x green: 10 files, 80/80 tests each run, coverage 98.88/94.18/99.08/99.37.
- `npm run test:integration` 3x green (18:48–18:50 IST): 17 files, 154/154 each run, coverage
  99.17/95.42/100/99.73. The uniquely named container was removed after each run.
- Not counted: an earlier series ran while the laptop was in Modern Standby (16:39–18:46 IST;
  11 time-outs), and the first run after waking failed 3 server-side expiry checks (a 200 ms lock
  TTL not yet expired after a 300 ms sleep; Docker's VM clock resyncs after standby). The next
  5 runs, with no change, were all green.

Next: the coordinator re-runs the gates, then merges into `main` with the release.

Last updated 2026-11-25. Read with `CLAUDE.md`/`.claude/ECOSYSTEM.md` and the hub `STATE.md`.

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
npm ci                      # the lockfile resolves only from the registry (framework 0.2.0-next.1)
npm run ci                  # lint, typecheck, unit tests + coverage, build (no Redis needed)
npm run test:integration    # needs Docker (Linux containers); one uniquely named container, removed after
```

## Status (2026-11-20, agent-reported until the coordinator re-runs)

- devDependency `@strutvane/framework` is the published `0.2.0-next.1`; lockfile rebuilt from the
  registry (no `link` entries); `allowScripts`: esbuild 0.18.20 / 0.25.12 / 0.28.2 true, fsevents
  2.3.3 false; plain `npm ci` passes; `npm audit --omit=dev`: 0 vulnerabilities.
- Gate 3× green at b93025e (Windows, Node 24.21, Redis 8.2.10-alpine container):
  `npm run ci` 56/56 each run (coverage 98.78/93.54/99.02/99.31) and `npm run test:integration`
  127/127 each run (99.25/95.27/100/99.85).
- publint 0.3.25 `--strict`: all good. attw 0.18.5 `--profile esm-only`: exit 0.
  `check-package.mjs`: 25 files. CHANGELOG has 0.2.0-next.0.
- Fixed this session: a network-error regex that held literal backspace characters; skipped
  integration suites (no Docker) failing to load; function coverage under 90% (lazy logger moved
  to `src/lazy-logger.ts` with a test); a flush test that timed out under load.

## Half-done / next

1. Coordinator: re-run the gate 3× and accept or reject the R-rows in `RELEASE-READINESS.md`.
   CI matrix (Linux/macOS, Node 26) has not run: the branch is not pushed.
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
