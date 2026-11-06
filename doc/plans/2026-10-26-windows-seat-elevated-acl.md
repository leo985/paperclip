# Windows 席位管理员安装与普通登录启动的权限修复

## 已确认原因

在授权的 Windows 电脑 `10.60.58.129`（FG 用户、Python 3.14.2）远程复现：

1. 同一 Python 的前台和 `pythonw.exe --check-startup` 均通过，但实际登录计划任务退出码 2，未生成新的启动日志。
2. 用临时诊断任务在相同的 Interactive / Limited 用户环境读取目标脚本，得到 `PermissionError / errno 13`。
3. 版本目录的所有者为 Administrators，受保护 DACL 只有 Owner Rights、SYSTEM、Administrators，没有当前用户 SID 的显式授权。Python 3.13+ 对 Windows mode 0700 目录的特殊权限处理，使管理员创建的临时解压目录不等于普通登录用户可访问的目录。目录重命名后保留该 DACL；chmod 不会修复它。
4. 修复版本目录权限后，计划任务进入 watcher。随后在管理员前台运行时创建的 `seat-control/state.json` 和 `intake` 目录上复现同类权限错误；修复这两个状态目录后恢复正常心跳。

这解释了此前后台启动失败、日志空白、升级回退及在线状态丢失。之前的普通升级断点恢复缺陷是另一个已修复问题。

## 代码改动

- 安装器在创建安装根目录、创建临时解压目录及复用既有版本目录时，显式授予当前用户 SID 和 SYSTEM 完全控制，保护继承；保留所有者与审计部分。不授予 Everyone / Users 权限。
- 引导权限处理独立于尚未可读的接入桥模块。先核对受信所有者（当前用户、SYSTEM、Administrators），拒绝其他个人所有者及链接／junction，再核对安装包摘要和已有版本内容。文件内容不因权限修复而覆盖。
- 识别既有桥时、恢复旧升级事务时，同样修复已登记的旧／新目录，使普通登录用户能够继续恢复管理员创建的旧包。
- 席位控制与 Jira 接入状态目录使用既有 `private_directory`，不再仅依赖 mkdir(0700)。

## 现场处理

先备份目录 SDDL，再修复三个已登记版本目录以及两个受影响的状态目录；没有清除配置、重建席位或变更模型／Jira 凭据。

恢复未完成的更新后，已通过普通权限的当前用户计划任务启动 watcher，服务器确认相同席位 ID 的新版心跳及自动上线检查通过。随后使用发布后的新安装器再做一次正常升级，以验证新建版本目录无需手工修复。

权限备份位于该电脑 `~/.config/paperclip-dsp7-bridge/upgrade-backups/directory-acl-*.json`。临时诊断计划任务已在检查后注销。

## 验证

- 本机桥测试 123 项：121 通过，2 项 Windows 原生检查因平台不符跳过。
- 发布包对应测试 114 项：112 通过，2 项 Windows 原生检查跳过；未加入依赖未发布模块的 delivery execution 测试。
- 同一台真实 Windows / Python 3.14.2 上，28 项权限、安装复用、启动及恢复相关测试全部通过，包含上述两项原生权限检查。
- 用真实 Interactive / Limited 临时任务确认脚本从 PermissionError 恢复为可读，`--check-startup` 退出 0。
- 新发布包内容基于线上 ZIP，只修改 `quick_install.py`、`seat_upgrade.py`、`seat_control.py`、`jira_intake.py`。保留线上文件集合和其他功能内容，安装器与 ZIP 中的 quick_install.py 保持一致。
- 发布仅更新静态客户端文件，平台与其他服务不重启，数据库不修改。公开下载摘要及服务健康已核验，详见同名 `-release.json`。

未重启或退出用户的 Windows 登录。登录触发器与实际后台启动已验证；真实重启登录仍可在用户下次正常使用时观察，不为验收中断桌面会话。

## 新发布版本现场验收

已用公开新安装器将该席位正常升级到 `0ade2712e5662edc`，新版本目录未做手工权限修复。升级退出 0，`harness doctor` 退出 0 且全部检查通过，升级记录已清理。任务在桌面 Session 1、Interactive / Limited 权限下持续运行，登录触发器启用。计划任务返回 267009（0x41301，任务正在运行），不是失败退出码。服务器收到新包摘要对应的心跳并报告 idle，所有检查通过。详细验收数据见同名 `-verification.json`。
