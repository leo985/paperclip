# P1 独立需求分析生产发布记录

日期：2026-10-26（上海时区）。生产地址：http://10.60.43.53:3100 。

## 发布结果

P1 独立需求分析闭环已发布，平台服务健康正常。发布基于既有生产依赖和原生 runner，更新所需 backend/shared/db 编译模块、UI、帮助页及接入桥安装包，不整体替换依赖。

- 发布 UTC 时间标识：`20261025T160019Z`。
- 563 个发布文件逐一 SHA-256 校验通过。
- 生产迁移 0289–0296 已应用，数据库迁移状态为 `upToDate`。
- 其他运行中用户服务 PID 未变化；没有向生产创建分析验收任务、自动执行 Jira 或发送钉钉消息。
- 已有席位未强制升级，凭据、配置及研发目录未迁移。
- 发布前已完成数据库与变更文件备份：`/home/fg/paperclip/private/p1-analysis-backup-20261025T160019Z`。
- 服务端发布回执：`/home/fg/paperclip/private/p1-analysis-release.json`。

## 独立发布后核验

从本机访问生产地址验证：健康接口正常，首页引用的全部 JS/CSS 资源返回成功，独立分析资源 `AnalysisExecutions-CJCTqwYz.js` 可访问，在线帮助包含“独立需求分析闭环”。

接入桥 ZIP 共 38 个文件，下载内容与线上 manifest SHA-256 一致；包含 `analysis_execution.py`、`analysis-execution-v1` 能力声明及 `attach-run` 支持。未登录访问分析接口返回 403，没有放开鉴权。

机器可读回执及核验明细见 [发布证据](2026-10-26-p1-analysis-production-release.json)。

## 使用方式

1. 已有席位负责人先在席位详情 → 设备与诊断 → 更新客户端，执行网页给出的升级命令。
2. 本机登记分析套件：

   ```sh
   harness capability register --kind analysis --profile dsp --path /Users/leo/work/fingard/base-harness-analysis-suit
   ```

   其他电脑使用各自实际存在的分析 Harness 路径。
3. 打开交付工作台／条目交付 → 独立需求分析，选择项目并创建任务；不要求 Jira 编号。
4. 管理员明确授权派发到已登记分析能力的在线席位，本机拉起可见 Claude。当前版本问题与质量评审在网页答复，同一会话接收后继续。
5. P0–P4 完成后查看七项产物索引。正式发布仍需在 Jira／轻舟正式流程完成，再由管理员登记实际链接和版本核验说明。

## 验证边界

发布前相关服务端回归 107 项、Python 接入桥回归 65 项通过，shared/db 构建、迁移安全检查及服务端 TypeScript 编译通过，UI 构建、类型与 token gates 已通过。原生 runner 未改动，复用生产制品；未声称本机 Cargo runner 完整构建通过。

隔离本机真实可见 Claude 已完成 P0–P4、网页决定传输和七项产物采集，详见 [实现与验收](2026-10-25-p1-analysis-execution-implementation.md)。这属于本机隔离验收，不是生产真实业务端到端验收；会话采集标记 `known_gap`，不保证完整覆盖。

ego-browser 创建空间及空间列表调用无响应，已终止挂起 CLI；本次未完成交互式浏览器验收。Windows/Linux 实机分析运行和真实钉钉提醒仍待验收。正式发布仅为人工核验登记，不含上游自动上传、自动发布或来源回读，不自动触发研发派单。

## 回退约束

保留发布前备份、旧静态资源及新增表数据。若需回退，由维护人员按备份文件清单恢复兼容模块与静态资源、保留已应用迁移文件和日志，再重启并核验健康；不得删除新增表、破坏性回灌数据库或重复派发未确认停止的运行。
