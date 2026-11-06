import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { isSeatAgent } from "@/lib/agent-execution-mode";

/** Restricted agent responses omit adapterConfig; absence is not a server identity. */
export function useSeatAgentIdentity(agent?: Pick<Agent, "id" | "companyId" | "adapterConfig">) {
  const registered = Boolean(agent && isSeatAgent(agent));
  const needsRegistry = Boolean(agent && !registered && Object.keys(agent.adapterConfig ?? {}).length === 0);
  const registry = useQuery({
    queryKey: ["dsp7-registered-seats", agent?.companyId],
    queryFn: () => dsp7SeatsApi.list(agent!.companyId),
    enabled: needsRegistry,
    staleTime: 30_000,
    retry: false,
  });
  return {
    isSeat: registered || Boolean(needsRegistry && registry.data?.some(seat => seat.agentId === agent?.id)),
    pending: needsRegistry && registry.isPending,
    failed: needsRegistry && registry.isError,
    retry: registry.refetch,
  };
}
