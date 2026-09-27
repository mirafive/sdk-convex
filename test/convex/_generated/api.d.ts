// As `npx convex codegen` writes it, so the modules' types are as circular as in a real app.
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server"

import type * as app from "../app.js"
import type * as mirafive from "../mirafive.js"
import type * as off from "../off.js"
import type * as outbox from "../outbox.js"

declare const fullApi: ApiFromModules<{
  app: typeof app
  mirafive: typeof mirafive
  off: typeof off
  outbox: typeof outbox
}>

export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>

export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>
