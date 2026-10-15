# 新建 Claude 智能体：第三方中转站

## 场景与入口

智能体 → 新建 Claude → 连接模型 → API 密钥 → 使用第三方中转站。

支持兼容 Anthropic Messages API 的服务。填写站点基础地址、认证方式、中转站密钥和可选模型名称；地址保留站点要求的路径，不自动追加 /v1。仅支持 OpenAI 接口的站点不适用于此入口。

## 实现

- `ui/src/lib/claude-relay.ts`：验证 HTTP/HTTPS 基础地址，拒绝 URL 中的账号、密码、查询参数及片段；构造非秘密环境配置并将原始密钥仅保留在内存 credentials 中。
- `AgentProviderConnection.tsx`：新建智能体连接步骤增加中转站选项、Bearer Token/API Key 选择和模型输入。中转站不进入官方 AI Connections 路径，保留官方连接原有行为。
- `NewAgentSetup.tsx`：测试与创建使用相同地址、认证、模型和执行环境；创建时走既有个人秘密存储，只持久化 user_secret_ref；失败清理新建秘密。中转站采用 Claude CLI，配置页展示所选站点，可修改模型或回到连接步骤。
- `packages/shared/src/validators/agent.ts`：单次连接探测的 testCredentials 白名单增加 ANTHROPIC_AUTH_TOKEN，凭证只供探测使用。
- 在线帮助智能体主题同步使用说明。

向导使用 ANTHROPIC_BASE_URL，以及所选 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY；清空另一认证变量与 OAuth Token，关闭 Bedrock/Vertex/Foundry 选择，避免本机既有配置干扰所选站点。不会修改本机全局 Claude 配置。个人秘密继续遵守已有负责人和授权规则。

组织首次引导及通用官方连接管理面板未增加中转站管理。本次入口为新建智能体；已有智能体可通过现有环境变量编辑器和秘密引用配置。

## 检查与发布

UI 类型检查、UI 生产构建、shared 包构建、脚本语法及 diff 空白检查通过。未新增或运行测试套件。未提供指定中转站地址与密钥，因此未做真实站点调用验收，也未进行浏览器交互验收。

前端发布整份当前构建（包含既有界面/帮助改动），保留旧 assets，最后原子替换 index.html。后端仅部署 testCredentials 白名单增量；检查无活动运行后仅重载 Paperclip，其他服务不重启。

### 发布记录

已上线。主 JS 确认包含中转站选项和 AUTH_TOKEN 配置；首页、新建智能体路径、在线帮助及健康接口返回 HTTP 200。Tracker 首页也返回 HTTP 200。

- 前端备份：`/home/fg/paperclip/private/ui-before-claude-relay-20261007-010128`。
- 后端白名单备份：`/home/fg/paperclip/private/agent-validator-before-relay-20261007-005934.js`。
- 重载前没有 queued/running 运行。Paperclip 启动健康恢复超过初始 50 秒等待窗口，随后确认恢复，未进行额外重启。
- 未使用真实中转站密钥验收；连接表单会调用原有实际环境探测。
