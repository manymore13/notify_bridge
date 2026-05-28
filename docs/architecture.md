# notify-bridge 系统架构文档

> 面向审阅者：本文档描述 notify-bridge 的完整系统架构、代码逻辑、数据流和潜在风险。适用于首次接触本项目的技术专家进行安全审计和架构评审。

---

## 1. 概述

**notify-bridge** 是一个 MCP (Model Context Protocol) Server，在 AI 编码 Agent（如 Claude Code、OpenCode）与即时通讯工具（飞书、Telegram）之间架设桥梁，实现 **Human-in-the-Loop** 远程决策。

**核心场景**: Agent 在编码过程中需要人类确认（删除文件、架构选型、危险操作等），但人不在电脑旁——Agent 通过 IM 发消息到人类手机，人类回复后 Agent 自动继续执行。

**版本**: 0.9.0 | **最后更新**: 2026-05-28 | **状态**: 正式封版 (Approved for Production)

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

#### 数据结构 & 存储抽象 (v0.4.0: IDecisionStore)

```typescript
// 存储接口抽象 (v0.6.0: 全面异步化 + 事件钩子)
// v0.8.0: 不 extends EventEmitter — 解耦 Node.js 运行时依赖
// 实现类自行选择继承 EventEmitter 或手动管理回调列表
interface IDecisionStore {
  get(id: string): Promise<PendingDecision | undefined>;
  set(id: string, entry: PendingDecision): Promise<void>;
  delete(id: string): Promise<boolean>;
  getAll(): Promise<[string, PendingDecision][]>;
  getSize(): Promise<number>;
  clear(): Promise<void>;

  // 显式声明事件方法签名，不依赖 Node.js 内置类
  on(event: "recovered" | "expired", cb: (entry: PendingDecision) => void): this;
  off(event: "recovered" | "expired", cb: (entry: PendingDecision) => void): this;
}

// 默认实现: 纯内存 (当前行为)
class MemoryDecisionStore implements IDecisionStore {
  private map = new Map<string, PendingDecision>();
  // ... 标准 Map 包装
}

// 可选实现: 文件持久化 (v0.6.0: 异步 + 防并发写入锁)
// v0.8.0: FileDecisionStore 自行选择继承 EventEmitter (仅 Node.js 平台)
class FileDecisionStore extends EventEmitter implements IDecisionStore {
  private map = new Map<string, PendingDecision>();
  private filePath: string;
  private isFlushing = false;
  private needsFlush = false;

  constructor(path: string) {
    super();
    this.filePath = path;
  }

  // 异步加载 + 恢复逻辑
  async loadFromDisk(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf-8"));
      const now = Date.now();
      for (const item of raw) {
        const remaining = item.timeoutMs - (now - item.createdAt);
        if (remaining <= 0) { this.emit("expired", item); continue; }
        const entry = this.rebuildEntry(item);
        this.map.set(item.id, entry);
        this.emit("recovered", entry);
      }
      await this.flushToDisk();
    } catch (err: any) {
      if (err.code !== "ENOENT") console.error(`[Store] 加载失败: ${err.message}`);
    }
  }

  // 防并发冲突的异步写锁 (v0.6.0)
  private async flushToDisk(): Promise<void> {
    if (this.isFlushing) { this.needsFlush = true; return; }
    this.isFlushing = true;
    try {
      const data = Array.from(this.map.values()).map(e => ({
        id: e.request.id, createdAt: e.request.createdAt,
        timeoutMs: e.request.timeoutMs, question: e.request.question,
      }));
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } finally {
      this.isFlushing = false;
      if (this.needsFlush) { this.needsFlush = false; await this.flushToDisk(); }
    }
  }

  async set(id: string, entry: PendingDecision): Promise<void> {
    this.map.set(id, entry); await this.flushToDisk();
  }
  async delete(id: string): Promise<boolean> {
    const ok = this.map.delete(id); if (ok) await this.flushToDisk(); return ok;
  }
  async get(id: string) { return this.map.get(id); }
  async getAll() { return Array.from(this.map.entries()); }
  async getSize() { return this.map.size; }
  async clear() { this.map.clear(); await this.flushToDisk(); }
  private rebuildEntry(item: any): PendingDecision { /* ... */ }
}
```

**使用方式**:

```typescript
class NotifyBridge {
  private store: IDecisionStore;

  constructor(adapter: IMBotAdapter, store?: IDecisionStore) {
    this.store = store || new MemoryDecisionStore();  // 默认内存
  }
}
```

**重启恢复 & Timer 重新绑定 (v0.5.0 修复僵尸决策)**:

v0.4.0 致命遗漏: `loadFromDisk()` 恢复决策后没有重新绑定 `setTimeout`。
定时器是 JS 运行时对象，无法被 `JSON.stringify` 序列化。
如果不重新绑定，恢复后的决策永远不会触发超时 → 变成 "僵尸挂起"，永久占用内存和磁盘。

**唯一方案: 事件驱动恢复 (v0.5.0 确定, v0.8.0 清除冗余)**:

`FileDecisionStore.loadFromDisk()` 不接受回调参数，通过 emit 事件通知外层。
`NotifyBridge.start()` 在 `init()` 之前注册事件监听器，确保 `loadFromDisk()` 触发的
`recovered` 事件能被捕获并重新绑定 `setTimeout`。

```typescript
// FileDecisionStore: 恢复时 emit 事件
async loadFromDisk(): Promise<void> {
  const raw = JSON.parse(await fs.readFile(this.filePath, "utf-8"));
  const now = Date.now();
  for (const item of raw) {
    const remaining = item.timeoutMs - (now - item.createdAt);
    if (remaining <= 0) { this.emit("expired", item); continue; }
    const entry = this.rebuildEntry(item);
    this.map.set(item.id, entry);
    this.emit("recovered", entry);  // ← 事件通知, 非回调
  }
  await this.flushToDisk();
}

// NotifyBridge.start(): 先注册事件, 再触发恢复
async start() {
  this.store.on("recovered", (entry) => {
    const remaining = entry.request.timeoutMs - (Date.now() - entry.request.createdAt);
    if (remaining <= 0) { await this.store.delete(entry.request.id); return; }
    entry.timer = setTimeout(() => {
      // ⚠️ setTimeout 不会 await 回调, 必须 try/catch 防 UnhandledRejection
      this.store.delete(entry.request.id).catch(err =>
        console.error(`[bridge] 恢复决策清理失败: ${err.message}`)
      );
      entry.reject(new Error("决策超时 (恢复后)"));
    }, remaining);
  });
  this.store.on("expired", (entry) => {
    this.store.delete(entry.request.id);
  });

  await this.adapter.init();
  await this.adapter.start((response) => this.handleReply(response));
  // loadFromDisk 在 init 内部或之后由 store 自身触发
}
```

**关键属性**: 默认 `MemoryDecisionStore` 保持现有行为。
`FileDecisionStore` 为可选增强，通过配置 `BRIDGE_PERSISTENT_STORE=true` 启用。

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

**sendDecision 发送超时保护 (v0.6.0: AbortController 防 Unhandled Rejection)**:

v0.5.0 致命缺陷: `Promise.race` 超时后 `sendDecision` 的原生 Promise 仍在后台运行。
若它在超时后发生 `reject`，由于外层 catch 已结束 → `UnhandledPromiseRejection` → **进程崩溃**。

```typescript
const SEND_TIMEOUT_MS = 5000;

async requestDecision(question, options, timeoutMs) {
  // ... 前置处理
  const abortController = new AbortController();

  try {
    await Promise.race([
      // 传递 AbortSignal 到底层 HTTP 请求，真正中止网络连接
      this.adapter.sendDecision(request, { signal: abortController.signal })
        .catch(err => {
          if (err.name === "AbortError") return;  // ← 吞掉中止错误
          throw err;
        }),
      new Promise((_, reject) =>
        setTimeout(() => {
          abortController.abort();  // 触发真正的网络请求取消
          reject(new Error("IM发送超时 (网关无响应)"));
        }, SEND_TIMEOUT_MS)
      ),
    ]);

    // 发送成功 → 注册业务超时 timer
    const timer = setTimeout(async () => {
      await this.store.delete(id);
      rejectFn(new Error(`决策超时 (${timeoutMs}ms)`));
    }, timeoutMs);
    entry.timer = timer;

  } catch (err) {
    clearTimeout(entry.timer);
    await this.store.delete(id);
    throw err;
  }

  return decisionPromise;
}
```

**关键修复**:
1. `AbortController.signal` 传递给适配器的 `sendDecision` → axios `{ signal }` → 真正中止 HTTP 连接
2. `.catch(err => { if (err.name === "AbortError") return; throw err; })` → 吞掉预期内的中止错误
3. 超时后不会产生 `UnhandledPromiseRejection`

**注意**: 适配器接口需增加可选 `options?: { signal?: AbortSignal }` 参数。

**⚠️ 残留风险**:
- 发送超时后 pending 条目已清理，但 IM 消息可能已送达（网络延迟导致 race condition）。
  **缓解**: 超时后 Agent 在终端重新展示问题。

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

#### stop() — 关闭 (v0.7.0: 适配 IDecisionStore 异步 API)

```typescript
async stop(): Promise<void> {
  const allPending = await this.store.getAll();
  for (const [, pending] of allPending) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Bridge shutting down"));
  }
  await this.store.clear();
  await this.adapter.stop();
}
```

遍历存储中的所有挂起决策 → 清除定时器 → reject Promise → 清空存储 → 关闭适配器。

#### checkDecisionRateLimit() — 频控 (v0.4.0: 服务端不阻塞，返回 retry_after)

```typescript
// 令牌桶: 决策 ≤5/分钟
private decisionTimestamps: number[] = [];

private checkDecisionRateLimit(): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  this.decisionTimestamps = this.decisionTimestamps.filter(t => now - t < 60000);

  if (this.decisionTimestamps.length >= 5) {
    const oldest = this.decisionTimestamps[0];
    const retryAfterMs = oldest + 60000 - now + 100;
    return { allowed: false, retryAfterMs };
  }

  this.decisionTimestamps.push(now);
  return { allowed: true };
}
```

**设计意图 (v0.4.0 重大修正)**:

v0.3.1 的致命问题: `await setTimeout()` 在 MCP Server 内部阻塞 → Node.js 单线程事件循环被挂起 → stdio 读取停止 → Claude 的 ping/其他工具调用全部积压 → 客户端超时 → 进程被 Kill。

```
错误链路: 频控触发 → setTimeout 60s → 事件循环阻塞 → stdio 卡死 → 进程被 Kill
```

v0.4.0 方案: **服务端立即返回，Agent 侧执行 sleep**。

```typescript
// bridge.ts: 频控检查失败 → 立即 throw (不阻塞)
async requestDecision(question, options, timeoutMs) {
  const check = this.checkDecisionRateLimit();
  if (!check.allowed) {
    throw new RateLimitError(check.retryAfterMs!);
  }
  // ... 正常流程
}
```

```typescript
// mcp-server.ts: 工具层捕获 RateLimitError → 返回 retry_after
async ({ question, options, timeout_ms }) => {
  try {
    const answer = await bridge.requestDecision(...);
    // ...
  } catch (err) {
    if (err instanceof RateLimitError) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "rate_limited",
          retry_after_ms: err.retryAfterMs,
          hint: `频控保护，请在 ${Math.round(err.retryAfterMs / 1000)} 秒后重试。不要连续重试。`,
        }) }],
        isError: true,
      };
    }
    // ... 其他错误处理
  }
}
```

**Agent System Prompt 规约** (在 AGENT_INSTRUCTIONS 中):

> 收到 `status: "rate_limited"` 时，必须等待 `retry_after_ms` 毫秒后再重试。
> 严禁忽略 retry_after_ms 直接重试。

**关键**: MCP Server 自身不做任何阻塞等待，始终立即返回。由 Agent 在其运行周期内执行 sleep，释放 stdio 通道。

#### getStatus() / getPendingDecisions() (v0.8.0: 异步化)

```typescript
// v0.8.0: IDecisionStore 异步化后，getPendingDecisions 必须改为 async
async getPendingDecisions(): Promise<{ id: string; question: string; elapsedMs: number }[]> {
  const now = Date.now();
  const entries = await this.store.getAll();  // ← await
  return entries.map(([, pending]) => ({
    id: pending.request.id,
    question: pending.request.question,
    elapsedMs: now - pending.request.createdAt,
  }));
}

getStatus(): { imType: string; ready: boolean; pendingCount: number; detail: any } {
  // getStatus 保持同步 — ready/pendingCount 基于内存计数器
  const adapterStatus = (this.adapter as any).getStatus?.() || {};
  return {
    imType: config.im.type,
    ready: (this.adapter as any).isReady?.() ?? true,
    pendingCount: this.pendingCount,    // 同步计数器
    detail: adapterStatus,
  };
}
```

`bridge_status` 工具中 await 调用：`const pending = await bridge.getPendingDecisions()`。

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

频控 (v0.4.0 新增):
{
  "status": "rate_limited",
  "retry_after_ms": 45000,
  "hint": "频控保护，请在 45 秒后重试。不要连续重试。"
}

超时:
{
  "status": "timeout",
  "error": "决策超时 (300s)...",
  "original_question": "...",  // 原始问题，供 Agent 重新展示
  "hint": "人类未在IM上回复。请在终端重新展示问题，直接获取回复。"
}
```

**warning 字段可能的值 (v0.3.1)**:

| warning 内容 | 触发条件 | Agent 行为 |
|-------------|---------|-----------|
| 无 (undefined) | 卡片按钮 + decisionId 精确匹配 | 正常执行 |
| `"回复不是预设选项，请检查是否为有效决策"` | selected_option 为 null | 忽略，重新询问 |
| `"文本回复无法关联决策ID，可能存在错位"` | 文本回复 + 多决策并发 | 谨慎处理，必要时重新确认 |

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

**身份重置机制 (v0.4.0 新增)**:

飞书 SDK `WSClient` 重连可能导致内部 session 重建；用户在企业内部身份变更（离职重入职）时 `open_id` 可能变化。如果 `lockedOpenId` 永久锁定在旧值上，合法用户将无法再触发决策。

```typescript
// 方案1: 进程重启重置 (最简单)
// lockedOpenId 在内存中，进程重启自动清空 → 重新捕获

// 方案2: MCP 工具显式重置
// bridge_reset 工具: 清空 lockedOpenId + lockedUserId + pending
// Agent 可调用或人类在飞书发 "!reset" 指令触发

// 方案3: 精准自愈 (v0.5.0: 仅身份失效错误码解锁)
// checkHealth() 连续 N 次发送失败 (code != 0, 如 user_not_found)
// → 自动解锁 + 日志告警 + 等待重新绑定
// v0.5.0: 仅身份失效错误码才累计，网络错误不解锁
private static readonly IDENTITY_INVALID_CODES = new Set([
  "user_not_found", "chat_not_found",
  "no_permission", "receive_id_not_authorized",
]);
private identityFailures = 0;

private async sendImMessage(...): Promise<void> {
  try {
    const res = await axios.post(...);
    if (res.data?.code === 0) { this.identityFailures = 0; return; }

    const errorType = res.data?.msg || "";
    if (FeishuAdapter.IDENTITY_INVALID_CODES.has(errorType)) {
      this.identityFailures++;
      if (this.identityFailures >= 3) {
        console.error(`[feishu] 身份失效 (${errorType})，自动解锁`);
        this.lockedOpenId = null;
        this.capturedChatId = null;
        this.identityFailures = 0;
      }
    }
    // 网络/限流/超时 → 不累计，不解锁
  } catch (err) {
    console.warn(`[feishu] 网络错误 (不触发解锁): ${err.message}`);
  }
}
```

**安全状态机 (v0.6.0: PENDING_REBIND 防二次劫持)**:

v0.5.0 致命缺陷: 自动解锁后回退到 `UNBOUND` 状态 → 任何同事发消息即可劫持身份。

```
状态转换图:

  UNBOUND ──首次合法消息──► BOUND_LOCKED ──连续3次身份失效错误码──► PENDING_REBIND
      ▲                         │                                        │
      │                         │ 其余错误码                              │
      │                         ▼ (不转换)                               │
      └──────────────────── 仅进程重启或管理员手动指令 ──────────────────┘
      (任何人发消息无法从 PENDING_REBIND 回到 UNBOUND!)
```

```typescript
enum AuthState {
  UNBOUND = 0,         // 初始未绑定
  BOUND_LOCKED = 1,    // 已锁定有效用户
  PENDING_REBIND = 2,  // 身份失效，等待安全重绑 (拒绝任何新用户消息)
}

private authState: AuthState = AuthState.UNBOUND;

// 身份失效时：
if (this.identityFailures >= 3) {
  console.error(`[feishu] 🚨 身份彻底失效，进入 PENDING_REBIND 锁定状态`);
  this.authState = AuthState.PENDING_REBIND;  // ← 不回退到 UNBOUND!
  this.lockedOpenId = null;
  this.identityFailures = 0;
}

// 处理入站事件时：
function handleIncomingEvent(operatorId: string): void {
  if (this.authState === AuthState.PENDING_REBIND) {
    console.warn(`[feishu] PENDING_REBIND: 拒绝 ${operatorId} 的请求。请重启服务或执行 bridge_reset。`);
    return;  // ← 任何人的消息都被拒绝，不捕获不锁定!
  }
  // ... 正常处理
}
```

**重置策略**:
- 进程重启 → `UNBOUND` (重新捕获)
- 身份失效错误码 × 3 → `PENDING_REBIND` (拒绝所有人，等待管理员介入)
- 网络错误 / 限流 / 超时 → 不转换状态
- `bridge_reset` MCP 工具 → 回到 `UNBOUND` (需在本地终端确认)

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
        ├─ 身份校验 (v0.3.1 新增): 提取 event.operator.open_id
        │    ├─ 白名单检查: allowedUsers 非空 → 必须在白名单中
        │    └─ 锁定检查: lockedOpenId 非空 → 必须匹配
        ├─ 解析 action.value: JSON.parse → {id: decisionId, option: "是"}
        ├─ 向下兼容: 非 JSON value 视为纯选项文本 (decisionId 为空)
        └─ 调用 onReply({ decisionId, answer }) → bridge.handleReply()
```

**卡片按钮现已生效**: `card.action.trigger` 事件已在 EventDispatcher 中注册。
用户点击飞书卡片按钮 → `handleCardAction()` 提取按钮值 → 传给 `bridge.handleReply()`。

**handleCardAction 安全校验 (v0.3.1 新增)**:

```typescript
function handleCardAction(data): void {
  // ⚠️ 必须与 handleMessageEvent 使用相同的身份校验
  const operatorOpenId = data.event?.operator?.open_id
                      || data.event?.operator?.user_id;

  // 白名单检查
  if (this.allowedUsers.size > 0 && !this.allowedUsers.has(operatorOpenId)) {
    console.warn(`[feishu] 非白名单用户 ${operatorOpenId} 卡片点击已丢弃`);
    return;
  }
  // 锁定检查
  if (this.lockedOpenId && operatorOpenId !== this.lockedOpenId) {
    console.warn(`[feishu] 非锁定用户 ${operatorOpenId} 卡片点击已丢弃`);
    return;
  }

  // v0.8.0 修复: 首次点击触发锁定 (与 handleMessageEvent 行为一致)
  // 修复前: 用户只点卡片不发文字 → lockedOpenId 永远为 null → 任何人点卡片都通过
  if (!this.lockedOpenId && operatorOpenId) {
    this.lockedOpenId = operatorOpenId;
    this.authState = AuthState.BOUND_LOCKED;
    console.log(`[feishu] 🔒 卡片点击锁定用户: ${operatorOpenId}`);
  }

  // 安全校验通过，解析按钮值
  const raw = data.event?.action?.value || data.action?.value;
  let decisionId = "", answer = raw;
  try {
    const parsed = JSON.parse(raw);
    decisionId = parsed.id || "";
    answer = parsed.option || raw;
  } catch { /* 兼容旧格式 */ }

  this.onReply?.({ decisionId, answer, respondedAt: Date.now() });
}
```

**安全边界闭合**: 卡片点击与文本消息共享完全相同的白名单 + 锁定检查。
非授权用户点击卡片按钮 → 事件被丢弃，不会触发决策回复。

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

**v0.6.0 致命修复: `start()` 不再阻塞 MCP 初始化**:

```typescript
// v0.5.0 (旧): start() 内部 await 死循环 → MCP 初始化永久挂起
async start(cb) {
  while (this.polling) { await getUpdates(); }  // ← 永不返回!
}

// v0.6.0 (新): start() 立即返回, 循环在后台 fire-and-forget
async start(callback) {
  this.onReplyCallback = callback;
  if (this.polling) return;
  this.polling = true;
  this.pollUpdates();  // 不 await, 后台运行
  return Promise.resolve();
}

private pollAbortController = new AbortController();

async pollUpdates() {
  while (this.polling) {
    try {
      const res = await axios.get(`${apiBase}/getUpdates`, {
        params: { offset: this.lastUpdateId + 1, timeout: 30 },
        signal: this.pollAbortController.signal,  // ← 可被 stop() 中断
      });
      for (const update of res.data.result) {
        this.lastUpdateId = update.update_id;
        this.handleUpdate(update);
      }
    } catch (err: any) {
      if (err.name === "AbortError") return;  // ← stop() 触发的预期中断
      console.warn(`[telegram] 轮询异常: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async stop(): Promise<void> {
  this.polling = false;
  this.pollAbortController.abort();  // ← 立即杀死进行中的 30s 长轮询
  return Promise.resolve();
}
```

#### 差异点

| 特性 | 飞书 | Telegram |
|------|------|----------|
| 连接 | WebSocket 长连接 | HTTP 长轮询 |
| 消息格式 | 交互式卡片 | Markdown + ReplyKeyboard |
| 用户身份 | 自动捕获 + 锁定 open_id | 配置中指定 chat_id + from.id 校验 |
| 重连 | SDK 自动 | 循环自动恢复 |
| 群组安全 | 白名单校验 | from.id 个人身份校验 |

#### Telegram 身份校验 (v0.3.1 新增)

Telegram 的 `chat_id` 固定并不意味着安全——如果配置的是**群组** ID，群内所有成员都能看到并回复 Agent 的决策。

```typescript
// 在 poll() 循环中处理消息时:
for (const update of res.data.result) {
  const msg = update.message;
  if (!msg?.text) continue;

  // ⚠️ 必须校验发送者个人 ID，不能仅信任 chat_id
  const senderId = msg.from?.id?.toString();
  if (!senderId) continue;

  // 白名单校验 (环境变量 TELEGRAM_ALLOWED_USER_IDS)
  if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(senderId)) {
    console.warn(`[telegram] 非授权用户 ${senderId} 消息已丢弃`);
    continue;
  }

  // 锁定: 首次回复的用户成为唯一授权者
  if (!this.lockedUserId) {
    this.lockedUserId = senderId;
    console.log(`[telegram] 🔒 锁定用户: ${senderId}`);
  }
  if (senderId !== this.lockedUserId) {
    console.warn(`[telegram] 非锁定用户 ${senderId} 消息已丢弃`);
    continue;
  }

  // ... 继续处理
}
```

**配置**: 新增可选环境变量 `TELEGRAM_ALLOWED_USER_IDS`（逗号分隔的 Telegram 用户 ID）。
未配置时首次回复者自动锁定（与飞书行为一致）。

---

### 3.5 适配器生命周期 & 健康检查 (v0.4.0 新增)

当前各适配器的初始化、Token 维护、连接维持逻辑各自为战，不利于扩展第三个 IM 平台。

#### IMBotAdapter 接口规范化 (v0.4.0)

```typescript
interface HealthStatus {
  status: "healthy" | "unhealthy" | "connecting";
  reason?: string;
  details?: Record<string, any>;
}

// v0.8.0: abstract base class 替代可选方法
abstract class BaseBotAdapter implements IMBotAdapter {
  // ── 子类必须实现 ──
  abstract init(): Promise<void>;
  abstract start(callback: (r: DecisionResponse) => void): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendDecision(req: DecisionRequest, opts?: { signal?: AbortSignal }): Promise<void>;
  abstract sendNotification(message: string): Promise<void>;

  // ── 有默认实现，可覆盖 ──
  async checkHealth(): Promise<HealthStatus> { return { status: "healthy" }; }
  isReady(): boolean { return true; }
  getStatus(): Record<string, any> { return {}; }
}

interface IMBotAdapter {
  init(): Promise<void>;
  start(callback: (r: DecisionResponse) => void): Promise<void>;
  stop(): Promise<void>;
  sendDecision(req: DecisionRequest, opts?: { signal?: AbortSignal }): Promise<void>;
  sendNotification(message: string): Promise<void>;
  checkHealth(): Promise<HealthStatus>;
  isReady(): boolean;
  getStatus(): Record<string, any>;
}
```

#### init() vs start() 职责分离 (v0.5.0 明确语义)

v0.4.0 的问题: 飞书把所有逻辑塞进 `start()`，Telegram 把长轮询死循环塞进 `start()`。
两个适配器的职责分层不一致，外层控制代码无法可靠地在 `init()` 之后执行自检。

v0.5.0 严格规定单一职责:

| 阶段 | 职责 | 飞书 | Telegram |
|------|------|------|----------|
| `init()` | 建立连接 & 鉴权 | `new WSClient` + 等待 `open` | `getMe()` 探活 |
| `start(cb)` | 使能监听，分发事件 (立即返回) | 存储 cb (连接已就绪) | `pollUpdates()` fire-and-forget |
| `checkHealth()` | 健康探针 | WS === OPEN && Token 有效 | 30s内 getUpdates 成功 |

**NotiftyBridge 启动流程规范化**:

```typescript
async start() {
  this.setupStoreEvents();          // 1. 恢复持久化状态
  await this.adapter.init();         // 2. 建立连接 & 鉴权
  if (adapter.checkHealth) {         // 3. 连接就绪后自检
    const h = await adapter.checkHealth();
    if (h.status === "unhealthy") throw new Error(h.reason);
  }
  await this.adapter.start(cb);      // 4. 一切就绪，使能流量
}
```

**执行保证**: `init()` 返回后 WebSocket 必须是 CONNECTED / Telegram API 至少成功探活过一次。
`start()` 仅负责解封流量，不负责建立连接。

#### bridge_status 改造

当前 `bridge_status` 返回静态配置信息。v0.4.0 改造为调用适配器的 `checkHealth()` 做真正的健康探针：

```typescript
// mcp-server.ts: bridge_status 工具
async () => {
  const health = adapter.checkHealth
    ? await adapter.checkHealth()
    : { status: "healthy" as const, reason: "adapter health check" };

  const pendingDecisions = await bridge.getPendingDecisions();  // v0.8.0: await

  return {
    content: [{ type: "text", text: JSON.stringify({
      im_type: config.im.type,
      adapter_health: health,
      ready: adapter.isReady?.() ?? true,
      pending_count: pendingDecisions.length,
      store_type: store instanceof FileDecisionStore ? "file" : "memory",
    }) }],
  };
};
```

**健康探针实现要求**:
- 飞书: 检查 WebSocket 连接状态 (OPEN / CLOSED) + Token 是否有效 + lockedOpenId 是否设置
- Telegram: 检查最近一次 `getUpdates` 是否成功 (30s 内有过成功响应)
- 通用: 检查凭证是否存在 (`appSecret` / `botToken` 非空)

---

### 3.6 配置加载 (`config.ts`) (v0.3.0: 向上查找 + 全局回退)

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

### 3.7 Setup 命令 (`setup.ts`)

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
| ~~回复注入~~ | ~~低~~ | ✅ v0.2.0: selected_option 隔离 + source 标记 | Agent 按结构执行 |
| ~~卡片点击绕过白名单~~ | ~~高~~ | ✅ v0.3.1: handleCardAction 引入同等的白名单+锁定检查 | 卡片与消息同等安全检查 |
| Agent 频控死锁重试 | ~~中~~ | ✅ v0.3.1: backoff/sleep 替代抛异常 | 物理延迟拉低重试频率 |
| Telegram 群组成员劫持 | ~~中~~ | ✅ v0.3.1: from.id 校验 + 用户锁定 | 群组内仅授权用户可回复 |

### 5.2 审计修复记录

#### v0.2.0

| 问题 | 状态 | 修复方式 |
|------|------|---------|
| 回复注入 | ✅ | `selected_option` 隔离 + `source: "im"` 标记 |
| 凭证明文存储 | ✅ | 强制环境变量 |
| 无速率限制 | ✅ | 令牌桶限流 |
| 卡片按钮不工作 | ✅ | 注册 `card.action.trigger` |
| Token 无缓存 | ✅ | TTL 缓存 + 60s 提前刷新 |

#### v0.3.1

| 问题 | 状态 | 修复方式 |
|------|------|---------|
| 卡片点击绕过白名单 | ✅ | handleCardAction 引入同等的白名单+锁定检查 |
| 文本回复多并发错位 | ✅ | 文档明确标注限制，warning 字段标记错位风险 |
| Telegram 群组成员劫持 | ✅ | from.id 校验 + lockedUserId + TELEGRAM_ALLOWED_USER_IDS |
| Agent 频控死锁 | ✅ | throw → sleep/backoff 阻塞等待 |

#### v0.4.0

| 问题 | 状态 | 修复方式 |
|------|------|---------|
| backoff 阻塞导致 stdio 死锁 | ✅ | 服务端不阻塞，返回 `retry_after_ms`，Agent 侧 sleep |
| lockedOpenId 永久失效 | ✅ | 连续发送失败自动解锁 + 进程重启重置 |
| pending 内存无持久化 | ✅ | `IDecisionStore` 抽象 + `FileDecisionStore` 可选 |
| 适配器无统一生命周期 | ✅ | `IMBotAdapter` 增加 `init()` + `checkHealth()` + `isReady()` |

### 5.3 仍待关注

1. **伪造回复**: 飞书的 `open_id` 和 Telegram 的 `from.id` 可能被伪造（依赖 IM 平台自身的身份保证）。
2. **FileDecisionStore 恢复语义**: 重启后 Promise 无法恢复，需明确定义恢复行为（reject + 通知 Agent）。

---

## 6. 弹性与边缘场景

### 6.1 WebSocket 断开

- **飞书**: SDK 内置自动重连，重连后 `capturedOpenId` 仍在内存中，可继续发送消息
- **Telegram**: 长轮询循环自动恢复

### 6.2 进程崩溃

- `pending` Map 在内存中 → 崩溃后所有挂起决策永久丢失
- Agent 的 `request_decision` 工具调用会因为 stdio 断开而收到错误
- **不会**产生孤儿消息（飞书卡片仍然存在但回复会被静默丢弃）

### 6.3 多决策并发 (v0.3.1: 文本回复限制)

```
Agent 发出决策A (id=aaa), 人类还没回 → Agent 又发出决策B (id=bbb)
→ pending.size = 2

场景1: 人类点卡片按钮
  → 按钮 value = {id: "bbb", option: "是"}
  → handleCardAction 解析 → decisionId="bbb"
  → bridge.handleReply → decisionId 精确匹配 → resolve B ✅

场景2: 人类文本回复 "是"
  → decisionId 为空
  → 选项匹配: 遍历 pending, 找 options 包含 "是" 的
    → A.options = ["是","否"] 第一个命中 → 匹配到 A ⚠️
    → B 的 options 永远不会被检查 (A 已命中)
  → 结果: 文本回复永远匹配到最旧的包含该选项的决策
```

**⚠️ 文本回复的固有局限**:

由于纯文本无法携带 `decisionId`，当多个决策共享相同的 options 时：
- **文本回复永远命中 Map 中插入最早的那个决策**（JS Map 保持插入顺序）
- 在 options 为 `["是","否"]` 的常见场景下，无法通过文本回复区分 A 和 B
- 这不是 bug，而是纯文本通道的本质限制

**强制规则 (v0.3.1)**:
- 多决策并发时，**强烈建议用户仅使用卡片按钮进行交互**
- 文本回复在 `warning` 字段中标记 `"文本回复无法关联决策ID，可能存在错位"`
- Agent 在收到 warning 时应格外谨慎，必要时重新确认

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

### 7.2 v0.3.0 规划修复项 (全部完成)

| 限制 | 状态 |
|------|------|
| 多用户 ID 覆盖 | ✅ 用户锁定 + 白名单 |
| 多决策并发错位 | ✅ decisionId 精确匹配 |
| sendDecision 无超时 | ✅ Promise.race 5s |
| express 冗余依赖 | ✅ 已移除 |
| config.json 绑定 cwd | ✅ 向上查找 + 全局回退 |

### 7.3 v0.3.1 规划修复项 (全部完成)

| 限制 | 状态 |
|------|------|
| 卡片点击绕过白名单 | ✅ |
| Telegram 群组劫持 | ✅ |
| 频控死锁 (抛异常 → 重试) | ✅ |
| 文档 6.3 节逻辑冲突 | ✅ |

### 7.4 v0.4.0 规划修复项 (全部完成)

| 限制 | 状态 |
|------|------|
| backoff 阻塞导致 stdio 死锁 | ✅ |
| lockedOpenId 永久失效 | ✅ |
| pending 无持久化 | ✅ |
| 适配器无统一生命周期 | ✅ |

### 7.5 v0.5.0 规划修复项

| 限制 | 状态 |
|------|------|
| FileDecisionStore 重启后 Timer 丢失 → 僵尸决策 | ✅ 恢复后重新绑定 setTimeout |
| 自愈算法网络抖动误杀 | ✅ 仅 IDENTITY_INVALID_CODES 触发解锁 |
| IDecisionStore 缺乏事件通知 | ✅ on("recovered"/"expired") 事件钩子 |
| init/start 职责混淆 | ✅ init=连接, start=监听 语义分离 |

### 7.6 仍存在的限制

| 限制 | 影响 | 优先级 |
|------|------|--------|
| 文本回复无法关联 decisionId | 纯文本降级到选项匹配 + warning | 低 |
| IM 身份依赖平台保证 | 理论上 open_id/from.id 可伪造 | 极低 |

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
| 0.3.1-draft | 2026-05-28 | 二轮评审: 卡片点击安全校验、Telegram from.id验证、频控backoff防死锁、文本错位文档修正 |
| 0.4.0-draft | 2026-05-28 | 三轮评审: 频控改为retry_after不阻塞stdio、lockedOpenId自愈重置、IDecisionStore持久化抽象、适配器生命周期规范化 |
| 0.5.0-draft | 2026-05-28 | 四轮评审: 重启Timer重绑定、自愈精准错误码防误杀、IDecisionStore事件驱动、init/start职责分离 |
| 0.6.0-draft | 2026-05-28 | 五轮评审: Telegram start()去阻塞、AbortController防崩溃、Store异步化+写锁、PENDING_REBIND安全状态机 |
| 0.7.0 | 2026-05-28 | 封版: stop()适配IDecisionStore异步API、Telegram轮询AbortController优雅退出 |
| 0.8.0 | 2026-05-28 | 六轮评审: handleCardAction锁定、bridge_status await、清除回调冗余、IDecisionStore解耦EventEmitter、BaseBotAdapter基类 |
| 0.9.0 | 2026-05-28 | 正式封版: setTimeout防UnhandledRejection、EventEmitter组合替代继承、代码落地注意事项 |

## 11. 评审记录

| 日期 | 轮次 | 结论 | 关键发现 |
|------|------|------|---------|
| 2026-05-28 | 一轮 | 不通过→修复后通过 | 5项: open_id覆盖、并发错位、发送死锁、express冗余、cwd绑定 |
| 2026-05-28 | 二轮 | Conditionally Approved → 通过 | 4项: 卡片点击绕过白名单、文本错位文档冲突、Telegram群组劫持、频控死锁 |
| 2026-05-28 | 三轮 | Conditional Disapproval → 待修复 | 4项: backoff阻塞stdio致命Bug、lockedOpenId假死、无持久化抽象、适配器无生命周期 |
| 2026-05-28 | 四轮 | Pass with Revision → 小修后发布 | 4项: 重启Timer丢失、自愈误杀、存储无事件、init/start混淆 |
| 2026-05-28 | 五轮 | Pass with Revision → 趋于完美 | 4项: Telegram死循环、UnhandledRejection、Store同步I/O、解锁劫持 |
| 2026-05-28 | 终审 | Approved for Production ✅ | 2项微瑕: stop()旧API残留、Telegram轮询非优雅退出 |
| 2026-05-28 | 六轮 | Conditional Disapproval → 修复后通过 | 3Bug + 3架构 |
| 2026-05-28 | 终审 | Approved for Production ✅ | 2微瑕: setTimeout回调异常、EventEmitter类型冲突 (代码级备忘) |

## 12. 代码落地注意事项 (v0.9.0)

架构层面已无硬伤，以下为代码编写时的微观注意事项：

### 12.1 setTimeout 异步回调防崩溃

```typescript
// ❌ 错误: setTimeout 的 async 回调抛异常 → UnhandledPromiseRejection → 进程崩溃
entry.timer = setTimeout(async () => {
  await this.store.delete(entry.request.id);
}, remaining);

// ✅ 正确: .catch() 吞掉异常, 确保进程不被回调内部错误杀死
entry.timer = setTimeout(() => {
  this.store.delete(entry.request.id).catch(err =>
    console.error(`[bridge] 清理失败: ${err.message}`)
  );
}, remaining);
```

### 12.2 EventEmitter 继承时的 TypeScript 类型冲突

`FileDecisionStore` 若直接 `extends EventEmitter implements IDecisionStore`，
在严格模式下 `EventEmitter.on(string|symbol, (...any[]) => void)` 与
`IDecisionStore.on("recovered"|"expired", (PendingDecision) => void)` 签名不兼容。

**推荐方案: 组合替代继承**：

```typescript
class FileDecisionStore implements IDecisionStore {
  private emitter = new EventEmitter();  // 组合, 不继承

  on(event: "recovered" | "expired", cb: (entry: PendingDecision) => void): this {
    this.emitter.on(event, cb);
    return this;
  }
  off(event: "recovered" | "expired", cb: (entry: PendingDecision) => void): this {
    this.emitter.off(event, cb);
    return this;
  }
}
```

解耦 `EventEmitter` 的类型系统, 避免编译期签名冲突。

---

## 13. 总结

notify-bridge 在**单用户 + 单人开发机**场景下是一个完整可用的 Human-in-the-Loop 方案。架构设计上采用 Promise 阻塞模式让工具调用自然地挂起 Agent 执行，适配器模式让 IM 平台可插拔。

v0.2.0 审计修复解决了初始版本中 6 项核心问题。v0.3.0 架构评审消除了用户身份覆盖、并发决策错位、配置查找失败等深层风险。目前仍存的限制主要是内存持久化和文本回复无法精确关联 decisionId，属于低优先级范畴。
