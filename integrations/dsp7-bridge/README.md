# DSP7 Paperclip 第一期接入桥

本目录是智研协同平台 fork 内维护的席位桥源码，支持 macOS、Linux 和原生 Windows 接入。推荐从网站“席位 → 接入我的电脑”生成命令；Windows 选择 PowerShell，使用 Python 3.10+ 和 pywinpty，不需要 WSL。Windows 当前尚待实机验收，先验证模拟任务再启用正式自动执行。

服务端负责授权、调度和记录，Claude 与模型配置保留研发电脑。最新使用说明见网站帮助中心；下文保留一期试点的设计与运行记录，单 Mac／单工单等表述属于当时的范围。

## 实现范围

- 明确登记 Jira 子工单；绑定唯一 Paperclip 任务；不扫描所有工单。
- 使用 DSP7 公司内专用非管理员身份调用控制面，不持有管理员运行会话。
- 校验工单类型、经办人、需求／附件指纹和就绪状态；编码任务要求工单独占 worktree。
- 真实 run ID、任务归属和工单执行锁校验；不按超时直接抢占执行权。
- 阶段摘要、阻塞报告、JCONF、通知去重及有效确认后的再次唤醒。
- 复用现有 Harness 的通知构造与 Jira 回复校验；正式决策仍在 Jira。
- Mac 通知可用；钉钉需配置 Webhook 和逐工单发送授权。本机通知调用成功不保证 Focus 模式下可见。
- 运行时间和 `usageJson` 按 run ID 保存；缺失用量标记 unknown，成本不等于 Claude 订阅账单。
- 完成前核验领域 completed、证据文件、Jira 交付评论、tracker 回执或明确降级记录。
- 显式模拟模式：真实 Jira 只读，回复与 tracker 回执写入独立 replay 目录，不能混入真实业务数据。

尚未覆盖：多人／跨机器租约、设计依赖自动解析、通用 Jira webhook、通知超时升级、tracker 自动补报、内嵌 UI。第一期真实编码开发还需目标仓库、工程权限和一张未完成工单验收。

## 运行位置与配置

源码：`/Users/leo/work/fingard/paperclip-dsp7-integration`。

本机配置与持久化文件均在 `~/.config/paperclip-dsp7-bridge/`：

| 文件 | 用途 |
|---|---|
| `config.json` | API 地址、company／Agent、目录、轮询和通知模式 |
| `access.json` | 非管理员 Paperclip 服务身份的 API key、有效期及撤销标识，0600 |
| `jira-access.json` | 有效 Jira 凭证，0600；不输出、不提交 |
| `bridge.sqlite3` | 映射、执行锁、运行、事件与通知回执 |
| `replays/` | 独立模拟工单状态与验收产物 |
| `watch.log` / `watch.error.log` | 本机监督服务日志 |

模板见 [config.example.json](config.example.json)。不要把真实凭证复制进源码目录。默认 API key 有有效期，过期后通过专用服务账号重新签发并替换受限文件；无需改用管理员账号。

```bash
python3 pilot.py doctor
python3 pilot.py status
python3 pilot.py report --output /absolute/path/report.json
```

监督服务由 `com.leo.paperclip-dsp7-bridge` LaunchAgent 运行。当前 Mac 需保持登录、唤醒且内网可达；服务只处理 enabled 的登记工单，空名单不启动任务。

```bash
python3 install_launchagent.py
launchctl print gui/$(id -u)/com.leo.paperclip-dsp7-bridge
launchctl kickstart -k gui/$(id -u)/com.leo.paperclip-dsp7-bridge
```

## 真实工单登记

先核实实际 Jira 类型和可执行状态、研发负责人、源码 worktree、领域状态根目录，以及没有其他执行者。首次仅允许一张启用工单。示例工单号不代表已授权开工：

```bash
python3 pilot.py register --jira ATSES-XXXXX --workflow feature \
  --worktree /absolute/path/to/ticket-worktree --ready-status '实际就绪状态'
python3 pilot.py enable ATSES-XXXXX --confirm-no-other-executor
```

`register` 不启用任务；`enable` 后监督服务会调度。钉钉模式需在配置设置 `notifications=dingtalk`，并在登记时显式提供 `--allow-notifications`；发送仍需有效 Webhook 和接收人映射。首次试点的“无其他执行者”需要负责人检查；第一期不能拦截完全不遵守该锁的历史人工 Claude 会话。

需求或经办人变化后保持阻塞，不自动更新旧指纹。修复环境／接口问题后，通过人工核验重试，不自动重新执行失败的开发：

```bash
python3 pilot.py retry ATSES-XXXXX --reason '已核验的修复原因'
python3 pilot.py disable ATSES-XXXXX
python3 pilot.py cancel ATSES-XXXXX
```

`disable` 只停止新调度；`cancel` 才会取消本工单活动 run，核对并终止匹配 run ID 的本机 Claude 进程树，确认停止后释放锁。不处理其他 Claude 窗口。实际 SSH 环境中，仅看到 Paperclip cancelled 不能证明本机进程已经退出。

## Agent 工具协议

只在真实 Paperclip run 中使用下列工具，凭证由运行环境注入。工具拒绝未登记任务、其他 Agent、归属不符或缺少真实 run ID 的调用。

```bash
/usr/bin/python3 /Users/leo/work/fingard/paperclip-dsp7-integration/pilot.py agent inspect
/usr/bin/python3 /Users/leo/work/fingard/paperclip-dsp7-integration/pilot.py agent claim
```

阶段、阻塞及完成输入为 JSON stdin，禁止把 Jira 动态文本拼入 shell。字段示例：

```json
{"summary":"本阶段结论","evidence":["本工单证据文件.md"]}
```

- `agent stage`：读取领域 state 当前 Phase 并回写摘要。
- `agent block`：保存／复用 JCONF 请求；真实模式发布 Jira 确认评论；附解除条件回写 Paperclip blocked。成功后 Agent 立即结束运行。
- `agent complete`：需 summary、非空 evidence、tracker 回执／降级记录、`jira_evidence_comment_id`；真实编码模式还核对 state 中的源码 worktree 与 HEAD。
- `agent replay`：仅在显式 replay 模式执行确定的模拟步骤，不能用于真实业务完成。

控制面会要求 `unblockDescriptor` 才能合法进入 blocked。Agent 以自身作为“负责核验确认和续传”的解除执行者；研发决策人仍由 Jira／JCONF 定义，不把 Agent 标识当成人类授权。

原生 `dangerouslySkipPermissions=false`。只定向放行该工具的 agent 子命令；业务工具仍按权限配置运行。旧的部署检查 helper 不作为登记工单的领域完成入口。

## ATSES-493499 模拟验收

用户指定该已完成工单用于模拟。真实类型是“系统设计”，源状态“已完成”；本次不是重新开发编码任务。

```bash
python3 pilot.py register-replay --jira ATSES-493499
python3 pilot.py enable ATSES-493499 --confirm-no-other-executor
python3 replay_acceptance.py --jira ATSES-493499 --output /absolute/path/acceptance.json
```

脚本等待真实 run 阻塞和本机通知，注入两条明确标为 simulated 的无效回复，确认不唤醒，再写入有效模拟同意，等待第二次真实 run 续传并完成。模拟 reviewer 不冒充真实 Jira 用户；没有向 Jira 发布回复，也没有写真实 tracker。

不能在已登记工单上再次 register 覆盖状态。模拟完成后查看保存的报告，不重新启用并重复交付。真实业务验收需另行登记未完成工单。

## 可靠性边界

- 数据落盘先于唤醒／完成。唤醒结果不确定时不盲目重发，需人工核验后 retry。
- 钉钉发送结果未知不自动重发；失败与未知均有回执，仍保留业务阻塞。
- Paperclip run 成功不等于领域完成；没有 completed 和完成记录的 done 会提示核对。
- 正式确认由 Agent 在自己的执行权下更新领域状态；监督进程只在临时副本校验回复。
- 首期持久化记录与回执用于恢复核对，不声明已实现所有副作用自动补偿。回写失败保留证据并进行受控重试，不能从头执行已完成的编码。
- 业务完成降级需要实际 Harness 允许的持久化记录；不能将模拟回执当成真实上报成功。

## 停用

先取消已登记活动工单并确认本机进程停止，再停用监督服务：

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.leo.paperclip-dsp7-bridge.plist
```

保留数据库、状态与证据用于恢复。该操作不停止 Paperclip、Tracker 或原有 SSH 服务。


## 当前验收结果（2026-10-03）

用户指定的 ATSES-493499 为已完成系统设计单。修复后的任务 DSP-3 自动完成“启动→blocked→Mac 提醒→无效回复不推进→有效模拟回复→自动唤醒续传→done”，9 项验收通过，两次真实运行均 succeeded，耗时 100.770 秒、81.512 秒。

运行实际模型上报为 `glm-5.3[1M]`，CLI 别名仍为 `opus`。第一段输入／输出／缓存 token 为 22412／1848／151232；第二段为 26042／1516／157376。三个口径分别展示，不盲目相加；成本不视为真实订阅账单。

最终无活动 run、无本机工单锁，试点 enabled=false。完整报告位于 tracker 仓库 `docs/Paperclip第一期验收结果-2026-10-03.md`，完整 JSON 位于 `~/.config/paperclip-dsp7-bridge/replays/ATSES-493499/clean-acceptance.json`。

初轮 DSP-2 保留用于排查及取消恢复记录。以后在旧模拟完成并停用后，可以用 `register-replay --jira ATSES-493499 --new-attempt` 创建独立新轮次；不会覆盖旧证据或真实业务数据。

## 本地交互入口（2026-10-03）

已提供 `harness` 命令和 Claude 命令包装器。普通后台任务仍使用原有 Claude print 模式；仅明确切换为 interactive 的登记工单接受本地启动请求。此模式保留 Paperclip 原生 SSH／claude_local 适配器、真实 run 与运行期身份，没有改动 Paperclip 核心。

先使用上文 `register` 登记一张未完成工单，保留 disabled 状态，再在 Mac Terminal 执行：

```bash
harness start ATSES-XXXXX --confirm-no-other-executor
```

已有自动调度工单必须先 `python3 pilot.py disable ATSES-XXXXX`，确认没有活动运行后再切换。入口校验 Jira／worktree／旧执行锁，切换为交互调度，写入一次性启动编号，请求 Paperclip 创建真实 run。SSH 包装器核对服务端运行上下文中的启动编号后建立本机 Unix socket；终端连接后才启动可见 Claude。同一个 run 使用唯一 Claude session ID，启动时自动 claim。

- 初次连接等待最多 120 秒；单次 run 上限已配置为 14400 秒（4 小时），单次审批等待最多 3600 秒（1 小时）。
- 人可以直接对 Claude 输入指导，原生权限提示保留；正式需求决策仍需 Jira 确认。
- 待审批时只结束本轮输出，Stop hook 保持同一会话等待；交付完成后可使用 `/exit` 结束本次 run。退出终端不等于领域交付 completed。
- `Ctrl+]` 暂离，60 秒内可 `harness attach ATSES-XXXXX` 重连同一个运行。审批等待期限内允许超过 60 秒后重连；审批已到达而终端断开时，等 attach 后才续传。其他阶段超过 60 秒终止当前会话并保留领域状态。
- `harness start` 可主动续传：启用同会话等待后可以进入 pending 确认的等待会话，推进开发仍必须先收到有效 Jira 同意；Agent 在真实执行锁下更新权威领域状态。
- 交互工单由人 start 建立终端；同会话内有效同意可自动续传，阻塞通知继续工作。其他未经本地授权的唤醒被包装器拒绝，不能启动另一执行者。
- 服务器取消或超时会结束包装器及所属 Claude；不能结束其他终端会话。
- 普通 `claude`、已经打开的 Claude 窗口不会自动登记，不能作为同一工单的第二执行者。

```bash
harness status
harness attach ATSES-XXXXX
harness knowledge ATSES-XXXXX --summary '补充银行接口附件校验规则及失败案例'
```

知识改进命令记录摘要及 Harness HEAD、dirty、tracked diff 指纹和 Markdown 知识指纹，并关联 Paperclip 评论；不会自动提交代码。临时指导与长期规则修改应分别记录；长期修改通过 Git 审查。运行前后快照也保存于 `~/.config/paperclip-dsp7-bridge/interactive/runs/<run-id>/`。

终端内容保存在本机受限 `terminal.log`，不自动上传完整原始终端记录。阶段／阻塞／完成仍通过 `pilot.py agent` 回传，Paperclip 运行日志包含连接信息和退出摘要。运行期密钥不保存到启动请求、会话元数据或 socket 协议。

交互用量从明确 session 的 Claude JSONL 采集，按 message ID 去重，分别记录输入／输出／缓存及实际模型，标记 `observed`。它不是原生 CLI 最终账单，成本明确 unknown。没有可用消息账本时，包装器使 run 报错并保留 unknown，防止原生适配器将缺失用量当成零。Paperclip 的成本展示可能仍含其估算，应以接入桥的来源说明为准。

交互入口已完成代码与配置接入，语法检查通过；尚未运行真实终端端到端验收。此前 DSP-3 的 9 项验收只覆盖后台模式，不能作为交互入口的验收证据。


### 命令入口归属修正

研发命令的正式源码入口已归入 base-harness：`harness/bin/harness` → `harness/scripts/harness_cli.py`。本机 `~/.local/bin/harness` 已链接到该入口。本目录的 harness 文件仅用于兼容。

接入桥仍提供独立的运行连接实现。Harness 默认从兄弟目录定位接入桥，可通过环境变量 `HARNESS_PAPERCLIP_BRIDGE` 或本机 `.harness-local.json.paperclipBridgeRoot` 覆盖。团队共享入口代码不包含本机绝对路径或凭证。


### 交互启动等待故障修复

首次终端体验发现运行期 token 不允许 GET `/heartbeat-runs/<id>`，包装器在创建 socket 前失败。已改为校验原生适配器注入的 `PAPERCLIP_WAKE_REASON` 和一次性启动编号；不扩大 token 权限。等待命令每 5 秒显示调度／运行状态，发现本地启动错误或服务端终态立即退出；scheduled_retry 也纳入活动运行及取消检查。已清理该次失败的自动重试，终端端到端验收仍待用户重新启动完成。


## Paperclip 页面模拟确认

模拟工单现可通过页面评论审批，无需 `replay-confirm`。使用配置 `paperclip_replay_approver_user_ids` 中明确授权的用户，在任务底部发送 `#JCONF-... 同意` 或 `#JCONF-... 拒绝`。只接受服务端 authorUserId 对应的人工评论、当前确认编号、请求时间之后的明确决定；Agent、错误身份／编号和旧评论不生效。

监督服务在运行中和退出后均检查页面评论。首次有效决策按原始时间确定并固定，记录评论 ID、审批用户 ID、原文和 simulated 标识到 `paperclip-confirmation-receipts.json`；再生成本地模拟确认。它不改变权威领域 state；Agent 在真实执行锁下续传时核验和更新。收到页面决定后不能再用终端模拟命令覆盖。此前已通过终端确认的编号也不会被页面覆盖。

审批结果显示在任务描述的“页面模拟确认结果”，保留原评论作为审计依据。当前实现使用页面评论，没有生成 Paperclip 原生 Approval 对象。新版会话等待期间收到同意后自动续传；拒绝后保持业务阻塞，需要修订方案和新确认编号。旧版会话不具备 Stop hook，需结束后启动新版一次。轮询通常约 20 秒，错误退避期间会更长。

页面评论可能触发原生自动唤醒。交互包装器将明确的评论／重试唤醒作为无模型调用处理：不创建 Claude，不读取用户输入，回报等待本地续传，记录 no_model_invocation；输入／输出与成本为真实零调用，不冒充一次模型执行。本地主动启动仍必须通过一次性请求和真实 run 校验。

该转换只在 `mode=replay` 生效，实际原作者 ID 保存在模拟回执中；本地 replay-reviewer 是明确的模拟身份映射，不代表真实 Jira 经办人。真实工单仍从 Jira 获取决策，页面确认不会写入 Jira 或 tracker。新增用户需显式更新受限配置中的用户 ID 白名单。

已执行语法检查、读取现有页面评论并发布操作说明；尚未提交人为同意，也未新增或运行测试。有效审批／拒绝的端到端处理待实际用户回复验收。


## 同会话审批续传（2026-10-03）

配置 `same_session_resume=true`、`confirmation_wait_seconds=3600`。交互包装器为每次新会话合并 Claude 原生 Stop hook 设置，保持权限配置和既有 hooks。Claude 保存 pending 确认并结束本轮输出时，hook 等待有效决策，不调用模型；同意后返回 Stop block reason，让同一会话重新 inspect / claim 并从领域状态继续。真实单核验 Jira 评论，模拟单核验本地模拟评论；页面评论到模拟评论的转换仍经过人工作者白名单和当前 JCONF 校验。

每个确认编号在同一 run 内最多派发一次，派发意图先落盘；响应不确定时不自动重发。拒绝、Ctrl+C、超时或校验失败均保留阻塞。审批等待期间断开终端会保留等待，使用 `harness attach ATSES-493499` 重连后才继续；超过等待期限需人工恢复。运行日志显示等待／重连／继续状态，Paperclip 原生 run 仍可能显示 Working，不代表模型持续消耗 token。用量在退出时汇总。

当前旧 run `b9361363-d82a-49a1-806c-bb06d9b4bef6` 已在服务端超时，已按 run ID 清理对应残留 Claude，释放租约。需执行一次 `harness start ATSES-493499 --confirm-no-other-executor` 启动新版，然后在 DSP-4 页面发送 `#JCONF-ATSES-493499-CBCA94EC 同意`；等待期间无需 /exit 或再次 start。

代码、配置及语法检查已完成；实际 Stop hook 加载、页面发送和同会话自动续传仍待用户完成端到端验收，未代提交同意。


## 网页接入正式 Jira 子工单（2026-10-04）

Project页面现有“接入 Jira 工单”入口，选择本机源码工作区和基线，提交子工单及允许状态。原用户授权评论与任务均持久化，桥 jira_intake.py 校验后准备独立工作树并调用 register，绑定同一任务。登记disabled且interactive；随后harness start才开工。

本机开关web_jira_intake_enabled；授权paperclip_intake_user_ids，源目录白名单intake_repository_roots，目标根intake_worktree_root。只复用本申请的工作树，不覆盖既有Jira登记、不删除失败产物。设计单不创建编码工作树。Project或工作区漂移阻止执行。正式工程审批仍由Jira决定。未完成真实开发验收；Python语法、UI类型与生产构建已通过。


## 多席位网页接入（2026-10-05）

共享工作区配置仓库 URL/基线，各电脑独立 Agent/SSH 通道。本机初始化 `harness seat init --name "研发电脑"`，管理员合并输出的 dsp7Seat 并签发独立 Agent key；安装 key 使用 `--credential-file`，0600 JSON 包含 companyId/agentId/token。之后 `harness repo bind --project UUID --workspace UUID --path /本机仓库`。网页选择席位；桥忽略旧 v1 和其他席位，先取得中央 Jira reservation，再创建自己的工作树。

当前 Mac 已配置；完整方案见 Paperclip fork 的 `doc/plans/2026-10-05-dsp7-multi-seat-intake.md`。中央登记不会因离线、取消或完成自动释放；不支持自动换席位。必须保留 activity_log 中 dsp7.jira.reserved 记录。旧正式工单需迁移，replay 可继续。配置示例 project_repositories 的键为 project UUID:workspace UUID。


## 第一期：自动关联已登记席位

适用于已经在本机配置 Claude 和 Harness，希望网页直接复用本机执行者的研发人员。

1. 管理员先为这台电脑绑定独立 Agent、SSH 环境、机器身份和授权用户，安装本席位的 0600 Agent 凭证。登记不能替代初始通道授权。
2. 在自己的 Harness 目录执行登记，例如：

```sh
harness seat register --claude /usr/local/bin/claude --settings /Users/leo/work/fingard/base-harness-infrastructure-dsp7/.claude/settings.local.json
harness seat info
```

以上路径是当前 Leo Mac 的示例，其他电脑换成自己的路径。默认自动查找 Claude，并使用上次登记的配置或 Harness 的 settings.local.json；用 `--use-default-settings` 显式选择 Claude 默认配置。

3. 新建 Claude 的连接步骤上方选择 **关联已登记的本机席位**。页面会展示执行环境、Claude 版本与路径、设置文件、Harness 根目录和最近检查时间。
4. 点击 **使用此席位，打开已有智能体**。网页重新核对登记并打开原 Agent；这条入口不会为同一电脑再创建一个执行者。Project 接入 Jira 工单时也选择同一个席位。
5. 本机执行 `harness seat check` 可核验并刷新；配置、路径或 Claude 版本变更后执行 `harness seat register` 重新登记，再点网页 **刷新席位**。

登记检查有效期为 **24 小时**，并不表示电脑当前在线。网页核对服务端登记；本机启动和交互包装器在调用 Claude 前再次检查机器、文件摘要、版本、环境和登记版本。登记不验证密钥或模型可用性。文件内容和 API 密钥不会上传。

已登记的包装器使用登记的 Claude 路径，通过 `--settings` 读取本机设置；原有同会话审批续传继续保留。管理员改变执行通道或参数后，需要重新核对登记。存在活动任务时不得更新执行配置。

若网页显示需刷新、配置不存在、登记版本不一致，请先在所属电脑处理，不要复制其他席位配置或重复创建 Agent。登记入口不自动发现电脑、不安装 SSH、不提供持续在线检测；下方手动配置向导用于创建独立智能体。


## 个人电脑快捷接入（2026-10-07）

优先从网站“席位 → 接入我的电脑”生成一次性命令，在本人电脑终端运行。检测 Claude、Harness、现有 Jira 配置后，确认路径并选择组织项目及本机仓库。新席位通过出站 HTTP 领取真实 Paperclip Run，不需要 SSH。账号需要 agents:create 权限，组织审批规则保持生效。

已有电脑复用原席位；安装器不会将现有 SSH 配置改为主动连接。关联其他业务仓库：`harness repo connect`。macOS 可通过网页打开本机 Terminal 确认启动；Linux 在本机运行 `harness start`。断线、服务重启或取消后，必须核对本机 Claude 已停止再重试。

安装器支持 macOS/Linux，Python 3.9+、Git、已经配置好的 Claude Code 和当前 Harness 工程。Linux 使用当前用户 systemd；无用户服务时安装命令追加 `--no-service`，按输出手动运行 watcher。Windows 原生安装尚未提供。
