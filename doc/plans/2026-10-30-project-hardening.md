# P0–P2 完善与验收

日期：2026-10-30。状态：2026-10-31 恢复后连续三轮复核，外部验收条件未变化，目标阻塞。

用户授权持续完成前述项目分析的 P0、P1、P2。保留工作区已有改动，不以历史实施记录替代本轮验证。

## 工作清单

- [x] P0：测试与构建基线恢复，失败分类及真实回归修复（分组恢复通过；原始整仓失败记录保留，条件跳过不作为真实平台验收）。
- [x] P0：源码、迁移、服务端、UI、Bridge 本地版本矩阵；部署和设备对应版本明确标为未验证。
- [ ] P0：真实串行交付闭环及中断、停止、恢复验收。
- [ ] P0：Windows 真机治理及计量／费用完整性验收。
- [ ] P1：正式来源证据只读核验与材料变更失效。
- [x] P1：测试失败、修复、独立复审、重测的有界编排及本地数据库／Bridge／UI 验证；真实业务验收归 P0。
- [x] P1：待处理事件持久化认领、转交、提醒及审计。
- [ ] P2：产物索引与下载、阶段计量和数据完整性。
- [ ] P2：后台保留清理、完整备份与恢复演练。

## 验证原则

先执行定向测试，再完成整仓类型、测试与构建检查。真实业务、Windows 与生产发布分别记录，模拟验证不视为真实验收。不得因全量失败而删掉测试、弱化权限或门禁。未知费用不计为零；未经本机确认的停止不得用于重新派单。

## 本轮记录

- 已复现 TrustPresetSection 三项因英文断言与默认中文不一致的失败；开始修复为当前语言断言，保留边界状态与只读行为检查。
- 全量 UI 测试与 UI 类型检查已启动，结果待收集。
- 发现受管会话保留清理仅在采集请求后触发，且全局节流先于执行成功；拟接入现有后台控制周期，失败应可重试。
- 已完成后台保留清理改造及生成迁移 0299；真实 PostgreSQL 回归通过，验证删除中途失败完整回滚、立即重试、并发合并、近期正文保留及去重 tombstone 保留。
- 修复 macOS 嵌入式 PostgreSQL 缺少 major/unversioned dylib 别名导致数据库测试被跳过的问题；5 项原生运行时回归通过，真实数据库已能启动及应用迁移。
- 项目要求 Node >=24.11；本机默认 22.22。下载官方 Node 24.22.2 并校验 SHA-256，仅用于本轮命令 PATH；不替换用户全局 Node。Cargo 使用已有 ~/.cargo/bin，不跳过 Rust 门禁。
- UI 英文行为测试显式使用英文基线，产品默认中文保持不变；新增中英文切换、默认语言及运行时值保护回归，相关 12 项断言通过。首次全量基线 6627 项中 1947 项失败，第二次全量正在运行。
- UI 类型检查通过；整仓类型检查与测试在符合版本的工具链下继续执行。
- 整仓类型检查与整仓构建已通过（本轮后续修改仍需复验）；UI 英文基线从 1947 项失败收敛到 262 项，多个大组定向修复后继续收敛。
- 管理协作跟进已落库，生成迁移 0300；真实 PostgreSQL 路由回归 2 项、认领／释放／冲突刷新／转交 UI 回归 4 项通过。释放自动清除旧提醒；并发版本、公司边界、有效成员及源工单权限均由服务端校验。
- 技能目录构建远程读取补充 15 秒超时，避免网络异常无限等待；不得把缓存回退误称为最新远程验证。
- 日期、预算和相对时间随界面语言格式化，默认中文不变；补充中文日期回归。
- 交付中断恢复新增持久化三次上限，恢复时清除旧回执和评审；真实数据库回归 4 项通过。此项只封住无限人工恢复入口，不代表“测试失败→修复→独立复审→重测”功能已完成。
- 新增完整本地恢复包工具，包含逻辑数据库备份、配置、主密钥、附件和运行日志；文件校验、损坏拒绝、路径边界、禁止覆盖及失败清理两项回归通过。真实 PostgreSQL 备份导入与密文恢复演练正在验证。外部 S3／密钥服务与生产切换仍需各自验收。
- 最新全量 UI：6505 通过、129 失败；当前侧栏 18 项回归已改为真实使用的交付导航、权限、折叠与移动端行为，全部通过。
- 真实 PostgreSQL 恢复演练已通过：导出完整数据库、恢复包拷贝与校验、导入独立数据库、核对业务数据、使用包内主密钥解密附件、验证运行日志。测试过程中发现并修复压缩 SQL 文件后缀丢失导致恢复引擎误判的问题。DB 类型检查通过；生产恢复未执行。
- 产物索引新增兼容字段 downloadUrl：Bridge 逐个读取 Jira 附件并按哈希匹配，仅匹配项提供下载链接；服务端拒绝跨源、凭据、查询参数、片段和非附件路径。界面区分可下载与指纹索引。Bridge 9 项、服务端证据与真实流程 10 项回归通过；重建下载包，不代表已升级在线席位。
- UI 最新全量结果为 6574 通过、53 失败；继续处理剩余向导、成员页与文本契约差异，未跳过测试。
- 报表新增按阶段事件边界裁剪的执行／等待／未知时长；没有阶段事件的区间保留未知，不按耗时比例伪造 token。10 项报表与边界定向回归通过，补充执行／等待跨阶段回归后继续复验。

- 剩余五个测试文件已通过 213 项，整仓类型检查再次通过；全量 UI 复验正在执行。账号测试使用隔离工作目录，防止开发者项目认证配置污染测试。
- 找到登记 Harness 的正式 Jira 确认协议，新增冻结前只读回查：完整有界分页、复用原生判定、临时副本解析、已确认回复版本比较；删除、编辑、替换和未批准均阻断。11 项 Bridge 回归通过。该能力核验已有原生确认，不代替仍未知的最终业务验收字段。

- 最新整仓构建通过，token gates 和 diff 空白检查通过；版本矩阵按本轮 UI 与 Bridge 重新生成。UI 6629/6630 后剩余一项为取消编辑路由异步等待，已用等待卸载替代固定三轮等待，32 项定向通过，全量 UI 再验。
- 下游启动前新增正式附件只读回查与冻结指纹比对；缺少下载原件、附件删除或内容变化阻断派入模型，仍不把未提供原件的其他索引条目标记已核验。

- 全量 UI 最终复验 6630/6630 通过，无跳过；日志 `/tmp/paperclip-ui-clean-20261030.json`。Bridge 正式确认与上游附件指纹定向 12 项通过；实际本机 Harness 解析器离线四种结论版本场景通过，不等同线上 Jira 验收。

- QA 原生模板已确认具有 `证据.用例总数/通过数/失败数/阻塞数/跳过数`、逐条 `execution-records.md` 与被测版本。新增测试结果回执及逐条对账，失败／阻塞／跳过／旧回执结果未知时阻断自动验收；保留交付报告，不伪造全通过。真实数据库覆盖进程已核验退出仍不能放行的四类状态。完整修复→独立评审→重测编排尚未完成，不能以该门禁代替闭环。

- 后续已实现修复链：管理员针对当前失败指纹显式关联已有缺陷、独立评审及重测工单；修复／评审席位不同，串行运行独立 CLI，保留预算、门禁及退出核验。并发创建仅一份成功，历史失败回执保留；第二轮可明确继续同一缺陷，三轮后拒绝继续。真实数据库完整三步运行、跨席位冒充拒绝、缺少评审报告拒绝、再次失败与上限等回归通过；相关 25 项定向通过。Bridge 原生 bugfix/review 路由及结论验证通过，全套 139 项中 137 通过、2 项 Windows 专属跳过。UI 固定授权时看到的失败版本，旧版本冲突可见且不静默重试。此为本地工程验证，不替代真实 Jira/Windows 验收。
- 首轮完整服务端测试：13063 通过、32 失败、89 跳过，另有清理／启动钩子失败；期间修改导致部分旧源码与新测试组合，不能用于宣称当前版本全绿。已知五组集中 187 项通过；补齐启动 DB mock 并复验访问服务／工作区隔离／启动导出共 43 项通过；运行环境暴露 25 项通过、3 项跳过。第二轮完整测试已启动，日志 `/tmp/paperclip-tests-frozen-20261030.log`，尚未结束。
- 最新整仓构建通过 `/tmp/paperclip-build-freeze.log`；整仓类型流程仅服务端测试辅助参数推断过窄失败，补显式 string 后服务端 tsc 通过，其余包包括 UI 类型检查已通过。最新源码矩阵 `/tmp/paperclip-component-matrix-freeze-20261030.json`：迁移目标 0300_large_katie_power，Bridge 包及安装脚本摘要一致，线上应用迁移／设备安装／业务验收未验证。

- User supplied ATSES-515808 for live acceptance. Read-only Jira inspection: standalone online-problem issue, pending triage, no parent/subtasks/links, description only states that a page cannot open. No Jira mutations performed. Actual page URL, reproduction steps, enrolled Windows seat and a linked demand for the full serial chain are still required; questions are pending.

- 已只读核验部署记录中的在线站点 `http://10.60.43.53:3100/`：health 为 ok，服务自报 commit `8f8a0ab7effbd6a0584107d8038736c134ee5047`，备份状态 ok；公开 Bridge 实际下载摘要与在线 manifest 一致，为 `779e3cafd8bd6f9fb6c3e9a42c0835718a89c9f5313e5f99055fa358b89cb010`，与本轮本地包不同。此为在线观测，不能视为本轮发布或完整恢复验证。
- 通过现有浏览器会话只读核对席位：李巍为在线 macOS，最近心跳客户端 `5b8e7bfc05a37d87`；范天星为离线 Windows，最近客户端 `0bc5051e843dfcd2`，登记版本 2、检查时间 2026-10-23 19:12:56，页面要求本机上线和重新核验登记。Windows 真机验收仍受设备离线限制；已询问问题页面／复现步骤与完整需求链。未更新线上服务、客户端、设备登记、派单或 Jira 工单。观测记录 `/tmp/paperclip-online-version-observation-20261030.json`。

- Final recursive typecheck completed successfully: /tmp/paperclip-typecheck-final-all-green.log. Full build already passed at /tmp/paperclip-build-freeze.log. Frozen full test run remains active without a failure report so far; no full-pass claim yet.

- 进一步通过已配置 SSH 与已知主机密钥进行只读线上检查：运行目录 `/home/fg/paperclip/runtime`，发布包 paperclipai 2026.1001.0。数据库使用 READ ONLY 事务，仅查询迁移历史；最新三条 hash 与本地 0297、0296、0295 精确匹配，最新已应用为 `0297_loose_paladin`，本轮目标 0300 尚差 0298–0300。未迁移、重启、部署或读取业务表。证据 `/tmp/paperclip-online-migrations-readonly-20261030.log`。
- 已向用户明确：自动化测试在本机 Mac 上运行；线上平台仅只读检查，Windows 席位离线，尚未派单或执行真实 Windows 验收。

- 冻结后重新生成组件矩阵 `/tmp/paperclip-component-matrix-current-20261030.json`，服务端／UI／数据库／共享包／Bridge 源码摘要与 freeze 矩阵全部一致，UI 构建与 Bridge 安装包摘要一致；类型检查与构建日志均以 Done 完成。整仓测试会话 3559 已再次确认仍存活、日志持续更新，尚无最终汇总，不宣称通过。

- 等待全量测试期间发现首轮遗留本地 fake-harness runner（PID 21316，PPID 1，连接端口 57996 无监听，状态目录属于已结束 vt-82137-1）。仅对该确定的测试进程发送 TERM，并确认进程消失；当前测试会话 3559 与业务席位均未停止。尚无足够证据归因为产品清理缺陷，不改动冻结源码。

- 冻结全量测试第一阶段 general-server 完成：708 文件通过、3 文件跳过；13128 项通过、83 项跳过，无失败。运行器已继续 general-workspaces-a 的 UI，全量命令整体尚未结束；不能把服务端阶段通过当作整仓全部通过。

- 同一冻结整仓流程中的 UI 全量复验已通过：646 文件、6633 项测试全部通过，无跳过，包含最终新增修复链控制 UI 回归；流程继续 CLI 与其余工作区和串行服务端组。

- 临时 Claude 2.1.207 已完成安装，未修改全局 Claude 或席位。真实本地 MCP 隔离定向 3 项通过，日志 `/tmp/paperclip-mcp-isolation-final-20261030.log`；继续工作区 B 完整组，日志 `/tmp/paperclip-tests-workspaces-b-final-20261030.log`（会话 88234）。
- 串行组发现席位预约存在性泄露：`POST /issues/:id/dsp7-reservation` 跨公司 403 与不存在 404 可区分。已按 authz 契约在资源查询后加入 hasCompanyAccess 404 门禁，保留同公司写权限及机器校验。真实 Express 请求回归验证跨公司与缺失响应一致且不继续查席位，同公司仍进入机器校验；原静态门禁加新行为回归共 4 项通过 `/tmp/paperclip-seat-oracle-final-20261030.log`。重新运行串行组 `/tmp/paperclip-tests-serialized-repaired-20261030.log`（会话 11210），服务端类型检查已通过 `/tmp/paperclip-typecheck-seat-oracle-20261030.log`。先前全量证据需与此改动及后续检查组合解读。

- 工作区 B 完整组已 exit 0：shared 766、skills-catalog 21、DB 163、adapter-utils 1233、Claude 299、Codex 421、Grok 131、OpenClaw 18、OpenCode 48、Daytona 236、plugin-sdk 71、create-plugin 2 项通过；合计保留 22 项原有条件跳过。最新服务端构建也 exit 0 `/tmp/paperclip-build-seat-oracle-20261030.log`，组件矩阵更新为 `/tmp/paperclip-component-matrix-oracle-20261030.json`。
- 只读核对线上恢复配置：embedded-postgres、local_disk、local_encrypted、文件日志，自动数据库备份每 60 分钟、保留 7 天。当前部署未使用外部 S3 或密钥服务，因此它们不是当前部署真实恢复验收的必需项；线上完整一致性恢复仍未演练。未读取配置密钥值或改动服务。证据 `/tmp/paperclip-online-recovery-config-readonly-20261030.log`。

## 完成审计（尚未全部通过）

| 原始要求 | 当前可检查证据 | 尚缺的完成证据 |
| --- | --- | --- |
| P0 工程基线 | 整仓类型及构建通过；最终预约权限修复后服务端类型、构建和四项权限回归通过；general-server、UI、CLI、工作区 B 通过 | 149 文件串行组已完整通过并核对唯一覆盖；最终 OpenAPI 修改后服务端类型和构建均 exit 0 |
| P0 版本对应 | 当前源码摘要、UI 构建、Bridge 包及安装脚本一致；线上服务与迁移、两席位客户端版本已只读核验 | 本轮版本上线后的迁移、UI、客户端一致性验证；目前线上仅应用到 0297，本地目标 0300 |
| P0 真实交付及中断恢复 | 本地真实 PostgreSQL 状态机、进程退出门禁、恢复上限与修复链测试 | 可执行的真实工单复现和需求阶段链；ATSES-515808 只有“无法打开页面”，没有页面地址、复现步骤或需求关联 |
| P0 Windows 治理及计量 | 跨平台实现、Bridge 本机测试；Windows 专属测试明确未执行 | 已登记 Windows 席位恢复在线、重新核验并完成真实运行、停止和计量核对；当前范天星离线 |
| P1 正式证据及失效 | 原生 Jira 确认只读回查、回复版本比较、正式附件回读及指纹核对；代码见 `delivery_execution.py` | 最终业务验收的权威字段或记录规则及真实通过样本；不能把平台人工确认或普通工单状态提升为正式验收 |
| P1 有界修复及管理协作 | 三轮修复上限、独立评审、逐条重测对账；管理认领、转交、提醒、审计已持久化并有数据库和 UI 回归 | 本地实现已验证；真实业务闭环仍归 P0 验收 |
| P2 产物与计量完整性 | 正式附件下载索引、阶段执行/等待/未知时长、运行级用量及缺口显示 | 阶段级可信 token 来源尚缺；当前明确 unavailable，不能按时间摊分；真实数据核对仍需运行 |
| P2 保留及恢复 | 后台正文过期、失败重试、事务回滚、并发合并；独立 PostgreSQL 恢复及密钥解密、附件和日志核对通过 | 线上写入静默后的一致性全组件恢复演练；定时数据库备份状态不能代替此项 |

本表保留原始范围。未验证、条件跳过和外部阻塞都不是完成；本地工程实现通过也不自动勾选真实业务或 Windows 验收。

- 串行组完成 86 文件后，关闭工作区签出测试 6 项失败。实际异常是测试的空 DB 桩不支持新增 DSP7 签出预检查询；补齐“无 DSP7 登记”的空查询响应后，原有重建、run-id 门禁及清理回归保持原断言。并发现签出预检在公司校验前解析接入标记，补充解析前 404 公司门禁及无效标记跨公司回归。关闭工作区、预约/签出边界和原存在性静态门禁共 17 项通过 `/tmp/paperclip-checkout-boundary-final-20261030.log`。
- 为避免每个新失败都重跑已通过文件，按原运行器 dry-run 的完整 149 文件清单与 duration 分片算法恢复剩余 63 文件；每份仍调用未修改的 `run-vitest-stable.mjs --mode serialized`，保留原隔离环境，逐文件保存退出状态，不失败即停止遗漏后续文件。临时恢复驱动 `/tmp/paperclip-resume-serialized-20261030.mjs`，日志 `/tmp/paperclip-tests-serialized-resume-20261030.log`，覆盖及退出状态 `/tmp/paperclip-serialized-resume-results-20261030.json`；原 86 份通过证据保留在 repaired 日志中，尚待剩余执行完后联合审计。
- 恢复组发现重试门禁误分类：预算服务的预检也涵盖人工暂停，调度器错误地把人工暂停记录成 budget_blocked。已让人工暂停继续代理可执行性门禁并返回 agent_not_invokable，保留公司预算及 agent budget 硬停优先级；人工和预算暂停均仍取消重试，不放行执行。补充真实数据库两类暂停回归，路由、策略和 PostgreSQL 适配层共 104 项通过 `/tmp/paperclip-retry-gates-final-20261030.log`。恢复组保留原失败记录，完毕后须用原运行器补跑该文件并合并覆盖证据。
- 剩余 63 文件已全部执行完，记录两个失败：已定向修复的 scheduled-retry 与 OpenAPI 路由覆盖。OpenAPI 现有扫描器未登记新增 17 文件，补登记后暴露至少 66 个字面量接口缺少契约；另外 analysis/delivery/management 等使用 base/callback 组合路径，旧正则漏扫，须一并补强扫描并补齐实际契约，不能把它们放入排除名单或声称当前 OpenAPI 全绿。诊断 `/tmp/paperclip-openapi-coverage-diagnosis-20261030.log`。当前 `openapi-routes.test.ts` 仅补了 17 文件前缀登记，覆盖测试预期仍失败，待继续实施。
- 最新重试门禁修复后服务端类型检查、构建 exit 0，日志 `/tmp/paperclip-typecheck-retry-final-20261030.log`、`/tmp/paperclip-build-retry-final-20261030.log`；最新源码矩阵 `/tmp/paperclip-component-matrix-final-20261030.json`。后续 OpenAPI 改动须再验证。

- 冻结整仓命令后续：CLI 502、shared 766、skills-catalog 21、DB 163 项全部通过。adapter-utils 1232 通过、11 跳过、1 失败；失败为本机 Claude 2.1.206 不满足现有 MCP 隔离测试 >=2.1.207 门禁，隔离行为尚未执行，不删除／放宽门禁。开始仅安装到 `/tmp/paperclip-claude-test-2.1.207` 的测试工具版本，不升级全局客户端；整仓命令 exit 1，余下工作区待恢复。149 个串行服务端文件已另起相同运行器继续，日志 `/tmp/paperclip-tests-serialized-final-20261030.log`，会话 26421。

- OpenAPI 缺口已修复：为新增 17 个路由文件生成 116 条实际契约，包含请求结构、响应状态和权限说明；AST 扫描支持组合路径、模板和有限循环，无法解析或歧义绑定直接失败，不加入排除名单。生成漂移纳入现有 OpenAPI 测试；管理查询补充 CSV 参数说明，席位权限说明按实际行为表述，不宣称全部接口拒绝 JWT。AST 3 项与 OpenAPI 11 项通过，最新日志 `/tmp/paperclip-openapi-contract-final-20261030.log`。开发文档补充生成及验证命令。
- 串行组已恢复完成：原先 86 份通过 + 首次恢复 61 份通过 + 最后两个修复文件通过，精确并集 149 个文件，与原运行器清单一致。保留首次失败报告 `/tmp/paperclip-serialized-resume-results-first-20261030.json`，联合覆盖 `/tmp/paperclip-serialized-resume-results-20261030.json`，最后原运行器日志 `/tmp/paperclip-tests-serialized-final-20261030.log`；后续 CSV/权限文案变更又单独通过 OpenAPI 11 项。原始 `pnpm test:run` exit 1 不改写为单次全绿；全套分组恢复已通过，条件跳过保持原样。进程审计未发现遗留 fake-harness 或测试运行器。
- 最终服务端类型检查及构建均 exit 0：`/tmp/paperclip-typecheck-contract-final-20261030.log`、`/tmp/paperclip-build-contract-final-20261030.log`。组件矩阵 `/tmp/paperclip-component-matrix-contract-final-20261030.json`，Bridge 包及安装器一致；`git diff --check` 通过。当前仍保持整体目标 active：本机工程验证不能替代上表中的真实业务、Windows、正式验收来源及线上恢复证据。

## 2026-10-30 外部条件复核

上一目标轮完成接口契约及串行测试收尾。本轮核对日志和唯一覆盖后勾选工程基线，其余验收项保持未完成。

线上 health 仍为 ok，提交仍为旧版 8f8a0ab7effbd6a0584107d8038736c134ee5047；证据 `/tmp/paperclip-health-final-audit-20261030.json`。使用已知 SSH 主机密钥及 PostgreSQL READ ONLY 事务，只查询席位标识、最近心跳和登记检查时间：本机席位心跳更新到 02:27:42Z，其他席位心跳仍不晚于 10 月 27 日，原 Windows 对应记录仍停留在 10 月 23 日；证据 `/tmp/paperclip-seat-final-audit-20261030.json`。未修改登记、客户端、派单或业务数据。

原生 effort_tracker.py 只有阶段边界和投入时间，没有阶段 token 计量协议；阶段报表保留 unavailable，不能按时长摊分。外部缺口仍为工单复现及需求链、在线 Windows 真机、正式验收来源、发布后验收和一致性恢复窗口，以及可信阶段 token 来源。目标继续 active，不能宣称全部完成。

## 阻塞判定

连续三个目标轮均保留并复核同一组外部验收缺口。最近一轮未发现本项目仍在运行的测试、构建或恢复任务，且没有新的用户答复或可执行验收证据。现有本机实现与回归已完成可独立推进的部分；重复运行不能产生 Windows 真机、正式审批、实际业务复现或线上一致性恢复证据。整体目标标记 blocked，不标记 complete。

恢复工作所需输入：ATSES-515808 的实际页面地址／复现步骤及关联需求；Windows 席位上线并在本机重新核验；正式验收字段／记录规则及通过样本；本轮发布后的真实验收和一致性恢复条件；阶段 token 的可信计量来源。保持原目标范围，证据到位后继续剩余项。

- 用户补充基础平台月度排期报错截图后继续处理该具体故障：实际原因是 2.8 MB 响应超过统一 2 MB 流式上限，非已修复的 null 叶子问题。仅整月树提高至 8 MB，其他接口保持 2 MB；30 项定向回归、类型及构建通过。单模块发布经首轮超时回滚后重试成功，真实页面显示 62/62 条、无 alert。详见 `2026-10-30-monthly-response-size-fix.md`。整体目标其他外部缺口继续保留。

## 2026-10-31 恢复后的首次审计

上一实质工作已修复并发布月度响应体上限问题。用户将目标恢复 active 后重新只读核对：线上 health ok，月度客户端补丁摘要仍为 c32fbece1557f576e0d1d537e13430edcc066bccba79c74242da0342b3e54870；Windows 席位心跳仍为 10 月 23 日，Mac 本机心跳已更新。线上迁移最新 hash 与原审计相同，不能将单模块补丁视为本轮整体部署。

Jira ATSES-515808 仍待受理，描述仅“无法打开页面”，没有父子单、关联、评论、附件或需求条目引用。截图对应读取故障的线上修复已有专门记录，但它不证明完整需求阶段链或正式验收。

当前临时目录已经清理，原全量日志及临时 Node 24 工具链不在。历史通过记录保留为历史记录，不冒充本次全量复验。将当前源码组件摘要、线上模块／迁移／席位及 Jira 观测保存到仓库内 `2026-10-31-acceptance-recheck.json`，不再仅依赖 /tmp 路径。该清单的 tests/typecheck/build 等未验证字段保持原样。其余外部缺口仍未消除；恢复后的阻塞审计重新计数，此轮不标记 blocked 或 complete。

## 2026-10-31 恢复后的阻塞判定

恢复后的第一轮完成持久化证据和线上／Jira 新观测；第二轮确认源码、UI 与 Bridge 摘要不变，无本项目验证任务运行，无实质进展；第三轮再次以 READ ONLY 数据库事务确认 Windows 最后心跳仍为 10 月 23 日、活动运行数为 0。最近两轮不是 verified wait，不存在可等待完成的活任务。连续三轮同一外部验收条件未满足，也无新增用户信息；目标标记 blocked，未标记 complete。

月度页面读取修复已线上验证，其他 P0/P1/P2 缺口保持原范围：Windows 真机、完整需求阶段链、正式验收依据、可信阶段 token 来源，以及本轮目标部署和一致性恢复验证。精确观测保存在 `2026-10-31-acceptance-recheck.json`。条件变化后按原目标继续。

## 2026-11-02 重新激活后的首次复核

此前关于“源代码库”的问题已回答：该项目中仓库关联提供代码来源及基线分支，截图已有 GitLab 仓库，GitHub 为可选附加仓库。此说明不改变当前验收范围。

只读线上复核显示服务健康，但运行提交仍为旧版；月度响应上限补丁摘要仍与发布记录相同。Windows 席位心跳仍是 2026-10-23。ATSES-515808 仍待受理，描述仅“无法打开页面”，无父子单、关联、评论或附件。阶段用量核查确认 usage checkpoint 是累计高水位差量，时间戳只标识观测点；若两个观测间跨阶段边界，现有账本不能准确恢复各阶段 token。未知部分继续保持未归属，不能按时长或观测终点分摊。证据见 `2026-11-02-acceptance-recheck.json`。

用户本轮恢复目标后，此为第一次外部条件复核；目标保持 active，后续继续处理可在本地完成的目标项，并在连续三轮复核后再重新评估阻塞状态。


## 2026-11-02 Harness 源仓库绑定核验

用户指出席位已配置研发／需求 Harness 目录，并会在 Harness 工作区使用代码仓库。核对实现后确认两者各有用途：seat `harnessRoot` 是工具目录；Project workspace URL/ref 是共享仓库身份；本机 `harness repo bind` 将 Project/workspace 映射到已存在的本地 Git checkout，并校验 origin 和基线；编码工单随后从该 checkout 建独立 worktree。填写 Project URL 本身不会克隆或建立本机映射。

当前 `harness repo list` 只返回一条本机映射，其 origin 为 `http://gitlab.fingard.cn/QJ/dsp/dsp7.1_git.git`，分支 `pre-release`，没有本地 `dev` ref；用户截图对应 `http://gitlab.fingard.cn/QJ/ATSSAAS/ats-usercore.git` / `dev`。因此截图仓库尚未证明绑定到这台席位。未新增、替换或拉取任何仓库。详细观测保存于 `2026-11-02-acceptance-recheck.json`。
