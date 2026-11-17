import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {alias: [
    {find:/^@paperclipai\/shared$/, replacement:fileURLToPath(new URL('./packages/shared/src/index.ts',import.meta.url))},
    {find:/^@paperclipai\/db$/, replacement:fileURLToPath(new URL('./packages/db/src/index.ts',import.meta.url))},
    {find:/^@paperclipai\/db\/(.+)$/, replacement:fileURLToPath(new URL('./packages/db/src/',import.meta.url))+'$1.ts'},
  ]},
  test: {include:["server/src/services/dsp7-outbound-settlement.test.ts","server/src/services/harness-validation-outbound.test.ts","server/src/services/harness-validation.test.ts","server/src/routes/harness-observer-dispatch.test.ts",'server/src/services/seat-execution-permits.test.ts','server/src/services/harness-observer-binding.test.ts','server/src/__tests__/harness-v2-rollout.test.ts','server/src/__tests__/harness-observation-routes.test.ts','server/src/routes/harness-bundles.test.ts','server/src/routes/harness-capabilities.test.ts'],environment:'node',
    setupFiles:['./server/src/__tests__/setup-supertest.ts'],testTimeout:30000,maxWorkers:1},
});
