# 帮助中心：工单工作流程泳道图

日期：2026-10-09

## 内容与入口

新增帮助主题“流程总览：从 Jira 指派到交付验收”，作为帮助中心默认主题。
入口：`/DSP/help?section=workflow`；完整手册：`/help.html#workflow`；独立矢量图：`/zhiyan-workflow.svg`。

四条泳道：人员与 Jira、智研协同平台、研发电脑、Harness Tracker。
覆盖一次性接入前提、Jira 指派、本机发现与校验、平台登记与调度、本机执行、阻塞提醒、分渠道决策、有效校验后继续、交付证据、领域回执、运行记录和人员验收。

主图采用可放大的 SVG，无外部渲染服务或新依赖；网页和完整手册共享同一矢量图。
窄屏支持键盘及触摸横向滚动，有独立放大入口；完整手册打印时适配页面宽度。
图下提供相同步骤的文字与表格，支持搜索和无障碍阅读。

## 边界

- 本机接入桥查询 Jira，平台负责登记、调度与可见性；Claude 运行在研发电脑。
- 自动接单需事先授权规则、登记席位、配置 Jira 凭据及仓库映射。
- 正式需求决策走 Jira/Harness，平台原生审批走网页，工具权限走 Claude；模拟 JCONF 单独说明。
- 普通评论不替代正式工程确认，拒绝或信息不足时保持阻塞。
- 运行结束不等于交付验收，待办不等于自动队列。

## 检查

TypeScript 检查与生产构建通过；SVG 使用 macOS Quick Look 渲染并人工检查节点、箭头与中文排版。
未运行测试套件，未进行登录后浏览器交互验收。
发布包：`/Users/leo/Downloads/zhiyan-workflow-ui-20261009.tar.gz`。
SHA256：`101e4890a8ca603a464989bfe89b8f352e2211d161ed13227d78abc83ddbd05f`。

## 发布结果

已发布，备份：`/home/fg/paperclip/private/zhiyan-workflow-backup-20261009-020743`。
状态：`/home/fg/paperclip/private/zhiyan-workflow-release-state.json`。
前端静态更新，保留旧资产，最后替换入口，无后端重启。
服务器与本机核验帮助入口、完整手册、SVG 和健康接口返回 200；本机下载 SVG 与入口 JS 和本地构建一致。
