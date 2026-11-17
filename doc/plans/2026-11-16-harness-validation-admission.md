# Harness V2 隔离验证正式准入

状态：授权准备及原生许可接线已实现；专用派发、Bridge 运行与生产验收待实现。

## 目的和领域边界

首个试点是“基础平台 → 李巍”对合成 Git 历史执行冻结的 L3/L4 历史方法。
它不属于需求分析，也没有普通 Jira-development pilot 身份。
采用独立 `validation` 许可领域，不能伪装 `requirements-analysis` 或复用历史 Jira 授权。
该领域直接绑定冻结候选组合；不扩展现有原生技能 capability 类型，也不改变 analysis/development/qa 的登记语义。
组合发现记录中的 `executionReady=false` 和观察附件的 `purpose=observation-only` 保持。

## 本批已实现

- `POST /api/companies/:companyId/dsp7-seats/:id/harness-validation/:taskId`，输入仅
  `dispatchId`、`expectedBundleDigest`。组织管理员准备一次 15 分钟授权；返回
  `dispatched=false`、`executionStarted=false`，不唤醒席位、不建 run、不签发许可。
- `DELETE` 同一路径加 `/:dispatchId` 撤销。关闭试点开关后仍可撤销；重复撤销幂等。
- `DSP7_HARNESS_VALIDATION_ENABLED=true` 和闭合 JSON 数组
  `DSP7_HARNESS_VALIDATION_TASKS` 显式限定 companyId/seatId/taskId/projectId/bundleDigest，
  最多 16 项，拒绝重复、通配和脚本/路径扩展字段。默认不启用。
- 依赖原观察开关/范围及唯一登记组合，要求 L4 显式入口 `harness-v2-history-pilot`。
  当前任务项目、负责人、机器、组合及登记 revision 全部冻结。
- 授权和撤销复用原 `activity_log`，按席位原 advisory lock 串行，不创建第二许可表、调度器或本地业务账本。
- `seatPermitService.issue(kind=validation)` 必须独立协商 validationProtocol=1、observerProtocol=1、
  supervisionProtocol=2；授权绑定同公司/席位/原生任务的一个真实 running run。
  普通研发许可拒绝带验证标记的 run。首次消费在原事务记录唯一 run 绑定；重复运行拒绝。
- 原 `ledger_scope.harnessValidation` 冻结运行绑定，续期重查授权有效期、管理员权限、任务/负责人、
  项目、机器、组合、预算、暂停和取消。变化后撤销原许可，不换包、不换 run。
  原许可唯一约束、容量、进程树退出和停止协议保持。
- 原 outbound 对验证上下文明确拒绝，避免尚未接通的专用派发被当作 Jira 研发执行。
  准入服务本身不能证明历史技能或模型已执行。

## 后续顺序

1. 专用 dispatch 复用原 heartbeat/wakeup、原子任务 checkout 和幂等请求；启动前核验
   在线/空闲及新的 Bridge 执行协议，在一次性领取前拒绝旧客户端。
2. Bridge 固定入口创建私有 synthetic fixture 和独立输出，运行三提交样本；禁止任务元数据
   指定 shell、脚本、路径或任意仓库。保留原平台许可、进程树、取消及用量监督。
3. 正式启动冻结 L3/L4 与真实 session，独立检查三提交、修复/撤销关系及报告契约。
   禁止将采集器执行或文件存在认定 L4 方法通过。
4. 同步冻结新服务/Bridge 候选并复核编译文件清单；旧 vertical overlay 未包含本批新模块，不能直接发布。
5. 再核对平台在线状态、队列/活动运行和依赖基线，按已准备候选完成发布与真实纵向验收。

## 验证边界

新增用例使用隔离真实 PostgreSQL，覆盖授权幂等、发现不授予执行、独立协商、领域错配、
重复 run、撤销、到期、负责人/组合/项目/席位变化、开关、管理员失权、费用硬预算及取消。
接口测试验证公司隔离、组织管理员权限、闭合输入、撤销和无 run/permit 启动副作用。
独立 outbound 负例验证验证上下文不能退回旧入口。
本地源代码检查不是编译 overlay、真实 Bridge 或生产联合验收。
