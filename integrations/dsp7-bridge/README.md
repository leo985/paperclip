## 2026-10-22：统一平台派单入口

网页项目页“派单并执行”为默认入口；“仅登记”为高级选项。Jira 经办人仅用于来源展示和在手工单统计，不再自动发现或创建执行任务。平台保存独立、可审计的派单授权，本机主动领取，在线空闲后自动打开可见 Claude 终端。离线和忙碌时保持队列，开始前检查授权、身份、Jira 条件及执行锁，无需逐单运行启动命令。已领取的执行需在任务页处理，不通过取消队列强行中断。

原申请人失去席位授权后，管理员可重新派单。接入回执与启动分配复用当前平台派单授权，重新核验管理员权限、申请内容及席位负责人；撤销授权、修改申请或变更负责人后，旧授权不能继续使用。

新增 `platform-dispatch-v1` 客户端能力；老客户端必须更新后才能接收平台自动派单。未明确派单的旧登记不会自动启动。历史 Jira 自动发现入口在服务端拒绝新任务，旧的运行中任务保留监控和收尾逻辑。参见 `doc/plans/2026-10-22-platform-dispatch.md`。

# DSP7 Paperclip 第一期接入桥

本目录是智研协同平台 fork 内维护的席位桥源码，支持 macOS、Linux 和原生 Windows 接入。推荐从网站“席位 → 接入我的电脑”生成命令；Windows 选择 PowerShell，使用 Python 3.10+ 和 pywinpty，不需要 WSL。Windows 当前尚待实机验收，先验证模拟任务再启用正式自动执行。

服务端负责授权、调度和记录，Claude 与模型配置保留研发电脑。最新使用说明见网站帮助中心；下文保留一期试点的设计与运行记录，单 Mac／单工单等表述属于当时的范围。

### Windows 安装时提示无法连接网站

接入码检查返回 HTTP 403／410 时，安装器明确提示“接入码无效或已过期”，请从网站“席位 → 接入我的电脑”重新生成命令，并在 15 分钟内执行。不会因此删除或重新创建已有席位，也不会将该响应误报为断网。其他端点的 HTTP 拒绝保留状态码，不一律归因为接入码过期。

PowerShell 能下载安装脚本，不保证 Python 使用相同的代理设置。安装器会显示正在下载的文件或接入码检查步骤，并区分 HTTP 拒绝、连接拒绝、超时、DNS 和证书错误；检测到 Python 代理时会提示核对内网地址的绕过规则，不输出代理凭证、接入码或响应正文。HTTP 状态表示请求收到了响应，应核对对应端点、代理和接入码，不应直接判定电脑断网。

在失败电脑上先检查 `Test-NetConnection 10.60.43.53 -Port 3100`，再用 `py -3 -c "import urllib.request; print(urllib.request.urlopen('http://10.60.43.53:3100/dsp7-bridge-manifest.json', timeout=10).status)"` 检查 Python 实际连接。若端口可达而 Python 失败，可在当前 PowerShell 窗口临时将该平台主机加入 `$env:NO_PROXY`（保留原列表，使用逗号分隔），然后重新执行原接入命令。如果临时绕过后成功，再配置代理工具对该内网主机长期直连，并核验重新登录后的后台上线。无需修改 Claude 模型代理或删除已有席位配置。不要贴出含凭证的完整代理设置。

## 2026-10-21：受管会话、阶段与统计

新增 `managed_sessions.py` / `session_hook.py`：绑定本次原生 Claude 会话，采集可见对话、完整工具正文、子代理、终端和受支持文本附件；密钥脱敏后进入 SQLite outbox，按分块摘要和连续确认补传。不会读取独立 Claude 或重算 Token。新正文仅执行时负责人／管理员可读。

- 记录：`managed-sessions.sqlite3`；每轮状态：`runs/<runId>/collection-status.json`。
- 配置：`managed_collection.queue_bytes` 默认 1 GiB（最小 1 MiB）；`excluded_paths`、`excluded_tools` 为额外排除列表；不应在 Git 配置中填写 `secret_values`。
- `phase_gate.py` 只执行 Git 已提交的阶段契约与门禁脚本，观察 state/effort 不等于通过；Harness 入口是 `harness phase check --contract ... --phase ...`。
- `jira_workload.py` 每 5 分钟统计已授权 Jira 范围内未完成总数；`quality_collection.py` 按已交付正式工单收集显式 Jira 关联缺陷，14 天窗口成熟后用于质量统计。
- 平台新增迁移、私有会话 API、工单会话面板及席位周期报表。需要服务端与客户端一起更新；仅更新 Harness 不替换桥接客户端。
- 平台应急关闭写入：`DSP7_MANAGED_SESSIONS_ENABLED=false`。本机队列保留，领域任务不因此重跑。关闭期间应评估本机队列容量。
- 构建网站分发包：在 Paperclip 根目录运行 `python3 scripts/build-dsp7-bridge.py`，同步 installer、ZIP 与 SHA-256 manifest，不更新已安装客户端。

二进制附件、跨运行复用同一原生会话和旧技能完整阶段契约仍未提供；未知格式、超限和缺失来源会显示缺口。首次离线绑定失败且运行已结束时不会事后伪造登记。当前未进行真实 Claude／macOS／Windows 验收。完整设计和实施边界见 `doc/plans/2026-10-21-managed-session-*.md`。

## 实现范围

- 明确登记 Jira 子工单；绑定唯一 Paperclip 任务；不扫描所有工单。
- 使用 DSP7 公司内专用非管理员身份调用控制面，不持有管理员运行会话。
- 校验工单类型、需求／附件指纹和就绪状态；编码任务要求工单独占 worktree。
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

需求或附件变化后保持阻塞，不自动更新旧指纹。修复环境／接口问题后，通过人工核验重试，不自动重新执行失败的开发：

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

任务页面的“等待人工处理”包含两类来源：网页业务决策沿用任务内的待决策卡片；Claude 原生提问和权限请求必须在对应席位电脑的 Claude 终端处理。页面根据当前在线席位、任务和运行匹配的原生等待提醒，显示席位名称及 `harness --company <组织UUID> attach-run <运行UUID>` 重连命令；历史会话和离线提醒不生成当前处理指引。网页评论、对话记录和终端补充不能回答原生提示，处理后以本机上报恢复为准。
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

优先从网站“席位 → 接入我的电脑”生成一次性命令，在本人电脑终端运行。检测 Claude、Harness、现有 Jira 配置后，确认 Harness 路径；执行仓库及本机目录由 Harness 套件管理，安装时无需绑定业务仓库。新席位通过出站 HTTP 领取真实 Paperclip Run，不需要 SSH。账号需要 agents:create 权限，组织审批规则保持生效。

已有电脑复用原席位；普通接入不修改现有 SSH 方式，显式 `--upgrade` 可迁移已有管理员绑定的 SSH 席位。旧的 `harness repo connect` 入口保留兼容用途，新接入执行无需配置。macOS 可通过网页打开本机 Terminal 确认启动；Linux 在本机运行 `harness start`。断线、服务重启或取消后，必须核对本机 Claude 已停止再重试。

安装器支持 macOS/Linux，Python 3.9+、Git、已经配置好的 Claude Code 和当前 Harness 工程。Linux 使用当前用户 systemd；无用户服务时安装命令追加 `--no-service`，按输出手动运行 watcher。Windows 原生安装尚未提供。


## 已有席位更新

在网页席位详情的“设备与诊断 → 本机接入桥”复制更新命令；无需新接入码。
安装器 `--upgrade --agent-id <席位 UUID>` 会校验网站和本机席位，下载校验后的版本包，保留身份、Jira、仓库和模型设置，并切换本用户的后台服务。活动任务、待响应会话和启动请求会阻止更新，不会执行取消工单或停止 Claude 命令。

配置备份位于 `~/.config/paperclip-dsp7-bridge/upgrade-backups/`。切换失败恢复旧配置并尝试启动旧服务；若恢复服务失败，按终端提示核对服务和备份。迁移断网或断电留下的 `upgrade-in-progress.json` 会用于下次原命令恢复；不要删除记录。非迁移的旧升级记录仍需管理员核对备份与当前路径。

手工 watch 应先在空闲时停止；自定义 `--config` 需配合 `--no-service`。Harness 技能框架仍由 Git 单独更新。旧 SSH 席位在显式升级时自动迁移为本机主动连接：仅原独立凭证、已绑定机器指纹和空闲席位可执行。服务端先暂停派工，再同步本机与服务端执行环境及登记，后台服务安装完成才恢复。失败时协调回退；网络结果未知保留记录并保持暂停，重试原命令继续。不创建席位、不修改负责人及历史工单、不删除原 SSH 环境。升级后的版本以网页重新收到的心跳为准。


## 日常简化命令

`harness online` 启动后台接入服务；`harness offline` 持久暂停新任务，现有任务和人工响应结束后安全下线；`harness doctor` 检查接入，原开发环境诊断用 `--environment` 或原 `--repo` 参数；`harness upgrade` 获取网站最新安装器。

已有席位但登录后自动上线服务未注册成功时，在原注册用户下执行 `harness service install` 补装并立即启动。macOS 注册本用户 LaunchAgent；Windows 注册本用户登录触发的计划任务，无需管理员权限。命令复用已有席位身份和匹配服务，不需要新接入码，不重复创建席位，也不重启已运行的 watcher；服务路径或用户不匹配时拒绝覆盖。该命令与 `online` 一样恢复本机主动下线状态，网站暂停接单设置保持不变。完成后执行 `harness doctor` 并确认网页席位心跳；自动启动发生在该用户登录后，未登录时不会上线。

`harness service install`、`harness online` 和正常安装／升级同时安装本席位的独立定时巡检：macOS LaunchAgent、Windows 当前用户交互式计划任务、Linux 用户级 systemd timer 每分钟检查一次。多组织按配置路径分隔任务和日志；重复安装复用匹配任务，身份、路径或周期冲突时拒绝覆盖。旧客户端需先 `harness upgrade`，再运行 `harness service install`。

巡检以本机 watcher 独占锁及成功上报后的 `lastHeartbeat` 为证据：服务未运行或心跳超过 90 秒时，调用对应席位的 `harness online`，失败也至少间隔 5 分钟重试。首次安装预留 90 秒启动时间；手动 `harness offline`、升级标记或升级锁存在时跳过，不修改网页暂停接单、工单、执行锁或审批。恢复仅拉起接入服务，不强制结束卡住的 watcher 或 Claude 进程，也不将心跳陈旧推断为任务已停止。断网时无法保证恢复，电脑睡眠、关机或退出登录时巡检不保证运行，需接电防休眠并保留登录会话。

巡检状态和动作日志位于该席位配置目录下 `seat-watchdog/status.json`、`seat-watchdog/watchdog.log`；macOS 调度器错误见同目录 `scheduler.error.log`。日志仅记录时间、心跳时差、恢复动作及退出码，不记录凭证或命令输出。升级和回退后按当前席位配置选择接入桥，保留原席位身份。验证命令：`python3 -m unittest discover -s integrations/dsp7-bridge/tests -v`。

若首次接入尚未保存席位身份或 Claude 运行登记尚未完成，请先恢复首次接入流程，服务补装不能代替首次登记。旧客户端需先通过网页“更新客户端”命令更新，才能使用 `harness service install`。Windows 的当前窗口尚未刷新 PATH 时可直接执行 `& "$env:LOCALAPPDATA\ZhiyanSeat\bin\harness.cmd" service install`。

已有电脑先从网页复制完整命令升级一次。Unix 受管 CLI 保留领域转发，未知入口拒绝覆盖；失败回退也恢复原符号链接。Windows 继续使用 harness.cmd。主动 offline 的标记跨登录保留；online 不改变网页原有暂停。自定义配置升级使用 --config <路径> --no-service。


### 本机 Claude 工具权限模式

默认保留 Claude 原生工具权限确认。更新接入桥并上线后，可在网页「席位 → 设备与诊断 → Claude 启动参数」配置 `--dangerously-skip-permissions`、`--model`、`--effort`、`--permission-mode`（跳过权限确认与权限模式不可同时设置）。参数按空格或换行分隔，不支持 shell 语法。负责人或管理员保存后，对下一次新建的工单、分析和交付会话生效，运行中会话不变；平台会话标识及采集 hooks 仍保留。跳过 Claude 工具权限确认不会绕过 Harness 业务审批。

客户端在每次新会话启动前通过本机独立凭证读取席位配置，读取失败停止启动。网页尚未配置时沿用本机 `"claude_skip_permissions": true` 设置；网页一旦保存，则覆盖本机同类启动参数，保存为空会关闭本机旧的跳过权限设置并恢复默认。会话元数据记录配置来源、版本和已生效参数。

该参数仅影响 Claude 工具授权，macOS 系统隐私授权、平台派单授权、Jira 门禁和单执行器检查仍分别生效。

### 可见终端显示与重连

多席位安装时，自动打开的终端通过 `DSP7_BRIDGE_CONFIG` 显式使用发起请求的席位配置，不依赖终端默认环境。手动重试 `seat accept` 时也需保留同一配置路径，否则可能读取其他席位数据库并提示“请求不存在、已领取或取消”。

启动 Claude 前，接入桥先读取本机终端的实际行列数及终端类型，Unix PTY 和 Windows ConPTY 均使用该尺寸创建。实时显示按完整 UTF-8 字符和终端控制序列转发；本机原始 `terminal.log` 继续保留，不因此缩减会话采集。

`Ctrl+]` 暂离后可用 `harness attach <Jira 工单号>` 重连。重连恢复当前显示模式，并通过窗口尺寸通知请求 Claude 重新绘制画面，不再回放截断的历史字节，不发送模型提示或按键。历史内容可通过网页会话记录查看。连接结束时复原鼠标、粘贴、光标和屏幕模式，避免影响后续 shell 命令。

Claude 启动提示会去除接入桥内部的申请、授权和接入结果 JSON 注释；平台及本机保存的原始授权记录不变，业务说明与 Jira 审批门禁仍保留。更新客户端后，下一次启动的会话生效。

### 异常退出后的停止核验

服务端运行已失败、取消或超时时，客户端检查对应 Claude、包装器和本机监督器的实际进程。缺少结束摘要时，只要有本机启动记录，连续两次检查（间隔至少 15 秒）均确认进程不存在、且任务没有活动运行，也能确认旧执行已停止；正常心跳下通常在 20～60 秒内更新。进程仍存在或无法读取进程状态时保留保护，不会强行结束进程。

核验依据写入本机运行目录 `stop-verification.json` 并记录桥事件，不补造用量、费用或成功摘要。已有“正在核验”的中断任务会更新为“本机会话已结束”，历史会话仍须负责人在网页点击恢复。新会话额外记录包装器和监督器 PID，便于异常退出时核对。

通过 `register`／`register-replay` 登记的旧任务也可上报中断；服务端仍核验本机身份、任务归属、对应的最新已结束运行及无活动运行，不会释放 checkout 或跳过恢复门禁。单个中断回执失败时保留重试并在席位告警中展示，心跳与其他任务继续处理。

### Claude 原生等待提醒

席位监控会消费当前运行的显式 hook 边界：`AskUserQuestion` 调用及 `PermissionRequest` 表示等待人工处理；匹配的工具完成/失败、用户输入或会话结束清除等待。等待期间席位报告 `waiting_decision`，由平台既有机器人通道按提醒间隔去重并超时升级。原生问题、权限确认须在席位电脑的 Claude 终端处理，网页不能代答；Harness 领域确认仍在工单页面处理。不会因长时间没有输出而推断等待、离线或自动授权。hook 只记录边界、工具调用 ID 和等待类别，不记录问题正文、工具参数或回复。

诊断不再把历史个人 DWS 投递显示成当前提醒成功。通知页的机器人历史记录只证明对应时间的受理/失败结果，不能证明当前等待已通知；受理不代表已读。测试：`python3 -m unittest discover -s integrations/dsp7-bridge/tests -v`。


### 明确停止与一次自动重试（2026-10-23）

停止整个任务请使用网页运行页的“停止”，或在本机执行 `harness stop <Jira 工单号>`。本机命令在取消运行、终止匹配进程树之前写入停止记录；离线时保留记录，恢复连接后同步。明确停止后不自动重试，须在网页明确恢复。Esc、Ctrl+C、关闭终端和非零退出码本身不作为停止整个任务的证据。

新版客户端启动的、已有平台派单授权的本机出站 Claude 会话发生未知异常、超时或连接丢失后，最多自动重试一次。必须先由本机确认旧进程停止、席位空闲、执行环境释放且无其他保护；继续沿用现有派单、Jira 状态、负责人、仓库、独占锁及预算门禁。平台记录新启动授权后，客户端重新打开可见终端，创建新的启动意图和真实运行。等待本机启动时显示“准备自动重试”，不会创建成功的空运行。

自动重试再次失败或条件不满足时保持阻塞，需明确恢复；每次网页明确派单或恢复重新获得一次机会。历史运行不因升级被自动拉起。明确停止记录会撤销尚待本机启动的自动重试资格；人工恢复须重新授权。通用唤醒缺少本机启动请求时返回启动失败，不再显示执行成功。


### 2026-10-23：网页恢复与派单启动提速

- 平台对已登记且在线空闲的任务，在授权事务中直接创建启动指令；未准备、忙碌、离线时仍由原队列推进。
- `watch` 启动独立的 `command_receiver.py` 线程，使用独立 Bridge／SQLite 连接，18 秒长轮询、服务端每秒查询；网络失败退避重连，心跳继续兜底。仅向服务器主动发起 HTTP 请求，无本机入站端口。
- 主循环先处理接单与心跳，再补传会话和采集统计；独立通道不执行这些慢任务及通知。
- `delivery.lock` 串行处理指令，打开前持久化 `opened`；`upgrade.lock` 共享读取与安装器独占锁互斥，升级仍要求空闲。Windows 用 LockFileEx 支持同等共享／独占语义。
- 启动阶段回执仅含固定阶段、时间和耗时，不含配置、PAT、模型 Key 或会话内容；阶段回执失败不阻止执行。接受和运行回执、Jira／授权／执行锁核验保持强校验。
- 新版 `once` 及旧服务器兼容心跳领取；收到自动请求返回的指令当轮处理，不再等下一次轮询。新版本需在席位空闲后更新。

### macOS 本机提醒的点击行为

更新客户端后，本机提醒使用独立通知工具发送。点击携带运行信息的提醒时，先核对运行与任务归属，再按 attach 客户端的 TTY 定位对应 Terminal 标签页；只切换窗口，不重启、恢复或批准执行。会话已结束、终端已关闭或定位失败时，打开该任务的网页详情；席位配置提醒打开席位管理。

Apple Silicon macOS 14+ 的安装器尝试安装固定 SHA-256 校验的官方 Homebrew terminal-notifier 3.1.0 应用包，不依赖本机 Homebrew。其他 Mac 可自行安装 terminal-notifier。工具缺失时改由后台 System Events 发送提醒，点击定位不可用，安装器会提示；不再使用会打开“脚本编辑器”文件窗口的通知来源。系统须允许 terminal-notifier 发送通知；勿扰模式和系统通知设置仍可能影响显示。Windows 通知保持原行为。

### 接口联调工单

席位接单类型支持“接口联调”，需负责人手动勾选并保存。更新本机桥后，类型映射到 `integration` / Harness `dsp-integration-test`，领域资料保存在 `tickets/integration-{JiraKey}/`，沿用独占工作树、执行权、Jira 指纹校验。先确认技能要求的测试环境、测试账号和执行范围，再执行。`agent inspect` 返回技能和专用工作流说明。完成前额外执行 Harness 的 `check_integration_execution_plan.py --stage complete`，需要上下文、联调报告及范围证据；partial 只表示批准范围的有限验收，并在完成评论中明确保留。原有 Tracker 回执、Jira 评论和源码证据门禁仍生效。


### 本机统一客户端更新（2026-11-05）

在原注册操作系统用户下执行 `harness upgrade`，现在统一更新当前用户在同一网站登记的全部组织席位，不再只更新默认组织。只下载并校验一份版本包，各席位沿用原身份、凭证、仓库、Harness 根目录和服务名称；不更新 Harness 工程的 Git 内容，也不涉及其他操作系统用户或其他网站。

开始前逐一检查全部目标席位的运行、等待确认状态和操作锁，短暂的心跳检查锁最多等待 20 秒，超时仍停止；任意席位不满足条件时不开始更新。更新时逐席位再次加锁并检查空闲；若中途有新任务或某一步失败，停止后续更新，保留已完成项及各席位原有备份，在 `~/.local/share/paperclip/device-upgrade.json` 记录已完成和剩余席位。处理错误后由用户重新执行原命令，不自动重试，也不声称所有席位一起回滚。每个工作进程独立加载配置，避免组织环境串用。

`harness upgrade --this-seat` 仅更新当前选中的席位，可与 `harness --company <组织> upgrade --this-seat` 配合。网页管理员请求始终使用单席位范围，兼容早期客户端的固定摘要请求，不扩展组织管理员权限。发布安装包仍不会自动升级任何客户端。

## 管理员下发客户端升级（2026-11-05）

发布安装包不会触发升级。管理员在席位详情“设备与诊断”中查看当前及网站版本，点击“下发客户端升级”，为该席位创建固定目标摘要、24 小时有效的请求。已安装 `seat-admin-upgrade-v1` 客户端的独立每分钟巡检通过本席位凭证领取请求，服务器再次校验管理员授权、目标版本和任务状态；本机仍沿用 `harness upgrade` 的全部空闲与执行锁检查。忙碌或离线的席位等待空闲或恢复连接，未领取的请求可由管理员取消。领取后不强制终止任务；失败需管理员核对后重新下发，结果未知时不盲目重跑。

安装器固定核验管理员选择的目标 SHA-256，发布包发生变化则拒绝更新。只有服务器收到目标版本的新心跳才显示成功。状态保存在当前席位配置目录 `seat-watchdog/remote-upgrade.json`，不记录凭证或命令输出。手动下线或升级进行中跳过；Windows 与 Linux 巡检为受控升级预留最多 10 分钟运行时间。旧客户端必须先在原电脑更新一次才能接收网页升级请求。发布清单始终保留 `autoUpgrade.enabled=false`，兼容已安装的早期客户端；本版不读取发布清单来自动决定升级。

升级成功记录由服务端持久保存，并写入审计日志；之后电脑休眠或离线不会改变本次升级结果。建议先选择一台空闲席位验证新版本，再由管理员逐个下发其他席位。

### 领域布局扩展与席位心跳（2026-11-05）

`harness/artifact-layout.json` 保留原有四种工作流映射，并允许增加 `design-review` 等工作流；所有名称与目录前缀仍须为安全的单个路径组件，前缀不得重复。已有工作流的映射变更、越界路径及歧义状态继续拒绝。单条历史工单登记解析失败时，席位发布明确的“工单状态解析”失败检查并继续发送心跳，阻止新任务启动；修复登记后下次心跳自动清除该检查。历史状态文件和工单登记不会被重写。

### 正式任务复用 Harness 原生启动环境（2026-10-24）

新版接入桥从席位登记的 Harness 根目录启动正式 Claude 会话，目标等同于 `cd <Harness 根目录> && claude` 后输入“完成 ATSES-XXXXX 工单”。Claude 原生读取 `CLAUDE.md`、`.claude/skills/` 和 user / project / local 配置来源。`.claude/settings.json`、`.claude/settings.local.json`、`.mcp.json` 按存在情况加载。认证与 MCP 凭据保留本机，不上传配置内容。外部显式 settings 仍按 Claude 合并优先级生效。

启动提示要求查询 Jira 真实类型，按 Harness 路由选择技能，并遵守断点续传和领域门禁。平台补充派单身份、执行权、采集与回传信息。相同加载环境不保证模型每次选择和输出完全相同。

**启动目录与源码目录分开**：Claude 在 Harness 根目录启动；代码仍在本工单登记的源码目录 / 独占工作树修改，通过 `--add-dir` 提供访问。不会因切换启动目录创建或替换源码目录，也不免除独占校验。

启动前检查引导、技能目录、可选 JSON 配置与源码路径；缺失、格式错误或显式限制配置来源时明确阻塞，不自动换目录。诊断通过不代表 MCP 网络、认证或技能实际调用已验证。`--strict-mcp-config` 和限制 `--setting-sources` 的配置与此模式冲突时拒绝启动，需要核对配置。

**已有席位如何使用**：席位详情 → 设备与诊断 → 更新客户端，在原电脑、原注册用户下空闲时执行更新命令。保留席位身份、负责人、接单规则、仓库映射与历史；执行中、排队启动或等待决策时更新器拒绝更新。更新后核对“正式任务启动方式”，下一次正式会话生效；旧会话不改目录、不被接管。旧客户端保持原行为，模拟任务保留隔离目录。

需要回退时，由负责人在本机接入桥 `config.json` 设置 `"claude_launch_mode": "legacy-source"`，空闲后重启桥，仅影响随后新会话。删除该字段或设置 `"harness-root-v1"` 恢复默认；兼容模式会明确显示，不会静默降级。

实现：`harness_launch.py`；能力 `harness-root-launch-v1`、诊断 `harness_launch`。相同工程 settings 不重复显式注入，平台 hook 作为补充。会话元数据记录启动模式、源码目录与引导哈希；附件采集仍限制为源码与本工单目录。

### 同一席位登记多个 Harness（2026-10-25，开发中）

更新到包含 `harness_capabilities.py` 的客户端，待服务端能力登记接口发布后，可在同一台电脑登记多个套件：

```sh
harness capability register --kind analysis --profile dsp --path "/本机路径/base-harness-analysis-suit"
harness capability register --kind development --path "/本机路径/base-harness-infrastructure-dsp7"
harness capability register --kind qa --path "/本机路径/qa-harness-infrastructure"
harness capability list
harness capability check
```

Windows 的 `--path` 使用该电脑上的实际绝对路径，例如 `"C:\work\qa-harness-infrastructure"`。命令不要求当前目录位于 Harness 内。

登记读取 Git origin、HEAD、CLAUDE.md、实际技能入口及分析 profile 的路由文件；凭据、MCP 配置和 API Key 不上报。Git URL 中的认证部分会被去除。服务端核验本席位凭据、机器身份和登记修订；并发登记冲突时刷新重试。执行或等待决策期间不能更换登记，不变的能力可刷新检查时间。

原有 `harness_root`、研发任务和席位身份不改变。登记仅说明本机文件检查通过，页面显示“执行适配待验收”，不自动切换目录、不授予派单权，也不表示独立评审、分析或 QA 已可执行。

`analysis_runtime.py` 为分析原生 P0–P4 适配基础：平台身份与修订映射为独立任务目录，禁止覆盖/接管未绑定任务，续传先查原生 status；即使退出码为 0，也必须检查 gate_errors。交付分别核验原生输入指纹及 handoff 哈希，并重验采集期间材料是否变化。当前未接入网页分析派单，不提供绕过预算/许可的直接启动命令。

出站运行在失败时仍保留已获得的 Token 汇总；CLI 模型估价不冒充中转账单，费用保持 unknown/unpriced。用量完全缺失时不能标为执行成功。


### P0 监督协议与对账（未发布增量）

新版领取声明 `supervisionProtocol=2`。受管执行以固定 Harness 路由、60 秒许可、独立看门狗和 session/Windows Job 树证明监督。未知进程状态不回报已停止；旧任务不得通过切换目录静默迁移。

执行中每 5 秒采集当前 session JSONL 的累计 Token，高水位写入不可变 outbox，ACK 后删除。累计观测和最终汇总由服务端计算差额，实际中转/订阅价格未知时保持 unpriced。API 错误和 synthetic 消息不当作真实零用量。对账摘要见网页执行记录；不把本地 CLI 退出或业务工单完成当作正式交付验收。

路由配置在席位 → 设备与诊断 → 本机 Harness 能力；可分别选择已登记的分析、研发、测试能力。领域原生任务执行适配未开放时，选择路由不会启动 Agent。详细状态与未验证环境见 `doc/plans/2026-10-25-p0-execution-governance-implementation.md`。

### 免填路径的本机目录选择

网页席位详情 → 设备与诊断 → 本机 Harness 能力中选择套件用途，生成 `harness capability register --kind analysis --profile dsp --choose --seat-id <席位UUID>`。更新客户端后，在该席位电脑执行，系统弹框选择 Git 根目录，原生文件与 Git 身份校验通过后保存登记。取消不写入；网页生成命令绑定席位，避免在其他电脑误登记。`--choose` 与 `--path` 互斥，原有 `--path` 命令保留。

分析任务表单也提供此向导。研发选 `development`，测试选 `qa`；只登记实际需要的套件，同一席位可以有多类能力。登记不会启动模型或授予执行权；QA 自动执行适配仍未开放。macOS 使用系统目录框，Windows 使用 PowerShell STA 文件夹对话框，Linux 优先 zenity/kdialog，再尝试 tkinter；无图形桌面使用 `--path`。

### Jira 经办人与执行席位解耦

Jira 经办人保留为来源信息与在手工单统计账号，不再要求与席位一致，经办人变更也不要求重新登记或停止执行。预览、派单、需求子单准备、本机接入与运行监控遵循同一规则；平台选择的席位及其当前授权决定执行者。统计账号可以在多个席位复用。原有组织、席位负责人授权、项目仓库、状态、类型、需求／附件指纹、预算与单执行器门禁继续有效。旧客户端需执行 `harness upgrade` 后生效；通过其余校验后仅清除旧经办人校验错误，不自动恢复已阻塞任务。

### 可选业务仓库与已有目录复用

测试 Harness 可以只使用套件内测试资产和目标环境，不必另建业务仓库或执行
`harness repo bind`。原生工单、环境准入、被测版本和交付证据仍按测试流程核验。

新版席位心跳每分钟优先读取已登记 Harness 的 `.claude/settings.local.json` 中
`permissions.additionalDirectories`，核验其中的 Git 根目录与 origin；普通文件夹
不当作仓库，非空配置中的失效路径不会替换为无关仓库。只读取目录引用，不使用或上传
env，也不执行 hooks、命令。未配置目录引用的旧套件才补充发现 `intake_repository_roots` 白名单根及其两层子目录的
已有 Git checkout，并复核已有显式绑定；不会 clone、fetch 或切换分支。发现结果
只上报去除凭据的 origin 和当前分支，本机目录不上传。项目可直接选择已有仓库，
也可继续手工填写 URL。更深的源码目录请缩小白名单根或使用显式绑定。

研发接入优先使用显式绑定；未绑定时，只复用 origin、基线匹配的唯一白名单目录。
多个候选、缺失基线或 origin 变化时停止并提示人工核对。业务仓库与 Harness 套件
目录仍分别管理，任务工作树隔离保持原有规则。先升级服务端，再更新席位客户端。

### 同一电脑接入多个组织

macOS 与 Linux 接入命令先核验邀请所属组织。同组织复用原席位；其他组织使用独立身份、凭据、数据库、工作树和登录启动服务，保留默认席位。每个组织单独选择 Harness 目录。

默认 `harness` 仍操作原席位。其他组织使用安装完成后显示的独立 `harness-<配置摘要>` 命令。默认席位也升级到此版本后，还可使用 `harness --company <组织名称或UUID> doctor|online|offline|upgrade`。网页携带席位编号的命令自动选择该席位。更新客户端按席位独立进行。已完成的同组织接入码可在有效期内用于恢复配置；无效或过期接入码不会被静默忽略。

Windows 同样支持多组织：每个组织使用独立配置、凭据、数据库、带摘要后缀的 `harness-<配置摘要>.cmd` 命令和当前用户登录任务。默认 `harness.cmd`、原登录任务与共享 Harness 工程的默认桥引用保持原样；新组织使用自己的配置选择接入桥。旧默认席位需更新客户端后才能通过 `harness --company` 选择其他组织；也可直接使用新组织安装完成时显示的独立命令。更新、上线、下线均只作用于所选席位。

### Windows 已有登录任务恢复（2026-11-03）

`harness online` 对路径、当前用户及登录触发器一致的已有任务仅执行启动，不重复注册，也不强制覆盖。任务已运行时不重复启动；任务被禁用或身份不一致时明确停止。首次接入只在任务不存在时创建，不使用 `-Force`。任务访问拒绝会明确显示 0x80070005，而非建议对 online 添加不生效的 --no-service。旧客户端需要更新才能获得此行为；现有任务可以先使用 Start-ScheduledTask 单独启动。此修复不代表此前的模块导入退出已被复现或解决。

### Windows 启动任务诊断（2026-11-03）

在安装席位时使用的 Windows 用户下执行 `harness doctor`，查看“登录后自动上线”。诊断会显示当前席位对应的 `Zhiyan-Seat-Bridge-…` 任务名称，并区分未注册、已注册但禁用、用户／登录触发器／启动路径不一致、已启用但未运行，以及正在运行。未运行时附上次运行结果（十六进制）和恢复建议；查询权限不足会明确报告注册状态未知。诊断仅查询，不会注册、启动或覆盖任务。它同时显示在网页“设备与诊断”中。

Windows 使用当前用户的登录启动任务；重启后需要登录该用户才会自动上线。旧客户端执行 `harness upgrade` 更新后获得此诊断，多组织电脑可先用 `harness --company <组织名> doctor` 选择席位，或执行该组织安装时生成的独立命令。


## 2026-11-03：执行仓库交由 Harness 管理

网页接单规则与工单接入只选择平台项目和席位，不再选择共享仓库、登记本机仓库路径或配置基线。版本 4 接入申请不携带工作区编号；接入桥不扫描或准备业务仓库，也不创建 Git 工作树。从本机登记的 Harness 根目录启动，按 Harness 的技能、知识库、隔离和交付规则解析本工单涉及的一个或多个仓库。安装结束不再弹出项目仓库绑定步骤。

先发布服务端、页面和新客户端包，再在原电脑通过网页更新命令或 `harness upgrade` 更新客户端，等待心跳上报 `harness-repository-management-v1` 后提交新工单。旧客户端不能领取新协议申请；已登记的旧任务仍按其原执行上下文运行，不迁移或删除已有工作树。手动 `harness repo` 命令仅为旧登记保留兼容，不是新接入的前置要求。新版仅改变仓库责任划分，仍要求 Jira／平台授权、独占登记、任务租约及真实交付回执，不会直接把进程退出当作任务完成。


### Harness 领域状态目录契约

新登记读取 Harness 根目录 `harness/artifact-layout.json`（`schema_version: 1`、单层相对 `directory`、`workflow_prefixes` 固定四映射 feature→feature、bugfix→bugfix、design-doc→design、code-review→review）。桥接 `design` 对应领域 `design-doc`；无契约或契约未声明的工作流保持旧 `tickets/` 布局。声明损坏、未知版本、绝对/父级路径或 symlink 越界会阻止操作。

旧登记仅在路径完全等于标准 `tickets/{workflow}-{key}/state.json`、旧文件不存在且契约声明新路径时，按公开契约读取新路径并在 inspect 的 details 提示映射；SQLite 原登记不改。旧文件单独存在则保留旧记录；新旧文件同时存在拒绝歧义。自定义路径和 replay 不迁移，不复制、合并、重置或创建领域账本。inspect 若发现历史 completed 仅提示原记录，当前租约、checkout 与 complete 交付核验继续生效，不生成本次 Tracker 回执。

启动提示给出当前安装的绝对 pilot.py 入口。`agent inspect` / `agent claim` 通过运行身份定位工单，不接收 `--ticket`。同步及 issue_guard resolve/init/verify 必须在 Harness 根目录独立执行，不加管道、重定向或 cd 串联，并沿用启动器身份。此提示只作用于新启动上下文，不向已运行会话发送消息。

源修复须经现有 `ui/scripts/build-dsp7-bridge.mjs` 构建并发布客户端包后，在原电脑空闲时按组织安装命令或 `harness upgrade` 更新；不会直接替换已安装目录。活动运行、待响应会话或启动请求按现有升级门禁阻止更新，应先按正常流程结束。升级保留组织/席位/配置；既有业务登记无需 SQL 修改。

## 个人与群同步提醒（2026-11-04）

现有席位个人通知默认不变。管理员可在“席位管理 → 接入与管理 → 钉钉通知群”登记一个或多个群，再在每个席位的通知设置中选择一个群，与个人提醒同时发送。

1. 在目标钉钉群添加“自定义机器人”，启用加签，取得 Webhook 与 SEC 开头的加签密钥；确认该群属于所选企业、席位负责人已在群中。
2. 管理员登记群名称、所属企业机器人、Webhook 和加签密钥。所属企业机器人用于确定 CorpId 和人员身份；群消息通过该群自定义机器人发送，个人消息仍通过原企业机器人发送。
3. 席位通知设置中保留个人机器人及接收人，选择“同时通知钉钉群”。页面展示将被 @ 的席位负责人，保存后生效。个人接收人可以与席位负责人不同，群内始终 @ 当前席位负责人。
4. 负责人身份必须由系统人员联邦的 `userId` 关联唯一匹配到同 CorpId、有效人员及启用的钉钉来源。不会按显示姓名、邮箱或任意输入猜测；没有唯一身份时阻止保存群配置，发送时也重新校验。
5. 群消息使用 `at.atUserIds` 和正文中的 `@userId`，不 @ 全员。个人消息、群消息分别按等待事项及提醒时间桶去重；超时应用内 DING 仅发个人，同次等待仅升级一次。投递结果未知不会在同一时间桶重发；后续提醒时间桶仍可产生正常提醒。
6. 查看“机器人投递记录”中的个人普通消息、群消息及个人 DING 结果。群记录展示群名和被 @ 的钉钉账号。钉钉受理不代表已读或已处理；负责人是否在群中及客户端是否显示有效 @，需在目标群实际验证。

Webhook 与加签密钥整体存入组织加密 vault，配置、审计和列表仅保存／返回密钥引用或是否已配置，不下发到席位客户端。群配置仅接受 `https://oapi.dingtalk.com/robot/send?access_token=…`，拒绝任意网络目的地址及重定向。编辑时两项均留空保留原值；轮换时同时填写两项。停用群只停群通道，停用企业机器人则停用该机器人关联的个人及群通道。负责人变更沿用原规则清空通知设置，需重新配置。此变更保存在现有 adapterConfig 与 activity_log，不新增数据库列。

配置和签名／投递契约由本地回归覆盖；没有目标群凭据时不宣称真实群投递或 @ 验证通过。旧的个人 DWS 通知兼容路径不提供群发送，需要使用网页登记的企业机器人配置。


## 运行配置自动刷新登记

接入桥每分钟检查运行配置。仅已登记路径下的 Claude 版本或配置文件摘要变化，且本机和服务端身份、环境及登记版本仍一致时，自动在席位空闲后重新登记并立即复检，更新下一次心跳的检查结果。不会修改配置内容，不会终止任务，也不会自动恢复被阻塞的工单。

排队、执行中、等待响应、本机进程未结束或刚收到启动请求时，保留配置异常状态并推迟刷新；网络或复检失败按 1、2、4、8、15 分钟退避重试。路径、环境、机器身份或服务端登记变化仍需人工核对，网页诊断显示“自动刷新登记”的原因。配置正常时仍按原有每小时续期，不会每次心跳重新登记。旧客户端需更新后生效。

### 独立评审顺序

客户端以 `delivery-work-review-v1` 声明支持阶段内独立评审。更新客户端并刷新登记后才能运行新顺序；工作单提示会列出 `delegatedReviewKeys`，禁止提前执行这些独立评审工单。设计／用例评审为负责人任务，不由设备执行。

### 交付链人工／Agent 执行配置（2026-11-05）

设计、编码、用例编写和功能测试工作单分别支持 `workExecution: human | agent`；设计、代码和用例评审单分别支持 `reviewExecution`。可为人工工作及评审指定 `workExecutorUserId`、`reviewExecutorUserId`，均限当前组织活跃成员；未指定则沿用所选席位负责人／原审核人。人工执行不要求设备或 Harness；需求分析仍沿用独立分析与正式发布协议，最终验收仍为人工。旧模板字段缺省时保持既有执行语义。

人工节点分派给用户，前置通过后进入待处理，不唤醒设备。正式完成登记绑定来源指纹、前置交付摘要、真实 Jira 子单和指定执行人。工作单须登记交付版本及正式材料引用，功能测试须登记可对账的全部通过计数；失败、阻塞或跳过不能放行。人工交付证据参与后续版本摘要与 Agent 上下文，不伪造设备回执。

Agent 节点仍要求对应领域原生能力、租约、进程停止和正式交付证据，混合执行要求客户端 `delivery-executor-v1`。设计／用例 Agent 评审新增 `design-review`／`test-case-review` 能力；必须同时安装原生评审技能及 `harness/delivery-review-protocols.json` v1 声明，设备守卫需支持真实评审工单和工作流，报告须含通过结论、被审版本和正式完成核验。当前旧 Harness 没有该协议时无法接单，配置页明确提示且不得静默改派或冒充工作单执行。

原生领域评审声明示例（只声明已经实现的角色）：
```json
{"design-review":{"workflow":"design-review","guardRole":"design-review","version":1},"test-case-review":{"workflow":"testcase-review","guardRole":"test-case-review","version":1}}
```
对应技能分别为 `jira-design-review`、`jira-testcase-review`；不能只新增声明来绕过尚未实现的守卫和交付协议。

### 评审返工（2026-11-05）

席位新增 `delivery-rework-v1`，接收评审返工意见及历史证据。必须通过原生恢复／重开协议修改，修改后重新完成门禁和正式交付；无法原生重开时提交问题请求负责人。Stop hook 和服务端均拒绝复用退回的 completed 状态及历史正式附件。更新客户端后刷新登记才能接收返工。

### 独立评审与知言返工统计（2026-11-05）

设计／用例 Agent 评审需原生 Harness 声明 delivery-review-protocols.json 并安装对应独立技能；能力摘要包含身份、计时和上报脚本。准备阶段按原生 execution_state_path 定位账本，不能假定研发和 QA 使用同一目录。返工需 delivery-rework-protocol.json v1，保留原统计来源与代次，归档旧证据、撤销旧确认，不重置历史统计。新版只读 verify 避免核验时间变化导致反复冻结失败；旧核验器只允许身份元数据变化。

交付回读核对已确认知言快照、项目/工单、代次与实际度量；仅统计文件改变不能证明返工材料已修改。领域评审必须绑定本次 inputDigest 与 reviewWorkKeys。人工网页等待不等于人工实际投入；Agent changes_requested 请求负责人决定，不能冒充人工审签。部署与验证范围见 doc/plans/2026-11-05-delivery-review-zhiyan-fix.md。

## Harness V2 observation candidate

`harness_observation.py --config <seat-config> --run <registered-run>` accepts the validated Harness transport summary on stdin and queues it locally; it does not launch work or upload. The existing collector uploads it only when a fresh receipt advertises `harness.observation/1`. Missing capability leaves this stream queued while old streams continue. See [contract, validation and remaining launcher work](../../doc/plans/2026-11-14-harness-observation-protocol.md).

## Explicit candidate bundle registry

The Harness capabilities CLI supports `bundle-list` and `bundle-register`. Registration first validates the configured frozen bundle, negotiates the new endpoint, then sends only descriptor metadata with expectedRevision using existing device authentication. It never uploads local paths or changes execution routing/configuration. Registration conflicts are not automatically retried. Include `harness_bundle_registry.py` when distributing this candidate.


Harness V2 单席位试点现要求服务端 `DSP7_HARNESS_V2_SEATS` 精确白名单和 Bridge `harness_v2_pilot` 公司/席位/任务范围。仅开启旧功能开关不再放行。配置、发布前置条件与回滚见 [试点准备](../../doc/plans/2026-11-14-harness-v2-seat-pilot.md)。

Harness V2 platform observer binding (candidate): outbound poll negotiates
`observerProtocol: 1` alongside the existing permit/tree protocols. A selected
`harness.observer-binding/1` attachment travels in the original permit. Bridge
checks its run scope and actual local bundle at launch and compares the same
attachment on renewals. A required attachment cannot fall back to optional
observation when preparation fails. This does not grant any new domain task
execution authority or mark a package loaded. The new module is included in the
installer inventory. No live configuration is changed by installing the source.

The candidate bundle launcher also freezes `harness.runtime-context/1` from the
original Collector paths and the verified package roots. It exposes
`HARNESS_CONTEXT_FILE` / `HARNESS_CONTEXT_DIGEST` only after successful
preparation, checks for drift before producing further projections, and supplies
the same context to the pinned native reader. This records the organization
Bridge configuration directory without reading configuration contents. Legacy
core configuration precedence and state locations remain authoritative.
