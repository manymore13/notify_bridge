# notify-bridge

MCP Server 连接 AI Coding Agent (Claude Code) 与 IM (飞书/Telegram)，实现远程 **Human-in-the-Loop** 决策。

当 agent 需要人类确认时，通过 IM 发消息给人类并阻塞等待回复，解决人不在电脑旁的问题。

## 安装

```bash
npm install -g notify-bridge
```

或者本地克隆：

```bash
git clone https://github.com/leiyanlian/notify-bridge.git
cd notify_bridge
npm install
npm run build
```

## 初始化

运行交互式向导，一次搞定凭证配置 + 权限检查 + MCP 注册：

```bash
notify-bridge init
```

向导会逐步引导你填写 IM 配置（飞书 AppSecret / Telegram BotToken 等），检查认证是否成功，然后把 MCP 配置写入 `.mcp.json` 或 `~/.claude.json`。

## 手动配置

### config.json

项目根目录或 `~/.notify-bridge/config.json`：

```json
{
  "im": {
    "type": "feishu",
    "feishu": {
      "appId": "cli_xxx"
    }
  },
  "defaultTimeoutMs": 300000
}
```

### 环境变量

敏感凭据必须用环境变量（不写入 config.json）：

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_SECRET` | 飞书应用密钥 |
| `FEISHU_APP_ID` | 飞书应用 ID（可替代 config.json） |
| `FEISHU_RECEIVE_ID` | 接收消息的飞书用户 open_id/邮箱 |
| `FEISHU_RECEIVE_ID_TYPE` | open_id / user_id / email |
| `FEISHU_ALLOWED_USER_IDS` | 允许回复的用户 ID（逗号分隔） |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID |
| `TELEGRAM_ALLOWED_USER_IDS` | 允许回复的 Telegram 用户 ID |
| `BRIDGE_IM_TYPE` | feishu / telegram / mock |
| `BRIDGE_DEFAULT_TIMEOUT_MS` | 等待人类回复的超时（ms） |

`.env.example` 提供了模板。

### MCP 注册

手动写入 `.mcp.json`（项目级）或 `~/.claude.json`（全局）：

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

或用命令行快速注册：

```bash
notify-bridge setup             # 写入当前项目 .mcp.json
notify-bridge setup --global    # 写入 ~/.claude.json
```

### 飞书额外配置

1. 在 [飞书开放平台](https://open.feishu.cn) 创建自建应用
2. 开启权限：`im:message:send_as_bot`、`im:message:receive`
3. 事件订阅 → 配置 URL `http://YOUR_IP:18777/feishu/webhook`（需公网可达）
4. 订阅事件：`im.message.receive_v1`

Telegram 不需要 Webhook，使用内置长轮询。

## 使用

配置完成后，Agent 可通过 4 个 MCP 工具与人类交互：

### request_decision

需要人类决策时使用，**阻塞等待回复**。

```
request_decision("是否删除 src/old-module/？", ["确认删除", "保留"])
```

返回 `{ status, selected_option, raw_reply }`，严格按 `selected_option` 执行。

### send_notification

纯通知，不需要回复。

```
send_notification("任务完成：已合并 PR #42")
```

### check_pending

查看当前挂起的决策请求。

### bridge_status

检查 IM 连接状态。

## Agent 记忆

在 CLAUDE.md 中添加规则，让 agent 知道何时使用这些工具（供参考）：

```markdown
## Human-in-the-Loop 决策

需要人类确认时，调用 notify-bridge MCP 工具：
- request_decision(question, options?) — 阻塞等回复
- send_notification(message) — 纯通知
- check_pending() — 查看挂起决策
- bridge_status() — 检查连接

触发场景：删除文件、git push --force、方案选择、长任务完成通知。
```

## 命令参考

```bash
notify-bridge              # 启动 MCP Server
notify-bridge init         # 交互式初始化向导
notify-bridge setup        # MCP 配置写入项目 .mcp.json
notify-bridge setup -g     # MCP 配置写入全局 ~/.claude.json
notify-bridge -h           # 帮助
```

## License

MIT
