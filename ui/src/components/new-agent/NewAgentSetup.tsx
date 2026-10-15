import { RegisteredSeatConnection } from "./RegisteredSeatConnection";
import { uiTextFormat,  uiText } from "@/i18n/interface";
import { AgentCharacter } from "../AgentCharacter";
import { useAgentAppearanceDraft } from "../../hooks/useAgentAppearanceDraft";
import { AiConnectionField, aiProviderForAdapter } from "../ai-connections/AiConnectionField";
import type { AiConnectionBinding } from "@paperclipai/shared";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import {
  SETUP_CREDENTIAL_KEYS,
  SETUP_LOGIN_HINTS,
  setupEfforts,
  setupProviderKeys,
} from "@/lib/agent-setup-fields";
import { testAgentSetup } from "@/lib/test-agent-setup";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { isNewAgentAdapterAllowed } from "@/lib/new-agent-adapters";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Settings2 } from "lucide-react";
import type {
  AdapterEnvironmentTestResult,
  Agent,
  EnvBinding,
} from "@paperclipai/shared";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import { useNavigate, useSearchParams } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { adaptersApi } from "@/api/adapters";
import { environmentsApi } from "@/api/environments";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { secretsApi } from "@/api/secrets";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { queryKeys } from "@/lib/queryKeys";
import { cn, agentUrl } from "@/lib/utils";
import { getUIAdapter } from "@/adapters";
import { getAdapterDisplay } from "@/adapters/adapter-display-registry";
import {
  resolveAdapterTestEnvironmentId,
  resolveLocalDefaultEnvironmentId,
  resolveManagedSandboxEnvironmentId,
} from "@/lib/adapter-test-environment";
import { resolveForcedKubernetesEnvironment } from "@/lib/forced-kubernetes-environment";
import { environmentDisplayLabel } from "@/lib/managed-sandbox-environment";
import { buildNewAgentRuntimeConfig } from "@/lib/new-agent-runtime-config";
import {
  PROVIDER_ENV_KEYS,
  storeProviderApiKey,
  storeOrganizationApiKey,
} from "@/lib/provider-credential";
import { defaultCreateValues } from "../agent-config-defaults";
import { ModelDropdown } from "../AgentConfigForm";
import { Field } from "../agent-config-primitives";
import { SecretPicker } from "../environment-variables-editor/SecretPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  OnboardingCard,
  OnboardingHeading,
} from "../onboarding/OnboardingPrimitives";
import { stepMotion } from "../onboarding/onboarding-motion";
import { RuntimeTestCard, type TestState } from "../RuntimeTestCard";
import { AgentBasicsDialog, AdapterMark } from "./AgentBasicsDialog";
import {
  AgentProviderConnection,
  type ProviderConnection,
} from "./AgentProviderConnection";

const controlClass =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring";
const blocking = (result: AdapterEnvironmentTestResult) =>
  result.status === "fail" ||
  result.checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE);

export function NewAgentSetup() {
  const { selectedCompanyId } = useCompany();
  const [params] = useSearchParams();
  if (!selectedCompanyId)
    return (
      <p className="text-sm text-muted-foreground">{uiText("Select an organization to create an agent.")}{" "}</p>
    );
  return (
    <Setup
      key={`${selectedCompanyId}:${params.get("name")}:${params.get("adapterType")}:${params.get("runnerProvider")}`}
      companyId={selectedCompanyId}
      name={params.get("name") ?? ""}
      adapterType={params.get("adapterType") ?? ""}
      runnerProvider={params.get("runnerProvider") ?? "codex"}
      createdAgentId={params.get("createdAgentId")}
    />
  );
}

function Setup({
  companyId,
  name,
  adapterType,
  runnerProvider,
  createdAgentId,
}: {
  companyId: string;
  name: string;
  adapterType: string;
  runnerProvider: string;
  createdAgentId: string | null;
}) {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { openNewIssue } = useDialogActions();
  const appearanceDraft = useAgentAppearanceDraft(`${companyId}:new-agent`);
  const isRunner = adapterType === "paperclip_runner";
  const brandType = isRunner
    ? runnerProvider === "claude"
      ? "claude_local"
      : runnerProvider === "opencode"
        ? "opencode_local"
        : "codex_local"
    : adapterType;
  const connectionAdapter =
    brandType === "claude_local" || brandType === "codex_local" || brandType === "grok_local"
      ? brandType
      : null;
  const multiProvider =
    brandType === "opencode_local" || brandType === "pi_local";
  const providerKeys = setupProviderKeys(brandType);
  const chooseProvider = multiProvider || brandType === "hermes_local";
  const hasCredentialField =
    chooseProvider || Boolean(SETUP_CREDENTIAL_KEYS[adapterType]);
  const showModel = !["cursor_cloud", "hermes_gateway"].includes(adapterType);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [kimiModel, setKimiModel] = useState("");
  const [kimiBaseUrl, setKimiBaseUrl] = useState("");
  const [kimiProtocol, setKimiProtocol] = useState("kimi");
  const [screen, setScreen] = useState<"connect" | "runtime" | "saved">(
    createdAgentId ? "saved" : connectionAdapter ? "connect" : "runtime",
  );
  const [model, setModel] = useState("");
  const efforts = isRunner ? [] : setupEfforts(adapterType, model);
  const [effort, setEffort] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [environmentOverride, setEnvironmentOverride] = useState("");
  const [provider, setProvider] = useState("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [providerBinding, setProviderBinding] = useState<EnvBinding | null>(
    null,
  );
  const [runtimeAiBinding, setRuntimeAiBinding] = useState<AiConnectionBinding | undefined>(() =>
    brandType === "opencode_local"
      ? { provider: "openrouter", method: "api_key", mode: "responsible_user" }
      : undefined,
  );
  const [connection, setConnection] = useState<ProviderConnection | null>(null);
  const aiBinding = (connection?.relay || connection?.localConfiguration) ? undefined : runtimeAiBinding ?? connection?.aiConnection;
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [createdInSession, setCreated] = useState<Agent | null>(null);
  const savedAgent = useQuery({
    queryKey: queryKeys.agents.detail(createdAgentId ?? "new"),
    queryFn: () => agentsApi.get(createdAgentId!, companyId),
    enabled: Boolean(createdAgentId),
    retry: false,
  });
  const created =
    createdInSession ??
    (savedAgent.data?.companyId === companyId ? savedAgent.data : null);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<TestState | "warn">("idle");
  const [result, setResult] = useState<AdapterEnvironmentTestResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const savingRef = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const resetTest = () => {
    generation.current++;
    setResult(null);
    setTestState("idle");
    setError(null);
  };
  const adapters = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: adaptersApi.list,
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const envs = useQuery({
    queryKey: queryKeys.environments.list(companyId),
    queryFn: () => environmentsApi.list(companyId),
  });
  const settings = useQuery({
    queryKey: queryKeys.instance.settings,
    queryFn: instanceSettingsApi.get,
  });
  const experimental = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: instanceSettingsApi.getExperimental,
  });
  const general = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: instanceSettingsApi.getGeneral,
  });
  const caps = useQuery({
    queryKey: queryKeys.environments.capabilities(companyId),
    queryFn: () => environmentsApi.capabilities(companyId),
  });
  const models = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, brandType, null, aiBinding?.provider),
    queryFn: () => agentsApi.adapterModels(companyId, brandType, { provider: aiBinding?.provider }),
    enabled: Boolean(brandType) && showModel,
    retry: false,
  });
  const companySecrets = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
    enabled: hasCredentialField && adapterType !== "cursor_cloud",
  });
  const userSecrets = useQuery({
    queryKey: queryKeys.secrets.myUserSecrets(companyId),
    queryFn: () => secretsApi.listMyUserSecrets(companyId),
    enabled: hasCredentialField && adapterType !== "cursor_cloud",
    retry: false,
  });
  const forced = resolveForcedKubernetesEnvironment(
    general.data?.executionMode,
    envs.data ?? [],
  );
  const managedOnly = experimental.data?.enableManagedSandboxOnly === true;
  let environmentId: string | null = null;
  let environmentError: string | null = null;
  try {
    environmentId = forced.forced
      ? (forced.kubernetesEnvironment?.id ?? null)
      : resolveAdapterTestEnvironmentId({
          agentDefaultEnvironmentId: environmentOverride || null,
          instanceDefaultEnvironmentId:
            settings.data?.defaultEnvironmentId ?? null,
          localDefaultEnvironmentId: resolveLocalDefaultEnvironmentId(
            envs.data ?? [],
          ),
          managedSandboxOnly: managedOnly,
          managedSandboxEnvironmentId: resolveManagedSandboxEnvironmentId(
            envs.data ?? [],
          ),
          visibleEnvironmentIds: (envs.data ?? []).map((env) => env.id),
        });
  } catch (cause) {
    environmentError =
      cause instanceof Error
        ? cause.message
        : "Could not resolve the environment.";
  }
  const environment = envs.data?.find((env) => env.id === environmentId);
  const sandboxProvider =
    typeof environment?.config?.provider === "string"
      ? environment.config.provider
      : "";
  const canLogin =
    environment?.driver === "sandbox" &&
    caps.data?.sandboxProviders?.[sandboxProvider]?.supportsLoginPty === true;
  const envKey =
    SETUP_CREDENTIAL_KEYS[adapterType] ?? providerKeys[provider] ?? "API_KEY";
  const savedKey = userSecrets.data?.find(
    (entry) => entry.definition.key === envKey && entry.secret,
  );
  const savedOrganizationKey = companySecrets.data?.find(
    (entry) => entry.key === envKey && entry.status === "active",
  );
  const selectedBinding =
    adapterType === "cursor_cloud"
      ? null
      : (providerBinding ??
        (savedOrganizationKey
          ? {
              type: "secret_ref" as const,
              secretId: savedOrganizationKey.id,
              version: "latest" as const,
            }
          : savedKey
            ? {
                type: "user_secret_ref" as const,
                key: envKey,
                version: "latest" as const,
              }
            : null));
  const usingKimiApi =
    adapterType === "kimi_local" && Boolean(apiKey.trim() || selectedBinding);
  const cloud = Boolean(useCloudInstance());
  const available =
    isNewAgentAdapterAllowed(adapterType, {
      cloud,
      nativeRunnerEnabled: experimental.data?.enableNativeRunner === true,
    }) &&
    adapters.data?.some(
      (adapter) =>
        adapter.type === adapterType &&
        adapter.loaded &&
        !adapter.disabled &&
        !getAdapterDisplay(adapterType).comingSoon,
    );
  const ready = Boolean(
    available &&
    !environmentError &&
    !envs.isPending &&
    !settings.isPending &&
    !experimental.isPending &&
    !general.isPending &&
    !agents.isPending &&
    !caps.isPending &&
    !envs.error &&
    !settings.error &&
    !experimental.error &&
    !general.error &&
    !agents.error &&
    !caps.error &&
    (!(managedOnly || forced.forced) || environmentId),
  );
  const busy = testState === "running" || saving;

  function buildConfig(
    nextConnection = connection,
    binding = selectedBinding,
  ): Record<string, unknown> {
    const values = {
      ...defaultCreateValues,
      adapterType,
      model:
        (nextConnection?.model || model) || (brandType === "codex_local" ? DEFAULT_CODEX_LOCAL_MODEL : ""),
      thinkingEffort: effort,
      dangerouslyBypassSandbox: adapterType === "codex_local",
      envBindings: nextConnection?.env ?? {},
      ...(isRunner
        ? {
            adapterSchemaValues: {
              provider: runnerProvider === "claude" ? "acpx" : runnerProvider,
              ...(runnerProvider === "claude" ? { acpxAgent: "claude" } : {}),
            },
          }
        : {}),
    };
    const config = getUIAdapter(adapterType).buildAdapterConfig(values);
    if ((nextConnection?.relay || nextConnection?.localConfiguration) && adapterType === "claude_local") config.engine = "cli";
    if (nextConnection?.command) config.command = nextConnection.command;
    if (nextConnection?.extraArgs?.length) config.extraArgs = [...(Array.isArray(config.extraArgs) ? config.extraArgs : []), ...nextConnection.extraArgs];
    if (isRunner)
      Object.assign(config, {
        provider: runnerProvider === "claude" ? "acpx" : runnerProvider,
        ...(runnerProvider === "claude" ? { acpxAgent: "claude" } : {}),
        ...(model ? { model } : {}),
      });
    if (!aiBinding && !nextConnection?.aiConnection && hasCredentialField && binding) {
      if (adapterType === "hermes_gateway") config.apiKey = binding;
      else
        config.env = { ...((config.env as object) ?? {}), [envKey]: binding };
    }
    if (adapterType === "cursor_cloud")
      Object.assign(config, {
        repoUrl: repository.trim(),
        ...(branch.trim() ? { repoStartingRef: branch.trim() } : {}),
      });
    if (adapterType === "hermes_gateway") config.apiBaseUrl = gatewayUrl.trim();
    if (usingKimiApi) {
      // --model overrides Kimi's environment-defined model. Let KIMI_MODEL_NAME win.
      delete config.model;
      config.env = {
        ...((config.env as object) ?? {}),
        KIMI_MODEL_NAME: { type: "plain", value: kimiModel.trim() },
        KIMI_MODEL_PROVIDER_TYPE: { type: "plain", value: kimiProtocol },
        ...(kimiBaseUrl.trim()
          ? {
              KIMI_MODEL_BASE_URL: { type: "plain", value: kimiBaseUrl.trim() },
            }
          : {}),
      };
    }
    return config;
  }
  function preparedConfig(nextConnection = connection) {
    if (multiProvider && (!model.trim() || !model.includes("/")))
      throw new Error(uiText("Choose or enter a model in provider/model format."));
    if (
      adapterType === "cursor_cloud" &&
      !/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(repository.trim())
    )
      throw new Error(uiText("Enter a GitHub repository URL."));
    if (
      ["cursor_cloud", "hermes_gateway"].includes(adapterType) &&
      !apiKey.trim() &&
      !selectedBinding
    )
      throw new Error(
        adapterType === "cursor_cloud"
          ? "Enter a Cursor API key."
          : `Enter ${envKey} or select an organization secret.`,
      );
    if (adapterType === "hermes_gateway") {
      try {
        const url = new URL(gatewayUrl.trim());
        if (!["https:", "http:"].includes(url.protocol)) throw new Error();
      } catch {
        throw new Error(uiText("Enter the Hermes API base URL."));
      }
    }
    if (usingKimiApi && !kimiModel.trim())
      throw new Error(uiText("Enter the Kimi API model name."));
    return buildConfig(nextConnection);
  }
  function pendingCredentials(nextConnection = connection) {
    if (nextConnection?.localConfiguration) return {};
    if (!nextConnection?.relay && (aiBinding || nextConnection?.aiConnection)) return {};
    return {
      ...nextConnection?.credentials,
      ...(hasCredentialField && apiKey.trim()
        ? { [envKey]: apiKey.trim() }
        : {}),
    };
  }

  async function runTest(nextConnection = connection): Promise<boolean> {
    if (!ready) return false;
    const run = ++generation.current;
    setTestState("running");
    setResult(null);
    setError(null);
    try {
      const config = await preparedConfig(nextConnection);
      const tested = await testAgentSetup({
        companyId,
        adapterType,
        providerAdapter: brandType,
        adapterConfig: config,
        testCredentials: pendingCredentials(nextConnection),
        aiConnection: (nextConnection?.relay || nextConnection?.localConfiguration) ? undefined : runtimeAiBinding ?? nextConnection?.aiConnection,
        environmentId,
      });
      if (run !== generation.current) return false;
      setResult(tested);
      setTestState(blocking(tested) ? "fail" : tested.status);
      return (
        !blocking(tested) &&
        (!connectionAdapter ||
          tested.checks.some((check) =>
            check.code.endsWith("hello_probe_passed"),
          ))
      );
    } catch (cause) {
      if (run === generation.current) {
        setError(
          cause instanceof Error ? cause.message : "Could not test the agent.",
        );
        setTestState("fail");
      }
      return false;
    }
  }
  async function finish() {
    if (
      savingRef.current ||
      createdAgentId ||
      created ||
      !ready ||
      !name.trim() ||
      testState === "running" ||
      testState === "fail" ||
      (connectionAdapter && !connection)
    )
      return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const staged: Array<{ remove: () => Promise<unknown> }> = [];
    let hired = false;
    try {
      const config = preparedConfig();
      const credentials = pendingCredentials();
      // A local configuration may have changed or the user selected another host.
      if (connection?.localConfiguration && !(await runTest())) return;
      // Untested entered keys must pass a probe before they can be stored.
      if (Object.keys(credentials).length && !(await runTest())) return;
      for (const [key, value] of Object.entries(credentials)) {
        const store = connectionAdapter
          ? storeProviderApiKey
          : storeOrganizationApiKey;
        const secret = await store(companyId, key, value);
        staged.push(secret);
        if (adapterType === "hermes_gateway" && key === "API_SERVER_KEY")
          config.apiKey = secret.binding;
        else
          config.env = {
            ...((config.env as object) ?? {}),
            [key]: secret.binding,
          };
      }
      const existing = agents.data ?? [];
      const leader = existing.find(
        (agent) => agent.role === "ceo" && agent.status !== "terminated",
      );
      const response = await agentsApi.hire(companyId, {
        name: name.trim(),
        appearance: appearanceDraft.appearance,
        role: existing.length ? "general" : "ceo",
        ...(leader ? { reportsTo: leader.id } : {}),
        adapterType,
        adapterConfig: config,
        defaultEnvironmentId:
          environmentOverride ||
          (connection?.localConfiguration || forced.forced || managedOnly ? environmentId : null),
        runtimeConfig: { ...buildNewAgentRuntimeConfig({ heartbeatEnabled: false }), ...(aiBinding ? { aiConnection: aiBinding } : {}) },
        budgetMonthlyCents: 0,
        ...(connection?.storedSessionId
          ? { storedSessionId: connection.storedSessionId }
          : {}),
        ...(connection?.applyStoredClaudeLogin
          ? { applyStoredClaudeLogin: true }
          : {}),
      });
      hired = true;
      setApiKey("");
      setConnection(null);
      setCreated(response.agent);
      appearanceDraft.clear();
      setScreen("saved");
      navigate(
        `/agents/new?${new URLSearchParams({ name: response.agent.name, adapterType, runnerProvider, createdAgentId: response.agent.id })}`,
        { replace: true },
      );
      cache.setQueryData(
        queryKeys.agents.detail(response.agent.id),
        response.agent,
      );
      await Promise.all([
        cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
        cache.invalidateQueries({
          queryKey: queryKeys.approvals.list(companyId),
        }),
      ]);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create the agent.",
      );
    } finally {
      if (!hired) {
        try {
          await Promise.all(staged.map((secret) => secret.remove()));
        } catch {
          setError(
            (original) =>
              `${original ? `${original} ` : ""}Could not remove an unused setup credential. Remove it from Secrets before retrying.`,
          );
        }
      }
      void cache.invalidateQueries({
        queryKey: queryKeys.secrets.myUserSecrets(companyId),
      });
      void cache.invalidateQueries({
        queryKey: queryKeys.secrets.list(companyId),
      });
      savingRef.current = false;
      setSaving(false);
    }
  }
  if (createdAgentId && !created)
    return (
      <p
        role={savedAgent.error ? "alert" : "status"}
        className="text-sm text-muted-foreground"
      >
        {savedAgent.error
          ? uiText("Could not load the created agent. Return to Agents to view it.")
          : uiText("Loading your agent…")}
      </p>
    );
  if (!name || !adapterType)
    return (
      <AgentBasicsDialog
        open
        initialAdapter={adapterType}
        onClose={() => navigate("/agents/all")}
        onContinue={(basics) =>
          navigate(`/agents/new?${new URLSearchParams(basics)}`, {
            replace: true,
          })
        }
      />
    );
  const steps = [
    ...(connectionAdapter ? ["connect" as const] : []),
    "runtime" as const,
    "saved" as const,
  ];
  const labels = {
    connect: "Connect",
    runtime: "Configure",
    saved: "Confirmation",
  };
  const confirmationEnvironment = created?.defaultEnvironmentId
    ? envs.data?.find((env) => env.id === created.defaultEnvironmentId)
    : environment;
  const createdKimiModel = (
    created?.adapterConfig?.env as Record<string, unknown> | undefined
  )?.KIMI_MODEL_NAME;
  const confirmationModel =
    created?.adapterConfig?.model ||
    (typeof createdKimiModel === "string"
      ? createdKimiModel
      : (createdKimiModel as { value?: string } | undefined)?.value) ||
    model ||
    "Default";
  const environmentLabel =
    adapterType === "cursor_cloud"
      ? "Cursor Cloud"
      : adapterType === "hermes_gateway"
        ? "Hermes Gateway"
        : confirmationEnvironment
          ? environmentDisplayLabel(confirmationEnvironment)
          : "Local machine";
  const setupError =
    adapters.error ??
    envs.error ??
    settings.error ??
    experimental.error ??
    general.error ??
    agents.error ??
    caps.error;
  return (
    <MotionConfig reducedMotion="user">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 py-6">
        <header className="flex items-center gap-4">
          <AgentCharacter appearance={created?.appearance ?? appearanceDraft.appearance} size={256} className="size-48" trackingScope="page"
            state={created || testState === "pass" ? "success" : testState === "running" ? "loading" : "sleepy"}
            muted={!created && testState !== "pass"} />
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AdapterMark type={brandType} />
              <span>{getAdapterDisplay(brandType).label}</span>
              {isRunner && (
                <span>
                  ·{" "}
                  {runnerProvider === "codex"
                    ? uiText("Native app server runner")
                    : "Paperclip Runner"}
                </span>
              )}
            </div>
          </div>
        </header>
        {environmentError && !envs.isPending && (
          <p role="alert" className="text-sm text-destructive">
            {environmentError}
          </p>
        )}
        {setupError && (
          <p role="alert" className="text-sm text-destructive">
            {setupError.message}
          </p>
        )}
        {adapters.data && !available && (
          <p role="alert" className="text-sm text-destructive">{uiText("This adapter is unavailable. Choose an enabled adapter.")}{" "}</p>
        )}
        {(managedOnly || forced.forced) &&
          !envs.isPending &&
          !environmentId && (
            <p role="alert" className="text-sm text-destructive">{uiText("No managed environment is available. Configure an environment before continuing.")}{" "}</p>
          )}
        <div className="flex flex-col gap-8 md:flex-row">
          <nav aria-label={uiText("Agent setup steps")} className="shrink-0 md:w-44">
            <ol className="flex flex-wrap gap-2 md:flex-col">
              {steps.map((step, index) => (
                <li key={step}>
                  <button
                    type="button"
                    aria-current={step === screen ? "step" : undefined}
                    disabled={
                      busy || Boolean(created) || index > steps.indexOf(screen)
                    }
                    onClick={() => setScreen(step)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm",
                      step === screen
                        ? "bg-accent font-medium"
                        : "text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
                        step === screen
                          ? "border-foreground bg-foreground text-background"
                          : "border-border",
                      )}
                    >
                      {index + 1}
                    </span>
                    {labels[step]}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <div className="min-w-0 flex-1">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={screen} {...stepMotion}>
                {screen === "connect" && connectionAdapter ? (
                  <OnboardingCard className="mx-auto">
                    <div className="mb-8">
                      <OnboardingHeading
                        title={uiText("Connect a model")}
                        lede={`Connect ${name} to ${connectionAdapter === "claude_local" ? "Claude" : connectionAdapter === "grok_local" ? "Grok" : "OpenAI"}.`}
                        center
                      />
                    </div>
                    {connectionAdapter === "claude_local" && !isRunner && !forced.forced && !managedOnly && <RegisteredSeatConnection companyId={companyId} />}
                    <div className="mb-6 space-y-2">
                      <label htmlFor="connect-execution-environment" className="block text-sm font-medium">Claude 执行环境</label>
                      <select id="connect-execution-environment" className={controlClass} value={environmentOverride} disabled={busy || forced.forced || managedOnly} onChange={(event) => {
                        setEnvironmentOverride(event.target.value); setConnection(null); setRuntimeAiBinding(undefined); resetTest();
                      }}>
                        <option value="">默认：{environmentLabel}</option>
                        {(envs.data ?? []).filter((env) => env.status === "active").map((env) => <option key={env.id} value={env.id}>{environmentDisplayLabel(env)}</option>)}
                      </select>
                      <p className="text-xs text-muted-foreground">先选择安装了 Claude 的执行电脑，再检查连接。Local 表示 智研协同平台服务器本地环境；使用研发电脑时请选择对应的 SSH 环境。</p>
                    </div>
                    <AgentProviderConnection
                      key={environmentId ?? "local"}
                      companyId={companyId}
                      adapterType={connectionAdapter}
                      environmentId={environmentId}
                      canLogin={canLogin}
                      localEnvironment={environment?.driver === "local"}
                      allowLocalConfiguration={!isRunner}
                      onBack={() => navigate("/agents/all")}
                      testConnection={runTest}
                      testError={
                        error ??
                        (
                          result?.checks.find(
                            (check) => check.level === "error",
                          ) ??
                          result?.checks.find(
                            (check) =>
                              check.code.includes("hello_probe") &&
                              check.level === "warn",
                          )
                        )?.message
                      }
                      onConnected={(next) => {
                        const { model: connectionModel, ...configuredConnection } = next;
                        setConnection(configuredConnection);
                        if (next.relay || next.localConfiguration) setRuntimeAiBinding(undefined);
                        if (connectionModel) setModel(connectionModel);
                        resetTest();
                        setScreen("runtime");
                      }}
                    />
                  </OnboardingCard>
                ) : screen === "saved" && created ? (
                  <div className="space-y-6">
                    <div className="space-y-6 rounded-lg border border-border p-6">
                      <h2 className="flex items-center gap-3 text-lg font-semibold">
                        <Check className="size-5" />
                        {created.status === "pending_approval"
                          ? uiText("Agent submitted for approval")
                          : uiText("Your agent is ready")}
                      </h2>
                      <dl className="grid grid-cols-2 gap-4 text-sm">
                        <dt className="text-muted-foreground">{uiText("Adapter")}</dt>
                        <dd>{getAdapterDisplay(adapterType).label}</dd>
                        {showModel && (
                          <>
                            <dt className="text-muted-foreground">{uiText("Model")}</dt>
                            <dd className="break-all">
                              {String(confirmationModel)}
                            </dd>
                          </>
                        )}
                        <dt className="text-muted-foreground">{uiText("Environment")}</dt>
                        <dd>{environmentLabel}</dd>
                      </dl>
                      <p className="text-sm text-muted-foreground">
                        {created.status === "pending_approval"
                          ? uiText("An organization administrator must approve this agent before it can work.")
                          : uiText("Assign a task when you’re ready for this agent to work.")}
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-between gap-3">
                      <Button
                        variant="outline"
                        onClick={() => navigate(`${agentUrl(created)}/runtime`)}
                      >
                        <Settings2 className="size-4" />
                        {uiText("Edit configuration")}
                      </Button>
                      <Button
                        disabled={created.status === "pending_approval"}
                        onClick={() =>
                          openNewIssue({
                            assigneeAgentId: created.id,
                            status: "todo",
                          })
                        }
                      >
                        {uiText("Assign")} {created.name}{" "}{uiText("a Task")}{" "}<ArrowRight className="size-4" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <form
                    className="space-y-8"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void finish();
                    }}
                  >
                    <h2 className="text-xl font-semibold">{uiText("Configure your agent")}{" "}</h2>
                    <fieldset disabled={busy} className="space-y-8">
                      <section className="space-y-5">
                        <h3 className="text-sm font-semibold">{uiText("Runtime")}</h3>
                        {connection?.localConfiguration && <div className="space-y-3 rounded-md border border-border p-4">
                          <p className="text-sm font-medium">使用执行电脑的已有 Claude 配置</p>
                          <p className="text-xs text-muted-foreground">Claude 命令：{connection.command ?? "claude"}。网站不注入密钥和中转站地址。{connection.extraArgs?.[1] ? `工程配置文件：${connection.extraArgs[1]}` : "使用用户级设置或执行目录中的工程设置。"}</p>
                          <Button type="button" variant="outline" onClick={() => setScreen("connect")}>修改配置来源</Button>
                        </div>}
                        {connection?.relay && <div className="space-y-3 rounded-md border border-border p-4">
                          <p className="text-sm font-medium">第三方中转站（Claude CLI）</p>
                          <p className="break-all text-sm text-muted-foreground">{String((connection.env.ANTHROPIC_BASE_URL as { value?: string })?.value ?? "")}</p>
                          <p className="text-xs text-muted-foreground">使用连接步骤选择的中转站密钥。模型可在下方修改；现有官方连接不会替代此密钥。</p>
                          <Button type="button" variant="outline" onClick={() => setScreen("connect")}>修改中转站连接</Button>
                        </div>}
                        {!connection?.relay && !connection?.localConfiguration && aiProviderForAdapter(brandType) && (
                          connection && !aiBinding ? (
                            <div className="space-y-3">
                              <p className="text-sm text-muted-foreground">{uiText("Using the connection selected in the Connect step.")}{" "}</p>
                              <Button type="button" variant="outline" onClick={() => setScreen("connect")}>{uiText("Change connection")}{" "}</Button>
                            </div>
                          ) : (
                            <AiConnectionField companyId={companyId} agentName={name} adapterType={brandType} model={model} environmentId={environmentId ?? undefined} value={aiBinding}
                              onChange={binding => { setRuntimeAiBinding(binding); resetTest(); }} />
                          )
                        )}
                        {models.error && <p role="alert" className="text-sm text-destructive">{uiText("Could not load models. Retry or enter a model ID manually.")}</p>}
                        {((showModel && !usingKimiApi) ||
                          efforts.length > 0) && (
                          <div className="grid items-start gap-5 sm:grid-cols-2">
                            {showModel && !usingKimiApi && (
                              <ModelDropdown
                                models={models.data ?? []}
                                value={model}
                                onChange={(value) => {
                                  setModel(value);
                                  if (
                                    effort &&
                                    !setupEfforts(adapterType, value).includes(
                                      effort,
                                    )
                                  )
                                    setEffort("");
                                  const nextProvider = value.split("/")[0];
                                  if (
                                    multiProvider &&
                                    PROVIDER_ENV_KEYS[nextProvider] &&
                                    nextProvider !== provider
                                  ) {
                                    setProvider(nextProvider);
                                    setApiKey("");
                                    setProviderBinding(null);
                                  }
                                  resetTest();
                                }}
                                open={modelOpen}
                                onOpenChange={setModelOpen}
                                allowDefault={!multiProvider}
                                required={multiProvider}
                                creatable
                                groupByProvider={multiProvider}
                              />
                            )}
                            {efforts.length > 0 && (
                              <Field label={uiText("Thinking effort")}>
                                <select
                                  aria-label={uiText("Thinking effort")}
                                  className={controlClass}
                                  value={effort}
                                  onChange={(event) => {
                                    setEffort(event.target.value);
                                    resetTest();
                                  }}
                                >
                                  <option value="">{uiText("Auto")}</option>
                                  {efforts.map((value) => (
                                    <option key={value} value={value}>
                                      {value}
                                    </option>
                                  ))}
                                </select>
                              </Field>
                            )}
                          </div>
                        )}
                        {SETUP_LOGIN_HINTS[adapterType] && (
                          <p className="text-sm text-muted-foreground">
                            {SETUP_LOGIN_HINTS[adapterType]}
                          </p>
                        )}
                        {showModel && models.error && (
                          <p className="text-xs text-muted-foreground">{uiText("Couldn’t load models. You can enter a model ID manually.")}{" "}</p>
                        )}
                        {hasCredentialField && !aiBinding && (
                          <div className="grid gap-5 sm:grid-cols-2">
                            {chooseProvider && (
                              <Field label={uiText("API key provider")}>
                                <select
                                  aria-label={uiText("API key provider")}
                                  className={controlClass}
                                  value={provider}
                                  onChange={(event) => {
                                    setProvider(event.target.value);
                                    setModel("");
                                    setApiKey("");
                                    setProviderBinding(null);
                                    resetTest();
                                  }}
                                >
                                  {Object.keys(providerKeys).map((key) => (
                                    <option key={key} value={key}>
                                      {key === "openrouter"
                                        ? uiText("OpenRouter")
                                        : key === "openai"
                                          ? "OpenAI"
                                          : key === "anthropic"
                                            ? "Anthropic"
                                            : ({
                                                google: "Google",
                                                xai: "xAI",
                                                groq: "Groq",
                                                opencode: "OpenCode",
                                              }[key] ?? key)}
                                    </option>
                                  ))}
                                </select>
                              </Field>
                            )}
                            <div
                              className={
                                adapterType === "cursor_cloud"
                                  ? "sm:col-span-2"
                                  : undefined
                              }
                            >
                              <Field label={envKey}>
                                <div className="flex items-center gap-3">
                                  <Input
                                    aria-label={envKey}
                                    type="password"
                                    autoComplete="off"
                                    value={apiKey}
                                    onChange={(event) => {
                                      setApiKey(event.target.value);
                                      setProviderBinding(null);
                                      resetTest();
                                    }}
                                    placeholder={
                                      selectedBinding
                                        ? uiText("Using saved key")
                                        : [
                                              "cursor_cloud",
                                              "hermes_gateway",
                                            ].includes(adapterType)
                                          ? uiText("Required")
                                          : uiText("Optional if already configured")
                                    }
                                  />
                                  {adapterType === "cursor_cloud" && (
                                    <a
                                      href="https://cursor.com/dashboard/api?section=user-keys#user-api-keys"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="shrink-0 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                                    >{uiText("get api key")}{" "}</a>
                                  )}
                                </div>
                              </Field>
                            </div>
                            {adapterType !== "cursor_cloud" && (
                              <div
                                className={
                                  chooseProvider ? "sm:col-span-2" : undefined
                                }
                              >
                                <Field label={uiText("Or use an organization secret")}>
                                  <SecretPicker
                                    secretId={
                                      selectedBinding &&
                                      typeof selectedBinding === "object" &&
                                      selectedBinding.type === "secret_ref"
                                        ? selectedBinding.secretId
                                        : ""
                                    }
                                    secrets={companySecrets.data ?? []}
                                    disabled={busy}
                                    onSelect={(secretId) => {
                                      setProviderBinding({
                                        type: "secret_ref",
                                        secretId,
                                        version: "latest",
                                      });
                                      setApiKey("");
                                      resetTest();
                                    }}
                                  />
                                </Field>
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground sm:col-span-2">{uiText("New keys are saved as organization secrets when you finish setup.")}{" "}{multiProvider && uiTextFormat(" Use a __PCVAR0__/model ID.", [provider])}
                            </p>
                          </div>
                        )}
                        {adapterType === "hermes_gateway" && (
                          <Field label={uiText("Hermes API base URL")}>
                            <Input
                              aria-label={uiText("Hermes API base URL")}
                              value={gatewayUrl}
                              onChange={(event) => {
                                setGatewayUrl(event.target.value);
                                resetTest();
                              }}
                              placeholder="https://hermes.example.com"
                            />
                          </Field>
                        )}
                        {usingKimiApi && (
                          <div className="grid gap-5 sm:grid-cols-2">
                            <Field label={uiText("Kimi API model name")}>
                              <Input
                                aria-label={uiText("Kimi API model name")}
                                value={kimiModel}
                                onChange={(event) => {
                                  setKimiModel(event.target.value);
                                  resetTest();
                                }}
                                placeholder="kimi-for-coding"
                              />
                            </Field>
                            <Field label={uiText("Kimi API protocol")}>
                              <select
                                aria-label={uiText("Kimi API protocol")}
                                className={controlClass}
                                value={kimiProtocol}
                                onChange={(event) => {
                                  setKimiProtocol(event.target.value);
                                  resetTest();
                                }}
                              >
                                {["kimi", "anthropic", "openai"].map(
                                  (value) => (
                                    <option key={value}>{value}</option>
                                  ),
                                )}
                              </select>
                            </Field>
                            <Field
                              label={uiText("Kimi API base URL")}
                              hint={uiText("Optional override for your provider endpoint.")}
                            >
                              <Input
                                aria-label={uiText("Kimi API base URL")}
                                value={kimiBaseUrl}
                                onChange={(event) => {
                                  setKimiBaseUrl(event.target.value);
                                  resetTest();
                                }}
                                placeholder={uiText("Provider default")}
                              />
                            </Field>
                          </div>
                        )}
                        {adapterType === "cursor_cloud" && (
                          <div className="grid gap-5 sm:grid-cols-2">
                            <Field label={uiText("GitHub repository")}>
                              <Input
                                aria-label={uiText("GitHub repository")}
                                value={repository}
                                onChange={(event) => {
                                  setRepository(event.target.value);
                                  resetTest();
                                }}
                                placeholder="https://github.com/your-org/repo"
                              />
                            </Field>
                            <Field label={uiText("Branch")}>
                              <Input
                                aria-label={uiText("Branch")}
                                placeholder={uiText("Repository default")}
                                value={branch}
                                onChange={(event) => {
                                  setBranch(event.target.value);
                                  resetTest();
                                }}
                              />
                            </Field>
                          </div>
                        )}
                      </section>
                      {!["cursor_cloud", "hermes_gateway"].includes(
                        adapterType,
                      ) && (
                        <section className="space-y-5">
                          <h3 className="text-sm font-semibold">{uiText("Environment")}</h3>
                          <select
                            aria-label={uiText("Environment")}
                            className={controlClass}
                            value={environmentOverride}
                            disabled={forced.forced || managedOnly}
                            onChange={(event) => {
                              setEnvironmentOverride(event.target.value);
                              setConnection(null);
                              resetTest();
                              if (connectionAdapter) setScreen("connect");
                            }}
                          >
                            <option value="">
                              {uiText("Default:")} {environmentLabel}
                            </option>
                            {(envs.data ?? [])
                              .filter((env) => env.status === "active")
                              .map((env) => (
                                <option key={env.id} value={env.id}>
                                  {environmentDisplayLabel(env)}
                                </option>
                              ))}
                          </select>
                        </section>
                      )}
                    </fieldset>
                    <RuntimeTestCard
                      state={testState}
                      result={result}
                      error={error}
                      disabled={!ready || busy}
                      onTest={() => void runTest()}
                    />
                    {error && testState !== "fail" && (
                      <p role="alert" className="text-sm text-destructive">
                        {error}
                      </p>
                    )}
                    <div className="flex justify-between border-t border-border py-5">
                      {connectionAdapter ? (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setScreen("connect")}
                        >
                          <ArrowLeft className="size-4" />
                          {uiText("Connection")}
                        </Button>
                      ) : (
                        <span />
                      )}
                      <Button
                        type="submit"
                        disabled={
                          !ready ||
                          busy ||
                          testState === "fail" ||
                          Boolean(connectionAdapter && !connection)
                        }
                      >
                        {saving ? uiText("Creating…") : uiText("Finish setup")}
                        <Check className="size-4" />
                      </Button>
                    </div>
                  </form>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </MotionConfig>
  );
}
