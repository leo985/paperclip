# Paperclip V1 Implementation Spec

Status: Implementation contract for first release (V1)
Date: 2026-04-28
Audience: Product, engineering, and agent-integration authors
Source inputs: `GOAL.md`, `PRODUCT.md`, `SPEC.md`, `DATABASE.md`, current monorepo code

## 1. Document Role

`SPEC.md` remains the long-horizon product spec.
This document is the concrete, build-ready V1 contract.
When there is a conflict, `SPEC-implementation.md` controls V1 behavior.

Seat service recovery: `harness service install` installs a per-seat, current-user timer on macOS, Windows and Linux, alongside the login service. Every 60 seconds it checks the local watcher lock and the timestamp recorded after a successful seat heartbeat. A stopped watcher or heartbeat at least 90 seconds old may invoke the existing `harness online` for that exact configuration; all attempts are spaced at least 300 seconds apart. Startup gets a 90-second grace period. Explicit offline intent and upgrade markers/locks suppress recovery, including offline intent arriving during recovery. Recovery must not force-restart processes, clear execution protection, alter dispatch/approval policy or claim that a stale heartbeat proves a task stopped. Repeated installs reuse matching timers and reject conflicting identity/path/schedule. Timers and their local status/action logs are isolated by seat configuration, contain no credentials, survive bridge replacement and use the current configured bridge after rollback. Sleep, shutdown, logout and network outages are outside the online guarantee. A supported watcher with stale heartbeats may consume a seat-bound recovery request at a loop boundary and exit cooperatively for its existing service supervisor to restart, only after obtaining upgrade/operator/delivery locks and positively verifying both server and local idle state, no pending commands or live wrappers, and no offline/upgrade intent. Unknown idle state preserves the process. Restarts are spaced at least 300 seconds apart and limited to three per hour. Credential-free diagnostics retain the failing stage, error type, HTTP status and consecutive failure count; doctor displays heartbeat age and recovery status. An unresponsive watcher is never force-killed.

Administrator-controlled client upgrades: publishing a package never authorizes an upgrade. A company/instance administrator explicitly targets one seat and the current published SHA-256 through the board. Durable, audited requests expire after 24 hours and can be cancelled before claim. An independently scheduled, seat-authenticated client claims only an authorized request, pins the installer digest, and retains local/server idle and execution-lock gates. Busy/offline seats wait; failed or unknown attempts are not blindly replayed. Successful installation remains verifying until a fresh target-version heartbeat arrives. Unsupported clients require one initial local upgrade. Publication manifests always disable legacy automatic-update policies.

## 2. V1 Outcomes

Paperclip V1 must provide a full control-plane loop for autonomous agents:

1. A human board creates a company and defines goals.
2. The board creates and manages agents in an org tree.
3. Agents receive and execute tasks via heartbeat invocations.
4. All work is tracked through tasks/comments with audit visibility.
5. Token/cost usage is reported and budget limits can stop work.
6. The board can intervene anywhere (pause agents/tasks, override decisions).
   An effective task or ancestor pause replaces the message composer with an
   amber Resume takeover. New board messages, including updates with comments,
   are rejected until the hold is released. Drafts survive pause and resume.

Success means one operator can run a small AI-native company end-to-end with clear visibility and control.

## 3. Explicit V1 Product Decisions

These decisions close open questions from `SPEC.md` for V1.

| Topic | V1 Decision |
|---|---|
| Tenancy | Single-tenant deployment, multi-company data model |
| Company model | Company is first-order; all business entities are company-scoped |
| Board | Single human board operator per deployment |
| Org graph | Strict tree (`reports_to` nullable root); no multi-manager reporting |
| Visibility | Company-scoped visibility: board + all in-company agents can see all work objects by default; public/private deployment flags affect external exposure only and do **not** imply project/issue privacy |
| Communication | Tasks + comments only (no separate chat system) |
| Task ownership | Single assignee; atomic checkout required for `in_progress` transition |
| Task watchdogs | A task watchdog is an explicitly configured, issue-subtree-scoped verification and recovery capacity. It may restore live task paths inside the watched subtree; for issue-thread interaction resolution it is an ordinary agent subject to the same audience and containment checks, not board authority, active-run output monitoring, or general liveness recovery. |
| Recovery | Liveness/watchdog recovery preserves explicit ownership: continue interrupted local conversations with bounded fresh turns and preserved history, never replay tool calls automatically; retain native ownership and real execution gates; preserve verified stop evidence and reconsider saved post-stop user messages after cleanup; otherwise open visible source-scoped recovery actions by default, use issue-backed recovery only for independent repair work, or require human escalation (see `doc/execution-semantics.md`) |
| Agent adapters | Built-in `process`, `http`, local CLI/session adapters, and OpenClaw gateway support; external adapters can also be loaded through the adapter plugin flow |
| Plugin framework | Local/self-hosted early plugin runtime is in scope; cloud marketplace and packaged public distribution remain out of scope |
| Auth | Mode-dependent human auth (`local_trusted` implicit board in current code; authenticated mode uses sessions), API keys for agents |
| Budget period | Monthly UTC calendar window |
| Budget enforcement | Soft alerts + hard limit auto-pause |
| Deployment modes | Canonical model is `local_trusted` + `authenticated` with `private/public` exposure policy (see `doc/DEPLOYMENT-MODES.md`) |

Low-trust agent presets are containment controls for hostile automated work, not
general project or issue privacy controls. The core preset resolver contract is
documented in `doc/LOW-TRUST-PRESETS.md`.

## 4. Current Baseline (Repo Snapshot)

As of 2026-02-17, the repo already includes:

- Node + TypeScript backend with REST CRUD for `agents`, `projects`, `goals`, `issues`, `activity`
- React UI pages for dashboard/agents/projects/goals/issues lists
- PostgreSQL schema via Drizzle with embedded PostgreSQL fallback when `DATABASE_URL` is unset

V1 implementation extends this baseline into a company-centric, governance-aware control plane.

## 5. V1 Scope

## 5.1 In Scope

- Company lifecycle (create/list/get/update/archive)
- Goal hierarchy linked to company mission
- Agent lifecycle with org structure and adapter configuration
- Task lifecycle with parent/child hierarchy and comments
- Atomic task checkout and explicit task status transitions
- Board approvals for hires and CEO strategy proposal
- Heartbeat invocation, status tracking, and cancellation
- Cost event ingestion and rollups (agent/task/project/company)
- Budget settings and hard-stop enforcement
- Board web UI for dashboard, org chart, tasks, agents, approvals, costs
- Agent-facing API contract (task read/write, heartbeat report, cost report)
- Auditable activity log for all mutating actions

## 5.2 Out of Scope (V1)

- Cloud-grade plugin marketplace/distribution beyond the local/self-hosted plugin runtime
- Revenue/expense accounting beyond model/token costs
- Knowledge base subsystem
- Public marketplace (ClipHub)
- Multi-board governance (multiple board UIs for a single company)
- Automatic self-healing orchestration (auto-reassign/retry planners)

Role-based human permission granularity is V1 — see the `humans-and-permissions`
plan, the `principal_permission_grants` table, and the `PERMISSION_KEYS` set
in `packages/shared/src/constants.ts`.

## 6. Architecture

## 6.1 Runtime Components

- `server/`: REST API, auth, orchestration services
- `ui/`: Board operator interface
- `packages/db/`: Drizzle schema, migrations, DB clients (Postgres)
- `packages/shared/`: Shared API types, validators, constants

## 6.2 Data Stores

- Primary: PostgreSQL
- Local default: embedded PostgreSQL at `~/.paperclip/instances/default/db`
- Optional local prod-like: Docker Postgres
- Optional hosted: Supabase/Postgres-compatible
- File/object storage:
  - local default: `~/.paperclip/instances/default/data/storage` (`local_disk`)
  - cloud: S3-compatible object storage (`s3`)

## 6.3 Background Processing

A lightweight scheduler/worker in the server process handles:

- heartbeat trigger checks
- stuck run detection
- budget threshold checks

Separate queue infrastructure is not required for V1.

## 7. Canonical Data Model (V1)

All core tables include `id`, `created_at`, `updated_at` unless noted.

## 7.0 Auth Tables

Human auth tables (`users`, `sessions`, and provider-specific auth artifacts) are managed by the selected auth library. This spec treats them as required dependencies and references `users.id` where user attribution is needed.

## 7.1 `companies`

- `id` uuid pk
- `name` text not null
- `description` text null
- `status` enum: `active | paused | archived`
- `pause_reason` text null
- `paused_at` timestamptz null
- `issue_prefix` text not null
- `issue_counter` int not null
- `budget_monthly_cents` int not null default 0
- `spent_monthly_cents` int not null default 0
- `require_board_approval_for_new_agents` boolean not null default false
- feedback sharing consent fields

Invariant: every business record belongs to exactly one company.

## 7.2 `agents`

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `name` text not null
- `role` text not null
- `title` text null
- `icon` text null
- `status` enum: `active | paused | idle | running | error | pending_approval | terminated`
- `reports_to` uuid fk `agents.id` null
- `capabilities` text null
- `adapter_type` text; built-ins include `process`, `http`, `claude_local`, `codex_local`, `gemini_local`, `opencode_local`, `pi_local`, `cursor`, `hermes_local`, `hermes_gateway`, and `openclaw_gateway`
- `adapter_config` jsonb not null
- `runtime_config` jsonb not null default `{}`; contains Paperclip runtime policy such as heartbeat scheduling and debug settings
- `default_environment_id` uuid fk `environments.id` null
- `context_mode` enum: `thin | fat` default `thin`
- `budget_monthly_cents` int not null default 0
- `spent_monthly_cents` int not null default 0
- pause fields: `pause_reason`, `paused_at`
- `permissions` jsonb not null default `{}`
- `last_heartbeat_at` timestamptz null
- `metadata` jsonb null

Invariants:

- agent and manager must be in same company
- no cycles in reporting tree
- `terminated` agents cannot be resumed

## 7.3 `agent_api_keys`

- `id` uuid pk
- `agent_id` uuid fk `agents.id` not null
- `company_id` uuid fk `companies.id` not null
- `name` text not null
- `key_hash` text not null
- `last_used_at` timestamptz null
- `revoked_at` timestamptz null

Invariant: plaintext key shown once at creation; only hash stored.

## 7.4 `goals`

- `id` uuid pk
- `company_id` uuid fk not null
- `title` text not null
- `description` text null
- `level` enum: `company | team | agent | task`
- `parent_id` uuid fk `goals.id` null
- `owner_agent_id` uuid fk `agents.id` null
- `status` enum: `planned | active | achieved | cancelled`

Invariant: at least one root `company` level goal per company.

## 7.5 `projects`

- `id` uuid pk
- `company_id` uuid fk not null
- `goal_id` uuid fk `goals.id` null
- `name` text not null
- `description` text null
- `status` enum: `backlog | planned | in_progress | completed | cancelled`
- `lead_agent_id` uuid fk `agents.id` null
- `target_date` date null
- `env` jsonb null (same secret-aware env binding format used by agent config)

Invariant:

- project env is merged into run environment for issues in that project and overrides conflicting agent env keys before Paperclip runtime-owned keys are injected

Routine execution issues add a routine-scoped env overlay after project env and before Paperclip runtime-owned keys. Routine env uses the same secret-aware binding format, is stored on `routines.env`, is snapshotted in routine revisions, and resolves secret refs against the routine binding target so routine-owned secrets do not require direct bindings on the executing agent.

Project source repositories use the existing `project_workspaces` collection.
Each selected GitHub repository has a canonical `repo_url` and stable provider ID
in `metadata.githubRepositoryId`; the first workspace remains the execution default.
The board can select multiple repositories from its usable personal and shared
GitHub grants. Selection does not grant runtime credential access. Legacy workspace
URLs remain valid. Project creation and repository replacement are transactional.
Project repositories are optional: QA Harness tasks can use suite-local test assets and a target environment without a business checkout. Seat owners and managers can also import existing allowlisted business checkouts reported by their online seats; these use `metadata.harnessRepositoryId`. Coding intake still verifies source identity and baseline before preparing an isolated worktree. See `doc/project-repositories.md` for the API and UI contract.

## 7.6 `issues` (core task entity)

- `id` uuid pk
- `company_id` uuid fk not null
- `project_id` uuid fk `projects.id` null
- `project_workspace_id` uuid fk `project_workspaces.id` null
- `goal_id` uuid fk `goals.id` null
- `parent_id` uuid fk `issues.id` null
- `title` text not null
- `description` text null
- `status` enum: `backlog | todo | in_progress | in_review | done | blocked | cancelled`
- `priority` enum: `critical | high | medium | low`
- `review_policy` nullable enum: `anyone | not_creator | human_only`; null is equivalent to `anyone`
- `assignee_agent_id` uuid fk `agents.id` null
- `assignee_user_id` text null
- checkout/execution locks: `checkout_run_id`, `execution_run_id`, `execution_agent_name_key`, `execution_locked_at`
- `created_by_agent_id` uuid fk `agents.id` null
- `created_by_user_id` uuid fk `users.id` null
- identifier fields: `issue_number`, `identifier`
- origin fields: `origin_kind`, `origin_id`, `origin_run_id`, `origin_fingerprint`
- Creation stores the actor run in `origin_run_id` unless an explicit origin run is supplied. `GET /api/companies/:companyId/issues?createdFromIssueId=<uuid>` selects tasks created by runs bound to that source task, using native run issue identity or persisted legacy task context. Historical rows without an origin run may use their recorded creation activity; comments and shared creators do not establish provenance. Source, run, activity and result are company-scoped.
- Relation lists can use `sortField=id&sortDir=asc&afterId=<uuid>` for stable pagination. The cursor excludes earlier IDs and cannot be combined with an offset or activity-based order.
- The streamlined task page's Tasks tab keeps two independent memberships: the existing subtask tree, and created tasks grouped by their current project (or No project). A created subtask appears in both. Only Subtasks has completion progress; groups collapse independently and unfinished tasks sort above finished tasks.
- `request_depth` int not null default 0
- `work_mode` text not null default `standard`; supported values:
  - `standard`: normal autonomous execution. Agents may investigate, edit files, create artifacts, and complete the task.
  - `ask`: answer-only execution. Agents may use tools for investigation or temporary scratch work, but the deliverable is an issue-thread answer; they must not write implementation code or produce an implementation plan.
  - `planning`: plan-only execution. Agents create or revise the plan without implementation work. Accepting a fresh confirmation for the issue's current `plan` revision atomically changes this mode to `standard`, so the continuation may implement the approved plan on the source issue.
- `billing_code` text null
- `assignee_adapter_overrides` jsonb null
- `execution_policy` jsonb null
- `execution_state` jsonb null
- execution workspace fields: `execution_workspace_id`, `execution_workspace_preference`, `execution_workspace_settings`
- `started_at` timestamptz null
- `completed_at` timestamptz null
- `cancelled_at` timestamptz null
- `hidden_at` timestamptz null

Invariants:

- single assignee only
- task must trace to company goal chain via `goal_id`, `parent_id`, or project-goal linkage
- `in_progress` requires assignee
- an `in_review -> done | cancelled` verdict is authorized against the current review policy while the issue row is locked; a policy change in the same request or a concurrent request cannot relax that verdict gate
- accepting or rejecting the review-confirmation interaction locks the issue row before resolving the interaction and reauthorizes against the current review policy in that transaction
- accepting a fresh `request_confirmation` for the current issue's `plan` revision changes `work_mode = planning` to `work_mode = standard` in the same transaction as the accepted interaction; the existing agent-return transition also moves an eligible `in_review` issue to `todo` without changing its agent owner
- while a restrictive review policy is stored, changing it requires an actor who is allowed by that row-locked policy
- the transition into `in_review` and its requester activity record commit atomically, including transitions without an explicit review-interaction binding
- terminal states: `done | cancelled`

## 7.7 `issue_comments`

- `id` uuid pk
- `company_id` uuid fk not null
- `issue_id` uuid fk `issues.id` not null
- `author_agent_id` uuid fk `agents.id` null
- `author_user_id` uuid fk `users.id` null
- `body` text not null

## 7.8 `heartbeat_runs`

- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk not null
- `invocation_source` enum: `scheduler | manual | callback`
- `status` enum: `queued | running | succeeded | failed | cancelled | timed_out`
- `started_at` timestamptz null
- `finished_at` timestamptz null
- `error` text null
- `external_run_id` text null
- `context_snapshot` jsonb null

## 7.9 `cost_events`

- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk `agents.id` not null
- `issue_id` uuid fk `issues.id` null
- `project_id` uuid fk `projects.id` null
- `goal_id` uuid fk `goals.id` null
- `billing_code` text null
- `provider` text not null
- `model` text not null
- `cost_status` text not null default `reported`; `unpriced` when usage exists but no price was reported
- `input_tokens` int not null default 0
- `output_tokens` int not null default 0
- `cost_cents` int not null
- `occurred_at` timestamptz not null

Invariant: each event must attach to agent and company; rollups are aggregation, never manually edited.

## 7.10 `approvals`

- `id` uuid pk
- `company_id` uuid fk not null
- `type` enum: `hire_agent | approve_ceo_strategy | budget_override_required | request_board_approval`
- `requested_by_agent_id` uuid fk `agents.id` null
- `requested_by_user_id` uuid fk `users.id` null
- `status` enum: `pending | revision_requested | approved | rejected | cancelled`
- `payload` jsonb not null
- `decision_note` text null
- `decided_by_user_id` uuid fk `users.id` null
- `decided_at` timestamptz null

## 7.11 `activity_log`

- `id` uuid pk
- `company_id` uuid fk not null
- `actor_type` enum: `agent | user | system`
- `actor_id` uuid/text not null
- `action` text not null
- `entity_type` text not null
- `entity_id` uuid/text not null
- `details` jsonb null
- `created_at` timestamptz not null default now()

## 7.12 `project_memberships` + `agent_memberships`

Per-user project/agent membership is personal visibility state for board users. It only controls whether a resource appears in the current user's sidebar; it must not grant or revoke access to all-pages, detail pages, selectors, assignment flows, search, or existing permissions.

`project_memberships`:

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `project_id` uuid fk `projects.id` not null
- `user_id` text not null
- `state` enum-like text: `joined | left`
- `created_at` timestamptz not null default now()
- `updated_at` timestamptz not null default now()
- unique `(company_id, user_id, project_id)`

`agent_memberships` mirrors the same shape with `agent_id` instead of `project_id` and unique `(company_id, user_id, agent_id)`.

Invariants:

- Missing membership rows mean `joined` for backward compatibility.
- Mutations are board-user-only `/me` operations; agent API keys are rejected.
- Viewer-role board users may update only their own membership rows through the narrow self-service helper.
- Target project/agent ownership is checked against the path company before mutation.
- Successful state changes write `resource_membership.joined` or `resource_membership.left` activity entries.

## 7.13 `company_secrets` + `company_secret_versions`

- Secret values are not stored inline in `agents.adapter_config.env`.
- Agent env entries should use secret refs for sensitive values.
- `company_secrets` tracks identity/provider metadata per company.
- `company_secret_versions` stores encrypted/reference material per version.
- Default provider in local deployments: `local_encrypted`.

Operational policy:

- Config read APIs redact sensitive plain values.
- Activity and approval payloads must not persist raw sensitive values.
- Config revisions may include redacted placeholders; such revisions are non-restorable for redacted fields.

## 7.14 Required Indexes

- `agents(company_id, status)`
- `agents(company_id, reports_to)`
- `issues(company_id, status)`
- `issues(company_id, assignee_agent_id, status)`
- `issues(company_id, parent_id)`
- `issues(company_id, project_id)`
- `cost_events(company_id, occurred_at)`
- `cost_events(company_id, agent_id, occurred_at)`
- `heartbeat_runs(company_id, agent_id, started_at desc)`
- `approvals(company_id, status, type)`
- `activity_log(company_id, created_at desc)`
- `assets(company_id, created_at desc)`
- `assets(company_id, object_key)` unique
- `issue_attachments(company_id, issue_id)`
- `company_secrets(company_id, name)` unique
- `company_secret_versions(secret_id, version)` unique
- `project_memberships(company_id, user_id)`
- `project_memberships(company_id, user_id, project_id)` unique
- `agent_memberships(company_id, user_id)`
- `agent_memberships(company_id, user_id, agent_id)` unique

## 7.15 `assets` + `issue_attachments`

- `assets` stores provider-backed object metadata (not inline bytes):
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `provider` enum/text (`local_disk | s3`)
  - `object_key` text not null
  - `content_type` text not null
  - `byte_size` int not null
  - `sha256` text not null
  - `original_filename` text null
  - `created_by_agent_id` uuid fk null
  - `created_by_user_id` uuid/text fk null
- `issue_attachments` links assets to issues/comments:
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `issue_id` uuid fk not null
  - `asset_id` uuid fk not null
  - `issue_comment_id` uuid fk null
- V1 attachment serving contract:
  - Default upload allowlist includes common images, PDF, plain text/markdown/JSON/CSV/HTML, ZIP, and video artifacts (`video/mp4`, `video/webm`, `video/quicktime`).
  - Attachment reads are company-scoped and expose stable path metadata: `contentPath`/`openPath` for inline-safe viewing and `downloadPath` for forced download.
  - Inline-safe responses use `Content-Disposition: inline`; unsafe types and explicit download requests use `attachment`.
  - Script-capable content such as HTML is always served as an attachment with `X-Content-Type-Options: nosniff` and a sandboxed, deny-by-default CSP; it is never rendered inline on the Paperclip origin.
  - Video attachments are inline-safe and support single `Range: bytes=start-end` requests with `206`, `Content-Range`, and `Accept-Ranges: bytes` for browser playback/seeking.
- Attachment-backed artifact work products use `type: "artifact"`, `provider: "paperclip"`, and metadata with `attachmentId`, `contentType`, `byteSize`, `contentPath`, `openPath`, `downloadPath`, and optional `originalFilename`.
- Workspace-only file references use work product `metadata.resourceRef` with `kind: "workspace_file"`, `issueId`, `workspaceKind` (`execution_workspace` or `project_workspace`), `workspaceId`, `relativePath`, optional `line`/`column`, and `displayPath`. These references point at files in a workspace; they do not replace attachment-backed artifacts for deliverables that must be inspectable without workspace access.

## 7.15 `documents` + `document_revisions` + `issue_documents`

- `documents` stores editable text-first documents:
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `title` text null
  - `format` text not null (`markdown`)
  - `latest_body` text not null
  - `latest_revision_id` uuid null
  - `latest_revision_number` int not null
  - `created_by_agent_id` uuid fk null
  - `created_by_user_id` uuid/text fk null
  - `updated_by_agent_id` uuid fk null
  - `updated_by_user_id` uuid/text fk null
  - `locked_at` timestamptz null
  - `locked_by_agent_id` uuid fk null
  - `locked_by_user_id` uuid/text fk null
  - Locked documents are immutable until unlocked. Board operators can lock/unlock; agent writes to a locked key create a new issue document with a derived key instead of overwriting the locked document.
- `document_revisions` stores append-only history:
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `document_id` uuid fk not null
  - `revision_number` int not null
  - `body` text not null
  - `change_summary` text null
- `issue_documents` links documents to issues with a stable workflow key:
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `issue_id` uuid fk not null
  - `document_id` uuid fk not null
  - `key` text not null (`plan`, `design`, `notes`, etc.)

## 7.16 Current Implementation Addenda

The current implementation includes additional V1-control-plane tables beyond the original February snapshot:

- Issue structure and review: `issue_relations` for blockers, `labels`/`issue_labels`, `issue_thread_interactions`, `issue_approvals`, `issue_execution_decisions`, `issue_work_products`, `issue_inbox_archives`, `issue_read_states`, and issue reference mention indexes.
- Execution and workspace control: `execution_workspaces`, `project_workspaces`, `workspace_runtime_services`, `workspace_operations`, `environments`, `environment_leases`, `agent_task_sessions`, `agent_runtime_state`, `agent_wakeup_requests`, heartbeat events, and watchdog decision tables.
- Plugins and routines: `plugins`, plugin config/state/entities/jobs/logs/webhooks, plugin database namespaces/migrations, plugin company settings, `routines`, `routine_revisions`, `routine_triggers`, and `routine_runs`.
- Access and operations: company memberships, instance roles, principal permission grants, invites, join requests, board API keys, CLI auth challenges, budget policies/incidents, feedback exports/votes, company skills, sidebar preferences, and company logos.

Decision-desk triage uses company-scoped sidecars rather than adding queue fields to every attention source:

- `decision_queues` stores durable named queues, optional retention overrides, server-derived creator/run provenance, and data-backed seed rules.
- `decision_queue_items` keys membership by `(queue_id, source_kind, source_id)` and repeats `company_id` for company-consistent joins.
- `decision_triage` keys current decide-by/snooze state by `(company_id, source_kind, source_id)` and preserves the latest setter attribution.
- `decision_triage_events` is the immutable mutation history for queue membership and triage overrides, including actor, run, API-key, and responsible-user provenance.
- `decision_retention` stores the attention source's last observed activity timestamp, monotonic version, Keep flag, and reversible archive provenance. Queue `retention_days` overrides use the shortest assigned queue threshold; otherwise the shelf threshold is 30 days.
- `decision_archive_notification_outbox` records one retry-safe origin-agent notification per source/archive version. The 90-day internal sweeper archives only unkept rows and coalesces delivery per origin agent.
- Queue membership never grants source visibility. Item writes re-authorize the referenced source, and queue reads re-authorize every member before returning rows or counts.

## 8. State Machines

## 8.1 Agent Status

Allowed transitions:

- `idle -> running`
- `running -> idle`
- `running -> error`
- `error -> idle`
- `idle -> paused`
- `running -> paused` (requires cancel flow)
- `paused -> idle`
- `* -> terminated` (board only, irreversible)

## 8.2 Issue Status

Allowed transitions:

- `backlog -> todo | cancelled`
- `todo -> in_progress | blocked | cancelled`
- `in_progress -> in_review | blocked | done | cancelled`
- `in_review -> in_progress | done | cancelled`
- `blocked -> todo | in_progress | cancelled`
- terminal: `done`, `cancelled`

Side effects:

- entering `in_progress` sets `started_at` if null
- entering `done` sets `completed_at`
- entering `cancelled` sets `cancelled_at`

V1 non-terminal liveness rule:

- agent-owned `todo`, `in_progress`, `in_review`, and `blocked` issues must have a live execution path, an explicit waiting path, or an explicit recovery path
- `in_review` is healthy only when a typed execution participant, pending issue-thread interaction or approval, user owner, active run, queued wake, or explicit recovery action owns the next action
- a blocked chain is covered only when each unresolved leaf issue is live or explicitly waiting
- external waits are durable only when persisted as a bounded monitor/scheduled wake, a first-class blocker with a named owner and action, or healthy delegated child work connected by a blocker edge when the source must wait; parent/child structure alone is not a wait path
- unmanaged shell jobs, detached sessions, adapter child processes, local polling loops, PIDs, logs, and comments are evidence rather than liveness; a managed runtime service counts only when paired with a persisted monitor, wake, blocker, or delegated issue that owns the next check
- heartbeat finalization evaluates liveness from persisted Paperclip state; an issue cannot remain healthy `in_progress` solely because the exiting heartbeat started a local/background watcher
- a continuation cancelled as `issue_continuation_waiting_on_review` first converts a current typed wait target into a first-class wait; without a current target it is classified as `deliberate_wait_without_target` and gives the invokable original owner five normal-model disposition-repair attempts (immediate, then after 60, 120, 240, and 480 seconds, with up to 10 percent jitter)
- disposition repair revalidates blockers, children, interactions, approvals, monitors, execution stages, queued wakes, active runs, work products, owner invokability, budgets, and governance before every attempt; the attempt bound is keyed by durable source state, so comments or equivalent parked prose do not reset it while durable source-state changes may establish a new fingerprint
- backwards-compatible upgrades count consecutive historical `issue_continuation_waiting_on_review` cancellations for the unchanged accepted-interaction source state against the same five-attempt disposition-repair ceiling; missing pre-upgrade recovery-action rows do not reset the budget
- the source fingerprint, source-attempt count, next due time, source owner, and return owner persist in the recovery action; startup and periodic reconciliation resume that exact lineage without duplicate wakes, fold it when a current typed wait appears, and reschedule or escalate an expired action that has no live scheduled run
- source-attempt exhaustion opens one board-owned source-scoped recovery action without changing the source assignee and without waking a substitute agent; the board explicitly chooses whether to repair, retry the original owner, reassign, or resolve
- an active recovery action counts as a live source or blocker-chain path only while its owner has a live run, queued wake, scheduled retry, typed wait, or explicit board escalation; source and blocker projections consume the same nested recovery-path result
- when Paperclip cannot safely infer the next action, it surfaces the problem through visible blocked/recovery work instead of silently completing or reassigning work
- explicit recovery actions are the liveness primitive; source-scoped actions are the default form, issue-backed recovery is a fallback for independent repair work or safety boundaries, and comments alone are evidence rather than a healthy liveness path
- recovery-action ownership is separate from source-task ownership: automatic repair and board escalation preserve both source assignee fields; reassignment requires an explicit board decision or a policy-defined serious failure
- source-scoped recovery routing is cause-keyed: bounded continuity and disposition repair may retry only the original agent; provider-quota failures create/reuse a scheduled wait-recovery monitor; every other exhausted or unsafe path creates/reuses a board-owned recovery action with `routingPolicy: board_escalation_no_takeover_v1` and no substitute-agent wake
- legacy active agent-owned recovery actions remain readable, resolvable, and API-compatible after upgrade, but reconciliation does not enqueue another takeover wake for them
- active-run output silence is an informational board UI signal at one hour (`suspicious`) and four hours (`critical`); it does not create or update issues or recovery actions, comment on or block source work, change assignments, or wake an agent
- board snooze and continue decisions suppress the run signal until their stored re-arm time; a false-positive decision suppresses it permanently for that run; open legacy evaluation issues remain readable and manually resolvable without automatic refresh

Detailed ownership, execution, blocker, active-run watchdog, crash-recovery, and non-terminal liveness semantics are documented in `doc/execution-semantics.md`.

## 8.3 Approval Status

- `pending -> approved | rejected | cancelled`
- terminal after decision

## 9. Auth and Permissions

## 9.1 Board Auth

- Session-based auth for human operator
- Board has full read/write across all companies in deployment
- Every board mutation writes to `activity_log`

## 9.2 Agent Auth

- Bearer API key mapped to one agent and company
- Agent key scope:
  - read org/task/company context for own company
  - read company-visible tasks and comments
  - comment on and update visible tasks under the shared write rule
  - create child tasks and assign visible work for delegation under the same rule
  - report heartbeat status
  - report cost events
- Agent cannot:
  - bypass approval gates
  - modify company-wide budgets directly
  - mutate auth/keys

## 9.3 Permission Matrix (V1)

| Action | Board | Agent |
|---|---|---|
| Create company | yes | no |
| Hire/create agent | yes (direct) | request via approval |
| Pause/resume agent | yes | pause: no; resume: direct `agents:configure` grant only |
| Create/update task | yes | yes |
| Force reassign task | yes | limited |
| Approve strategy/hire requests | yes | no |
| Report cost | yes | yes |
| Set company budget | yes | no |
| Set subordinate budget | yes | yes (manager subtree only) |
| Manage responsible user's inbox state | yes | yes (default-open policy) |
| Manage another user's inbox state | yes | saved target-user opt-in or scoped `inbox:manage` grant |
| Set work-object visibility (issue/project) | no | no (pro gate) |

Agent resume is the only grant-gated exception in the lifecycle-route group. An
agent actor calling `POST /agents/:agentId/resume` must pass the protected
`agent_config:update` decision with `scope.requiresChangeGrant: true`; self
access does not bypass that decision, and `agents:suggest-changes` alone cannot
apply the lifecycle change. Pause, clear-error, terminate, approval, and
key-management routes remain board-only.

### 9.3.1 Shared default-open issue writes

For standard-trust agents, issue comments, issue field/status updates, child
creation under a parent, and assignment share one authorization rule: the
target issue must be visible to the agent and the responsible user represented
by the run must also be authorized. In V1, issue visibility defaults to the
whole company, so these writes are company-wide by default.

The shared rule does not widen low-trust, `skill_test`, or `task_bridge` key
scopes. It also does not replace run-lifecycle controls: checkout ownership,
active-run conflicts, status-transition validation, interaction ownership,
budget gates, and pause gates remain independently enforced. Comment access is
structurally downstream of issue read access (`issue:comment` is a subset of
`issue:read`).

Cross-issue writes are contained per heartbeat run. An agent-authored comment
may wake the target assignee, including an explicit `resume: true` comment on a
`done` or `cancelled` issue, but the wake remains agent-class and is subject to
the normal agent rewake throttle; comment presentation cannot give it human
wake privileges. Agent issue comments and updates require a persisted heartbeat
run bound to the authenticated agent and company; missing, invalid, or mismatched
run context fails closed before mutation. A run may attempt at most 20 cross-issue comments, issue
updates, or issue-thread interaction resolutions across one shared counter. The
server records each attempt with its source issue, target issue, run, count, and
rollout mode, and fails closed with the cap in the error once enforcement is
active. Writes to the run's own source issue are not counted. Assignee self-comments do not
wake the assignee, and a non-assignee comment cannot mint a mention grant.

Agent-authored issue comments persist the responsible user derived from the
authenticated actor; clients cannot choose that attribution. Each comment also
records the write-policy reason, and spoof attempts fail with an audited 422.
Every issue PATCH emits an `issue.updated` activity receipt containing the
actor, responsible user, run, authorization reason, and field-level before/after
changes so both agent and board edits are visible in the issue activity stream.

## 9.4 Permission Terminology and Default Visibility Rule

Paperclip V1 keeps a company-scoped visibility model as the default because centralized authorization and scoped work-object controls are not yet a core V1 control surface.

The approved term set is:

- **Agent profile visibility**: identity-level facts needed for delegation and governance (name, role, capabilities, reporting lines).
- **Agent config visibility**: adapter/runtime config metadata and secret-access policy.
- **Assignment/invocation permission**: who may modify or execute a task.
- **Work-object visibility**: who can read/write issues, comments, projects, and attachments.
- **Tool/secret policy**: what tools and secret-backed credentials an agent can use and what appears in logs.
- **Escalation authority**: where refusal/blocked decisions route (manager, then board).

## 9.5 Core V1 Rule: what “private” means

- A **private marker** on an agent profile (where represented) does **not** make company-visible work private.
- Company-visible work objects (issues, comments, work products, costs, activity, project/task state) remain visible to the board and in-company agents by default.
- Project/issue-level privacy, scoped assignment-only object visibility, and organization-wide custom ACLs are deferred to Pro/Enterprise controls.

## 9.6 V1 vs Pro/Enterprise Controls (recommended target split)

| Permission area | Free / V1 default | Pro / Enterprise |
|---|---|---|
| Company boundary | Hard boundary only (`company_id`) | Multi-company policy overlays (`membership`, `project`, and `task` scopes) |
| Simple roles | Board + agent roles with existing approval/budget gates | Additional role aliases + scoped approver roles |
| Profile visibility | Full profile visibility for coordination and audit | Optional profile redaction / selective sharing for external surfaces |
| Config visibility | Board full read with redacted secret fields; agent config read/write constrained by own agent identity | Scoped config visibility controls and central policy enforcement |
| Assignment/invocation | Assignment creates execution authority; board can reassign or force release | Delegation policies and scoped invokers with deny-listed tool classes |
| Work-object visibility | All issues and projects in-company are visible to board and agents | Project/issue ACLs and reviewer-only channels |
| Tool/secret policy | Secret refs, log redaction, and adapter-level command/webhook restrictions | Tool allowlists with centralized policy evaluation |
| Company skills | Open to authenticated company agents; core enforces invariants and any stored restriction policy | Paperclip EE policy editor, protected-skill controls, presets, simulation, and policy audit UX |
| Inbox management | Responsible agent may archive/unarchive its responsible user's Mine items under a default-open user policy; explicit cross-user access requires saved target-user opt-in or `inbox:manage`; all mutations are audited | Policy administration UX, organization presets, simulations, bulk controls, and richer audit/reporting surfaces |
| Escalation | Escalate from agent to manager to board; board approval/budget gates remain authoritative | Escalation routing and SLA windows |

## 9.7 Recommended first-slice implementation order

1. Lock route-level checks for existing company boundaries, actor extraction, and approval/budget gates.
2. Treat profile privacy as external-facing signal only; do not use it to hide company-visible work objects.
3. Enforce assignment/invocation coupling (`assignee`/`agent` checks, checkout semantics, invocation checks).
4. Standardize read-path redaction for secrets and secret references, including logs and activity.
5. Standardize escalation paths (`blocked` and refusal) so non-board agents hand off by manager/board with immutable audit.

## 9.8 Scoped Task Assignment Grants

`tasks:assign` remains the broad assignment permission. Existing unscoped grants preserve compatibility and allow the principal to assign any visible company task within normal company-boundary checks.

`tasks:assign_scope` is the constrained assignment permission. Its `principal_permission_grants.scope` JSON must include at least one recognized constraint:

- Project scope: `projectId`, `projectIds`, or `allow: ["project:<projectId>"]`.
- Target-agent allowlist: `agentId`, `agentIds`, `assigneeAgentId`, `assigneeAgentIds`, `targetAgentId`, `targetAgentIds`, or `allow: ["agent:<agentId>"]`.
- Managed-subtree scope: `managerAgentId`, `managerAgentIds`, `managedSubtreeAgentId`, `managedSubtreeAgentIds`, `subtreeAgentId`, `subtreeAgentIds`, `subtreeRootAgentId`, `subtreeRootAgentIds`, or `allow: ["subtree:<agentId>"]`.

When multiple constraint families are present, assignment must satisfy all of them. Denials return `403` with a generic scope explanation and do not disclose details about hidden or unrelated resources.

A protected-agent hard block is represented canonically as
`authorizationPolicy.protectedAgent.blockAssignment: true`. It denies assignment
even when the caller has a broad or scoped assignment grant. A company
administrator must remove the block before assignment can be retried; no pending
approval is created. The legacy fields `protectedAgent.requiresApproval` and
`assignmentPolicy.protectedAgentRequiresApproval` remain fail-closed compatibility
aliases for the same hard block, but API denial copy must describe the block and
administrator remediation rather than promising a nonexistent approval step.

### 9.8.1 Issue-thread interaction resolver contract

Issue-thread interactions are coordination records, not grants of authority. Every
interaction kind defaults to resolver policy `anyone` when the create request omits
`resolverPolicy`. Restrictions are opt-in.

Canonical resolver policies are:

- `anyone`: any authenticated actor in the interaction's company who can read the
  issue and use the normal resolution route. For agents this includes the creator
  agent and the creating/source run.
- `not_creator`: the explicit independent-review policy. It excludes the creator
  agent and creating/source run while otherwise using the ordinary agent resolver
  path.
- `human_only`: only an authorized human/board actor may resolve the interaction.

`board_or_agents` and `board_only` are deprecated migration and API-input aliases.
For new writes they normalize to `anyone` and `human_only`, respectively. API reads
return canonical requested/effective policies, compatibility aliases, and immutable
provenance. The persisted provenance is `explicit`, `inherited`, or
`legacy_inherited_restriction`; the effective-policy source is `requested`,
`company_cap`, or `governed_action`.

Historical rows predate explicit-vs-inherited provenance. Migration must never
silently widen an ambiguous pending card: legacy `board_or_agents` rows retain the
old creator-excluding behavior as canonical `not_creator`, legacy `board_only` rows
become `human_only`, and both are marked `legacy_inherited_restriction`. Resolved
outcomes and resolver attribution are immutable.

An explicit named agent or user addressee and a company-configured cap may narrow
the effective audience. Only the exact named addressee may resolve an addressed
interaction; a human does not override a user addressee. A cap never widens the
requested audience. Tool-action confirmations and
other hard-governed action cards remain `human_only` (or move to the formal approval
system) regardless of a requested open audience.

Surfaces that offer a resolution must state the effective audience before the
operator acts, from server metadata rather than a client-side policy inference.
Issue-thread cards read it from the interaction snapshot; attention rows read it
from the feed item's `resolverAudience` (canonical requested/effective policy,
effective-policy source, provenance, and the addressee/creator identities the
evaluator compares against), because a collapsed row carries decision verbs
before the interaction itself is fetched. A failed resolution keeps the server's
denial reason in visible, assertively announced feedback and names who may
respond; an audience denial is permanent, so it must not degrade to a retry
prompt. Neither surface may enable or disable a control on its own authority.

Every resolution remains company-scoped, run-attributed for agent actors,
low-trust/task-bridge contained, target-current, and exact-once. Target staleness,
supersession, continuation idempotency, and activity attribution remain mandatory.
An open audience is not an uncapped one: when an agent run resolves an interaction
on an issue other than its own source issue, the resolution is a cross-issue
mutation and consumes the per-run cross-issue influence budget in §9.3, charged
after audience authorization and before the interaction mutation, child tasks,
continuation, tool action, or wake. Same-issue resolutions and board/user
resolutions are outside that counter.
Accepting or answering an interaction records a response only: suggested-task
creation, provider/tool calls, deployment, spend, hiring, secrets, execution-policy
decisions, and every other downstream effect must re-run its own authorization and
approval checks. Mislabeling a governed action as an open interaction grants no
downstream capability.

## 9.9 Task Watchdog Authority Contract

A task watchdog is a scoped execution capacity for a configured watchdog agent on one watched issue subtree. It is not a separate principal, does not inherit board auth, and does not expand the selected agent's company boundary. The server must enforce the watchdog contract from persisted watchdog configuration and run context; custom instructions and prompt text can narrow the mandate but cannot expand it.

The watched subtree is the source issue plus descendants reached through `parent_id`, excluding every issue whose `origin_kind = 'task_watchdog'` and excluding all descendants below those watchdog issues. The generated reusable watchdog issue is outside the watched work subtree for scan purposes, but the watchdog agent may update that reusable watchdog issue to record its own review disposition.

Task-watchdog wakes must include server-derived capability metadata that names the watched root, reusable watchdog issue, excluded `task_watchdog` origin branches, allowed operations, and denied operations. Watchdogs must use that metadata and server denials for capability discovery; they must not create visible probe issues, comments, or throwaway tasks to learn their permissions.

### Allowed watchdog mutations

Within the watched subtree, a watchdog run may perform only mutations that restore or clarify the next live/waiting path:

- add comments that explain findings, evidence, and next action
- create descendant follow-up issues under an included subtree issue, inheriting company, project, goal, and workspace context from that subtree
- assign or reassign included issues to active, invokable, same-company agents when normal assignment checks and scoped assignment grants allow it
- move included issues among `todo`, `in_progress`, `in_review`, and `blocked` when the transition is needed to restore a valid action path
- reopen `done` or `cancelled` included issues only with explicit resume metadata and an audit comment when evidence shows the stopped disposition is wrong or incomplete
- add, replace, or clear blockers on included issues when the blocker target is in the same company and the change makes the waiting path more accurate
- set or refresh a one-shot monitor on an included issue when the current assignee owns the future check
- resolve issue-thread interactions through the ordinary resolver-audience path
  when the watchdog agent otherwise has issue access and the effective policy allows it
- update the reusable watchdog issue itself to `done`, `in_review`, or `blocked` with the evidence for the watchdog decision

Every watchdog-triggered mutation must write activity with the watchdog id, source issue id, watchdog issue id when present, run id, and stop fingerprint. Mutations still use the normal status-transition, blocker, assignment, budget, and company-boundary guards.

### Atomic recovery batch

A watchdog run may submit an atomic recovery batch of at most 3 mutations drawn from the allowed-mutation list above, validated against the stop fingerprint that run observed. The server applies the batch all-or-nothing: if the subtree's stop fingerprint changed between observation and application — the subtree went live concurrently — the entire remainder of the batch is aborted and the staleness is recorded as evidence on the reusable watchdog issue. The batch is single-shot per watchdog run. This replaces the exactly-one-fresh-write model: the stale-guard's purpose (never mutate a subtree that concurrently went live) is preserved by fingerprint validation on the whole batch rather than by capping the run at one write, so a restoration that needs both a state-restoring `PATCH` and an explanatory comment cannot forfeit the restoration by ordering the comment first.

### Restoration verification and escalation

Reviewed-fingerprint suppression is disposition-aware. A watchdog disposition of "stopped state is legitimate" suppresses re-fire for that fingerprint as today. A disposition of "live path restored" arms a bounded verification instead:

- if a later scan observes the subtree stopped with a fingerprint equal to the one the restoration claimed to fix, the watchdog re-fires with an incremented attempt count for that fingerprint lineage
- restoration-attempt lineage (attempt number, claimed-fixed fingerprint, restoration actions) is persisted durable watchdog state
- the stop fingerprint (or the lineage check) must account for intermediate-node durable updates so a restoration that changes no stopped leaf is classified as a failed restoration, not as a reviewed stop
- after N attempts (N = 2–3, configuration-bounded) on the same fingerprint lineage, the platform stops re-firing and escalates to a human — the watchdog owner or a board notification — with the attempt history attached

Escalation is terminal for the automatic loop: no further watchdog wakes fire for that lineage until a human or a new durable subtree change produces a different fingerprint.

### Disallowed watchdog mutations

A task watchdog must not:

- mutate issues outside the watched subtree, except for comments or newly created follow-up issues that are children of included subtree issues
- mutate company, project, goal, agent, auth, API key, budget, secret, environment, plugin, or deployment settings
- approve or reject rows in the `approvals` table, including hiring, CEO strategy, spend, budget override, or `request_board_approval` decisions
- resolve execution-policy decisions unless the watchdog agent is the typed participant under that policy outside of its watchdog capacity
- force-release checkout/execution locks, cancel active runs, terminate processes, or perform active-run output watchdog decisions
- create visible probe issues, comments, or throwaway tasks to discover whether an operation is allowed
- delete issue documents, comments, attachments, work products, or activity records
- change the watchdog configuration, select a different watchdog agent, or create nested watchdog configurations
- treat custom instructions as authority to bypass approval gates, cross company boundaries, access secrets, or override this contract

When the safe next action needs one of these disallowed mutations, the watchdog must leave a valid waiting path by commenting, creating an in-subtree escalation/follow-up issue, assigning to the correct owner, or leaving the source issue blocked on a first-class blocker.

### Interaction resolution

A task-watchdog run has no special resolver audience, plan-purpose marker, or
interaction-kind allowlist. The task-watchdog context neither widens nor
categorically removes the selected agent's ordinary interaction authority. The
same evaluator used for every agent applies `anyone`, `not_creator`, `human_only`,
named-addressee, company-cap, company-boundary, run-attribution, low-trust,
task-bridge, target-staleness, and exact-once checks.

Resolving an interaction does not authorize its downstream effect. In particular,
an accepted plan still passes normal decomposition/idempotency checks, and a
governed action still requires its own typed reviewer, permission, or formal
approval. A watchdog may not use an open coordination response to bypass any item
in the disallowed-mutations list above.

### Downstream acceptance criteria

Implementation, security, UI, and QA work for task watchdogs must prove these contract points:

- server tests deny cross-company watched issues, watchdog agents, watchdog issues, blockers, interactions, and assignment targets
- server tests deny paused, terminated, pending-approval, budget-blocked, or otherwise uninvokable watchdog agents
- watchdog-scoped mutations can touch only the watched subtree and the reusable watchdog issue, with activity records for each mutation
- interaction tests prove watchdog runs use the same resolver policy as ordinary agents, without a watchdog-only kind or purpose-marker exception
- interaction tests cover `anyone`, `not_creator`, `human_only`, named addressees, company caps, stale targets, governed actions, newer user comments, low-trust/task-bridge containment, and cross-company denial
- scheduler tests prove live runs, queued wakes, and scheduled retries suppress watchdog wakeups, while terminal, cancelled, blocked, and review leaves are still verified when the subtree has no live path
- tests prove `task_watchdog` origin issues and descendants are excluded from scans so watchdogs do not trigger themselves
- recovery-batch tests prove batches are capped at 3 allowed mutations, applied all-or-nothing, and aborted with recorded evidence when the observed stop fingerprint went stale mid-batch
- restoration-verification tests prove a "live path restored" disposition re-fires on an unchanged fingerprint with an incremented attempt count, a failed intermediate-node restoration is not treated as a reviewed stop, and the N-attempt bound escalates to a human with attempt history instead of firing forever
- regression tests prove watchdog capability discovery comes from wake metadata/denials and denied probes do not create visible issues
- UI copy and badges distinguish task watchdogs from active-run output watchdogs, monitors, reviewers, approvers, and liveness recovery
- prompt/context tests prove custom instructions are appended after non-overridable safety constraints and cannot expand authority
- QA validates a full create/edit/remove/run/reuse flow with screenshots for UI changes

No unresolved policy decision blocks implementation once CTO and Security accept this contract. Deliberately deferred and disallowed for the first implementation: letting watchdogs cancel active runs, approving board/governance actions, mutating outside the watched subtree, or allowing watchdog agents to modify their own watchdog configuration. Any expansion of those capabilities requires a new product/security review.

## 9.10 Company Skill Policy Contract

### Product default

An authenticated agent may perform normal company-skill work without a skill-specific grant when the target company has no explicit skill policy. This includes creating, importing, installing, editing, updating, testing, resetting, and removing skills. Core MUST NOT introduce a `skills:author` prerequisite, a draft-only default, or an activation-approval default.

Authorization order is fixed:

1. Enforce non-configurable platform invariants.
2. Evaluate the company's explicit skill policy when one exists.
3. Otherwise allow the authenticated company agent.

Non-configurable invariants include authenticated actor identity, exact company scoping, source and workspace path containment, package and frontmatter validation, secret redaction/non-export, immutable audit attribution, and any hard runtime isolation rule. A policy rule, legacy grant, plugin, or EE configuration cannot override these invariants.

For avoidance of doubt:

- Local-path imports, updates, resets, and project scans MUST resolve under a Paperclip-known local workspace root or a Paperclip-managed skill root. Arbitrary host filesystem paths are invalid even when the caller is otherwise authorized. Caller-supplied `source`, `sourceLocator`, or similar path strings are descriptive input only; they MUST NOT expand authority beyond those approved roots.
- Remote imports and updates MUST normalize to a known source category, require validated HTTPS or catalog sources, and resolve immutable content before install (for example pinned Git commit/content hash or pinned package version). Unknown schemes, unknown source categories, symlink escapes, and out-of-tree files fail closed before persistence.
- Unsafe executable content, fetch-and-exec patterns, and secret exfiltration or non-redacted secret material are platform safety failures. Policy cannot waive them; the route MUST reject the operation before any new skill version, install, update, or reset is persisted.
- Mandatory activity attribution is part of the invariant boundary. If the required audit record for a skill mutation or policy mutation cannot be persisted, the mutation MUST fail or roll back; do not return success with missing auditability.

### Canonical actions and resources

The version 1 evaluator uses these stable action identifiers:

- `skills.create`: create or fork a company-authored skill and create skill versions
- `skills.import`: import or scan skills from a workspace, Git source, URL, or package
- `skills.install`: install a catalog or externally sourced skill into the company
- `skills.edit`: change skill metadata, name, files, test inputs, or test templates
- `skills.update`: install a newer upstream revision
- `skills.test`: start, cancel, or remove a skill test run and run a skill audit
- `skills.reset`: restore the installed/upstream revision
- `skills.remove`: delete a company skill

Policy resources may include `skillId`, stable `skillKey`, `sourceType`, and `sourceLocator`. The stable source categories are `workspace`, `catalog`, `git`, `external_package`, `generated`, and `unknown`; adapters may preserve a more specific source value as metadata, but policy evaluation MUST normalize it to one of these categories. Core derives actor and company identity from authentication and derives known resource fields from stored data; a mutation client cannot authorize itself by supplying actor or resource identity fields.

### Version 1 policy document

Absence of a policy record is semantically equivalent to the following document, but core SHOULD avoid materializing records for untouched companies:

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "defaultEffect": "allow",
  "rules": []
}
```

An explicit policy has a monotonically increasing `revision`, a `defaultEffect` of `allow` or `deny`, and ordered rules. Each rule contains a stable `id`, integer `priority`, `effect` (`allow` or `deny`), a subject selector (`all_agents`, agent ids, or role names), one or more canonical actions, and optional resource selectors for skill ids/keys and normalized source types/locators. An omitted resource selector matches every resource for the listed action.

Rules are evaluated by ascending `priority`, then stable rule id; the first matching rule decides. If no rule matches, `defaultEffect` decides. This supports both the normal open policy with targeted deny rules and an opt-in restricted preset with default deny plus explicit allow rules. Core MUST validate policy documents atomically and reject ambiguous, unknown-version, unknown-action, cross-company, or malformed selectors with `422`.

Every decision returned by the evaluator has this stable shape:

```json
{
  "allowed": false,
  "action": "skills.install",
  "reason": "explicit_rule",
  "policyRevision": 7,
  "matchedRuleId": "deny-external-packages",
  "remediation": "Contact a company administrator to change the skill policy."
}
```

`reason` is one of `platform_invariant`, `no_policy_default`, `explicit_rule`, `policy_default`, or `legacy_compatibility`. Mutation routes MUST use this evaluator and return `403` with code `skill_policy_denied` and the non-sensitive decision fields when an explicit restriction denies an operation. Denials must identify the action and remediation without exposing hidden rule data, secrets, or another company's policy.

Platform-invariant failures are not policy denials and MUST use stable machine-readable error codes so clients can distinguish non-overridable safety failures from optional administrative restrictions. Version 1 requires a finite code set covering at least:

- `skill_authentication_required`
- `skill_company_boundary_denied`
- `skill_workspace_boundary_denied`
- `skill_source_validation_failed`
- `skill_unsafe_content_blocked`
- `skill_secret_handling_blocked`
- `skill_policy_admin_required`

Core Skill Studio and Paperclip EE MUST treat those codes as hard platform failures, not as prompts to loosen policy.

### Core API and ownership boundary

Core owns and ships these company-scoped endpoints:

- `GET /companies/:companyId/skill-policy` returns the effective versioned policy, its revision, and whether it is materialized or the open default.
- `PUT /companies/:companyId/skill-policy` atomically replaces the policy and requires the caller's expected revision; stale writes return `409`.
- `DELETE /companies/:companyId/skill-policy` removes explicit configuration and restores the open default.
- `POST /companies/:companyId/skill-policy/evaluate` simulates decisions for administrative tooling without performing a skill mutation.

Policy reads, writes, deletion, and simulation enforce company access. Policy mutation and cross-principal simulation require board administration authority or the existing `users:manage_permissions` capability; ordinary skill access does not. Every policy mutation writes an activity event containing the actor, previous revision, new revision, and a redacted change summary. Skill mutation activity logging remains required independently of the policy decision.

Paperclip EE owns the detailed editor, presets, protected-skill management, policy simulation UX, and policy-specific audit views. EE consumes the core endpoints and does not implement a second evaluator. Core may expose a concise effective-policy summary and denial state, but MUST NOT depend on EE for enforcement or make EE installation a prerequisite for normal skill work.

### Compatibility and availability

- Existing companies with no explicit restriction adopt the open default, including companies that previously depended on missing grants to deny skill changes. Release notes and upgrade guidance MUST call out this behavior change.
- Existing explicit restriction policies remain effective after migration.
- Legacy `skills:create` and `skills:suggest-changes` positive grants remain accepted in APIs and portability packages. Historically either positive grant authorized the broad company-skill mutation surface, so in an explicit restricted policy either grant remains a compatibility allow fallback for all eight canonical skill actions only when no explicit rule matched. They never override an explicit deny or a platform invariant. With no explicit policy they are redundant because the default already allows the action.
- Legacy `skills:suggest-changes` consent state is not a platform invariant for company skills and does not add a second mutation gate under the open-default policy. Companies that require approval or consent before skill changes must express that restriction through explicit skill-policy rules; authentication, company boundaries, source containment, validation, auditability, and runtime safety remain non-configurable invariants.
- Import preview MUST report whether a package contains an explicit skill policy or legacy grants and how each will map. Import apply MUST preserve explicit policies, normalize supported legacy grants, and reject unknown policy versions rather than silently weakening them.
- Export MUST include explicit skill policy configuration and retained legacy grants in `.paperclip.yaml`, never secret values or environment-specific paths. An unconfigured company exports no synthetic restriction.
- If Paperclip EE is unavailable or removed, core continues to enforce stored policies and expose the policy API. Normal skill work remains available under the open default; explicit denials use core remediation text rather than a broken EE-only link.

### Required regression tests

Phase 2 server tests and Phase 4 UI tests must prove:

- unauthenticated actors and authenticated actors from another company are denied for all skill mutation routes and all skill-policy routes
- local-path imports and project scans reject paths outside approved workspace or managed-skill roots, including symlink escapes and out-of-tree files
- remote imports and updates reject unknown schemes/categories, unpinned mutable refs, unsafe executable content, and secret exfiltration patterns before persistence
- policy mutation, policy reset, and cross-principal policy simulation require board administration authority or `users:manage_permissions`; ordinary open-default skill access never grants those actions
- explicit policy denials return `skill_policy_denied`, while platform safety failures return the stable invariant denial codes above
- successful skill mutations and policy mutations persist activity records with actor, company, run attribution, normalized action, and revision/change summary; audit-write failures do not leave successful unaudited mutations behind

## 9.11 Inbox Management Permission and Ownership Contract

`inbox:manage` is the permission key for agent-driven per-user inbox archive state. Inbox archive state changes presentation in a user's Mine inbox; it does not change issue status, assignment, visibility, or the underlying work record.

Core authorization follows these rules:

- Board users may archive or unarchive inbox entries for users in the company.
- An agent may manage the responsible user's inbox without an explicit grant when the authenticated run resolves that user and the user's inbox-agent policy permits the agent. This is the default-open path.
- A user may set inbox-agent policy to `disabled` or `allowlist`. Policy restrictions override the default-open path, and low-trust agents are denied.
- An agent targeting any user other than its resolved responsible user requires either a materialized target-user policy that permits that agent (`open` or matching `allowlist`) or an explicit `inbox:manage` grant. The implicit default-open policy for a missing row remains responsible-user-only, so it never becomes a blanket cross-user grant. Grants may be unscoped or constrained by `scope.userIds` and act as administrative overrides, including over a disabled target-user policy.
- Archive and unarchive operations are company-scoped, reversible, and activity logged with actor, agent, run, target user, target-resolution source, and policy mode.
- New qualifying issue activity may invalidate an archive so the item resurfaces; archival is not a substitute for resolving or closing work.
- Viewing an issue may update its per-user read receipt, but read receipts alone do not enroll the issue in Mine. Mine participation begins with a user-authored comment, issue creation/assignment, or another audited user mutation; explicit product actions such as manually running a routine may record an audited inbox touch.

Ownership split:

- **Core / Free:** permission key and scoped-grant enforcement; responsible-user resolution; default-open, disabled, and allowlist policy modes; archive/unarchive APIs; per-user archive persistence; resurfacing behavior; activity audit records; and stable denial codes.
- **Paperclip EE / Enterprise:** centralized policy administration beyond the per-user controls, organization-wide presets, policy simulation, bulk inbox operations, advanced compliance reporting, and richer administrative audit UX. EE may extend policy management surfaces but must not weaken core company boundaries, user policy restrictions, scoped grants, or audit requirements.

## 10. API Contract (REST)

All endpoints are under `/api` and return JSON.

## 10.1 Companies

- `GET /companies`
- `POST /companies`
- `GET /companies/:companyId`
- `PATCH /companies/:companyId`
- `PATCH /companies/:companyId/branding`
- `POST /companies/:companyId/archive`

On a Paperclip Cloud-managed instance, `POST /companies` returns `403` with
code `cloud_managed`; the trusted-header provisioning path and company import
routes remain the only company-creation paths there.

## 10.1.1 Cloud Stack Portfolio

- `GET /cloud/stacks`

The route exists only on a Cloud-managed instance, requires a trusted
`cloud_tenant` actor, and proxies the current actor's user id plus the current
stack id to the Cloud tenant portfolio endpoint. Client-supplied user ids are
never forwarded. Successful responses are cached briefly per user; self-hosted
instances return `404`.

## 10.2 Goals

- `GET /companies/:companyId/goals`
- `POST /companies/:companyId/goals`
- `GET /goals/:goalId`
- `PATCH /goals/:goalId`
- `DELETE /goals/:goalId` (soft delete optional, hard delete board-only)

## 10.3 Agents

- `GET /companies/:companyId/agents`
- `POST /companies/:companyId/agents`
- `GET /agents/:agentId`
- `PATCH /agents/:agentId`
- `POST /agents/:agentId/pause`
- `POST /agents/:agentId/resume`
- `POST /agents/:agentId/terminate`
- `POST /agents/:agentId/keys` (create API key)
- `POST /agents/:agentId/heartbeat/invoke`

## 10.4 Tasks (Issues)

- `GET /companies/:companyId/issues`
- `POST /companies/:companyId/issues`
- `GET /issues/:issueId`
- `PATCH /issues/:issueId`
- `GET /issues/:issueId/documents`
- `GET /issues/:issueId/documents/:key`
- `PUT /issues/:issueId/documents/:key`
- `POST /issues/:issueId/documents/:key/lock`
- `POST /issues/:issueId/documents/:key/unlock`
- `GET /issues/:issueId/documents/:key/revisions`
- `DELETE /issues/:issueId/documents/:key`
- `POST /issues/:issueId/checkout`
- `POST /issues/:issueId/release`
- `POST /issues/:issueId/admin/force-release` (board-only lock recovery)
- `POST /issues/:issueId/comments`
- `GET /issues/:issueId/comments`
- `POST /companies/:companyId/issues/:issueId/attachments` (multipart upload)
- `GET /issues/:issueId/attachments`
- `GET /attachments/:attachmentId/content`
- `DELETE /attachments/:attachmentId`
- `GET /issues/:issueId/runner-goal?agentId=...`
- `POST /issues/:issueId/runner-goal/actions`

The runner-goal endpoints control an issue-scoped durable agent-session goal,
not a row in the company `goals` hierarchy. Reads return the effective agent,
negotiated capability, normalized goal snapshot, active-run state, pending
action, and revision. Mutations require a request id, assigned agent, expected
revision, and a negotiated action; they return `202`, replay the original result
for a duplicate request id, and return `409` with the current projection for a
stale revision or an unconfirmed unfinished-goal replacement. These controls do
not create issue comments.

### 10.4.1 Atomic Checkout Contract

`POST /issues/:issueId/checkout` request:

```json
{
  "agentId": "uuid",
  "expectedStatuses": ["todo", "backlog", "blocked", "in_review"]
}
```

Server behavior:

1. single SQL update with `WHERE id = ? AND status IN (?) AND (assignee_agent_id IS NULL OR assignee_agent_id = :agentId)`
2. if updated row count is 0, return `409` with current owner/status
3. successful checkout sets `assignee_agent_id`, `status = in_progress`, and `started_at`

`POST /issues/:issueId/admin/force-release` is an operator recovery endpoint for stale harness locks. It requires board access to the issue company, clears checkout and execution run lock fields, and may clear the agent assignee when `clearAssignee=true` is passed. The route must write an `issue.admin_force_release` activity log entry containing the previous checkout and execution run IDs.

## 10.5 Projects

- `GET /companies/:companyId/projects`
- `POST /companies/:companyId/projects`
- `GET /projects/:projectId`
- `PATCH /projects/:projectId`

## 10.6 Current-user Resource Memberships

- `GET /companies/:companyId/resource-memberships/me`
- `PUT /companies/:companyId/resource-memberships/me/projects/:projectId`
- `PUT /companies/:companyId/resource-memberships/me/agents/:agentId`

Request payload:

```json
{ "state": "joined" }
```

Allowed states are `joined` and `left`. Endpoints require a concrete board user and active company membership, reject agent API keys, and only mutate the caller's own sidebar visibility state. Joining/leaving is idempotent; missing rows read as `joined`.

## 10.7 Approvals

- `GET /companies/:companyId/approvals?status=pending`
- `POST /companies/:companyId/approvals`
- `POST /approvals/:approvalId/approve`
- `POST /approvals/:approvalId/reject`

## 10.8 Cost and Budgets

- `POST /companies/:companyId/cost-events`
- `GET /companies/:companyId/costs/summary`
- `GET /companies/:companyId/costs/by-agent`
- `GET /companies/:companyId/costs/by-project`
- `PATCH /companies/:companyId/budgets`
- `PATCH /agents/:agentId/budgets`

## 10.9 Activity and Dashboard

- `GET /companies/:companyId/activity`
- `GET /companies/:companyId/dashboard`

Dashboard payload must include:

- active/running/paused/error agent counts
- open/in-progress/blocked/done issue counts
- month-to-date spend and budget utilization
- pending approvals count

## 10.10 Error Semantics

- `400` validation error
- `401` unauthenticated
- `403` unauthorized
- `404` not found
- `409` state conflict (checkout conflict, invalid transition)
- `422` semantic rule violation
- `500` server error

## 10.11 Current Implementation API Addenda

The current app also exposes V1-supporting surfaces for:

- company-scoped summary slots for projects, the workspaces overview, project workspaces, and individual execution workspaces; execution-workspace slots are keyed by execution workspace id so a new workspace never inherits another workspace's summary
- issue thread interactions (`suggest_tasks`, `ask_user_questions`, `request_confirmation`, `request_checkbox_confirmation`, `request_item_verdicts`) with the open-default resolver contract in §9.8.1
- issue approvals, issue references/search, labels, read state, inbox/archive state, and work products
- task search uses shared PostgreSQL matching/ranking for company search and task-list quick search;
  all query terms contribute, quoted phrases stay literal, exact identifiers and direct title matches
  lead relevance ordering, and the UI preserves server result order (see `doc/SEARCH.md`)
- company search through `GET /companies/:companyId/search` plus agent-oriented bulk extraction through
  `GET /companies/:companyId/search/extract`; extraction accepts a server-escaped literal `contains`, optional
  server-owned URL expansion, issue/comment/document scopes, status/date filters, issue-level pagination, a
  bounded `matchesPerIssue` override for machine consumers, and explicit issue/match truncation flags
- execution workspaces, project workspaces, workspace runtime services, and workspace operations. Workspace reads
  derive `deliveryState` as `merged_via_pr | merged_by_ancestry | unmerged | unknown`; terminal issue trees with a
  merged delivery and no active checkout run become cleanup-eligible with reason `issue_terminal` and are archived
  through the workspace cleanup path. Reopening the source issue records activity but does not restore that workspace.
- task watchdog configuration and reusable watchdog issue orchestration for explicitly watched issue subtrees
- routines and scheduled/API/webhook triggers
- plugin installation, configuration, state, jobs, logs, webhooks, and plugin database namespace migration
- company import/export preview/apply, feedback export/vote routes, instance backup/config routes, invites, join requests, memberships, and permission grants
- company skill policy read/replace/reset/simulation, enforced by the same core evaluator used by skill mutation routes
- decision queues and per-attention-item triage:
  - `GET|POST /companies/:companyId/decision-queues`
  - `PATCH /companies/:companyId/decision-queues/:key`
  - `GET|POST /companies/:companyId/decision-queues/:key/items`
  - `DELETE /companies/:companyId/decision-queues/:key/items/:sourceKind/:sourceId`
  - `GET /companies/:companyId/decision-queue-seed-rules`
  - `GET|PUT /companies/:companyId/decision-triage/:sourceKind/:sourceId`
  - `PATCH /companies/:companyId/decision-retention/:sourceKind/:sourceId` (Keep)
  - `POST /companies/:companyId/decision-retention/:sourceKind/:sourceId/archive|revive`
  - `POST /companies/:companyId/decision-archive-proposals`

Queue and triage mutations accept board non-viewers and active standard-scope agents, apply responsible-user intersection for run JWTs, and reject low-trust, `task_bridge`, and `skill_test` contexts. Missing, cross-company, and unauthorized attention sources share the same not-found response.

The attention feed returns server-computed `shelf`, `retentionDays`, `keep`, `archivedAt`, and `retentionVersion` fields. Archived rows are excluded by default and selected with `archived=true`. Bulk archive proposals bind the exact source identities, per-item reasons, activity timestamps, and expected retention versions into the signed decisions-v1 target snapshots; acceptance re-authorizes both proposer and decider and commits all rows or none.

## 11. Heartbeat and Adapter Contract

## 11.1 Adapter Interface

```ts
interface AgentAdapter {
  invoke(agent: Agent, context: InvocationContext): Promise<InvokeResult>;
  status(run: HeartbeatRun): Promise<RunStatus>;
  cancel(run: HeartbeatRun): Promise<void>;
}
```

### Local adapter engine availability

For the legacy Codex, Claude, Gemini, and Kimi local adapters, an omitted engine
or legacy `auto` value selects ACP deterministically. Missing prerequisites or
ACP execution failures fail the run; they must not launch a different engine
with different session, permission, or sandbox semantics. CLI execution requires
explicit selection. Environment tests report the same engine availability error
as execution. Codex CLI defaults permit workspace writes and network access for
Paperclip coordination without disabling its sandbox; explicit operator
restrictions and execution-target network denials remain effective.

## 11.2 Process Adapter

Config shape:

```json
{
  "command": "string",
  "args": ["string"],
  "cwd": "string",
  "env": {"KEY": "VALUE"},
  "timeoutSec": 900,
  "graceSec": 15
}
```

Behavior:

- spawn child process
- stream stdout/stderr to run logs
- mark run status on exit code/timeout
- cancel sends SIGTERM then SIGKILL after grace

## 11.3 HTTP Adapter

Config shape:

```json
{
  "url": "https://...",
  "method": "POST",
  "headers": {"Authorization": "Bearer ..."},
  "timeoutMs": 15000,
  "payloadTemplate": {"agentId": "{{agent.id}}", "runId": "{{run.id}}"}
}
```

Behavior:

- invoke by outbound HTTP request
- 2xx means accepted
- non-2xx marks failed invocation
- optional callback endpoint allows asynchronous completion updates

## 11.4 Context Delivery

- `thin`: send IDs and pointers only; agent fetches context via API
- `fat`: include current assignments, goal summary, budget snapshot, and recent comments

## 11.5 Recovery Work Classes

Status-only recovery coordination must include guard context that prevents deliverable work and document or plan updates (`allowDeliverableWork: false`, `allowDocumentUpdates: false`, `resumeRequiresNormalModel: true`). Recovery work classes do not select or change the agent model.

Failed source-work retries, process-loss retries, transient or scheduled retries, max-turn continuations, source-assignee continuations, and downstream source-work child, requeue, or resume contexts use the agent's configured model. If status-only recovery repairs liveness while actual work remains, the next live continuation path must be a separate worker run.

## 11.6 Scheduler Rules

Per-agent schedule fields in `adapter_config`:

- `enabled` boolean
- `intervalSec` integer (minimum 30)
- `maxConcurrentRuns` integer; new agents default to `20`; scheduler clamps configured values to `1..50`

Scheduler must skip invocation when:

- agent is paused/terminated
- an existing run is active
- hard budget limit has been hit

Legacy execution records a renewable controller lease when claiming a queued run,
before provisioning. A live lease protects the run during overlapping service
deployments. An expired controller loses dispatch authority; a recovery worker
must establish that the previous execution stopped before starting a successor.

## 11.7 Durable agent session goals

Runner Protocol v2 negotiates a required `sessionGoals` capability and typed
`session.goal.*` commands and events. PRP v1 sessions remain supported and are
goal unsupported. The Codex app-server driver maps controls to
`thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`; it observes
provider-created goal notifications and reconciles with an authoritative get
after each turn. An active goal suppresses premature run terminalization while
autonomous turns continue. The Paperclip runner's persistent ACP backend opts
in through the `_session/goal` extension and advertises its exact action subset.
Its pinned Codex/Claude executables retain the runner's Linux x64 qualification
requirement. Direct `codex_local` and `claude_local` adapters currently have no
live goal controller and remain unsupported, even when their underlying ACP
package exposes goals. Goal actions never change an agent's adapter, model,
permission policy, or rollout settings to manufacture support. CLI, one-shot
ACP, and providers without the structured extension remain unsupported.

When a goal heartbeat settles, the runner suspends its durable authority even
under a warm lifecycle policy. Paused, blocked, completed, and rollover goals
must survive controller restart without relying on an in-memory warm owner.
The next run resumes the same provider session through the existing verified
checkpoint and authority-rotation path.

The board composer treats `/goal` as an action command rather than Markdown or
comment text. It is capability-aware, and the issue thread renders durable goal
status and controls immediately above the composer. Goal completion enters the
normal run-result/completion arbitration path and does not directly close the
issue.

## 12. Governance and Approval Flows

## 12.1 Hiring

1. Agent or board creates `approval(type=hire_agent, status=pending, payload=agent draft)`.
2. Board approves or rejects.
3. On approval, server creates agent row and initial API key (optional).
4. Decision is logged in `activity_log`.

Board can bypass request flow and create agents directly via UI; direct create is still logged as a governance action.

## 12.2 CEO Strategy Approval

1. CEO posts strategy proposal as `approval(type=approve_ceo_strategy)`.
2. Board reviews payload (plan text, initial structure, high-level tasks).
3. Approval unlocks execution state for CEO-created delegated work.

Before first strategy approval, CEO may only draft tasks, not transition them to active execution states.

## 12.3 Board Override

Board can at any time:

- pause/resume/terminate any agent
- reassign or cancel any task
- edit budgets and limits
- approve/reject/cancel pending approvals

## 12.4 Connection Tool Reviews

Ask-first connection calls use a server-owned tool-action confirmation linked to
the authoritative action request. The task feed retains a stable record; dismissal
only hides the composer takeover. Task and Connections decisions share one
transaction. Approval runs stored, signed arguments once; decline runs nothing.
The human decision remains distinct from provider execution success or failure.

Always allow remembers the same agent, connection, and action, restricted to the
current project when present, with future argument values permitted. Explicit
denials, revoked access, catalog-definition changes, and formal approval gates
remain effective. A durable continuation receipt resumes eligible task context
with the recorded outcome after the agent yields. Uncertain interrupted execution
is surfaced without automatic replay. See [Task reviews](connections/TASK-REVIEWS.md)
for contracts, recovery behavior, Storybook, and acceptance workflows.

## 13. Cost and Budget System

## 13.1 Budget Layers

- company monthly budget
- agent monthly budget
- optional project budget (if configured)

## 13.2 Enforcement Rules

- soft alert default threshold: 80%
- hard limit: at 100%, trigger:
  - set agent status to `paused`
  - block new checkout/invocation for that agent
  - emit high-priority activity event

Board may override by raising budget or explicitly resuming agent.

## 13.3 Cost Event Ingestion

`POST /companies/:companyId/cost-events` body:

```json
{
  "agentId": "uuid",
  "issueId": "uuid",
  "provider": "openai",
  "model": "gpt-5",
  "inputTokens": 1234,
  "outputTokens": 567,
  "costCents": 89,
  "occurredAt": "2026-02-17T20:25:00Z",
  "billingCode": "optional"
}
```

Validation:

- non-negative token counts
- `costCents >= 0`
- company ownership checks for all linked entities

## 13.4 Rollups

Read-time aggregate queries are acceptable for V1.
Materialized rollups can be added later if query latency exceeds targets.

## 14. UI Requirements (Board App)

V1 UI routes:

- `/` dashboard
- `/companies` company list/create
- `/companies/:id/org` org chart and agent status
- `/companies/:id/tasks` task list/kanban
- `/companies/:id/agents/:agentId` agent detail
- `/companies/:id/costs` cost and budget dashboard
- `/companies/:id/approvals` pending/history approvals
- `/companies/:id/activity` audit/event stream

Required UX behaviors:

- global company selector
- quick actions: pause/resume agent, create task, approve/reject request
- conflict toasts on atomic checkout failure
- no silent background failures; every failed run visible in UI

## 15. Operational Requirements

## 15.1 Environment

- Node 24.11+
- `DATABASE_URL` optional
- if unset, auto-use embedded PostgreSQL under `~/.paperclip/instances/default/db`

## 15.2 Migrations

- Drizzle migrations are source of truth
- local/dev startup applies pending migrations automatically where supported
- `pnpm db:migrate` applies pending migrations manually
- no destructive migration in-place for V1 upgrade path

## 15.3 Logging and Audit

- structured logs (JSON in production)
- request ID per API call
- every mutation writes `activity_log`

## 15.4 Reliability Targets

- API p95 latency under 250 ms for standard CRUD at 1k tasks/company
- heartbeat invoke acknowledgement under 2 s for process adapter
- no lost approval decisions (transactional writes)

## 16. Security Requirements

- store only hashed agent API keys
- redact secrets in logs (`adapter_config`, auth headers, env vars)
- CSRF protection for board session endpoints
- rate limit auth and key-management endpoints
- strict company boundary checks on every entity fetch/mutation
- restricted `skill_test` and `task_bridge` keys cannot enumerate company-wide run telemetry, workspace-operation logs, or the company secret catalog
- HTTP adapters use DNS-pinned outbound requests, reject redirects and link-local/metadata targets, and require an exact server-owner origin allowlist for private destinations
- external instruction bundle roots and exports that read them require instance-admin access; managed company-scoped bundles remain available through normal company authorization
- agent-authenticated callers cannot persist host-executed workspace commands, and restricted keys cannot invoke preconfigured workspace runtime controls

## 17. Testing Strategy

## 17.1 Unit Tests

- state transition guards (agent, issue, approval)
- budget enforcement rules
- adapter invocation/cancel semantics

## 17.2 Integration Tests

- atomic checkout conflict behavior
- approval-to-agent creation flow
- cost ingestion and rollup correctness
- pause while run is active (graceful cancel then force kill)

## 17.3 End-to-End Tests

- board creates company -> hires CEO -> approves strategy -> CEO receives work
- agent reports cost -> budget threshold reached -> auto-pause occurs
- task delegation across teams with request depth increment

## 17.4 Regression Suite Minimum

A release candidate is blocked unless these pass:

1. auth boundary tests
2. checkout race test
3. hard budget stop test
4. agent pause/resume test
5. dashboard summary consistency test

## 18. Delivery Plan

Current implementation note: the milestones below describe the original V1 sequencing. Several systems originally framed as future work have since shipped or advanced materially, including issue documents/interactions, blockers, routines, execution workspaces, import/export portability, authenticated deployment modes, multi-user basics, and the local/self-hosted plugin runtime.

## Milestone 1: Company Core and Auth

- add `companies` and company scoping to existing entities
- add board session auth and agent API keys
- migrate existing API routes to company-aware paths

## Milestone 2: Task and Governance Semantics

- implement atomic checkout endpoint
- implement issue comments and lifecycle guards
- implement approvals table and hire/strategy workflows

## Milestone 3: Heartbeat and Adapter Runtime

- implement adapter interface
- ship `process` adapter with cancel semantics
- ship `http` adapter with timeout/error handling
- persist heartbeat runs and statuses

## Milestone 4: Cost and Budget Controls

- implement cost events ingestion
- implement monthly rollups and dashboards
- enforce hard limit auto-pause

## Milestone 5: Board UI Completion

- add company selector and org chart view
- add approvals and cost pages

## Milestone 6: Hardening and Release

- full integration/e2e suite
- seed/demo company templates for local testing
- release checklist and docs update

## 19. Acceptance Criteria (Release Gate)

V1 is complete only when all criteria are true:

1. A board user can create multiple companies and switch between them.
2. A company can run at least one active heartbeat-enabled agent.
3. Task checkout is conflict-safe with `409` on concurrent claims.
4. Agents can update tasks/comments and report costs with API keys only.
5. Board can approve/reject hire and CEO strategy requests in UI.
6. Budget hard limit auto-pauses an agent and prevents new invocations.
7. Dashboard shows accurate counts/spend from live DB data.
8. Every mutation is auditable in activity log.
9. App runs with embedded PostgreSQL by default and with external Postgres via `DATABASE_URL`.

## 20. Post-V1 Backlog (Explicitly Deferred)

- cloud-grade plugin marketplace/distribution
- richer workflow-state customization per team
- milestones/labels/dependency graph depth beyond V1 minimum
- realtime transport optimization (SSE/WebSockets)
- public template marketplace integration (ClipHub)

## 21. Company Portability Package (V1 Addendum)

V1 supports company import/export using a portable package contract:

- markdown-first package rooted at `COMPANY.md`
- implicit folder discovery by convention
- `.paperclip.yaml` sidecar for Paperclip-specific fidelity
- canonical base package is vendor-neutral and aligned with `docs/companies/companies-spec.md`
- common conventions:
  - `agents/<slug>/AGENTS.md`
  - `teams/<slug>/TEAM.md`
  - `projects/<slug>/PROJECT.md`
  - `projects/<slug>/tasks/<slug>/TASK.md`
  - `tasks/<slug>/TASK.md`
  - `skills/<slug>/SKILL.md`

Export/import behavior in V1:

- export emits a clean vendor-neutral markdown package plus `.paperclip.yaml`
- projects and starter tasks are opt-in export content rather than default package content
- recurring `TASK.md` entries use `recurring: true` in the base package and Paperclip routine fidelity in `.paperclip.yaml`
- Paperclip imports recurring task packages as routines instead of downgrading them to one-time issues
- export strips environment-specific paths (`cwd`, local instruction file paths, inline prompt duplication) while preserving portable project repo/workspace metadata such as `repoUrl`, refs, and workspace-policy references keyed in `.paperclip.yaml`
- export never includes secret values; env inputs are reported as portable declarations instead
- export preserves explicit company skill policy and retained legacy skill grants in `.paperclip.yaml`; absence of policy remains the open default
- import supports target modes:
  - create a new company
  - import into an existing company
- import recreates exported project workspaces and remaps portable workspace keys back to target-local workspace ids
- import forces imported agent timer heartbeats off so packages never start scheduled runs implicitly
- import supports collision strategies: `rename`, `skip`, `replace`
- import supports preview (dry-run) before apply
- import preview reports skill-policy and legacy-grant mappings before apply and rejects unknown policy schema versions
- GitHub imports warn on unpinned refs instead of blocking

## Agent visual identity

Agent appearances are stable, versioned ClipLab end-cap personas, separate from
behavioral instructions. Compact surfaces use on-demand cached PNG URLs; larger
placements may use a lazy live character. See [agent-personas.md](agent-personas.md)
for persistence, migration, rendering, and integration contracts.
### Experimental task-backed agent chat (2026-09-10)

`enableAgentChat` is an instance experimental flag, default false. Conversation containers remain issues, unique by `(company_id, conversation_agent_id, conversation_user_id)`. The authenticated board actor supplies ownership; local trusted mode uses `local-board`. Ordinary company task access applies. A conversation's agent assignment and identity are immutable through ordinary updates; terminal status mutations are rejected.

`GET /api/companies/:companyId/chats/:agentRef` reads an existing conversation or null. `POST` atomically resolves its issue on first send/upload. Existing issue comment, attachment, document, interaction, and run APIs apply thereafter. User chat comments require an idempotent UUID `clientRequestId`. Conversation delivery preserves comment order through the existing issue execution queue; the durable comment outbox repairs the commit-to-enqueue crash window.

The server owns conversation state: `waiting` plus `in_review` denotes a healthy idle conversation, and `active` denotes an unanswered or executing turn. Successful replies settle a turn; they do not finish the issue. Idle containers are excluded from execution-work counts, ordinary task lists, timer work, and recovery invocations. Failed/unanswered turns retain normal handling. Child completion never wakes or completes the conversation. Search and direct task access preserve history.

Standalone `/new` is an ordered queue command with no model response. It advances a durable session generation and boundary comment, resets only this issue's provider context, and preserves the issue ID and history. Generation checks reject stale context writes and replies. Fresh replay excludes earlier messages and summaries. The shared transcript renders a session divider.

Chat prompts retain agent instructions and tools while directing clarification and task creation. Substantial execution belongs to linked, assigned ordinary issues. Ask mode remains non-mutating. Feature disablement prevents new turns and resets while retaining data and lifecycle protection; already-running turns may settle normally.

### Agent chat project handoff (2026-09-11)

Chat supports research and full plan drafting/revision in its existing plan document. On handoff, each ordinary assigned task receives the relevant plan in its own `plan` document, committed with task creation before execution is scheduled. The source plan remains in the conversation. Plan acceptance hands off execution; it never switches the conversation into implementation.

Chat instructions require selecting a suitable project, reusing an existing one where appropriate. The project requirement is prompt-only; ordinary projectless tasks remain supported. New parent relationships beneath conversation tasks are rejected by task services, including direct API creation and reparenting. Existing children remain readable/editable and can be moved elsewhere. The Subtasks panel is unchanged.

The `create_project` runtime tool uses the normal project API with durable idempotency. `list_projects` and `list_project_repositories` support selection. Multiple `repositoryIds` select authorized catalog entries; multiple HTTPS GitHub `repositoryUrls` register existing repositories absent from the catalog. IDs and URLs may be combined, but cannot accompany an explicit `workspace`. URLs do not create repositories on GitHub or grant credentials. Execution uses normal repository access rules. Repository IDs are revalidated against the authenticated run's responsible user and connection grants. Agents should consider proper available repositories, clarify material ambiguity, and use repository-free projects when appropriate for non-code work.

Confirmed project creation appears as a durable card in the shared task transcript, including selected repository links. Tasks are linked inline. Failed creation never produces a success card. Tool evals cover planning/handoff, project/repository selection, retries, permission and mode denials, and ordinary delegation regressions using the production chat directive.

### User continuation after execution recovery stops

An authenticated user message or an exact failed-run Retry can start a fresh
native or legacy conversation turn once the prior execution is confirmed stopped. Retain the source history and uncertain
action outcomes; do not replay tool calls or reset the failed incident's automatic
retry budget. Existing pause, approval, budget, ownership, and dependency gates
remain in effect. See `doc/execution-semantics.md` for admission and stop-proof
requirements.

### Managed AI authentication

AI credentials can be adopted into the existing Connections system. A typed
`runtimeConfig.aiConnection` selects the responsible user’s personal default, an
explicit shared grant. The existing human-audience and agent-access permissions
apply; AI credentials have no separate agent-delegation exception. Selection preserves
harness/model routing and fails closed without ambient credential fallback.
Legacy agents retain their authentication until validated adoption. See
[AI Connections](connections/AI-CONNECTIONS.md) for company isolation, compatible
methods, lifecycle, runtime enforcement, and migration details.
### Experimental task-bound email

AgentMail channel connections extend the experimental conversation/task pipeline
with explicit email publication. Each owned inbox/provider thread binds one task;
external email senders do not gain board authority. Incoming correspondence uses
the assigned agent's normal execution controls. Internal task activity never
implicitly sends email. New outgoing conversations create child tasks and durable
send intents before provider contact. The board directs email work through the
normal task conversation; rich email cards show the correspondence and delivery
outcomes without a separate email composer. See
[AgentMail connections](connections/AGENTMAIL.md) for setup, transports, recovery,
authorization, and the API/CLI contract.

### Experimental iMessage Photon channel

A Photon Cloud project can represent one agent through the existing
experimental channel subsystem. DMs and explicitly enabled groups create or
continue task-bound conversations. Linked sender identity is the default;
telephone numbers, email addresses, names, and group membership do not grant
Paperclip authority. Photos/files and ordinary questions/confirmations use the
existing attachment, interaction, continuation, and publication contracts.
Pause and Disconnect govern runtime behavior independently of the UI gate.
Local Mac access, unsolicited conversations, and SMS/RCS
fallback are excluded. Live qualification is required before release readiness.
Pro shared allocation supports DMs only, with sender enrollment in Photon and
separate identity linking in Paperclip. Shared channels reserve one project, not
a pool phone number; group admission and publication are disabled. Dedicated
allocation retains one selected number and individually enabled groups.

iMessage task completion ends a turn, not its conversation. Subsequent messages
reopen the same task, including after restart; only explicit `/new` or `/close`
allows the next message to start another task. The open task receives committed
inbound comments live, with “Sent from iMessage” attribution on user bubbles.

See [iMessage Photon](connections/IMESSAGE-PHOTON.md) for the implementation
contract, setup, recovery, boundaries, and qualification status.

### Native task completion

For ordinary low-risk tasks, accept the current agent's structured `done` claim
subject to explicit workflow constraints. Missing independent evidence or a
`needs_review` label alone must not create a human approval. Require a concrete
reviewer decision for a new review request. Keep unfinished work with the agent,
with bounded continuation and visible recovery. Preserve explicit approvals,
current task ownership, cancellation, dependencies, and newer task state. See
`doc/architecture/native-status-arbitration.md` for finish feedback and the
provenance-checked cleanup of historical automatic completion reviews.

### In-app announcements

A versioned remote JSON manifest supplies one optional board announcement.
The instance validates/caches content, proxies its raster image, and stores
user-scoped dismissals. Closing or following an action dismisses the ID; copy
edits retain it. Writes are board-only, idempotent and transactionally audited
using an authorized company's context. Viewers may dismiss their own card.
This is an explicit exception to company-scoped business entities: the
preference follows one account across companies on the instance. A separate
instance-level registry retains validated publication IDs, allowing offline
dismissal retries after withdrawal while rejecting caller-invented IDs. It
stores no announcement content, account data or interaction events.
See [Announcements](ANNOUNCEMENTS.md) for API and publishing details.


## DSP7 managed conversation resource (2026-10-21)

Managed local Claude conversations are separate company-scoped resources, not issue comments or generic heartbeat logs. Only the snapshotted execution owner and organization/instance administrators may read bodies; issue access alone does not grant conversation access. Device-key writes require the enrolled machine identity, a real run/task binding and contiguous, digest-checked stream receipts. Deletion retains a tombstone and removes all content parts/projections. Conversation bodies must not enter first-party telemetry, crash reporting, generic HTTP errors, search or run summaries.

Protocol v1 supports redacted visible text, tools, subagents and UTF-8 attachments. Unsupported binary attachments carry an explicit unavailable reason. Phase observation is not gate completion. Task facts, heartbeat spans and explicit Jira links support period reports without fabricating historical time or quality baselines. See [implementation design](plans/2026-10-21-managed-session-observability.md) and [implementation scope](plans/2026-10-21-managed-session-implementation.md) for limits and release prerequisites.


## DSP7 集成更新（2026-10-22）：统一平台派单

新增执行统一由智研平台项目页的“派单并执行”发起；Jira 指派只参与校验，不再扫描建单或触发执行。平台独立审计授权，客户端持久领取、排队并打开本机可见终端；仅登记仍等待本人启动。未明确派单的旧任务不自动开工。实现与兼容边界见 `doc/plans/2026-10-22-platform-dispatch.md`。


## DSP7 中断会话恢复（2026-10-22）

显式恢复本机出站会话时，已认证席位上报的停止证明须在派单事务内写入旧运行的停止确认；以旧运行不可变的 Claude 适配器身份、终止状态、席位/任务/组织归属、当前心跳及环境清理结果校验，保留未知操作结果与其他执行保护。不能仅将任务置回 backlog。

## DSP7 席位时间统计（2026-10-22）

席位统计保留工单、执行、人工等待、在线空闲和质量数据，移除“未知时长”和时间“覆盖率”的页面展示；仅增加“工作时段在线”辅助列，不设在线率、达标率或排名。在线以服务端收到的席位心跳为依据，有效期 90 秒，与执行状态、暂停接单无关；只累计 Asia/Shanghai 工作时段内截至当前的连接区间，席位创建前不计入，人员多电脑取并集。没有心跳证据的工作区间标记“统计不完整”，可展开查看，不推算成离线或人员工时。

工作规则按组织持久保存，管理员通过统计区默认折叠的“工作时段设置”配置 ISO 工作日（周一为 1、周日为 7）及最多四个同日、不重叠的时间段。默认周一至周五 09:00–12:00、13:00–18:00；修改规则后历史查询也按新规则计算。本期不含法定节假日日历、请假审批或免考核模块。`PUT /api/companies/:companyId/managed-seat-report/work-schedule` 要求组织管理员权限、组织访问校验并在同一事务记录活动日志；报表返回实际规则与配置权限。旧 API 的时间缺口字段保留用于诊断兼容，界面不展示。


## DSP7 明确停止与一次真实重试（2026-10-23）

网页停止或 `harness stop <Jira 工单号>` 留下持久停止意图，先记录再取消／发信号；离线意图与下次席位心跳一起同步。Esc、Ctrl+C 和未知退出码不证明用户停止整个任务。明确停止后必须人工恢复；晚到的明确停止也会阻断尚未启动的自动重试。

新版客户端发起的本机出站 Claude 运行在未知失败、超时或断连后，可在已有平台授权下自动重试一次。必须先核验最新运行的真实停止证明、席位空闲、环境已释放、组织与负责人归属及所有原有执行保护。原子记录新派单授权，交由本机重新核验 Jira、锁与预算门禁并打开可见终端；每次显式派单／恢复仅有一次机会。历史运行不追溯启动。通用唤醒不创建本机执行意图；缺少真实启动时返回失败，不能冒充成功。页面区分准备自动重试与运行中，审计保留未知操作结果。


## Jira 主需求与 Harness 协同（2026-10-24）

Jira 主需求作为交付协调容器，负责人取研发负责人字段；子单各自保留真实身份与经办人。旧版仅工作单模式由研发 Harness 编码技能同时处理关联代码评审。启用阶段内独立评审顺序后，平台显式绑定并调度真实评审子单，工作席位不得代执行已委派的评审子单。设计及用例人工评审沿用正式领域流程；QA 子单不能交由研发执行通道冒充执行。当前实现范围、权限和未完成项见 [主需求交付协同整改](plans/2026-10-24-jira-requirement-delivery.md)。

## 2026-10-25 条目纳管增量

条目交付首批提供按公司/项目隔离的只读手工快照纳管；来源结构、差异、版本与采集时间可在网页核对。保存快照不创建执行授权。在线同步、独立分析/评审/QA 编排仍以功能实现和预算治理验收为开放前提。具体行为及边界见 `doc/plans/2026-10-25-delivery-readonly-implementation.md`。


## 管理工作台与交付核验（2026-10-27）

组织首页按工单给出互斥的管理结论：需要处理与核实、已确认执行、待安排与调度。业务状态 `in_progress` 本身不证明进程正在运行；停止记录、当前席位心跳、离线和读取失败分别展示。待处理中心按工单合并提醒，显示处理负责人、证据时间与下一步，并保留原审批和历史通知入口。通知已读或归档不表示问题解决。

管理员默认组织概览，其他成员默认我的工作；个人范围包含直接指派及当前指派给本人席位的工单。范围偏好仅保存在当前浏览器，按账号与组织隔离，URL 显式范围优先；组织权限仍由原 API 执行。首页跳转保留项目与范围，工单列表沿用相同的管理结论。

月度排期在整月结果上组合来源条件、风险筛选和排序，再分页。计划已过、本周到期按上海时区计算，责任人缺失、准入待核验和日期缺失独立标记；无效日期排在有效日期之后。这些信号不认定正式延期、准入通过或验收完成。“正常条目”统计并筛选未命中任何上述风险信号的条目，与其他来源筛选组合使用，不表示正式验收通过。条目责任人仅取轻舟需求拆分人员（`splitter_show`），该字段缺失或仅含空白时标记责任人缺失，不以研发负责人或经办人兜底。月度排期接口未提供该字段时，按条目编号精确查询条目后读取拆分人员；同次读取按条目去重、最多四路并发，查询失败应报错，不伪装成责任人缺失。

项目准备区区分已保存配置与实际连接验证；席位接单准备缺项不授予逐单执行权限。执行记录用工单、席位、负责人和失败摘要提供上下文，仅搜索最近 50 次运行，关联元数据未完整时明确提示。列表不读取受管会话正文。

条目材料按 Jira 主工单分组，在各自子工单下展示产物路径、指纹、正式材料链接和评审／测试结论。经核对的历史 Jira「结果描述」单独列为结论证据。阶段回执必须匹配当前任务、运行、Jira 工单与输入版本，设计和测试用例还需匹配当前回执版本的正式评审；分析材料按独立修订按需读取。阶段交付与正式验收分别展示。费用、会话缺口与未分类任务保留数据质量说明，不以未知计零，不虚构延期率或人员绩效归因。

### Management coordination follow-up (2026-10-30)

`GET /api/companies/:companyId/management-follow-ups?issueIds=...` reads up to 100 issue-scoped coordination records. `PUT /api/companies/:companyId/management-follow-ups/:issueId` accepts `expectedVersion` and an owner and/or reminder change. Records are company-scoped sidecars; they never change issue assignment, status, execution authorization or formal decisions. Reads require source-issue read authorization; writes require source-issue mutation authorization. Members may claim unowned work or release their own work. Managers may transfer to active non-viewer company users. Releasing ownership clears the reminder. Reminders are local display state, not notification delivery receipts. Changes increment a version under the source issue lock and commit with their activity log; stale updates return 409.

Delivery stages permit at most three explicit operator resumes. Legacy stage records start at zero; each resume atomically increments the persisted counter, changes dispatch identity and clears prior receipt/review state. The limit does not reset on a process restart. Reaching the limit returns 409 and requires human diagnosis and replanning. A resume still requires the prior process-tree stop receipt and does not itself dispatch an agent. This bound is not an automatic defect repair loop.

Stage artifact indexes may include `downloadUrl` only for Jira attachment bytes read back by the enrolled device and matched to the artifact SHA-256. Server validation restricts these links to the receipt Jira origin and `/secure/attachment/:id/:filename`, without embedded credentials, queries or fragments. The UI shows a download action for those references and explicitly labels fingerprint-only entries. Download access uses the operator's Jira session. Legacy receipts remain valid without a download URL; a fingerprint alone is not proof of a remotely available file.

Delivery task reports include observed phase timing segments, clipped to the report window and the session lifetime. Time before a phase event remains unclassified. Execution state is bounded by the existing observation validity window; gaps remain unknown. Each phase reports execution, waiting and unknown milliseconds. Concurrent sessions can overlap across phases, so phase durations must not be summed as wall-clock task duration. Run-scoped token totals are not apportioned by elapsed time; phase token attribution is explicitly unavailable until a trustworthy phase-scoped metering source exists.

交付 Bridge 对存在 `Jira确认.当前` 的原生门禁，冻结回执前必须只读重新读取当前 Jira 工单的完整评论分页；最多 1000 条且每页不超过 2 MB，分页不完整时阻断。复用所登记 Harness 的 `jira_confirmation.py` 判定经办人、确认编号、请求时间和最新回复，在临时副本上运行解析，不改写原生状态或进度。最新结论必须仍为批准，回复评论 ID、原文、评论时间、评论人必须与本地已确认版本一致；评论删除、编辑、替换或后续拒绝均使当前交付失效。没有原生确认记录时不凭空创建确认，也不能据此声称正式验收完成；网页人工核验记录仍单独标记为人工声明。

依赖阶段启动模型前，Bridge 必须使用本机登记领域的 Jira 凭据，以禁止重定向的只读请求重新下载上游回执中带下载引用的正式附件，并逐个比较已冻结 SHA-256；跨来源、非正式附件路径、参数／凭据、空内容、超出 10 MiB、不可访问或指纹变化均阻断。旧回执只有指纹而没有任何可回读附件时要求重新核验，不默认为有效。未提供下载引用的条目仍明确为仅指纹，不宣称已核验其原件；分析发布沿用独立修订协议。

功能测试回执新增可选兼容字段 `testResults`；新提交的功能测试回执必须提供该字段，其他阶段不得提供。字段绑定原生 `证据` 中的用例总数及通过／失败／阻塞／跳过数、明确的 `环境信息.被测版本`、`execution-records.md` 的路径与 SHA-256。Bridge 对账逐条记录与原生计数，拒绝未知结果、重复用例、记录版本变化和计数缺失；服务端校验汇总与回执产物指纹。流程只有全部用例通过才自动进入待验收；失败、阻塞、跳过或旧回执缺少结果均转阻塞，保留报告及未完成任务，不自动重跑有副作用的测试，也不将报告完成等同测试通过。带缺陷上线及豁免不由此自动批准。

功能测试失败按项目策略复用原编码、原代码评审和原功能测试工单返工。保留原任务、原生工作流和执行席位；每轮仅生成新派发和运行、归档旧证据，经预算、权限、真实 Jira 身份及进程退出核验后继续。原编码按 coding/feature 工作流修改，原代码评审及功能测试按原流程复审/回归，不切换为新的 bugfix、修复或重测工单身份。

每个修复环节输入绑定原失败回执及上游交付指纹。独立评审必须有原生 `评审结果=passed`、`交付状态=completed`、真实 Jira 完成核验、非空被审版本及已索引评审报告；其回执绑定被审版本指纹和报告指纹，修复席位不能代交评审回执。重测仍须逐条对账及全部通过，之后才进入待正式验收。失败证据和原平台任务保留，可从修复历史访问；根据实例已固定的返工授权自动或人工办理，最多三轮，不新建执行任务。缺环境、记录不完整、跳过或缺少失败证据不自动转成产品缺陷。已有原生 completed 历史不能直接改标签重跑；须按原生流程核对和恢复，不手改原生状态跳阶段。


## Harness 管理执行仓库（2026-11-03）

席位接单规则只约束平台项目、Jira 项目、工单类型和允许状态，不要求配置或选择平台共享仓库。新 Jira 接入申请使用版本 4，不携带 workspace_id，任务不绑定 projectWorkspaceId，并禁用平台项目工作区选择。本机接入桥核验身份、Jira、派单授权并取得原有独占登记后，从已登记的 Harness 根目录启动原生会话；工单涉及的一个或多个仓库、目录、分支和 Git 工作树完全由 Harness 套件及其技能管理，平台不扫描业务仓库、不匹配 origin、不创建或核验业务工作树。领域完成状态、工程确认、交付证据、tracker/Jira 回执与原有执行权、预算、停止保护继续核验。

新版客户端上报 `harness-repository-management-v1`；新协议的派单和执行登记要求该能力。旧客户端先更新；已有登记及运行保持原模式，不自动修改旧工作树或重放任务。旧接入申请保持可读，版本 2/3 原始授权内容与独占记录保留。首次安装及恢复接入不再要求绑定项目本机仓库。此规则仅改变 DSP7 本机 Harness 席位执行，不删除其他适配器使用的原生项目仓库功能。


### Instance personnel federation (2026-11-04)

Personnel identity sources, external people, departments and sync jobs are shared
across the instance and managed only by instance administrators. Sync once per
enterprise; organizations reuse that directory through explicit membership
assignment. Synchronization and identity linking do not create organization
memberships or grant roles. Existing accounts, passwords, memberships and seat
ownership are preserved. Notification recipients use the shared active DingTalk
directory and must match the bot CorpId; organization membership is not required.
Selecting a recipient does not grant organization access. Bot configuration, seat
policies and audit records remain company-scoped.
The system directory is an explicit exception to company-scoped domain storage;
organization permissions and execution remain isolated.


### 轻舟需求分析阶段状态（2026-11-04）

需求条目交付页的需求分析阶段以轻舟条目级分析与评审事实展示，不能由 Jira 分析子工单数量或平台分析任务是否存在推断“待安排”。在线同步通过 `UC_PROJ2_DEMAND_DETAIL` 采集当前条目状态、分析内容是否已保存及各评审环节原始状态。平台分析执行状态独立展示；来源保存分析、下游待开发或单个评审环节通过均不自动授予开发准入或正式交付核验。旧快照缺少详情时显示“待核对”，重新同步后生成包含详情的新版本。

### Delivery template contract (2026-11-05)

`delivery_workflow_templates` stores company/project-scoped publication history. `GET/POST /api/companies/:companyId/delivery-templates` resolves/publishes templates. Publication requires organization manager access, company-valid projects/seats and active reviewer membership. `expectedRevision` guards concurrent edits; project inheritance is restored by publishing `definition.inheritOrganization: true`. Organization templates cannot inherit themselves. No configuration means the built-in design-review/parallel-coding template. Reads never publish or dispatch.

Workflow creation resolves the server template, rejects stale `expectedTemplate`, and pins the full template in workflow config. Enabled phases become a dependency graph. Multiple coding tasks bind separate real Jira children and explicit seats; parallel phases join before QA, while legacy rows without dependency fields retain serial semantics. Different seats can run concurrently; another unfinished branch on the same seat queues until business evidence and process-stop proofs are complete. `/confirm-start` and `/retry` identify stages by taskId. Template reviews are restricted to the pinned reviewer (seat owner or specified active member), including when another actor is an administrator. The current receipt digest and upstream dependencies remain mandatory. Context supports workflows without analysis and includes transitive ancestors rather than unrelated parallel branches.

Notifications follow each waiting stage's existing seat policy, including personal/group routing and seat-owner mentions. Disabling template waiting notifications suppresses these reminders, not execution gates. Existing source fingerprint, native route, budget, ownership, lease, code-review evidence, functional-test results and process-exit gates remain. Final acceptance is always human. Existing instances are not silently adopted into a new template or restarted.

### 阶段内工作与评审顺序（2026-11-05）

交付模板的设计、编码、用例编写阶段可配置 `taskSequence: work_only | work_then_review`，以及独立代码评审默认 `reviewSeatId`。未配置字段的旧模板保持原行为。内置 v2 模板采用设计单 → 负责人设计评审、并行编码单 → 独立席位代码评审、用例编写单 → 负责人用例评审；配置页预览阶段内顺序。

启动时 `reviewTasks` 显式绑定同一真实主单下的评审 Jira 子单及 `workKeys`。每个工作单恰好关联一个评审单，可多个工作单共享评审。代码评审席位必须与全部被审工作席位不同。评审仅在关联工作全部完成后激活，下一阶段等待上一阶段所有工作及评审通过。设计／用例评审由指定负责人处理，平台不伪造席位执行回执；审批绑定来源版本、前置产物摘要、当前负责人和正式评审 Jira 链接，过期结论不能放行。最终验收仍由人工完成。

独立顺序要求设备登记能力 `delivery-work-review-v1`；旧客户端需更新并刷新登记。工作席位收到已委派评审清单，保留技术自检但不能代处理独立评审工单。现存流程仍固定原模板，不自动改写或重新启动。

### 交付链人工／Agent 执行配置（2026-11-05）

设计、编码、用例编写和功能测试工作单分别支持 `workExecution: human | agent`；设计、代码和用例评审单分别支持 `reviewExecution`。可为人工工作及评审指定 `workExecutorUserId`、`reviewExecutorUserId`，均限当前组织活跃成员；未指定则沿用所选席位负责人／原审核人。人工执行不要求设备或 Harness；需求分析仍沿用独立分析与正式发布协议，最终验收仍为人工。旧模板字段缺省时保持既有执行语义。

人工节点分派给用户，前置通过后进入待处理，不唤醒设备。正式完成登记绑定来源指纹、前置交付摘要、真实 Jira 子单和指定执行人。工作单须登记交付版本及正式材料引用，功能测试须登记可对账的全部通过计数；失败、阻塞或跳过不能放行。人工交付证据参与后续版本摘要与 Agent 上下文，不伪造设备回执。

Agent 节点仍要求对应领域原生能力、租约、进程停止和正式交付证据，混合执行要求客户端 `delivery-executor-v1`。设计／用例 Agent 评审新增 `design-review`／`test-case-review` 能力；必须同时安装原生评审技能及 `harness/delivery-review-protocols.json` v1 声明，设备守卫需支持真实评审工单和工作流，报告须含通过结论、被审版本和正式完成核验。当前旧 Harness 没有该协议时无法接单，配置页明确提示且不得静默改派或冒充工作单执行。

### 评审退回与多轮返工（2026-11-05）

交付链阶段支持 `rejectionHandling: automatic_rework | pause`。内置 v3 默认设计、编码、用例评审退回后自动交回原执行人；旧版本缺省仍暂停，已启动流程固定原配置。人工评审必填正式结论链接及具体修改要求；自动模式等待受影响旧运行和进程树停止核验后，重开被明确绑定的原工作单及其依赖闭包，保留无关并行分支。共享评审退回时重开其全部绑定工作单。原席位／人工负责人、启动确认、原生能力与预算门禁继续生效；每轮采用新派发编号和绑定退回意见的输入摘要，修改后重新送审，当前版本通过前不推进后续阶段。

`reworkHistory` 保存每轮退回意见、正式引用、操作人、时间及旧交付、原评审证据；旧通过结论不能用于新版本。人工返工交付不能复用历史版本号；Agent 返工必须具有新原生状态及更新的正式附件，旧 completed 状态和旧材料不能重新包装成新交付。设备须支持 `delivery-rework-v1`；按 Harness 原生恢复／重开协议处理，不支持时请求负责人处理，禁止手改原生状态跳门禁。暂停模式由原评审人或组织管理员对当前退回摘要确认发起返工。最终仍须人工验收。

独立设计／用例 Agent 评审的原生执行须绑定真实评审子单及当前输入摘要、被审工作单集合；通过结论只能用于该版本。平台退回重开须保留原统计来源和 metrics_generation，归档旧证据并撤销旧统计确认；新一轮材料与统计均须独立回读。仅统计文件变化不能充当返工材料更新；缺少真实人工开始/结束事件时不估算网页审核人工投入。原生适配实现及验证边界见 doc/plans/2026-11-05-delivery-review-zhiyan-fix.md。

本机客户端更新（2026-11-05）：由当前操作系统用户执行 `harness upgrade` 时，统一更新同一网站的各组织席位，保留独立身份与配置。先检查全部目标空闲，每个席位更新前再次检查；中途失败保留完成与剩余记录，由用户重试。网页管理员升级仍限已授权席位，不扩大到其他组织；发布新包不触发升级。

### 席位并发执行（2026-11-05）

席位并发上限保存在既有 `runtimeConfig.heartbeat.maxConcurrentRuns`，通过公司范围的 `/api/companies/:companyId/dsp7-seats/:id/concurrency` PUT 设置，负责人或管理员授权、行锁复核并写活动审计。范围 1–50，默认 1；超过 1 要求主动连接及 `seat-concurrency-v1` 能力。调度器、终端请求领取与执行许可共同限流，同一工单仍不得重复执行。待执行请求持久排队，开始本机确认后保留原超时保护；已有任务不因降低上限中断。执行许可释放仍要求原进程退出／进程树证明，其他活跃工单可在剩余名额内执行。心跳 `activeRuns` 展示各工单的运行及等待状态，保留旧单工单字段兼容旧客户端。详见 `doc/seat-concurrency.md`。


### 交付链开始节点准入（2026-11-06）

条目准入按所选交付模板的首个启用阶段判断，与后续编码准入分开。开始节点的 `entryChecks` 可勾选标题、需求拆分人员、Jira 主工单、开始节点工单、来源结构一致、正式分析结论、正式设计评审结论、启动配置中的测试环境与待测构建引用，所有选中条件必须满足。分析节点直接使用需求条目，不要求预先存在编码单或设计通过结论；仅配置在后续节点的检查项不参与入口判断。内置 v4 不预选业务准入条件，由管理员按实际链路选择并发布。

未配置检查项的旧模板显示“未配置准入”，新建流程前必须配置；新发布的非继承模板必须为开始节点至少选择一项。历史模板可正常读取，已启动流程固定原模板并显示“已准入”，不会因后续阶段阻塞或新模板发布而退回未准入。月度和详情通过 `chainAdmission` 展示逐项结果；原 `admission` 和正式结论登记仍用于编码阶段门禁，入口通过不豁免执行授权、预算、来源版本和阶段门禁。

正式分析检查接受同条目最新平台分析的正式发布状态，或与当前来源和分析修订匹配的人工核验记录；设计检查要求匹配记录中明确登记了必需的正式设计评审通过引用。不得从来源“开发中”“已交付”或进程结束推断审批通过。条件检查不评判材料内容质量，也不自动代替人工审批。启动前在事务内检查入口条件，并将模板版本、开始节点和逐项结果写入启动活动记录。

轻舟排期子记录的 Jira 编号为空（null、缺失或纯空白）时按未关联占位记录处理，不纳入 Jira 工单和排期工单数，也不阻断条目同步；原始来源摘要仍参与版本指纹。主单作废不推定子单作废，真实子单保留各自 Jira 状态。非空编号格式错误、主单身份缺失及跨条目的 Jira 父子关系仍拒绝同步。同一条目内轻舟排期与 Jira 父单不一致时，按 Jira 展示并登记 parent_mismatch 来源差异，允许保存只读快照，准入仍核对该差异。

交付链 Agent 节点按当前 Jira 经办人账号匹配同项目、同 Jira 来源、具备节点能力的负责人席位；唯一匹配自动绑定，多匹配需明确选择或使用同一经办人的已配置默认席位，无匹配提示配置，不按显示姓名推断身份。启动及首次派发前核验账号归属，人工选择不能绕过服务端校验；离线或忙碌等待原席位，经办人变更时提示处理，不自动换人。需求分析无 Jira 子单时仍单独选分析席位，人工执行节点保留人员配置。新流程固定保存所选席位及 jira_assignee 绑定策略，已有流程沿用原授权；修复、独立评审和重测的席位选择也需通过经办人匹配。

### 月度条目进度筛选（2026-11-06）

月度排期在风险筛选上方提供全部进度、已完成、进行中、未开始与待确认，依据轻舟条目的 sourceStatus 精确映射，不使用日期、工单数或平台执行状态推断。显式完成、发布、上线、验收状态归为已完成；待需求分析等初始状态归为未开始；分析、评审、研发及后续等待、打回、挂起状态归为进行中；作废、关闭、缺失及未识别状态归为待确认。各组互斥且覆盖完整列表，来源完成不代表平台正式交付核验通过。进度计数应用其他明细筛选，但忽略风险选择；风险计数应用当前进度。所有筛选在分页前执行，URL 保留 mProgress，清除筛选一并移除。

线上轻舟条目状态使用“全部交付”“部分交付”“待开发”时，分别归入已完成、进行中、进行中。排期接口缺失状态时，复用按需求编号的精确查询补齐 demandState_show，去重并与责任人补查合并；来源明确为空的需求拆分人员不因补状态而被替换。

月度排期支持独立的“条目分析负责人”搜索筛选，取轻舟 `requirementer_show`，与来源负责人 `splitter_show` 分开；缺失值可单独筛选，不以拆分人员或经办人兜底。排期省略该字段时复用按条目编号的精确查询，与负责人、状态补查合并去重；明确为空时保留空值，读取失败报错。条件在整月数据上组合后分页，URL 参数 `mAnalysisOwner` 随详情往返及刷新保留，清除筛选或切换项目时移除。

### 分析正文自动回写轻舟（2026-11-10）

关联已纳管轻舟条目的分析完成 P0–P4 及当前版本真人质量评审后，接入桥上传与冻结文件指纹一致的 `analysis.md` 正文；平台使用同组织中执行席位独立配置的轻舟账号，按轻舟 multipart 分析保存协议自动更新正文，回读一致才登记成功。席位负责人或管理员可在接单设置保存、更换、检查登录或移除账号；密码通过加密凭据库保存，接口不回显，凭据不下发席位或模型。未配置或凭据失效时保留本地交付并提示修复后重试，不借用项目来源账号。项目来源凭据继续用于项目同步。其余原始材料留在本机，正文上限 120 KB。保存保留已有业务字段，缺失共性/工时/日期有界面明确的可修改默认值；轻舟仍按自身规则校验分析负责人并可能重新分配评审人。未绑定条目的独立分析不触发上传或回写。

回写状态与本地交付、正式发布分别保存；失败保留成果，可由管理员重试。重试先回读，已一致不重复写入；上次失败后来源正文变化、旧修订、未确认项目归属及已结束条目不自动覆盖。正文回读一致后，使用轻舟保存后返回的评审人调用申请评审，并再次核验正文、评审人与“分析完成待评审”状态；保存成功和提交成功分别记录，失败可从未完成步骤重试。申请评审不代替轻舟业务审签，不自动放行交付链。具体协议与发布要求见 [分析自动回写](plans/2026-11-10-analysis-qingzhou-writeback.md)。


### 按条目编号精确查询（2026-11-11）

需求条目页在月度排期和已纳管列表提供按完整条目编号精确查询。选择项目后，组织管理员使用该项目保存的轻舟凭据直接读取基本信息，不受排期月份、列表筛选或是否已纳管限制；来源可见范围由该账号权限决定。返回编号、名称、来源状态、拆分人员、条目分析负责人和当前组织各未归档项目中同来源的最新已保存版本入口，不返回原始报文或凭据。查询不保存快照或派单。结果可直接进入已保存的条目详情；本组织没有已保存版本时，用户可按查询月份手动同步并打开详情，也可以补录其他排期月份。来源配置或凭据在查询期间变化时拒绝旧结果。

需求条目详情的「工单与执行」按主工单分组，在对应子工单行内显示交付材料、正式结论及核验状态。条目级需求分析材料和正式验收记录在同一视图内单独展示。旧的「交付物与核验」链接继续打开该视图。在线 Jira 快照中的已完成子工单可查看 Jira 来源附件，已完成评审单还可查看 Jira「结果描述」原文。平台核验状态独立显示。


### 月度排期与期望交付分类（2026-11-11）

月度列表支持合并“本组织已排期”和“本月期望交付”两类条目，并按完整编号去重；条目可同时属于两类。组织来源配置新增可选 `subProductAttribution`（轻舟子产品归属代码，例如 DSP）：配置后，按该产品期望交付月份跨研发、测试组织补齐条目，并核对本组织排期条目的产品归属；留空保留原单组织排期模式。分类筛选在分页前生效，与其他筛选组合，URL 保留 `mScope`；清除筛选和切换项目会清除分类。整月同步重新读取合并清单，不受分类筛选限制。单条同步核对产品归属，读取配置组织及条目实际研发、测试、拆分组织的排期，允许尚未排期条目保存完整来源/Jira 版本。期望交付月份不等于实际交付完成，未读取工单数显示待核对，不能当作零工单。

项目来源配置接口仅向组织管理员返回已保存的轻舟登录账号 `qingzhouUsername`。密码保存在加密凭据库，界面根据 `credentialsConfigured` 在密码框显示 `***`。

定时整月同步由组织管理员经 `GET / PUT /companies/:companyId/delivery-connections/monthly-schedule` 按项目配置，默认关闭。每日按北京时间调度，运行时按北京时间确定当月，重读完整月度清单，逐条复用普通来源快照同步。调度器持久化下次运行时间和最近一次结果，服务器恢复后处理逾期的待运行计划。执行中断时保留已提交快照及最近进度，等待下次日程。定时同步仅保存来源快照，配置的修改和快照写入均记入活动日志。

### 统一任务详情（2026-11-11）

`/issues/:issueId` 默认使用统一任务详情；分析详情通过公司范围的只读 `analysis-executions/by-task/:executionId` 识别，只有明确不存在分析记录才返回 null 并使用通用工单展示。分析记录继续限负责人或组织管理员；拒绝或查询失败不得作为不存在处理。查询不派单、不写状态、不改变审批或预算。原分析详情端点与新入口共用读取／权限规则，响应使用 `AnalysisTaskDetail` 合同。

公共分区为概况、待处理与执行操作、进度与门禁、交付成果、会话与执行记录。分析专属的决策、修订、原生快照、回写、发布保留；研发／测试保留原派单、恢复、撤销与受管会话，阶段观察不代表门禁通过。`detailView=collaboration` 保留完整原任务界面，旧深链接保留目标。旧分析链接进入同一任务并保留返回条件。分析流程协议仍为当前 P0–P4，本次不宣称可自动适配任意原生流程。逐项验收对照见 [统一任务详情](plans/2026-11-11-unified-task-detail.md)。

### 任务入口归并（2026-11-12）

侧栏仅保留“任务”入口。任务页复用 AI 交付链的 `DELIVERY_STAGES` 和 `DELIVERY_STAGE_LABELS`，提供全部任务、需求分析、研发设计、编码与代码评审、测试用例、功能测试及其他任务筛选；环节、项目和任务状态条件可以组合，切换环节保留其他筛选。所有环节使用同一任务列表及统一详情。新建分析／新修订保留原表单与接口；其他交付环节通过需求条目安排任务，不绕过交付链准入。

Compact 任务响应新增可选 `deliveryStages`，服务端仅为当前用户可见任务按组织范围查询分析记录与交付链阶段关联；不根据标题猜测，也不把席位能力或运行阶段当作业务环节。评审任务归入对应环节，修复／重测使用其真实阶段，重复关联去重。明确无关联的任务才归入其他任务；缺少投影或读取失败必须显示异常。无数据库迁移、权限扩大或客户端协议变更。旧 `/analysis-executions` 链接和 `taskType=analysis` 保持兼容，保留项目、来源、任务和修订上下文。

### AI task visibility (2026-11-12)

The AI任务 collection defaults organization owners/admins and instance administrators to organization scope, with an optional personal view. Other human members are restricted to tasks assigned to themselves or their currently owned registered DSP7 seats. Members without a seat retain directly assigned tasks. This boundary applies before task pagination and search aggregation, and also to task detail access and analysis-task legacy endpoints; URL filters cannot widen it. Existing company boundaries and agent authorization continue to apply.

### Unified workbench and task actions (2026-11-13)

`/dashboard` is the unified 工作台. Default view is personal pending actions, with personal task progress, manager-only organization overview, notification/history, and secondary organization diagnostics. Old `/inbox` collection routes redirect while retaining project, scope, filters and historical notification context. AI任务 remains the lifecycle collection and unified task-detail entry point. Scope preferences are shared per user/company and clamped to personal for non-managers.

`GET /companies/:companyId/analysis-executions/pending-actions` returns compact current-run open question/review metadata, excluding report bodies, delivered/finished tasks, and replaced or non-running runs. Company access and existing personal-task authorization apply before returning rows. Task/run/question-key identity deduplicates versions. Existing attention sources support `includeArchived=true` in addition to `includeDismissed=true` so archived notifications cannot hide still-active business actions from the workbench; feed defaults and underlying retention remain unchanged.

Personal actions follow explicit analysis ownership, named interaction recipients, direct assignment and currently owned seats. Unassigned organization actions appear only in organization scope. Offline active tasks aggregate by device; absent execution evidence is a watch item. Partial reads are labeled and never presented as a confirmed empty list. Action counts and task counts are distinct. All resolutions retain existing detail pages, authorization, version checks and audit paths. No database migration or client upgrade is required.

### 受管会话输入来源（2026-11-12）

会话记录区分 Harness 注入、手动输入和来源未记录。原生 user 角色不代表人工输入：启动器对实际生成的首条提示词登记哈希，采集器优先核对该摘要及技能 isMeta/sourceToolUseID 标记，再使用原生 human/typed 来源。清单可选 inputSource=harness/manual/unknown，保存在原有私有会话 JSON 中，不进入 Telemetry 或 run log；旧客户端仍可上传不带该字段的清单。历史技能包装及已知分析启动包装可由页面识别，其他历史输入不得猜测为人工。

AskUserQuestion 的题目、候选项和实际 answers 保留脱敏记录及 toolCallId 关联，答复标为“手动输入 · 选项答复”；“仅人机问答”也包含该工具的问题与答复。旧记录只在原生明确返回已答复标记时认定为手动答复。未采集、未完成或纯终端权限选择不得编造结果。来源标识仅供查看，不授予执行或审批权限。新增来源字段需先发布服务端解析与页面，再更新席位采集客户端。

### 月度交付读取性能（2026-11-13）

月度读取并行获取期望交付与组织排期树；需求补查保留有界并发。来源结果按公司、项目、连接修订、凭据版本、组织、产品及月份隔离，最多缓存 30 秒、32 份且序列化内容合计不超过 8 MiB。认证会话最多 32 个、存活不超过 10 分钟；来源读取最多同时执行 4 个、排队 12 个，相同进行中查询共享来源读取。失败不缓存，已发出的读取收尾后才释放并发额度。

`POST /api/companies/:companyId/delivery-connections/monthly` 支持可选 `forceRefresh: true`。网页“刷新条目”绕过结果缓存及之前的进行中读取，旧请求不得覆盖刷新结果。缓存保留真实 `collectedAt`，每次请求独立核验访问权限、项目及凭据版本，并重新加载本地快照、分析、工作流和准入事实；缓存不授予执行权限。`Server-Timing` 返回各读取阶段及准入计算耗时和来源缓存命中标记，不包含凭据或业务正文。


### 交付实例中途介入（2026-11-16）

评审配置入口优先显示当前评审及被审工作；同主工单且对应类型唯一时自动关联，多个候选由管理员选择。其他阶段配置与派单说明折叠展示，校验发现折叠区域有必填项时自动展开。此入口仍启动完整交付链，页面与按钮明确说明范围，不跳过其他阶段准入。

一键交付配置中，所选 Jira 子工单已完成时默认复用已有交付，无需重复勾选；管理员可明确选择“重新执行”，恢复该节点执行配置；须先在 Jira 重开工单并刷新来源，已结束工单不能直接启动重跑。移除工单或停用阶段后不提交其已有交付记录。默认复用只减少配置操作，启动时仍核验最新来源状态、成果及前置节点；条目级分析仍须手工确认，功能测试仍须填写全部通过的测试总数。

项目模板保持标准流程。管理员启动单个条目时，可按工作单／评审单登记此前已完成的节点。Jira 子工单自动读取当前完成状态、附件和评论，并按附件内容指纹生成交付版本，无需手填三个链接字段；条目级分析仍手工提供交付版本、成果链接和正式完成依据；来源快照中的 Jira 子单须处于完成状态，取消／作废不算完成。条目级分析由管理员确认正式成果。已有节点的依赖也须登记完成；并行阶段允许部分工单已完成，其余继续执行。功能测试只允许登记全部通过的结果和测试总数。

流程保留全部模板节点及其绑定关系。已有交付记录确认人、时间、来源快照，创建完成态任务但不创建席位运行或伪造设备回执；已有成果参与下游输入摘要并通过上下文交接。未完成节点仍遵守原有准入、席位、评审和最终验收规则。模板不变，其他条目不受影响。Jira 已有交付由项目连接只读回读，限定同源附件、禁止重定向，最多 20 个附件、单件 10 MiB、合计 50 MiB；读取期间来源变化则拒绝。工作单须有附件，评审单可用完整评论作为历史记录，不自动推定本次评审通过。后续席位下载附件至本次执行目录并校验指纹，Agent 从本地原件读取成果；不自动解压或执行附件内容。手工登记仍以管理员具名确认为依据；退回涉及已有交付时明确阻塞，须先在来源流程处理，不能自动重跑。


### 席位研发能力首次登记与补登记（2026-11-16）

席位接入并核验运行配置后，从用户已选择并登记的默认研发目录校验原生技能并登记研发能力。已有席位升级后在空闲心跳中补齐缺失的研发能力；只使用设备登记的原目录，服务端核对机器身份、执行环境、登记修订和活动运行。能力清单由本机文件校验产生，不根据目录名称推断；缺少技能、目录不一致、运行中或网络失败时保留明确提示并在空闲时重试。已登记的能力身份与角色变更仍需人工登记，分析及测试套件不自动发现。登记不授权执行。


### 测试失败自动修复（2026-11-16）

项目／组织交付模板可配置 `automaticRepair`：模块对应的原编码／原代码评审／原功能测试席位、构建回读地址和最多 1–3 轮。实例启动须确认复用原任务返工授权，固定策略版本、Jira 来源、席位账号与负责人。2026-11-19 按 DSP 现有工单约定收口：不再配置或使用额外缺陷、修复、评审、重测建单类型；旧字段仅兼容读取，不授予建单能力。

Agent 功能测试提交 `delivery-failures.json` 正式附件，逐条对应失败用例，包含模块、问题类别、复现步骤、预期／实际结果。产品缺陷自动按模块派发；环境／用例问题、跨模块归属、未配置模块或轮数／预算上限会显示明确的人工待处理原因。当前一次测试报告须归属于一个模块；跨模块报告先人工拆分测试范围。

调度器按缺陷模块定位同主工单下唯一的原编码任务及覆盖它的原代码评审任务，复用当前失败的原功能测试任务。保持 Jira 工单号、Paperclip 任务 ID、原生工作流、父单和席位不变；新增派发/运行和返工历史，不新增 Jira 单或 Paperclip 节点。无法唯一定位、原任务来源/负责人变化或旧进程未核验停止时转人工核对。功能测试的当前轮依赖原代码评审再次完成；未涉及的编码分支及用例任务保留。

自动执行顺序为修复 → 独立代码评审 → 修复构建核验 → 重测。独立评审退回携带正式报告和修改说明，按原生返工协议返回修复席位，退回同样受轮数限制。所有原生门禁、租约、预算和进程停止核验继续生效。

修复席位通过项目已有构建／部署流程交付新版本及 `delivery-build.json` 正式附件；平台不预设生产部署命令。QA 客户端只访问策略固定的构建回读接口，不转发 Jira 凭据，不跟随重定向。接口返回 `{ "version": "build-2", "environmentReference": "本实例测试环境引用" }`。修复版本须区别于失败版本，开始及完成重测时均回读一致，测试报告也须登记相同版本。缺少可自动执行的构建部署流程或回读接口时会停下请求处理，不推定已部署。

所有测试通过后进入既有人工正式验收。启用前须更新并刷新登记支持 `delivery-reuse-repair-v1` 的席位客户端，使用原生返工协议重新办理原编码、代码评审和功能测试任务，保留历轮统计及正式证据。平台已封禁旧自动修复 Jira 建单入口；Jira 原单的附件、评论和必要状态流转仍按原生流程执行。本地模拟不替代真实席位联调。


### 交付链自动启动计划（2026-11-17）

启动交付链默认由服务端读取最新 Jira 子单，按项目已发布模板纳入全部对应工作单及评审单、生成依赖、按精确经办人账号与领域能力匹配席位，并核验已有交付。用户查看计划后一次授权启动；多主工单、评审关联歧义、测试环境/历史结果或席位缺失时仅补充实例例外。项目模板不因本次中途接入而变更。原人工启动、人工评审、预算停止及最终验收策略继续生效。

自动计划将缺少附件和评论的历史独立评审，以及缺少报告或全部通过用例数的历史功能测试，登记为待核验节点。到达节点后由本次启动授权人核对同源 Jira 工单的正式结论。评审登记结论及核验说明，历史功能测试另登记正式报告、被测版本及可对账的全部通过数量。已核验的下游历史材料在前置完成后按启动授权的版本重新读取，再登记完成。身份、来源状态、附件完整性等读取异常仍按原规则阻塞。尚未完成的 Jira 测试采用模板规定的执行方式，测试报告和通过数随执行结果提交。

管理员可勾选一个或多个已就绪主工单授权启动。其余主工单可待补齐后追加，或经单独确认排除出本次交付及验收范围。已启动的主工单继续纳入验收。只保存忽略范围时不创建或派发节点。范围选择绑定计划摘要及授权请求，变化写入活动记录。待补齐的主单仍影响验收，明确忽略的主单无需生成节点。

管理员可在自动计划中按未启动主单选择忽略测试用例阶段。授权后为该主单固定跳过范围，将用例编写及评审子单排除出启动和验收范围，并重算功能测试的前置依赖。若用例阶段原为开始节点，其准入检查随计划中的开始节点继续生效。已启动分支的用例范围沿用原授权。

计划节点返回实时 Jira 经办人显示名，缺少显示名时使用账号，两者均空时显示未分配。计划表在席位待匹配时展示该信息。

交付计划图使用节点依赖及已确认的主工单前置关系布局。结束日期使用快照中的排期截止事实，区分子单、主单和条目期望来源，缺失时显示待定。横向位置表示依赖顺序。节点标记 Jira 进度，已有交付仍需核验时显示待核验。

交付计划生成后保存其内容和生成选项。再次打开条目只读取已保存的计划，选择重新生成会替换旧计划。若来源快照或已授权的交付范围变化，页面仍显示保存的计划，并提示重新生成后再授权。启动接口重新计算并比对计划摘要，事务内核对来源、席位授权/Harness 登记与历史成果版本；任何变化要求重新查看计划。相同授权请求重试幂等，失败回滚，保留组织隔离及活动任务防重。详见 `doc/plans/2026-11-17-delivery-automatic-start.md`。

### 交付链节点与个人待办闭环（2026-11-17）

条目列表以交付链实例作为统一执行入口。工作台从实例投影当前可办理动作：人工交付、正式评审、Agent 成果核验、业务答复、启动确认及受治理的恢复/验收。未满足前置的节点只可查看；任务存在不等于允许执行。个人待办按实际操作人员过滤，组织待办需管理员权限；分析发布保留现有专用待办。任务页提供经公司及实例参与者授权的实例/节点关联，办理动作回到具体节点执行，并校验当前成果版本。普通任务状态、执行人更新及抢先领取不能绕过实例控制。详见 `doc/plans/2026-11-17-delivery-workflow-closure.md`。

### 交付链快速演练与返工确认（2026-11-18）

本地 `pnpm delivery:simulate` 使用隔离数据库及模拟外部执行验证真实编排接口，不将线上节点全局切为模拟。返工后的启动确认须等待当前输入摘要准备完成；确认与派发共享摘要生成规则。普通独立代码评审拒绝记录正式修改意见，按模板选择自动派回原研发任务/席位或暂停并人工发起返工；节点累计返工达到 3 轮后，自动代码评审转人工处理。详见 `doc/plans/2026-11-18-delivery-chain-simulation.md`。

### 席位月度交付报表

`GET /api/companies/:companyId/managed-seat-report/monthly-delivery?month=YYYY-MM` 返回组织内已同步的 Jira 子工单及可见席位。按轻舟项目排期与期望交付月确定条目归属，未保存归月证据的旧快照兼容原截止月筛选。截止日优先采用子工单自己的有效排期，其次取所属主工单排期或条目期望交付日。已经归月但无可靠截止日的子工单仍计入进度，单独提示数据缺口。完成以该子工单在最新 Jira 快照中的状态为准，取消、作废排除。未归属席位可由管理员查看。月报字段存于现有快照 JSON，旧快照可通过重新同步补齐，来源指纹与已有交付授权保持有效。

「席位看板」使用独立的组织路由，旧席位月报链接跳转到新入口。接口返回可见席位的负责人标识、子工单类型和主工单编号，以及该子工单关联交付链节点的中断信号。月报归属合并该子工单的交付链执行席位、Jira 经办人及 Jira 研发负责人。后两者使用同 Jira 实例的席位账号配置或当前组织成员的有效目录账号，按员工消除同人多席位歧义。账号匹配不改变派单规则。研发负责人字段沿用 `PAPERCLIP_JIRA_REQUIREMENT_OWNER_FIELD`，在线重同步补齐该字段且不把它纳入交付准入的来源指纹。跨员工协作可进入各员工进度，组织汇总按项目和子工单编号去重。中断、到期和资料缺口可以重叠，风险队列按工单去重。

### 条目级多主工单交付

历史评审可复用已完成的 Jira 评审单中明确通过的「结果描述」。平台核对该字段的名称、工单身份和来源版本，并将结论纳入交付指纹。该字段有值但未明确通过时，节点等待人工核验。已完成的 Jira 人工功能测试也可用该字段的明确测试通过结论复用。缺少附件或用例计数时，平台保留原文和来源版本。Agent 功能测试仍走结构化执行回执及报告指纹核验。

已启动的交付计划按实例节点展示最新执行状态。依赖图以灰色标记未开始、蓝色标记进行中、绿色标记已完成，阻塞或中断另行标记。进度随实例刷新更新，未绑定实例节点的计划项仍显示 Jira 来源状态。

自动计划按主工单预览就绪、阻塞、执行中和已核验状态。启动接口接受本次授权的主单集合，事务中重新核验来源、固定模板、人员、已有证据和授权摘要；补启动及重复请求沿用同一实例。节点按主单分别编排，需求分析为共享节点。可为待启动的主单显式登记一个前置主单，前置正式核验后才允许授权，已授权关系随节点依赖固定。

条目同步后的新增主单可单独启动。新增子工单可经管理员确认纳入已启动分支，并核验受影响节点的旧进程停止后重开交付和评审，保留原任务及旧证据。涉及已授权工单移除、改型或无法安全重开的历史交付时提示核对正式来源。分支内的暂停和测试失败不暂停无关主单。正式验收要求所有当前主单范围已授权、全部节点通过，提交须绑定当前范围和全部节点的交付版本摘要，并重新读取 Jira 子工单范围。可完整对应原主单的旧实例可接续，原验收记录在接续活动中保留。
