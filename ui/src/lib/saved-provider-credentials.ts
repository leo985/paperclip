import { uiTextFormat } from "@/i18n/interface";
import type { AiConnectionBinding, AiManagedConnectionSummary, AiProvider, CompanySecret, EnvBinding } from "@paperclipai/shared";
import type { MyUserSecretEntry } from "../api/secrets";

export type SavedProviderKey = { id: string; label: string } & (
  | { binding: EnvBinding; aiConnection?: never }
  | { binding?: never; aiConnection: AiConnectionBinding }
);

export function savedManagedProviderAccounts(
  companyId: string, provider: AiProvider, currentUserId: string,
  connections: AiManagedConnectionSummary[],
): SavedProviderKey[] {
  return connections.flatMap<SavedProviderKey>((account) => {
    if (account.companyId !== companyId || account.provider !== provider || account.status !== "connected") return [];
    if (account.ownership === "personal" && account.ownerUserId === currentUserId && account.isDefault) {
      return [{ id: `ai:${account.grantId}`, label: uiTextFormat("__PCVAR0__ (Your default)", [account.name]), aiConnection: { provider, method: account.method, mode: "responsible_user" as const } }];
    }
    if (account.ownership === "shared") {
      return [{ id: `ai:${account.grantId}`, label: uiTextFormat("__PCVAR0__ (Company shared)", [account.name]), aiConnection: { provider, method: account.method, mode: "shared" as const, connectionId: account.id, grantId: account.grantId } }];
    }
    return [];
  });
}

/** Match the canonical onboarding key and distinct keys created by agent setup. */
export function savedProviderKeys(
  companyId: string,
  envKey: string,
  personal: MyUserSecretEntry[],
  organization: CompanySecret[],
): SavedProviderKey[] {
  const matches = (key: string | null) =>
    key?.toUpperCase() === envKey ||
    key?.toUpperCase().startsWith(`${envKey}.SETUP.`);
  return [
    ...personal.flatMap(({ definition, secret }) =>
      definition.companyId === companyId &&
      definition.status === "active" &&
      secret?.companyId === companyId &&
      secret.status === "active" &&
      matches(definition.key)
        ? [
            {
              id: `user:${definition.id}`,
              label: uiTextFormat("__PCVAR0__ (Your key)", [definition.name]),
              binding: {
                type: "user_secret_ref" as const,
                key: definition.key,
                version: "latest" as const,
              },
            },
          ]
        : [],
    ),
    ...organization.flatMap((secret) =>
      secret.companyId === companyId &&
      secret.scope === "company" &&
      secret.status === "active" &&
      matches(secret.key)
        ? [
            {
              id: `company:${secret.id}`,
              label: uiTextFormat("__PCVAR0__ (Organization key)", [secret.name]),
              binding: {
                type: "secret_ref" as const,
                secretId: secret.id,
                version: "latest" as const,
              },
            },
          ]
        : [],
    ),
  ];
}

/** Codex device login creates one reusable company secret per account home. */
export function savedCodexSubscriptions(
  companyId: string,
  organization: CompanySecret[],
): SavedProviderKey[] {
  return organization
    .filter(
      (secret) =>
        secret.companyId === companyId &&
        secret.scope === "company" &&
        secret.status === "active" &&
        secret.name.startsWith("CODEX_HOME_"),
    )
    .map((secret) => ({
      id: `company:${secret.id}`,
      label: secret.name.replace("CODEX_HOME_", "ChatGPT account · "),
      binding: { type: "secret_ref", secretId: secret.id, version: "latest" },
    }));
}
