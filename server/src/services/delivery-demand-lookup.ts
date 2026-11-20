import type { DeliveryDemandLookup } from "@paperclipai/shared";
import { qingzhouClient } from "./qingzhou-client.js";

export async function readDeliveryDemand(input: {
  demandNo: string;
  credentials: () => Promise<{ username: string; password: string }>;
}, fetcher: typeof fetch = fetch): Promise<Omit<DeliveryDemandLookup, "snapshotId" | "savedEntries">> {
  const result = await qingzhouClient({ credentials: input.credentials, fetch: fetcher }).demand(input.demandNo);
  const row = result.data.rows.find((item: Record<string, unknown>) => item.demandNo === input.demandNo)!;
  const text = (value: unknown) => typeof value === "string" ? value.slice(0, 500) : "";
  return {
    demandNo: input.demandNo, title: text(row.theme), sourceStatus: text(row.demandState_show),
    owner: text(row.splitter_show), analysisOwner: text(row.requirementer_show), collectedAt: new Date().toISOString(),
  };
}
