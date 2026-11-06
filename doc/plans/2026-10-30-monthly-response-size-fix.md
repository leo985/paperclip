# 月度排期响应体上限修复

日期：2026-10-30。

## 问题与证据

用户截图的基础平台 2026-10 月度排期读取错误已在生产页面复现。
已部署的 null 叶子兼容补丁存在且摘要吻合，不能重复归因为 children: null。
只读调用当前产品客户端发现响应为 2,806,226 字节，无 Content-Length，含 62 个根条目、1663 个节点；结构深度为 2，未发现根标识或叶子容器异常。
实际失败点为统一 2,000,000 字节流式读取上限。
诊断只输出结构、数量及模块摘要，不记录凭据或完整业务报文。

## 改动

仅整月排期树 monthlyEntries 使用 8,000,000 字节上限。登录、单条需求、单条排期、分析、组织及月计划查询仍为 2,000,000 字节。
声明长度与实际流式字节都受限，超限取消正文；按 UTF-8 字节计数，不按字符数计数。既有树深、节点数、组织、身份冲突和完整性门禁保留。

## 验证

- qingzhou-client 与 delivery-monthly：14 项通过，包含超过旧上限的中文响应，以及带／不带声明长度的超限取消。
- delivery-connections 与 qingzhou-organizations：16 项通过。
- 服务端类型检查及构建通过。
- 候选模块在服务器内存中使用既有加密凭据只读验证，完整读取 62 个条目。验证前活动运行数为 0。
- 本次只发布 qingzhou-client.js；备份、旧摘要校验、活动运行门禁、原子替换及失败回滚均在发布脚本中。无数据库迁移和客户端更新。

日志：`/tmp/paperclip-monthly-size-audit-20261030.log`、`/tmp/paperclip-monthly-candidate-audit-20261030.log`、`/tmp/paperclip-monthly-size-regression-20261030.log`、`/tmp/paperclip-monthly-source-routes-20261030.log`、`/tmp/paperclip-monthly-size-typecheck-20261030.log`、`/tmp/paperclip-monthly-size-build-20261030.log`。发布及浏览器验收结果待收集。

## 发布过程记录

首次发布在重启后 45 秒健康窗口内未就绪，发布脚本恢复旧模块。原模块摘要恢复，平台随后 health ok；不能把首次发布算成功。服务启动超过该等待窗口，回滚后启动同样超过窗口。重试将健康等待窗口延长为 180 秒，仍保持失败回滚；首轮日志 `/tmp/paperclip-monthly-size-deploy-20261030.log`，重试日志 `/tmp/paperclip-monthly-size-deploy-retry-20261030.log`。

## 最终结果

重试发布 exit 0，健康检查 ok，安装模块摘要 c32fbece1557f576e0d1d537e13430edcc066bccba79c74242da0342b3e54870。基础平台 `/CMP/delivery` 页面真实读取 2026-10，显示 62 / 62 个条目、首屏 20 行、无 alert。浏览器截图采集超时，未将截图当作证据；随后直接读取页面 DOM 获得验收结果并结束任务空间。证据 `/tmp/paperclip-monthly-browser-proof-20261030.json`，发布记录 `2026-10-30-monthly-response-size-release.json`。

此修复只证明截图中的月度排期读取故障已恢复，不替代整体 P0/P1/P2 的 Windows、正式验收及恢复演练缺口。
