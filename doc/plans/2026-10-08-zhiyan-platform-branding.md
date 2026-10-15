# 网站名称更新：智研协同平台

日期：2026-10-08

## 修改范围

- 登录页标识使用中文产品名，保留图形标记。
- 浏览器标题（含导航后的页面标题）、Apple 安装标题和 Web Manifest 名称更新。
- 中文界面中的平台名称、席位配置提示、浏览器阻塞通知和在线帮助更新。
- 保留内部包名、接口、命令、配置键和上游服务专名。

## 验证与发布状态

UI TypeScript 检查通过；生产构建通过。未运行测试套件。
首次发布连接被网络权限拦截；权限启用后已于 2026-10-08 发布到线上。
发布过程仅更新前端静态文件，保留旧 assets，并最后原子替换 index.html；未重启后端。
服务器备份：`/home/fg/paperclip/private/zhiyan-ui-backup-20261008-065838`。
发布状态：`/home/fg/paperclip/private/zhiyan-branding-release-state.json`。
服务器本地及本机访问核验：/auth、/DSP/dashboard、/site.webmanifest、/help.html、/api/health 均为 HTTP 200。
HTML、Manifest、帮助页以及新版入口 JS 已确认包含“智研协同平台”。未进行登录后的交互验收。

发布包：`/Users/leo/Downloads/zhiyan-ui-20261008.tar.gz`
SHA256：`1ccae7c71a297e2115a841d2b3b4754c3a2d82dd6e8bdcf958b5a745a65df2c2`

## 发布操作记录

已上传发布包。目标 UI 目录为
`/home/fg/paperclip/runtime/node_modules/@paperclipai/server/ui-dist`。
先备份目标目录，解压到暂存目录，保留已有 assets，复制新静态资源，最后原子替换 index.html。
此变更仅涉及前端静态文件，无需重启后端。
发布后检查 /auth、导航后页面标题、/site.webmanifest、/help.html 和 /api/health。
