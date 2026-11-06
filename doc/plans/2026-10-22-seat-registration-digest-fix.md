# SSH 席位迁移后的登记摘要误报修复

## 现象与原因

席位在线，但显示“配置异常 / 需要处理 · 请检查设备”。Claude 可执行文件、设置 JSON、Harness CLI 均通过检查；本机读取服务端登记接口返回 409。

迁移 prepare/finish 将完整环境数据库行传入 executorDigest，摘要因此包含环境 ID、名称、时间等额外字段；日常登记校验只对 driver/config/envVars 计算摘要，二者必然不一致。这是平台校验逻辑缺陷，不是本机模型密钥或 Harness 文件缺失。

## 修改

- 新迁移 prepare 统一使用 driver/config/envVars 计算摘要。
- finish/rollback 兼容此前已 prepared 迁移的旧摘要；只有当前环境与旧摘要仍完全匹配才允许继续，完成时归一为标准摘要。
- 不放宽身份、环境可用性、登记版本或活动运行门禁。

## 当前席位恢复

对 Leo 的原 Mac 席位执行已有 seat register 流程，保留身份与配置，登记版本由 2 更新为 3。随后最新心跳为 idle，failed checks 为空。未启动工单或模型任务。

完成服务端 TypeScript 编译与差异空白检查。未添加或运行自动化测试。

已发布到线上，批次 `20261022T004714Z`，仅更新服务端席位路由模块。发布后健康接口正常，文件哈希匹配，其他用户服务 PID 未变化，无数据库迁移。备份：`/home/fg/paperclip/private/seat-digest-backup-20261022T004714Z`。
