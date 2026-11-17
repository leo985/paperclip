# Harness V2 李巍单席位试点准备

## 已核定范围

公司：基础平台 `bf49caa4-5d09-4f5c-b6ae-a5d80b90a5e8`；席位：李巍 `a8d57a91-cfcc-4642-a2d1-964bdf3c9e9b`。2026-11-14 登录后只读核对为在线、空闲、无活动 run，Claude 2.1.325；页面提示项目仓库未绑定。开始执行前重新读取状态，不沿用此快照作许可。

当前生产组合查询返回 404。健康接口 commit `8f8a0ab7effbd6a0584107d8038736c134ee5047` 与本地工作树基线 `d2f11ed1d` 之间已有大量功能差异，且生产可包含额外发布覆盖文件；不能按 commit 号直接覆盖整个服务。此次源码候选包不是可直接部署的运行包。

## 新增隔离约束

服务端必须同时启用相应功能开关并匹配精确公司/席位白名单；无白名单、无效 JSON、通配符、未知字段、超过 16 个条目全部不放行。开关分别控制观察协商/写入和候选组合登记。既有私有查询权限不因开关而扩大；关闭后历史数据仍可由原有授权人查看。

```dotenv
DSP7_HARNESS_OBSERVATION_ENABLED=true
DSP7_HARNESS_BUNDLES_ENABLED=true
DSP7_HARNESS_V2_SEATS=[{"companyId":"bf49caa4-5d09-4f5c-b6ae-a5d80b90a5e8","seatId":"a8d57a91-cfcc-4642-a2d1-964bdf3c9e9b"}]
```

这是部署配置示例，不已写入任何服务。新配置无热重载保证，按实际服务加载方式生效并重新读取回执验证。

Bridge 除已有 `harness_v2_observation` 包锁配置外，要求顶层 `harness_v2_pilot`：

```json
{
  "harness_v2_pilot": {
    "companyId": "bf49caa4-5d09-4f5c-b6ae-a5d80b90a5e8",
    "seatId": "a8d57a91-cfcc-4642-a2d1-964bdf3c9e9b",
    "taskIds": ["<平台正式创建的隔离测试任务 UUID>"]
  }
}
```

占位值不能执行。任务 ID 列表为 1–16 个 UUID；未命中公司、席位或任务时保留原启动参数，不创建观察绑定。缺少或非法范围时拒绝加载候选，原启动器继续既有可选观察降级逻辑。配置不授予任务执行权；原平台许可、预算、工单身份、工作树和进程监督检查继续生效。运行中的绑定保持冻结；修改白名单只影响后续启动，正在运行任务的停止须用原取消/许可撤销流程。

## 执行顺序与验收证据

1. 获取生产受影响文件和运行依赖的实际 SHA-256 清单，备份当前服务及配置。候选 manifest 的 `baseSha256` 是本地 HEAD 基线，不是生产基线；任何不一致都先评审移植，禁止整目录覆盖。服务端路由/shared 与 Bridge 一起核定，UI API 客户端不要求发布新页面；无需新增 DB migration。
2. 将变更移植到经核定的发布基线，在独立构建目录完成相关测试、类型检查及生产构建；检查依赖不会指向开发者的另一工作树。当前开发目录 node_modules 为共享链接，不作为发布产物复制。
3. 准备服务运行包、Bridge 包、冻结的 L3/L4 组合包、精确文件清单和配置差异，给出具体发布范围再进入发布步骤。服务开关先关闭；发布与重启须服从生产活动队列/任务检查，不能仅凭李巍空闲判定整个平台可重启。
4. 通过平台既有支持的入口创建专用隔离测试任务，记录真实任务/run/许可。核定专用项目与源码工作区映射，不把现有业务仓库改绑为测试仓库，不重开 ATSES-516228。若原入口不能表示无业务写回的测试，先补设计和实现，不能伪造状态绕过门禁。
5. 在单席位的真实配置副本中准备 `harness_v2_pilot` 和固定 bundleDigest；复核同名旧技能冲突。当前 Harness 根目录已有旧 git-history-analyzer 时应保持冲突拒绝，不能删除旧入口来凑通过。2026-11-15 新增独立试点入口构建方案（见下节），保持原 cwd 与治理配置；正式调用仍须联合验收。
6. 正常运行后收集原生 session、观察快照、outbox ACK、平台私有查询及 DB 去重证据；比较旧计时/上报账本。继续验证断网、重复、取消、许可到期、崩溃重启及进程树退出。模板 Read 成功不等于完整 L4 技能使用验收。

## 回滚

- 先停止新试点任务进入；通过原平台取消和进程退出证明处理活动试点，不删除 run/许可或强改状态释放席位。
- 关闭观察与组合登记开关或移除该白名单，禁止新 V2 写入；保留历史查询及本地待传队列，不删除 SQLite/outbox。关闭能力可能使已有 V2 待传流暂缓收尾，恢复/归档须按既有协议处理。
- 移除本席位新增候选配置，恢复备份的 Bridge/服务文件与配置；保留其他席位、现有凭证、项目映射及活动业务配置。
- 核验非试点旧执行链路、原生许可/停止、健康与鉴权负例；核验无额外计时/上报。

## 本轮验证与未完成项

服务端 31 项路由/范围测试通过（含真实嵌入式 PostgreSQL），定向服务端类型检查通过。Bridge 验证结果见 Harness IMPLEMENTATION-STATUS。本轮未部署、未创建测试任务、未更改真实席位配置。生产实际文件基线、可运行发布包、启动路径冲突处理及真实纵向验收仍未完成。


## 2026-11-15 启动冲突处理更新

使用打包器 `build --pilot-alias` 构建的独立入口 `harness-v2-history-pilot`，不替换原 git-history-analyzer，不改变正式席位 cwd/settings/MCP/Hook。候选技能设置 `disable-model-invocation: true`，只能显式调用。它用于试点共存，不代表正式别名迁移已完成。Bridge 原冲突校验继续生效。

冻结候选 bundleDigest：`6998c2aacd8fc93641062f1fc7f8dacb94de4cdb3cd0aa4599b021d2ff7d1c1e`，本机目录 `harness/v2/artifacts/history-pilot-alias-20261115`（相对于 Harness 仓库）。后续席位配置须使用这个新包和对应摘要，不覆盖旧版本目录。Bridge 原目录准备测试通过；真实模型探针仍运行于隔离目录，不冒充正式平台运行。

验证：打包 9 项、Bridge 42 项、引擎 12 项通过；新包真实模型 Read 探针通过。公共目录 license/icon 提示仍待正式分发确定。生产只读 SSH 尚未建立：密钥认证失败，保存配置的编码尚未核定，现有解密工具要求的本机 key 缺失；未修改认证配置或服务器。先恢复受支持的 fg SSH 访问再获取实际文件基线，不能因网页 admin 登录正常而绕过此条件。


## 2026-11-15 生产基线及候选包复核

SSH 阻塞已解除：已确认保存连接直接使用凭据，未采用通用 XOR 解密流程；已完成 fg 只读连接与服务 active 核验。前节缺少 key 的解释不能作为当前阻塞。

已捕获 13 条生产文件/缺失记录及当前公共 Bridge 包，生成限定运行候选：

- 服务端：8 个 JS 文件，原文件 SHA-256 与新摘要逐项记录于 Harness `harness/v2/artifacts/service-overlay-20261115/manifest.json`。保留生产正文清理、自动能力登记限制、审计和 inputSource 等既有差异。生成器为 `harness/v2/scripts/build-service-overlay.py`。
- Bridge：以生产 ZIP 为基线，53 文件、8 项变化，修复安装器遗漏新模块。候选摘要 `c635faf545772b96a3b9776b9612cda8378975eebbdce8610b1099d79280b97d`，自动升级 false；详见 `harness/v2/artifacts/bridge-overlay-20261115/review.json`。生成器为 `harness/v2/scripts/build-bridge-overlay.py`。
- L3/L4：继续使用上一节冻结的独立试点入口包。

产物测试：编译路由/契约与捕获服务加本地其余依赖的 31 项测试通过；ZIP 解包运行 42 项 Bridge 测试通过；安装器在临时目录安装/字节核对/重复安装通过。两套运行包可重复构建，捕获基线被改写时拒绝构建。测试不等于远端运行环境启动成功。

切换前必须按 manifest 再取生产文件摘要（不存在的新增文件也须再次确认）、检查整个服务的活动 run/队列、备份所替换文件和配置。先保持 V2 开关关闭验证旧链路，再按精确白名单启用。公共 Bridge 下载不随单席位试点自动替换；李巍席位当前安装目录和配置必须单独核定后通过支持的版本化安装切换，不能覆盖运行中的版本目录。本轮未上传、重启或切换任何真实席位。


### 单席位最终候选选择

已核定李巍实际版本为 `8ff4722992ebb0cdd2cc84d88bda12fa247a53cff69c7bc0170d85243ef54146`，组织专属配置位于 `~/.config/paperclip-dsp7-bridge/organizations/655ae2c797e834a3/bf49caa4-5d09-4f5c-b6ae-a5d80b90a5e8/config.json`；专属服务 `com.leo.paperclip-dsp7-bridge-5e8a5bf795a319b0`，不要操作默认 DSP7 配置/服务。

公共最新包还包含两项无关分析模块变化，因此李巍试点选择基于当前席位代码的 `seat-bridge-overlay-20261115`，摘要 `6705e9fedb218558afdf631d7ce0db0b4540e7c98ca0f7626eac3b94ed73d974`，不选择上一节 cf5a58 基线候选。旧代码基线为逐文件已捕获快照，不冒充原始版本 ZIP。安装前重新核对 49 个基线文件。新包 42 项回归及临时安装核验通过。

首次服务发布范围限定为 service-overlay manifest 中的 8 个 JS 文件；两项 V2 功能开关保持关闭，不作 DB migration、不发布 UI、不替换公共 Bridge 下载。执行前重新核对全部原文件摘要、新文件不存在、服务全部活动运行/队列及退出未确认容量；不满足即停止切换。备份所改文件及其存在性，按原服务管理方式重启；健康、鉴权负例、旧协议和新 GET 路由关闭态核验失败即恢复文件及原服务配置并核验。服务开关和单席位安装/测试任务启动是后续独立步骤，不随首批服务发布自动执行。

## 2026-11-15 原生领域状态观察候选

- delivery 启动器将现有已校验上下文交给候选 prepare，冻结原生工单/父单/工作流/路径；仅显式试点范围生效。Collector.scan 调用同一 L3 包的只读读取器，使用原 `phase: observed` 协议及 SQLite outbox，未新增状态权威或上报队列。
- 事务内串行采样/去重，事件与游标原子提交；同阶段原生状态变化也可观察，completed 仍不等同门禁通过/平台接受。暂停后不补采，当前 scope 变化拒绝迟到数据。旧简单 state→phase 快照读取在 nativeDomain 模式停用，其他既有来源保留。
- 新候选目录为 Harness 工程 `harness/v2/artifacts/history-domain-pilot-20261115` 和 `seat-domain-overlay-20261115`。前者 bundleDigest `b9a17b75d5d0817ee8572e0492e032a8fac3e3f36027b1300fabb0ead7fc3272`；后者 ZIP SHA256 `4abd6e9414882714786d137154df42df30ce19b84d0ae91434105c63d56aba50`。旧冻结产物未覆盖。
- 测试：72 项 Bridge Harness 测试、31 项服务端定向测试通过，服务端限定范围 tsc 通过。测试是本地 SQLite/包读取器与 HTTP 替身，不是线上许可/业务验收。
- 查询沿用 `GET /api/companies/:companyId/managed-sessions/:sessionId` 的 phases；Mod 生命周期摘要保留原独立查询。本批未增加 UI。
- 当前覆盖既有五类 Jira 交付工作流；历史分析技能实际方法/结果证据、治理/上报权威回读仍待补。未上线、未激活席位、未创建真实任务/run/permit。

## 2026-11-15 首个 L4 方法本地真实宿主验收

Harness 新增隔离 Git fixture、固定 collect/count/evidence 工具适配、独立结果验收与真实 Claude 探针。`harness/v2/artifacts/live-history-4y_pg4xr/report.json` 为 passed=true；冻结组合 b9a17b75d5d0817ee8572e0492e032a8fac3e3f36027b1300fabb0ead7fc3272，真实宿主 2.1.325，显式候选 L4 入口完成方法/报告，3 提交/2 issue/1 revert 及当前代码经独立核对正确，权限拒绝 0。知识库/业务未写入，原始统计通过重采集核对；产物由探针保存模型结构化 stdout。本地验收器共 29 项测试通过。

此结论限于本地合成数据，不能代替平台 run/permit、真实 outbox 故障或客户交付；registry executionReady 保持 false，未安装或激活李巍席位。真实试点输入和联合验收仍待完成。

## 2026-11-15 观察附件冻结补充

新增严格 `harness.observer-binding/1`，由服务端操作员精确 company/seat/task/project/bundleDigest 配置选择，经原许可事务冻结在 ledgerScope JSON 内，无 DDL。原 outbound-poll 需 observerProtocol=1 + permitProtocol=1 + supervisionProtocol=2；指定附件的旧客户端在一次性领取前拒绝。续租比较当前选择、登记 revision/描述与原附件，变化撤销许可；Bridge 检查冻结附件、本机试点范围及包字节，明确附件准备失败时不得降级继续启动模型。原业务执行路由、预算及进程树退出契约继续权威。

此能力只是候选观察包关联，不是正式可执行组合路由，也不能把 Git 历史分析登记为平台 requirements-analysis。李巍席位的真实 task/project/run 尚未创建，真实配置与生产均未变更。最新候选为 Harness 的 service-binding-overlay-20261115（12 文件）与 seat-binding-overlay-20261115（54 文件、10 变化），旧 overlay 不含本批修改。详情见 Harness V2 docs/platform-observer-binding.md 与 IMPLEMENTATION-STATUS.md；仍须发布前复查基线/席位空闲/映射及真实原生授权。

## 2026-11-15 显式路径上下文首批迁移

Bridge 将原 Collector 的 project/source/state/config 位置及已校验 runtime/resources 冻结为 harness.runtime-context/1，在创建观察目录前由包内同一 L3 parser 校验，文件与摘要保存到既有运行元数据。原生状态和资源 reader 可接收显式 context+pin；运行中路径漂移拒绝新投影，不移动账本。config root 只记录组织专属 Bridge 配置父目录，不读取配置或改变 Jira/知言/宿主凭据来源。

最新候选更新为 Harness 的 history-context-pilot-20261115-r2 和 seat-context-overlay-20261115。服务 JS 不变，service-binding-overlay-20261115 仍为当前候选；新源码配合其编译 JS 的 53 项验收通过。Bridge 实际解包 100 项通过。旧 core 路径迁移、匹配原生领域的正式组合路由和真实专用任务/席位验收仍未完成；生产/真实配置没有改动。

## 2026-11-15 原核心显式路径候选

Harness 打包原 Python 治理/计时/知言和其依赖，通过 HARNESS_CORE_CONTEXT=1 + 已冻结上下文提供显式本地入口；原工程策略、模板、配置与原账本继续权威。Bridge outbound 和 interactive 清除监督环境继承的 HARNESS_CORE_CONTEXT，本批不自动启用真实平台核心路径迁移。

最新本地组合为 history-core-pilot-20261115（bundleDigest 5467c621af9c43cbd5c7f28da8b1aa26cd53c6c9337b4a3750a4897b1b84aeb2），单席位候选 seat-core-overlay-20261115（ZIP SHA256 3f7bfcdb9402260d4a75763a77823cdd58c383dc88c3cddeb2e039eb8f6eddab）。服务 JS 无修改，仍复用 service-binding-overlay-20261115。Bridge 解包 100 项、服务编译候选 53 项与限定 tsc 通过；核心重定位仅对本地 loopback Jira fixture 验证，无生产 Jira/Tracker 写入。CJS/bootstrap 与全体 Hook/MCP 尚未迁完，正式执行组合/真实授权任务验收仍未完成。未部署、重启、激活席位或修改真实配置。

## 2026-11-15 CJS、MCP、SessionStart 显式候选

Harness 已补 CJS/bootstrap、MCP 环境、claude-mem、Hook 修复器、SessionStart 和 reporting-checklist 的显式路径入口。Node 通过同一 L3 Python 解析器校验上下文，原工程策略/配置和宿主数据目录继续权威；默认入口/真实配置不变，Bridge 仍清除继承的核心开关，不自动启用本批功能。

最终组合 history-launchers-pilot-20261115-r2，bundleDigest a03cf399bf18edfca21c71950bf5b3401418169d1954dea9a1b90d6a6f1ca221。Bridge/service 源码本批未改，继续使用 seat-core-overlay-20261115 与 service-binding-overlay-20261115；最新组合源码配合实际解包 Bridge 的 100 项、服务编译候选 53 项、限定 tsc 通过。Harness 分包 56、旧入口 127 项通过，新增 9 项测试覆盖本地 CJS 前后台/配置优先级/启动事件边界，不是真实模型或生产安装验收。其余 CLI/Hook、正式执行组合与专用任务/run/permit 联合验收仍未完成；未发布、重启、激活席位或提交推送。

## 2026-11-15 原治理工具显式路径候选

Harness 新增 review-gate、codedog-check、test-evidence、defect-closure 四个显式入口，沿用原模块/策略和多仓账本范围。回执/证据写原工单，缺陷核销写原工程台账；冻结上下文不成为平台许可或 Tracker 身份。没有修改 Bridge/service 代码、真实配置或安装 Hooks。

最终组合 history-governance-pilot-20261115，bundleDigest 59c2cf357069feeff159d3b8123a0fe0d564766dfac51523fd937e52f95974ab。复用 seat-core-overlay-20261115 和 service-binding-overlay-20261115；当前包源码配合实际解包 Bridge 100 项、服务编译候选 53 项及限定 tsc 通过。Harness 分包 63 项、旧治理 98 项通过，新增 7 项重定位测试包含实际本地断言与原评审链、合成缺陷回读；不证明真实发布/真实 Tracker 更新。其他 CLI/Hook、正式组合与专用授权 run 联合验收仍待完成，未发布、重启、激活席位或提交推送。

## 2026-11-15 静态扫描与知识库显式路径候选

Harness 增加 static-scan/scope-check 与 kb-status/kb-validate/kb-staleness/kb-route 显式入口。打包 harness-cli 的其他混合分支在分派前拒绝；原工程工具/知识数据与缓存、原工单产物和 state 保持原位，原 L4 加载策略不变。知识库维护写入链、其他 Hook/安装接线与正式执行组合仍未完成，不修改 Bridge/service 及真实配置。

当前组合 history-cli-knowledge-pilot-20261115，bundleDigest 08c17ef6d4f02b5a646e2e7ffdbc4e0e147ab08cc583126b590df5cdd3072528。复用 seat-core-overlay-20261115 与 service-binding-overlay-20261115；当前源码配合实际解包 Bridge 100 项、服务编译候选 53 项、限定 tsc 通过。Harness 分包 69 项（含新增 6 项）、旧静态扫描 18 项、backlog 2 项、平台 CLI 11 项通过；旧路由 13 项中 2 项失败已在原 HEAD 代码和同一数据上复现，不能宣称全绿，未改变数据或信任语义。验收详见 Harness artifacts/cli-knowledge-path-acceptance-20261115/report.json。

李巍席位仍无真实专用 task/run/permit 联合验收，registry 保持 false/unconfirmed。未发布、重启、安装、激活席位、写生产业务或提交推送。其余技能、旧单续传与 Windows/多席位验证继续待办。

## 2026-11-15 原工单工作树检查候选

Harness 的打包 CLI 增加 worktree-check，原工单仓库清单与可选 ticket 在 Git 检查前后核对；保留主检出拒绝/linked worktree 接受的原判定，不创建工作树或签发执行权。最新组合 history-worktree-pilot-20261115，bundleDigest f3dec6c2bc922be22a1d128ca4e23cf40a5ff6fabce5b9ce1c0ca5600cbbebb8；3 项实际 Git 重定位、分包 72 项与旧 CLI 11 项通过。Bridge/service 源码未改，本批未重跑其旧测试；上批原路由两项基线失败继续保留，不宣称全绿。

验收见 Harness artifacts/worktree-path-acceptance-20261115/report.json。正式组合/真实授权 run、其余技能、Hook/安装与跨版本续传仍未完成。未部署、重启、安装、切换李巍席位、提交推送或写生产业务，registry 仍为 false/unconfirmed。

## 2026-11-15 metrics 与确定性知识维护候选

Harness 显式入口新增 metrics 读写/汇总、knowledge-update/kb-update 及固定 UC/错误码提取器。原工程保留数据与聚合，知识更新前校验全索引和原跨仓提取范围，子进程执行校验包内代码。原 HEAD 更新器缺失 count_module_apis 导入已复现并修复；仅补齐该依赖的旧算法对照与新显式链 JSON 一致（时间除外）。PyYAML==6.0.3 声明随包提供，仅在本地临时 venv 安装验证，不自动安装到席位。

最新组合 history-maintenance-pilot-20261115，bundleDigest fa9fb116159eca49584f00b561bd624de0de982a11a39c04d11fa592c0024918。新增 11 项，完整分包 83 项、旧静态 18 项、CLI 11 项通过；Bridge/service 未改、旧 100/53 项本批未重跑，原路由两项失败保留，不宣称全绿。证据见 Harness artifacts/maintenance-path-acceptance-20261115/report.json。

其他 CLI/手工或 JS 提取器、Hook/安装、剩余技能、正式组合与真实授权 run 仍未完成，Phase 2 保持部分完成。未提交推送、发布重启、安装、切换李巍席位或写生产业务，registry 仍为 false/unconfirmed。

## 2026-11-15 评测、索引与只读初始化候选

Harness 已接入原评测定义/固定业务单元回放、CodeGraph 全批目标预检，并拆出 init --read-only。未知或变化的 runner 拒绝，实际代码来自包；定义结构校验不等于 LLM 行为评测。只读初始化沿用原配置优先级，跳过 Git 同步/编译/安装/个人配置写入/原工程 Oracle bootstrap。安装式 init/bootstrap、平台代理 CLI 与真实席位安装尚未接通。

最终组合 history-diagnostics-pilot-20261115，bundleDigest 9b926d2bd7c2de844cf43d49432fd5615e0bf75f8acdfb0b50f416b771bcfa30；此前 history-evals-index-pilot-20261115 保留为中间冻结证据。新增本轮 13 项后分包 96 项、旧 CLI 11 项、静态 18 项通过；原 16 条路由回放结果一致。CodeGraph 和网络诊断为替身，不是真实索引或生产连接验收。Bridge/service 未改、旧 100/53 项本批未重跑；原路由两项基线失败保留，不宣称全绿。详情见 Harness artifacts/diagnostics-path-acceptance-20261115/report.json。

其余技能/提取器/Hook、正式执行组合、旧单续传、真实授权 task/run/permit 与 Windows/多席位验收仍未完成，registry false/unconfirmed。未提交推送、部署重启、安装、切换李巍席位或写生产业务。
