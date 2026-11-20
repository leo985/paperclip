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
条目交付的功能测试报告与测试通过分别记录。测试结果必须注明被测版本并与逐条执行记录对账；失败、阻塞、跳过和结果未知均不会自动进入验收。对于已有明确失败证据的测试，组织管理员可复用条目原编码、原代码评审和原功能测试任务，授权一轮返工。系统保留每轮原失败报告及版本，最多三轮；评审未通过、原件变化、预算或执行治理门禁未通过时停留待处理，不自动创建重复缺陷或批准带缺陷上线。


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

### 分析完成后自动保存轻舟（2026-11-10）

关联轻舟条目的分析通过当前版本质量评审并完成本地交付后，自动把分析正文保存至该条目；页面分别显示本地完成、轻舟回写和正式发布状态。执行席位独立配置的轻舟账号须具备该条目分析负责人的权限；未配置时提示席位负责人或管理员配置，不借用项目来源账号；失败保留成果，可修改保存参数后重试。保存保留已有业务字段，缺少时使用界面明确说明的可修改默认值；轻舟可能按业务共性重新分配评审人。其余客户原始材料保留本机。保存内容不自动申请评审、不代替正式业务审签与交接包发布。


### 按条目编号精确查询（2026-11-11）

需求条目页在月度排期和已纳管列表提供按完整条目编号精确查询。选择项目后，组织管理员使用该项目保存的轻舟凭据直接读取基本信息，不受排期月份、列表筛选或是否已纳管限制；来源可见范围由该账号权限决定。返回编号、名称、来源状态、拆分人员、条目分析负责人和当前组织各未归档项目中同来源的最新已保存版本入口，不返回原始报文或凭据。查询不保存快照或派单。结果可直接进入已保存的条目详情；本组织没有已保存版本时，用户可按查询月份手动同步并打开详情，也可以补录其他排期月份。来源配置或凭据在查询期间变化时拒绝旧结果。

需求条目详情的「工单与执行」按主工单分组，在对应子工单行内显示交付材料、正式结论及核验状态。条目级需求分析材料和正式验收记录在同一视图内单独展示。旧的「交付物与核验」链接继续打开该视图。在线 Jira 快照中的已完成子工单可查看 Jira 来源附件，已完成评审单还可查看 Jira「结果描述」原文。平台核验状态独立显示。


### 月度排期与期望交付分类（2026-11-11）

月度列表支持合并“本组织已排期”和“本月期望交付”两类条目，并按完整编号去重；条目可同时属于两类。组织来源配置新增可选 `subProductAttribution`（轻舟子产品归属代码，例如 DSP）：配置后，按该产品期望交付月份跨研发、测试组织补齐条目，并核对本组织排期条目的产品归属；留空保留原单组织排期模式。分类筛选在分页前生效，与其他筛选组合，URL 保留 `mScope`；清除筛选和切换项目会清除分类。整月同步重新读取合并清单，不受分类筛选限制。单条同步核对产品归属，读取配置组织及条目实际研发、测试、拆分组织的排期，允许尚未排期条目保存完整来源/Jira 版本。期望交付月份不等于实际交付完成，未读取工单数显示待核对，不能当作零工单。

组织管理员可在组织来源配置中查看已保存的轻舟登录账号，密码框以 `***` 显示已配置状态。

组织管理员可在「需求条目 → 月度排期」选定项目，点击月度条目顶部「刷新条目」旁的「定时同步」打开设置。默认关闭，开启时可设置每天的北京时间（预填 06:00）。服务器在运行时重新读取当月全部条目及相关 Jira 工单并保存来源快照，关闭网页后仍会运行。设置面板显示下次运行和最近一次同步的状态及成功、失败数量。

### 统一任务详情（2026-11-11）

分析、研发、测试及人工任务统一从任务 URL 查看概况、操作、进度、成果和会话记录，专属领域功能继续使用原接口与核验规则。分析列表保留创建及筛选，旧分析详情链接进入统一任务详情。任务对话、文件、属性、关联工作及高级操作保留为同页视图，既有深链接继续有效。完整迁移对照与原生流程协议边界见 [统一任务详情](plans/2026-11-11-unified-task-detail.md)。

### 任务入口归并（2026-11-12）

侧栏仅保留“任务”入口。任务页复用 AI 交付链的 `DELIVERY_STAGES` 和 `DELIVERY_STAGE_LABELS`，提供全部任务、需求分析、研发设计、编码与代码评审、测试用例、功能测试及其他任务筛选；环节、项目和任务状态条件可以组合，切换环节保留其他筛选。所有环节使用同一任务列表及统一详情。新建分析／新修订保留原表单与接口；其他交付环节通过需求条目安排任务，不绕过交付链准入。

Compact 任务响应新增可选 `deliveryStages`，服务端仅为当前用户可见任务按组织范围查询分析记录与交付链阶段关联；不根据标题猜测，也不把席位能力或运行阶段当作业务环节。评审任务归入对应环节，修复／重测使用其真实阶段，重复关联去重。明确无关联的任务才归入其他任务；缺少投影或读取失败必须显示异常。无数据库迁移、权限扩大或客户端协议变更。旧 `/analysis-executions` 链接和 `taskType=analysis` 保持兼容，保留项目、来源、任务和修订上下文。

### 工作台与 AI 任务（2026-11-13）

工作入口合并为“工作台”，默认进入“待我处理”；“我的关注”查看本人及所属席位的任务进展，组织管理员另有“组织概览”。原“待处理中心”不再作为一级菜单，旧链接保留组织、项目、事项筛选及历史通知上下文后跳转。AI 任务保留完整交付环节、状态、负责人和历史查询，待办进入既有统一任务详情处理。个人/组织范围共用按账号与组织保存的偏好，普通成员不能通过 URL 或旧偏好扩大范围。

待办按具体人工操作计数，分析问题来自当前运行的有效未答复记录，支持同一任务多个问题；已回答、失效和旧运行的问题不重复计入。组织审批未指定接收人时只进入组织范围，不自动分派给每个管理员。设备离线按席位合并列出受影响活动任务；执行证据缺失和一般设备提醒作为关注信息单独展示。通知与历史收件记录继续支持原有已读和归档操作，但这些操作不解决尚未结束的业务待办；工作台不使用原收件箱角标冒充待办数。

### AI task visibility (2026-11-12)

The AI任务 collection defaults organization owners/admins and instance administrators to organization scope, with an optional personal view. Other human members are restricted to tasks assigned to themselves or their currently owned registered DSP7 seats. Members without a seat retain directly assigned tasks. This boundary applies before task pagination and search aggregation, and also to task detail access and analysis-task legacy endpoints; URL filters cannot widen it. Existing company boundaries and agent authorization continue to apply.

### 月度交付刷新（2026-11-13）

重复打开月度交付可复用最多 30 秒的来源数据，页面保留真实采集时间。“刷新条目”主动重读轻舟；平台纳管、分析及交付链准入状态每次请求重新核验。来源读取失败仍显示失败，不能把不完整结果显示成空月份或已完成交付。


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


### 工单与执行统一视图（2026-11-17）

条目“工单与执行”使用一份主子工单表，同时展示来源状态、经办人、排期、关联平台任务、运行状态及操作，默认显示全部子单（含未排期测试单）。可筛选待安排、已接入和来源已结束；已接入工单沿用原任务查看与恢复。该页不再重复显示来源工单树或已在行内展示的平台任务列表，未匹配当前来源的关联任务仍单独可查。来源差异说明保留，来源结束数量不代表正式验收通过。


### 独立评审执行入口（2026-11-17）

“工单与执行”中的设计评审、代码评审及用例评审可进入交付链评审配置，定位并预选当前真实评审子单，不走普通编码 Jira 接入。管理员须明确绑定同一主工单的被审工作单，登记已有交付或等待工作单交付，按项目既定人工／Agent 策略执行；Agent 席位仍需匹配 Jira 经办人和领域评审能力。项目模板未启用相应独立评审时显示设置提示，不因单次入口访问修改模板。已有交付实例沿用原任务，不能从入口追加或重复派发评审。


### 交付链自动启动计划（2026-11-17）

启动交付链默认由服务端读取最新 Jira 子单，按项目已发布模板纳入全部对应工作单及评审单、生成依赖、按精确经办人账号与领域能力匹配席位，并核验已有交付。用户查看计划后一次授权启动；多主工单、评审关联歧义、测试环境/历史结果或席位缺失时仅补充实例例外。项目模板不因本次中途接入而变更。原人工启动、人工评审、预算停止及最终验收策略继续生效。

自动计划可先启动包含待核验历史节点的分支。缺少附件或评论的历史独立评审，到达节点后由授权管理员依据正式 Jira 结论登记。历史功能测试缺少报告或通过数时，到达测试节点再登记正式报告、被测版本和全部通过用例数。下游等待核验完成。尚未完成的 Jira 测试沿用模板执行及结果提交规则。

管理员可勾选一个或多个已就绪主工单授权启动。其余主工单可待补齐后追加，或经单独确认排除出本次交付及验收范围。已启动的主工单继续纳入验收。只保存忽略范围时不创建或派发节点。

未启动的主工单可在本次计划里选择忽略测试用例编写及评审。重新生成计划并授权后，功能测试和其他阶段仍按项目流程推进，项目模板继续用于其他主单。

席位待匹配的计划节点显示 Jira 经办人。未分配经办人时在节点上直接标明。

主工单计划按依赖从左到右展示节点，点选节点可查看直接前置和后续节点。图中标明快照已有的期望结束日期及回退来源，原计划表可展开查看。

节点直接显示 Jira 进度。已结束的历史工单仍需核验时，计划图同时标明核验状态。

待执行的功能测试需要提供可核对环境及部署版本的发布记录链接。计划只对需要此信息的主单显示输入框，项目模板也可将该链接设为开始节点的准入条件。

条目详情的“交付计划”卡片有已保存的计划或可查看的交付实例时显示“查看计划”。工单行的“交付计划”入口会展开卡片，已有保存计划的未启动条目直接打开计划内容。确认没有已保存的计划且尚未启动时，管理员可以点击“生成交付计划”。

交付计划生成后保存其内容和生成选项。再次打开条目只读取已保存的计划，选择重新生成会替换旧计划。若来源快照或已授权的交付范围变化，页面仍显示保存的计划，并提示重新生成后再授权。启动接口重新计算并比对计划摘要，事务内核对来源、席位授权/Harness 登记与历史成果版本；任何变化要求重新查看计划。相同授权请求重试幂等，失败回滚，保留组织隔离及活动任务防重。详见 `doc/plans/2026-11-17-delivery-automatic-start.md`。

交付链的条目执行入口统一创建或查看实例；工作台仅列出已激活且需要当前人员办理的节点动作，任务页可以返回所属实例与节点。未到达节点仍可作为进度查看，但不计入可办理待办；人工提交或 Agent 结果须经实例校验后推进。人工工作、人工评审和 Agent 交付后的人工核验分别表达，最终验收继续遵循管理员治理规则。

### 席位月度交付报表

「席位看板」按轻舟当月条目下的 Jira 子工单展示进度。子工单截止日用于判断风险，已归月的工单即使缺截止日也计入进度。管理员查看组织数据，席位负责人查看当前归属自己的席位。点击风险或员工可筛选子工单明细，主工单编号用于追溯归属。子工单以最近已同步的 Jira 状态判断是否完成，同一员工的多个席位参与同一子工单只计一次，组织汇总按项目去重。

子工单明细在筛选后按项目和主工单编号聚合，默认只显示组头中的项目、主工单编号及当前筛选下的子工单数量。点击组头可展开或收起该组子工单，也可一次展开或收起当前筛选结果中的全部分组，翻页时保留展开状态。各组按最紧急子工单排序，每页展示 20 个完整分组，同一主工单的子工单不跨页；缺少主工单编号的子工单按项目归入「未关联主工单」组。

子工单的 Jira 经办人或研发负责人能唯一匹配到席位负责人的账号，即可计入该员工的进度。可以保存席位的 Jira 账号并保持接单关闭，供报表归属使用。该子工单在交付链中的执行席位也可提供归属，不继承主工单或相邻子工单的负责人。

### 条目下多个主工单的交付

条目交付计划列出本次同步的所有 Jira 主工单及其工作和评审子单。管理员可授权全部已就绪主单，也可单独启动。条件未齐的主单补齐后在同一实例继续启动。需求分析按条目共用；工作、评审和测试默认在主单内推进。确有跨主单依赖时，可为待启动主单指定一个前置主单，等其交付核验后再授权。系统保留各次授权范围和排除原因。待启动或未核验的主单会挡住条目正式验收。

需求条目页在当前浏览器中按组织记住上次选择的项目，重开页面时仅恢复仍可访问且未归档的项目；链接中指定的项目优先，清空项目筛选会清除该偏好。
