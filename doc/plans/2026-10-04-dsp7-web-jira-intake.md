# Paperclip 网页接入 Jira 工单

日期：2026-10-04
状态：页面与本机处理逻辑已部署；真实业务登记及开发端到端验收待执行。

## 使用步骤

1. 强制刷新 Paperclip。当前公司尚无 Project，先创建一个对应业务代码仓库的 Project。
2. 在 Project 的工作区配置 Mac 上业务 Git 仓库的绝对路径，以及基线分支（repoRef 或 defaultRef）。例如路径 /Users/leo/work/fingard/业务源码仓库，基线 develop；填写实际存在的值。不能把 base-harness 知识库作为业务源码仓库。
3. 回到 Project 页面，在“接入 Jira 工单”区域点击“接入工单”。
4. 输入未完成的 Jira 编码、Bug 或设计子工单号，选择工作区，并填写实际允许开工的 Jira 状态。
5. 点击“提交接入申请”。网页保存同一任务和当前用户的授权评论；本机桥通常按20秒监督周期处理。Mac离线时请求保留。
6. 登记成功后，页面显示“接入已完成，等待本地启动”，以及任务链接。无需执行 pilot.py register。
7. 核对无人并行处理同一工单，在 Mac 运行 harness start ATSES-XXXXX --confirm-no-other-executor。这是本地可见终端的启动步骤。

失败时，任务与页面显示原因。修复 Project配置后点击“重试接入”；若改了申请工单号／工作区／状态，提交新申请。已经创建的工作树不会盲目删除或覆盖；路径／基线变化需要人工核对旧计划。旧工单已登记时不重复登记，关闭的工单不重新开工。真实工单的工程确认继续使用 Jira，网页模拟审批不等于正式决策。

## 执行与关联

- Project 工作区：登记源仓库及基线。
- 编码／Bug单：桥创建 harness/ATSES-XXXXX 分支与独立工作树，保存源仓库、基线提交和目标路径，再调用 Harness worktree门禁。
- 设计单：使用指定仓库目录，不创建编码工作树；领域状态保存在 Harness tickets/design-ATSES-XXXXX。
- 登记结果：绑定网页创建的同一任务和Project，不另建一张开发任务，默认不启用、不分派、不自动开工。
- Claude：正式启动的 cwd 为登记路径；共享技能根目录仍为 /Users/leo/work/fingard/base-harness-infrastructure-dsp7。

## 本机设置与边界

当前部署启用 web_jira_intake_enabled，申请创建账号需在 paperclip_intake_user_ids 白名单中。首轮仅授权部署管理员账号。源仓库限制在 /Users/leo/work，自动工作树位于 ~/.config/paperclip-dsp7-bridge/worktrees/<仓库名-路径摘要>/<工单号>。配置位于受限 config.json。

任务创建来源、原创建用户的授权评论、公司、Project、工作区、Jira类型／负责人／状态都会校验；既有绑定不能覆盖。注册时保持现有单张启用工单限制。Project路径或基线变化会阻止后续启动／续传，避免静默换仓库。工作区 setupCommand/cleanupCommand 不作为接入命令执行。桥不自动 git fetch/pull，不修改主工作区源码、不写真实 Jira或Tracker；用户稍后的正式开发仍遵守原Harness门禁。

## 恢复与升级

申请及授权评论存于Paperclip，处理计划与登记存于本机SQLite及 intake/<taskId>.json。先落盘计划再创建工作树；中途失败重试只复用本申请拥有且仓库/分支吻合的工作树。完成注册但回写页面失败，可以从既有绑定继续回写；不同任务申请同一Jira不覆盖旧登记。

Paperclip改动仅增加Project页面组件，复用原任务/评论API与审计，无新增服务器数据库表或端口。桥新模块 jira_intake.py；SQLite新增本地intake_jobs。完整静态备份 /home/fg/paperclip/private/ui-before-jira-intake；旧哈希资源保留。升级需保留个人fork的UI改动及独立桥。关闭本机web_jira_intake_enabled后停止新接入，已有登记/证据保留。

## 检查结果

Python语法检查、UI类型检查和生产构建通过；现有服务和页面资源HTTP检查完成。本机空队列处理正常。未新增或运行测试，未代提交真实工单接入请求、未创建业务工作树、未启动真实业务开发。完整验收需要用户配置Project并提供未完成子工单。


## 2026-10-05 修订

共享 cwd 单机设计已由 [多席位接入](2026-10-05-dsp7-multi-seat-intake.md) 取代。使用 v2 定向申请、本机仓库映射和服务端中央 Jira 独占登记。
