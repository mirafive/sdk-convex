import { MiraConvex } from "../../src/index.ts"
import { internal } from "./_generated/api.js"

type Events = { "order paid": { total: number } }

export const mira: MiraConvex<Events> = new MiraConvex<Events>({
  key: "mf_test0000_secret",
  host: "https://collector.test",
  deliver: internal.mirafive.deliver
})

export const deliver = mira.deliverAction()

// Untyped events on the same delivery action, for payloads the typed client would refuse.
export const plain: MiraConvex = new MiraConvex({
  key: "mf_test0000_secret",
  host: "https://collector.test",
  deliver: internal.mirafive.deliver
})
