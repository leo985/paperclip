# DSP7 审批消息前端状态

## 实现

仅对 adapterConfig.dsp7ExternalConfirmation=true 的 Agent 识别独立 JCONF 评论，兼容编辑器转义。发送前与评论投影不将审批标为队列；普通评论及重分派消息保留原行为。聊天与经典评论通过显示投影展示审批状态，不改原文、作者和时间。

本机桥将人工 JCONF 评论的显示状态持久化到任务 description 隐藏 DSP7-CONFIRMATION-STATUS 标记。版本1包含 commentId、status、message、confirmation、runId；不存凭证。前端仅用于观测，不作为执行权限。有效决定来自不可变回执，继续状态需对应 same_session_resume_dispatch 事件。

界面显示提交中、等待核验、无效原因、同意／拒绝已接受、等待终端重连、Claude 已继续、模拟任务完成。刷新恢复服务器投影；未完成时每5秒查询，描述更新触发核对。桥按既有监督周期发布。本次回执显示只支持模拟模式，正式工单仍以 Jira 为准。

## 部署与检查

源码：ui/src/lib/dsp7-confirmations.ts、ui/src/pages/IssueDetail.tsx；桥 pilot.py 的 publish_confirmation_status。静态生产构建先复制全部资源，再原子替换 index.html，旧哈希资源保留。完整备份位于 /home/fg/paperclip/private/ui-before-confirmation-status。回滚恢复其 index.html 和同名非哈希文件；回执与领域状态保留。未重启服务器后端、Tracker、SSH；仅重载本机桥监督服务。

Python语法、UI类型检查、Vite生产构建通过。构建存在上游大资源块与动态导入警告。未新增或运行测试。DSP-5实际同意回执与同会话派发已发布 completed，旧“确认”显示 invalid。页面与资源HTTP状态已检查；实际浏览器渲染待用户强制刷新验收。

## Project 与真实执行

当前 Project 非必需；包装器以登记 --worktree 为 cwd 启动正式 Claude。建议一业务仓库一 Project，编码／Bug子单独立 worktree。Harness知识目录为 /Users/leo/work/fingard/base-harness-infrastructure-dsp7。模拟在临时 workspace 执行，不能证明真实开发已验收。根据 Project 自动选择本地仓库、创建 worktree 和登记工单尚未实现。
