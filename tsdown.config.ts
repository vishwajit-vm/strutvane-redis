import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    provider: 'src/provider.ts',
    installer: 'src/installer.ts',
    queue: 'src/queue/index.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: true,
  sourcemap: true,
  clean: true,
  // The framework is a peer (one copy per app: container tokens rely on it); the client is a
  // regular dependency resolved from node_modules, never bundled.
  deps: {
    neverBundle: [/^@strutvane\//, /^@redis\//],
  },
})
