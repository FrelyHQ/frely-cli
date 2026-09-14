# 两层授权修订记录

日期：2026-09-14。

CLI 与 Relay 使用分支 `T-feat-two-tier-auth-20260914`。原始工作树保持原状；CLI 工作树包含上一轮 keytar 移除补丁，不包含原目录中与本任务无关的 Network 改动。

## 实现

基础层使用受限 OAuth 客户端 `frely-cli-basic` 与私有会话文件。MCP 采用独立密钥、浏览器批准和服务端授权记录。期限默认 180 天，上限 360 天；刷新、重启与重复批准不延期。续期轮换 MCP URL，撤销保留 Provider 设备与服务。

独立程序、macOS/Linux 安装脚本、Windows 安装脚本、Windows 用户级服务适配器和三平台 CI 已加入源码。安装器不安装 Node.js/npm，不配置基础层密钥，不提升权限。MCP 存储检查属于启用流程。

Relay 配套新增 Web 授权页面、控制 API、授权数据库表、运行期校验、请求授权 ID、到期与撤销通知。基础 bearer 的 Web 与 Owner 操作通过显式权限边界限制。

## 验证证据

| 范围 | 结果 |
| --- | --- |
| CLI TypeScript 与构建 | 通过 |
| CLI 测试 | 76 项通过，0 失败，0 跳过 |
| macOS Keychain 凭证往返、迁移与跨进程读取 | 通过；测试记录使用隔离命名空间 |
| npm 打包后安装、禁用生命周期脚本 | 通过；安装位置为临时前缀 |
| macOS ARM64 独立程序 | 通过；PATH 为空，MCP 存储配置无效，基础功能可用 |
| macOS 离线安装器 | 通过；路径含空格，错误 checksum 不替换现有程序 |
| Linux ARM64 独立程序 | 通过基础诊断；临时容器无网络、PATH 为空、无桌面凭证服务 |
| Relay 领域、协议、数据面与授权边界测试 | 17 项通过 |
| Relay Web、Backend、Device Relay、运行服务、DB Ops 类型检查 | 通过 |
| PostgreSQL 迁移与授权约束 | 通过；使用本地临时 Docker 数据库，验证后清理 |
| UI 边界、操作注册表、数据分类、Identity/Tenancy 边界、测试编写规则 | 通过 |
| 两个工作树 git diff --check | 通过 |

测试输出保存在对应工作树的 `.local/two-tier-auth/`，不进入提交。

## 未通过与未执行

Relay 的全仓 `verify:static` 被既有 Collection 审计失败阻断：`apps/web/pages/api/user/[[...path]]/route.ts` 的聚合 GET 使用 `listProviders`。原始 Relay 工作树可以复现该失败。本任务未修改该读取实现，未绕过静态门禁。

Windows 原生安装、凭证和计划任务尚未实机验收。Linux Secret Service 原生存储、macOS/Windows 发布签名，以及浏览器实际批准到远程工具调用的端到端验收尚未完成。适配器测试与类型检查不能替代这些证据。

独立程序为本地验证产物。未执行代码推送、版本发布、公开 release 上传、业务数据库迁移或全局 CLI 替换。

## 应用约束

发布需要协调数据库迁移、Web、Device Relay 与 CLI。旧 MCP URL 不获得默认授权，旧 Cookie 不迁入基础文件；用户需要登录并批准新 MCP 授权。旧 Provider 绑定可能需要重建。

MCP 授权到期不是副作用回滚，也不是 Shell 沙箱。任意程序脱离受管进程集合后的副作用不属于停止保证。

产品规则、配置与迁移限制见 [credential-storage.md](credential-storage.md)；命令流程见 [chatgpt-mcp.md](chatgpt-mcp.md)。
