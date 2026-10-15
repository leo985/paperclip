# DSP7 中文在线帮助中心

## 入口与用途

- 网站侧栏和账号菜单：帮助中心（组织内 `/help?section=start`）。
- 公共完整手册：http://10.60.43.53:3100/help.html，无需登录，可搜索、按目录跳转、打印或保存 PDF。
- 登录页：查看网站使用帮助。

帮助包含 21 个主题，覆盖快速入门、概览、任务、项目、Jira 接入、席位、本地终端、决策、运行、收件箱、审批、费用、智能体、技能、自动化、交付物、连接、设置、排障及能力边界。每节列出用途、适用场景和操作方法。

重点解释 Jira / Paperclip / Harness / Tracker 分工；Project 长期复用与各电脑路径映射；登记不等于启动；模拟 JCONF 与正式 Jira 确认的区别；离线与取消不等于本地进程停止；自动化、外部提醒和用量统计的当前边界。

## 实现与维护

- 内容唯一来源：`ui/src/content/dsp7-help.json`，使用 Markdown 编写正文。
- 应用内页面：`ui/src/pages/Help.tsx`，复用 MarkdownBody；主题由 URL 查询参数保存，支持全文关键词筛选。
- 公共手册：`ui/scripts/build-help.mjs` 使用 React Markdown 服务端渲染静态 HTML，生成 `ui/public/help.html`、`help.css`、`help.js`。
- UI build 和 build:preview 在 Vite 构建前自动生成公共手册。修改内容后运行 `pnpm --filter @paperclipai/ui build` 即同步两种入口。
- 公共页面只含使用说明，不读取业务 API，不含凭证或私有配置。新增内容同样应避免写入敏感信息。

## 发布与检查

只替换 UI 资源，保留历史散列 assets，并最后原子替换 index.html。备份目录写入发布记录。无数据库变更，无服务重启。

执行 UI TypeScript 检查、生产构建、静态脚本语法检查及部署 HTTP 检查；未运行测试套件。当前浏览器自动化不可用，尚未进行浏览器交互和视觉验收。

### 本次发布记录

- 已部署至 http://10.60.43.53:3100/help.html。
- 回滚备份：`/home/fg/paperclip/private/ui-before-help-20261005-151702`。
- 已通过 UI TypeScript 检查、生产构建、静态脚本语法检查和 diff 空白检查。
- 公共帮助 HTML/JS/CSS、SPA 帮助路径、当前主 JS、Paperclip 首页及健康接口、Tracker 首页均返回 HTTP 200。公共页面确认包含 21 节内容。
- 未运行测试套件；尚未进行浏览器交互和视觉验收。
