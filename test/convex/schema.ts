import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

import { miraOutboxTable } from "../../src/index.ts"

export default defineSchema({
  orders: defineTable({ total: v.number() }),
  miraOutbox: miraOutboxTable
})
