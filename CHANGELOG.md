# Changelog

## 2.2.0 — 2026-11-10

### Added

- `mira.deletePerson(userId)`: erases one person (GDPR Art. 17) from an action with the secret
  key and resolves with the proof. It throws a `MiraError` with `retryable` instead of queueing,
  so a workpool can retry it; the erasure is idempotent. See `@mirafive/node` 2.3.1.

### Changed

- Requires `@mirafive/node` 2.3.1 and `@mirafive/protocol` 2.3.0.

## 2.1.2 — 2026-11-10

### Changed

- Requires `@mirafive/node` 2.2.1 (was `^2.1.1`): `fee` and `tax` on `revenue()` are deprecated
  there and no longer sent; passing them still compiles and does nothing.
- Built and checked with oxfmt 0.78 and oxlint 1.93.

## 2.1.1 — 2026-11-08

### Removed

- `dealStage` and `dealLost` from 2.1.0. A project's funnel maps its own events to stages on
  the MIRA FIVE server (Settings → Funnel): send the events your system already has. 2.1.0 is
  deprecated; nothing else changed.

## 2.1.0 — 2026-11-08 (deprecated)

- Added `dealStage` and `dealLost`; removed again in 2.1.1.

## 2.0.0 — 2026-11-08

A rewrite for the current MIRA FIVE platform: consent tiers, the revenue ledger, touchpoints and
the `/v1/batch` wire format.

### Added

- `mira.revenue(ctx, …)` and friends schedule delivery in the mutation's transaction;
  `dedupeKey`; touchpoints; no dependency on `convex`.

### Migrating from 1.x

- **Keys:** projects have a public key (`mira_pk_…`, browser and apps) and a secret key
  (`mira_sk_…`, servers). `mf_…` website and secret keys are gone. Every SDK refuses the wrong
  kind of key with a clear message.
- **Host:** `https://events.mirafive.io` (was `collect.mirafive.io`).
- **Environment:** `MIRAFIVE_SECRET_KEY` and `MIRAFIVE_HOST` on servers; the public key as
  `NEXT_PUBLIC_MIRAFIVE_KEY`, `VITE_MIRAFIVE_KEY`, `PUBLIC_MIRAFIVE_KEY` (Astro),
  `NUXT_PUBLIC_MIRAFIVE_KEY` or `MIRAFIVE_PUBLIC_KEY` (PHP templates).
- **Consent:** there are no modes any more. The browser SDK follows the site's consent banner
  (`consent: "auto"`) and collects what each tier allows: cookieless without consent, an
  anonymous id with analytics consent, a user with `identify`. Server events carry the consent
  they were collected under (default `not_applicable`).
- **Revenue:** `revenue()` on the server SDKs, in integer minor units with an ISO currency,
  `entryId` (replaces `payment_id`), `entryKind`, fees, tax, refunds and subscriptions. Revenue
  properties on plain events are no longer read.
