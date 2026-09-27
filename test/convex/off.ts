import { MiraConvex } from "../../src/index.ts"
import { internal } from "./_generated/api.js"

export const disabled: MiraConvex = new MiraConvex({
  key: "mf_test0000_secret",
  disabled: true,
  deliver: internal.off.deliver
})
export const keyless: MiraConvex = new MiraConvex({
  key: process.env["MIRAFIVE_UNSET"],
  deliver: internal.off.deliver
})
export const deliver = disabled.deliverAction()

export const bare: MiraConvex = new MiraConvex({
  key: "mf_test0000_secret",
  host: "",
  deliver: internal.off.deliverBare
})
export const deliverBare = bare.deliverAction()
