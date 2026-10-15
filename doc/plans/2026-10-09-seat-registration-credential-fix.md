# 席位登记检查误报修复

## 根因

接入桥 seats.verify_runtime 用网页凭证读取 Agent 的 adapterConfig。网站管理权限边界向普通网页身份隐藏机器登记字段，校验把缺失字段当作登记不一致。使用本席位独立凭证读取时，登记版本、运行环境、机器 ID、指纹及全部 runtime 字段实际匹配。

## 修复

在 verify_runtime 的完整 Agent 读取和登记端点校验中统一使用机器身份：Agent 运行模式使用已有 Agent API 客户端，后台桥使用 seat_api。seat_api 保留机器身份、凭证所属 Agent/组织和 0600 文件权限校验。没有放宽网页权限，也没有将内部字段公开。seat init 的网页读取属于尚未领取席位凭证时的管理员登记流程，保留；Jira 调度原本已经使用席位凭证。

本机接入桥已重启，诊断缓存刷新。网站桥下载 ZIP、manifest 和安装入口已更新；服务端不需要重启。其他已安装旧桥的电脑需要更新桥文件并重启自己的接入服务。

## 验证

修复前网页视图不含 runtime，独立席位凭证匹配全部登记字段；修复后本机 verify_runtime 和 inspect_configuration 通过。发布包 manifest SHA256 与 ZIP 一致，并检查 ZIP 内 seats.py 使用正确客户端。未新增或运行测试套件。线上席位最新心跳是最终告警解除证据。
