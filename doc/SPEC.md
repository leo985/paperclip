# Paperclip Specification

Target specification for the Paperclip control plane. Living document — updated incrementally during spec interviews.

Personal seat availability includes a user-session recovery timer installed with `harness service install`. It checks each enrolled seat independently and requests recovery through the existing `harness online` command when the watcher stops or heartbeat evidence expires. Explicit offline intent, upgrades and existing execution/dispatch/approval controls remain authoritative. It does not promise online availability during sleep, logout, shutdown or network loss; the timing and recovery contract is defined in `SPEC-implementation.md`.

---

## 1. Company Model [DRAFT]

A Company is a first-order object. One Paperclip instance runs multiple Companies. A Company does not have a standalone "goal" field — its direction is defined by its set of Initiatives (see Task Hierarchy Mapping).

### Fields (Draft)

| Field       | Type          | Notes                             |
| ----------- | ------------- | --------------------------------- |
| `id`        | uuid          | Primary key                       |
| `name`      | string        | Company name                      |
| `createdAt` | timestamp     |                                   |
| `updatedAt` | timestamp     |                                   |

### Board Governance [DRAFT]

Every Company has a **Board** that governs high-impact decisions. The Board is the human oversight layer.

**V1: Single human Board.** One human operator.

#### Board Approval Gates (V1)

- New Agent hires (creating new Agents)
- CEO's initial strategic breakdown (CEO proposes, Board approves before execution begins)
- [TBD: other governance-gated actions — goal changes, firing Agents?]

Connection tool reviews also appear in task history, with a composer takeover for
human approval, decline, or scoped remembered permission. Connections and task
views resolve the same review, and the agent continues with the server-recorded
outcome. See [the implementation contract](SPEC-implementation.md#124-connection-tool-reviews).

#### Board Powers (Always Available)

The Board has **unrestricted access** to the entire system at all times:

- **Set and modify Company budgets** — the Board sets top-level token/LLM cost budgets
- **Pause/resume any Agent** — stop an Agent's heartbeat immediately
- **Pause/resume any work item** — pause a task, project, subtask tree, milestone. Paused items are not picked up by Agents.
- **Full project management access** — create, edit, comment on, modify, delete, reassign any task/project/milestone through the UI
- **Override any Agent decision** — reassign tasks, change priorities, modify descriptions
- **Manually change any budget** at any level

The Board is not just an approval gate — it's a live control surface. The human can intervene at any level at any time.

#### Budget Delegation

The Board sets Company-level budgets. The CEO can set budgets for Agents below them, and every manager Agent can do the same for their reports. How this cascading budget delegation works in practice is TBD, but the permission structure supports it. The Board can manually override any budget at any level.

**Future governance models** (not V1):

- Hiring budgets (auto-approve hires within $X/month)
- Multi-member boards
- Delegated authority (CEO can hire within limits)

### Open Questions

- External revenue/expense tracking — future plugin. Token/LLM cost budgeting is core.
- Company-level settings and configuration?
- Company lifecycle (pause, archive, delete)?
- What governance-gated actions exist beyond hiring and CEO strategy approval?

---

## 2. Agent Model [DRAFT]

Every employee is an agent. Agents are the workforce.

### Agent Identity (Adapter-Level)

Concepts like SOUL.md (identity/mission) and HEARTBEAT.md (loop definition) are **not part of the Paperclip protocol**. They are adapter-specific configurations. For example, an OpenClaw adapter might use SOUL.md and HEARTBEAT.md files. A Claude Code adapter might use CLAUDE.md. A bare Python script might use command-line args.

Paperclip doesn't prescribe how an agent defines its identity or behavior. It provides the control plane; the adapter defines the agent's inner workings.

### Agent Configuration [DRAFT]

Each agent has an **adapter type** and an **adapter-specific configuration blob**. The adapter defines what config fields exist.

#### Paperclip Protocol (What Paperclip Knows)

At the protocol level, Paperclip tracks:

- Agent identity (id, name, role, title)
- Org position (who they report to, who reports to them)
- Adapter type + adapter config
- Status (active, paused, terminated)
- Cost tracking data (if the agent reports it)

#### Adapter Configuration (Agent-Specific)

Each adapter type defines its own config schema. Examples:

- **OpenClaw adapter**: SOUL.md content, HEARTBEAT.md content, OpenClaw-specific settings
- **Process adapter**: command to run, environment variables, working directory
- **HTTP adapter**: endpoint URL, auth headers, payload template

#### Exportable Org Configs

A key goal: **the entire org's agent configurations are exportable.** You can export a company's complete agent setup — every agent, their adapter configs, org structure — as a portable artifact. This enables:

- Sharing company templates ("here's a pre-built marketing agency org")
- Version controlling your company configuration
- Duplicating/forking companies

#### Context Delivery

Configurable per agent. Two ends of the spectrum:

- **Fat payload** — Paperclip bundles relevant context (current tasks, messages, company state, metrics) into the heartbeat invocation. Suited for simple/stateless agents that can't call back to Paperclip.
- **Thin ping** — Heartbeat is just a wake-up signal. Agent calls Paperclip's API to fetch whatever context it needs. Suited for sophisticated agents that manage their own state.

#### Minimum Contract

The minimum requirement to be a Paperclip agent: **be callable.** That's it. Paperclip can invoke you via command or webhook. No requirement to report back — Paperclip infers basic status from process liveness when it can.

#### Integration Levels

Beyond the minimum, Paperclip provides progressively richer integration:

1. **Callable** (minimum) — Paperclip can start you. That's the only contract.
2. **Status reporting** — Agent reports back success/failure/in-progress after execution.
3. **Fully instrumented** — Agent reports status, cost/token usage, task updates, and logs. Bidirectional integration with the control plane.

Paperclip ships **default agents** that demonstrate full integration: progress tracking, cost instrumentation, and a **Paperclip skill** (a Claude Code skill for interacting with the Paperclip API) for task management. These serve as both useful defaults and reference implementations for adapter authors.

#### Export Formats

Two export modes:

1. **Template export** (default) — structure only: agent definitions, org chart, adapter configs, role descriptions. Optionally includes a few seed tasks to help get started. This is the blueprint for spinning up a new company.
2. **Snapshot export** — full state: structure + current tasks, progress, agent status. A complete picture you could restore or fork.

The usual workflow: export a template, create a new company from it, add a couple initial tasks, go.

---

## 3. Org Structure [DRAFT]

Hierarchical reporting structure. CEO at top, reports cascade down.

### Agent Visibility

**Full visibility across the org.** Every agent can see the entire org chart, all tasks, all agents. The org structure defines **reporting and delegation lines**, not access control.

Visibility settings on an agent profile (where supported) do not alter company-level visibility for tasks, projects, issues, comments, costs, or activity. Those work-object privacy controls are not a V1 feature until centralized scoped authorization is in place.

Each agent publishes a short description of their responsibilities and capabilities — almost like skills ("when I'm relevant"). This lets other agents discover who can help with what.

### Cross-Team Work

Agents can create tasks and assign them to agents outside their reporting line. This is the mechanism for cross-team collaboration. These rules are primarily encoded in the Paperclip SKILL.md which is recommended for all agents. Paperclip the app enforces the tooling and some light governance, but the cross-team rules below are mainly implemented by agent decisions.

#### Task Acceptance Rules

When an agent receives a task from outside their team:

1. **Agrees it's appropriate + can do it** → complete it directly
2. **Agrees it's appropriate + can't do it** → mark as blocked
3. **Questions whether it's worth doing** → **cannot cancel it themselves.** Must reassign to their own manager, explain the situation. Manager decides whether to accept, reassign, or escalate.

#### Manager Escalation Protocol

It's any manager's responsibility to understand why their subordinates are blocked and resolve it:

0. **Decide** — as a manager, is this work worth doing?
1. **Delegate down** — ask someone under them to help unblock
2. **Escalate up** — ask the manager above them for help

#### Request Depth Tracking

When a task originates from a cross-team request, track the **depth** as an integer — how many delegation hops from the original requester. This provides visibility into how far work cascades through the org.

#### Billing Codes

Task detail keeps hierarchy separate from creation provenance: the Tasks tab shows
all subtasks and, independently, work created from the current task grouped by
project or No project. A created subtask may appear in both sections. Creation
provenance follows the originating run equally for legacy and native runners.

Tasks carry a **billing code** so that token spend during execution can be attributed upstream to the requesting task/agent. When Agent A asks Agent B to do work, the cost of B's work is tracked against A's request. This enables cost attribution across the org.

### Open Questions

- Is this a strict tree or can agents report to multiple managers?
- Can org structure change at runtime? (agents reassigned, teams restructured)
- Do agents inherit any configuration from their manager?
- Billing code format — simple string? Hierarchical?

---

## 4. Heartbeat System [DRAFT]

The heartbeat is a protocol, not a runtime. Paperclip defines how to initiate an agent's cycle. What the agent does with that cycle — how long it runs, whether it's task-scoped or continuous — is entirely up to the agent.

### Execution Adapters

Agent configuration includes an **adapter** that defines how Paperclip invokes the agent. Built-in adapters include:

| Adapter | Mechanism | Example |
| ---------------- | -------------------------- | -------------------------------------------------- |
| `process` | Execute a child process | `python run_agent.py --agent-id {id}` |
| `http` | Send an HTTP request | `POST https://openclaw.example.com/hook/{id}` |
| `claude_local` | Local Claude Code process | Claude Code heartbeat worker |
| `codex_local` | Local Codex process | Codex CLI heartbeat worker |
| `opencode_local` | Local OpenCode process | OpenCode heartbeat worker |
| `pi_local` | Local Pi process | Pi CLI heartbeat worker |
| `cursor` | Cursor API/CLI bridge | Cursor-integrated heartbeat worker |
| `openclaw_gateway` | OpenClaw gateway API | Managed OpenClaw agent via gateway |
| `hermes_local` | Local Hermes process | Hermes agent heartbeat worker |

The `process` and `http` adapters ship as generic defaults. Additional built-in adapters cover common local coding runtimes (see list above), and new adapter types can be registered via the plugin system (see Plugin / Extension Architecture).

An adapter's selected execution engine is part of its permission and session
contract. Missing prerequisites or engine failures must be surfaced without
silently launching a different engine. A default local engine must support
normal task work and control-plane coordination; explicit operator restrictions
remain authoritative.

### Adapter Interface

Every adapter implements three methods:

```
invoke(agentConfig, context?) → void     // Start the agent's cycle
status(agentConfig) → AgentStatus        // Is it running? finished? errored?
cancel(agentConfig) → void               // Graceful stop signal (for pause/resume)
```

This is the full adapter contract. `invoke` starts the agent, `status` lets Paperclip check on it, `cancel` enables the board's pause functionality. Everything else (cost reporting, task updates) is optional and flows through the Paperclip REST API.

### What Paperclip Controls

- **When** to fire the heartbeat (schedule/frequency, per-agent)
- **How** to fire it (adapter selection + config)
- **What context** to include (thin ping vs. fat payload, per-agent)

### What Paperclip Does NOT Control

- How long the agent runs
- What the agent does during its cycle
- Whether the agent is task-scoped, time-windowed, or continuous

### Pause Behavior

When the board (or system) pauses an agent:

1. **Signal the current execution** — send a graceful termination signal to the running process/session
2. **Grace period** — give the agent time to wrap up, save state, report final status
3. **Force-kill after timeout** — if the agent doesn't stop within the grace period, terminate
4. **Stop future heartbeats** — no new heartbeat cycles will fire until the agent is resumed

This is "graceful signal + stop future heartbeats." The current run gets a chance to land cleanly.

### Open Questions

- Heartbeat frequency — who controls it? Fixed? Per-agent? Cron-like?
- What happens when a heartbeat invocation fails? (process crashes, HTTP 500)
- Health monitoring — how does Paperclip distinguish "stuck" from "working on a long task"?
- Can agents self-trigger their next heartbeat? ("I'm done, wake me again in 5 min")
- Grace period duration — fixed? configurable per agent?

---

## 5. Inter-Agent Communication [DRAFT]

All agent communication flows through the **task system**.

### Model: Tasks + Comments

- **Delegation** = creating a task and assigning it to another agent
- **Coordination** = commenting on tasks
- **Status updates** = updating task status and fields

There is no separate messaging or chat system. Tasks are the communication channel. This keeps all context attached to the work it relates to and creates a natural audit trail.

Experimental Agent Chat presents one persistent task per person and agent as a simplified conversation. It retains the task composer, transcript, tools, attachments, documents, and existing Subtasks panel, with ordinary company visibility. New execution tasks are ordinary project tasks, not children of the conversation. Idle conversations wait for a message without entering execution-task work queues. Agents clarify goals here and create assigned tasks for substantial execution. `/new` resets provider context at an ordered session boundary within the same task while preserving visible history. `enableAgentChat` is disabled by default; the V1 lifecycle and rollout contract is specified in `SPEC-implementation.md`.

### Implications

- An agent's "inbox" is: tasks assigned to them + comments on tasks they're involved in
- The CEO delegates by creating tasks assigned to the CTO
- The CTO breaks those down into sub-tasks assigned to engineers
- Discussion happens in task comments, not a side channel
- If an agent needs to escalate, they comment on the parent task or reassign

### Task Hierarchy Mapping

Full hierarchy: **Initiative** (company goal) → Projects → Milestones → Issues → Sub-issues. Everything traces back to an initiative, and the "company goal" is just the first/primary initiative.

---

## 6. Cost Tracking [DRAFT]

Token/LLM cost budgeting is a core part of Paperclip. External revenue and expense tracking is a future plugin.

### Cost Reporting

Fully-instrumented Agents report token/API usage back to Paperclip. Costs are tracked at every level:

- **Per Agent** — how much is this employee costing?
- **Per task** — how much did this unit of work cost?
- **Per project** — how much is this deliverable costing?
- **Per Company** — total burn rate

Costs should be denominated in both **tokens and dollars**.

Billing codes on tasks (see Org Structure) enable cost attribution across teams — when Agent A requests work from Agent B, B's costs roll up to A's request.

### Budget Controls

Three tiers:

1. **Visibility** — dashboards showing spend at every level (Agent, task, project, Company)
2. **Soft alerts** — configurable thresholds (e.g. warn at 80% of budget)
3. **Hard ceiling** — auto-pause the Agent when budget is hit. Board notified. Board can override/raise the limit.

Budgets can be set to **unlimited** (no ceiling).

### Open Questions

- Cost reporting API — what's the schema for an agent to report costs?
- Dashboard design — what metrics matter most at each level?
- Budget period — per-day? per-week? per-month? rolling?

---

## 7. Default Agents & Bootstrap Flow [DRAFT]

### Bootstrap Sequence

How a Company goes from "created" to "running":

1. Human creates a Company and its initial Initiatives
2. Human defines initial top-level tasks
3. Human creates the CEO Agent (using the default CEO template or custom)
4. CEO's first heartbeat: reviews the Initiatives and tasks, proposes a strategic breakdown (org structure, sub-tasks, hiring plan)
5. **Board approves** the CEO's strategic plan
6. CEO begins execution — creating tasks, proposing hires (Board-approved), delegating

### Default Agents

Paperclip ships default Agent templates:

- **Default Agent** — a basic Claude Code or Codex loop. Knows the **Paperclip Skill** (SKILL.md) so it can interact with the task system, read Company context, report status.
- **Default CEO** — extends the Default Agent with CEO-specific behavior: strategic planning, delegation to reports, progress review, Board communication.

These are starting points. Users can customize or replace them entirely.

### Default Agent Behavior

The default agent's loop is **config-driven**. The adapter config contains the instructions that define what the agent does on each heartbeat cycle. There is no hardcoded standard loop — each agent's config determines its behavior.

This means the default CEO config tells the CEO to review strategy, check on reports, etc. The default engineer config tells the engineer to check assigned tasks, pick the highest priority, and work it. But these are config choices, not protocol requirements.

### Paperclip Skill (SKILL.md)

A skill definition that teaches agents how to interact with Paperclip. Provides:

- Task CRUD (create, read, update, complete tasks)
- Status reporting (check in, report progress)
- Company context (read goal, org chart, current state)
- Cost reporting (log token/API usage)
- Inter-agent communication rules

This skill is adapter-agnostic — it can be loaded into Claude Code, injected into prompts, or used as API documentation for custom agents.

---

## 8. Architecture & Deployment [DRAFT]

### Deployment Model

**Single-tenant, self-hostable.** Not a SaaS. One instance = one operator's companies.

#### Development Path (Progressive Deployment)

1. **Local dev** — One command to install and run. Embedded Postgres. Everything on your machine. Agents run locally.
2. **Hosted** — Deploy to Vercel/Supabase/AWS/anywhere. Remote agents connect to your server with a shared database. The UI is accessible via the web.
3. **Open company** — Optionally make parts public (e.g. a job board visible to the public for open companies).

The key constraint: it must be trivial to go from "I'm trying this on my machine" to "my agents are running on remote servers talking to my Paperclip instance."

#### Agent Authentication

When a user creates an Agent, Paperclip generates a **connection string** containing: the server URL, an API key, and instructions for how to authenticate. The Agent is assumed to be capable of figuring out how to call the API with its token/key from there.

Flow:

1. Human creates an Agent in the UI
2. Paperclip generates a connection string (URL + key + instructions)
3. Human provides this string to the Agent (e.g. in its adapter config, environment, etc.)
4. Agent uses the key to authenticate API calls to the control plane

### Tech Stack

| Layer    | Technology                                                   |
| -------- | ------------------------------------------------------------ |
| Frontend | React + Vite                                                 |
| Backend  | TypeScript + Express (REST API, not tRPC — need non-TS clients) |
| Database | PostgreSQL (see [doc/DATABASE.md](./doc/DATABASE.md) for details — PGlite embedded for dev, Docker or hosted Supabase for production) |
| Auth     | [Better Auth](https://www.better-auth.com/)                  |

### Concurrency Model: Atomic Task Checkout

Tasks use **single assignment** (one agent per task) with **atomic checkout**:

1. Agent attempts to set a task to `in_progress` (claiming it)
2. The API/database enforces this atomically — if another agent already claimed it, the request fails with an error identifying which agent has it
3. If the task is already assigned to the requesting agent from a previous session, they can resume

No optimistic locking or CRDTs needed. The single-assignment model + atomic checkout prevents conflicts at the design level.

### Human in the Loop

Agents can create tasks assigned to humans. The board member (or any human with access) can complete these tasks through the UI.

When a human completes a task, if the requesting agent's adapter supports **pingbacks** (e.g. OpenClaw hooks), Paperclip sends a notification to wake that agent. This keeps humans rare but possible participants in the workflow.

The agents are discouraged from assigning tasks to humans in the Paperclip SKILL, but sometimes it's unavoidable.

### API Design

**Single unified REST API.** The same API serves both the frontend UI and agents. Authentication determines permissions — board auth has full access, agent API keys have scoped access (their own tasks, cost reporting, company context).

No separate "agent API" vs. "board API." Same endpoints, different authorization levels.

### Work Artifacts

Paperclip manages task-linked work artifacts: issue documents (rich-text plans, specs, notes attached to issues) and file attachments. Agents read and write these through the API as part of normal task execution. Full delivery infrastructure (code repos, deployments, production runtime) remains the agent's domain — Paperclip orchestrates the work, not the build pipeline.

### Open Questions

- Real-time updates to the UI — WebSocket? SSE? Polling?
- Agent API key scoping — what exactly can an Agent access? Only their own tasks? Their team's? The whole Company?

### Crash Recovery: Manual, Not Automatic

When an agent crashes or disappears mid-task, Paperclip does **not** auto-reassign or auto-release the task. Instead:

- Paperclip surfaces stale tasks (tasks in `in_progress` with no recent activity) through dashboards and reporting
- Paperclip may perform bounded continuity repair with the same assigned agent; when that is exhausted or unsafe, it opens a board-owned recovery action without waking a substitute agent
- Paperclip does not fail silently — the auditing and visibility tools make problems obvious
- Recovery is handled by humans or by emergent processes (e.g. a project manager agent whose job is to monitor for stale work and surface it)

**Principle: Paperclip reports problems, it doesn't silently fix them.** Automatic recovery hides failures. Good visibility lets the right entity (human or agent) decide what to do.

### Plugin / Extension Architecture

The core Paperclip system must be extensible. Features like knowledge bases, external revenue tracking, and new Agent Adapters should be addable as **plugins** without modifying core. This means:

- Well-defined API boundaries that plugins can hook into
- Event system or hooks for reacting to task/Agent lifecycle events
- **Agent Adapter plugins** — new Adapter types can be registered via the plugin system
- Plugin-registrable UI components (future)

The plugin framework has shipped. Plugins can register new adapter types, hook into lifecycle events, and contribute UI components (e.g. global toolbar buttons). A plugin SDK and CLI commands (`paperclipai plugin`) are available for authoring and installing plugins.

---

## 9. Frontend / UI [DRAFT]

### Primary Views

Each is a distinct page/route:

1. **Org Chart** — the org tree with live status indicators (running/idle/paused/error) per agent. Real-time activity feed of what agents are doing.
2. **Task Board** — Task management. Kanban and list views. Filter by team, agent, project, status.
3. **Dashboard** — high-level metrics: agent count, active tasks, costs, goal progress, burn rate. The "glance" view from GOAL.md.
4. **Agent Detail** — deep dive on a single agent: their tasks, activity, costs, configuration, status history.
5. **Project/Initiative Views** — progress tracking against milestones and goals.
6. **Cost Dashboard** — spend visualization at every level (agent, task, project, company).

### Board Controls (Available Everywhere)

- Pause/resume agents (any view)
- Pause/resume tasks/projects (any view)
- Approve/reject pending actions (hiring, strategy proposals)
- Direct task creation, editing, commenting

---

## 10. V1 Scope (MVP) [DRAFT]

**Full loop with one adapter.** V1 must demonstrate the complete Paperclip cycle end-to-end, even if narrow.

### Must Have (V1)

- [ ] **Company CRUD** — create a Company with Initiatives
- [ ] **Agent CRUD** — create/edit/pause/resume Agents with Adapter config
- [ ] **Org chart** — define reporting structure, visualize it
- [ ] **Process adapter** — invoke(), status(), cancel() for local child processes
- [ ] **Task management** — full lifecycle with hierarchy (tasks trace to company goal)
- [ ] **Atomic task checkout** — single assignment, in_progress locking
- [ ] **Board governance** — human approves hires, pauses Agents, sets budgets, full PM access
- [ ] **Cost tracking** — Agents report token usage, per-Agent/task/Company visibility
- [ ] **Budget controls** — soft alerts + hard ceiling with auto-pause
- [ ] **Default agent** — basic Claude Code/Codex loop with Paperclip skill
- [ ] **Default CEO** — strategic planning, delegation, board communication
- [ ] **Paperclip skill (SKILL.md)** — teaches agents to interact with the API
- [ ] **REST API** — full API for agent interaction (Express)
- [ ] **Web UI** — React/Vite: org chart, task board, dashboard, cost views
- [ ] **Agent auth** — connection string generation with URL + key + instructions
- [ ] **One-command dev setup** — embedded PGlite, everything local
- [ ] **Multiple Adapter types** (HTTP, OpenClaw gateway, and local coding adapters)

### Not V1

- Knowledge base - a future plugin
- Advanced governance models (hiring budgets, multi-member boards)
- Revenue/expense tracking beyond token costs - a future plugin
- Public job board / open company features

---

## 11. Knowledge Base

**Anti-goal for core.** The knowledge base is not part of the Paperclip core — it will be a plugin. The task system + comments + agent descriptions provide sufficient shared context.

The architecture must support adding a knowledge base plugin later (clean API boundaries, hookable lifecycle events) but the core system explicitly does not include one.

---

## 12. Anti-Requirements

Things Paperclip explicitly does **not** do:

- **Not an Agent runtime** — Paperclip orchestrates, Agents run elsewhere
- **Not a knowledge base** — core has no wiki/docs/vector-DB (plugin territory)
- **Not a SaaS** — single-tenant, self-hosted
- **Not opinionated about Agent implementation** — any language, any framework, any runtime
- **Not automatically self-healing** — surfaces problems, doesn't silently fix them
- **Does not manage delivery infrastructure** — no repo management, no deployment, no file systems (but does manage task-linked documents and attachments)
- **Does not auto-reassign work** — stale tasks are surfaced, not silently redistributed
- **Does not track external revenue/expenses** — that's a future plugin. Token/LLM cost budgeting is core.

---

## 13. Principles (Consolidated)

1. **Unopinionated about how you run your Agents.** Any language, any framework, any runtime. Paperclip is the control plane, not the execution plane.
2. **Company is the unit of organization.** Everything lives under a Company.
3. **Tasks are the communication channel.** All Agent communication flows through tasks + comments. No side channels.
4. **All work traces to the goal.** Hierarchical task management — nothing exists in isolation.
5. **Board governs.** Humans retain control through the Board. Conservative defaults (human approval required).
6. **Surface problems, don't hide them.** Good auditing and visibility. No silent auto-recovery.
7. **Atomic ownership.** Single assignee per task. Atomic checkout prevents conflicts.
8. **Progressive deployment.** Trivial to start local, straightforward to scale to hosted.
9. **Extensible core.** Clean boundaries so plugins can add capabilities (Adapters, knowledge base, revenue tracking) without modifying core.

## Agent visual identity

Agent appearances are stable, versioned ClipLab end-cap personas, separate from
behavioral instructions. Compact surfaces use on-demand cached PNG URLs; larger
placements may use a lazy live character. See [agent-personas.md](agent-personas.md)
for persistence, migration, rendering, and integration contracts.
### Agent chat project handoff (2026-09-11)

Chat supports research and full plan drafting/revision in its existing plan document. On handoff, each ordinary assigned task receives the relevant plan in its own `plan` document, committed with task creation before execution is scheduled. The source plan remains in the conversation. Plan acceptance hands off execution; it never switches the conversation into implementation.

Chat instructions require selecting a suitable project, reusing an existing one where appropriate. The project requirement is prompt-only; ordinary projectless tasks remain supported. New parent relationships beneath conversation tasks are rejected by task services, including direct API creation and reparenting. Existing children remain readable/editable and can be moved elsewhere. The Subtasks panel is unchanged.

The `create_project` runtime tool uses the normal project API with durable idempotency. `list_projects` and `list_project_repositories` support selection. Multiple `repositoryIds` select authorized catalog entries; multiple HTTPS GitHub `repositoryUrls` register existing repositories absent from the catalog. IDs and URLs may be combined, but cannot accompany an explicit `workspace`. URLs do not create repositories on GitHub or grant credentials. Execution uses normal repository access rules. Repository IDs are revalidated against the authenticated run's responsible user and connection grants. Agents should consider proper available repositories, clarify material ambiguity, and use repository-free projects when appropriate for non-code work.

Confirmed project creation appears as a durable card in the shared task transcript, including selected repository links. Tasks are linked inline. Failed creation never produces a success card. Tool evals cover planning/handoff, project/repository selection, retries, permission and mode denials, and ordinary delegation regressions using the production chat directive.

### Paused task messages

A paused task takes over the composer with an amber notice and a Resume action.
Operators must release the effective task or ancestor pause before sending a new
message. The draft stays intact. This applies to both task interfaces and to
board comment API requests; an agent may still report interrupted work.

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

See [iMessage Photon](connections/IMESSAGE-PHOTON.md) for the implementation
contract, setup, recovery, boundaries, and qualification status.

## Task search relevance

Task discovery uses PostgreSQL and the existing search indexes, with no external
search service or background indexing job. The task-list quick search and full
company search share lexical matching and ranking. Known identifiers and direct
title matches lead; current conversation and document content supplies supporting
evidence. See [Task search relevance](SEARCH.md) for the evaluation rubric,
matching contract and reproducible quality tests.


## DSP7 managed conversation resource (2026-10-21)

Managed local Claude conversations are separate company-scoped resources, not issue comments or generic heartbeat logs. Only the snapshotted execution owner and organization/instance administrators may read bodies; issue access alone does not grant conversation access. Device-key writes require the enrolled machine identity, a real run/task binding and contiguous, digest-checked stream receipts. Deletion retains a tombstone and removes all content parts/projections. Conversation bodies must not enter first-party telemetry, crash reporting, generic HTTP errors, search or run summaries.

Protocol v1 supports redacted visible text, tools, subagents and UTF-8 attachments. Unsupported binary attachments carry an explicit unavailable reason. Phase observation is not gate completion. Task facts, heartbeat spans and explicit Jira links support period reports without fabricating historical time or quality baselines. See [implementation design](plans/2026-10-21-managed-session-observability.md) and [implementation scope](plans/2026-10-21-managed-session-implementation.md) for limits and release prerequisites.


## DSP7 中断会话恢复（2026-10-22）

席位的显式恢复同时确认旧会话的停止证明和执行环境释放，再允许本机新运行；保留既有工作和未知操作结果，不自动重放旧操作。详见 V1 实现约束及 `doc/plans/2026-10-22-seat-resume-stop-ack.md`。

## DSP7 席位时间统计（2026-10-22）

席位统计保留工单、执行、人工等待、在线空闲和质量数据，移除“未知时长”和时间“覆盖率”的页面展示；仅增加“工作时段在线”辅助列，不设在线率、达标率或排名。在线以服务端收到的席位心跳为依据，有效期 90 秒，与执行状态、暂停接单无关；只累计 Asia/Shanghai 工作时段内截至当前的连接区间，席位创建前不计入，人员多电脑取并集。没有心跳证据的工作区间标记“统计不完整”，可展开查看，不推算成离线或人员工时。

工作规则按组织持久保存，管理员通过统计区默认折叠的“工作时段设置”配置 ISO 工作日（周一为 1、周日为 7）及最多四个同日、不重叠的时间段。默认周一至周五 09:00–12:00、13:00–18:00；修改规则后历史查询也按新规则计算。本期不含法定节假日日历、请假审批或免考核模块。`PUT /api/companies/:companyId/managed-seat-report/work-schedule` 要求组织管理员权限、组织访问校验并在同一事务记录活动日志；报表返回实际规则与配置权限。旧 API 的时间缺口字段保留用于诊断兼容，界面不展示。


## Jira 主需求与 Harness 协同（2026-10-24）

Jira 主需求作为交付协调容器，负责人取研发负责人字段；子单各自保留真实身份与经办人。旧版仅工作单模式由研发 Harness 编码技能同时处理关联代码评审。启用阶段内独立评审顺序后，平台显式绑定并调度真实评审子单，工作席位不得代执行已委派的评审子单。设计及用例人工评审沿用正式领域流程；QA 子单不能交由研发执行通道冒充执行。当前实现范围、权限和未完成项见 [主需求交付协同整改](plans/2026-10-24-jira-requirement-delivery.md)。


## Harness 管理执行仓库（2026-11-03）

席位接单规则只约束平台项目、Jira 项目、工单类型和允许状态，不要求配置或选择平台共享仓库。新 Jira 接入申请使用版本 4，不携带 workspace_id，任务不绑定 projectWorkspaceId，并禁用平台项目工作区选择。本机接入桥核验身份、Jira、派单授权并取得原有独占登记后，从已登记的 Harness 根目录启动原生会话；工单涉及的一个或多个仓库、目录、分支和 Git 工作树完全由 Harness 套件及其技能管理，平台不扫描业务仓库、不匹配 origin、不创建或核验业务工作树。领域完成状态、工程确认、交付证据、tracker/Jira 回执与原有执行权、预算、停止保护继续核验。

新版客户端上报 `harness-repository-management-v1`；新协议的派单和执行登记要求该能力。旧客户端先更新；已有登记及运行保持原模式，不自动修改旧工作树或重放任务。旧接入申请保持可读，版本 2/3 原始授权内容与独占记录保留。首次安装及恢复接入不再要求绑定项目本机仓库。此规则仅改变 DSP7 本机 Harness 席位执行，不删除其他适配器使用的原生项目仓库功能。


### Instance personnel federation (2026-11-04)

Personnel identity sources, external people, departments and sync jobs are shared
across the instance and managed only by instance administrators. Sync once per
enterprise; organizations reuse that directory through explicit membership
assignment. Synchronization and identity linking do not create organization
memberships or grant roles. Existing accounts, passwords, memberships and seat
ownership are preserved. Notification recipients must have an active membership
in the seat's organization and a valid DingTalk identity matching the bot CorpId.
The system directory is an explicit exception to company-scoped domain storage;
organization permissions and execution remain isolated.


### 轻舟需求分析阶段状态（2026-11-04）

需求条目交付页的需求分析阶段以轻舟条目级分析与评审事实展示，不能由 Jira 分析子工单数量或平台分析任务是否存在推断“待安排”。在线同步通过 `UC_PROJ2_DEMAND_DETAIL` 采集当前条目状态、分析内容是否已保存及各评审环节原始状态。平台分析执行状态独立展示；来源保存分析、下游待开发或单个评审环节通过均不自动授予开发准入或正式交付核验。旧快照缺少详情时显示“待核对”，重新同步后生成包含详情的新版本。

### Delivery orchestration configuration (2026-11-05)

Delivery templates are company-scoped, immutable published revisions with optional project overrides. Each new workflow embeds the resolved revision and definition; edits and inheritance changes affect future instances only. The default starts at design, requires design seat-owner review, forks coding across seats and joins all coding before QA. Enabled phases, automatic/confirmed starts, optional receipt review, default seats, serial/parallel coding and waiting reminders are configurable. Human final acceptance remains mandatory.

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


### 交付链开始节点准入（2026-11-06）

条目准入按所选交付模板的首个启用阶段判断，与后续编码准入分开。开始节点的 `entryChecks` 可勾选标题、需求拆分人员、Jira 主工单、开始节点工单、来源结构一致、正式分析结论、正式设计评审结论、启动配置中的测试环境与待测构建引用，所有选中条件必须满足。分析节点直接使用需求条目，不要求预先存在编码单或设计通过结论；仅配置在后续节点的检查项不参与入口判断。内置 v4 不预选业务准入条件，由管理员按实际链路选择并发布。

未配置检查项的旧模板显示“未配置准入”，新建流程前必须配置；新发布的非继承模板必须为开始节点至少选择一项。历史模板可正常读取，已启动流程固定原模板并显示“已准入”，不会因后续阶段阻塞或新模板发布而退回未准入。月度和详情通过 `chainAdmission` 展示逐项结果；原 `admission` 和正式结论登记仍用于编码阶段门禁，入口通过不豁免执行授权、预算、来源版本和阶段门禁。

正式分析检查接受同条目最新平台分析的正式发布状态，或与当前来源和分析修订匹配的人工核验记录；设计检查要求匹配记录中明确登记了必需的正式设计评审通过引用。不得从来源“开发中”“已交付”或进程结束推断审批通过。条件检查不评判材料内容质量，也不自动代替人工审批。启动前在事务内检查入口条件，并将模板版本、开始节点和逐项结果写入启动活动记录。

交付链 Agent 节点按当前 Jira 经办人账号匹配同项目、同 Jira 来源、具备节点能力的负责人席位；唯一匹配自动绑定，多匹配需明确选择或使用同一经办人的已配置默认席位，无匹配提示配置，不按显示姓名推断身份。启动及首次派发前核验账号归属，人工选择不能绕过服务端校验；离线或忙碌等待原席位，经办人变更时提示处理，不自动换人。需求分析无 Jira 子单时仍单独选分析席位，人工执行节点保留人员配置。新流程固定保存所选席位及 jira_assignee 绑定策略，已有流程沿用原授权；修复、独立评审和重测的席位选择也需通过经办人匹配。
