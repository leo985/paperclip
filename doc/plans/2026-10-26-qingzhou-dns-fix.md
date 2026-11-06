# 轻舟组织读取：生产 DNS 修复

日期：2026-10-26。服务器：10.60.43.53。

## 原因与证据

服务器常规域名解析间歇超时，影响轻舟登录网关和业务服务。不是登录表单格式或密码错误。IPv4 查询与指定已验证地址的请求均可成功；登录网关固定地址连接耗时约 4ms。仅修复业务域名后，组织读取成功但登录仍耗时约 10 秒，因此同时修复登录域名解析。

## 已实施配置

在 `/etc/hosts` 添加以下两条映射，保留原有条目；未修改全局 DNS、TLS 校验或防火墙，未重启服务：

```text
115.238.104.98 proj.fingard.com # Paperclip Qingzhou connection
10.60.44.214 gateway.proj-prod.avatar.fingard.cn # Paperclip Qingzhou login connection
```

每次修改前均检查同名映射冲突并备份：

- `/etc/hosts.paperclip-qingzhou-20261026T010235Z`
- `/etc/hosts.paperclip-qingzhou-gateway-20261026T010342Z`

## 真实验证

通过服务器已部署的 `readQingzhouOrganizations` 代码完成真实登录及研发、测试组织查询，连续三次均返回 42 个组织，耗时分别为 510ms、161ms、158ms。凭据仅用于内存中的验证，未写入文档、配置或日志；未输出访问令牌。

平台 `/api/health` 返回 `status=ok`。修改前后平台 MainPID 均为 3205883。无需重新构建应用或升级席位客户端。

## 后续维护与回滚

映射是当前 DNS 异常的定点绕过。轻舟服务地址发生变更时，应重新核实地址并更新映射，或在 DNS 修复后移除这两条专用映射。

回滚时优先仅删除本次添加的两条映射，保留其他 hosts 内容；如确认备份之后没有其他改动，也可使用备份恢复。
