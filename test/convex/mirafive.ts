import { MiraConvex } from "../../src/index.ts"
import { internal } from "./_generated/api.ts"

type Events = { "order paid": { total: number } }

export const mira = new MiraConvex<Events>({
  key: "mf_test0000_secret",
  host: "https://collector.test",
  deliver: internal.mirafive.deliver
})

export const deliver = mira.deliverAction()
