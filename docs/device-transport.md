# Device Transport：Cloudflare Worker + Durable Objects

状态：CLI 传输选择与 Relay 回退已实现；Worker、Durable Objects、控制面下发未部署。

## 1. 目标

数据面：

```text
Remote MCP Client
        |
        v
Cloudflare Worker
        |
        v
Device Durable Object
        |
        v
frely-cli
```

备用数据面：

```text
Remote MCP Client
        |
        v
Current Frely Device Relay
        |
        v
frely-cli
```

控制面保留 Frely 服务：

- 账号身份；
- 设备 enrollment；
- MCP execution authorization；
- OAuth connection；
- 设备撤销；
- transport grant 签发；
- edge authorization decision；
- 审计元数据。

Cloudflare 数据面承担：

- Remote MCP HTTP ingress；
- 设备 WebSocket；
- request / response / cancel 路由；
- stream frame 路由；
- edge 在线状态。

frely-cli 承担：

- workspace；
- 文件操作；
- Shell；
- Process；
- MCP runtime；
- Local Provider；
- 授权 lease；
- 本机调度。

## 2. 设计约束

### 2.1 协议

设备协议保持：

```text
frely.device-relay.v1
```

Envelope 保持：

```text
request
response
cancel
stream_start
stream_chunk
stream_end
mcp_disabled
```

CLI 不维护 Cloudflare 专用业务协议。

### 2.2 公网 MCP URL

设备 MCP resource 保持：

```text
https://connect.frely.cloud/mcp/<device-id>
```

OAuth resource、客户端配置、设备 URL 不因 transport 变化。

### 2.3 数据面回退

传输优先级由控制面返回数组定义：

```text
cloudflare_do
relay
```

CLI 不写死 Cloudflare hostname。

### 2.4 请求重放

transport 断开不触发请求重放。

原因：

```text
request sent
    |
    v
local mutation starts
    |
transport lost
    |
    v
outcome unknown
```

文件写入、Shell、Git、Process、Provider 请求存在副作用。

规则：

- 未派发请求允许切换 transport；
- 已派发请求遇到连接丢失返回 transport error；
- mutation outcome 标记 unknown；
- Relay fallback 只承接新请求；
- 客户端决定重试策略。

## 3. Cloudflare 架构

### 3.1 Device Durable Object

DO identity：

```text
deviceId -> one DeviceSessionDO
```

DO 只承担：

- device socket registration；
- waiter socket registration；
- request route；
- response route；
- cancel route；
- stream route；
- connection replacement；
- bounded inflight enforcement。

DO 不承担：

- tool execution；
- model execution；
- workspace state；
- MCP session；
- OAuth database；
- 长时间 Promise；
- outbound WebSocket；
- timer heartbeat；
- request result storage。

### 3.2 Hibernation

设备 WebSocket 使用 Durable Objects Hibernation API：

```ts
ctx.acceptWebSocket(socket)
```

Socket attachment 保存角色与路由数据：

```ts
socket.serializeAttachment({
  role: "device" | "waiter",
  requestId,
  authorizationId
})
```

DO constructor 不依赖内存 routing map。

恢复路径：

```text
DO hibernates
    |
WebSocket stays connected
    |
message arrives
    |
constructor
    |
deserializeAttachment()
    |
route frame
```

DO 禁止：

```text
setInterval
setTimeout
await fetch() during tool execution
outbound WebSocket
outbound TCP
pending request handler for tool duration
```

这些状态会阻断 hibernation。

### 3.3 Worker 请求生命周期

DO 不等待 frely-cli 的执行结果。

Worker 保存公网 HTTP 请求生命周期。

请求路径：

```text
ChatGPT
   |
   | POST /mcp/<device-id>
   v
Worker
   |
   | WebSocket Upgrade
   v
DeviceSessionDO
   |
   | waiter socket
   |
   | request frame
   v
device socket
   |
   v
frely-cli
```

响应路径：

```text
frely-cli
   |
   | response / stream frame
   v
DeviceSessionDO
   |
   | waiter socket
   v
Worker
   |
   v
ChatGPT
```

关键点：

1. Worker 为一次 MCP HTTP 请求建立 waiter WebSocket。
2. DO 接收 waiter socket。
3. Worker 向 waiter socket 写入 request envelope。
4. DO 向 device socket 转发 frame。
5. DO handler 结束。
6. frely-cli 执行任务。
7. frely-cli 返回 response 或 stream frame。
8. DO 唤醒。
9. DO 找到 request 对应 waiter socket。
10. DO 转发 frame。
11. Worker 生成 HTTP MCP response。
12. waiter socket 关闭。

Worker HTTP invocation 可以覆盖工具执行等待时间。计费主体为 Worker 请求与 CPU，不是 Worker wall-clock duration。

### 3.4 Waiter 查找

单设备 inflight 上限保持 64。

推荐方式：

```text
WebSocket attachment
+
WebSocket tag
```

Tag 示例：

```text
role:device
request:<request-id>
```

DO 不依赖 Map 作为持久 routing state。

## 4. 控制面连接契约

现有接口保持：

```text
POST /api/user/device-relay/connect
```

新响应：

```json
{
  "websocketUrl": "wss://legacy-relay.example/device-relay/ws?deviceId=...",
  "accessToken": "<legacy-token>",
  "expiresAt": "2026-09-19T00:00:00Z",
  "transports": [
    {
      "kind": "cloudflare_do",
      "websocketUrl": "wss://connect.frely.cloud/edge/device-relay/ws?deviceId=...",
      "accessToken": "<edge-token>",
      "expiresAt": "2026-09-19T00:00:00Z"
    },
    {
      "kind": "relay",
      "websocketUrl": "wss://legacy-relay.example/device-relay/ws?deviceId=...",
      "accessToken": "<relay-token>",
      "expiresAt": "2026-09-19T00:00:00Z"
    }
  ]
}
```

顶层三个 legacy 字段保留一个兼容周期。

旧 CLI：

```text
websocketUrl
accessToken
expiresAt
```

新 CLI：

```text
transports[0]
    |
failure
    v
fresh connection grant
    |
    v
next transport kind
```

每次 fallback 获取新 grant。备用 token 不需要覆盖主连接寿命。

## 5. Transport grant

Edge token 与 Relay token 分离。

Edge token 建议绑定：

```text
deviceId
userId
transport = cloudflare_do
mcpAuthorizationId?
issuedAt
expiresAt
jti
```

Relay token 保持现有单次消费语义。

Token 不进入 URL。

## 6. OAuth 与 MCP execution authorization

现有 MCP OAuth access token 是 opaque token。Worker 不承担 token 数据库语义。

第一阶段：

```text
Worker
   |
   | authorization decision
   v
Frely control plane
   |
   v
allowed / denied
deviceId
authorizationId
expiresAt
```

MCP payload 不进入控制面授权接口。

效果：

- Frely 服务器保留认证与撤销判断；
- Frely 服务器退出设备长连接；
- Frely 服务器退出 MCP payload 转发；
- Frely 服务器退出工具结果与 stream 转发。

Signed edge-verifiable MCP access token 属于独立迁移，不进入本阶段。

## 7. 撤销

### 7.1 MCP authorization 到期

CLI 的 McpLease 保持本机强制检查。

### 7.2 MCP authorization 撤销

控制面向 edge 发送设备级撤销事件：

```text
control plane
    |
    v
Worker internal endpoint
    |
    v
DeviceSessionDO
    |
    | mcp_disabled
    v
frely-cli
```

DO 校验内部请求身份。

### 7.3 Device revoke

动作：

- control plane 标记 device revoked；
- edge device socket 关闭；
- Relay fallback grant 拒绝签发；
- 现有 Relay connection 执行现有撤销流程。

## 8. Fallback 状态机

CLI：

```text
request connection grant
        |
        v
cloudflare_do
   |        |
 success   failure
   |        |
 stay       v
         request fresh grant
             |
             v
           relay
          |     |
      success  failure
          |     |
         stay  backoff
                |
                v
            primary order
```

Failback 规则：

- 已建立 Relay fallback connection 不执行抢占切换；
- 下次 reconnect 使用控制面优先级；
- 主连接恢复不影响在途请求。

Worker：

```text
new request
   |
   v
DO route
   |
   +-- device socket exists -> dispatch
   |
   +-- edge unavailable before dispatch -> legacy Relay fallback
   |
   +-- transport lost after dispatch -> error, no replay
```

Legacy fallback 入口使用独立 origin 或 service binding。Public `connect.frely.cloud` 不回源到自身。

## 9. Heartbeat

CLI 现有 WebSocket protocol ping 保留。

DO 不创建 timer heartbeat。

连接健康状态来源：

- protocol ping/pong；
- socket close；
- connection replacement；
- Worker/DO routing result。

## 10. Provider

第一阶段复用同一 transport candidate。

```text
Gateway
   |
Worker
   |
DO
   |
frely-cli
   |
loopback model
```

Provider stream 使用现有：

```text
stream_start
stream_chunk
stream_end
cancel
```

Provider 请求遵守“不重放未知结果请求”。

## 11. 观测

CLI status 增加：

```text
transport = cloudflare_do | relay
```

诊断事件：

```text
relay.transport_selected.cloudflare_do
relay.transport_selected_fallback.relay
relay.transport_fallback.cloudflare_do_to_relay
relay.disconnected.cloudflare_do
relay.disconnected.relay
```

日志禁止：

- bearer token；
- MCP OAuth token；
- tool arguments；
- tool result；
- file content；
- shell command；
- Provider payload。

Edge metrics：

```text
active_device_sockets
active_waiter_sockets
dispatch_total
dispatch_error_total
transport_lost_total
fallback_total
inflight_per_device
handler_cpu_ms
```

## 12. 成本约束

架构约束：

- Hibernation API；
- DO server-side WebSocket；
- 无 DO timer；
- 无 DO outbound socket；
- 无 DO 长等待；
- 无 DO tool execution；
- Worker 持有 HTTP 等待；
- 设备 protocol ping；
- 单设备 inflight 64。

成本模型：

```text
Worker:
  inbound request
  CPU

DO:
  connection request
  inbound WebSocket message
  active handler duration
```

空闲设备连接不形成持续 DO duration。

## 13. 发布阶段

### Phase A — CLI compatibility

内容：

- transport candidate contract；
- `cloudflare_do | relay`；
- server-defined priority；
- fresh-grant fallback；
- transport diagnostics；
- legacy single-grant compatibility。

状态：已完成。

### Phase B — Edge data plane

内容：

- Worker；
- DeviceSessionDO；
- Hibernation device socket；
- waiter socket；
- request / response / cancel / stream route；
- internal authorization decision；
- edge connection token。

状态：未实施。

### Phase C — Control-plane rollout

内容：

- `transports[]` grant；
- edge token signer；
- revoke notification；
- feature flag；
- per-account rollout；
- legacy top-level grant fields。

状态：未实施。

### Phase D — Traffic migration

顺序：

```text
internal
canary users
small percentage
majority
default
```

指标：

- edge connect success；
- fallback rate；
- transport loss；
- MCP error rate；
- request latency；
- DO duration；
- DO request count；
- Worker CPU。

Current Relay 保留 fallback 能力。

## 14. 回滚

控制面删除 `cloudflare_do` candidate：

```json
{
  "transports": [
    {
      "kind": "relay",
      "websocketUrl": "...",
      "accessToken": "...",
      "expiresAt": "..."
    }
  ]
}
```

CLI 无版本回滚需求。

## 15. Cloudflare 依据

- Durable Objects Hibernation WebSocket API：
  https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Durable Object lifecycle：
  https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- Durable Objects pricing：
  https://developers.cloudflare.com/durable-objects/platform/pricing/
- Workers WebSocket：
  https://developers.cloudflare.com/workers/examples/websockets/
- Workers pricing：
  https://developers.cloudflare.com/workers/platform/pricing/
- Workers limits：
  https://developers.cloudflare.com/workers/platform/limits/
