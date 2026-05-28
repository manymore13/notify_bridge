# notify-bridge 系统架构文档

> 面向审阅者：本文档描述 notify-bridge 的完整系统架构、代码逻辑、数据流和潜在风险。适用于首次接触本项目的技术专家进行安全审计和架构评审。

---

## 1. 概述

**notify-bridge** 是一个 MCP (Model Context Protocol) Server，在 AI 编码 Agent（如 Claude Code、OpenCode）与即时通讯工具（飞书、Telegram）之间架设桥梁，实现 **Human-in-the-Loop** 远程决策。

**核心场景**: Agent 在编码过程中需要人类确认（删除文件、架构选型、危险操作等），但人不在电脑旁——Agent 通过 IM 发消息到人类手机，人类回复后 Agent 自动继续执行。

**版本**: 0.11.0 | **最后更新**: 2026-05-28 | **状态**: 八轮评审修复

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
// v0.8.0: 不 extends EventEmitter — 解耦 Node.js 运行时依赖
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
```

#### RateLimitError (v0.4.0 新增)

```typescript
class RateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super(`频控: 请等待 ${Math.round(retryAfterMs / 1000)}s 后重试`);
  }
}
```

---

### 3.2 MCP Server 层 (`mcp-server.ts`)

在 MCP 协议上注册 4 个工具，使用 Zod schema 做参数校验。

| 工具名 | 阻塞 | 用途 |
|--------|------|------|
| `request_decision` | 是 | 发决策请求到 IM，阻塞等回复 |
| `send_notification` | 否 | 发纯通知到 IM |
| `check_pending` | 否 | 查看当前挂起的决策列表 |
| `bridge_status` | 否 | 检查 IM 连接状态 |

---

### 3.3 飞书适配器 (`adapters/feishu.ts`)

使用 **@larksuiteoapi/node-sdk** 官方 SDK 的 `WSClient` 建立 WebSocket 长连接。

**安全状态机**:

```
UNBOUND → 首次捕获 → BOUND_LOCKED
                            │
                    身份失效错误码 × 3
                            │
                            ▼
                      PENDING_REBIND (拒绝所有人)
```

---

### 3.4 Telegram 适配器 (`adapters/telegram.ts`)

使用 Telegram Bot API 的 **Long Polling** (`getUpdates`) 接收消息。

---

### 3.5 配置加载 (`config.ts`)

向上递归查找 + `~/.notify-bridge` 回退。凭证强制环境变量。

---

### 3.6 Setup 命令 (`setup.ts`)

```bash
notify-bridge setup           # 项目级 → .claude/mcp.json
notify-bridge setup --global  # 全局   → ~/.claude/settings.json
```

---

## 4. 完整数据流

### 4.1 正常决策流程

```
T+0s     Agent 调 request_decision("是否删文件?", ["是","否"])
T+0.1s   bridge.requestDecision() 频控检查 → 创建 Promise + store.set()
T+0.2s   adapter.sendDecision() 发飞书卡片 (value = {id, option})
T+0.3s   Promise 返回，工具进入阻塞状态, Agent 挂起
T+15s    人类点卡片按钮"是"
T+15.1s  飞书推送 card.action.trigger → handleCardAction() → PENDING_REBIND检查 → BOUND锁定 → 解析{id, option}
T+15.2s  bridge.handleReply() → decisionId 精确匹配 → resolve("是")
T+15.3s  工具返回 { status: "answered", selected_option: "是", source: "im" }
T+15.4s  Agent 严格按 selected_option 执行
```

### 4.2 超时流程

```
T+5s     setTimeout → store.delete(id).catch() + reject("超时")
         工具返回 { status: "timeout", original_question: "...", hint: "..." }
```

### 4.3 频控流程

```
T+0s     调 request_decision → checkDecisionRateLimit() → 未通过
         立即 throw RateLimitError(retryAfterMs)
         工具返回 { status: "rate_limited", retry_after_ms: N, hint: "..." }
         Agent 侧 sleep(retryAfterMs) → 重试
```

---

## 5. 安全性

### 5.1 威胁模型

| 威胁 | 状态 | 缓解 |
|------|------|------|
| 凭证明文存储 | ✅ | 强制环境变量 |
| 回复注入 | ✅ | selected_option 隔离 |
| 卡片点击绕过白名单 | ✅ | handleCardAction 白名单+锁定+PENDING_REBIND |
| 多用户 ID 覆盖 | ✅ | BOUND_LOCKED + PENDING_REBIND |
| Telegram 群组劫持 | ✅ | from.id + lockedUserId |
| 频控死锁 | ✅ | retry_after_ms，Agent 侧 sleep |

### 5.2 仍待关注

- IM 身份依赖平台保证
- 文本回复无法关联 decisionId（降级 + warning）
- 进程重启丢弃未决决策（Promise 不可恢复，设计如此）

---

## 6. 已知限制

| 限制 | 影响 | 优先级 |
|------|------|--------|
| 文本回复无法关联 decisionId | 降级到选项匹配 + warning | 低 |
| IM 身份依赖平台保证 | open_id/from.id 可伪造 | 极低 |

---

## 7. 依赖清单

| 包 | 用途 | 许可 |
|----|------|------|
| `@modelcontextprotocol/sdk` | MCP 协议实现 | MIT |
| `@larksuiteoapi/node-sdk` | 飞书官方 SDK (WSClient) | MIT |
| `axios` | HTTP 请求 | MIT |
| `zod` | 参数校验 | MIT |

---

## 8. 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| 0.1.0 | 2026-05-28 | 初始版本 |
| 0.2.0 | 2026-05-28 | 审计修复: 卡片事件、Token缓存、防注入、频控、凭证强制env |
| 0.3.0 | 2026-05-28 | 用户锁定+白名单、decisionId精确匹配、send超时、移除express、向上查找配置 |
| 0.4.0 | 2026-05-28 | 频控retry_after、lockedOpenId自愈、IDecisionStore持久化、适配器生命周期 |
| 0.5.0 | 2026-05-28 | Timer重绑定、精准自愈错误码、事件驱动恢复、init/start分离 |
| 0.6.0 | 2026-05-28 | Telegram去阻塞、AbortController防崩溃、Store异步化+写锁、PENDING_REBIND安全机 |
| 0.7.0 | 2026-05-28 | 封版: stop()适配Store、Telegram优雅退出 |
| 0.8.0 | 2026-05-28 | 卡片锁定、bridge_status await、清除回调冗余、解耦EventEmitter、BaseBotAdapter |
| 0.9.0 | 2026-05-28 | setTimeout防崩溃、EventEmitter组合替代继承、代码落地注意事项 |
| 0.10.0 | 2026-05-28 | 裸await修复、setTimeout去async、handleReply异步化、loadFromDisk时机、统一store.getSize |
| 0.11.0 | 2026-05-28 | 持久化恢复改为审计模式(不恢复Promise)、PENDING_REBIND全局门禁、MemoryDecisionStore EventEmitter |