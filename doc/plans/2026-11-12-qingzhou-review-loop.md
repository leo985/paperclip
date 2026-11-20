# 分析交付到轻舟申请评审闭环（2026-11-12）

实际轻舟协议将保存分析与申请评审分开：`UC_PROJ2_DEMAND_SPLIT_ANALYZE` 仅保存，`UC_PROJ2_DEMAND_APPLY_REVIEW` 使用 `urid/reviewer` 表单进入状态 5（分析完成待评审）。依据 avatar-proj 的 DemandServiceImpl.splitAnalyze/applyReview、状态机与 proj-ui 的调用契约实现。

平台保留当前输入版本的真人 P3 批准门禁。原生 P4 交付通过后，沿用同组织执行席位凭据、项目条目身份核对和冻结报告指纹，先保存并回读正文，再取轻舟保存后返回的 reviewer 申请评审，再核验正文、状态和评审人。没有有效评审人或评审人与分析负责人相同则停止，不能借用席位负责人或猜测人员。

既有 JSON 回执增加可选 reviewStatus/reviewerId/reviewAttemptedAt/reviewVerifiedAt/sourceState/reviewError，无数据库迁移。status=saved 仅表示正文已核验，reviewStatus=submitted 表示已核验进入轻舟评审。历史仅保存记录不会批量自动提交；显式重试时先读取来源，继续未完成步骤。申请结果未知时先读回，不在同一尝试中重复 POST；重试不覆盖已保存后被他人改变的正文、不把下游状态回退到评审。已有状态 5 且正文一致时读取确认，不重复申请。所有写入仍在任务与条目串行锁下，按组织记录保存/提交审计。正式业务评审仍由轻舟评审人完成。

数据库联调发现旧版本防护用 JS 毫秒时间比较 PostgreSQL 微秒时间时可能匹配任务自身。新增排除本任务 ID，保留对其他新交付的保护。

验证与发布结果见同名 release.json。测试涵盖真实 PostgreSQL 的并发串行、丢失保存响应、归属权限、审计，以及 HTTP 协议的提交丢失响应/状态未流转/正文变化/无效评审人和 UI 分步重试。当前 TWGF-00919 的 P3 待人工批准；实现发布不等于该条目已实际提交。

验证结果：定向数据库测试 13 项与 HTTP 协议/闭环/UI 测试 25 项全部通过；shared 构建、服务端直接 tsc --noEmit、UI typecheck、token gates 通过。标准 server typecheck 命令的前置 runner 构建因环境缺少 cargo 停止。另跑的 analysis-executions 路由套件有 2 项在进入回写前返回 404（by-task、dispatch）；本次未改对应路由，也未将它们计为通过。未运行全仓构建/测试与浏览器可视化验收。

发布结果：175 个文件服务端哈希一致，其中 173 个网页文件通过外部 HTTP 哈希核验；接口健康正常，匿名任务详情返回 403；7716 个静态具名导入核对通过。无数据库迁移、无客户端升级。真实轻舟只读核验条目仍为待需求分析，评审人已配置且不同于分析负责人。

运行恢复：热重启报告 lostRunIds 为空，但旧 outbound 运行实际被标为 cancelled/finalized_while_down，因此不能仅据 lostRunIds 宣称运行保留。核实完整进程树退出和许可撤销后，已通过标准派发接口恢复同一任务，运行号为 `14e772db-bb20-4ae3-ab8d-dfa198a6334b`；原始目录、28276 字节分析正文、输入指纹及 28 条证据保留，新运行的 P3-review 为 open。发布后的运行核对必须检查实际活动状态；当前 outbound 场景后续应使用先停止并确认、发布后恢复的流程，不能假定热重启能保留运行。未代替用户批准报告或提交轻舟评审。完整证据见 [发布回执](2026-11-12-qingzhou-review-loop-release.json)。
