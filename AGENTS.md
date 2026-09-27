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

## Local dependency on sdk-server

`@mirafive/sdk-server` is a devDependency as `file:../sdk-server` while it is unpublished
(its `dist/` must be built: `bun run build` there). Once 1.0.0 is on npm, switch the
devDependency to `^1.0.0` and refresh `bun.lock`; CI cannot resolve the `file:` path. The
peer range is already `^1.0.0`.

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
