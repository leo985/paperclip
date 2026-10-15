import { uiTextFormat,  uiText } from "@/i18n/interface";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, ExternalLink, HelpCircle, Loader2, Plus, Trash2 } from "lucide-react";
import { InlineBanner } from "@/components/InlineBanner";
import { ActionsSection } from "@/pages/apps/app-detail/PermissionsPanel";
import { SetupWizardFooter } from "@/components/SetupWizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RemoteMcpManagement } from "./RemoteMcpManagement";
import { AccessStepContent, StepHeader } from "../ConnectionSetupFlow";
import type { RemoteMcpProvider } from "./providers";
import type { RemoteMcpSetupActions, RemoteMcpSetupState } from "./types";

const steps = ["access", "connect"] as const;
const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function FieldHelp({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger asChild><button type="button" aria-label={uiTextFormat("Help with __PCVAR0__", [label])} onClick={() => setOpen(!open)} className="rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><HelpCircle className="size-4" /></button></TooltipTrigger>
    <TooltipContent className="max-w-xs">{children}</TooltipContent>
  </Tooltip>;
}

/** Controlled presentation shared by provider setup, configuration imports and review stories.
 * Authentication, persistence and calls belong to the controller, never these views. */
export function RemoteMcpConnectionSetup({ provider, state: s, actions: a, agents, connectionId }: {
  provider: RemoteMcpProvider;
  connectionId: string;
  state: RemoteMcpSetupState;
  actions: RemoteMcpSetupActions;
  agents: { id: string; name: string }[];
}) {
  const uid = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(s.step);
  useEffect(() => {
    if (previousStep.current !== s.step) heading.current?.focus();
    previousStep.current = s.step;
  }, [s.step]);
  const currentStep = steps.indexOf(s.step as typeof steps[number]);
  const busy = s.connectStatus === "connecting";
  const change = (patch: Partial<RemoteMcpSetupState>) => a.edit(patch);
  const external = (purpose: Parameters<typeof a.openProvider>[0], text: string) => <Button type="button" variant="link" className="h-auto p-0 text-sm text-current underline" onClick={() => a.openProvider(purpose)}>{text}<ExternalLink className="size-3.5" aria-hidden="true" /></Button>;
  const boundary = <InlineBanner compact>{uiText("Paperclip controls access to the tools listed here. App and action permissions inside these tools are managed in")}{" "}{external("manage", provider.name)}.
  </InlineBanner>;
  const footer = (children: ReactNode) => <SetupWizardFooter onSaveExit={a.saveExit} disabled={busy}>{children}</SetupWizardFooter>;

  const error = s.connectStatus === "invalid_url" ? { title: uiText("Enter a valid MCP URL"), body: uiText("Paste the complete server URL, including https:// or http://. A dashboard page is not an MCP endpoint.") }
    : s.connectStatus === "rejected" ? { title: uiText("Credentials were rejected"), body: uiTextFormat("Check or replace the credentials from __PCVAR0__, then reconnect. Your agent access and tool choices are preserved.", [provider.name]) }
    : s.connectStatus === "unreachable" ? { title: uiText("Paperclip could not reach this server"), body: uiText("Check that the endpoint is running and reachable from Paperclip, then try again. Your draft is still here.") }
    : null;

  return <div className="mx-auto max-w-6xl p-4 text-foreground sm:p-8" data-remote-mcp-provider={provider.id}>
    <StepHeader headingRef={heading} appIdentity={{ name: provider.name, logoUrl: null }}
      title={s.step === "draft" ? uiText("Continue your setup") : s.setupComplete ? s.step === "access" ? uiText("Who can use this connection") : s.step === "connect" ? uiTextFormat("Reconnect __PCVAR0__", [provider.name]) : provider.name : undefined}
      subtitle={currentStep >= 0 && !s.setupComplete ? uiTextFormat("Step __PCVAR0__ of 2", [currentStep + 1]) : s.step === "draft" ? uiTextFormat("Your __PCVAR0__ setup is ready to resume.", [provider.name]) : s.step === "permissions" ? uiTextFormat("Connected__PCVAR0__ · __PCVAR1__ actions available", [s.identity ? ` as ${s.identity}` : "", s.tools.length]) : uiTextFormat("Manage this __PCVAR0__ connection.", [provider.name])}
      step={currentStep >= 0 && !s.setupComplete ? "access" : "gallery"} activeIndex={currentStep} labels={["Access", "Connect"]} onCancel={busy || s.step === "management" || s.step === "permissions" || s.step === "draft" ? undefined : a.saveExit} />
    <main className="space-y-6">
        {s.notice && <p role="status" className="text-sm text-muted-foreground">{s.notice}</p>}

        {s.step === "access" && <AccessStepContent agents={agents} authKind="oauth" grantKind={s.grantKind} setGrantKind={(grantKind) => { if (grantKind !== "agent") change({ grantKind }); }}
          installChoice={s.allAgents ? "all" : "specific"} setInstallChoice={(choice) => change({ allAgents: choice === "all" })}
          installAgentIds={new Set(s.agentIds)} setInstallAgentIds={(ids) => change({ agentIds: [...ids] })}
          submitLabel={s.setupComplete ? "Done" : "Continue"} onBack={s.setupComplete ? a.finish : a.saveExit} onContinue={s.setupComplete ? a.finish : () => a.navigate("connect")} />}
        {s.step === "permissions" && <>
          <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">{uiText("Permissions")}</h2><Button variant="outline" onClick={a.finish}>{uiText("Connection settings")}</Button></div>
          {s.tools.some((entry) => entry.broad) && boundary}
          <ActionsSection connectionId={connectionId} appName={provider.name}
            readOnly={s.tools.filter((entry) => entry.isReadOnly)} canChange={s.tools.filter((entry) => !entry.isReadOnly)} quarantined={[]}
            enabledIds={new Set(s.tools.filter((entry) => s.permissions[entry.id] !== "off").map((entry) => entry.id))}
            askFirstIds={new Set(s.tools.filter((entry) => s.permissions[entry.id] === "ask_first").map((entry) => entry.id))}
            disabled={!s.connected} refreshPending={s.refreshing} canConfigure
            onSetPermission={(id, next) => change({ permissions: { ...s.permissions, [id]: next === "ask" ? "ask_first" : next } })}
            onReviewQuarantined={() => {}} onRefreshActions={a.refresh} />
        </>}
        <div className="mx-auto max-w-2xl space-y-6">
        {s.step === "connect" && <>
          <div className="space-y-3">
            <ol className="list-decimal space-y-2 pl-5 text-sm">{provider.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ol>
            {external("setup", `Open ${provider.name} setup guide`)}
          </div>
          {s.connectStatus === "sign_in" && provider.supportsBrowserAuth ? <>
            <div role="status"><InlineBanner title={uiTextFormat("Finish signing in to __PCVAR0__", [provider.name])}>{uiText("Complete sign-in in the provider window, then return here. Paperclip is waiting for confirmation.")}{" "}</InlineBanner></div>
            <p className="text-sm text-muted-foreground">{uiText("If a window did not open,")}{" "}{external("sign_in", "open sign-in again")}.</p>
            {footer(<><Button variant="outline" onClick={a.cancelConnect}>{uiText("Cancel sign-in")}</Button><Button disabled>{uiText("Waiting for sign-in")}</Button></>)}
          </> : <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); a.connect(); }}>
            {error && <div role="alert"><InlineBanner tone="danger" title={error.title}>{error.body}</InlineBanner></div>}
            {s.connectStatus === "cancelled" && <p role="status" className="text-sm text-muted-foreground">{uiText("Connection cancelled. Your setup details are preserved; try again when you are ready.")}</p>}
            <fieldset disabled={busy} className="min-w-0 space-y-5">
              <div className="space-y-2">
                <div className="flex items-center gap-2"><Label htmlFor={`${uid}-url`}>{uiText("MCP server URL")}</Label><FieldHelp label={uiText("MCP server URL")}>{provider.urlHelp}</FieldHelp></div>
                <Input id={`${uid}-url`} type="password" autoComplete="off" spellCheck={false} placeholder={provider.placeholder} value={s.url} aria-invalid={s.connectStatus === "invalid_url"} aria-describedby={`${uid}-url-help`} onChange={(event) => change({ url: event.target.value })} />
                <p id={`${uid}-url-help`} className="text-xs text-muted-foreground">{provider.urlHelp}</p>
              </div>
              <details open={s.advanced} onToggle={(event) => { if (event.currentTarget.open !== s.advanced) change({ advanced: event.currentTarget.open }); }}>
                <summary className="cursor-pointer text-sm font-medium">{uiText("Advanced authentication")}</summary>
                <div className="space-y-4 pt-4">
                  <p className="text-sm text-muted-foreground">{provider.authHelp}</p>
                  <div className="space-y-2"><Label htmlFor={`${uid}-auth`}>{uiText("Authentication")}</Label><select id={`${uid}-auth`} className={selectClass} value={s.auth} onChange={(event) => change({ auth: event.target.value as RemoteMcpSetupState["auth"] })}>
                    {provider.supportsBrowserAuth && <option value="auto">{uiText("Automatic (sign in if required)")}</option>}<option value="bearer">{uiText("Bearer token")}</option><option value="headers">{uiText("Custom headers")}</option><option value="none">{uiText("No additional authentication")}</option>
                  </select></div>
                  {s.auth === "bearer" && <div className="space-y-2"><div className="flex items-center gap-2"><Label htmlFor={`${uid}-token`}>{uiText("Bearer token")}</Label><FieldHelp label={uiText("bearer token")}>{uiText("Paste the token only, without the word Bearer. It is kept in the connection’s credentials.")}</FieldHelp></div><Input id={`${uid}-token`} type="password" autoComplete="off" value={s.token} onChange={(event) => change({ token: event.target.value })} /></div>}
                  {(s.auth === "bearer" || s.auth === "headers") && <div className="space-y-3">
                    <p className="text-sm font-medium">{s.auth === "bearer" ? uiText("Additional headers") : uiText("Headers")}</p>
                    {s.headers.map((header, index) => <div key={header.id} className="flex flex-wrap items-end gap-2">
                      <div className="min-w-0 flex-1 space-y-2"><Label htmlFor={`${uid}-${header.id}-name`}>{uiText("Header")} {index + 1} name</Label><Input id={`${uid}-${header.id}-name`} value={header.name} placeholder={provider.id === "arcade" ? uiText("Arcade-User-ID") : uiText("Header name")} onChange={(event) => change({ headers: s.headers.map((h) => h.id === header.id ? { ...h, name: event.target.value } : h) })} /></div>
                      <div className="min-w-0 flex-1 space-y-2"><Label htmlFor={`${uid}-${header.id}-value`}>{uiText("Header")} {index + 1} value</Label><Input id={`${uid}-${header.id}-value`} type="password" autoComplete="off" value={header.value} onChange={(event) => change({ headers: s.headers.map((h) => h.id === header.id ? { ...h, value: event.target.value } : h) })} /></div>
                      <Button type="button" variant="ghost" size="icon" aria-label={uiTextFormat("Remove header __PCVAR0__", [index + 1])} onClick={() => change({ headers: s.headers.filter((h) => h.id !== header.id) })}><Trash2 className="size-4" /></Button>
                    </div>)}
                    <Button type="button" variant="outline" size="sm" onClick={() => change({ headers: [...s.headers, { id: crypto.randomUUID(), name: "", value: "" }] })}><Plus className="size-4" />{uiText("Add header")}</Button>
                  </div>}
                </div>
              </details>
            </fieldset>
            {busy && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" />{uiText("Connecting and discovering tools…")}</p>}
            {footer(<><Button type="button" variant="outline" disabled={busy} onClick={() => s.setupComplete ? a.finish() : a.navigate("access")}>{uiText("Back")}</Button><Button type="submit" disabled={busy || !s.url.trim()}>{busy ? uiText("Connecting…") : error || s.connectStatus === "cancelled" ? uiText("Try again") : uiText("Connect")}</Button></>)}
          </form>}
        </>}

        {s.step === "management" && <>
          {!s.connected ? <InlineBanner tone="warning" title={uiText("Disconnected")}>{uiText("Agents cannot use this connection. Reconnect to restore access under the saved permission choices.")}</InlineBanner> : <div className="space-y-2"><p className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4" />{uiText("Connected")}{s.identity ? uiTextFormat(" as __PCVAR0__", [s.identity]) : ""}</p><p className="text-sm text-muted-foreground">{s.grantKind === "user" ? uiText("Just me") : uiText("Any human in the organization")} · {s.tools.length}{" "}{uiText("tools ·")}{" "}{s.allAgents ? uiText("Any agent") : uiTextFormat("__PCVAR0__ agents with access", [s.agentIds.length])}</p></div>}
          <div className="flex flex-wrap gap-2"><Button onClick={() => a.navigate("access")}>{uiText("Who can use this connection")}</Button><Button variant="outline" disabled={!s.connected} onClick={() => a.navigate("permissions")}>{uiText("Permissions")}</Button></div>
          <p className="text-sm text-muted-foreground">{uiText("Refresh the catalog after changing tools in")}{" "}{provider.name}{uiText(". Existing Off and Ask first choices are preserved.")}</p>
          <Button variant="outline" disabled={!s.connected || s.refreshing} onClick={a.refresh}>{s.refreshing ? uiText("Refreshing…") : uiText("Refresh tools")}</Button>
          <RemoteMcpManagement providerName={provider.name} connected={s.connected} onReconnect={a.reconnect} onManage={() => a.openProvider("manage")} onDisconnect={a.disconnect} />
        </>}
        {s.step === "draft" && <><p className="text-sm">{uiText("Your access choices and setup progress are kept with this connection.")}</p><div className="flex justify-end"><Button onClick={a.resumeDraft}>{uiText("Resume setup")}</Button></div></>}
        </div>
    </main>
  </div>;
}
