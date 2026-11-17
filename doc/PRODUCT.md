# Paperclip — Product Definition

## What It Is

Paperclip is the control plane for autonomous AI companies. One instance of Paperclip can run multiple companies. A **company** is a first-order object.

## Core Concepts

### Company

A company has:

- A **goal** — the reason it exists ("Create the #1 AI note-taking app that does $1M MRR within 3 months")
- **Employees** — every employee is an AI agent
- **Org structure** — who reports to whom
- **Revenue & expenses** — tracked at the company level
- **Task hierarchy** — all work traces back to the company goal

### Employees & Agents

Every employee is an agent. When you create a company, you start by defining the CEO, then build out from there.

Each employee has:

- **Adapter type + config** — how this agent runs and what defines its identity/behavior. This is adapter-specific (e.g., an OpenClaw agent might use SOUL.md and HEARTBEAT.md files; a Claude Code agent might use CLAUDE.md; a bare script might use CLI args). Paperclip doesn't prescribe the format — the adapter does.
- **Role & reporting** — their title, who they report to, who reports to them
- **Capabilities description** — a short paragraph on what this agent does and when they're relevant (helps other agents discover who can help with what)

Example: A CEO agent's adapter config tells it to "review what your executives are doing, check company metrics, reprioritize if needed, assign new strategic initiatives" on each heartbeat. An engineer's config tells it to "check assigned tasks, pick the highest priority, and work it."

Then you define who reports to the CEO: a CTO managing programmers, a CMO managing the marketing team, and so on. Every agent in the tree gets their own adapter configuration.

### Agent Execution

Paperclip supports several ways to run an agent's heartbeat:

1. **Local CLI/session adapters** — Paperclip starts or resumes local coding-tool sessions such as Claude Code, Codex, Gemini, OpenCode, Pi, and Cursor, then tracks the run.
2. **Run a command** — Paperclip kicks off a process (shell command, Python script, etc.) and tracks it. The heartbeat is "execute this and monitor it."
3. **Fire and forget a request** — Paperclip sends a webhook/API call to an externally running agent. The heartbeat is "notify this agent to wake up." OpenClaw-style hooks work this way.
4. **External adapter plugins** — Paperclip loads adapter packages through the plugin/adapter flow so self-hosted installs can add runtimes without hardcoding them in core.

Project repositories are optional. QA Harness tasks may use suite-local test assets and a target environment without a separate business checkout. Boards can reuse existing business checkouts reported by their owned or managed seats while retaining the native project workspace model.

Agent runs can use project and execution workspaces, managed runtime services such as preview/dev servers, adapter-specific session state, and HTTP/webhook-style execution. We provide sensible defaults, but the adapter is still the boundary: if a runtime can be invoked, observed, and authorized, Paperclip can coordinate it.

### Task Management

Task management is hierarchical. At any moment, every piece of work must trace back to the company's top-level goal through a chain of parent tasks:

```
I am researching the Facebook ads Granola uses (current task)
  because → I need to create Facebook ads for our software (parent)
    because → I need to grow new signups by 100 users (parent)
      because → I need to get revenue to $2,000 this week (parent)
        because → ...
          because → We're building the #1 AI note-taking app to $1M MRR in 3 months
```

Tasks have parentage. Every task exists in service of a parent task, all the way up to the company goal. This is what keeps autonomous agents aligned — they can always answer "why am I doing this?"

The current issue model includes stable issue identifiers, parent/sub-issues, blockers, a single assignee, comments, issue documents, attachments and work products, and review/approval handoffs. That structure keeps work inspectable by both the board and agents while still allowing agents to decompose work into smaller tasks.

### Company Skills and Policy

Company skills are shared operating capabilities, not privileged objects by default. Every authenticated agent in a company can create, import, install, edit, update, test, reset, and remove that company's skills unless the company has configured an explicit restriction.

The governing rule is: **skill permissions are opt-in restrictions, not opt-in capabilities**. Missing skill grants never create a denial in an otherwise unconfigured company, and ordinary skill work does not require board confirmation, a draft-only workflow, or an activation approval.

Core Paperclip owns the skill runtime, company-boundary enforcement, policy evaluation contract, API denials, validation, path containment, secret redaction, and activity logging. Those safety invariants cannot be disabled by policy. Open-by-default skill work never authorizes arbitrary host-path reads, unsafe executable content, or policy edits: local imports and scans must stay within Paperclip-known workspace or managed-skill roots, remote sources must resolve to validated immutable content, and platform safety denials must stay distinct from optional administrative restrictions. Paperclip EE may provide detailed administration for per-agent, per-role, per-action, per-source, and protected-skill rules, but EE is not required to use skills and is not an enforcement boundary. Without EE, companies remain open by default and any already-configured restrictions continue to be enforced by core.

An explicit restricted policy may deny selected operations or switch to a default-deny preset with explicit allow rules. Core exposes a stable versioned policy API so EE and other administrative clients configure and simulate the same evaluator used by skill mutation routes. Core Skill Studio only needs to perform normal skill work, explain an explicit denial, and point administrators to EE when its richer policy UI is available; it must not recreate a partial enterprise permission editor.

## Principles

席位接入服务安装包含当前用户、当前席位独立的每分钟巡检。服务停止或本机成功心跳证据超过 90 秒时，巡检通过既有 `harness online` 恢复连接，两次尝试至少间隔 5 分钟。手动下线和升级期间跳过；不强制终止任务或绕过网页暂停、派单及审批门禁。该机制依赖电脑运行和用户会话，不承诺睡眠、关机、退出登录或断网期间在线。

客户端升级仅由管理员在网页对具体席位和目标版本明确下发，不因发布新版本自动推广。支持网页升级的客户端通过独立巡检领取有期限的请求，空闲后按既有升级流程执行；忙碌及离线等待，未领取可取消，失败由管理员核对后重试。原有任务、待确认和执行锁保护保持生效，目标版本新心跳确认后才显示成功。旧客户端须先在本机升级一次以获得网页升级能力。

1. **Unopinionated about how you run your agents.** Your agents could be OpenClaw bots, Python scripts, Node scripts, Claude Code sessions, Codex instances — we don't care. Paperclip defines the control plane for communication and provides utility infrastructure for heartbeats. It does not mandate an agent runtime.

2. **Company is the unit of organization.** Everything lives under a company. One Paperclip instance, many companies.

3. **Adapter config defines the agent.** Every agent has an adapter type and configuration that controls its identity and behavior. The minimum contract is just "be callable."

4. **All work traces to the goal.** Hierarchical task management means nothing exists in isolation. If you can't explain why a task matters to the company goal, it shouldn't exist.

5. **Control plane, not execution plane.** Paperclip orchestrates. Agents run wherever they run and phone home.

## User Flow (Dream Scenario)

1. Open Paperclip, create a new company
2. Define the company's goal: "Create the #1 AI note-taking app, $1M MRR in 3 months"
3. Create the CEO
   - Choose an adapter (e.g., process adapter for Claude Code, HTTP adapter for OpenClaw)
   - Configure the adapter (agent identity, loop behavior, execution settings)
   - CEO proposes strategic breakdown → board approves
4. Define the CEO's reports: CTO, CMO, CFO, etc.
   - Each gets their own adapter config and role definition
5. Define their reports: engineers under CTO, marketers under CMO, etc.
6. Set budgets, define initial strategic tasks
7. Hit go — agents start their heartbeats and the company runs

## Guidelines

There are two runtime modes Paperclip must support:

- `local_trusted` (default): single-user local trusted deployment with no login friction
- `authenticated`: login-required mode that supports both private-network and public deployment exposure policies

Canonical mode design and command expectations live in `doc/DEPLOYMENT-MODES.md`.

## Further Detail

See [SPEC.md](./SPEC.md) for the full technical specification and [TASKS.md](./TASKS.md) for the task management data model.

---

Paperclip’s core identity is a **control plane for autonomous AI companies**, centered on **companies, org charts, goals, issues/comments, heartbeats, budgets, approvals, and board governance**. The public docs are also explicit about the current boundaries: **tasks/comments are the built-in communication model**, Paperclip is **not a chatbot**, and it is **not a code review tool**. The roadmap already points toward **easier onboarding, cloud agents, easier agent configuration, plugins, better docs, and ClipMart/ClipHub-style reusable companies/templates**.

## What Paperclip should do vs. not do

**Do**

- Stay **board-level and company-level**. Users should manage goals, orgs, budgets, approvals, and outputs.
- Make the first five minutes feel magical: install, answer a few questions, see a CEO do something real.
- Keep work anchored to **issues/comments/projects/goals**, even if the surface feels conversational.
- Treat **agency / internal team / startup** as the same underlying abstraction with different templates and labels.
- Make outputs first-class: files, docs, reports, previews, links, screenshots.
- Provide **hooks into engineering workflows**: worktrees, preview servers, PR links, external review tools.
- Use **plugins** for edge cases like rich chat, knowledge bases, doc editors, custom tracing.

**Do not**

- Do not make the core product a general chat app. The current product definition is explicitly task/comment-centric and “not a chatbot,” and that boundary is valuable.
- Do not build a complete Jira/GitHub replacement. The repo/docs already position Paperclip as organization orchestration, not focused on pull-request review.
- Do not build enterprise-grade RBAC first. Paperclip now has authenticated mode, company memberships, instance roles, and permission grants, but fine-grained enterprise governance should remain secondary to the core company control plane.
- Do not interpret agent-level privacy flags as a project/issue privacy feature in V1; work visibility stays company-scoped.
- Do not lead with raw bash logs and transcripts. Default view should be human-readable intent/progress, with raw detail beneath.
- Do not force users to understand provider/API-key plumbing unless absolutely necessary. There are active onboarding/auth issues already; friction here is clearly real.

## Specific design goals

1. **Time-to-first-success under 5 minutes**
   A fresh user should go from install to “my CEO completed a first task” in one sitting.

2. **Board-level abstraction always wins**
   The default UI should answer: what is the company doing, who is doing it, why does it matter, what did it cost, and what needs my approval.

3. **Conversation stays attached to work objects**
   “Chat with CEO” should still resolve to strategy threads, decisions, tasks, or approvals.

4. **Progressive disclosure**
   Top layer: human-readable summary. Middle layer: checklist/steps/artifacts. Bottom layer: raw logs/tool calls/transcript.

5. **Output-first**
   Work is not done until the user can see the result: file, document, preview link, screenshot, plan, or PR.

6. **Execution visibility without log worship**
   Active runs, recovery issues, blockers, and work products should be first-class surfaces. Raw transcripts are available when needed, but they are not the primary product surface.

7. **Local-first, cloud-ready**
   The mental model should not change between local solo use and shared/private or public/cloud deployment.

8. **Safe autonomy**
   Auto mode is allowed; hidden token burn is not.

9. **Thin core, rich edges**
   Put optional chat, knowledge, and special surfaces into plugins/extensions rather than bloating the control plane.

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
### Experimental persistent agent conversations

Agent Chat is an opt-in core task presentation (`enableAgentChat`, off by default). Each person has one persistent task-backed conversation per agent and company, with ordinary company task visibility. The shared task composer, transcript, tools, files, and document panel remain the interaction surface. Agents clarify goals and hand substantial execution to linked, assigned tasks; a reply ends a turn without completing the conversation. `/new` starts fresh provider context in the same conversation while preserving visible history and artifacts. Healthy idle conversations wait for a message and do not count as unfinished execution work. See `doc/plans/2026-09-10-agent-chat.md` for the implementation contract.

### Agent chat project handoff (2026-09-11)

Chat supports research and full plan drafting/revision in its existing plan document. On handoff, each ordinary assigned task receives the relevant plan in its own `plan` document, committed with task creation before execution is scheduled. The source plan remains in the conversation. Plan acceptance hands off execution; it never switches the conversation into implementation.

Chat instructions require selecting a suitable project, reusing an existing one where appropriate. The project requirement is prompt-only; ordinary projectless tasks remain supported. New parent relationships beneath conversation tasks are rejected by task services, including direct API creation and reparenting. Existing children remain readable/editable and can be moved elsewhere. The Subtasks panel is unchanged.

The `create_project` runtime tool uses the normal project API with durable idempotency. `list_projects` and `list_project_repositories` support selection. Multiple `repositoryIds` select authorized catalog entries; multiple HTTPS GitHub `repositoryUrls` register existing repositories absent from the catalog. IDs and URLs may be combined, but cannot accompany an explicit `workspace`. URLs do not create repositories on GitHub or grant credentials. Execution uses normal repository access rules. Repository IDs are revalidated against the authenticated run's responsible user and connection grants. Agents should consider proper available repositories, clarify material ambiguity, and use repository-free projects when appropriate for non-code work.

Confirmed project creation appears as a durable card in the shared task transcript, including selected repository links. Tasks are linked inline. Failed creation never produces a success card. Tool evals cover planning/handoff, project/repository selection, retries, permission and mode denials, and ordinary delegation regressions using the production chat directive.

### In-app announcements

An optional announcement card shares product news with board users on opening
or returning to Paperclip. Dismissals persist per user across companies and
browsers within an instance. Operators can disable fetching independently of
telemetry. See [Announcements](ANNOUNCEMENTS.md).

### Agent chat discovery

With Agent Chat enabled, the Chats sidebar always includes the company's
earliest-created agent, plus personal starred agents and up to four other recent
conversations. First use has the same compact rows as returning use. The compose
icon shares a column with stars and appears on hover or keyboard focus (always on
touch). It opens a company-wide name/role search, independent of sidebar membership.
Selecting an agent opens their persistent conversation; it does not reset history
or create a task until the existing first-write flow requires one.


## DSP7 集成更新（2026-10-22）：统一平台派单

新增执行统一由智研平台项目页的“派单并执行”发起；Jira 指派只参与校验，不再扫描建单或触发执行。平台独立审计授权，客户端持久领取、排队并打开本机可见终端；仅登记仍等待本人启动。未明确派单的旧任务不自动开工。实现与兼容边界见 `doc/plans/2026-10-22-platform-dispatch.md`。

明确恢复已中断的本机出站会话时，平台在同一事务中核对席位停止证明与旧运行身份、释放的执行环境，并同步旧运行的停止确认，再重新授权本机启动。旧操作结果仍保留为未知，不重放旧操作，也不跳过其他执行保护。


## DSP7 席位时间统计（2026-10-22）

席位统计保留工单、执行、人工等待、在线空闲和质量数据，移除“未知时长”和时间“覆盖率”的页面展示；仅增加“工作时段在线”辅助列，不设在线率、达标率或排名。在线以服务端收到的席位心跳为依据，有效期 90 秒，与执行状态、暂停接单无关；只累计 Asia/Shanghai 工作时段内截至当前的连接区间，席位创建前不计入，人员多电脑取并集。没有心跳证据的工作区间标记“统计不完整”，可展开查看，不推算成离线或人员工时。

工作规则按组织持久保存，管理员通过统计区默认折叠的“工作时段设置”配置 ISO 工作日（周一为 1、周日为 7）及最多四个同日、不重叠的时间段。默认周一至周五 09:00–12:00、13:00–18:00；修改规则后历史查询也按新规则计算。本期不含法定节假日日历、请假审批或免考核模块。`PUT /api/companies/:companyId/managed-seat-report/work-schedule` 要求组织管理员权限、组织访问校验并在同一事务记录活动日志；报表返回实际规则与配置权限。旧 API 的时间缺口字段保留用于诊断兼容，界面不展示。


## DSP7 明确停止与一次真实重试（2026-10-23）

网页停止或 `harness stop <Jira 工单号>` 留下持久停止意图，先记录再取消／发信号；离线意图与下次席位心跳一起同步。Esc、Ctrl+C 和未知退出码不证明用户停止整个任务。明确停止后必须人工恢复；晚到的明确停止也会阻断尚未启动的自动重试。

新版客户端发起的本机出站 Claude 运行在未知失败、超时或断连后，可在已有平台授权下自动重试一次。必须先核验最新运行的真实停止证明、席位空闲、环境已释放、组织与负责人归属及所有原有执行保护。原子记录新派单授权，交由本机重新核验 Jira、锁与预算门禁并打开可见终端；每次显式派单／恢复仅有一次机会。历史运行不追溯启动。通用唤醒不创建本机执行意图；缺少真实启动时返回失败，不能冒充成功。页面区分准备自动重试与运行中，审计保留未知操作结果。


## 管理工作台与交付核验（2026-10-27）

组织首页按工单给出互斥的管理结论：需要处理与核实、已确认执行、待安排与调度。业务状态 `in_progress` 本身不证明进程正在运行；停止记录、当前席位心跳、离线和读取失败分别展示。待处理中心按工单合并提醒，显示处理负责人、证据时间与下一步，并保留原审批和历史通知入口。通知已读或归档不表示问题解决。

管理员默认组织概览，其他成员默认我的工作；个人范围包含直接指派及当前指派给本人席位的工单。范围偏好仅保存在当前浏览器，按账号与组织隔离，URL 显式范围优先；组织权限仍由原 API 执行。首页跳转保留项目与范围，工单列表沿用相同的管理结论。

月度排期在整月结果上组合来源条件、风险筛选和排序，再分页。计划已过、本周到期按上海时区计算，责任人缺失、准入待核验和日期缺失独立标记；无效日期排在有效日期之后。这些信号不认定正式延期、准入通过或验收完成。

项目准备区区分已保存配置与实际连接验证；席位接单准备缺项不授予逐单执行权限。执行记录用工单、席位、负责人和失败摘要提供上下文，仅搜索最近 50 次运行，关联元数据未完整时明确提示。列表不读取受管会话正文。

条目材料按阶段索引产物路径与指纹、正式来源引用及核验入口。阶段回执必须匹配当前任务、运行、Jira 工单与输入版本，设计和测试用例还需匹配当前回执版本的正式评审；分析材料按独立修订按需读取。阶段交付与正式验收分别展示。费用、会话缺口与未分类任务保留数据质量说明，不以未知计零，不虚构延期率或人员绩效归因。

### 管理协作跟进

管理事项可记录独立的协调负责人和本地到期提醒。成员可认领未认领事项、释放自己的跟进；管理员可转交给组织内有效成员。此记录不改变工单唯一执行人、执行许可、预算或正式审批。提醒在管理事项中显示，不表示已经发送站外通知。并发更新按版本检查，冲突后刷新最新记录。
条目交付的功能测试报告与测试通过分别记录。测试结果必须注明被测版本并与逐条执行记录对账；失败、阻塞、跳过和结果未知均不会自动进入验收。对于已有明确失败证据的测试，组织管理员可关联已有缺陷、独立评审及重测工单，配置不同的修复和评审席位，授权一轮串行修复链。系统保留每轮原失败报告及版本，最多三轮；评审未通过、原件变化、预算或执行治理门禁未通过时停留待处理，不自动创建重复缺陷或批准带缺陷上线。


## Harness 执行边界（2026-11-03）

平台向已授权席位派发工单并记录执行状态；仓库选择、本机目录及工作树由研发电脑上的 Harness 套件负责。接单设置与 Jira 工单接入不再要求选择单个共享仓库，一个工单可以按 Harness 技能涉及多个仓库。平台保留公司、项目、席位授权、独占执行、预算和交付证据规则。


### Instance personnel federation (2026-11-04)

Personnel identity sources, external people, departments and sync jobs are shared
across the instance and managed only by instance administrators. Sync once per
enterprise; organizations reuse that directory through explicit membership
assignment. Synchronization and identity linking do not create organization
memberships or grant roles. Existing accounts, passwords, memberships and seat
ownership are preserved. Notification recipients use active shared DingTalk identities
matching the bot CorpId, without requiring organization membership. Selecting a
recipient does not grant organization access; notification configuration remains
company-scoped.
The system directory is an explicit exception to company-scoped domain storage;
organization permissions and execution remain isolated.

### Configurable delivery templates (2026-11-05)

Organization managers configure delivery under the home navigation → 交付链 (`/delivery-chain`); the legacy Settings entry remains available. Projects inherit the organization template unless they publish an override; publishing a restore-inheritance version resumes following organization changes. With no published template, new deliveries automatically use design → responsible human design review → parallel coding → independent code review → test-case writing → responsible human case review → functional testing → human acceptance. Template defaults do not launch work on a page read. Starting a delivery explicitly binds real child issues and seats.

Stage configuration exposes work-only or work-then-review ordering and previews the full sequence. Launching the latter binds real review tickets to specific work tickets; multiple coding branches may share a review. Human design/case reviews are assigned to the responsible user and require formal Jira review evidence. Code review uses a separate capable seat. Existing workflows keep their pinned template.

交付链可分别指定每类工作单和评审单由人工或 Agent 执行。人工任务指定组织成员，登记正式交付版本及材料后衔接后续；Agent 任务匹配对应原生 Harness 能力，缺少能力时明确阻止派发。

### 评审返工（2026-11-05）

交付链支持配置评审退回后自动交原执行人修改并重新送审，或暂停后手动发起返工。每轮评审及材料保留历史，新版本通过后才进入后续阶段。

本机客户端更新（2026-11-05）：由当前操作系统用户执行 `harness upgrade` 时，统一更新同一网站的各组织席位，保留独立身份与配置。先检查全部目标空闲，每个席位更新前再次检查；中途失败保留完成与剩余记录，由用户重试。网页管理员升级仍限已授权席位，不扩大到其他组织；发布新包不触发升级。

### 席位并发执行

每个席位可独立设置最大并发工单数（1–50，默认 1）。新版主动连接客户端支持多个工单同时执行；达到上限的授权任务排队，释放名额后继续。等待人工处理、已领取待启动和退出尚未核验的执行占用名额。降低上限不终止已有运行；旧客户端及 SSH 席位保持单任务。

## Harness observation candidate (2026-11-14)

The private managed-session API can expose bounded Harness runtime summaries to the existing session owner/managers. This is an opt-in candidate capability, not delivery approval or execution-time accounting. See [protocol plan](plans/2026-11-14-harness-observation-protocol.md).

## Candidate Harness bundle inspection

Owners/managers may query seat-reported candidate L3/L4 package metadata through the private bundle API. Local verification, actual host loading and task execution readiness remain separate states; this candidate does not add a UI page or make packages eligible for dispatch.

## Harness isolated validation preparation (2026-11-16 candidate)

Organization managers can prepare and revoke a short-lived authorization for an explicitly allowlisted synthetic history task and frozen L3/L4 bundle. Discovery remains observation-only. Preparation does not wake a seat or create a run. A separate explicit dispatch now reserves one request and uses the native heartbeat scheduler; the fixed Bridge entry runs only the authorized synthetic fixture under the original permit. This candidate has local verification; live rollout and joint acceptance remain pending. Native execution permits enforce a separate validation domain, one run per authorization, budgets, cancellation, process-tree supervision and authorization expiry. See [dispatch scope and remaining acceptance](plans/2026-11-16-harness-validation-dispatch.md).
