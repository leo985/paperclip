# DSP7 多席位网页接入（2026-10-05）

## 配置归属

| 层级 | 保存的信息 |
| --- | --- |
| 共享 Project/workspace | 仓库 URL、基线分支、项目说明；不依赖某位研发的本机 cwd |
| 执行席位（一个独立 Paperclip Agent） | 席位名称、机器 UUID、硬件身份摘要、允许发起接入的用户 |
| 本机接入桥 | Project/workspace → 本地仓库路径、工作树根目录、独立 Agent 凭证 |
| 工单 | Jira、Project/workspace、所选席位、实际运行和领域状态 |

“席位”在这里是执行电脑身份，不是 Paperclip 的许可证或计费席位。

## 已实现的接口和流程

1. 网页接入表单提交 v2 请求：`seat_id` 为所选 Agent UUID，另含 Jira、Project/workspace 和允许执行状态。原始请求由真实创建者评论授权。
2. 桥只处理属于自己席位的 v2 申请；未指定席位的 v1 请求和其他席位申请不产生执行动作。
3. 本地路径只从本机 `project_repositories` 获取，键为 `<project UUID>:<workspace UUID>`。校验 Git 根目录、路径白名单、origin、共享基线和 Jira 状态；不自动 fetch/pull。
4. 准备工作树前，以独立 Agent 凭证调用 `POST /api/issues/:id/dsp7-reservation`。服务端验证公司、席位、机器身份、创建人白名单和真实授权评论。
5. 服务端对 `company + Jira` 取得 PostgreSQL 事务 advisory lock，写入不可通过工单编辑修改的 `activity_log` 记录：`action=dsp7.jira.reserved`、`entityType=dsp7_jira_claim`、`entityId=Jira`。同任务、同席位、同机器、同原始申请可幂等重试；其他登记返回 409。该方案复用现有持久化表和索引，没有增加数据库迁移。
6. 编码/Bug 创建该电脑自己的工作树；设计任务使用本机映射的源仓库。绑定现有网页任务后，保持未开工，由所选电脑运行 `harness start`。
7. 任务设置 `assigneeAdapterOverrides.useProjectWorkspace=false`，使用原生 Agent 默认执行工作区，避免服务器根据共享 URL 克隆源码。真实 Claude 的 cwd 仍由本机桥从已登记目录确定。
8. 启动、运行 claim 和后续领域写入均校验中央归属；服务端 checkout 增加 v2 所选席位检查。原生 `checkoutRunId` 和本机 SQLite 租约继续锁定具体运行。

## 运维边界

- 每台电脑必须使用独立 Agent、机器身份、服务配置和反向 SSH 执行通道；服务器端的 Adapter 必须指向该电脑自己的通道。不得给两台电脑复制同一 Agent 配置。
- `harness seat init` 仅登记本机配置，并输出管理员所需的 `dsp7Seat` 配置。它不会扩大桥的服务账号权限。管理员在 Agent 配置中合并字段，并签发该 Agent 的独立 API key。
- Agent 凭证文件格式：`{companyId, agentId, token}`，权限 0600。安装凭证时使用 `harness seat init --name ... --credential-file /绝对路径/seat-credential.json`。不得把凭证放入共享仓库。
- 硬件摘要可防止正常使用时误复制配置，不替代凭证安全：掌握 Agent 凭证的调用者仍属于该 Agent 信任边界。
- `dsp7.jira.reserved` 记录必须永久保留。删除工单、结束运行、取消任务或席位离线均不释放 Jira 归属。本期没有自动接管、网页换席位或释放接口；迁移必须人工确认旧执行者已停止后实施管理员迁移，不允许直接删除记录来“解锁”。
- 模拟 replay 保持独立模式；旧正式命令行登记不能绕过席位校验，需迁移到 v2 网页接入。
- 网页显示已配置席位，不把 Agent idle 当作电脑在线状态。所选桥离线时申请保留，不路由给其他电脑。
- 首期每台桥仍只允许一张启用工单；不同席位可各自执行不同工单。

## 当前登记

- 席位：Leo 的 Mac，Agent `f38bb5a9-031c-4a4f-b58d-09272e47a966`。
- Project：DSP7 银企直联，`b4752dda-8cd7-45a7-9c3a-3bd7d11230d8`。
- 共享工作区：`983c3768-06ec-45c8-9162-665e2c2a6b04`，`cwd=null`，基线 `origin/develop-3.0`（origin 默认分支）。
- 当前电脑本地映射：`/Users/leo/work/fingard/dsp7.1_git`，没有创建真实工单工作树。

## 使用

```sh
harness seat info
harness repo bind --project b4752dda-8cd7-45a7-9c3a-3bd7d11230d8 \
  --workspace 983c3768-06ec-45c8-9162-665e2c2a6b04 \
  --path /Users/leo/work/fingard/dsp7.1_git
harness repo list
```

其他电脑绑定同一 Project/workspace，`--path` 填自己的仓库根目录。绑定后监督进程下轮轮询读取新映射；更改 Agent、公司或桥数据库等运行身份需重启桥。

网页进入该 Project → 接入工单 → 选择共享工作区、执行席位和允许执行状态。待“接入完成”后，在所选电脑执行：

```sh
harness start ATSES-XXXXX --confirm-no-other-executor
```

`--confirm-no-other-executor` 仍用来核对未纳入 Paperclip 的旧人工 Claude 会话；中央锁只管纳入新版接入的执行者。

## 检查范围

前后端 TypeScript 类型检查、网页生产构建、Python 语法检查和当前 Agent 凭证连通性检查通过。未运行测试套件，未提交真实 Jira 接入申请、未启动真实编码、未写 Jira/Tracker；两台真实电脑同时执行与重复领取的验收尚未进行。


## 部署记录

2026-10-05 已部署服务端席位 reservation/checkout 校验和网页表单，Paperclip 与 Tracker HTTP 200。本机命令已生效。修复旧进程检测误把提示词中的历史 run ID 当作活动会话的问题，改为匹配真实 Claude `--session-id`。已完成模拟 ATSES-493499 在确认无服务端活动运行、无准确匹配的本地会话后停用，保留历史记录并释放本机启用名额，没有终止任何进程。
