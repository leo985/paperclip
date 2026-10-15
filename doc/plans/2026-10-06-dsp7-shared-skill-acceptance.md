# Paperclip 公共技能与 Harness 工程技能联合加载验收

日期：2026-10-06

## 结论

当前已部署的原生 SSH 执行环境会把 Paperclip 管理的技能提示包传到 Mac，并将其路径通过 `--add-dir` 交给本地 Claude Code。同时，配置的 Harness 工程目录也通过 `--add-dir` 提供，其项目技能出现在同一 Claude 会话的技能清单中。

此前仅凭智能体 adapterConfig 中没有 executionTarget 判断通道能力是不充分的：真实 SSH 配置来自智能体 defaultEnvironmentId 指向的 Environment，运行时由服务端解析为执行目标。本次实际日志已验证技能文件传输。

## 验收对象与结果

- 公共技能：共享技能加载验收；slug `shared-skill-load-probe-20261006`。
- 技能 ID：`d8537cd9-0113-43e7-a8b6-94e768ad2297`。
- 独立临时智能体：`49691b9b-ce01-4631-afc7-cd3d4156a5f4`；使用现有 Leo Mac Claude 执行环境，验收后已暂停。
- 运行 ID：`49d02efd-d291-4b5b-a38d-293144f4ace1`。
- 在线记录：http://10.60.43.53:3100/DSP/agents/49691b9b-ce01-4631-afc7-cd3d4156a5f4/runs/49d02efd-d291-4b5b-a38d-293144f4ace1
- 运行时间：北京时间 12:23:56 至 12:24:51；状态 succeeded，exitCode 0。
- Claude Code 版本：2.1.206；此次初始化记录模型为 glm-5.3[1M]，这是 Claude Code 宿主的实际供应商模型标识，不应把 CLI 名称等同于底层模型。

| 检查 | 证据 | 结果 |
| --- | --- | --- |
| 服务器技能分配 | 临时智能体启用自定义组织技能 | 通过 |
| 文件传输 | 日志 `Syncing skills to ssh` 达 100% | 通过 |
| 本机副本 | 提示包内存在实际 SKILL.md 文件，非指向服务器的符号链接 | 通过 |
| 公共技能发现 | Claude init.skills 包含公共技能运行名 | 通过 |
| 公共技能调用 | Skill 工具调用成功，返回仅存在于技能正文的随机验收标记 | 通过 |
| Harness 技能发现 | 同一 init.skills 包含 jira-feature-dev、jira-bug-fix、jira-design-doc、jira-resume 等 | 通过 |
| Harness 技能读取 | Read 工具成功读取 jira-feature-dev/SKILL.md 前 35 行 | 通过 |
| 交互桥参数保留 | 对现有 interactive_args 做参数断言，两个 add-dir 和指令文件参数均保留 | 通过 |

公共技能实际运行名为 `shared-skill-load-probe-20261006--8b6db90b1c`，Paperclip 自动添加消歧后缀。调用时应使用实际运行名或技能清单，不应假设名称永远等于网页 slug。

本机公共技能文件 SHA256：`9aa292aaf31a53e6132080884a166fe06bad868fb350380a848a5cdaef6a1b23`。

## 证据范围与保留

本次是由 Paperclip 真正发起、通过实际 SSH 环境运行于 Mac 的独立只读 Claude 调用。模型工具记录仅有 Skill 和 Read；未执行 Bash、开发、Jira 操作或领域流程。没有启动正式/模拟 Jira 工单，没有修改原研发智能体配置，也没有重启服务。

没有额外运行可见终端的完整 Harness 工单；可见交互桥只验证了参数转换，不将其等同于交互端到端开发验收。也未验证技能修改后的会话更新、其他席位或全部技能资源类型。

演示技能和已暂停临时智能体保留，供网站查看记录。结构化证据保存在 Tracker 文档目录 `Paperclip公共技能加载验收证据-20261006.json`；服务器归档 `/home/fg/paperclip/docs/shared-skill-acceptance-20261006.json`。

## 推荐使用方式

公共协作技能维护在 Paperclip 组织技能库，为智能体选择启用；领域 SOP 与知识维护在 Harness Git 仓库。启用后下次运行通过现有 SSH 环境同步文件；同一 Claude 可发现两处技能。保留工程领域门禁，避免两处维护相同流程；运行时核对实际技能名称与版本。
