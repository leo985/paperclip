# 个人席位智能体与服务器智能体的操作区分

## 行为

以 adapterConfig.dsp7Seat 登记对象或 dsp7Transport=outbound 识别席位智能体，兼容旧 SSH 席位。共享 AgentActionButtons 对席位仅展示派发 Jira 工单、查看关联席位及既有运行查看内容，不展示原生创建任务、invoke、provider trace、pause/resume、terminate、duplicate、reset。独立服务器 Agent 行为不变。

导航保留详情未保存配置确认，席位 query 参数传递到 Jira 表单，预选指定席位并默认展开。优先显示席位接单规则绑定项目；手动选择与最终确认仍可用。目标不可用明确提示，不自动选择其他席位。席位深链接使用 scope=all&view=work&seat=ID；不可访问目标不回落到其他电脑。

不更改 API 权限、数据库、席位身份、接单规则或本机客户端，不触发工单或中断会话。此变更为 UI 流程统一，并非撤销接口权限。

## 验证与发布

AgentActionButtons 10 项测试覆盖席位路由、旧 SSH/出站识别、无原生变更、脏表单导航保护及独立服务器任务分配和执行。既有测试固定英文环境，避免中文默认语言导致断言失效。UI 类型检查、构建与 token gates。静态资源发布，无服务重启、无需客户端升级。未实际启动 Agent 或派发工单。
