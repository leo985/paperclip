# 来源状态复选与静态发布完整性修复

月度条目、主子工单树、子工单安排三个来源状态筛选器改为复选下拉。勾选立即生效，菜单保持打开；未选择代表全部状态，点击「全部状态」清除选择。同类状态之间为 OR，其他筛选条件为 AND。

月度筛选使用重复 mStatus URL 参数，兼容旧单值链接；详情链接和返回保留所有状态。改变第二个及后续状态也会清空批量选择并重置页码。跨月未返回的已选状态保留，可单独取消，避免静默改变筛选范围。子工单安排选择已结束状态仍按原规则切换全部子单，不修改派单授权。

## 动态模块加载故障

Layout 模块自身返回 200，但其间接依赖的 dsp7-seats、dsp7-execution 两个哈希模块未被发布。旧临时打包脚本用 basename 的 dsp7- 前缀排除客户端分发文件，误排除了同前缀的 assets/ 前端模块。已补齐两个文件，不重启服务。

持久化修复：scripts/ui-static-release.mjs 提供完整 UI 静态资源清单与逐文件线上 SHA-256、JavaScript/CSS MIME 验证。仅排除根目录下四个确切的客户端安装包／脚本／manifest 名称，浏览器兼容脚本和所有 assets/ 模块始终纳入。

## 发布结果

已发布至 http://10.60.43.53:3100 ，UTC 标识 `20261026T055652Z`。本次更新 174 个静态文件，发布后完整核验 870 个静态资源，内容摘要和 JavaScript/CSS MIME 全部通过。浏览器实际导入新 Layout、新条目模块及用户报错的旧 Layout 均成功。

29 项 UI 回归、3 项发布规则测试、UI 类型检查、构建和 token gates 通过。浏览器使用隔离数据验证三个位置的多选、批量选择重置和窄屏布局；线上验证模块及帮助，未执行真实业务工单。

服务未重启，数据库与客户端包未改变。备份：`/home/fg/paperclip/private/entry-stages-backup-20261026T055652Z`。详见 [发布证据](2026-10-26-source-status-multiselect-release.json)。

```sh
node --test scripts/ui-static-release.test.mjs
node scripts/ui-static-release.mjs manifest ui/dist
node scripts/ui-static-release.mjs verify ui/dist http://10.60.43.53:3100
```

当前发布打包脚本已接入该清单，并在切换 index.html 前核对完整构建资源，而非只检查本次变更文件。保留旧哈希资源以兼容旧页面。补齐后旧 Layout 的浏览器实际 import 成功，完整原构建 870 个静态文件在线核验无缺失或内容不一致。
