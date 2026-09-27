# Agents working in mirafive/sdk-convex

`@mirafive/sdk-convex`: records MIRA FIVE events from Convex mutations and actions by
scheduling (or writing to an outbox table) and delivering through `@mirafive/sdk-server`.
Part of the MIRA FIVE SDK family; the wire contract, flag semantics and public API live in
[mirafive/protocol](https://github.com/mirafive/protocol) (PROTOCOL.md, FLAGS.md, API.md).

## Commands

```sh
bun install --frozen-lockfile
bun run check            # format, lint, typecheck, test, build, publint, attw, size-limit
bun run test             # vitest with convex-test (in-memory Convex, offline)
bun run size             # size-limit against the limit in package.json (peers excluded)
```

## Layout

- `src/index.ts`: everything (`MiraConvex`, `miraOutboxTable`).
- `test/convex/`: a small Convex app the tests run with `convex-test`;
  `_generated/api.ts` is a stand-in for codegen, which convex-test needs to find the root.

## Dependency on sdk-server

`@mirafive/sdk-server` is an ordinary `^1.0.0` dependency from npm. To try an unreleased change,
build the sibling repo and `bun link` it; never commit a `file:` path or `overrides`.

## Rules

- API.md is the contract for this package's public surface. Do not add, rename or
  remove exports without changing API.md first.
- No transport of its own: every request goes through `Mira.send()` of
  `@mirafive/sdk-server`, with an idempotency key fixed when the delivery was queued.
- A mutation never sends. It schedules with `runAfter(0)` or writes to the outbox, so a
  rolled-back transaction sends nothing. Keep it that way.
- The outbox relies on crons being single-flight and on the `_creationTime` cutoff; a
  batch's key is its row ids. Do not add claim marks, leases or self-scheduling (a
  scheduled continuation could overlap the next cron run).
- Bundle size is the headline goal: ≤ 2 kB min + gzip without peers; a change that grows
  it explains why. No runtime dependencies beyond the peers.
- `sideEffects: false` must stay true. The constructor never throws (a module that throws
  on import takes the whole deployment down).
- Transport failures never throw into the caller's code (API.md, shared rules); they fail
  the `deliver` / `flushOutbox` run instead.
- Comments only for a non-obvious constraint, one or two lines.
- Do not run git write commands unless asked; the maintainer commits.

## Releasing

To release, bump `version` in `package.json` (and any SDK version constant), add a `## X.Y.Z — YYYY-MM-DD` section to `CHANGELOG.md`, commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml` checks both, runs `bun run check`, stages it on npm through trusted publishing (no token) and creates the GitHub release from the changelog section. The version goes live only after a maintainer approves it with 2FA on npmjs.com (`npm stage approve`). Never `npm publish` from a laptop.
