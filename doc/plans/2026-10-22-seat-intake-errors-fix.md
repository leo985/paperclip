# Jira 接入阻塞回写与启动错误提示修复

## 原因

DSP-10 / FRISK-30716 的 Jira 类型为“代码扫描问题”，不在当前编码、Bug、设计工作流映射内，未完成本机登记。原接入失败处理直接更新 blocked，但没有解除阻塞说明，触发平台 422，掩盖真实类型错误。直接执行 harness start 又因托管命令入口未捕获 BridgeError 而显示堆栈。

## 修改

- 不支持的 Jira 类型明确显示实际类型名，不擅自选择其他工作流。
- 接入失败回写 blocked 时附带 board 负责的 unblockDescriptor，说明修正及恢复 backlog 重试步骤。
- 托管交互命令捕获业务异常，以简洁信息退出；尚未登记时引导查看网页接入结果。

## 发布

Python 编译和差异空白检查通过，未添加或运行自动化测试。

客户端发布批次 `20261022T012930Z`，仅更新 ZIP 与清单，包内变动为 harness_entry.py、interactive.py、jira_intake.py。公开下载哈希已核对，无服务端重启。

SHA256：`956f4daefab3ea61dc183b4d18879c8140838f9bff4b390162eebd18b9220141`。

备份：`/home/fg/paperclip/private/seat-intake-errors-fix-20261022T012930Z`。

该工单需要先明确“代码扫描问题”的工作流支持方案，或选择符合现有类型要求的子工单；本修复不绕过领域门禁，也不启动 Claude。
