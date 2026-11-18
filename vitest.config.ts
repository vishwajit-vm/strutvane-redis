import { defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

// The default gate runs everything that needs no Redis server: config parsing, key spaces, the
// connection's failure handling (against a scripted client), the cache manager, the provider's
// bindings and the installer. The stores themselves (cache, locks, rate limits, sessions,
// idempotency, signatures, queue) are Lua and Redis semantics, so they are tested only against a
// real Redis/Valkey container: `npm run test:integration` (vitest.integration.config.ts), which
// covers every file. They are excluded from this gate's coverage for that reason.
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      exclude: ['test/integration/**', 'node_modules/**', 'dist/**'],
      coverage: {
        exclude: [
          'src/**/*.test.ts',
          'src/**/index.ts',
          'src/cache-store.ts',
          'src/lock.ts',
          'src/rate-limiter.ts',
          'src/session-store.ts',
          'src/idempotency-store.ts',
          'src/signature-store.ts',
          'src/queue/redis-queue.ts',
        ],
      },
    },
  }),
)
