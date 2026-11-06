# 席位简化命令

- 跨平台命令统一：`harness online`、`offline`、`doctor`、`upgrade`（支持 macOS/Linux/原生 Windows）。
- 已登记席位通过网页完整更新命令升级一次，安装受管 CLI；之后 upgrade 获取网站最新安装器，不依赖旧安装器代码。
- Unix 的原安装器符号链接切换至受管转发器，领域命令转回登记的 Harness；未知入口拒绝覆盖。备份和恢复包括符号链接。
- Harness 工程 CLI 同步提供简化命令，旧版桥明确提示先更新。`doctor --environment` 保留原环境诊断，带 --repo 参数仍走原环境检查。
- online 安装/启动当前用户服务，恢复本机暂停；不自动清除网页暂停策略。
- offline 先写持久暂停标记。调度、发现、接入、网页启动、本地 start、新 outbound 运行和 wake 均阻止新执行；现有会话和网页决策继续运行，确认空闲后 watcher 自行成功退出。断网无法确认时保持服务重试。
- macOS KeepAlive 改为仅失败重启，成功退出不拉起；Linux Restart=on-failure、Windows 登录任务保留。主动暂停跨登录保留。
- 心跳 acceptingWork=false 显示“本机暂停／待下线”，服务端拒绝新启动。离线页展示简单恢复命令。
- 不执行或终止真实任务，不改动当前已安装席位；未发布线上。

## 检查边界

本次进行 Python 编译、UI/后端类型检查、网页构建与样式门禁；未运行真实服务启停、离线等待任务、Windows/Linux 实机流程或自动化测试。
