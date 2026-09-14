# MCP OAuth Relay Contract

状态：Frely Relay 配套实现契约，目标 MCP 规范版本 `2026-07-28`。

## 1. 目标

MCP endpoint 使用设备绑定的稳定地址：

```text
https://app.frely.cloud/mcp/<device-id>
```

地址不包含凭证。远程客户端通过 OAuth 访问该 resource。MCP 本机执行授权保留 90 天默认期限和 180 天上限。

OAuth connection 与 MCP execution authorization 分离：

```text
OAuth client authorization
AND
MCP execution authorization
AND
Device Relay connection
=
MCP execution
```

OAuth token refresh 不修改 MCP execution authorization 的 `approvedAt`、`expiresAt`、`workspace`、`keyThumbprint` 或授权 ID。

## 2. MCP execution authorization request v2

CLI 使用 Ed25519 MCP 执行密钥签名批准请求。

签名消息：

```json
[
  "frely.mcp.request.v2",
  "<device-id>",
  "<key-thumbprint>",
  90,
  "/approved/workspace",
  "<issued-at>",
  "<nonce>"
]
```

控制 API 请求体：

```json
{
  "action": "request",
  "deviceId": "drd_...",
  "publicKeySpki": "...",
  "keyThumbprint": "...",
  "days": 90,
  "workspace": "/approved/workspace",
  "issuedAt": "...",
  "nonce": "...",
  "signature": "..."
}
```

请求体不得包含 `mcpTokenHash`、MCP URL bearer secret 或私钥。

Relay 校验：

- `deviceId` 归属当前账号；
- `keyThumbprint` 与 `publicKeySpki` 一致；
- Ed25519 signature 有效；
- `issuedAt` 与 nonce 满足重放保护；
- `days` 范围为 `1..180`；
- workspace 与批准页面展示值一致。

续期创建新的 execution authorization 和新的 MCP execution key。设备 ID 不变，MCP URL 不变。

## 3. Protected Resource Metadata

MCP resource：

```text
https://app.frely.cloud/mcp/drd_xxx
```

RFC 9728 metadata endpoint：

```text
https://app.frely.cloud/.well-known/oauth-protected-resource/mcp/drd_xxx
```

响应：

```json
{
  "resource": "https://app.frely.cloud/mcp/drd_xxx",
  "authorization_servers": [
    "https://app.frely.cloud"
  ],
  "scopes_supported": [
    "mcp:invoke"
  ]
}
```

未携带 access token 的 MCP 请求返回：

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://app.frely.cloud/.well-known/oauth-protected-resource/mcp/drd_xxx"
```

错误响应不得把 device execution authorization 误报为 OAuth 登录状态。

## 4. Authorization Server Metadata

Endpoint：

```text
https://app.frely.cloud/.well-known/oauth-authorization-server
```

最低 metadata：

```json
{
  "issuer": "https://app.frely.cloud",
  "authorization_endpoint": "https://app.frely.cloud/api/auth/oauth2/authorize",
  "token_endpoint": "https://app.frely.cloud/api/auth/oauth2/token",
  "revocation_endpoint": "https://app.frely.cloud/api/auth/oauth2/revoke",
  "registration_endpoint": "https://app.frely.cloud/api/auth/oauth2/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["mcp:invoke", "offline_access"],
  "authorization_response_iss_parameter_supported": true,
  "client_id_metadata_document_supported": true
}
```

CIMD 是客户端注册主路径。DCR 是兼容路径。DCR client 记录绑定 issuer。

CIMD 获取需要 URL 校验、DNS/IP 边界、超时、响应大小上限、redirect 限制和内容类型校验，避免 SSRF。

## 5. Authorization Code + PKCE

授权请求要求：

- `response_type=code`；
- `code_challenge_method=S256`；
- `resource=https://app.frely.cloud/mcp/<device-id>`；
- `scope` 包含 `mcp:invoke`；
- `offline_access` 用于 refresh token；
- `state` 原样返回；
- 成功响应包含 RFC 9207 `iss`。

Authorization code 属性：

```text
clientId
userId
deviceId
redirectUri
resource
scope
codeChallenge
expiresAt
consumedAt
```

Code 采用单次使用，建议 TTL 5 分钟。数据库保存 code hash。

Token endpoint 校验 `redirect_uri`、PKCE verifier、client binding、resource binding、code 状态和 issuer binding。

## 6. Access Token

MCP 客户端接收 opaque bearer token：

```text
fmcp_at_<32-byte-random-base64url>
```

TTL 为 10 分钟。Relay 不向 MCP 客户端返回内部 JWT。数据库保存 SHA-256 token hash。

数据结构：

```text
McpOAuthAccessToken
-------------------
id
tokenHash
connectionId
expiresAt
createdAt

McpOAuthConnection
------------------
id
userId
clientId
resource
authorizedAt
revokedAt
createdAt
updatedAt
```

MCP ingress 校验：

- `fmcp_at_` token 格式；
- token hash 存在；
- token 未过期；
- connection 未撤销；
- connection `resource` 与 MCP URL 相等；
- connection `userId` 对应启用账号；
- URL device ID 属于 connection 用户；
- 当前 MCP execution authorization 处于 active 状态。

`mcp:invoke` scope 在授权码和 refresh token 发放阶段实施。CLI 基础 access token 不进入 MCP opaque token 表，不能访问 MCP resource。设备 A 的 token 不能访问设备 B。

## 7. Refresh Token

Refresh token 使用 Better Auth OAuth Provider 的 opaque token 与 rotation 机制。Relay 不在 MCP URL 或 MCP CLI 存储中保存 refresh token。

一次 refresh exchange 产生：

```text
new opaque MCP access token
+
new OAuth refresh token
```

旧 refresh token 重放触发 Better Auth refresh-family revocation。Frely 同步撤销对应 `McpOAuthConnection`，该 connection 的 `fmcp_at_*` token失效。

Refresh token 绑定 OAuth connection，不绑定 MCP execution authorization ID。MCP renew 不要求 OAuth 重连。

## 8. OAuth connection

一个 `(userId, clientId, resource)` 对应一个 MCP OAuth connection。一个设备可拥有多个 client connection。

Authorization Code 成功时创建或重新激活 connection。Refresh 只在 connection 未撤销时签发新的 MCP opaque access token。OAuth revoke 删除该 connection 的有效 access token并标记 connection revoked。对应 consent 删除。后续连接需要新的授权流程。

单个 connection revoke 不影响其他 connection，不影响 MCP execution authorization。

## 9. MCP execution authorization check

OAuth 验证通过后，Relay 查询该设备的当前 MCP execution authorization。

要求：

- status 为 `active`；
- `expiresAt` 大于当前时间；
- authorization 属于 OAuth token 的 `userId` 和 `deviceId`；
- Device Relay 连接提供匹配 authorization ID 与 MCP key proof。

MCP execution authorization 过期时，不返回 OAuth `401`。返回 MCP 应用层错误：

```text
FRELY_MCP_AUTHORIZATION_EXPIRED
```

用户恢复路径：

```sh
frely mcp renew
```

完成批准后，客户端保留原 MCP URL 和 OAuth connection。

OAuth token 无效、过期、撤销、scope 错误或 resource 错误使用 HTTP `401`/`403` 语义。

## 10. Revocation semantics

`frely mcp revoke`：

- 撤销 MCP execution authorization；
- 不撤销 Provider device；
- 不删除 OAuth connection；
- 不把 OAuth connection 当作本机执行权限。

OAuth client disconnect：

- 撤销指定 OAuth connection；
- 撤销该 connection 的 access/refresh token；
- 不撤销 MCP execution authorization；
- 不影响其他 OAuth connection。

账号安全操作可提供全 connection revoke，属于 Relay 账号层能力。

## 11. Logging and secret handling

禁止日志内容：

- access token；
- refresh token；
- authorization code；
- PKCE verifier；
- MCP 私钥；
- Device Relay access token。

允许审计字段：

```text
connectionId
clientId hash / normalized identity
userId
deviceId
scope
resource
tool name
authorization decision
requestId
result class
```

MCP URL 可进入审计日志，因为 URL 不含 bearer secret。日志仍按用户/设备元数据处理。

## 12. Rollout order

部署顺序：

```text
Database migration
-> OAuth authorization server
-> Protected Resource Metadata
-> OAuth MCP ingress
-> MCP execution authorization v2
-> Device Relay enforcement
-> frely-cli
```

不接受以下混合状态：

- CLI v2 + 只支持 `mcpTokenHash` 的 Relay；
- OAuth MCP ingress + 不校验 resource 的 token；
- OAuth refresh 可修改 MCP execution authorization expiry；
- 稳定 MCP URL 允许无 OAuth token 调用；
- 旧 private-secret URL 获得隐式 OAuth 权限。

## 13. Standards references

- MCP Authorization Specification, revision `2026-07-28`
- RFC 9728 OAuth 2.0 Protected Resource Metadata
- RFC 8707 Resource Indicators for OAuth 2.0
- RFC 7636 PKCE
- RFC 9207 OAuth 2.0 Authorization Server Issuer Identification
- RFC 8414 OAuth 2.0 Authorization Server Metadata
- RFC 7009 OAuth 2.0 Token Revocation
