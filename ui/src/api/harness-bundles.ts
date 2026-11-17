import { api } from "./client";
import type { HarnessBundleRegistryResponse } from "@paperclipai/shared";

/** Metadata discovery, not a routing or activation API. */
export const harnessBundlesApi = {
  list: (companyId:string,seatId:string) => api.get<HarnessBundleRegistryResponse>(
    `/companies/${companyId}/dsp7-seats/${seatId}/harness-bundles`),
};
