# Changelog

## 0.5.0 — unreleased

Rebuilt from scratch on `@mirafive/sdk-server` 0.5 and the v1 ingest protocol.

- `MiraConvex`: `track()`, `trackMany()` and `identify()` from mutations and actions. A
  mutation schedules the delivery with `runAfter(0)`, so a rolled-back transaction sends
  nothing. `identify(ctx, userId, traits?, { anonymousId? })` links the browser's anonymous
  id. Typed events (types only), `mode: "consentless"`, `disabled`, and a missing key
  drops events with one warning instead of failing the deployment. An unparseable `time`
  throws a `TypeError` at the call site rather than being sent as epoch 0.
- `deliverAction()`: the internal action that sends one delivery with an idempotency key
  fixed at enqueue time, so every retry of it is stored once. `enqueue` hands deliveries
  to a workpool.
- Outbox: `outbox: true`, `miraOutboxTable` in the customer's own schema, and
  `flushOutbox()` for a cron. Batches of up to 1000 events or 1 MB, read below a
  `_creationTime` cutoff, named after their row ids.
- Events the server refuses as malformed are isolated by halving the batch and dropped
  one by one, so they never block the rest.
