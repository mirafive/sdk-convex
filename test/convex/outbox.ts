import { MiraConvex } from "../../src/index.ts"
import { internal } from "./_generated/api.js"

export const mira: MiraConvex = new MiraConvex({
  key: "mf_test0000_secret",
  host: "https://collector.test",
  outbox: true,
  deliver: internal.outbox.deliver
})

export const deliver = mira.deliverAction()
export const { flushOutbox, outboxRows } = mira.flushOutbox()
