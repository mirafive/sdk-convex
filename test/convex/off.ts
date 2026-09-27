import { MiraConvex } from "../../src/index.ts"
import { internal } from "./_generated/api.ts"

export const disabled = new MiraConvex({
  key: "mf_test0000_secret",
  disabled: true,
  deliver: internal.off.deliver
})
export const keyless = new MiraConvex({ key: process.env["MIRAFIVE_UNSET"], deliver: internal.off.deliver })
export const deliver = disabled.deliverAction()
