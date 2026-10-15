import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { claudeRelayConnection, type ClaudeRelayAuth } from "@/lib/claude-relay";
import { uiText } from "@/i18n/interface";
import { healthApi } from "@/api/health";
import { aiConnectionsApi } from "@/api/ai-connections";
import { useLocalAiLogin } from "../ai-connections/useLocalAiLogin";
import type { AiConnectionBinding, AiConnectionLoginIntent } from "@paperclipai/shared";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import {
  SavedProviderKeySelect,
  useSavedProviderKeys,
} from "../onboarding/SavedProviderKeySelect";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { AdapterLoginPanel } from "../AgentConfigForm";
import {
  LocalProviderLoginInstructions,
  OnboardingCardField,
  OnboardingLoginCard,
} from "../AdapterLoginChrome";
import { ModelSourceTiles } from "../onboarding/ModelSourceTiles";
import { CredentialModeLink } from "../onboarding/CredentialModeLink";
import { FooterNav } from "../onboarding/FooterNav";
import { MAKE_ROOM, CARD_ENTER } from "../onboarding/onboarding-motion";
import { buildFixedClaudeOAuthBinding } from "../environment-variables-editor/model";
import type { EnvBinding } from "@paperclipai/shared";

export type ProviderConnection = {
  env: Record<string, EnvBinding>;
  aiConnection?: AiConnectionBinding;
  /** Kept in memory until the user finishes setup. */
  credentials?: Record<string, string>;
  model?: string;
  relay?: boolean;
  localConfiguration?: boolean;
  extraArgs?: string[];
  command?: string;
  storedSessionId?: string;
  applyStoredClaudeLogin?: boolean;
};
export function AgentProviderConnection({
  companyId,
  adapterType,
  environmentId,
  canLogin,
  localEnvironment = false,
  allowLocalConfiguration = true,
  onConnected,
  onBack,
  testConnection,
  testError,
  managedAccount,
}: {
  companyId: string;
  adapterType: "claude_local" | "codex_local" | "grok_local";
  environmentId: string | null;
  canLogin: boolean;
  localEnvironment?: boolean;
  allowLocalConfiguration?: boolean;
  onConnected: (connection: ProviderConnection) => void;
  onBack: () => void;
  testConnection: (connection: ProviderConnection) => Promise<boolean>;
  testError?: string | null;
  /** Connections supplies its access intent; presentation and login controllers stay shared. */
  managedAccount?: {
    intent: AiConnectionLoginIntent;
    initialMethod?: "subscription" | "api_key";
    fixedMethod?: boolean;
    disabled?: boolean;
    onComplete: (result: { connectionId: string; grantId: string; method: "subscription" | "api_key" }) => void;
  };
}) {
  const health = useQuery({ queryKey: queryKeys.health, queryFn: healthApi.get, enabled: localEnvironment });
  const canUseLocalLogin = localEnvironment && (health.data?.localAiLoginSupported ?? health.data?.deploymentMode === "local_trusted");
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  const cancel = () => {
    epoch.current++;
    setBusy(false);
    setOpened(false);
    setAuthorizationUrl(null);
    setLoginPhase("preparing");
  };
  const [methodChoice, setMethod] = useState<"subscription" | "api" | null>(managedAccount?.initialMethod === "api_key" ? "api" : managedAccount ? "subscription" : null);
  const [opened, setOpened] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [loginPhase, setLoginPhase] = useState<"preparing" | "ready" | "waiting" | "connecting">("preparing");
  const phaseBeforeSubmit = useRef<"ready" | "waiting">("ready");
  const [apiKey, setApiKey] = useState("");
  const [localConfiguration, setLocalConfiguration] = useState(allowLocalConfiguration && adapterType === "claude_local" && !managedAccount);
  const [localSettingsPath, setLocalSettingsPath] = useState("");
  const [localCommand, setLocalCommand] = useState("claude");
  const [useRelay, setUseRelay] = useState(false);
  const [relayBaseUrl, setRelayBaseUrl] = useState("");
  const [relayAuth, setRelayAuth] = useState<ClaudeRelayAuth>("auth_token");
  const [relayModel, setRelayModel] = useState("");
  const relayEnabled = adapterType === "claude_local" && !managedAccount && useRelay;
  function invalidateRelay() { setStoredConnection(null); setError(null); }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storedConnection, setStoredConnection] =
    useState<ProviderConnection | null>(null);
  const provider = adapterType === "claude_local" ? "Claude" : adapterType === "grok_local" ? "Grok" : "OpenAI";
  const envKey =
    adapterType === "claude_local" ? "ANTHROPIC_API_KEY" : adapterType === "grok_local" ? "XAI_API_KEY" : "OPENAI_API_KEY";
  const aiProvider = adapterType === "claude_local" ? "anthropic" : adapterType === "grok_local" ? "xai" : "openai";
  const availableKeys = useSavedProviderKeys(companyId, envKey);
  // Add/reconnect creates the requested account, never copies a saved account's
  // credential or silently changes its ownership. Agent setup retains reuse.
  const savedKeys = managedAccount
    ? { ...availableKeys, options: [], subscriptions: [], loading: false }
    : availableKeys;
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const savedSubscription =
    savedKeys.subscriptions.length
      ? savedKeys.subscriptions.find(
          (option) =>
            option.id === (subscriptionId ?? savedKeys.subscriptions[0]?.id),
        )
      : undefined;
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const selectedKey = relayEnabled ? undefined : savedKeys.options.find(
    (option) => option.id === (selectedKeyId ?? savedKeys.options[0]?.id),
  );
  const storedLogin = managedAccount
    ? { ...savedKeys.storedLogin, data: undefined, isPending: false, isError: false }
    : savedKeys.storedLogin;
  const savedManagedAccount = useRef<{ connectionId: string; grantId: string } | null>(null);
  const method = methodChoice ?? (
    (savedKeys.subscriptions.length > 0 || (adapterType === "claude_local" && !savedSubscription && storedLogin.data))
      ? "subscription" : savedKeys.options.length ? "api" : "subscription"
  );
  const localLogin = useLocalAiLogin(companyId, managedAccount?.intent ?? {
    provider: aiProvider, method: "subscription", name: `My ${provider} subscription`,
    ownership: "personal", agentIds: [], allAgents: true,
  }, !localConfiguration && canUseLocalLogin && method === "subscription" && !savedSubscription && !storedLogin.data,
  { allowHostClaude: health.data?.deploymentMode === "local_trusted" });
  const auth = useQuery({
    queryKey: queryKeys.agents.authSignal(
      companyId,
      adapterType,
      environmentId,
    ),
    queryFn: () =>
      agentsApi.getAdapterAuthSignal(
        companyId,
        adapterType,
        environmentId ?? undefined,
      ),
    retry: false,
    enabled: !managedAccount && !localConfiguration,
  });
  async function connect() {
    if (busy || managedAccount?.disabled) return;
    const run = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      if (managedAccount) {
        if (method === "subscription" && !canUseLocalLogin) return;
        const result = savedManagedAccount.current ?? await (method === "api"
          ? aiConnectionsApi.create(companyId, { ...managedAccount.intent, method: "api_key", apiKey: apiKey.trim() })
          : localLogin.connect(managedAccount.intent));
        savedManagedAccount.current = result;
        setApiKey("");
        if (run === epoch.current) managedAccount.onComplete({ ...result, method: method === "api" ? "api_key" : "subscription" });
        return;
      }
      let connection: ProviderConnection =
        method === "api" && relayEnabled
          ? (storedConnection ?? claudeRelayConnection({ baseUrl: relayBaseUrl, auth: relayAuth, key: apiKey, model: relayModel }))
          : method === "api"
          ? selectedKey
            ? selectedKey.aiConnection ? { env: {}, aiConnection: selectedKey.aiConnection } : { env: { [envKey]: selectedKey.binding } }
            : (storedConnection ?? {
                env: {},
                credentials: { [envKey]: apiKey.trim() },
              })
          : {
              ...(savedSubscription?.aiConnection ? { aiConnection: savedSubscription.aiConnection } : {}),
              env: savedSubscription?.binding
                ? { CODEX_HOME: savedSubscription.binding }
                : {},
              ...(adapterType === "claude_local" && !savedSubscription && storedLogin.data
                ? {
                    env: buildFixedClaudeOAuthBinding(),
                    applyStoredClaudeLogin: true,
                  }
                : {}),
            };
      if (method === "subscription" && canUseLocalLogin && !savedSubscription && !storedLogin.data) {
        savedManagedAccount.current ??= await localLogin.connect();
        connection = { env: {}, aiConnection: { provider: aiProvider, method: "subscription", mode: "responsible_user" } };
      }
      if (connection.credentials && !connection.relay) {
        await aiConnectionsApi.create(companyId, { provider: aiProvider, method: "api_key", name: `My ${provider} API`, ownership: "personal", apiKey: connection.credentials[envKey], agentIds: [], allAgents: true });
        connection = { env: {}, aiConnection: { provider: aiProvider, method: "api_key", mode: "responsible_user" } };
      }
      if (run !== epoch.current) return;
      if (method === "api") {
        setApiKey("");
        if (!selectedKey) setStoredConnection(connection);
      }
      const connected = await testConnection(connection);
      if (run !== epoch.current) return;
      if (connected) onConnected(connection);
      else
        setError(
          "The provider did not respond. Check the connection and try again.",
        );
    } catch (cause) {
      if (run !== epoch.current) return;
      if (managedAccount) setApiKey("");
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not connect to the provider.",
      );
    } finally {
      if (run === epoch.current) setBusy(false);
    }
  }
  async function connectLocalConfiguration() {
    if (busy) return;
    const run = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      const path = localSettingsPath.trim();
      if (path && (!/^(\/|[A-Za-z]:[\\/])/.test(path) || !path.toLowerCase().endsWith(".json"))) {
        throw new Error("工程配置文件须为执行电脑上的绝对 JSON 文件路径。");
      }
      const command = localCommand.trim();
      if (!command || /[\r\n]/.test(command)) throw new Error("请填写 Claude 命令名或可执行文件的绝对路径，不包含命令参数。");
      const connection: ProviderConnection = { env: {}, localConfiguration: true, command, ...(path ? { extraArgs: ["--settings", path] } : {}) };
      const connected = await testConnection(connection);
      if (run !== epoch.current) return;
      if (connected) onConnected(connection);
      else setError("本机配置检查未通过，请核对执行环境、Claude 登录及配置文件路径。");
    } catch (cause) {
      if (run === epoch.current) setError(cause instanceof Error ? cause.message : "本机配置检查失败。");
    } finally { if (run === epoch.current) setBusy(false); }
  }
  const needsLogin =
    method === "subscription" &&
    canLogin &&
    environmentId &&
    !savedSubscription &&
    !savedKeys.loading &&
    !storedLogin.data &&
    (Boolean(managedAccount) || auth.data?.status !== "present" || subscriptionId === "");
  if (localConfiguration && adapterType === "claude_local" && !managedAccount) {
    return <div className="space-y-5">
      <h3 className="text-lg font-semibold">使用本机已有配置</h3>
      <p className="text-sm text-muted-foreground">沿用所选执行电脑上的 Claude 配置，无需再次填写 API 密钥。请确认执行环境是研发电脑；服务器上的配置不等于本机配置。</p>
      <label className="block space-y-2 text-sm">Claude 命令或可执行文件路径
        <Input value={localCommand} disabled={busy} placeholder="claude 或 /usr/local/bin/claude" onChange={(event) => { setLocalCommand(event.target.value); setError(null); }} />
      </label>
      <p className="text-xs text-muted-foreground">命令必须存在于上方所选执行电脑中。若 PATH 找不到 claude，可填写绝对路径；Mac 常见路径为 /usr/local/bin/claude 或用户目录下的 .local/bin/claude。</p>
      <label className="block space-y-2 text-sm">工程配置文件（可选）
        <Input value={localSettingsPath} disabled={busy} placeholder="/absolute/path/base-harness/.claude/settings.local.json" onChange={(event) => { setLocalSettingsPath(event.target.value); setError(null); }} />
      </label>
      <p className="text-xs text-muted-foreground">使用用户级 Claude 设置或登录时留空。若密钥仅在 Harness 工程配置中，填写该文件在执行电脑上的绝对路径。文件内容不会上传到网站；Claude 会读取该文件的设置，包括其中的权限规则。实际在源码 worktree 中运行也可使用这份配置。</p>
      <p className="text-xs text-muted-foreground">网站不注入 API 密钥、中转站地址或官方账号绑定。模型默认跟随本机设置，也可在下一步显式选择模型。</p>
      {error && <p role="alert" className="text-sm text-destructive">{testError ?? error}</p>}
      <div className="flex flex-wrap justify-between gap-3">
        <Button type="button" variant="outline" disabled={busy} onClick={() => { setLocalConfiguration(false); setError(null); }}>使用网站密钥或登录</Button>
        <Button type="button" disabled={busy} onClick={() => void connectLocalConfiguration()}>{busy ? "正在检查本机配置…" : "检查并使用本机配置"}</Button>
      </div>
    </div>;
  }
  return (
    <div className="min-w-0 max-w-full">
      {allowLocalConfiguration && adapterType === "claude_local" && !managedAccount && <Button type="button" variant="outline" className="mb-5" disabled={busy} onClick={() => { setLocalConfiguration(true); setApiKey(""); setStoredConnection(null); setError(null); }}>使用本机已有配置</Button>}
      <ModelSourceTiles
        label={uiText("Connect your model provider")}
        sources={[
          {
            id: adapterType,
            label: provider,
            icon: (
              <img
                src={adapterType === "grok_local" ? "/brands/adapters/grok.svg" : `/brands/${adapterType === "claude_local" ? "claude" : "codex"}-color.svg`}
                className="size-6"
                alt=""
              />
            ),
          },
        ]}
        mode={method}
        selectedId={opened ? adapterType : null}
        collapsed={opened}
        onSelect={() => { if (!managedAccount?.disabled) setOpened(true); }}
      />
      {!opened && !managedAccount?.fixedMethod && (
        <div className="-ml-3 mt-1">
          <CredentialModeLink
            mode={method}
            onChange={(next) => {
              savedManagedAccount.current = null;
              setMethod(next);
              setError(null);
            }}
          />
        </div>
      )}
      {!opened && savedKeys.options.length > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          {savedKeys.options.length}{" "}{uiText("saved API")}{" "}
          {savedKeys.options.length === 1 ? uiText("key available") : uiText("keys available")}.
        </p>
      )}
      {method === "subscription" &&
        savedKeys.subscriptions.length > 0 && (
          <SavedProviderKeySelect
            options={savedKeys.subscriptions}
            value={savedSubscription?.id ?? ""}
            onChange={setSubscriptionId}
            loading={false}
            error={false}
            kind="subscription"
            disabled={busy}
          />
        )}
      <motion.div
        initial={false}
        animate={{ height: opened ? "auto" : 0, opacity: opened ? 1 : 0 }}
        transition={{ height: MAKE_ROOM, opacity: CARD_ENTER }}
        className="overflow-hidden"
      >
        {opened && (
          <div className="pt-5">
            {method === "api" ? (
              <OnboardingLoginCard
                instruction={
                  savedKeys.options.length
                    ? "Choose a saved API key or enter a new one"
                    : `Provide your ${provider} API key to connect`
                }
              >
                {adapterType === "claude_local" && !managedAccount && (
                  <div className="space-y-4">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={useRelay} disabled={busy} onChange={(event) => { setUseRelay(event.target.checked); setApiKey(""); setSelectedKeyId(""); invalidateRelay(); }} />
                      使用第三方中转站
                    </label>
                    {relayEnabled && <div className="space-y-3">
                      <label className="block space-y-1 text-sm">中转站地址
                        <Input type="url" value={relayBaseUrl} disabled={busy} placeholder="https://relay.example.com" onChange={(event) => { setRelayBaseUrl(event.target.value); invalidateRelay(); }} />
                      </label>
                      <label className="block space-y-1 text-sm">认证方式
                        <select value={relayAuth} disabled={busy} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" onChange={(event) => { setRelayAuth(event.target.value as ClaudeRelayAuth); invalidateRelay(); }}>
                          <option value="auth_token">{uiText("Bearer Token（ANTHROPIC_AUTH_TOKEN）")}</option>
                          <option value="api_key">{uiText("API Key / x-api-key（ANTHROPIC_API_KEY）")}</option>
                        </select>
                      </label>
                      <label className="block space-y-1 text-sm">模型名称（可选）
                        <Input value={relayModel} disabled={busy} placeholder="填写中转站支持的模型标识" onChange={(event) => { setRelayModel(event.target.value); invalidateRelay(); }} />
                      </label>
                      <p className="text-xs text-muted-foreground">支持兼容 Anthropic Messages API 的中转站。地址和认证方式按站点说明填写，系统不会自动追加 /v1；仅提供 OpenAI 接口的站点不能直接用于 Claude。密钥通过秘密存储保存，不写入浏览器草稿。</p>
                    </div>}
                  </div>
                )}
                {!relayEnabled && <SavedProviderKeySelect
                  {...savedKeys}
                  value={selectedKey?.id ?? ""}
                  disabled={busy}
                  onChange={(id) => {
                    setSelectedKeyId(id);
                    setApiKey("");
                    setStoredConnection(null);
                    setError(null);
                  }}
                />}
                {!selectedKey && (
                  <OnboardingCardField
                    label={relayEnabled ? "中转站密钥" : uiText("API key")}
                    masked
                    autoFocus
                    value={apiKey}
                    placeholder={
                      storedConnection
                        ? uiText("Key entered. Retry the connection.")
                        : uiText("Enter API key here")
                    }
                    onChange={(value) => {
                      setSelectedKeyId("");
                      setApiKey(value);
                      setStoredConnection(null);
                    }}
                    onSubmit={() => void connect()}
                    disabled={busy}
                  />
                )}
              </OnboardingLoginCard>
            ) : needsLogin ? (
              <AdapterLoginPanel
                companyId={companyId}
                adapterType={adapterType}
                environmentId={environmentId}
                chrome="onboarding"
                aiConnection={managedAccount?.intent ?? { provider: aiProvider, method: "subscription", name: `My ${provider} subscription`, ownership: "personal", agentIds: [], allAgents: true }}
                autoStart
                onStored={() => {}}
                onPromptReady={(url) => {
                  setAuthorizationUrl(url);
                  setLoginPhase((phase) => url ? (phase === "preparing" ? "ready" : phase) : "preparing");
                }}
                onCodeSubmitted={() => {
                  phaseBeforeSubmit.current = loginPhase === "waiting" ? "waiting" : "ready";
                  setLoginPhase("connecting");
                }}
                onSubmitFailed={() => {
                  setLoginPhase((phase) => phase === "connecting" ? phaseBeforeSubmit.current : phase);
                }}
                onConnected={(sessionId) => {
                  if (managedAccount) {
                    if (!sessionId) { setError("The login did not return a saved connection. Try again."); return; }
                    const run = epoch.current;
                    setLoginPhase("connecting");
                    void aiConnectionsApi.loginResult(companyId, sessionId).then((result) => {
                      if (run === epoch.current) managedAccount.onComplete({ ...result, method: "subscription" });
                    }).catch(() => {
                      if (run !== epoch.current) return;
                      setLoginPhase("ready");
                      setError("Could not retrieve the saved connection. Go back and retry.");
                    });
                    return;
                  }
                  const connection: ProviderConnection = { env: {}, aiConnection: { provider: aiProvider, method: "subscription", mode: "responsible_user" } };
                  setStoredConnection(connection);
                  onConnected(connection);
                }}
              />
            ) : savedSubscription ? null : canUseLocalLogin && !storedLogin.data ? (
              <LocalProviderLoginInstructions adapterType={adapterType} login={{ ...localLogin, retry: () => { setError(null); localLogin.retry(); } }} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {storedLogin.data
                  ? uiText("Use your saved Claude subscription for this agent.")
                  : canLogin
                    ? uiText("Use the existing provider connection for this environment.")
                    : uiText("This environment does not support browser sign-in. Choose a sign-in environment or connect with an API key.")}
              </p>
            )}
          </div>
        )}
      </motion.div>
      {method === "subscription" && storedLogin.isError && (
        <p role="alert" className="mt-4 text-sm text-destructive">{uiText("Could not check your saved Claude subscription. Try again.")}{" "}</p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {testError ?? error}
        </p>
      )}
      {localEnvironment && health.isError && (
        <p role="alert" className="mt-4 text-sm text-destructive">{uiText("Could not prepare sign-in. Reload this page to try again.")}</p>
      )}
      <FooterNav
        onBack={() => {
          if (opened) cancel();
          else onBack();
        }}
        primaryLabel={
          opened && needsLogin
            ? loginPhase === "waiting" ? "Waiting for code"
              : loginPhase === "connecting" ? "Connecting"
              : `Sign in to ${provider}`
            : busy
            ? "Connecting"
            : method === "subscription" &&
                (storedLogin.data || savedSubscription)
              ? "Use saved subscription"
              : method === "api" && selectedKey
                ? "Use saved API key"
                : "Connect"
        }
        primaryDisabled={
          managedAccount?.disabled ||
          (Boolean(managedAccount) && method === "subscription" && !canLogin && !canUseLocalLogin) ||
          (localEnvironment && health.isPending) || localLogin.preparing || Boolean(localLogin.error) ||
          (!managedAccount && auth.isPending) ||
          savedKeys.loading ||
          (adapterType === "claude_local" && storedLogin.isPending) ||
          !opened ||
          (Boolean(needsLogin) && (!authorizationUrl || loginPhase !== "ready")) ||
          (method === "api" &&
            !apiKey.trim() &&
            !storedConnection &&
            !selectedKey)
        }
        loading={busy}
        primaryIcon={opened && needsLogin ? loginPhase === "ready" ? "none" : "spinner" : undefined}
        onPrimary={() => {
          if (needsLogin) {
            if (!authorizationUrl || loginPhase !== "ready") return;
            window.open(authorizationUrl, "_blank", "noreferrer,noopener");
            setLoginPhase("waiting");
          } else void connect();
        }}
      />
    </div>
  );
}
