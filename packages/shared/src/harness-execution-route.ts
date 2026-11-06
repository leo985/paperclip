import type { HarnessCapabilityInput } from "./harness-capabilities.js";
/** Server-selected machine binding; not a task or business execution grant. */
export interface HarnessExecutionRoute {
  protocolVersion: 1;
  runId: string;
  taskId: string;
  agentId: string;
  companyId: string;
  machineId: string;
  registryRevision: number;
  capabilityId: string;
  capability: HarnessCapabilityInput;
}
