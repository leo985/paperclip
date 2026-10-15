# 原生 Windows 席位接入

## 方案

Windows 使用 PowerShell 安装入口，直接连接本机 Windows Claude Code、Harness 工程、业务仓库和模型配置，不安装 WSL。

运行链路：网站调度 → 本机主动轮询 → Windows 可见控制台 → ConPTY 中的 Claude → 原有领域技能与门禁。审批仍由平台／Jira 核验，通过 Stop hook 续传同一 Claude 会话；保留单执行器保护。

## 接入步骤与使用场景

适用于研发已有 Windows Claude 环境，希望通过网页接收指派、查看执行与用量、处理阻塞决策的场景。

1. 准备 Windows 10 1809+ 或 Windows 11、Python 3.10+（含 pip）、Git for Windows（含 Git Bash）。支持原生 `claude.exe`；官方 npm 安装的 `claude.cmd` 会解析为 Node 与 CLI JS 入口，避免将任务提示交给 `cmd.exe` 解释。Node 版本遵循 Claude 自身要求。
2. 在 PowerShell 验证 `claude --version` 与 Git 可用，准备 Harness 和业务仓库。本机 `.claude/settings.local.json` 存在时沿用；否则使用 Claude 默认配置，不需要在网站重新填写模型 Key。
3. 网站“席位 → 接入我的电脑”选择 **Windows（原生 PowerShell）**，生成并执行接入命令。接入码有效期有限且仅能消费一次，不要转发。
4. PowerShell 入口检测 Python，并在缺少时通过 pip 安装 `pywinpty>=2.0.15,<4` 的预编译 wheel；虚拟环境安装到当前环境，普通 Python 使用当前用户安装。企业网络需允许所配置 pip 源，或事先安装批准的 wheel。
5. 根据提示确认 Harness／Claude 路径与项目仓库。成功后在用户级 PATH 加入 `%LOCALAPPDATA%\ZhiyanSeat\bin`，重新打开 PowerShell 使用 `harness`。
6. 回网站确认心跳。可以先使用已授权的模拟工单验证，再启用正式 Jira 自动接单。

`harness start`、`attach`、`seat`、`repo`、`status` 和 `knowledge` 通过桥执行；其他子命令委托给登记的 Harness CLI。安装不修改 Harness 源码，不保证所有领域技能里的 Shell、Maven、MCP 都已适配 Windows；这些工具仍须在研发电脑准备好。

## 后台运行

安装当前用户的 `Zhiyan-Seat-Bridge-<用户SID>` 计划任务，使用交互登录身份、普通权限，登录时启动并立即启动本次接入，不保存 Windows 密码、不安装 SYSTEM 服务。使用 pythonw 启动监督进程并保存本机日志。

- 必须保持该 Windows 用户已登录。退出登录、休眠和断网时会离线。
- 网页请求或授权自动接单时可打开本机可见窗口。`Ctrl+]` 暂离后使用 `harness attach 工单号` 重连；`/exit` 结束 Claude 会话。
- 使用 `-NoService` 时不创建任务，按安装器打印的命令手动运行 `pilot.py ... watch`。
- 本机日志位于 `~/.config/paperclip-dsp7-bridge/watcher.log`，超过 5 MB 后在下一次启动保留一份 previous 日志。
- 本机 Windows 气泡提醒为尽力投递，受系统通知设置影响；网页与管理员配置的钉钉机器人仍是独立通知通道。

## 平台适配

- Windows 当前用户 ACL 保护席位配置和凭据；不能以 `chmod 600` 代替 Windows 权限。外部 Jira 凭据文件也需要私有 ACL。
- Windows 文件锁使用 `msvcrt` 字节锁；释放文件句柄后自动释放。
- 使用 Windows MachineGuid 的摘要作为设备指纹；服务端允许 Windows 盘符绝对路径，仍拒绝相对路径和换行／NUL。
- ConPTY 保留真实 Claude 交互；IPC 只监听回环地址，连接前校验随机令牌，令牌文件在当前用户私有目录中。
- 通过 CIM 查询精确 Claude 进程与会话 UUID。停止时校验进程身份，仅停止本次执行树；使用 Job Object 在监督进程退出时结束它的后代。
- 子进程管道通过线程读取，避免 Windows 无法 select 管道；UTF-8 使用增量解码。
- 同用户已有计划任务或 `harness.cmd` 指向其他版本时拒绝覆盖，先核对旧进程与执行权，再迁移。

## 源码与构建

桥源码位于 fork 的 `integrations/dsp7-bridge/`。`ui/scripts/build-dsp7-bridge.mjs` 生成 ZIP、摘要、Python 与 PowerShell 安装入口，单独克隆本仓库即可生成分发文件。特殊开发可用 `DSP7_BRIDGE_SOURCE` 显式覆盖位置；生产构建使用仓库内源码。

## 验证边界与实机验收

本次执行 macOS 下的 Python 编译、前后端类型检查、UI token gate 与前端构建。当前没有 Windows 主机，未完成 PowerShell 实际执行、ConPTY 交互和真实工单全流程验收，不能将静态检查作为 Windows 生产验收。

结果：Python 编译、UI 类型检查、server 类型检查、UI token gate 和前端生产构建均通过。全工作区类型检查被未安装依赖的示例 MCP 包阻断（缺少 Node 类型）；全工作区构建的前置步骤缺少 `cli/node_modules/tsx`。未运行测试。当前 Node 为 22.22.0，低于项目声明的 24.11+，后续完整工作区验证需先准备项目要求的环境。

待 Windows 实机验证：

1. 原生 Claude 和 npm Claude，两种安装方式；用户名／目录包含中文和空格。
2. 首次登记、重复运行、过期接入码与已存在旧任务的保护。
3. 当前用户登录后台任务、注销／重新登录后的心跳。
4. 可见终端启动、人工输入、窗口缩放、暂离与重连、网页审批同会话续传。
5. 取消只停止目标执行树，不影响其他人工 Claude；断网后无重复执行。
6. 已授权模拟工单的用量采集、网页状态、阻塞通知；随后验证获授权的正式工单及领域工具。
