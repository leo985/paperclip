# 帮助中心阅读布局优化

## 站内帮助

- 目录宽度由正文区域的 25% 改为共享样式 token 控制的 208px。
- 按帮助正文区域的可用宽度切换布局，避免网站主导航存在时继续压缩正文：不足 56rem 时采用“浏览主题”抽屉。
- 只展开当前主题分类；搜索时展开匹配分类，并显示匹配数量。窄屏顶部搜索有独立结果区域。
- 搜索移到页面顶部；选择主题后清除筛选、回到正文顶部，抽屉关闭后的焦点进入正文。
- 增加“收起目录 / 展开目录”，使用 localStorage 记忆偏好；搜索临时展开不会覆盖偏好。
- 当前主题有浅色背景与左侧标记；目录独立滚动，保留分类数量和标题换行。
- 普通说明限制为 72ch，流程图、代码与宽表格使用完整正文宽度。
- 流程图默认适应宽度，提供“放大阅读 / 适应宽度”和原图入口。

## 完整手册

公开手册采用同样的窄目录、分类折叠、顶部搜索、目录偏好、当前章节标记与图表放大。窄屏使用原生 dialog，支持关闭按钮、Escape 和焦点处理。
CSS/JS 地址携带内容版本号，避免旧样式缓存；打印继续包含全部章节并隐藏目录与操作按钮。
样式与脚本从生成器拆分到 ui/scripts/help-manual.css 和 help-manual.js，生成器只负责安全渲染内容与写入公开资源。

## 检查

UI TypeScript、静态脚本语法检查、生产构建和中文文案扫描通过，未运行测试套件。
使用独立无头 Chrome 对线上公开手册进行桌面、目录收起、手机、抽屉与搜索截图检查：桌面目录实测 208px；抽屉可打开；未发现页面脚本错误。
截图位于 /tmp/help-reader-desktop.png、/tmp/help-reader-desktop-focused.png、/tmp/help-reader-mobile.png、/tmp/help-reader-mobile-directory.png、/tmp/help-reader-mobile-search.png。
站内 Help 的登录后交互尚未进行浏览器验收，公开手册截图不代表该验收已完成。

## 发布

2026-10-09 13:57 发布至 http://10.60.43.53:3100/，后端未重启，账号和工单数据未改动。
备份：/home/fg/paperclip/private/help-reader-backup-20261009-055646。
发布状态：/home/fg/paperclip/private/help-reader-release-state.json。
最终 UI 包 SHA256：ef536e8b72254ec91d16177c0fbd726331fe2dcb966a10ab2d982a4057cc7896。

线上健康状态为 ok；站内帮助入口返回 200，页面 JS/CSS 与完整手册 HTML/CSS/JS、流程图共 54 个资源的 SHA256 与最终本机构建一致。
