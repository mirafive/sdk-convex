import { anyApi } from "convex/server"

// Stands in for `npx convex codegen`; convex-test finds the functions root by this directory.
// oxlint-disable-next-line typescript/no-explicit-any -- codegen types these per deployment
export const api: any = anyApi
// oxlint-disable-next-line typescript/no-explicit-any
export const internal: any = anyApi
