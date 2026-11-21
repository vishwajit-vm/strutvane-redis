---
"@strutvane/redis": minor
---

**Minor, not patch, because the default key prefix changes what an upgraded app reads and writes.**

- **Key prefix:** the default is now `<app>:<environment>:` (the `APP_NAME` and `APP_ENV` slugs, such as `my_blog:production:`); it was `<app>:`. A custom `REDIS_PREFIX` must be exactly two parts, each ending with `:` (`blog:production:`), so no app's prefix is the start of another's and one app's flush never touches another's keys. In production, an app without `APP_NAME` stops boot with `invalid_redis_config` instead of using the shared `strutvane:` prefix. After upgrading, the app no longer sees its old keys: caches refill, users stored in Redis sessions sign in once more, and locks, rate-limit counters and idempotency records start over (README, "Upgrading").
- **Production, Redis on another machine:** boot stops with `invalid_redis_config` unless TLS is chosen explicitly (`REDIS_TLS=true` or `rediss://`, or `REDIS_TLS=false` to accept plain text on purpose) and a password is set (or `REDIS_ALLOW_NO_PASSWORD=true`). Loopback is recognised in every spelling (`::1`, `0:0:0:0:0:0:0:1`, `[::1]`, `127.0.0.0/8`, `::ffff:127.x.y.z`).
- **Cache stores** may not use the package's own key areas (`session`, `idempotency`, `lock`, `rate`, `queue`, `signature`) as their `area`.
- **Queue (experimental):** an entry that is not a job is moved to `<queue>:failed` and `pop` goes on with the next one.
- `RedisCacheStore.many()` returns an object without a prototype; a failed background refresh logs a digest of the key, not the key.
