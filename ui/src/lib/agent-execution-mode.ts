import type { Agent } from "@paperclipai/shared";

/** Registered seats (including legacy SSH seats) use the seat dispatch flow. */
export function isSeatAgent(agent: Pick<Agent, "adapterConfig">): boolean {
  const config = agent.adapterConfig;
  return config?.dsp7Transport === "outbound" ||
    (typeof config?.dsp7Seat === "object" && config.dsp7Seat !== null);
}

export function seatAgentLinks(id: string) {
  const query = `seat=${encodeURIComponent(id)}`;
  return { dispatch: `/jira-intake?${query}`, seat: `/seats?scope=all&view=work&${query}` };
}
