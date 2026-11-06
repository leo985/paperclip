# 席位升级时 Harness 同级依赖加载修复

## 原因与修改

升级器通过 importlib 文件路径加载 jira_confirmation.py，但没有将 Harness scripts 目录加入模块搜索路径。新增的 execution_time 同级依赖因此报 ModuleNotFoundError；文件本身不缺失。

pilot.load_module 在执行模块期间临时添加模块所属目录，并在成功或异常后恢复 sys.path；失败时清理未完成的模块。首次接入读取本机 Jira 配置也复用同一加载器。

## 发布

2026-10-21 已发布最小修复到 http://10.60.43.53:3100/。以线上已有安装包为基线，仅修改 pilot.py 和 quick_install.py，未包含本地尚未发布的简化生命周期命令。更新安装器、ZIP、校验清单，无数据库变更，无服务重启。

备份：`/home/fg/paperclip/private/import-fix-20261021T072017Z`。

线上 ZIP SHA256：`d610ba7ec784e22e196b7610272905d6ef4625edda150eda172546e41404c0e7`。

完成 Python 编译检查、差异空白检查及线上三份文件哈希核对。未操作本机席位服务或 Claude 会话，未运行自动化测试；用户需重新执行原升级命令完成实际升级。
