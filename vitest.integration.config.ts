import { defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

// Real Redis tests. The global setup starts one uniquely named container (TLS port and ACL users
// included) and removes it afterwards; set REDIS_TEST_URL to use a server you run yourself, or
// REDIS_TEST_IMAGE to try another image (valkey/valkey:8-alpine). Without Docker running Linux
// containers, every suite is skipped with the reason printed.
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      include: ['test/**/*.test.ts'],
      globalSetup: ['test/integration/global-setup.ts'],
      testTimeout: 30_000,
      hookTimeout: 120_000,
      coverage: {
        reportsDirectory: 'coverage/integration',
      },
    },
  }),
)
