# @mirafive/convex

MIRA FIVE for [Convex](https://convex.dev): track events and revenue from mutations. A mutation
cannot use the network, so the event is scheduled in the same transaction and an internal action
delivers it right after the commit. A mutation that rolls back sends nothing, so an order that
never happened is never counted. Built on [`@mirafive/node`](https://github.com/mirafive/sdk-node);
no dependency on `convex`, and it runs in Convex's default runtime (no `"use node"`).

## Install

```sh
npm install @mirafive/convex
npx convex env set MIRAFIVE_SECRET_KEY mira_sk_…
```

## Setup

```ts
// convex/mira.ts
import { MiraConvex } from "@mirafive/convex";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

// The `: MiraConvex` annotation is required: it breaks the type cycle through `internal`.
export const mira: MiraConvex = new MiraConvex(internal.mira.deliver);

export const deliver = internalAction({
  args: { events: v.array(v.any()) },
  handler: (_ctx, { events }) => mira.deliver(events),
});
```

## Use

```ts
// convex/orders.ts
import { v } from "convex/values";

import { mutation } from "./_generated/server";
import { mira } from "./mira";

export const pay = mutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId);
    await ctx.db.patch(orderId, { status: "paid" });
    await mira.revenue(ctx, {
      userId: order.userId,
      amount: order.totalCents,
      currency: "EUR",
      entryId: `order:${orderId}`,
      // A stable key: a retried mutation schedules the event again, the ingest counts it once.
      dedupeKey: `order:${orderId}:paid`,
    });
  },
});
```

| Method                                                                        | Sends                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `mira.track(ctx, { event, userId?, properties?, … })`                         | A custom event                                                                        |
| `mira.identify(ctx, { userId, traits?, externalIds? })`                       | Who the user is                                                                       |
| `mira.group(ctx, { groupId, traits? })`                                       | The company or account                                                                |
| `mira.revenue(ctx, { amount, currency, entryId?, subscription?, … })`         | Money for the revenue ledger                                                          |
| `mira.touchpoint(ctx, { kind, source \| channel, userId \| anonymousId, … })` | A touchpoint that is not a visit                                                      |
| `mira.dealStage(ctx, { dealId, stage, value?, userId \\                       | anonymousId })`                                                                       | A deal of the pipeline reached a stage (value in minor units, expected, not revenue) |
| `mira.dealLost(ctx, { dealId, reason?, userId \\                              | anonymousId })`                                                                       | A deal was lost                                                                      |
| `mira.schedule(ctx, events)`                                                  | Several at once (`{ method: "track", … }`)                                            |
| `mira.deliver(events)`                                                        | Sends now; for the internal action. Returns `{ sent, failed, errors }`, never throws. |

Every method takes the same fields as [`@mirafive/node`](https://github.com/mirafive/sdk-node#readme)
plus `dedupeKey`. `Date` values are converted for the scheduler. Scheduling never fails your
mutation: a problem goes to `onError` (`new MiraConvex(ref, { onError })`).

## For AI coding assistants

Rules for integrating MIRA FIVE correctly. They hold for every MIRA FIVE SDK.

- **Keys:** the public key (`mira_pk_…`) goes in browser and app code. The secret key (`mira_sk_…`)
  goes only into the server's environment (`MIRAFIVE_SECRET_KEY`), never into client code, a
  `NEXT_PUBLIC_`/`VITE_`/`PUBLIC_` variable or a repository. The SDKs refuse the wrong key.
- **Money** is sent only from the server: integer minor units plus an ISO 4217 currency
  (`amount: 1999, currency: "EUR"` is 19.99 EUR), never floats.
- **Count once:** give money an `entryId` from the payment provider (`stripe:in_123`), so the
  Stripe connector and retries do not double it. Give business events a stable id:
  `eventId: await eventIdFor("order:123:paid")`. The same key gives the same id in every SDK.
- **Personal data** never goes into event names or properties. Use your own user id (not an email)
  for `identify`; put email, name and phone in its traits, which MIRA FIVE encrypts at rest.
- **Consent:** keep `consent: "auto"`; it follows the site's consent banner (Usercentrics,
  Cookiebot, consentmanager, CCM19, Borlabs, any TCF 2.2 CMP, Google Consent Mode). Call
  `consent()` only for a custom banner. Do not gate the SDK behind consent yourself: without
  consent it is cookieless and still counts.
- **Never block on analytics:** event methods return nothing, never throw, and batch on their
  own. Do not `await` or `try` them. Call `flush()`/`shutdown()` only at the end of a script or a
  serverless function.
- **Server events and visitors:** pass the browser's `mira.anonymousId` to your server and set it
  as `anonymousId` on server events, so a purchase joins the visit and its source.
