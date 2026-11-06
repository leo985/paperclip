# Jira 经办人与执行席位解耦

日期：2026-10-27。用户要求：取消 Jira 经办人与执行席位不一致的校验。

## 行为

- Jira 经办人保留为来源责任信息及 Jira 在手工单统计账号，不再限制网页选择执行席位。
- 网页接入预览、来源同步、主子工单准备、旧运行授权、本机接入和续传均取消经办人一致性校验。
- Jira 改派不再单独导致停止执行或要求重新登记。
- 同一个 Jira 统计账号、项目可配置多个席位，实际执行者由平台授权派单确定。
- 保留席位负责人及操作权限、平台派单授权、项目与仓库映射、工单类型、允许开工状态、需求/附件指纹、完成状态和单执行器门禁。原有的初次接入须指定 Jira 经办人检查仍然保留。
- 旧经办人错误仅在其余校验通过后清除，不自动恢复阻塞任务，不重新启动 Claude。

## 修改范围

服务端：`jira-intake-sync.ts`、`dsp7-jira-dispatch.ts`、`jira-requirements.ts`。
客户端：`jira_intake.py`、`jira_dispatch.py`、`pilot.py`。
相关派单、接单、组织设置和帮助文案已同步。

## 验证

- Python：运行 133 项测试，2 项跳过，其余通过。
- 定向 Vitest：4 文件、48 项全部通过，覆盖跨经办人接入与保留其他门禁。
- 服务端编译、UI 类型检查、UI 构建及 token gates 检查通过。
- 线上健康检查、入口页面、客户端包和 manifest 均为 HTTP 200；发布文件 177 个逐一核验，旧 hash 资源保留。
- 无数据库结构变更，仅重启 paperclip 服务；其他用户服务 PID 未变。
- 张志林 Windows 席位已执行 `harness upgrade`、`harness online`、`harness doctor`，均成功。
- 服务端心跳已确认新版 `779e3cafd8bd6f9fb6c3e9a42c0835718a89c9f5313e5f99055fa358b89cb010`，状态 idle。
- 真实 `ATSES-513404` 的 Jira 经办人 `chenjj1708`，席位统计账号 `zhangzl`：`Bridge.validate_jira` 通过，旧经办人 last_error 清除。未启动执行。

## 发布和更新

线上地址：http://10.60.43.53:3100 。
服务端备份：`/home/fg/paperclip/private/assignee-policy-backup-20261026T181431Z`。
详细发布回执见同目录 `2026-10-27-jira-assignee-independent-dispatch-release.json`。

其他已有席位需在空闲时运行 `harness upgrade`，解除其本机旧版本的经办人校验。已登记的席位身份、负责人、Jira 和仓库配置保留。

## 独立遗留问题

`ATSES-513404 / ATS-1` 仍为 blocked，来自此前执行中断后的恢复状态衔接缺口。本次未改动该恢复门禁，未自动重启任务。取消经办人限制不能单独解决该恢复阻塞。
