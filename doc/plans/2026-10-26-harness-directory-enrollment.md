# Harness 目录选择接入向导

日期：2026-10-26。

网页席位详情的设备与诊断、本机 Harness 能力，以及创建分析任务表单，提供免填路径引导。网页选择分析（DSP）、研发或测试用途后生成命令。普通浏览器不取得绝对路径；命令在对应电脑打开系统目录选择框，选择后经既有 Git、技能、profile 和必要文件校验，原有机器身份及空闲门禁通过后保存登记。此登记不是执行授权。

命令示例：`harness capability register --kind analysis --profile dsp --choose --seat-id <席位UUID>`。测试使用 `--kind qa`，研发使用 `--kind development`，二者不强制分析 profile。`--path` 保持兼容并与 `--choose` 互斥。网页命令绑定席位身份，在错误电脑上运行会在选目录前拒绝。

取消不登记、验证失败不登记，路径经参数和 JSON 传递，不写入待执行 shell 命令。网页提供复制失败后的手动复制提示，变更席位或用途后使旧命令失效；分析表单可刷新席位登记而无需刷新整页。

本机原生目录框：macOS 使用 osascript 标准目录选择框；Windows 使用 PowerShell STA 与 WinForms，静态脚本以 UTF-16LE Base64 参数传入，目录输出采用 UTF-8；Linux 优先 zenity/kdialog，回退 tkinter。无图形桌面时使用原有 --path。

同一席位可登记多个领域，不强制分角色。测试 Harness 只在需要承接测试时登记，登记本身不表示 QA 自动执行已开放。

## 验证

18 项相关 Python 回归通过，覆盖目录路径、macOS 和 Windows 参数构造、取消、身份不符和校验失败不登记。真实分析套件与 QA 套件通过 inspect 文件校验，未改本机席位配置或执行登记。macOS AppleScript 编译通过；Windows/Linux 原生弹框仅做参数和取消分支测试，尚未实机验收。

Microsoft Edge 真实浏览器验证：表单中的向导不误提交任务、未选席位禁用生成、分析命令与 QA 命令准确、切换用途清除旧命令、复制反馈、刷新保留表单、移动宽度无横向溢出，且无页面脚本错误。UI 类型检查、生产构建、token gates 通过。

证据位于 `/tmp/zhiyan-delivery-ux/enroll-edge-results.json` 和 `enroll-guide-edge.png`。

## 发布

已发布至 http://10.60.43.53:3100 ，176 个文件校验通过；线上健康、向导脚本、安装包摘要与包内容、帮助页均核验通过。备份目录：`/home/fg/paperclip/private/harness-directory-backup-20261025T165040Z`。详见 [发布回执](2026-10-26-harness-directory-release.json)。本次仅更新 UI、在线帮助和客户端分发包，不修改数据库或重启平台。已有席位须通过网页更新客户端后使用 --choose，不强制更新或重建席位。
