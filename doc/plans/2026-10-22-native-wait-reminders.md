# Claude 原生等待提醒修复（2026-10-22）

## 问题与行为

DSP-11 / ATSES-491887 的 Claude 在 `AskUserQuestion` 原生界面等待人工处理。本机已记录 `PermissionRequest` 等待边界，但席位监控只读取 Harness 的 `current_confirmation`，因此持续报告 busy，没有生成机器人提醒。历史个人 DWS 成功检查容易被理解成当前提醒成功。

席位现在消费当前运行目录的显式 hook 边界。`AskUserQuestion` 的 PreToolUse 和 PermissionRequest 进入等待；匹配的工具完成或失败、用户输入、Stop、SessionEnd 清除等待。其他工具的完成不会清除带调用 ID 的未完成问题。历史无调用 ID 的 hook 保持兼容，后续执行边界清除旧等待。校验运行、任务、会话状态及启动时间；不凭静默推断等待，也不代替用户回答或审批。等待期间报告 waiting_decision，提醒沿用服务器既有授权、去重、间隔及超时升级。

原生等待提醒明确引导到席位电脑的 Claude 终端。Harness 领域确认仍引导至工单。hook 仅记录边界、工具调用 ID、等待类别，不记录问题正文、参数或回复。移除历史个人 DWS 的“最近提醒通过”检查；网页把机器人记录明确标成历史投递，并说明受理不代表已读，也不能证明当前等待已通知。当前投递与运行的自动关联展示未增加：现有接口未返回运行/提醒标识，保留真实可核对的时间与结果。

## 发布与证据

- 本机仅更新三个兼容监控/observer 文件及 README，全部 28 个安装包文件与新公开 ZIP 逐字节核对，版本 d922bc4f46b84562d317ff821e47e8ade52960ec892a9c6dfaa4d97534be5553。
- 重启独立 watcher 前核对当前 Claude、wrapper、supervisor 均不是其后代；当前运行 b62bea6f-7e0c-42c3-911a-ee99a47f7aea 的 PID 41560 / 41474 / 41463 均保持存活。
- 网页静态资源与安装包原子更新，保留旧哈希资源并备份替换文件。服务端未重启，MainPID 1398742 保持不变，避免破坏内存中的 outbound 租约。无需数据库迁移或服务端代码变更。
- 线上等待信号变为 waiting_decision。按本次提醒的去重键精确查询 activity_log，2026-10-22T15:58:26.634Z（北京时间 23:58:26）返回 submitted / ACCEPTED_NOT_READ。连续心跳仍只有一次 sending 预留及一次 submitted 结果；没有手工发送或重试。
- 本机备份：`~/.config/paperclip-dsp7-bridge/live-patches/native-wait-20261022T155824Z`。
- 服务器静态备份：`/home/fg/paperclip/private/native-wait-static-backup-20261022T155916Z`。

## 验证

- Python 原生等待及席位集成测试 9 项通过，包括提问/权限、恢复、调用身份、历史/异任务、部分写入、内容白名单及同一等待 ID 稳定性。
- 现有 DSP7 seat runtime Vitest 测试 4 项通过。
- UI typecheck、UI build、token gates 通过。构建保留既有 Node 版本及 Vite/CSS/包体积警告。
- 未运行全仓 typecheck/test/build：变更限定在 Python 监控、hook 及 UI 文案，使用上述针对性验证。未代答当前原生问题，未修改 Jira 凭证；该任务仍需负责人在 Claude 终端处理。

机器可读发布记录：`2026-10-22-native-wait-release.json`。
