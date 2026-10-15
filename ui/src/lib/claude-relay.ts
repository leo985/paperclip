import type { EnvBinding } from "@paperclipai/shared";
export type ClaudeRelayAuth = "api_key" | "auth_token";
/** Credentials stay in memory until persisted through the secret store. */
export function claudeRelayConnection(input: { baseUrl: string; auth: ClaudeRelayAuth; key: string; model: string }) {
  let url: URL;
  try { url = new URL(input.baseUrl.trim()); }
  catch { throw new Error("请填写有效的中转站地址，例如 https://relay.example.com。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("中转站地址须使用 HTTP 或 HTTPS，不能包含账号、密码、查询参数或片段。");
  const key = input.key.trim();
  if (!key) throw new Error("请填写中转站密钥。");
  const envKey = input.auth === "auth_token" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
  const otherKey = input.auth === "auth_token" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN";
  const env: Record<string, EnvBinding> = {
    ANTHROPIC_BASE_URL: { type: "plain", value: url.toString().replace(/\/$/, "") },
    [otherKey]: { type: "plain", value: "" },
    CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "" },
    CLAUDE_CODE_USE_BEDROCK: { type: "plain", value: "0" },
    CLAUDE_CODE_USE_VERTEX: { type: "plain", value: "0" },
    CLAUDE_CODE_USE_FOUNDRY: { type: "plain", value: "0" },
  };
  return { env, credentials: { [envKey]: key }, model: input.model.trim() || undefined, relay: true as const };
}
