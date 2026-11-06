import { api } from "./client";
import type {
  DeliveryTemplateDefinition,
  DeliveryTemplateSettings,
  DeliveryTemplateSnapshot,
} from "@paperclipai/shared";
const base = (c: string) => `/companies/${c}/delivery-templates`;
export const deliveryTemplatesApi = {
  get: (c: string, projectId?: string) =>
    api.get<DeliveryTemplateSettings>(
      base(c) +
        (projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""),
    ),
  publish: (
    c: string,
    definition: DeliveryTemplateDefinition,
    expectedRevision: number,
    projectId?: string,
  ) =>
    api.post<DeliveryTemplateSnapshot>(base(c), {
      definition,
      expectedRevision,
      projectId,
    }),
};
