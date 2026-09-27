import { actionGeneric, mutationGeneric } from "convex/server"
import { v } from "convex/values"

import { mira, plain } from "./mirafive.ts"
import { disabled, keyless } from "./off.ts"
import { mira as outboxed } from "./outbox.ts"

export const pay = mutationGeneric({
  args: { total: v.number(), fail: v.optional(v.boolean()), outbox: v.optional(v.boolean()) },
  handler: async (ctx, { total, fail, outbox }) => {
    await ctx.db.insert("orders", { total })
    const event = { userId: "u_42", sessionId: undefined, properties: { total } }

    await (outbox ? outboxed.track(ctx, "order paid", event) : mira.track(ctx, "order paid", event))

    if (fail) {
      throw new Error("payment declined")
    }
  }
})

export const checkout = mutationGeneric({
  args: { key: v.optional(v.string()) },
  handler: async (ctx, { key }) => {
    await mira.trackMany(
      ctx,
      [
        { name: "order paid", properties: { total: 1 }, time: new Date("2026-09-27T10:00:00Z") },
        { name: "order paid", properties: { total: 2 } }
      ],
      { idempotencyKey: key }
    )
    await mira.identify(ctx, "u_42", { plan: "pro" }, { anonymousId: "anon_9" })
  }
})

export const bad = mutationGeneric({
  args: {},
  handler: async (ctx) => {
    await mira.trackMany(ctx, [
      { name: "order paid", properties: { total: 1 } },
      { name: "$bogus" as "order paid", properties: { total: 2 } },
      { name: "order paid", properties: { total: 3 } }
    ])
  }
})

export const quiet = mutationGeneric({
  args: {},
  handler: async (ctx) => {
    await disabled.track(ctx, "x")
    await keyless.track(ctx, "x")
    await keyless.track(ctx, "y")
  }
})

export const fromAction = actionGeneric({
  args: {},
  handler: async (ctx) => {
    await outboxed.track(ctx, "exported", { userId: "u_42" })
  }
})

export const odd = mutationGeneric({
  args: { outbox: v.optional(v.boolean()) },
  handler: async (ctx, { outbox }) => {
    const client = outbox ? outboxed : plain

    await ctx.db.insert("orders", { total: 7 })
    await client.track(ctx, "odd keys", { properties: { $weird: 1, größe: "XL", ["k".repeat(1100)]: true } })
    await client.track(ctx, "bigint", { properties: { amount: 10n } })
  }
})
