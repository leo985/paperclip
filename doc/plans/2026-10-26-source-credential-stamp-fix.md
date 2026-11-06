# 来源配置变化误报修复

## 根因

组织列表、月度排期及条目同步在读取前后比较来源凭据快照，旧快照包括 company_secrets.updated_at。然而真实 secretService.resolveSecretValue 每次读取都会更新 last_resolved_at 和 updated_at，因此来源未变化也必然被误报为变化。此前接口测试的凭据替身未模拟读操作的这个写入副作用，未发现问题。

## 改动

版本快照改为凭据 ID、latestVersion、状态、删除标记、provider、externalRef、providerConfigId 和 lastRotatedAt，不使用访问时间或通用 updatedAt。连接 revision 的前后核验、组织权限与凭据有效性检查保留。修复统一覆盖组织查询、月度查询和条目核对／同步。

## 验证

- 更新凭据替身，在每次 resolve 时真实写入 lastResolvedAt 和 updatedAt。
- 月度与来源接口 18 项回归通过，包含重复读取组织／月度／条目、修改组织、凭据真正轮换／停用时仍拒绝落库。
- 服务端 TypeScript 编译通过。
- 在生产主机运行修复路由的仅本机临时 HTTP 验证服务，使用真实 secretService 与已保存凭据，连续两轮组织查询均返回 HTTP 200、42 个组织，月度查询均返回 HTTP 200、73 个条目。未更改组织配置或保存条目快照；临时模块验证后移除，凭据没有打印或落盘。

## 发布

仅替换来源路由模块，备份旧模块，检查无活动运行后重启平台服务。不更改数据库结构、UI、席位客户端及凭据内容；核验其他服务 PID 不变。发布结果见同日 source-credential-stamp-release.json。
