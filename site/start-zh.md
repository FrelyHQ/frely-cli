# 开始使用 Frely CLI

## 安装 Frely CLI

选择您的安装方式：

### npm
需要 Node.js 22+。

```bash
npm install -g @frelyhq/frely-cli
```

### 下载独立可执行文件
独立版自带运行时，无需 Node.js。

从 [GitHub Releases](https://github.com/FrelyHQ/frely-cli/releases/latest) 下载。

## 使用邮箱登录

安装完成后，用邮箱登录：

```bash
frely login --email your-email@example.com
```

Frely CLI 会向您的邮箱发送验证码。用验证码完成账户设置：

```bash
frely login --code 123456
```

如果是首次登录，会自动创建新账户。

## 启用设备 MCP

登录后，启用设备 MCP 连接：

```bash
frely mcp
```

在浏览器中确认设备和工作区。您的 MCP 地址会被打印出来。

用这个地址在任何兼容客户端（ChatGPT、Claude Code、Codex 等）中连接 Agent。

## 检查连接

任何时候都可以检查设置：

```bash
frely doctor
```

添加 `-v` 查看详细诊断信息：

```bash
frely doctor -v
```

---

## 接下来做什么？

- **接入网页 Agent**：在 ChatGPT 或其他兼容客户端中添加 MCP 地址，用 Frely 账号授权，让 Agent 读取文件或运行命令。
- **接入命令行 Agent**：在另一台电脑上使用 Codex、Claude Code 等命令行 Agent，通过 MCP 访问你的设备。
- **共享本地模型**：配置本地模型提供者，通过 Frely 共享 Ollama 或其他本地 LLM。
