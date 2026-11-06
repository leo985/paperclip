# Windows 席位无窗口启动兼容与诊断

## 现场证据

- 计划任务使用 `D:/Program Files/python314/pythonw.exe`，指向已安装版本 `dd68bcf9c10b57b2/watch_windows.py`。
- 计划任务最近退出码为 2；当时尚未生成 `watcher.log`。
- 使用同目录 `python.exe` 前台运行同一个 watcher 后，进程持续运行。服务器验证该席位状态为空闲，最近心跳距查询约 2 秒。
- 因此登记和服务器通信已成功，故障集中在无窗口启动路径。尚无该电脑无窗口启动的异常堆栈，不能将具体异常视为已确认。

## 改动

1. PowerShell 子进程显式使用 `stdin=DEVNULL`，避免在 `pythonw.exe` 下继承缺失或无效的控制台输入句柄。
2. watcher 在导入桥模块和设置 ACL 前打开诊断日志。仅记录启动阶段、异常类型和系统错误码，不记录任意异常文本或凭据；ACL 核验通过后才开始收集子进程输出。
3. 保留 Windows Job Object 和目录权限校验，启动失败不绕过保护。
4. 新增 `--check-startup`，仅检查启动依赖、目录权限和 Job Object，不启动接单进程。

## 验证

- 本机完整桥测试：108 项，107 项通过，1 项 Windows 原生测试因平台不符跳过。
- 按线上原始 ZIP 制作补丁，仅替换 `platform_support.py`、`watch_windows.py`，其余文件内容及文件集合保持一致；安装器不变。
- 发布包对应测试：99 项，98 项通过，1 项 Windows 原生测试跳过。另一个源码测试文件 `test_delivery_execution.py` 依赖尚未包含于线上基线的模块，未加入此次发布包测试范围；没有为此夹带该功能。
- 发布包全部 Python 文件通过语法编译。
- Windows 无窗口真实启动及登录自启仍需在现场升级后验证；macOS 测试不等同 Windows 验收。

## 更新现有席位

已有席位完成运行环境登记后，重跑普通接入命令会复用旧客户端，应明确执行升级。

若临时前台 watcher 正在运行且没有任务执行，先在其窗口按 `Ctrl+C`，等待回到 PowerShell 提示符，再执行：

```powershell
& "$env:LOCALAPPDATA/ZhiyanSeat/bin/harness.cmd" upgrade
& "$env:LOCALAPPDATA/ZhiyanSeat/bin/harness.cmd" doctor
```

升级沿用原席位身份，保留配置，空闲状态下切换计划任务，不需要新邀请码。若仍失败，查看 `~/.config/paperclip-dsp7-bridge/watcher.log` 中的 `watcherStage` / `failedStage`；不要删除配置或重复创建席位。

## 发布

仅更新服务器静态客户端 ZIP 与对应摘要，不重启平台或其他服务，不修改数据库。线上校验结果见同名 `-release.json`。
