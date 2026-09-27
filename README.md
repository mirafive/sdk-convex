# @mirafive/sdk-convex

Record events from Convex mutations and actions. A mutation never sends: the event leaves
only after the transaction commits, so an order that rolled back is never counted.
Privacy-first analytics from MIRA FIVE, hosted in the EU.

## Size

| Import | min + gzip |
|---|---|
| `@mirafive/sdk-convex` | 1.68 kB |

Measured without its peers: `@mirafive/sdk-server` (2.83 kB) sends the batches, `convex`
is already in your deployment. One entry, `sideEffects: false`.

## Install

```sh
npm install @mirafive/sdk-convex @mirafive/sdk-server
# or: bun add / pnpm add / yarn add
```

Peers: `convex` ≥ 1.25 and `@mirafive/sdk-server` 0.5. Runs in Convex's default runtime;
no `"use node"`.

## Quickstart

1. Set the secret key of a MIRA FIVE server source on the deployment:

```sh
npx convex env set MIRAFIVE_SECRET_KEY mf_…
```

2. Create `convex/mirafive.ts` and export the delivery action:

```ts
// convex/mirafive.ts
import { MiraConvex } from "@mirafive/sdk-convex"
import { internal } from "./_generated/api"

export const mira: MiraConvex = new MiraConvex({
  key: process.env.MIRAFIVE_SECRET_KEY,
  deliver: internal.mirafive.deliver
})

export const deliver = mira.deliverAction()
```

The `: MiraConvex` annotation is required: `mira` refers to `internal.mirafive.deliver`,
whose generated type is derived from this module, so without it TypeScript reports TS7022
(`'mira' implicitly has type 'any'`). With typed events, annotate
`MiraConvex<Events>`.

3. Track where things happen:

```ts
// convex/orders.ts
import { v } from "convex/values"
import { mutation } from "./_generated/server"
import { mira } from "./mirafive"

export const pay = mutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId)
    await ctx.db.patch(orderId, { paidAt: Date.now() })

    await mira.track(ctx, "order paid", {
      userId: order.customerId,
      properties: { revenue: order.total, currency: "EUR" },
      idempotencyKey: `order-${orderId}`
    })
  }
})
```

`track()` schedules `deliver` with `ctx.scheduler.runAfter(0, …)`, which Convex runs only
if the mutation commits. `trackMany(ctx, events)` puts several events in one delivery (one
action run, one batch); `identify(ctx, userId, traits, { anonymousId })` sends `$identify`
and links the browser's anonymous id, when you have it. All three work in actions too.

Verify it: run the delivery action once with `$install_check`. It proves the key and host
work and is never stored or billed.

```sh
npx convex run mirafive:deliver '{"events":"[{\"name\":\"$install_check\"}]","idempotencyKey":"install-check"}'
```

`events` is a JSON string, as the queue stores it. The command prints `null` when the server
accepted the batch and fails with the server's error otherwise.

### The outbox: batching for busy deployments

The default runs one action per `track()` (or `trackMany()`) call. That is immediate, needs
no setup, and is the right choice below roughly one event per second. Above that, turn on
the outbox: mutations write events to a table in your own schema, and a cron sends them in
batches of up to 1000.

```ts
// convex/schema.ts
import { miraOutboxTable } from "@mirafive/sdk-convex"
import { defineSchema } from "convex/server"

export default defineSchema({
  // …your tables
  miraOutbox: miraOutboxTable
})
```

```ts
// convex/mirafive.ts
export const mira: MiraConvex = new MiraConvex({
  key: process.env.MIRAFIVE_SECRET_KEY,
  outbox: true,
  deliver: internal.mirafive.deliver
})

export const deliver = mira.deliverAction()
export const { flushOutbox, outboxRows } = mira.flushOutbox()
```

```ts
// convex/crons.ts
import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

crons.interval("mirafive outbox", { seconds: 30 }, internal.mirafive.flushOutbox)

export default crons
```

The table must be named `miraOutbox`, and `flushOutbox` and `outboxRows` must be exported
under those names from the module that exports `deliver`: the drain finds `outboxRows`
next to `deliver`.

| | Per-event scheduling (default) | Outbox |
|---|---|---|
| Latency | immediate | up to one cron interval |
| Cost | one action run per call | an insert and a delete per event; one action run per flush |
| Setup | none | schema table, two exports, a cron |
| When a send fails | lost after sdk-server's 3 retries, unless you use a workpool | rows stay and go with the next flush |
| Inspectable | `_scheduled_functions` | your `miraOutbox` table |

Metering is per event either way: batching saves Convex action time, not MIRA FIVE cost.

An action has no table to write to, so `track()` from an action schedules a delivery even
with `outbox: true`.

### Retries with a workpool

The scheduler does not retry a failed action. For retries across attempts, hand deliveries
to a [workpool](https://www.convex.dev/components/workpool):

```ts
import { Workpool } from "@convex-dev/workpool"
import { components, internal } from "./_generated/api"
import type { MutationCtx } from "./_generated/server"

const pool = new Workpool(components.mirafivePool, { maxParallelism: 2, retryActionsByDefault: true })

export const mira: MiraConvex = new MiraConvex({
  key: process.env.MIRAFIVE_SECRET_KEY,
  deliver: internal.mirafive.deliver,
  enqueue: (ctx, deliver, args) => pool.enqueueAction(ctx as MutationCtx, deliver, args)
})
```

Every delivery carries an idempotency key chosen when it was queued (yours, or a fresh
UUID), so a retried delivery is stored once.

## Consent & privacy

- Default mode: `full`. Server events carry the identifiers you pass (`userId`,
  `anonymousId`, `sessionId`); you, the customer, hold the consent or other lawful basis
  for them. Use your own pseudonymous user id, never an email address.
- `mode: "consentless"` counts without identifiers. Passing `userId`, `anonymousId` or
  `sessionId` (or calling `identify()`) then throws a `TypeError` in the calling function.
- Do Not Track and Global Privacy Control reach a server as `DNT: 1` / `Sec-GPC: 1` headers
  (for example in an `httpAction`). Leave the identifiers out of `track()` for such requests.
- Outbox rows are your data in your own table, `miraOutbox`, one event per row as a JSON
  string in `event`: you can open, count and delete them like any other table. A row lives until the next flush sends it, then it is
  deleted. This package stores nothing anywhere else.
- Without the outbox, a queued delivery's arguments sit in Convex's
  `_scheduled_functions` system table, which Convex keeps for a while after the run, as for
  every scheduled function.
- The secret key stays in the deployment's environment. Never put it in client code.

## API reference

`new MiraConvex<Events>(options)` never throws, so a module that creates it cannot take the
deployment down.

| Option | Default | |
|---|---|---|
| `key` | — | `process.env.MIRAFIVE_SECRET_KEY`. Missing: events are dropped, with one warning in the logs |
| `host` | `https://events.mirafive.io` | must include the scheme; empty means the default |
| `mode` | `"full"` | or `"consentless"` |
| `deliver` | — | required: the exported `deliverAction()`, e.g. `internal.mirafive.deliver` |
| `outbox` | `false` | mutations write to `miraOutbox` instead of scheduling |
| `enqueue` | `ctx.scheduler.runAfter(0, deliver, args)` | `(ctx, deliver, args) => Promise<unknown>`, e.g. a workpool |
| `disabled` | `false` | drop every event, e.g. on preview deployments |

| Member | |
|---|---|
| `track(ctx, name, { userId?, anonymousId?, sessionId?, properties?, time?, page?, idempotencyKey? }): Promise<void>` | queue one event; `time` is a `Date`, epoch ms or ISO string, default the start of the calling function; an unparseable one throws a `TypeError` |
| `trackMany(ctx, events, { idempotencyKey? }?): Promise<void>` | queue 1–1000 events (`{ name, …same fields }`) as one delivery |
| `identify(ctx, userId, traits?, { anonymousId? }?): Promise<void>` | queue `$identify`: the user's traits, linked to the anonymous id when given |
| `deliverAction()` | the internal action that sends one delivery; export it as `deliver` |
| `flushOutbox(): { flushOutbox, outboxRows }` | the cron action and its internal mutation; export both |

| Export | |
|---|---|
| `miraOutboxTable` | the outbox table for `defineSchema({ miraOutbox: miraOutboxTable })` |
| `MiraError` | re-exported from `@mirafive/sdk-server` |

`ctx` is any mutation or action context (queries cannot schedule). `idempotencyKey`
names the batch (PROTOCOL §5): the same key is stored once; an empty one throws a
`TypeError`. It is ignored for events that
go to the outbox, whose batches are named after the rows they carry.

Typed events are types only: `export const mira: MiraConvex<Events> = new MiraConvex<Events>(…)`
with `type Events = { "order paid": { revenue: number } }` narrows the names and properties
of `track()` and `trackMany()`.

Types: `MiraConvexOptions`, `TrackOptions`, `TrackEvent`, `SchedulingCtx`, `Enqueue`,
`DeliverArgs`, `DeliverReference`, `QueuedEvent`, `OutboxRow`, `OutboxRowsArgs`,
`OutboxFunctions`, `Events`, `Mode`, `Page`, `Receipt`.

## Framework / runtime notes

- A Convex mutation is a deterministic transaction without network access. Nothing here
  sends from a mutation; delivery happens in the `deliver` action or the `flushOutbox`
  cron, both in the default Convex runtime.
- Events travel as JSON strings, in the scheduler's arguments and in outbox rows, so
  property keys Convex refuses as field names (`$…`, `_…`, non-ASCII) are fine; the
  protocol's own limits (keys up to 128 characters, PROTOCOL §3) still apply. An event JSON cannot carry (a `BigInt`, a cycle) is dropped with a warning; it never
  fails the caller's transaction.
- `deliver` sends with `@mirafive/sdk-server`: three retries on 408, 429, 5xx, network
  errors and timeouts. The idempotency key, `sentAt` and every event's `time` are fixed when
  the event is queued (for the outbox: taken from the rows), so a rerun of the action sends
  the byte-identical batch. If
  every retry fails, the action fails and shows up in the Convex logs (and a workpool
  retries it).
- Events the server refuses (`400 validation_failed`, or refused before sending as an
  invalid name, id, time or size) are found by halving the batch, dropped one by one with
  a warning in the logs, and the rest is sent. A malformed event therefore never blocks the
  outbox. Other refusals (`collection_mode_not_allowed`, `invalid_json`, a wrong key)
  concern the whole source: the run fails and outbox rows are kept until it is fixed.
- A receipt that reports dropped events (`ingestion_paused`, `allowance_exhausted`) is
  logged as a warning; `bot` and `install_check` are not.
- `flushOutbox` reads only rows created before it started, so rows written during a flush
  go with the next one. Convex runs at most one instance of a cron at a time, which is what
  lets it read, send and delete without a lock. A batch is named after its row ids: sent
  but not yet deleted, it is resent under the same batch id and stored once. One run drains
  the whole backlog, at most 1000 events or 1 MB per batch.
- Deliveries report `mirafive-server` as their SDK: this package has no transport of its own.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Nothing arrives | Check the Convex logs. `[mirafive] no key`: run `npx convex env set MIRAFIVE_SECRET_KEY …`. A failed `deliver` shows the server's error. With the outbox: is the cron in `convex/crons.ts` deployed? |
| `Could not find function …:outboxRows` | Export `flushOutbox` and `outboxRows` from the module that exports `deliver`, under those names. |
| `miraOutbox` table or validator errors | Add `miraOutbox: miraOutboxTable` to `convex/schema.ts`. |
| `403 website_key_as_bearer` | You set the website key; server sources need the secret key. |
| `400 collection_mode_not_allowed` | The source is consentless; pass `mode: "consentless"` and no identifiers. Outbox rows wait until then. |
| TS7022 `'mira' implicitly has type 'any'` | Annotate it: `export const mira: MiraConvex = new MiraConvex({ … })`. |
| `[mirafive] the server dropped N events: …` | `allowance_exhausted` or `ingestion_paused` on the source in MIRA FIVE. |
| `TypeError: consentless mode …` | Identifiers in consentless mode; remove them or switch the mode. |
| `TypeError: time must be …` | `time` is not a `Date`, epoch ms or parseable date string. |
| `[mirafive] dropped an event the server refuses` | A name starting with `$` that is not reserved, a blank id, a non-UUID `sessionId`, or properties over the limits (keys over 128 characters, over 32 KB, PROTOCOL §3). |
| The outbox grows | Deliveries fail (see the `flushOutbox` runs in the logs), typically a wrong key: rows are kept until it is fixed. |

## For AI agents

Copy-paste setup prompt:

```text
Add MIRA FIVE server-side analytics to this Convex project with @mirafive/sdk-convex.
1. Install @mirafive/sdk-convex and @mirafive/sdk-server with the project's package manager.
2. The secret key goes in the Convex deployment's environment, never in code or client bundles:
   tell the user to run `npx convex env set MIRAFIVE_SECRET_KEY <key>` (a server source's secret key).
3. Create convex/mirafive.ts:
     import { MiraConvex } from "@mirafive/sdk-convex"
     import { internal } from "./_generated/api"
     export const mira: MiraConvex = new MiraConvex({ key: process.env.MIRAFIVE_SECRET_KEY, deliver: internal.mirafive.deliver })
   Keep the `: MiraConvex` annotation (without it TypeScript reports TS7022).
     export const deliver = mira.deliverAction()
4. In the mutations where business events happen (signup, order paid, subscription started), add
   `await mira.track(ctx, "order paid", { userId, properties: { revenue, currency: "EUR" } })` and
   `await mira.identify(ctx, userId, { plan }, { anonymousId })` after signup (anonymousId only if the browser sent it). Use the internal user id, never an email.
   Several events in one mutation: `await mira.trackMany(ctx, [{ name, ... }, ...])`.
5. Only if the app records more than about one event per second: pass `outbox: true`, add
   `miraOutbox: miraOutboxTable` to convex/schema.ts, export
   `export const { flushOutbox, outboxRows } = mira.flushOutbox()` from convex/mirafive.ts, and add
   `crons.interval("mirafive outbox", { seconds: 30 }, internal.mirafive.flushOutbox)` to convex/crons.ts.
6. Server events are "full" mode by default: the app holds consent. For anonymous counts only, use
   `mode: "consentless"` and pass no userId/anonymousId/sessionId.
7. Verify: `npx convex run mirafive:deliver '{"events":"[{\"name\":\"$install_check\"}]","idempotencyKey":"install-check"}'`
   prints null. Then report what you changed.
Do not add other analytics libraries, cookies or consent banners, and do not call fetch from mutations.
```

Facts for agents:

- Imports: `import { MiraConvex, miraOutboxTable } from "@mirafive/sdk-convex"`. There are no
  subpaths.
- Env vars: `MIRAFIVE_SECRET_KEY` (server only, required), set with
  `npx convex env set MIRAFIVE_SECRET_KEY …`; `MIRAFIVE_HOST` (optional, default
  `https://events.mirafive.io`), passed as `host`. The package reads no env vars itself.
- Never ship `MIRAFIVE_SECRET_KEY` to a browser bundle; a secret key in a browser is
  refused and marked exposed. Browsers use `@mirafive/sdk-browser` with the website key.
- `track()`, `trackMany()` and `identify()` return promises: `await` them. They never throw
  for transport reasons, and never over a payload Convex cannot store (it is dropped with a
  warning); they throw a `TypeError` only for programming errors (identifiers in consentless
  mode, an unparseable `time`, an empty `idempotencyKey`, an empty or over-1000 `trackMany`).
- Annotate the client: `export const mira: MiraConvex = new MiraConvex({ … })`
  (`MiraConvex<Events>` with typed events); without it, codegen makes TS7022.
- A mutation never sends; rolled-back mutations send nothing. Delivery failures appear in
  the Convex logs as failed `deliver` / `flushOutbox` runs.
- `deliver` must be exported under the name the `deliver` option references
  (`internal.mirafive.deliver` ↔ `export const deliver` in `convex/mirafive.ts`).
  With the outbox, `flushOutbox` and `outboxRows` live in the same module under those names,
  and the schema table is `miraOutbox`.
- Event names starting with `$` are reserved; use plain names like `order paid`. Revenue
  goes in `properties: { revenue: 49.9, currency: "EUR" }`.
- Verify an install: `npx convex run mirafive:deliver '{"events":"[{\"name\":\"$install_check\"}]","idempotencyKey":"install-check"}'`
  prints `null`; `$install_check` is never stored or billed.
- Wire contract: [mirafive/protocol](https://github.com/mirafive/protocol).

## License

[MIT](LICENSE) © 2026 Cloo GmbH
