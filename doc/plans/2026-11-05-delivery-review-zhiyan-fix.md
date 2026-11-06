# 独立领域评审与返工的知言适配

日期：2026-11-05。平台服务端与桥接安装包已发布，研发和 QA 原生 Harness 已推送各自 main，知言 0.10.16 已发布公司私服。没有强制更新或重启各席位的运行中会话；席位仍须更新客户端并重新启动 Claude 加载。

## 实现

- 研发 Harness 新增 jira-design-review / design-review，QA Harness 新增 jira-testcase-review / testcase-review；真实评审子单独立计时、交付和上报，拒绝父单及工作单冒用评审身份。
- 评审通过须完成全部原生阶段，绑定当前 inputDigest 与 reviewWorkKeys。领域评审摘要在设备与服务端独立比对，旧版本不能复用。
- 按 issue_guard.execution_state_path 使用原生目录；兼容验证后迁移旧平台绑定。原生只读核验不更新时间，旧核验器仅身份元数据变化可接受，业务变化仍拒绝。
- 新增原生 delivery_rework.py：校验本次运行/工单/派发及平台退回上下文，归档旧状态，重开原生门禁；保留来源、代次、历史时间和 Token，撤销旧统计确认。旧活跃计时/人工决策未关闭、重置未结束或代次冲突均阻断。上次完成日期不能替代新一轮真实完成时间。
- 回读同时校验 Tracker 项目/工单、统计代次、当前已确认快照及度量值；缺快照、未确认、待重置或数据不一致不能完成交付。仅统计文件变化不能作为返工材料更新证据。
- 知言源码增加 design-review、testcase-review、testcase、manual 生命周期。旧插件不支持时省略新标签，保持真实项目/工单/Phase 归属；不伪装成其他既有类型。
- QA 保持 harness-report 及原 Tracker 复杂度枚举；研发使用 zhiyan_auto 的 report CLI。已有 execution_time 来源保留原生正式上报路径，不能改标为知言。

## 修改范围

Paperclip：integrations/dsp7-bridge/delivery_execution.py、harness_capabilities.py 及测试；server/src/services/delivery-workflows.ts 及测试；ui/public 安装 ZIP 与摘要已重建。

原生：同级 base-harness-infrastructure 和 qa-harness-infrastructure 中的身份/路径/计时/上报脚本、独立评审技能、原生协议与返工测试。知言：同级 zhiyan-plugin/scripts/workitems.py、tests/test_workitems.py、docs/workitems.md。

## 验证与限制

针对性验证覆盖：研发身份50、知言桥28、自动上报27、返工3；QA身份21、知言桥9、返工3、上报40；插件12；Paperclip设备交付24、能力登记9、路由2、目录ACL7（其中1项平台条件跳过）；服务端交付/返工/路由23。服务端 tsc --noEmit 通过。安装包44文件已重建。

未运行全仓 typecheck/test/build：本次按修改路径运行针对性验证；环境系统 Git/编译链存在 Xcode license 阻断，Node22低于仓库要求的24。未声明全仓 PR-ready 验证。未对真实业务 Jira/Tracker 写入，未进行线上席位端到端验收。

Agent 发现阻断问题时保持 changes_requested 并请求负责人决定退回，不能将问答回复当作正式人工审签。网页人工审核缺少真实开始/结束事件时不生成“人工实际耗时”。

## 上线顺序

部署 Paperclip 服务端与桥接安装包，同步两类原生 Harness，刷新席位能力登记并更新客户端；知言包发布后重启相关会话加载。旧包兼容路径可采集真实工单与阶段，但新增生命周期标签需要新版插件。原生仓库的任务同步恢复检查点不得作为本功能提交盲目推送。

## 发布核验

- 平台版本：20261105-delivery-review-zhiyan。修改3文件，保留当前 UI 入口 index-879d8187.js；服务健康 ok，systemd active，无数据库迁移，lostRunIds=[]。
- 线上安装 ZIP 基于线上44文件的包，仅替换 delivery_execution.py 和 harness_capabilities.py；SHA-256：9f3ad1a716abd42e72056dda2b72c2e01a63d5ae767490f811e56b98e6a63f71。已通过 HTTP 下载与 manifest 回读核对。
- 研发 main：241cebd30f101ba3b44876207be47e41d53dc21c。干净远端基线验证身份44、知言桥28、自动上报27、返工3通过，声明 design-review 能力。
- QA main：6cf21ca0aee7cdc96fcb133cc18fe2350aca33e6。验证身份21、知言桥9、返工3、上报40通过，声明 test-case-review。隔离验证同时发现并修复无本地计时的跨机交接不应要求知言 scope 的历史问题；不补造旧工时或改动统计代次。
- 知言私服 latest=0.10.16；下载包包含新生命周期，SHA-512 与 registry dist.integrity 相同；npm测试18通过、1项跳过。没有替换已运行 Claude 的插件缓存。
- 原生提交来自独立工作树，仅包含本次功能；原工作树的恢复 checkpoint 和无关业务材料没有推送。
- 服务器备份与结果：/home/fg/paperclip/private/delivery-review-zhiyan-20261105/{backup,result.json}。平台重启前再次检查无 running/queued/scheduled_retry。
