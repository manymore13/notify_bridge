# notify-bridge 系统架构文档

> 面向审阅者：本文档描述 notify-bridge 的完整系统架构、代码逻辑、数据流和潜在风险。适用于首次接触本项目的技术专家进行安全审计和架构评审。

---

## 1. 概述

**notify-bridge** 是一个 MCP (Model Context Protocol) Server，在 AI 编码 Agent（如 Claude Code、OpenCode）与即时通讯工具（飞书、Telegram）之间架设桥梁，实现 **Human-in-the-Loop** 远程决策。

**核心场景**: Agent 在编码过程中需要人类确认（删除文件、架构选型、危险操作等），但人不在电脑旁——Agent 通过 IM 发消息到人类手机，人类回复后 Agent 自动继续执行。

**版本**: 0.3.0-draft | **最后更新**: 2026-05-28 | **状态**: 架构评审中 (代码待同步)

**通信模型**:

```
┌──────────────────┐   stdio/JSON-RPC    ┌──────────────────┐   WebSocket/HTTP   ┌──────────────┐
│  Claude Code     │ ◄─────────────────► │  notify-bridge    │ ◄────────────────► │  飞书/Telegram │
│  (MCP Client)    │                     │  (MCP Server)     │                    │  (Human)      │
│                  │                     │                   │                    │              │
│  tools/call ─────┼──► request_decision ─┼── sendDecision ──►│                    │  收到卡片     │
│                  │                     │                   │                    │              │
│                  │                     │     [阻塞等待]     │◄─ WebSocket msg ──│  点按钮/回复  │
│  ◄───────────────┼── result ───────────┼── resolve(answer) │                    │              │
└──────────────────┘                     └──────────────────┘                    └──────────────┘
```

---

## 2. 项目结构

```
src/
├── index.ts              # 入口：分流 MCP Server 或 setup 命令
├── mcp-server.ts         # MCP 协议层：4 个工具注册
├── bridge.ts             # 核心逻辑：决策队列、Promise 阻塞、回复匹配
├── config.ts             # 配置加载（文件 + 环境变量，env 优先）
├── setup.ts              # CLI setup 命令（项目级/全局 MCP 配置）
├── adapters/
│   ├── types.ts          # IMBotAdapter 接口定义
│   ├── index.ts          # 适配器工厂 (根据 config 创建具体实现)
│   ├── feishu.ts         # 飞书适配器 (官方 SDK 长连接)
│   ├── telegram.ts       # Telegram 适配器 (长轮询)
│   └── mock.ts           # Mock 适配器 (测试用)
├── test.ts               # 单元测试 (18 项)
├── integration-test.ts   # MCP 协议集成测试 (16 项)
├── e2e-test.ts           # 端到端测试 (真实飞书连接)
└── sdk-test.ts           # 飞书 SDK 连通性诊断
```

### 模块依赖图

```
index.ts
  ├─→ mcp-server.ts
  │     ├─→ bridge.ts
  │     │     └─→ adapters/index.ts → feishu.ts | telegram.ts | mock.ts
  │     └─→ @modelcontextprotocol/sdk
  └─→ setup.ts (CLI 模式)
```

---

## 3. 核心模块详解

### 3.1 NotifyBridge (`bridge.ts`)

整个系统的核心，管理决策请求的生命周期。

#### 数据结构

```typescript
interface PendingDecision {
  request: DecisionRequest;     // 决策请求的元数据
  resolve: (answer: string) => void;  // Promise resolve
  reject: (err: Error) => void;       // Promise reject
  timer: ReturnType<typeof setTimeout>; // 超时定时器
}

// 存储介质: 内存 Map<decisionId, PendingDecision>
private pending = new Map<string, PendingDecision>();
```

**关键属性**: 纯内存存储，进程重启后所有挂起决策丢失。

#### requestDecision() — 发起决策

```
调用流程:
1. 生成 UUID 作为 decisionId
2. 计算超时时间 (默认 300s)
3. 创建 DecisionRequest 对象
4. 创建 Promise (用 deferred 模式获取 resolve/reject)
5. 注册 setTimeout 超时回调
6. 将 PendingDecision 写入 this.pending Map ⚠️ (在发IM之前)
7. await adapter.sendDecision(request) — 发送IM消息
8. 若发送失败 → 清除 pending 条目 + reject
9. 返回 Promise (外部 await 阻塞)
```

**设计意图**: 步骤 6 在步骤 7 之前执行，确保 `getPendingDecisions()` 调用方无需等待微任务即可看到挂起决策。

**sendDecision 发送超时保护 (v0.3.0 新增)**:

```typescript
// sendDecision 必须设置硬超时 (3-5s)，防止 IM 服务商网关卡死
// 导致 MCP 线程被永久阻塞
const SEND_TIMEOUT_MS = 5000;

async requestDecision(question, options, timeoutMs) {
  // ...
  try {
    await Promise.race([
      this.adapter.sendDecision(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("IM发送超时")), SEND_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    clearTimeout(timer);
    this.pending.delete(id);
    throw err;
  }
  return promise;
}
```

**⚠️ 残留风险**:
- 发送超时后 pending 条目已清理，但 IM 消息可能已送达（网络延迟导致 race condition）。
  用户回复时 pending.size === 0，回复被静默丢弃。
  **缓解**: 超时返回后 Agent 会在终端重新展示问题，不会永久丢失上下文。

#### handleReply() — 回复匹配算法 (v0.3.0: decisionId 精确关联)

```
输入: DecisionResponse { decisionId, answer, respondedAt }

匹配逻辑 (v0.3.0 重构):
┌──────────────────────────────────────────────────────┐
│ 1. 如果 pending.size === 0 → 直接返回 (丢弃)         │
│                                                      │
│ 2. decisionId 精确匹配 (最高优先级, v0.3.0 新增):    │
│    decisionId 非空 → pending.get(decisionId)          │
│    命中 → 直接 resolve (跳过选项匹配和 FIFO)         │
│                                                      │
│ 3. 选项匹配 (Option Match):                          │
│    仅当 decisionId 为空时才降级到选项匹配             │
│    遍历 pending，如果 answer 在某 options 中 → 匹配   │
│                                                      │
│ 4. 降级 FIFO (最后手段):                             │
│    仅当 decisionId 为空 且 选项匹配无结果时           │
│    按 createdAt 排序，取最旧的 pending               │
│                                                      │
│ 5. 清除定时器 + 从 Map 删除 + resolve(answer)         │
└──────────────────────────────────────────────────────┘
```

**decisionId 来源**:
- **卡片按钮点击** (`card.action.trigger`): `action.value = JSON.stringify({id: decisionId, option: "是"})`
  — 强制携带 decisionId，精确关联到具体决策
- **文本回复** (`im.message.receive_v1`): decisionId 为空 → 降级到选项匹配 / FIFO

**卡片 value 结构 (v0.3.0 变更)**:

```typescript
// v0.2.0 (旧): 卡片按钮 value 仅为选项文本
actions: options.map(opt => ({ value: opt }))

// v0.3.0 (新): 卡片按钮 value 为 {id, option} 的 JSON 编码
actions: options.map(opt => ({
  value: JSON.stringify({ id: decisionId, option: opt })
}))
```

对应的 `handleCardAction()` 解析:

```typescript
function handleCardAction(data): void {
  const raw = action?.value;
  let decisionId = "", answer = raw;
  try {
    const parsed = JSON.parse(raw);
    decisionId = parsed.id || "";
    answer = parsed.option || raw;
  } catch { /* 兼容旧格式: value 直接是选项文本 */ }

  this.onReply({ decisionId, answer, respondedAt: Date.now() });
}
```

**并发安全性对比**:

| 场景 | v0.2.0 | v0.3.0 |
|------|--------|--------|
| A="删文件?" [是/否], B="格盘?" [是/否] | 回复"否" → FIFO 匹配到 A (错误!) | 卡片按钮 → decisionId 精确匹配 ✅ |
| 文本回复"否" | 选项匹配 → 第一个 [是/否] 的决策 | 文本无 decisionId → 降级选项匹配 (同左) |
| 卡片按钮点"是" | 选项匹配 → 可能错位 | decisionId 精确 → 绝不错位 ✅ |

**最小惊讶原则**: 卡片按钮强制精确关联；文本回复作为备用通道，降级到选项匹配 (带 warning 标记)。

#### stop() — 关闭

```typescript
async stop() {
  for (const [, pending] of this.pending) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Bridge shutting down"));
  }
  this.pending.clear();
  await this.adapter.stop();
}
```

正确清理所有挂起的 Promise，避免僵尸 Promise。调用方会收到明确的 reject。

#### checkDecisionRateLimit() / checkNotificationRateLimit() — 频控 (v0.2.0 新增)

```typescript
// 令牌桶: 决策 ≤5/分钟, 通知 ≤3/秒
private decisionTimestamps: number[] = [];
private notificationTimestamps: number[] = [];

private checkDecisionRateLimit(): void {
  this.decisionTimestamps = this.decisionTimestamps.filter(t => now - t < 60000);
  if (this.decisionTimestamps.length >= 5) throw new Error("决策频控...");
  this.decisionTimestamps.push(Date.now());
}
```

在 `requestDecision()` 和 `sendMessage()` 入口处调用，触发阈值时直接抛异常。
Agent 收到 `isError` 后应暂停决策请求。

#### getStatus() / getPendingDecisions()

只读方法，暴露内部状态用于 MCP 工具。无副作用。

---

### 3.2 MCP Server 层 (`mcp-server.ts`)

在 MCP 协议上注册 4 个工具，使用 Zod schema 做参数校验。

| 工具名 | 阻塞 | 用途 |
|--------|------|------|
| `request_decision` | 是 | 发决策请求到 IM，阻塞等回复 |
| `send_notification` | 否 | 发纯通知到 IM |
| `check_pending` | 否 | 查看当前挂起的决策列表 |
| `bridge_status` | 否 | 检查 IM 连接状态 |

**通信协议**: STDIO + JSON-RPC 2.0（MCP 标准）。无 HTTP 端点暴露，仅与父进程通信。

**错误处理**: `request_decision` 工具内部 catch 异常后返回 `isError: true`，不会让异常传播到 MCP 协议层导致连接中断。

#### request_decision 返回值结构 (v0.2.0 防注入强化)

```
成功:
{
  "status": "answered",
  "selected_option": "是",     // 匹配到预设选项时有值，否则 null
  "raw_reply": "是",           // 人类的原始IM回复
  "source": "im",              // 标记来源为外部输入
  "warning": "..."             // 回复不在选项中时有警告
}

超时:
{
  "status": "timeout",
  "error": "决策超时 (300s)...",
  "original_question": "...",  // 原始问题，供 Agent 重新展示
  "hint": "人类未在IM上回复。请在终端重新展示问题，直接获取回复。"
}
```

**防注入策略**: Agent 必须严格按 `selected_option` 执行，不自行解析 `raw_reply`。
如果 `selected_option` 为 null → 忽略回复并重新询问。工具描述中也内联了此安全提示。

---

### 3.3 飞书适配器 (`adapters/feishu.ts`)

#### 连接方式

使用 **@larksuiteoapi/node-sdk** 官方 SDK 的 `WSClient` 建立 WebSocket 长连接，不需要公网 URL。

```
启动流程:
1. new Lark.WSClient({ appId, appSecret })
2. 创建 EventDispatcher, 注册 im.message.receive_v1 + card.action.trigger
3. wsClient.start({ eventDispatcher })
4. WebSocket 连接到飞书服务器
5. 等待用户发送第一条消息
```

**自动重连**: SDK 的 WSClient 内部实现了自动重连机制，无需手动处理。

#### 用户身份捕获 & 锁定 (v0.3.0: 白名单机制)

```
身份捕获状态机:

  UNBOUND ──首次消息──► BOUND_LOCKED (捕获并锁定)
      │                      │
      │  非白名单用户消息      │  仅白名单用户可触发回复
      ▼                      ▼
  (丢弃, 不覆盖)         正常处理决策回复
```

**配置**: 新增 `config.json` 可选字段 `allowedUserIds: string[]` 和环境变量 `FEISHU_ALLOWED_USER_IDS`（逗号分隔的 open_id 列表）。

**捕获 & 锁定规则 (v0.3.0)**:

```typescript
// 1. 如果配置了 allowedUserIds → 仅接受白名单用户的消息
// 2. 首次捕获 open_id 后立即锁定 (BOUND_LOCKED 状态)
// 3. 非白名单/非锁定用户的消息 → 丢弃并记录警告日志
// 4. 锁定后不再接受其他用户的 open_id 覆盖

private allowedUsers: Set<string>;         // 从 config 加载的白名单
private lockedOpenId: string | null;       // 锁定后的唯一用户

function handleMessageEvent(data): void {
  const senderOpenId = event.sender?.sender_id?.open_id;

  // 如果配置了白名单 → 必须在白名单中
  if (this.allowedUsers.size > 0 && !this.allowedUsers.has(senderOpenId)) {
    console.warn(`[feishu] 非白名单用户 ${senderOpenId} 消息已丢弃`);
    return; // ← 不处理, 不覆盖
  }

  // 如果已锁定 → 只接受锁定用户的消息
  if (this.lockedOpenId && senderOpenId !== this.lockedOpenId) {
    console.warn(`[feishu] 非锁定用户 ${senderOpenId} 消息已丢弃 (当前锁定: ${this.lockedOpenId})`);
    return; // ← 不处理, 不覆盖
  }

  // 首次捕获 → 锁定
  if (!this.lockedOpenId) {
    this.lockedOpenId = senderOpenId;
    console.log(`[feishu] 🔒 锁定用户: ${senderOpenId}`);
  }

  // ... 继续处理消息
}
```

**安全语义**:
- 环境变量 `FEISHU_ALLOWED_USER_IDS` 为空且未配置 `allowedUserIds` → 首次消息自动锁定（开发友好）
- 环境变量 `FEISHU_ALLOWED_USER_IDS=ou_xxx,ou_yyy` → 仅白名单用户可触发决策
- 锁定后，同事误发消息或被@机器人等情况不会导致 "决策发错人" 的安全事故

#### Token 管理 (v0.2.0 已修复缓存)

```typescript
private tenantAccessToken = "";
private tokenExpireAt = 0;

private async getAccessToken(): Promise<string> {
  // 缓存命中: 距离过期还有 60s 以上则复用
  if (this.tenantAccessToken && Date.now() < this.tokenExpireAt - 60000) {
    return this.tenantAccessToken;
  }
  // 缓存未命中: 请求新 token
  const res = await axios.post(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    { app_id, app_secret }
  );
  this.tenantAccessToken = res.data.tenant_access_token;
  this.tokenExpireAt = Date.now() + (res.data.expire || 7200) * 1000;
  return this.tenantAccessToken;
}
```

**设计**: TTL 缓存 + 提前 60 秒刷新阈值，减少 token API 调用频率，降低限流风险和延迟。

#### 消息发送

```
sendDecision() → sendImMessage() → axios POST /im/v1/messages
                                   ↑
                                   receive_id = capturedOpenId || capturedChatId
```

- 决策消息以**交互式卡片**形式发送（带按钮）
- 通知消息以**纯文本**形式发送
- 使用 `receive_id_type: "chat_id"` 优先（如果有 chat_id），否则 `"open_id"`

#### 事件处理 (v0.2.0 已修复卡片事件)

```
WebSocket 收到事件 → EventDispatcher 分发:
  ├─ im.message.receive_v1 → handleMessageEvent()
  │     ├─ 捕获 open_id/chat_id
  │     ├─ 解析消息文本
  │     └─ 调用 onReply callback → bridge.handleReply()
  │
  └─ card.action.trigger → handleCardAction()
        ├─ 解析 action.value: JSON.parse → {id: decisionId, option: "是"}
        ├─ 向下兼容: 非 JSON value 视为纯选项文本 (decisionId 为空)
        └─ 调用 onReply({ decisionId, answer }) → bridge.handleReply()
```

**卡片按钮现已生效**: `card.action.trigger` 事件已在 EventDispatcher 中注册。
用户点击飞书卡片按钮 → `handleCardAction()` 提取按钮值 → 传给 `bridge.handleReply()`。
选项精确匹配路径优先命中（按钮值就是预设 options 之一）。

#### stop() (v0.2.0 改进)

```typescript
async stop() {
  this.stopped = true;
  if (this.wsClient) {
    try {
      (this.wsClient as any).stop?.();
      (this.wsClient as any).close?.();
    } catch { /* ignore */ }
    this.wsClient = null;
  }
}
```

尝试调用 SDK 的 stop/close 方法（如果存在），然后置空引用。进程退出时 WebSocket 自然关闭。

---

### 3.4 Telegram 适配器 (`adapters/telegram.ts`)

#### 连接方式

使用 Telegram Bot API 的 **Long Polling** (`getUpdates`) 接收消息，不需要公网 URL。

```typescript
// 长轮询循环:
while (this.polling) {
  const res = await axios.get(`${apiBase}/getUpdates`, {
    params: { offset: lastUpdateId + 1, timeout: 30 }
  });
  // 处理更新...
}
```

#### 差异点

| 特性 | 飞书 | Telegram |
|------|------|----------|
| 连接 | WebSocket 长连接 | HTTP 长轮询 |
| 消息格式 | 交互式卡片 | Markdown + ReplyKeyboard |
| 用户身份 | 自动捕获 open_id | 配置中指定 chat_id |
| 重连 | SDK 自动 | 循环自动恢复 |
| 多用户 | 可能混乱（覆盖） | chat_id 固定，无此问题 |

**⚠️ 注意**: Telegram 适配器的 `sendDecision` 使用 `reply_markup: buildReplyKeyboard(options)` —— 这是一个一次性键盘，用户点击按钮后会发送对应文本。所以回复匹配走的是 option 匹配路径（精确匹配）。

---

### 3.5 配置加载 (`config.ts`) (v0.3.0: 向上查找 + 全局回退)

```typescript
// 查找优先级: 环境变量 > 当前目录 config.json > 向上递归查找 > ~/.notify-bridge/config.json > 默认值
function findConfig(): string | null {
  let dir = process.cwd();
  while (true) {
    const configPath = join(dir, "config.json");
    if (existsSync(configPath)) return configPath;
    const parent = resolve(dir, "..");
    if (parent === dir) break;  // 已到文件系统根目录
    dir = parent;
  }
  // 回退到用户主目录
  const homeConfig = join(homedir(), ".notify-bridge", "config.json");
  if (existsSync(homeConfig)) return homeConfig;
  return null;  // 纯环境变量模式
}

// 凭证强制从环境变量读取，config.json 不允许存储
feishu: {
  appId:    process.env.FEISHU_APP_ID || fcfg.appId || "",
  appSecret: process.env.FEISHU_APP_SECRET || "",    // ← 仅 env
  allowedUserIds: parseUserIds(process.env.FEISHU_ALLOWED_USER_IDS || fcfg.allowedUserIds),
},
telegram: {
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",      // ← 仅 env
  chatId:   process.env.TELEGRAM_CHAT_ID || fcfg.chatId || "",
},
```

**查找策略 (v0.3.0)**: 类似 `.gitignore` 的向上递归查找，找到第一个 `config.json` 即停止。
回退链: `./config.json` → `../config.json` → ... → `~/.notify-bridge/config.json` → 纯环境变量模式。

**安全规则**: `appSecret` 和 `botToken` 只能通过环境变量注入。`config.json` 中写这些字段将被忽略。
如果缺少凭证，启动时报明确错误，不会静默失败。

---

### 3.6 Setup 命令 (`setup.ts`)

```bash
notify-bridge setup           # 项目级 → .claude/mcp.json
notify-bridge setup --global  # 全局   → ~/.claude/settings.json
```

- 读取现有文件 → 解析 JSON → 追加/更新 `mcpServers.notify-bridge` → 写回
- **不安全 JSON 不会覆盖**: 解析失败则报错退出（exit 1）
- 保留所有其他顶层 key 和其他 MCP Server 配置

---

## 4. 完整数据流

### 4.1 正常决策流程

```
时间线:

T+0s     Agent 调 request_decision("是否删文件?", ["是","否"])
T+0.1s   bridge.requestDecision() 创建 Promise + pending 条目
T+0.2s   adapter.sendDecision() 发飞书卡片 (按钮 value = JSON.stringify({id: decisionId, option: "是"}))
T+0.3s   Promise 返回，工具进入阻塞状态(T+0.3s), Agent 挂起

T+15s    人类在飞书上看到卡片, 点"是"按钮
T+15.1s  飞书推送 card.action.trigger → handleCardAction() 解析出 {decisionId, option}
         (如果是文本回复 → im.message.receive_v1 → handleMessageEvent(), decisionId 为空)
T+15.2s  bridge.handleReply() → decisionId 精确匹配 → resolve("是")
T+15.3s  工具返回 { status: "answered", selected_option: "是", raw_reply: "是", source: "im" }
T+15.4s  Agent 严格按 selected_option 执行，继续编码
```

### 4.2 超时流程

```
T+0s     调 request_decision(..., timeout=5000)
T+5s     setTimeout 触发 → pending.delete(id) → reject("超时")
         工具返回 { status: "timeout", error: "...", original_question: "...", hint: "..." }
         Agent 收到 isError → 在终端重新展示 original_question
```

### 4.3 IM 发送失败流程

```
T+0s     调 request_decision(...)
         bridge 注册 pending 条目 (在发消息之前)
T+0.1s   adapter.sendDecision() 抛出异常
         bridge: clearTimeout + pending.delete + throw
         工具返回 isError
         ⚠️ pending 已正确清理
```

---

## 5. 安全分析

### 5.1 威胁模型

| 威胁 | 风险等级 | 当前缓解 | 残留风险 |
|------|---------|---------|---------|
| ~~config.json 凭证泄露~~ | ~~高~~ | ✅ v0.2.0: 强制环境变量 | config.json 不再接受凭证 |
| 中间人截获 IM 消息 | 中 | HTTPS/WSS | 依赖飞书/Telegram 的 TLS |
| 伪造回复 | 中 | 无认证 | 任何人拿到 `chat_id` 可回复决策 |
| 多用户 ID 覆盖 | 中 | 无 | 第二个用户发消息会劫持对话 |
| MCP 工具被恶意调用 | 低 | MCP 仅与父进程通信 | 无网络暴露 |
| Token 在内存中 | 低 | 进程内存 | 进程 dump 可能泄露 |
| ~~回复注入~~ | ~~低~~ | ✅ v0.2.0: selected_option 隔离 + source 标记 + 工具描述警告 | Agent 按结构执行，不解析 raw |

### 5.2 审计修复记录 (v0.2.0)

| 问题 | 状态 | 修复方式 |
|------|------|---------|
| 回复注入 | ✅ 已修复 | `selected_option` 隔离 + `source: "im"` 标记 + 工具描述安全警告 |
| 凭证明文存储 | ✅ 已修复 | `appSecret`/`botToken` 仅从环境变量读取 |
| 无速率限制 | ✅ 已修复 | 决策 ≤5/min, 通知 ≤3/s 令牌桶限流 |
| 卡片按钮不工作 | ✅ 已修复 | 注册 `card.action.trigger` 事件 |
| Token 无缓存 | ✅ 已修复 | TTL 缓存 + 提前 60s 刷新 |

### 5.3 仍待关注

1. **多用户身份覆盖**: 第二个飞书用户发消息会覆盖 `capturedOpenId`，无用户认证机制。
2. **伪造回复**: 任何人获知 `chat_id` 即可回复决策，无消息签名验证。
3. **内存持久化**: `pending` Map 纯内存，进程重启丢失所有挂起决策。

---

## 6. 弹性与边缘场景

### 6.1 WebSocket 断开

- **飞书**: SDK 内置自动重连，重连后 `capturedOpenId` 仍在内存中，可继续发送消息
- **Telegram**: 长轮询循环自动恢复

### 6.2 进程崩溃

- `pending` Map 在内存中 → 崩溃后所有挂起决策永久丢失
- Agent 的 `request_decision` 工具调用会因为 stdio 断开而收到错误
- **不会**产生孤儿消息（飞书卡片仍然存在但回复会被静默丢弃）

### 6.3 多决策并发

```
Agent 发出决策A, 人类还没回 → Agent 又发出决策B
→ pending.size = 2
→ 人类回复"是" → 如果 B 的 options 包含"是", 匹配到 B
→ 否则 FIFO 匹配到 A
```

**⚠️ 风险**: 如果 A 和 B 的 options 有交集（如都是 ["是", "否"]），人类回复"是"时，代码遍历 pending Map 时先找到哪个取决于 Map 的迭代顺序（JS 的 Map 保持插入顺序，所以 A 先被遍历到，匹配到 A）。这是正确的，但不直观。

### 6.4 Agent 在不同目录工作 (v0.3.0 已修复)

配置加载采用向上递归查找 + 全局回退策略：

```
项目目录 A/  → 未找到 config.json
  └─ 向上查找 ../ → 未找到
    └─ 继续向上 ../../ → 未找到
      └─ 回退 ~/.notify-bridge/config.json → 命中!
```

Agent 在任意目录启动，只要在项目树任意层级或 home 目录有 `config.json` 即可工作。无需每个目录复制一份。

---

## 7. 已知限制

### 7.1 已修复项 (v0.2.0)

| 限制 | 修复 |
|------|------|
| 飞书卡片按钮不工作 | 注册 `card.action.trigger` 事件 |
| Token 不缓存 | TTL 缓存 + 60s 提前刷新 |
| 无速率限制 | 令牌桶: 决策 ≤5/min, 通知 ≤3/s |
| 凭证明文存储 | 强制环境变量 |
| 回复注入风险 | `selected_option` 隔离 + source 标记 |
| WebSocket stop 不彻底 | 尝试调用 SDK close/stop |

### 7.2 v0.3.0 规划修复项

| 限制 | 规划方案 |
|------|---------|
| 多用户 ID 覆盖 | 🔒 用户锁定 + 白名单机制 |
| 多决策并发错位 | 🎯 卡片按钮绑定 decisionId，精确匹配 |
| sendDecision 无超时 | ⏱️ Promise.race 5s 硬超时保护 |
| express 冗余依赖 | 🗑️ 移除 (飞书用 SDK WS, Telegram 用长轮询) |
| config.json 绑定 cwd | 📂 向上递归查找 + ~/.notify-bridge 回退 |

### 7.3 仍存在的限制

| 限制 | 影响 | 优先级 |
|------|------|--------|
| 无持久化 | 进程重启丢失挂起决策 | 低 |
| 超时无重试 | 网络瞬断导致超时 | 低 |
| 文本回复无法关联 decisionId | 纯文本降级到选项匹配 | 低 |

---

## 8. 测试策略

| 层级 | 文件 | 用例数 | 覆盖范围 |
|------|------|--------|---------|
| 单元测试 | `src/test.ts` | 18 | bridge 核心：创建、回复、超时、关闭、FIFO、选项匹配、频控 |
| 集成测试 | `src/integration-test.ts` | 16 | MCP 协议：initialize、tools/list、tools/call、bridge_status |
| 端到端测试 | `src/e2e-test.ts` | 手动 | 真实飞书 WebSocket 连接 + 用户发消息 |
| 连通性测试 | `src/sdk-test.ts` | 手动 | 飞书 SDK WSClient 连通性 |

### Mock 策略

- 单元测试使用 `MockAdapter`（对 `IMBotAdapter` 接口的内存实现）
- 集成测试使用 `BRIDGE_IM_TYPE=mock` 环境变量
- E2E 使用真实飞书凭证

---

## 9. 依赖清单

| 包 | 用途 | 许可 |
|----|------|------|
| `@modelcontextprotocol/sdk` | MCP 协议实现 | MIT |
| `@larksuiteoapi/node-sdk` | 飞书官方 SDK (WSClient) | MIT |
| `axios` | HTTP 请求 | MIT |
| `zod` | 参数校验 | MIT |

**v0.3.0 移除**: `express` 及 `@types/express` — 飞书使用 SDK WebSocket、Telegram 使用长轮询，均无需 HTTP server。移除后减少攻击面和内存开销。

---

## 10. 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| 0.1.0 | 2026-05-28 | 初始版本 |
| 0.2.0 | 2026-05-28 | 审计修复: 卡片事件、Token缓存、防注入、频控、凭证强制env |
| 0.3.0-draft | 2026-05-28 | 架构评审: 用户锁定+白名单、decisionId精确匹配、send超时保护、移除express、向上查找配置 |

## 11. 评审记录

| 日期 | 评审人 | 结论 | 关键发现 |
|------|--------|------|---------|
| 2026-05-28 | 一轮内审 | 不通过→修复后通过 | 5 项问题 (见 §7.2) |
| 2026-05-28 | 二轮评审 | 待定 | - |

## 12. 总结

notify-bridge 在**单用户 + 单人开发机**场景下是一个完整可用的 Human-in-the-Loop 方案。架构设计上采用 Promise 阻塞模式让工具调用自然地挂起 Agent 执行，适配器模式让 IM 平台可插拔。

v0.2.0 审计修复解决了初始版本中 6 项核心问题。v0.3.0 架构评审消除了用户身份覆盖、并发决策错位、配置查找失败等深层风险。目前仍存的限制主要是内存持久化和文本回复无法精确关联 decisionId，属于低优先级范畴。
