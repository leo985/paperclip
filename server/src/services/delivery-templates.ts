import { and, desc, eq, inArray } from "drizzle-orm";
import {
  companyMemberships,
  deliveryWorkflowTemplates,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  BUILTIN_DELIVERY_TEMPLATE,
  deliveryTemplateDefinitionSchema,
  type DeliveryTemplateSnapshot,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
type Row = typeof deliveryWorkflowTemplates.$inferSelect;
export const publicDeliveryTemplate = (row: Row): DeliveryTemplateSnapshot => ({
  id: row.id,
  revision: row.revision,
  scope: row.projectId ? "project" : "organization",
  definition: deliveryTemplateDefinitionSchema.parse(row.definition),
});
export async function deliveryTemplateSettings(
  db: Db,
  companyId: string,
  projectId?: string,
) {
  if (projectId) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.companyId, companyId), eq(projects.id, projectId)),
      );
    if (!project) throw notFound("项目不存在或不属于当前组织");
  }
  const rows = await db
    .select()
    .from(deliveryWorkflowTemplates)
    .where(
      and(
        eq(deliveryWorkflowTemplates.companyId, companyId),
        inArray(
          deliveryWorkflowTemplates.scopeKey,
          projectId ? ["organization", projectId] : ["organization"],
        ),
      ),
    )
    .orderBy(desc(deliveryWorkflowTemplates.revision));
  const own = rows.find(
    (row) => row.scopeKey === (projectId ?? "organization"),
  );
  const effective =
    (projectId && own?.definition.inheritOrganization ? undefined : own) ??
    rows.find((row) => row.scopeKey === "organization");
  return {
    effective: effective
      ? publicDeliveryTemplate(effective)
      : structuredClone(BUILTIN_DELIVERY_TEMPLATE),
    own: own ? publicDeliveryTemplate(own) : null,
    history: rows
      .filter((row) => row.scopeKey === (projectId ?? "organization"))
      .map(publicDeliveryTemplate),
  };
}
export async function assertTemplateReviewer(
  db: Db,
  companyId: string,
  userId: string,
) {
  if (
    userId === "local-board" &&
    process.env.PAPERCLIP_DEPLOYMENT_MODE === "local_trusted"
  )
    return;
  const [member] = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ),
    );
  if (!member)
    throw conflict("模板指定的审核人已不属于本组织或已停用，请修改流程配置");
}
