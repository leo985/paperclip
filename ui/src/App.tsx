import { useManagementAccess } from "@/hooks/useManagementAccess";
import { canEnterAppsConnect } from "./pages/apps/app-connect-policy";
import { AGENT_FILTER_TABS } from "./lib/agent-filter-tabs";
import { uiText } from "@/i18n/interface";
import { lazy, Suspense, type ReactNode, type ComponentType } from "react";
import type { ToolConnectionCredentialSource } from "@paperclipai/shared";
import { Link, Navigate, Outlet, Route, Routes, useActiveCompanyPrefix, useLocation, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { ConferenceRoomChatGate } from "./components/ConferenceRoomChatGate";
import { PipelinesExperimentalGate } from "./components/PipelinesExperimentalGate";
import { CasesExperimentalGate } from "./components/CasesExperimentalGate";
import { StatusCardsExperimentalGate } from "./components/StatusCardsExperimentalGate";
import { CloudManagedPageGate } from "./components/CloudManagedPageGate";
import { HiddenSettingsPageGate } from "./components/HiddenSettingsPageGate";
import { IsolatedWorkspacesRouteGate } from "./components/IsolatedWorkspacesRouteGate";
import {
  ExecutionWorkspaceCompanyGate,
  UnprefixedExecutionWorkspaceRedirect,
} from "./components/UnprefixedExecutionWorkspaceRedirect";
import { useHiddenSettings } from "./hooks/useHiddenSettings";
import { OnboardingWizardVariant } from "./components/OnboardingWizardVariant";
import { CloudAccessGate } from "./components/CloudAccessGate";
import { PaperclipLoading } from "./components/AnimatedPaperclipIcon";
import { ChatConnectorsExperimentalGate } from "./components/ChatConnectorsExperimentalGate";
import { useChatConnectorsEnabled } from "./hooks/useChatConnectorsEnabled";
import { InitialPasswordChange } from "./pages/InitialPasswordChange";
import { AuthPage } from "./pages/Auth";
import { NotFoundPage } from "./pages/NotFound";
import { useCompany } from "./context/CompanyContext";
import { useDialogActions, useDialogState } from "./context/DialogContext";
import {
  shouldRedirectCompanylessRouteToOnboarding,
} from "./lib/onboarding-route";
import { filterHiddenInstanceSettingsPath, normalizeRememberedInstanceSettingsPath } from "./lib/instance-settings";
import { useCloudInstance } from "./hooks/useCloudInstance";
import { useStreamlinedUiEnabled } from "./hooks/useStreamlinedUiEnabled";
import { cloudStackCreateUrl } from "./lib/cloudLinks";
import { navigateTopLevel } from "@/lib/browserNavigation";

// Keep heavyweight detail, configuration and lab surfaces out of the entry bundle.
// Each boundary retains the surrounding layout while its route loads.
function routeWithSuspense<Props extends object>(Page: ComponentType<Props>) {
  return function DeferredRoute(props: Props) {
    return <Suspense fallback={<PaperclipLoading />}><Page {...props} /></Suspense>;
  };
}

const IssueDetail = routeWithSuspense(lazy(() => import("./pages/IssueDetail").then(m => ({ default: m.IssueDetail }))));
const AgentChat = routeWithSuspense(lazy(() => import("./pages/AgentChat").then(m => ({ default: m.AgentChat }))));
const AgentDetail = routeWithSuspense(lazy(() => import("./pages/AgentDetail").then(m => ({ default: m.AgentDetail }))));
const DesignGuide = routeWithSuspense(lazy(() => import("./pages/DesignGuide").then(m => ({ default: m.DesignGuide }))));
const SkillStudio = routeWithSuspense(lazy(() => import("./pages/SkillStudio").then(m => ({ default: m.SkillStudio }))));
const TaskChatLab = routeWithSuspense(lazy(() => import("./pages/TaskChatLab").then(m => ({ default: m.TaskChatLab }))));
const IssueChatLongThreadPerf = routeWithSuspense(lazy(() => import("./pages/IssueChatLongThreadPerf").then(m => ({ default: m.IssueChatLongThreadPerf }))));
const BootstrapSetupUxLab = routeWithSuspense(lazy(() => import("./pages/BootstrapSetupUxLab").then(m => ({ default: m.BootstrapSetupUxLab }))));
const ResponsibleUserDenialUxLab = routeWithSuspense(lazy(() => import("./pages/ResponsibleUserDenialUxLab").then(m => ({ default: m.ResponsibleUserDenialUxLab }))));
const CrossIssueCollaborationUxLab = routeWithSuspense(lazy(() => import("./pages/CrossIssueCollaborationUxLab").then(m => ({ default: m.CrossIssueCollaborationUxLab }))));
const CompanyImport = routeWithSuspense(lazy(() => import("./pages/CompanyImport").then(m => ({ default: m.CompanyImport }))));
const CompanySettings = routeWithSuspense(lazy(() => import("./pages/CompanySettings").then(m => ({ default: m.CompanySettings }))));
const CompanyEnvironments = routeWithSuspense(lazy(() => import("./pages/CompanyEnvironments").then(m => ({ default: m.CompanyEnvironments }))));
const CompanySettingsPluginPage = routeWithSuspense(lazy(() => import("./pages/CompanySettingsPluginPage").then(m => ({ default: m.CompanySettingsPluginPage }))));
const NewAgent = routeWithSuspense(lazy(() => import("./pages/NewAgent").then(m => ({ default: m.NewAgent }))));
const ProjectDetail = routeWithSuspense(lazy(() => import("./pages/ProjectDetail").then(m => ({ default: m.ProjectDetail }))));
const ProjectWorkspaceDetail = routeWithSuspense(lazy(() => import("./pages/ProjectWorkspaceDetail").then(m => ({ default: m.ProjectWorkspaceDetail }))));
const ExecutionWorkspaceDetail = routeWithSuspense(lazy(() => import("./pages/ExecutionWorkspaceDetail").then(m => ({ default: m.ExecutionWorkspaceDetail }))));
const ProfileWizardRoute = routeWithSuspense(lazy(() => import("./pages/tools/profiles/ProfileWizardRoute").then(m => ({ default: m.ProfileWizardRoute }))));
const ProfileDetailRoute = routeWithSuspense(lazy(() => import("./pages/tools/profiles/ProfileDetailRoute").then(m => ({ default: m.ProfileDetailRoute }))));
const CompanySkills = routeWithSuspense(lazy(() => import("./pages/CompanySkills").then(m => ({ default: m.CompanySkills }))));
const Secrets = routeWithSuspense(lazy(() => import("./pages/Secrets").then(m => ({ default: m.Secrets }))));
const AppDetail = routeWithSuspense(lazy(() => import("./pages/apps/AppDetail").then(m => ({ default: m.AppDetail }))));
const GatewaysList = routeWithSuspense(lazy(() => import("./pages/apps/gateways/GatewaysList").then(m => ({ default: m.GatewaysList }))));
const GatewayDetail = routeWithSuspense(lazy(() => import("./pages/apps/gateways/GatewayDetail").then(m => ({ default: m.GatewayDetail }))));
const ChatEndpointSetup = routeWithSuspense(lazy(() => import("./pages/apps/chat/ChatEndpointSetup").then(m => ({ default: m.ChatEndpointSetup }))));
const ChatEndpointDetail = routeWithSuspense(lazy(() => import("./pages/apps/chat/ChatEndpointDetail").then(m => ({ default: m.ChatEndpointDetail }))));

const ManagementCenter = routeWithSuspense(lazy(() => import("./pages/ManagementCenter").then(m => ({ default: m.ManagementCenter }))));
const AnalysisExecutions = routeWithSuspense(lazy(() => import("./pages/AnalysisExecutions").then(m => ({ default: m.AnalysisExecutionsRedirect }))));
const DeliveryIntake = routeWithSuspense(lazy(() => import("./pages/DeliveryEntries").then(m => ({ default: m.DeliveryEntries }))));
const DeliveryWorkbench = routeWithSuspense(lazy(() => import("./pages/DeliveryWorkbench").then(m => ({ default: m.DeliveryWorkbench }))));
const DeliveryDashboard = routeWithSuspense(lazy(() => import("./pages/DeliveryDashboard").then(m => ({ default: m.DeliveryDashboard }))));
const JiraIntake = routeWithSuspense(lazy(() => import("./pages/JiraIntake").then(m => ({ default: m.JiraIntake }))));
const ExecutionRecords = routeWithSuspense(lazy(() => import("./pages/ExecutionRecords").then(m => ({ default: m.ExecutionRecords }))));
const Cases = routeWithSuspense(lazy(() => import("./pages/Cases").then(m => ({ default: m.Cases }))));
const CaseDetail = routeWithSuspense(lazy(() => import("./pages/CaseDetail").then(m => ({ default: m.CaseDetail }))));
const Seats = routeWithSuspense(lazy(() => import("./pages/Seats").then(m => ({ default: m.Seats }))));
const Help = routeWithSuspense(lazy(() => import("./pages/Help").then(m => ({ default: m.Help }))));
const Dashboard = routeWithSuspense(lazy(() => import("./pages/Workbench").then(m => ({ default: m.Workbench }))));
const DashboardLive = routeWithSuspense(lazy(() => import("./pages/DashboardLive").then(m => ({ default: m.DashboardLive }))));
const Timeline = routeWithSuspense(lazy(() => import("./pages/Timeline").then(m => ({ default: m.Timeline }))));
const Companies = routeWithSuspense(lazy(() => import("./pages/Companies").then(m => ({ default: m.Companies }))));
const Agents = routeWithSuspense(lazy(() => import("./pages/Agents").then(m => ({ default: m.Agents }))));
const Projects = routeWithSuspense(lazy(() => import("./pages/Projects").then(m => ({ default: m.Projects }))));
const Workspaces = routeWithSuspense(lazy(() => import("./pages/Workspaces").then(m => ({ default: m.Workspaces }))));
const Issues = routeWithSuspense(lazy(() => import("./pages/Issues").then(m => ({ default: m.Issues }))));
const Search = routeWithSuspense(lazy(() => import("./pages/Search").then(m => ({ default: m.Search }))));
const Routines = routeWithSuspense(lazy(() => import("./pages/Routines").then(m => ({ default: m.Routines }))));
const Learnings = routeWithSuspense(lazy(() => import("./pages/Pipelines").then(m => ({ default: m.Learnings }))));
const PipelineItemDetail = routeWithSuspense(lazy(() => import("./pages/Pipelines").then(m => ({ default: m.PipelineItemDetail }))));
const PipelineItemLegacyRedirect = routeWithSuspense(lazy(() => import("./pages/Pipelines").then(m => ({ default: m.PipelineItemLegacyRedirect }))));
const Pipelines = routeWithSuspense(lazy(() => import("./pages/Pipelines").then(m => ({ default: m.Pipelines }))));
const ReviewQueue = routeWithSuspense(lazy(() => import("./pages/Pipelines").then(m => ({ default: m.ReviewQueue }))));
const PipelineSettings = routeWithSuspense(lazy(() => import("./pages/PipelineSettings").then(m => ({ default: m.PipelineSettings }))));
const StatusCards = routeWithSuspense(lazy(() => import("./pages/StatusCards").then(m => ({ default: m.StatusCards }))));
const RoutineDetail = routeWithSuspense(lazy(() => import("./pages/RoutineDetail").then(m => ({ default: m.RoutineDetail }))));
const UserProfile = routeWithSuspense(lazy(() => import("./pages/UserProfile").then(m => ({ default: m.UserProfile }))));
const Goals = routeWithSuspense(lazy(() => import("./pages/Goals").then(m => ({ default: m.Goals }))));
const Artifacts = routeWithSuspense(lazy(() => import("./pages/Artifacts").then(m => ({ default: m.Artifacts }))));
const GoalDetail = routeWithSuspense(lazy(() => import("./pages/GoalDetail").then(m => ({ default: m.GoalDetail }))));
const Approvals = routeWithSuspense(lazy(() => import("./pages/Approvals").then(m => ({ default: m.Approvals }))));
const ApprovalDetail = routeWithSuspense(lazy(() => import("./pages/ApprovalDetail").then(m => ({ default: m.ApprovalDetail }))));
const CompanyActivity = routeWithSuspense(lazy(() => import("./pages/audit/CompanyActivity").then(m => ({ default: m.CompanyActivity }))));
const AuditHub = routeWithSuspense(lazy(() => import("./pages/audit/AuditHub").then(m => ({ default: m.AuditHub }))));
const Inbox = routeWithSuspense(lazy(() => import("./pages/Inbox").then(m => ({ default: m.Inbox }))));
const WhatNeedsMe = routeWithSuspense(lazy(() => import("./pages/WhatNeedsMe").then(m => ({ default: m.WhatNeedsMe }))));
const DecisionQueuePage = routeWithSuspense(lazy(() => import("./pages/DecisionQueuePage").then(m => ({ default: m.DecisionQueuePage }))));
const BoardChat = routeWithSuspense(lazy(() => import("./pages/BoardChat").then(m => ({ default: m.BoardChat }))));
const CompanyAccess = routeWithSuspense(lazy(() => import("./pages/CompanyAccess").then(m => ({ default: m.CompanyAccess }))));
const CompanyAccessLegacyRoute = routeWithSuspense(lazy(() => import("./pages/CompanyAccess").then(m => ({ default: m.CompanyAccessLegacyRoute }))));
const DeliveryTemplates = routeWithSuspense(lazy(() => import("./pages/DeliveryTemplates").then(m => ({ default: m.DeliveryTemplates }))));
const PersonnelFederation = routeWithSuspense(lazy(() => import("./pages/PersonnelFederation").then(m => ({ default: m.PersonnelFederation }))));
const AdvancedToolsRoute = routeWithSuspense(lazy(() => import("./pages/tools/AdvancedToolsRoute").then(m => ({ default: m.AdvancedToolsRoute }))));
const Browse = routeWithSuspense(lazy(() => import("./pages/apps/Browse").then(m => ({ default: m.Browse }))));
const AppsConnect = routeWithSuspense<NonNullable<Parameters<typeof import("./pages/apps/AppsConnect").AppsConnect>[0]>>(lazy(() => import("./pages/apps/AppsConnect").then(m => ({ default: m.AppsConnect }))));
const ChatIdentityConfirm = routeWithSuspense(lazy(() => import("./pages/apps/chat/ChatIdentityConfirm").then(m => ({ default: m.ChatIdentityConfirm }))));

const AppsReview = routeWithSuspense(lazy(() => import("./pages/apps/AppsReview").then(m => ({ default: m.AppsReview }))));
const AppNotConnected = routeWithSuspense(lazy(() => import("./pages/apps/AppNotConnected").then(m => ({ default: m.AppNotConnected }))));
const PaperclipCloudOAuthHandoffPage = routeWithSuspense(lazy(() => import("./pages/apps/PaperclipCloudOAuthHandoff").then(m => ({ default: m.PaperclipCloudOAuthHandoffPage }))));
const InstanceExperimentalSettings = routeWithSuspense(lazy(() => import("./pages/InstanceExperimentalSettings").then(m => ({ default: m.InstanceExperimentalSettings }))));
const InstanceAccess = routeWithSuspense(lazy(() => import("./pages/InstanceAccess").then(m => ({ default: m.InstanceAccess }))));
const ProfileSettings = routeWithSuspense(lazy(() => import("./pages/ProfileSettings").then(m => ({ default: m.ProfileSettings }))));
const PluginManager = routeWithSuspense(lazy(() => import("./pages/PluginManager").then(m => ({ default: m.PluginManager }))));
const PluginSettings = routeWithSuspense(lazy(() => import("./pages/PluginSettings").then(m => ({ default: m.PluginSettings }))));
const AdapterManager = routeWithSuspense(lazy(() => import("./pages/AdapterManager").then(m => ({ default: m.AdapterManager }))));
const PluginPage = routeWithSuspense(lazy(() => import("./pages/PluginPage").then(m => ({ default: m.PluginPage }))));
const BoardClaimPage = routeWithSuspense(lazy(() => import("./pages/BoardClaim").then(m => ({ default: m.BoardClaimPage }))));
const CliAuthPage = routeWithSuspense(lazy(() => import("./pages/CliAuth").then(m => ({ default: m.CliAuthPage }))));
const InviteLandingPage = routeWithSuspense(lazy(() => import("./pages/InviteLanding").then(m => ({ default: m.InviteLandingPage }))));
const JoinRequestQueue = routeWithSuspense(lazy(() => import("./pages/JoinRequestQueue").then(m => ({ default: m.JoinRequestQueue }))));
const Layout = routeWithSuspense(lazy(() => import("./components/Layout").then(m => ({ default: m.Layout }))));
const ProductionLayout = routeWithSuspense(lazy(() => import("./components/Layout.production").then(m => ({ default: m.Layout }))));
const FocusedInbox = routeWithSuspense(lazy(() => import("./components/FocusedInbox").then(m => ({ default: m.FocusedInbox }))));

const CompanyExport = lazy(() =>
  import("./pages/CompanyExport").then((module) => ({ default: module.CompanyExport })),
);

const ProductionAgents = lazy(() =>
  import("./pages/Agents.production").then((module) => ({ default: module.Agents })),
);
const ProductionRoutines = lazy(() =>
  import("./pages/Routines.production").then((module) => ({ default: module.Routines })),
);
const ProductionRoutineDetail = lazy(() =>
  import("./pages/RoutineDetail.production").then((module) => ({ default: module.RoutineDetail })),
);
const ProductionCompanySkills = lazy(() =>
  import("./pages/CompanySkills.production").then((module) => ({ default: module.CompanySkills })),
);
const ProductionCompanyActivity = lazy(() =>
  import("./pages/audit/CompanyActivity.production").then((module) => ({ default: module.CompanyActivity })),
);
const ProductionCosts = lazy(() =>
  import("./pages/Costs.production").then((module) => ({ default: module.Costs })),
);
const ProductionOrgChart = lazy(() =>
  import("./pages/OrgChart.production").then((module) => ({ default: module.OrgChart })),
);

function ProductionSurface({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PaperclipLoading />}>{children}</Suspense>;
}

const OrganizationSetup = routeWithSuspense(lazy(() => import("./pages/OrganizationSetup").then(m => ({ default: m.OrganizationSetup }))));

function boardRoutes(streamlinedUiEnabled: boolean) {
  return (
    <>
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="dashboard" element={<Dashboard />} />
      <Route path="management" element={<ManagementCenter />} />
      <Route path="setup" element={<OrganizationSetup />} />
      <Route path="delivery" element={<DeliveryIntake />} />
      <Route path="delivery-chain" element={<DeliveryTemplates />} />
      <Route path="analysis-executions" element={<AnalysisExecutions />} />
      <Route path="delivery-workbench" element={<DeliveryWorkbench />} />
      <Route path="delivery-dashboard" element={<DeliveryDashboard />} />
      <Route path="jira-intake" element={<JiraIntake />} />
      <Route path="runs" element={<ExecutionRecords />} />
      <Route path="help" element={<Help />} />
      <Route path="seats" element={<Seats />} />
      <Route path="dashboard/live" element={<DashboardLive />} />
      <Route
        path="timeline"
        element={streamlinedUiEnabled ? <AuditCompatibilityRedirect to="/activity/timeline" /> : <Timeline />}
      />
      <Route path="onboarding" element={<OnboardingRoutePage />} />
      <Route path="companies" element={<Companies />} />
      <Route path="company/settings" element={<CompanySettings />} />
      <Route path="company/settings/personnel" element={<Navigate to="/company/settings/instance/personnel" replace />} />
      <Route path="company/settings/delivery" element={<DeliveryTemplates />} />
      <Route path="company/settings/instance/personnel" element={<PersonnelFederation />} />
      <Route path="company/settings/environments" element={<Navigate to="/company/settings/instance/environments" replace />} />
      <Route path="company/settings/cloud-upstream" element={<Navigate to="/company/export" replace />} />
      <Route element={<HiddenSettingsPageGate pageKey="company.members" />}>
        <Route path="company/settings/members" element={<CompanyAccess />} />
        <Route path="company/settings/access" element={<CompanyAccessLegacyRoute />} />
      </Route>
      {/* Invites moved into the Members page; the old URL redirects (and stays
          gated so a hidden Invites surface never round-trips through it). */}
      <Route element={<HiddenSettingsPageGate pageKey="company.invites" />}>
        <Route
          path="company/settings/invites"
          element={<Navigate to="/company/settings/members?tab=invites" replace />}
        />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="company.export" />}>
        <Route
          path="company/export/*"
          element={(
            <Suspense fallback={<PaperclipLoading />}>
              <CompanyExport />
            </Suspense>
          )}
        />
      </Route>
      <Route element={<CloudManagedPageGate />}>
        <Route element={<HiddenSettingsPageGate pageKey="company.import" />}>
          <Route path="company/import" element={<CompanyImport />} />
        </Route>
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="company.secrets" />}>
        <Route path="company/settings/secrets" element={<Secrets />} />
      </Route>
      <Route path="company/settings/tools" element={<LegacyToolsSettingsRedirect />} />
      <Route path="company/settings/tools/:tab" element={<LegacyToolsSettingsRedirect />} />
      <Route path="tools" element={<LegacyToolsRedirect />} />
      <Route path="tools/:tab" element={<LegacyToolsRedirect />} />
      <Route path="apps" element={<Browse />} />
      <Route path="apps/browse" element={<Navigate to="/apps" replace />} />
      <Route path="apps/connections" element={<Navigate to="/apps" replace />} />
      <Route path="apps/byo" element={<AppsConnect byoOnly />} />
      <Route
        path="apps/vercel-connect"
        element={<AppsConnectEntryRoute credentialSource="vercel_connect" />}
      />
      <Route path="apps/connect" element={<AppsConnectEntryRoute />} />
      <Route path="apps/chat/connect" element={
        <ChatConnectorsExperimentalGate><ChatEndpointSetup /></ChatConnectorsExperimentalGate>
      } />
      <Route path="apps/chat/:endpointId" element={
        <ChatConnectorsExperimentalGate><Navigate to="settings" replace /></ChatConnectorsExperimentalGate>
      } />
      <Route path="apps/chat/:endpointId/:tab" element={
        <ChatConnectorsExperimentalGate><ChatEndpointDetail /></ChatConnectorsExperimentalGate>
      } />
      <Route path="apps/connect/:appKey" element={<Navigate to="/apps" replace />} />
      <Route path="apps/connect/:appKey/:stage" element={<Navigate to="/apps" replace />} />
      <Route path="apps/review" element={<AppsReview />} />
      {/* Connector health is inline on the Apps landing page; keep legacy links working. */}
      <Route path="apps/attention" element={<Navigate to="/apps" replace />} />
      <Route path="apps/gateways" element={<GatewaysList />} />
      <Route path="apps/gateways/:gatewayId" element={<Navigate to="overview" replace />} />
      <Route path="apps/gateways/:gatewayId/:tab" element={<GatewayDetail />} />
      <Route path="apps/advanced" element={<AdvancedToolsRoute />} />
      <Route path="apps/advanced/gateways" element={<GatewaysList />} />
      <Route path="apps/advanced/profiles/new" element={<ProfileWizardRoute mode="new" />} />
      <Route path="apps/advanced/profiles/:profileId/edit" element={<ProfileWizardRoute mode="edit" />} />
      <Route path="apps/advanced/profiles/:profileId" element={<ProfileDetailRoute />} />
      <Route path="apps/advanced/audit" element={<Navigate to="/apps" replace />} />
      <Route path="apps/advanced/run-your-own" element={<Navigate to="/apps" replace />} />
      <Route path="apps/advanced/:tab" element={<AdvancedToolsRoute />} />
      <Route path="apps/app/:applicationId" element={<AppNotConnected />} />
      <Route path="apps/app/:applicationId/:tab" element={<AppNotConnected />} />
      <Route path="apps/:connectionId" element={<Navigate to="permissions" replace />} />
      <Route path="apps/:connectionId/:tab" element={<AppDetail />} />
      <Route path="company/settings/instance" element={<Navigate to="/company/settings" replace />} />
      <Route element={<HiddenSettingsPageGate pageKey="instance.profile" />}>
        <Route path="company/settings/instance/profile" element={<ProfileSettings />} />
      </Route>
      <Route path="company/settings/instance/general" element={<Navigate to="/company/settings" replace />} />
      <Route path="company/settings/instance/heartbeats" element={<Navigate to="/company/settings" replace />} />
      <Route element={<HiddenSettingsPageGate pageKey="instance.environments" />}>
        <Route path="company/settings/instance/environments" element={<CompanyEnvironments />} />
        <Route path="company/settings/instance/environments/new" element={<CompanyEnvironments mode="create" />} />
        <Route path="company/settings/instance/environments/:environmentId/edit" element={<CompanyEnvironments mode="edit" />} />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="instance.access" />}>
        <Route path="company/settings/instance/access" element={<InstanceAccess />} />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="instance.experimental" />}>
        <Route path="company/settings/instance/experimental" element={<InstanceExperimentalSettings />} />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="instance.plugins" />}>
        <Route path="company/settings/instance/plugins" element={<PluginManager />} />
        <Route path="company/settings/instance/plugins/:pluginId" element={<PluginSettings />} />
      </Route>
      <Route element={<HiddenSettingsPageGate pageKey="instance.adapters" />}>
        <Route path="company/settings/instance/adapters" element={<AdapterManager />} />
      </Route>
      <Route path="company/settings/:settingsRoutePath/*" element={<CompanySettingsPluginPage />} />
      <Route path="skills/studio" element={<SkillStudio />} />
      <Route path="skills/studio/new" element={<SkillStudio />} />
      <Route path="skills/studio/:skillId" element={<SkillStudio />} />
      <Route path="skills/:skillId/studio" element={<LegacySkillStudioRedirect />} />
      <Route
        path="skills/*"
        element={streamlinedUiEnabled ? <CompanySkills /> : <ProductionSurface><ProductionCompanySkills /></ProductionSurface>}
      />
      <Route path="settings" element={<LegacySettingsRedirect />} />
      <Route path="settings/*" element={<LegacySettingsRedirect />} />
      <Route path="plugins/:pluginId" element={<PluginPage />} />
      <Route
        path="org"
        element={streamlinedUiEnabled ? <Navigate to="/agents/all" replace /> : <ProductionSurface><ProductionOrgChart /></ProductionSurface>}
      />
      <Route path="agents" element={<Navigate to="/agents/all" replace />} />
      {AGENT_FILTER_TABS.map((tab) => (
        <Route
          key={tab}
          path={`agents/${tab}`}
          element={streamlinedUiEnabled ? <Agents /> : <ProductionSurface><ProductionAgents /></ProductionSurface>}
        />
      ))}
      <Route path="agents/new" element={<NewAgent />} />
      <Route path="agents/:agentId" element={<AgentDetail />} />
      <Route path="agents/:agentId/:tab" element={<AgentDetail />} />
      <Route path="agents/:agentId/runs/:runId" element={<AgentDetail />} />
      <Route path="projects" element={<Projects />} />
      <Route path="projects/:projectId" element={<ProjectDetail />} />
      <Route path="projects/:projectId/overview" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues/:filter" element={<ProjectDetail />} />
      <Route element={<IsolatedWorkspacesRouteGate />}>
        <Route path="projects/:projectId/workspaces/:workspaceId" element={<ProjectWorkspaceDetail />} />
      </Route>
      <Route path="projects/:projectId/workspaces" element={<ProjectDetail />} />
      <Route path="projects/:projectId/configuration" element={<ProjectDetail />} />
      <Route path="projects/:projectId/budget" element={<ProjectDetail />} />
      <Route element={<IsolatedWorkspacesRouteGate />}>
        <Route path="workspaces" element={<Workspaces />} />
      </Route>
      <Route path="issues" element={<Issues />} />
      <Route path="tasks" element={<Navigate to="/issues" replace />} />
      <Route path="search" element={<Search />} />
      <Route path="issues/all" element={<Navigate to="/issues" replace />} />
      <Route path="issues/active" element={<Navigate to="/issues" replace />} />
      <Route path="issues/backlog" element={<Navigate to="/issues" replace />} />
      <Route path="issues/done" element={<Navigate to="/issues" replace />} />
      <Route path="issues/recent" element={<Navigate to="/issues" replace />} />
      <Route path="chats/:agentRef" element={<AgentChat />} />
      <Route path="issues/:issueId" element={<IssueDetail />} />
      {import.meta.env.DEV ? (
        <Route path="tests/perf/long-thread" element={<IssueChatLongThreadPerf />} />
      ) : null}
      <Route path="routines" element={streamlinedUiEnabled ? <Routines /> : <ProductionSurface><ProductionRoutines /></ProductionSurface>} />
      <Route
        path="cases"
        element={<CasesExperimentalGate><Cases /></CasesExperimentalGate>}
      />
      <Route
        path="cases/:caseIdentifier"
        element={<CasesExperimentalGate><CaseDetail /></CasesExperimentalGate>}
      />
      <Route
        path="status"
        element={<StatusCardsExperimentalGate><StatusCards /></StatusCardsExperimentalGate>}
      />
      <Route
        path="status/:cardId"
        element={<StatusCardsExperimentalGate><StatusCards /></StatusCardsExperimentalGate>}
      />
      {/* Back-compat: the board lived at /status-cards before PAP-15223. */}
      <Route path="status-cards" element={<StatusCardsLegacyRedirect />} />
      <Route path="status-cards/:cardId" element={<StatusCardsLegacyRedirect />} />
      <Route
        path="review-queue"
        element={<PipelinesExperimentalGate><ReviewQueue /></PipelinesExperimentalGate>}
      />
      <Route
        path="learnings"
        element={<PipelinesExperimentalGate><Learnings /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines"
        element={<PipelinesExperimentalGate><Pipelines /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId"
        element={<PipelinesExperimentalGate><Pipelines /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/add"
        element={<PipelinesExperimentalGate><Pipelines /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/settings"
        element={<PipelinesExperimentalGate><PipelineSettings /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/items/:caseId"
        element={<PipelinesExperimentalGate><PipelineItemDetail /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/cases/:caseId"
        element={<PipelinesExperimentalGate><PipelineItemLegacyRedirect /></PipelinesExperimentalGate>}
      />
      <Route path="routines/:routineId" element={streamlinedUiEnabled ? <RoutineDetail /> : <ProductionSurface><ProductionRoutineDetail /></ProductionSurface>} />
      <Route path="routines/:routineId/:section" element={streamlinedUiEnabled ? <RoutineDetail /> : <ProductionSurface><ProductionRoutineDetail /></ProductionSurface>} />
      <Route element={<IsolatedWorkspacesRouteGate />}>
        <Route element={<ExecutionWorkspaceCompanyGate />}>
          <Route path="execution-workspaces/:workspaceId" element={<ExecutionWorkspaceDetail />} />
          <Route path="execution-workspaces/:workspaceId/services" element={<ExecutionWorkspaceDetail />} />
          <Route path="execution-workspaces/:workspaceId/configuration" element={<ExecutionWorkspaceDetail />} />
          <Route path="execution-workspaces/:workspaceId/runtime-logs" element={<ExecutionWorkspaceDetail />} />
          <Route path="execution-workspaces/:workspaceId/issues" element={<ExecutionWorkspaceDetail />} />
          <Route path="execution-workspaces/:workspaceId/routines" element={<ExecutionWorkspaceDetail />} />
        </Route>
      </Route>
      <Route path="goals" element={<Goals />} />
      <Route path="goals/:goalId" element={<GoalDetail />} />
      <Route path="artifacts" element={<Artifacts />} />
      <Route path="approvals" element={<Navigate to="/approvals/pending" replace />} />
      <Route path="approvals/pending" element={<Approvals />} />
      <Route path="approvals/all" element={<Approvals />} />
      <Route path="approvals/:approvalId" element={<ApprovalDetail />} />
      <Route path="activity" element={streamlinedUiEnabled ? <CompanyActivity /> : <ProductionSurface><ProductionCompanyActivity /></ProductionSurface>} />
      {streamlinedUiEnabled ? (
        <>
          <Route path="activity/runs" element={<AuditHub section="runs" />} />
          <Route path="activity/costs" element={<AuditHub section="costs" />} />
          <Route path="activity/budgets" element={<AuditHub section="budgets" />} />
          <Route path="activity/timeline" element={<AuditHub section="timeline" />} />
          <Route path="audit" element={<AuditCompatibilityRedirect to="/activity" forceAgentMode />} />
          <Route path="audit/activity" element={<AuditCompatibilityRedirect to="/activity" />} />
          <Route path="audit/runs" element={<AuditCompatibilityRedirect to="/activity/runs" />} />
          <Route path="audit/costs" element={<AuditCompatibilityRedirect to="/activity/costs" />} />
          <Route path="audit/budgets" element={<AuditCompatibilityRedirect to="/activity/budgets" />} />
          <Route path="audit/timeline" element={<AuditCompatibilityRedirect to="/activity/timeline" />} />
          <Route path="runs" element={<AuditCompatibilityRedirect to="/activity/runs" />} />
          <Route path="costs" element={<AuditCompatibilityRedirect to="/activity/costs" />} />
          <Route path="budgets" element={<AuditCompatibilityRedirect to="/activity/budgets" />} />
        </>
      ) : (
        <>
          <Route path="costs" element={<ProductionSurface><ProductionCosts /></ProductionSurface>} />
          <Route path="audit" element={<Navigate to="/activity?mode=agents" replace />} />
        </>
      )}
      {/* Conference Room Chat surfaces (PAP-136/PAP-137): routes stay
          registered but redirect to the company home while the experimental
          flag is off. The board-level `artifacts` mount below is the new
          conference-room one; the master-level mount above it still serves
          `/artifacts` in both modes. */}
      <Route element={<ConferenceRoomChatGate />}>
        <Route path="board-chat" element={<BoardChat />} />
        <Route path="artifacts" element={<Artifacts />} />
      </Route>
      {/* Task chat dev harness — dev builds only. */}
      {import.meta.env.DEV ? (
        <Route path="dev/task-chat-lab" element={<TaskChatLab />} />
      ) : null}
      <Route path="decisions" element={<WhatNeedsMe />} />
      <Route path="decisions/queues/:key" element={<DecisionQueuePage />} />
      <Route path="inbox" element={<InboxRootRedirect />} />
      <Route path="inbox/mine" element={<FocusedInbox />} />
      <Route path="inbox/recent" element={<FocusedInbox />} />
      <Route path="inbox/unread" element={<FocusedInbox />} />
      <Route path="inbox/blocked" element={<FocusedInbox />} />
      <Route path="inbox/all" element={<FocusedInbox />} />
      <Route path="inbox/requests" element={<JoinRequestQueue />} />
      <Route path="inbox/new" element={<Navigate to="/inbox/mine" replace />} />
      <Route path="u/:userSlug" element={<UserProfile />} />
      <Route path="design-guide" element={<DesignGuide />} />
      <Route path="instance/settings/adapters" element={<AdapterManager />} />
      <Route path=":pluginRoutePath/*" element={<PluginPage />} />
      <Route path="*" element={<NotFoundPage scope="board" />} />
    </>
  );
}

function AppsConnectEntryRoute({
  credentialSource = "paperclip_vault",
}: {
  credentialSource?: ToolConnectionCredentialSource;
} = {}) {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const { enabled: chatConnectorsEnabled } = useChatConnectorsEnabled();
  return canEnterAppsConnect(searchParams, { chatConnectorsEnabled })
    ? <AppsConnect credentialSource={credentialSource} />
    : <Navigate to="/apps" replace />;
}

function InboxRootRedirect() {
  return <FocusedInbox />;
}

function LegacySkillStudioRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();
  const { companyPrefix, skillId } = useParams<{ companyPrefix?: string; skillId?: string }>();

  if (loading) return null;

  const targetCompany =
    (companyPrefix
      ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase())
      : null) ??
    selectedCompany ??
    companies[0] ??
    null;

  if (!targetCompany || !skillId) {
    return <Navigate to="/skills/studio" replace />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}/skills/studio/${encodeURIComponent(skillId)}${location.search}${location.hash}`}
      replace
    />
  );
}

function LegacySettingsRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const { hidden: hiddenSettings } = useHiddenSettings();

  if (loading) {
    return <PaperclipLoading />;
  }

  const targetCompany =
    (companyPrefix
      ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase())
      : null) ??
    selectedCompany ??
    companies[0] ??
    null;

  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  const normalizedPath = filterHiddenInstanceSettingsPath(
    normalizeRememberedInstanceSettingsPath(
      `${location.pathname}${location.search}${location.hash}`,
    ),
    hiddenSettings,
  );

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${normalizedPath}`}
      replace
    />
  );
}

function LegacyToolsSettingsRedirect() {
  const { tab } = useParams<{ tab?: string }>();
  return <Navigate to={legacyToolsRedirectTarget(tab)} replace />;
}

// The developer "Tools" surface moved under the Apps "Advanced setup" door
// (PAP-10862). `/tools` and `/tools/:tab` redirect to their new home.
function LegacyToolsRedirect() {
  const { tab } = useParams<{ tab?: string }>();
  return <Navigate to={legacyToolsRedirectTarget(tab)} replace />;
}

function legacyToolsRedirectTarget(tab?: string) {
  if (!tab) return "/apps/advanced/profiles";
  if (tab === "applications" || tab === "connections" || tab === "overview" || tab === "examples") return "/apps";
  if (tab === "runtime" || tab === "audit") return "/apps";
  if (tab === "policies") return "/apps/advanced/profiles";
  return `/apps/advanced/${tab}`;
}

export function OnboardingRoutePage() {
  const { companies, selectedCompany, loading } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { onboardingOpen } = useDialogState();
  const { isInstanceAdmin, loading: accessLoading } = useManagementAccess();
  const cloudInstance = useCloudInstance();
  const createStackUrl = cloudStackCreateUrl(cloudInstance?.cloudBaseUrl ?? null);
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const matchedCompany = companyPrefix ? companies.find(company => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase()) : null;
  if (loading || accessLoading) return <PaperclipLoading />;
  if (onboardingOpen) return null;
  if (matchedCompany) return <Navigate to={`/${matchedCompany.issuePrefix}/setup`} replace />;
  return <div className="mx-auto max-w-xl py-10"><div className="space-y-4 rounded-lg border border-border bg-card p-6">
    <h1 className="text-xl font-semibold">{companies.length ? "创建新组织" : "创建第一个组织"}</h1>
    <p className="text-sm text-muted-foreground">先建立组织，再按清单配置人员、项目仓库和研发电脑席位。无需先填写模型密钥或创建通用智能体。</p>
    <div className="flex flex-wrap gap-3">{companies.length > 0 && <Button asChild variant="outline"><Link to={`/${(selectedCompany ?? companies[0]!).issuePrefix}/companies`}>返回组织列表</Link></Button>}
    {cloudInstance ? createStackUrl ? <Button onClick={() => navigateTopLevel(createStackUrl)}>前往 Cloud 创建组织</Button> : <p className="text-sm text-muted-foreground">此实例的组织由 Cloud 管理，请从 Cloud 工作区创建。</p>
      : isInstanceAdmin ? <Button onClick={() => openOnboarding()}>创建组织</Button> : <p className="text-sm text-muted-foreground">创建组织需要实例管理员权限，请联系平台管理员。</p>}</div>
  </div></div>;
}

function CompanyRootRedirect() {
  const { companies, selectedCompany, loading } = useCompany();
  const location = useLocation();

  if (loading) {
    return <PaperclipLoading />;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  return <Navigate to={`/${targetCompany.issuePrefix}/dashboard`} replace />;
}

function StatusCardsLegacyRedirect() {
  const { cardId } = useParams<{ cardId?: string }>();
  const prefix = useActiveCompanyPrefix();
  const base = prefix ? `/${prefix}` : "";
  return <Navigate to={`${base}/status${cardId ? `/${cardId}` : ""}`} replace />;
}

function AuditCompatibilityRedirect({
  to,
  forceAgentMode = false,
}: {
  to: string;
  forceAgentMode?: boolean;
}) {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  if (forceAgentMode) searchParams.set("mode", "agents");
  const search = searchParams.toString();
  return <Navigate to={`${to}${search ? `?${search}` : ""}${location.hash}`} replace />;
}

function UnprefixedBoardRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return <PaperclipLoading />;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}

function NoCompaniesStartPage() {
  const { openOnboarding } = useDialogActions();
  const { isInstanceAdmin, loading } = useManagementAccess();
  const cloudInstance = useCloudInstance();
  const createStackUrl = cloudStackCreateUrl(cloudInstance?.cloudBaseUrl ?? null);
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="space-y-4 rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">开始使用智研协同平台</h1>
        <p className="text-sm text-muted-foreground">先建立组织，再配置人员、项目仓库和研发电脑席位。创建组织无需模型密钥。</p>
        {loading ? <p className="text-sm text-muted-foreground">正在核验权限…</p>
          : cloudInstance ? createStackUrl
            ? <Button onClick={() => navigateTopLevel(createStackUrl)}>前往 Cloud 创建组织</Button>
            : <p className="text-sm text-muted-foreground">此实例的组织由 Cloud 管理，请从 Cloud 工作区创建。</p>
          : isInstanceAdmin ? <Button onClick={() => openOnboarding()}>创建组织</Button>
          : <p className="text-sm text-muted-foreground">当前没有可访问的组织，请联系平台管理员添加组织成员权限。</p>}
      </div>
    </div>
  );
}

export function App() {
  const { enabled: streamlinedUiEnabled, loaded: streamlinedUiLoaded } = useStreamlinedUiEnabled();

  return (
    <>
      <Routes>
        <Route path="oauth-handoff" element={<PaperclipCloudOAuthHandoffPage />} />
        <Route path="change-password" element={<InitialPasswordChange />} />
        <Route path="auth" element={<AuthPage />} />
        <Route path="board-claim/:token" element={<BoardClaimPage />} />
        <Route path="cli-auth/:id" element={<CliAuthPage />} />
        <Route path="invite/:token" element={<InviteLandingPage />} />
        <Route element={streamlinedUiLoaded ? <CloudAccessGate allowMembershipRequest /> : <PaperclipLoading />}>
          {/* The identity APIs enforce the chat rollout flag. Nonmembers cannot
              read experimental settings, but a private invitation may request membership. */}
          <Route path="chat-identity/confirm" element={<ChatIdentityConfirm />} />
        </Route>
        <Route path="tests/perf/long-thread" element={<IssueChatLongThreadPerf />} />
        <Route path="ux-lab/bootstrap-setup" element={<BootstrapSetupUxLab />} />
        <Route path="ux-lab/responsible-user-denial" element={<ResponsibleUserDenialUxLab />} />
        <Route path="ux-lab/cross-issue-collaboration" element={<CrossIssueCollaborationUxLab />} />

        <Route element={streamlinedUiLoaded ? <CloudAccessGate /> : <PaperclipLoading />}>
          <Route index element={<CompanyRootRedirect />} />
          <Route path="onboarding" element={<OnboardingRoutePage />} />
          <Route path="instance" element={<LegacySettingsRedirect />} />
          <Route path="instance/settings" element={<LegacySettingsRedirect />} />
          <Route path="instance/settings/*" element={<LegacySettingsRedirect />} />
          <Route path="help" element={<UnprefixedBoardRedirect />} />
          <Route path="management" element={<UnprefixedBoardRedirect />} />
          <Route path="delivery" element={<UnprefixedBoardRedirect />} />
          <Route path="delivery-dashboard" element={<UnprefixedBoardRedirect />} />
          <Route path="jira-intake" element={<UnprefixedBoardRedirect />} />
          <Route path="runs" element={<UnprefixedBoardRedirect />} />
          <Route path="seats" element={<UnprefixedBoardRedirect />} />
          <Route path="setup" element={<UnprefixedBoardRedirect />} />
          <Route path="companies" element={<UnprefixedBoardRedirect />} />
          <Route path="issues" element={<UnprefixedBoardRedirect />} />
          <Route path="tasks" element={<UnprefixedBoardRedirect />} />
          <Route path="issues/:issueId" element={<UnprefixedBoardRedirect />} />
          <Route path="routines" element={<UnprefixedBoardRedirect />} />
          <Route path="routines/:routineId" element={<UnprefixedBoardRedirect />} />
          <Route path="review-queue" element={<UnprefixedBoardRedirect />} />
          <Route path="learnings" element={<UnprefixedBoardRedirect />} />
          <Route path="cases" element={<UnprefixedBoardRedirect />} />
          <Route path="cases/:caseIdentifier" element={<UnprefixedBoardRedirect />} />
          <Route path="status" element={<UnprefixedBoardRedirect />} />
          <Route path="status/:cardId" element={<UnprefixedBoardRedirect />} />
          <Route path="status-cards" element={<UnprefixedBoardRedirect />} />
          <Route path="status-cards/:cardId" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/add" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/settings" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/items/:caseId" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/cases/:caseId" element={<UnprefixedBoardRedirect />} />
          <Route path="artifacts" element={<UnprefixedBoardRedirect />} />
          <Route path="audit" element={<UnprefixedBoardRedirect />} />
          {streamlinedUiEnabled ? (
            <>
              <Route path="audit/*" element={<UnprefixedBoardRedirect />} />
              <Route path="activity" element={<UnprefixedBoardRedirect />} />
              <Route path="activity/*" element={<UnprefixedBoardRedirect />} />
              <Route path="runs" element={<UnprefixedBoardRedirect />} />
              <Route path="costs" element={<UnprefixedBoardRedirect />} />
              <Route path="budgets" element={<UnprefixedBoardRedirect />} />
            </>
          ) : null}
          <Route path="decisions" element={<UnprefixedBoardRedirect />} />
          <Route path="u/:userSlug" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/studio" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/studio/new" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/studio/:skillId" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/:skillId/studio" element={<LegacySkillStudioRedirect />} />
          <Route path="skills/*" element={<UnprefixedBoardRedirect />} />
          <Route path="settings" element={<LegacySettingsRedirect />} />
          <Route path="settings/*" element={<LegacySettingsRedirect />} />
          <Route path="agents" element={<UnprefixedBoardRedirect />} />
          {AGENT_FILTER_TABS.map((tab) => (
            <Route key={tab} path={`agents/${tab}`} element={<UnprefixedBoardRedirect />} />
          ))}
          <Route path="agents/new" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/:tab" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/runs/:runId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/overview" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues/:filter" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/workspaces" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/workspaces/:workspaceId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="workspaces" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId" element={<UnprefixedExecutionWorkspaceRedirect />} />
          <Route path="execution-workspaces/:workspaceId/services" element={<UnprefixedExecutionWorkspaceRedirect />} />
          <Route path="execution-workspaces/:workspaceId/configuration" element={<UnprefixedExecutionWorkspaceRedirect />} />
          <Route path="execution-workspaces/:workspaceId/runtime-logs" element={<UnprefixedExecutionWorkspaceRedirect />} />
          <Route path="execution-workspaces/:workspaceId/issues" element={<UnprefixedExecutionWorkspaceRedirect />} />
          <Route path="execution-workspaces/:workspaceId/routines" element={<UnprefixedExecutionWorkspaceRedirect />} />
          <Route path=":companyPrefix" element={streamlinedUiEnabled ? <Layout /> : <ProductionLayout />}>
            {boardRoutes(streamlinedUiEnabled)}
          </Route>
          <Route path="*" element={<NotFoundPage scope="global" />} />
        </Route>
      </Routes>
      <OnboardingWizardVariant />
    </>
  );
}
