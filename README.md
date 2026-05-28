# notify-bridge

MCP Server bridging AI coding agents (Claude Code / OpenCode) with IM tools (Feishu / Telegram) for **human-in-the-loop** decisions.

当 agent 在编码时需要人类确认/决策，但人不在电脑旁时，通过 IM 发送消息给人类并等待回复，实现远程 Human-in-the-Loop。

## 架构

```
┌──────────────┐     stdio/JSON-RPC     ┌──────────────────┐     HTTP/Webhook     ┌─────────────┐
│  Claude Code  │ ◄───────────────────► │  notify-bridge    │ ◄──────────────────► │  飞书/电报   │
│  (Agent)      │   MCP Tools           │  (MCP Server)     │   IM API            │  (Human)     │
│              │                       │                   │                     │             │
│  调用工具:    │                       │  request_decision  │ ──发消息──►        │  收到问题    │
│  - request_  │                       │  send_notification │ ◄──收回复──        │  回复答案    │
│    decision  │                       │  check_pending     │                     │             │
└──────────────┘                       └──────────────────┘                     └─────────────┘
```

## 支持的 IM 平台

| 平台 | 状态 | 说明 |
|------|------|------|
| **飞书 (Feishu/Lark)** | 可用 | 需创建自建应用，配置 Bot + 权限 |
| **Telegram** | 可用 | 需创建 Bot，获取 Token 和 Chat ID |
| 微信 | 计划中 | 需特殊适配方案 |

## 快速开始

### 1. 安装依赖 & 构建

```bash
cd notify_bridge
npm install
npm run build
```

### 2. 配置 IM 通道

选择一个 IM 平台配置：

<details>
<summary><b>飞书 配置</b></summary>

1. 在 [飞书开放平台](https://open.feishu.cn) 创建自建应用
2. 获取 App ID 和 App Secret
3. 开启权限：`im:message:send_as_bot`（发消息）、`im:message:receive`（收消息）
4. 创建 `config.json`：

```json
{
  "im": {
    "type": "feishu",
    "feishu": {
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "receiveId": "YOUR_OPEN_ID_OR_EMAIL",
      "receiveIdType": "open_id",
      "webhookPort": 18777,
      "webhookPath": "/feishu/webhook"
    }
  },
  "defaultTimeoutMs": 300000
}
```

获取 `receiveId`：
- **方法 A**（推荐）：在飞书管理后台 → 成员与部门 → 点击你的头像，查看 open_id
- **方法 B**：使用你的飞书邮箱，`receiveIdType` 设为 `email`
- **方法 C**（需通讯录权限）：`npx tsx src/feishu-lookup.ts email your@email.com`

5. 配置事件订阅（接收人类回复）：
   - 在飞书开放平台 → 事件订阅 → 配置请求地址 URL
   - URL 为 `http://YOUR_IP:18777/feishu/webhook`（需公网可达）
   - 订阅事件：`im.message.receive_v1`

</details>

<details>
<summary><b>Telegram 配置</b></summary>

1. 在 Telegram 找 [@BotFather](https://t.me/BotFather) 创建 Bot
2. 获取 Bot Token，找到你的 Chat ID
3. 创建 `config.json`：

```json
{
  "im": {
    "type": "telegram",
    "telegram": {
      "botToken": "123456:ABC-DEF",
      "chatId": "YOUR_CHAT_ID"
    }
  },
  "defaultTimeoutMs": 300000
}
```

Telegram 使用内置的长轮询（Long Polling），无需配置 Webhook 公网地址。

</details>

### 3. 在 Claude Code 中配置 MCP

在 Claude Code 的 MCP 配置文件中添加（`~/.claude/claude_desktop_config.json` 或项目 `.claude/mcp.json`）：

```json
{
  "mcpServers": {
    "notify-bridge": {
      "command": "node",
      "args": ["D:/github/notify_bridge/dist/index.js"],
      "cwd": "D:/github/notify_bridge"
    }
  }
}
```

### 4. 在 Agent 记忆中添加规则

将以下内容添加到 CLAUDE.md 或 Agent 记忆：

```markdown
## Human-in-the-Loop 决策

当你需要人类确认或决策时，调用 notify-bridge MCP 工具：

### 工具说明
- `request_decision(question, options?, timeout_ms?)` — 发问题给人类，阻塞等回复
- `send_notification(message)` — 纯通知，不等回复
- `check_pending()` — 查看挂起的决策

### 使用时机
- 删除文件、git push --force 等危险操作前
- 多种等价方案需要选择时
- 需要人类的领域知识才能继续
- 长任务完成/出错时通知
```

## MCP 工具参考

### request_decision

向人类发送决策请求，阻塞等待回复。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| question | string | 是 | 问题内容 |
| options | string[] | 否 | 可选选项列表 |
| timeout_ms | number | 否 | 超时（毫秒），默认 300000 (5分钟) |

返回值：`{ "status": "answered", "answer": "人类的选择" }`

### send_notification

发送纯通知，不等待回复。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| message | string | 是 | 通知内容 |

### check_pending

查看当前挂起的决策请求。

返回值：`{ "pending": [{ "id": "...", "question": "...", "elapsedMs": 12345 }] }`

## 环境变量

也可以不创建 `config.json`，全部用环境变量：

```bash
BRIDGE_IM_TYPE=feishu
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_RECEIVE_ID=xxx
FEISHU_RECEIVE_ID_TYPE=open_id
FEISHU_WEBHOOK_PORT=18777
BRIDGE_DEFAULT_TIMEOUT_MS=300000
```

## 测试

```bash
# 单元测试 (bridge 核心逻辑)
npm run dev -- src/test.ts

# MCP 协议集成测试
npm run dev -- src/integration-test.ts

# 飞书 API 连通性测试
npm run dev -- src/feishu-test.ts
```

## 项目结构

```
src/
├── index.ts              # 入口
├── mcp-server.ts         # MCP Server (工具定义)
├── bridge.ts             # 核心桥接逻辑 (决策队列/Promise阻塞)
├── config.ts             # 配置加载
├── adapters/
│   ├── types.ts          # IM 适配器接口
│   ├── feishu.ts         # 飞书适配器
│   ├── telegram.ts       # Telegram 适配器
│   ├── mock.ts           # Mock 适配器 (测试用)
│   └── index.ts          # 适配器工厂
├── feishu-lookup.ts      # 飞书用户查找工具
├── feishu-test.ts        # 飞书连通性测试
├── test.ts               # 单元测试
└── integration-test.ts   # 集成测试
```
