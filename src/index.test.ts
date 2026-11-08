import { describe, expect, test } from "bun:test";

import { validateEvent } from "@mirafive/protocol";

import { eventIdFor, MiraConvex, type MiraEvent, type SchedulerCtx } from "./index";

/** A fake ingest that accepts everything and keeps what it received. */
function fakeFetch() {
  const events: Record<string, any>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    events.push(...(JSON.parse(init.body as string) as { events: Record<string, any>[] }).events);
    return Response.json({ accepted: 1, duplicates: 0, rejected: [] }, { status: 202 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, events };
}

/** A mutation context whose scheduler records what it was asked to run. */
function fakeCtx() {
  const scheduled: { delay: number; fn: unknown; args: { events: MiraEvent[] } }[] = [];
  const ctx: SchedulerCtx = {
    scheduler: {
      runAfter: async (delay: number, fn: never, args: never) => {
        // A Convex value: what JSON can carry, and no undefined.
        expect(JSON.parse(JSON.stringify(args))).toEqual(args);
        scheduled.push({ delay, fn, args });
      },
    },
  };
  return { ctx, scheduled };
}

const options = { secretKey: "mira_sk_test", host: "https://ingest.example" };
const DELIVER = { name: "internal.mira.deliver" };

describe("MiraConvex", () => {
  test("schedules each method through ctx.scheduler as a Convex value", async () => {
    const { ctx, scheduled } = fakeCtx();
    const mira = new MiraConvex(DELIVER, options);
    await mira.track(ctx, { event: "order_paid", userId: "u1", timestamp: new Date(0) });
    await mira.revenue(ctx, {
      userId: "u1",
      amount: 4900,
      currency: "EUR",
      dedupeKey: "order:1:paid",
      product: undefined,
    });
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0]?.delay).toBe(0);
    expect(scheduled[0]?.fn).toBe(DELIVER);
    expect(scheduled[0]?.args.events[0]).toEqual({
      method: "track",
      event: "order_paid",
      userId: "u1",
      timestamp: "1970-01-01T00:00:00.000Z",
    });
    expect(scheduled[1]?.args.events[0]).not.toHaveProperty("product");
  });

  test("a failing scheduler never fails the mutation", async () => {
    const errors: string[] = [];
    const mira = new MiraConvex(DELIVER, {
      ...options,
      onError: (error) => errors.push(error.code),
    });
    const ctx: SchedulerCtx = {
      scheduler: { runAfter: () => Promise.reject(new Error("nope")) },
    };
    await mira.track(ctx, { event: "x" });
    expect(errors).toEqual(["dropped"]);
  });

  test("deliver sends every kind in the wire format and turns dedupe keys into stable ids", async () => {
    const fake = fakeFetch();
    const mira = new MiraConvex(DELIVER, { ...options, fetch: fake.fetch });
    const result = await mira.deliver([
      { method: "track", event: "order_paid", userId: "u1", dedupeKey: "order:1:paid" },
      {
        method: "identify",
        userId: "u1",
        traits: { plan: "pro" },
        externalIds: { stripe_customer: "cus_1" },
      },
      { method: "group", groupId: "acme", userId: "u1", traits: { plan: "team" } },
      {
        method: "revenue",
        userId: "u1",
        amount: 500,
        currency: "EUR",
        dedupeKey: "order:1:revenue",
      },
      { method: "touchpoint", kind: "survey", userId: "u1", source: "podcast" },
      { method: "touchpoint", kind: "survey", userId: "u1" } as never,
    ]);
    // The last one is invalid on purpose: a touchpoint needs a channel or a source.
    expect(result.sent).toBe(5);
    expect(result.failed).toBe(1);
    expect(fake.events[0]?.event_id).toBe(await eventIdFor("order:1:paid"));
    expect(fake.events.map((event) => event.event)).toEqual([
      "order_paid",
      "$identify",
      "$group",
      "$revenue",
      "$touchpoint",
    ]);
    for (const event of fake.events) {
      expect(validateEvent(event)).toEqual([]);
      expect(event.kind).toBeUndefined();
      expect(event.dedupeKey).toBeUndefined();
    }
  });

  test("an unknown kind is reported, the rest is sent", async () => {
    const fake = fakeFetch();
    const mira = new MiraConvex(DELIVER, { ...options, fetch: fake.fetch });
    const result = await mira.deliver([
      { method: "nope" } as never,
      { method: "track", event: "ok" },
    ]);
    expect(result).toEqual({
      sent: 1,
      failed: 1,
      errors: ["MIRA FIVE: unknown method: nope"],
    });
  });

  test("reports a missing key instead of throwing", async () => {
    const mira = new MiraConvex(DELIVER, { secretKey: "" });
    const result = await mira.deliver([{ method: "track", event: "x" }]);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain("MIRAFIVE_SECRET_KEY");
  });
});
