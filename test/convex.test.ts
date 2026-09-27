/// <reference types="vite/client" />
import { Mira } from "@mirafive/sdk-server"
import { convexTest } from "convex-test"
import type { DataModelFromSchemaDefinition, GenericActionCtx, GenericMutationCtx } from "convex/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { MiraConvex } from "../src/index.ts"
import type { DeliverArgs, SchedulingCtx } from "../src/index.ts"
import { api, internal } from "./convex/_generated/api.js"
import { mira as typed } from "./convex/mirafive.ts"
import schema from "./convex/schema.ts"

const modules = import.meta.glob(["./convex/**/*.{ts,js}", "!./convex/**/*.d.ts"])

interface Sent {
  readonly url: string
  readonly auth: string | null
  readonly body: {
    readonly batch: string
    readonly mode: string
    readonly events: readonly Record<string, unknown>[]
  }
}

interface Answer {
  readonly status?: number
  readonly body?: Record<string, unknown>
}

let sent: Sent[] = []
let answers: Answer[] = []

const failing = (count: number, answer: Answer = { status: 503, body: { code: "oops" } }): Answer[] =>
  Array.from({ length: count }, () => answer)

beforeEach(() => {
  sent = []
  answers = []
  vi.spyOn(Math, "random").mockReturnValue(0)
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Sent["body"]
    const answer = answers.shift() ?? {}

    sent.push({ url, auth: new Headers(init.headers).get("authorization"), body })

    return Response.json(
      { batch: body.batch, accepted: body.events.length, dropped: 0, ...answer.body },
      { status: answer.status ?? 202 }
    )
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const scheduled = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())

const outboxRows = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.query("miraOutbox").collect())

describe("scheduling from a mutation", () => {
  it("schedules the delivery with runAfter(0) and sends it after commit", async () => {
    vi.useFakeTimers()
    const t = convexTest(schema, modules)

    await t.mutation(api.app.pay, { total: 49 })

    const [job] = await scheduled(t)

    expect(sent).toHaveLength(0)
    expect(job?.name).toBe("mirafive:deliver")
    expect(job?.scheduledTime).toBeCloseTo(job?._creationTime ?? 0, 0)

    await t.finishAllScheduledFunctions(vi.runAllTimers)

    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe("https://collector.test/v1/batch")
    expect(sent[0]?.auth).toBe("Bearer mf_test0000_secret")
    expect(sent[0]?.body.mode).toBe("full")
    expect(sent[0]?.body.events).toEqual([
      { name: "order paid", userId: "u_42", properties: { total: 49 }, time: expect.any(Number) }
    ])
  })

  it("sends nothing for a transaction that rolls back", async () => {
    vi.useFakeTimers()
    const t = convexTest(schema, modules)

    await expect(t.mutation(api.app.pay, { total: 49, fail: true })).rejects.toThrow("payment declined")
    await expect(t.mutation(api.app.pay, { total: 49, fail: true, outbox: true })).rejects.toThrow()

    expect(await scheduled(t)).toHaveLength(0)
    expect(await outboxRows(t)).toHaveLength(0)

    await t.finishAllScheduledFunctions(vi.runAllTimers)
    await t.action(internal.outbox.flushOutbox, {})

    expect(sent).toHaveLength(0)
  })

  it("sends trackMany and identify as batches, under the caller's idempotency key", async () => {
    vi.useFakeTimers()
    const t = convexTest(schema, modules)

    await t.mutation(api.app.checkout, { key: "order-981" })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    expect(sent).toHaveLength(2)
    expect(sent[0]?.body.events.map((event) => event["properties"])).toEqual([{ total: 1 }, { total: 2 }])
    expect(sent[0]?.body.events[0]?.["time"]).toBe(Date.parse("2026-09-27T10:00:00Z"))
    // The batch id is UUIDv8(SHA-256("mirafive:batch:order-981")), PROTOCOL §5.
    expect(sent[0]?.body.batch).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8/)
    expect(sent[1]?.body.events).toEqual([
      {
        name: "$identify",
        userId: "u_42",
        anonymousId: "anon_9",
        properties: { plan: "pro" },
        time: expect.any(Number)
      }
    ])
  })

  it("reuses the key minted at enqueue when the delivery is retried", async () => {
    vi.useFakeTimers()
    const t = convexTest(schema, modules)

    await t.mutation(api.app.pay, { total: 49 })
    // The scheduled run stays parked on the fake clock; the test runs the action itself, twice.
    vi.useRealTimers()

    const [job] = await scheduled(t)
    const args = job?.args[0] as DeliverArgs
    const send = vi.spyOn(Mira.prototype, "send")

    answers = failing(4)
    await expect(t.action(internal.mirafive.deliver, args)).rejects.toMatchObject({ code: "oops" })
    await t.action(internal.mirafive.deliver, args)

    expect(sent).toHaveLength(5)
    expect(new Set(sent.map((request) => request.body.batch)).size).toBe(1)
    // sentAt is fixed at queue time, so every run hands sdk-server the same batch.
    expect(typeof args.sentAt).toBe("number")
    expect(send.mock.calls.map(([, options]) => options)).toEqual([
      { idempotencyKey: args.idempotencyKey, sentAt: args.sentAt },
      { idempotencyKey: args.idempotencyKey, sentAt: args.sentAt }
    ])
  })

  it("never fails the caller's transaction over an event Convex or JSON cannot carry", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const t = convexTest(schema, modules)

    await t.mutation(api.app.odd, {})
    await t.mutation(api.app.odd, { outbox: true })

    expect(await t.run((ctx) => ctx.db.query("orders").collect())).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0]?.[0])).toContain("bigint")

    await t.finishAllScheduledFunctions(vi.runAllTimers)
    tick()
    await t.action(internal.outbox.flushOutbox, {})

    const odd = { $weird: 1, größe: "XL", ["k".repeat(1100)]: true }

    expect(sent.map((request) => request.body.events.map((event) => event["properties"]))).toEqual([
      [odd],
      [odd]
    ])
  })

  it("drops only the events the server refuses", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const t = convexTest(schema, modules)

    await t.mutation(api.app.bad, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    expect(sent.flatMap((request) => request.body.events.map((event) => event["properties"]))).toEqual([
      { total: 1 },
      { total: 3 }
    ])
    expect(warn).toHaveBeenCalledOnce()
  })
})

// Only the clock is faked in outbox tests: a flush takes rows created before it started.
const tick = (): void => {
  vi.setSystemTime(Date.now() + 1000)
}

describe("outbox", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
  })

  it("writes rows in the mutation and flushes them as one batch", async () => {
    const t = convexTest(schema, modules)

    await t.mutation(api.app.pay, { total: 1, outbox: true })
    await t.mutation(api.app.pay, { total: 2, outbox: true })

    expect(await scheduled(t)).toHaveLength(0)
    expect(await outboxRows(t)).toHaveLength(2)

    tick()
    await t.action(internal.outbox.flushOutbox, {})

    expect(sent).toHaveLength(1)
    expect(sent[0]?.body.events.map((event) => event["properties"])).toEqual([{ total: 1 }, { total: 2 }])
    expect(await outboxRows(t)).toHaveLength(0)
  })

  it("peeks only rows created before the cutoff, and a repeated drop is harmless", async () => {
    vi.setSystemTime(1_000)
    const t = convexTest(schema, modules)

    await t.mutation(api.app.pay, { total: 1, outbox: true })
    vi.setSystemTime(2_000)
    await t.mutation(api.app.pay, { total: 2, outbox: true })

    const early = await t.mutation(internal.outbox.outboxRows, { before: 1_500 })

    expect(early.map((row) => JSON.parse(row.event).properties)).toEqual([{ total: 1 }])

    const drop = early.map((row) => row._id)

    await t.mutation(internal.outbox.outboxRows, { before: 1_500, drop })
    await t.mutation(internal.outbox.outboxRows, { before: 1_500, drop })

    expect(await outboxRows(t)).toHaveLength(1)
  })

  it("keeps rows when delivery fails and resends them under the same batch id", async () => {
    const t = convexTest(schema, modules)

    await t.mutation(api.app.pay, { total: 1, outbox: true })

    const send = vi.spyOn(Mira.prototype, "send")

    answers = failing(4)
    tick()
    await expect(t.action(internal.outbox.flushOutbox, {})).rejects.toMatchObject({ retryable: true })
    expect(await outboxRows(t)).toHaveLength(1)

    tick()
    await t.action(internal.outbox.flushOutbox, {})

    expect(await outboxRows(t)).toHaveLength(0)
    expect(sent).toHaveLength(5)
    expect(new Set(sent.map((request) => request.body.batch)).size).toBe(1)
    // A later flush of the same rows passes the same sentAt, taken from the rows.
    expect(send.mock.calls[0]?.[1]).toEqual(send.mock.calls[1]?.[1])
  })

  it("does not wedge on events the server refuses", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const t = convexTest(schema, modules)

    await t.mutation(api.app.pay, { total: 1, outbox: true })
    answers = [{ status: 400, body: { code: "validation_failed" } }]
    tick()
    await t.action(internal.outbox.flushOutbox, {})

    expect(await outboxRows(t)).toHaveLength(0)
  })

  it.each(["collection_mode_not_allowed", "invalid_json"])(
    "keeps the rows on 400 %s, which no halving can fix",
    async (code) => {
      const t = convexTest(schema, modules)

      await t.mutation(api.app.pay, { total: 1, outbox: true })
      await t.mutation(api.app.pay, { total: 2, outbox: true })
      answers = [{ status: 400, body: { code } }]
      tick()

      await expect(t.action(internal.outbox.flushOutbox, {})).rejects.toMatchObject({ code })
      expect(sent).toHaveLength(1)
      expect(await outboxRows(t)).toHaveLength(2)
    }
  )

  it("schedules from an action, which has no table to write to", async () => {
    vi.useFakeTimers()
    const t = convexTest(schema, modules)

    await t.action(api.app.fromAction, {})

    expect(await outboxRows(t)).toHaveLength(0)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(sent[0]?.body.events[0]).toMatchObject({ name: "exported", userId: "u_42" })
  })
})

describe("off", () => {
  it("queues nothing when disabled or without a key, and warns once about the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const t = convexTest(schema, modules)

    await t.mutation(api.app.quiet, {})

    expect(await scheduled(t)).toHaveLength(0)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toContain("MIRAFIVE_SECRET_KEY")
  })

  it("refuses identifiers in consentless mode before touching the context", async () => {
    const mira = new MiraConvex({
      key: "mf_test0000_secret",
      mode: "consentless",
      deliver: internal.mirafive.deliver
    })
    const ctx = {} as SchedulingCtx

    await expect(mira.track(ctx, "signup", { userId: "u_42" })).rejects.toThrow(TypeError)
    await expect(mira.identify(ctx, "u_42")).rejects.toThrow(TypeError)
  })

  it("refuses an unparseable time at the call site instead of sending epoch 0", async () => {
    const mira = new MiraConvex({ key: "mf_test0000_secret", deliver: internal.mirafive.deliver })
    const ctx = {} as SchedulingCtx

    await expect(mira.track(ctx, "signup", { time: "yesterday-ish" })).rejects.toThrow(TypeError)
    await expect(mira.track(ctx, "signup", { time: new Date(Number.NaN) })).rejects.toThrow(TypeError)
    await expect(mira.trackMany(ctx, [{ name: "a" }, { name: "b", time: "not a date" }])).rejects.toThrow(
      /time must be/
    )
  })

  it("refuses an empty idempotency key", async () => {
    const mira = new MiraConvex({ key: "mf_test0000_secret", deliver: internal.mirafive.deliver })
    const ctx = {} as SchedulingCtx

    await expect(mira.track(ctx, "signup", { idempotencyKey: "" })).rejects.toThrow(TypeError)
    await expect(mira.trackMany(ctx, [{ name: "signup" }], { idempotencyKey: "" })).rejects.toThrow(
      /idempotencyKey/
    )
  })
})

describe("the delivery action", () => {
  it("warns about receipts that dropped events, but not for an install check", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const t = convexTest(schema, modules)
    const events = JSON.stringify([{ name: "$install_check" }])

    answers = [{ body: { accepted: 0, dropped: 1, reason: "install_check" } }]
    await t.action(internal.mirafive.deliver, { events, idempotencyKey: "install-check" })
    expect(warn).not.toHaveBeenCalled()

    answers = [{ body: { accepted: 0, dropped: 1, reason: "allowance_exhausted" } }]
    await t.action(internal.mirafive.deliver, { events, idempotencyKey: "second" })
    expect(String(warn.mock.calls[0]?.[0])).toContain("dropped 1 events: allowance_exhausted")
  })

  it("falls back to the default host for an empty one", async () => {
    const t = convexTest(schema, modules)

    await t.action(internal.off.deliverBare, { events: '[{"name":"signup"}]', idempotencyKey: "k" })

    expect(sent[0]?.url).toBe("https://events.mirafive.io/v1/batch")
  })
})

describe("types", () => {
  it("accepts a context typed by the customer's schema and narrows typed events", () => {
    type DataModel = DataModelFromSchemaDefinition<typeof schema>

    const use = (mutation: GenericMutationCtx<DataModel>, action: GenericActionCtx<DataModel>) => [
      typed.track(mutation, "order paid", { properties: { total: 1 } }),
      typed.trackMany(action, [{ name: "order paid", properties: { total: 2 } }]),
      // @ts-expect-error not a declared event
      typed.track(mutation, "order lost"),
      // @ts-expect-error wrong property type
      typed.track(mutation, "order paid", { properties: { total: "1" } })
    ]

    expect(use).toBeTypeOf("function")
  })
})
