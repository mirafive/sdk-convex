/**
 * `@mirafive/convex`: MIRA FIVE events from Convex mutations and actions.
 *
 * Mutations are transactional and cannot use the network, so an event is scheduled with
 * `ctx.scheduler` in the same transaction and delivered by an internal action right after it
 * commits. A mutation that rolls back sends nothing, so an order that never happened is never
 * counted. No dependency on `convex`; it runs in Convex's default runtime (no `"use node"`).
 *
 * ```ts
 * // convex/mira.ts
 * import { MiraConvex } from "@mirafive/convex";
 * import { v } from "convex/values";
 * import { internal } from "./_generated/api";
 * import { internalAction } from "./_generated/server";
 *
 * // The `: MiraConvex` annotation is required: it breaks the type cycle through `internal`.
 * export const mira: MiraConvex = new MiraConvex(internal.mira.deliver);
 *
 * export const deliver = internalAction({
 *   args: { events: v.array(v.any()) },
 *   handler: (_ctx, { events }) => mira.deliver(events),
 * });
 *
 * // convex/orders.ts, in a mutation
 * await mira.revenue(ctx, { userId, amount: 4900, currency: "EUR", dedupeKey: `order:${id}:paid` });
 * ```
 */
import {
  eventIdFor,
  Mira,
  MiraError,
  type DealLostInput,
  type DealStageInput,
  type EventMap,
  type GroupInput,
  type IdentifyInput,
  type MiraOptions,
  type RevenueInput,
  type TouchpointInput,
  type TrackInput,
} from "@mirafive/node";

export { eventIdFor, MiraError } from "@mirafive/node";
export type {
  DealLostInput,
  DealStageInput,
  EventMap,
  GroupInput,
  IdentifyInput,
  MiraOptions,
  RevenueInput,
  TouchpointInput,
  TrackInput,
} from "@mirafive/node";

/** A stable key (`order:123:paid`) that becomes the event id, so a retried mutation counts once. */
interface Dedupe {
  dedupeKey?: string;
}

/** One event as it travels through `ctx.scheduler`: the method, its input and a dedupe key. */
export type MiraEvent =
  | ({ method: "track" } & TrackInput & Dedupe)
  | ({ method: "identify" } & IdentifyInput & Dedupe)
  | ({ method: "group" } & GroupInput & Dedupe)
  | ({ method: "revenue" } & RevenueInput & Dedupe)
  | ({ method: "touchpoint" } & TouchpointInput & Dedupe)
  | ({ method: "dealStage" } & DealStageInput & Dedupe)
  | ({ method: "dealLost" } & DealLostInput & Dedupe);

/** The part of a Convex mutation or action context this package uses. */
export interface SchedulerCtx {
  scheduler: { runAfter: (delayMs: number, fn: never, args: never) => Promise<unknown> };
}

export interface DeliverResult {
  sent: number;
  failed: number;
  errors: string[];
}

/**
 * Makes an event a Convex value: `Date`s become ISO strings and `undefined` fields disappear,
 * so `ctx.scheduler` accepts it.
 */
const toConvexValue = (event: MiraEvent): MiraEvent =>
  JSON.parse(JSON.stringify(event)) as MiraEvent;

export class MiraConvex<Events extends EventMap = EventMap> {
  /**
   * @param deliverFunction The internal action that calls `mira.deliver(events)`, for example
   *   `internal.mira.deliver`.
   * @param options Delivery options. The key defaults to the deployment's `MIRAFIVE_SECRET_KEY`
   *   (`npx convex env set MIRAFIVE_SECRET_KEY mira_sk_…`) and the host to `MIRAFIVE_HOST`.
   */
  private readonly deliverFunction: unknown;
  private readonly options: MiraOptions;

  constructor(deliverFunction: unknown, options: MiraOptions = {}) {
    this.deliverFunction = deliverFunction;
    this.options = options;
  }

  /** A custom event, sent after the current mutation commits. */
  track<Name extends keyof Events & string>(
    ctx: SchedulerCtx,
    input: TrackInput<Events, Name> & Dedupe,
  ): Promise<void> {
    return this.schedule(ctx, [{ method: "track", ...(input as TrackInput & Dedupe) }]);
  }

  identify(ctx: SchedulerCtx, input: IdentifyInput & Dedupe): Promise<void> {
    return this.schedule(ctx, [{ method: "identify", ...input }]);
  }

  group(ctx: SchedulerCtx, input: GroupInput & Dedupe): Promise<void> {
    return this.schedule(ctx, [{ method: "group", ...input }]);
  }

  /** Money for the revenue ledger. Give it a `dedupeKey` or `entryId`, so a retry counts once. */
  revenue(ctx: SchedulerCtx, input: RevenueInput & Dedupe): Promise<void> {
    return this.schedule(ctx, [{ method: "revenue", ...input }]);
  }

  touchpoint(ctx: SchedulerCtx, input: TouchpointInput & Dedupe): Promise<void> {
    return this.schedule(ctx, [{ method: "touchpoint", ...input }]);
  }

  /**
   * A deal of the pipeline reached a stage, sent after the mutation that moved it commits.
   * A stable `dedupeKey` (`case:${id}:stage:${stage}`) keeps a retried mutation from counting twice.
   */
  dealStage(ctx: SchedulerCtx, input: DealStageInput & Dedupe): Promise<void> {
    return this.schedule(ctx, [{ method: "dealStage", ...input }]);
  }

  /** A deal was lost, sent after the mutation commits. */
  dealLost(ctx: SchedulerCtx, input: DealLostInput & Dedupe): Promise<void> {
    return this.schedule(ctx, [{ method: "dealLost", ...input }]);
  }

  /** Several events in one scheduled delivery. */
  async schedule(ctx: SchedulerCtx, events: MiraEvent[]): Promise<void> {
    if (!events.length) return;
    try {
      await ctx.scheduler.runAfter(
        0,
        this.deliverFunction as never,
        {
          events: events.map(toConvexValue),
        } as never,
      );
    } catch (error) {
      // Analytics must never fail the mutation that records the real fact.
      this.options.onError?.(
        new MiraError("dropped", "could not schedule delivery", { cause: error }),
      );
    }
  }

  /**
   * Sends events now and waits for delivery. The internal action's handler calls it; never call
   * it from a mutation or query (they cannot use the network). Never throws: a MIRA FIVE outage
   * must not fail your action. Problems are in `errors`.
   */
  async deliver(events: MiraEvent[]): Promise<DeliverResult> {
    const errors: string[] = [];
    const failedIds = new Set<string>();
    let invalid = 0;

    const mira = new Mira({
      // Actions have a time limit; fewer retries keep them short.
      maxRetries: 3,
      ...this.options,
      flushAt: 100,
      onError: (error: MiraError) => {
        errors.push(error.message);
        for (const id of error.eventIds) failedIds.add(id);
        this.options.onError?.(error);
      },
    });
    if (errors.length) return { sent: 0, failed: events.length, errors };

    for (const item of events) {
      const before = errors.length;
      const eventId =
        item.eventId ?? (item.dedupeKey ? await eventIdFor(item.dedupeKey) : undefined);
      const { method, dedupeKey: _, ...input } = item as MiraEvent & { method: unknown };
      switch (method) {
        case "track":
          mira.track({ ...(input as TrackInput), eventId });
          break;
        case "identify":
          mira.identify({ ...(input as IdentifyInput), eventId });
          break;
        case "group":
          mira.group({ ...(input as GroupInput), eventId });
          break;
        case "revenue":
          mira.revenue({ ...(input as RevenueInput), eventId });
          break;
        case "touchpoint":
          mira.touchpoint({ ...(input as TouchpointInput), eventId });
          break;
        case "dealStage":
          mira.dealStage({ ...(input as DealStageInput), eventId });
          break;
        case "dealLost":
          mira.dealLost({ ...(input as DealLostInput), eventId });
          break;
        default:
          errors.push(`MIRA FIVE: unknown method: ${String(method)}`);
      }
      if (errors.length > before) invalid += 1;
    }

    await mira.shutdown();
    const failed = invalid + failedIds.size;
    return { sent: Math.max(0, events.length - failed), failed, errors };
  }
}
