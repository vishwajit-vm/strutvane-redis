# Release readiness

<!--
  Created once by strutvane-tooling (canonical/RELEASE-READINESS.md). This repo owns this file:
  sync never overwrites it. Gates and rules: hub docs/19-production-readiness.md
  (https://github.com/vishwajit-vm/strutvane/blob/main/docs/19-production-readiness.md).

  A version reaches npm `latest` only when every gate below is "pass" with evidence. One row per
  gate: the status (pass / fail / not checked), a link to the evidence (CI run, report or test
  file; never "trust me"), and the date it was checked (YYYY-MM-DD). The coordinator re-runs the
  checks before a gate is accepted; the project lead approves the staged release.
-->

Package: @strutvane/redis · Version: 0.2.0-next.0 · Last reviewed: 2026-11-20 (agent; the coordinator re-runs before any gate is accepted)

| Gate | What must be true (summary; docs/19 is the source) | Checked by | Status | Evidence | Date |
|---|---|---|---|---|---|
| R1 Code | Strict TS, ESM, lint clean, no `console.` in `src/`, no TODO/FIXME without an issue, TSDoc on every export | CI `verify` (`npm run ci`, `check-code-rules.mjs`) | partial (agent-reported) | local `npm run ci` 3× green at b93025e (biome, tsc strict, `check-code-rules.mjs`); TSDoc on exports | 2026-11-20 |
| R2 Tests | Green on Node 24 and 26 × Linux, Windows, macOS; coverage ≥ 90/90/85/90; type-level tests; 3 green runs in a row; no unhandled rejections or open handles | CI `verify` matrix and `repeat` job | partial (agent-reported) | Windows/Node 24 only: unit 56/56 ×3 (coverage 98.8/93.5/99.0/99.3), integration 127/127 ×3 on Redis 8.2.10 (99.3/95.3/100/99.9). CI matrix not run (not pushed); Valkey not run | 2026-11-20 |
| R3 Security | Threat model; attack-style tests; parsers fuzzed; review with 0 open critical/high; `npm audit --omit=dev` 0 high/critical; secrets scan clean | `security-reviewer` report; CI `security` job | partial (agent-reported) | attack tests: tenant/key injection, glob-safe flush, hashed session/idempotency keys, ACL denial, TLS verification, secrets never logged (fuzzed config errors). `npm audit --omit=dev`: 0. No security-reviewer pass yet; threat model in README only | 2026-11-20 |
| R4 Resilience | Failure scenarios named and tested; fails closed; idempotent retries; soak test with no growth | Resilience suites; `npm run test:soak` | partial (agent-reported) | unreachable server, circuit breaker, auth failure, close timeout, close during connect, NOSCRIPT, lock expiry after crash, queue reservation expiry: tested. No soak test | 2026-11-20 |
| R5 Packaging | publint and attw clean; tarball has no tests, fixtures, secrets or local map paths; exports resolve; `engines.node` ≥ 24.3; one framework copy; LICENSE, README, CHANGELOG; a changeset | CI `package-check` job | partial (agent-reported) | publint 0.3.25 --strict "All good", attw 0.18.5 esm-only exit 0, `check-package.mjs` 25 files, relative source maps, engines >=24.3, changeset consumed (CHANGELOG 0.2.0-next.0) | 2026-11-20 |
| R6 Integration | Installs alone and with every package, in any order, identically; re-install is a no-op; complete `.env.example`; boot fails closed; only the six connections; Northwind Ops green | Hub nightly ecosystem job; installer e2e | not checked | installer unit-tested (idempotent, reversible); not run in a real app with other packages | 2026-11-20 |
| R7 Docs | Every public feature documented with tested examples; upgrade guide; packages data, what's-new, versioning table and deprecations updated in the same change | Docs site tests | partial | README; docs site page not written | 2026-11-20 |
| R8 Release | Version per ADR-0020; staged by CI with provenance, approved with 2FA (ADR-0018); right dist-tag; release notes; rollback plan; `versions.json` updated | Release workflow; owner approval | not checked |  | |
| R9 Operations | Logs only through the framework Logger with redaction (ADR-0022); health and readiness checks; no debug tool reachable in production | Tests; `security:check` | partial (agent-reported) | logs only through the framework Logger (`redis.*` events, no secrets); `RedisConnection.health()` for readiness; no route exposed | 2026-11-20 |
