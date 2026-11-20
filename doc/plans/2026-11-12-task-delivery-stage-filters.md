# 任务按 AI 交付链环节筛选（2026-11-12）

## 最终行为

侧栏统一“任务”入口。页面使用 shared 的 `DELIVERY_STAGES`、`DELIVERY_STAGE_LABELS`，按交付链顺序展示全部任务、需求分析、研发设计、编码与代码评审、测试用例、功能测试、其他任务。交付链配置页也改为引用同一份顺序定义。

所有环节共用 `IssueManagement` 列表、状态视图、项目／人员／席位筛选、排序与分页，先组合条件再计算数量和分页。切换环节保留状态及项目等条件；清空普通筛选保留当前环节。列表增加可选“交付环节”列。原分析列表不再作为分析分类的浏览界面，创建分析与新修订仍使用原表单和 API。其他环节提供需求条目安排入口，不直接绕过交付准入创建或派发。

## 关联与边界

CompactIssue 增加可选 `deliveryStages`，不新增数据库列。compact 路由先完成组织和任务可见性过滤，再针对当前页 ID 批量读取同组织分析记录与交付链阶段记录，返回稳定去重的环节数组并计入 ETag。仅返回当前可见任务的关联，不扩展列表可见范围或分析详情权限。评审按对应阶段关联，修复和重测按其真实阶段记录关联。无直接关联的任务返回空数组，归入“其他任务”；未返回字段或查询失败不得当成无关联。

不通过标题、席位类型、本机运行阶段或猜测 Jira 文字归类。尚未建立显式交付链／分析关联的历史任务属于其他任务。只读取关联，不派单、不改变任务状态、不修改审批或预算。

保留旧 `/analysis-executions` 跳转和 `taskType=analysis` 链接。原执行编号链接继续打开统一详情，保留返回列表项目、状态、分页和条目上下文；创建与新修订参数仅在创建视图消费，返回列表时移除。原修订尚未加载、标识不匹配或无交付时，不提供可误建为独立分析的表单。

## 验证

- 8 个相关测试文件，52 项通过：关联归类／公司及分页范围／失败传播、环节与状态组合、统一列表计数、缺失投影不误归类、创建入口、旧详情链接与修订预填等。
- 原 compact HTTP PostgreSQL 集成套件 15 项因本机 `uv_os_get_passwd returned ENOENT` 跳过；独立探测得到相同不支持结果，未计为通过。
- Shared 构建、UI 类型检查、server 直接 `tsc --noEmit`、token gates、Vite UI 构建及 scoped diff 检查通过。
- 未进行仓库全量验证或实机浏览器验收。已于 2026-11-12 10:07（Asia/Shanghai）发布线上。

日志：`/tmp/pc-stage-final-tests.log`、`/tmp/pc-stage-tests.log`、`/tmp/pc-stage-pg-support.log`、`/tmp/pc-stage-shared.log`、`/tmp/pc-stage-typecheck.log`、`/tmp/pc-stage-server-types.log`、`/tmp/pc-stage-tokens.log`、`/tmp/pc-stage-build.log`。

## 上线验证

发布目标 `http://10.60.43.53:3100`，发布号 `20261112-task-stage`。基于线上资源图增量更新前端及任务列表路由／环节投影服务，保留其他已部署行为和所有旧资源 URL。前端 683 个模块链接检查、356 项安装文件和 354 项 HTTP 静态资源哈希核验通过。数据库及应用文件已备份，无数据库迁移、环境配置或客户端清单变更。重启报告无丢失任务，发布前后无活动任务。

候选与线上版本均以注入测试身份在数据库强制只读连接上调用真实 compact 任务路由，覆盖两个组织、14 项任务，核对阶段关联、ETag 304、跨组织关联为空及无组织权限 403。真实服务匿名 HTTP 检查仍拒绝访问。此验证不等同于真实浏览器登录／页面交互验收；ego-browser 因 macOS Launch Services 错误无法启动。

回执：`doc/plans/2026-11-12-task-delivery-stage-filters-release.json`。线上入口切换至 `index-27a46636.js`。

## 任务页上下文回归修复（2026-11-12 10:26）

用户打开任务页遇到 `useDialogActions must be used within DialogProvider`。此前增量产物仍可加载两份完整应用入口，各自创建弹窗 Context，静态模块链接校验无法识别这种运行时身份冲突。

基于新鲜线上资源图，将旧入口改为对当前入口的同名导出转发，保留最新应用实现；所有受影响引用重新生成版本化 URL，并更新 index 与 Service Worker 版本。发布不重启后端，不修改数据库、客户端、环境配置；原资源保留并备份切换文件。后续增量发布不得保留第二份应用入口的 Context／bootstrap 实现，须保留单例入口并执行产物运行时验证。

验证：674 个模块链接；产物中仅一个模块定义弹窗 Context；在 JSDOM 中移除顶层自动挂载语句、增加测试导出后，使用真实编译 React／createRoot、Provider Context 与另一入口导出的真实 hook 完成消费渲染，hook 身份相同且取得 Provider 值。该检查针对发布产物，不能等同于实机浏览器验收。331 项发布文件 HTTP 哈希通过，外部地址 index／sw／主入口／转发入口再次核验通过。服务 PID 1141251 保持不变，health 正常，匿名 API 403。浏览器工具仍不可用，未声称完成浏览器验收。

回执：`doc/plans/2026-11-12-dialog-context-hotfix-release.json`。入口 `index-212820ff.js`；线上备份及临时构建／验证脚本位置详见回执与 `/tmp/pc-context-hotfix/`。
