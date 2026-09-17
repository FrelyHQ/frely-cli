---
title: Wallet access through the unified MCP entry
mdq:
  profile: project-governance/governed-document-v1
---

# 统一 MCP 入口的钱包消费规划

## CLI-MCP-WALLET-001 — 已接受的用户目标

Status: Accepted; implementation pending
Source: 用户在 2026-09-17 的 Network MCP 迁移讨论
Review level: L3

Web3 消费者无需注册或登录 Frely 账户，无需 Frely API key、Credit 或设备远程执行授权，即可通过 frely-cli 使用已接入且具备有效钱包付款授权的能力。

命令按用户动作组织。通过统一 frely mcp 入口选择连接并按其认证方式接入，不为相同动作再拆出 Web2/Frely 与 Web3/Network 命名空间，也不新增 frely network mcp stdio 作为主要入口。现有 frely network 命令可以保留兼容并复用相同调用核心。

Network 正在评估替换 Hedera。不能把旧 MCP 的 Hedera SDK、测试网限制和本地私钥文件流程原样作为 CLI 的默认钱包接入方案；目标链、钱包渠道、支付协议及 SDK 发布方式尚未确定。

权威问题记录、产品约束和待审查方案见相邻 Network 仓库的 [统一 CLI MCP 与仅凭钱包消费](../../frely-network/docs/plans/unified-cli-wallet-access-20260917.md)。

## CLI-MCP-WALLET-002 — 当前代码缺口与改造边界

Status: Open
Source: main ff1123d；src/index.ts、src/mcp-authorization.ts、src/mcp-command.ts、src/network.ts

当前设备 MCP setup/stdio 路径使用 requireMcpAuthorization 或 setupMcpAuthorization，最终要求 requireLogin。它是设备授权边界，不能直接变成所有 MCP 能力的全局登录前置条件。runNetwork 的独立路径不要求 Frely 登录，但只接受 platform_demo，不能作为用户钱包实际付费的完成证据。

推荐先解析所选连接/能力，再由各模块执行自己的授权。保持现有设备执行的账户、工作区与权限检查，以及既有调用兼容性。新增钱包能力须能独立启动；不因 Frely 未登录而被阻断，也不因设备服务已授权就自动挂载付款工具。

本地 stdio 钱包调用不依赖 Frely 设备 Relay。网页端若需远程 MCP，必须有支持钱包权限的服务接入方案；现有 Frely 账户 OAuth 设备 URL 不能被宣称为免账户入口。

钱包连接不等于付款授权。浏览器完成的钱包配对不得索取主钱包私钥。持续自动消费必须由实际支付机制执行授权范围、限额、期限及撤销；普通连接会话或登录 token 不承担资金授权。

## CLI-MCP-WALLET-003 — 后续实施与验收

Status: Proposed; not implemented
Source: CLI-MCP-WALLET-001、CLI-MCP-WALLET-002；Network 权威记录
Review level: L3

统一 MCP 入口与调用核心可以先设计；目标渠道确定后再接入相应钱包和支付适配器，并同步完成服务端验款和认证结果查询。不要为即将替换的 Hedera 流程先投入完整 CLI 跨平台迁移。

所有新功能需验证：无 Frely 凭据环境下完成钱包消费、设备权限保持有效、两类能力独立启动、请求幂等与重启恢复、并发额度控制、查询权限，以及 npm/独立二进制实际安装运行。

本次只新增规划及 README 链接。没有更改运行代码、发布版本、远程服务或钱包状态，也没有选择或启用新的支付渠道。文档验证不代表上述功能验收。
