import { Mira, MiraError } from "@mirafive/sdk-server"
import type { Events, Mode, Page, SendEvent } from "@mirafive/sdk-server"
import {
  defineTable,
  getFunctionName,
  internalActionGeneric,
  internalMutationGeneric,
  makeFunctionReference
} from "convex/server"
import type { FunctionReference, RegisteredAction, RegisteredMutation, Scheduler } from "convex/server"
import { v } from "convex/values"
import type { GenericId } from "convex/values"

export { MiraError } from "@mirafive/sdk-server"
export type { Events, Mode, Page, Receipt } from "@mirafive/sdk-server"

export interface TrackOptions<P = Record<string, unknown> | undefined> {
  /** Your own pseudonymous id for the person. Never an email address. */
  readonly userId?: string | undefined
  readonly anonymousId?: string | undefined
  readonly sessionId?: string | undefined
  readonly properties?: P
  /** When it happened. Defaults to the start of the calling function. */
  readonly time?: Date | number | string | undefined
  readonly page?: Page | undefined
  /** Names the batch: the same key is stored once (PROTOCOL §5). Ignored when the event goes to the outbox. */
  readonly idempotencyKey?: string | undefined
}

export type TrackEvent<E extends Events = Events> = {
  [K in keyof E & string]: Omit<TrackOptions<E[K]>, "idempotencyKey"> & { readonly name: K }
}[keyof E & string]

/** An event as the action parses it back: `time` in epoch ms. */
export type QueuedEvent = SendEvent

/** `events` is a JSON array: Convex refuses some property keys (`$…`, non-ASCII) that JSON carries. */
export type DeliverArgs = { events: string; idempotencyKey: string; sentAt?: number }

export type DeliverReference = FunctionReference<"action", "internal", DeliverArgs>

/** A mutation or action context, typed by any schema. Queries cannot schedule. */
export interface SchedulingCtx {
  readonly scheduler: Scheduler
}

interface Inserter {
  insert(table: string, document: { event: string }): Promise<unknown>
}

/** Queues one delivery. Default: `ctx.scheduler.runAfter(0, deliver, args)`; pass a workpool's `enqueueAction` for retries. */
export type Enqueue = (ctx: SchedulingCtx, deliver: DeliverReference, args: DeliverArgs) => Promise<unknown>

export interface MiraConvexOptions {
  /** The source's secret key, `process.env.MIRAFIVE_SECRET_KEY`. Missing: events are dropped with a warning. */
  readonly key?: string | undefined
  readonly host?: string | undefined
  /** `"full"` (default): you hold consent. `"consentless"`: no identifiers at all. */
  readonly mode?: Mode | undefined
  /** The exported `deliverAction()`, e.g. `internal.mirafive.deliver`. */
  readonly deliver: DeliverReference
  /** Mutations write to the `miraOutbox` table instead of scheduling; `flushOutbox()` sends it in batches. */
  readonly outbox?: boolean | undefined
  readonly enqueue?: Enqueue | undefined
  /** Drops every event, e.g. on preview deployments. */
  readonly disabled?: boolean | undefined
}

const TABLE = "miraOutbox"
const MAX_EVENTS = 1000
const MAX_BYTES = 1_000_000

/** The outbox table for your `convex/schema.ts`: `miraOutbox: miraOutboxTable`. */
export const miraOutboxTable = defineTable({ event: v.string() })

/** `event` is the event as JSON. */
export type OutboxRow = { _id: GenericId<typeof TABLE>; _creationTime: number; event: string }

export type OutboxRowsArgs = { before: number; drop?: GenericId<typeof TABLE>[] }

export interface OutboxFunctions {
  readonly outboxRows: RegisteredMutation<"internal", OutboxRowsArgs, Promise<OutboxRow[]>>
  readonly flushOutbox: RegisteredAction<"internal", Record<string, never>, Promise<void>>
}

const encoder = new TextEncoder()
const HALVE = new Set<string>(["validation_failed", "invalid_event", "payload_too_large"])
const QUIET = new Set([undefined, "install_check", "bot"])

// Only a refusal of the events themselves is halved; anything else (key, mode, outage) keeps the rows.
const refused = (error: unknown): error is Error =>
  error instanceof TypeError || (error instanceof MiraError && HALVE.has(error.code))

const warn = (message: string): void => {
  // oxlint-disable-next-line no-console -- Convex logs are the only channel
  console.warn(`[mirafive] ${message}`)
}

/** Records events from Convex. Mutations never send: they schedule or write to the outbox, so a rollback sends nothing. */
export class MiraConvex<E extends Events = Events> {
  readonly #options: MiraConvexOptions
  #mira: Mira | undefined
  #warned = false

  constructor(options: MiraConvexOptions) {
    this.#options = options
  }

  /** Queues one event. Never throws for transport reasons; identifiers in consentless mode throw a `TypeError`. */
  track<K extends keyof E & string>(
    ctx: SchedulingCtx,
    name: K,
    options: TrackOptions<E[K]> = {}
  ): Promise<void> {
    const { idempotencyKey, ...event } = options

    return this.#queue(ctx, [{ ...event, name }], idempotencyKey)
  }

  /** Queues `$identify`: links the anonymous id, when given, to the user and records their traits. */
  identify(
    ctx: SchedulingCtx,
    userId: string,
    traits?: Record<string, unknown>,
    options: { readonly anonymousId?: string | undefined } = {}
  ): Promise<void> {
    return this.#queue(ctx, [
      { name: "$identify", userId, anonymousId: options.anonymousId, properties: traits }
    ])
  }

  /** Queues up to 1000 events as one delivery: one action run, one batch. */
  trackMany(
    ctx: SchedulingCtx,
    events: readonly TrackEvent<E>[],
    options: { readonly idempotencyKey?: string | undefined } = {}
  ): Promise<void> {
    return this.#queue(ctx, events, options.idempotencyKey)
  }

  /** The internal action that sends one queued delivery. Export it under the name `deliver` points at. */
  deliverAction(): RegisteredAction<"internal", DeliverArgs, Promise<null>> {
    return internalActionGeneric({
      args: { events: v.string(), idempotencyKey: v.string(), sentAt: v.optional(v.number()) },
      handler: (_ctx, args: DeliverArgs) =>
        this.#send(JSON.parse(args.events), args.idempotencyKey, args.sentAt ?? Date.now())
    })
  }

  /**
   * The outbox drain. Export both from the module that exports `deliver`:
   * `export const { flushOutbox, outboxRows } = mira.flushOutbox()`, then run `flushOutbox` from a cron.
   */
  flushOutbox(): OutboxFunctions {
    const rows = makeFunctionReference<"mutation", OutboxRowsArgs, OutboxRow[]>(
      `${getFunctionName(this.#options.deliver).split(":")[0] ?? ""}:outboxRows`
    )

    return {
      outboxRows: internalMutationGeneric({
        args: { before: v.number(), drop: v.optional(v.array(v.id(TABLE))) },
        handler: async (ctx, { before, drop }) => {
          const taken: OutboxRow[] = []

          if (drop) {
            for (const id of drop) {
              // oxlint-disable-next-line no-await-in-loop -- a row may already be gone (a repeated drop)
              if (await ctx.db.get(id)) {
                // oxlint-disable-next-line no-await-in-loop
                await ctx.db.delete(id)
              }
            }

            return taken
          }

          let size = 0

          // The cutoff keeps rows inserted during a flush outside this read.
          for await (const row of ctx.db
            .query(TABLE)
            .withIndex("by_creation_time", (q) => q.lt("_creationTime", before))) {
            size += encoder.encode(row.event).length + 1

            if (taken.length === MAX_EVENTS || (taken.length > 0 && size > MAX_BYTES)) {
              break
            }

            taken.push(row)
          }

          return taken
        }
      }),
      // Crons are single-flight, so reading, sending and then deleting needs no lock.
      flushOutbox: internalActionGeneric({
        args: {},
        handler: async (ctx) => {
          const before = Date.now()

          while (!this.#options.disabled) {
            // oxlint-disable-next-line no-await-in-loop -- one batch at a time, in order
            const taken = await ctx.runMutation(rows, { before })

            if (taken.length === 0) {
              return
            }

            const ids = taken.map((row) => row._id)

            // Key and sentAt come from the rows, so a batch sent but not yet dropped is resent identically.
            // oxlint-disable-next-line no-await-in-loop
            await this.#send(
              taken.map((row): QueuedEvent => JSON.parse(row.event)),
              ids.join(),
              Math.floor(taken.at(-1)?._creationTime ?? before)
            )
            // oxlint-disable-next-line no-await-in-loop
            await ctx.runMutation(rows, { before, drop: ids })
          }
        }
      })
    }
  }

  async #queue(
    ctx: SchedulingCtx,
    events: readonly (TrackOptions & { readonly name: string })[],
    idempotencyKey?: string
  ): Promise<void> {
    const { key, mode, outbox, deliver, enqueue, disabled } = this.#options

    if (events.length === 0 || events.length > MAX_EVENTS) {
      throw new TypeError(`trackMany() takes 1–${MAX_EVENTS} events, got ${events.length}`)
    }

    if (idempotencyKey === "") {
      throw new TypeError("idempotencyKey must not be empty")
    }

    if (
      mode === "consentless" &&
      events.some((e) => (e.userId ?? e.anonymousId ?? e.sessionId) !== undefined)
    ) {
      throw new TypeError(
        'consentless mode sends no userId, anonymousId or sessionId; use mode "full" when you hold consent'
      )
    }

    const now = Date.now()
    const times = events.map(({ time }) => new Date(time ?? now).getTime())

    if (times.some(Number.isNaN)) {
      throw new TypeError("time must be a Date, epoch ms or a parseable date string")
    }

    if (disabled) {
      return
    }

    if (!key?.trim()) {
      if (!this.#warned) {
        this.#warned = true
        warn("no key: run `npx convex env set MIRAFIVE_SECRET_KEY …`; events are dropped")
      }

      return
    }

    // Analytics must never roll back the caller's transaction: an event JSON cannot carry is dropped.
    const queued = events.flatMap((event, index) => {
      try {
        return [JSON.stringify({ ...event, time: times[index] })]
      } catch (error) {
        warn(`dropped ${event.name}: ${String(error)}`)

        return []
      }
    })

    if (queued.length === 0) {
      return
    }

    // An action has no `db`; it schedules like any other call.
    const db: Inserter | undefined = outbox ? Reflect.get(ctx, "db") : undefined

    if (db) {
      await Promise.all(queued.map((event) => db.insert(TABLE, { event })))
    } else {
      const args = {
        events: `[${queued.join()}]`,
        idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
        sentAt: now
      }

      await (enqueue ? enqueue(ctx, deliver, args) : ctx.scheduler.runAfter(0, deliver, args))
    }
  }

  async #send(events: QueuedEvent[], idempotencyKey: string, sentAt: number): Promise<null> {
    const { key, host, mode } = this.#options

    this.#mira ??= new Mira({ key, host: host || undefined, mode })

    try {
      const { dropped, reason } = await this.#mira.send(events, { idempotencyKey, sentAt })

      if (dropped > 0 && !QUIET.has(reason)) {
        warn(`the server dropped ${dropped} events: ${reason}`)
      }
    } catch (error) {
      if (!refused(error)) {
        throw error
      }

      if (events.length === 1) {
        warn(`dropped an event the server refuses: ${error.message}`)
      } else {
        const half = events.length >> 1

        await this.#send(events.slice(0, half), `${idempotencyKey}/0`, sentAt)
        await this.#send(events.slice(half), `${idempotencyKey}/1`, sentAt)
      }
    }

    return null
  }
}
