import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import type { IMBotAdapter, DecisionRequest, DecisionResponse } from "./adapters/types.js";
import { config } from "./config.js";

// ── IDecisionStore ──

export interface PendingDecision {
  request: DecisionRequest;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface IDecisionStore {
  get(id: string): Promise<PendingDecision | undefined>;
  set(id: string, entry: PendingDecision): Promise<void>;
  delete(id: string): Promise<boolean>;
  getAll(): Promise<[string, PendingDecision][]>;
  getSize(): Promise<number>;
  clear(): Promise<void>;
  on(event: "recovered" | "expired", cb: (entry: PendingDecision) => void): this;
  off(event: "recovered" | "expired", cb: (entry: PendingDecision) => void): this;
}

// ── MemoryDecisionStore ──

export class MemoryDecisionStore implements IDecisionStore {
  private map = new Map<string, PendingDecision>();
  private emitter = new EventEmitter();

  async get(id: string) { return this.map.get(id); }
  async set(id: string, entry: PendingDecision) { this.map.set(id, entry); }
  async delete(id: string) { return this.map.delete(id); }
  async getAll() { return Array.from(this.map.entries()); }
  async getSize() { return this.map.size; }
  async clear() { this.map.clear(); }

  on(event: "recovered" | "expired", cb: (entry: PendingDecision) => void): this {
    this.emitter.on(event, cb); return this;
  }
  off(event: "recovered" | "expired", cb: (entry: PendingDecision) => void): this {
    this.emitter.off(event, cb); return this;
  }
}

// ── FileDecisionStore (持久化) ──

export class FileDecisionStore extends EventEmitter implements IDecisionStore {
  private map = new Map<string, PendingDecision>();
  private filePath: string;
  private isFlushing = false;
  private needsFlush = false;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  /** 审计模式: 日志记录 + 清空文件, 不恢复 Promise */
  async loadFromDisk(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf-8"));
      const now = Date.now();
      let abandoned = 0;
      for (const item of raw) {
        const remaining = item.timeoutMs - (now - item.createdAt);
        if (remaining > 0) {
          abandoned++;
          console.warn(`[store] 丢弃未完成决策 id=${(item.id || "").slice(0, 8)} (进程重启)`);
        }
      }
      if (abandoned > 0) console.warn(`[store] 已丢弃 ${abandoned} 个旧决策`);
      await fs.writeFile(this.filePath, "[]", "utf-8");
    } catch (err: any) {
      if (err.code !== "ENOENT") console.error(`[store] 加载失败: ${err.message}`);
    }
  }

  private async flushToDisk(): Promise<void> {
    if (this.isFlushing) { this.needsFlush = true; return; }
    this.isFlushing = true;
    try {
      const data = Array.from(this.map.values()).map((e) => ({
        id: e.request.id,
        createdAt: e.request.createdAt,
        timeoutMs: e.request.timeoutMs,
        question: e.request.question,
      }));
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } finally {
      this.isFlushing = false;
      if (this.needsFlush) { this.needsFlush = false; await this.flushToDisk(); }
    }
  }

  async get(id: string) { return this.map.get(id); }
  async set(id: string, entry: PendingDecision) { this.map.set(id, entry); await this.flushToDisk(); }
  async delete(id: string) { const ok = this.map.delete(id); if (ok) await this.flushToDisk(); return ok; }
  async getAll() { return Array.from(this.map.entries()); }
  async getSize() { return this.map.size; }
  async clear() { this.map.clear(); await this.flushToDisk(); }

  on(event: "recovered" | "expired", cb: (entry: PendingDecision) => void): this {
    super.on(event, cb); return this;
  }
  off(event: "recovered" | "expired", cb: (entry: PendingDecision) => void): this {
    super.off(event, cb); return this;
  }
}

// ── RateLimitError ──

export class RateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super(`频控: 请等待 ${Math.round(retryAfterMs / 1000)}s 后重试`);
  }
}

// ── NotifyBridge ──

const SEND_TIMEOUT_MS = 5000;

export class NotifyBridge {
  private adapter: IMBotAdapter;
  private store: IDecisionStore;

  // 频控
  private decisionTimestamps: number[] = [];
  private notificationTimestamps: number[] = [];

  constructor(adapter: IMBotAdapter, store?: IDecisionStore) {
    this.adapter = adapter;
    this.store = store || new MemoryDecisionStore();
  }

  async start(): Promise<void> {
    // 1. 清理旧进程遗留
    if (this.store instanceof FileDecisionStore) {
      await this.store.loadFromDisk();
    }
    // 2. 建立连接 & 鉴权
    await this.adapter.init();
    const health = await this.adapter.checkHealth();
    if (health.status === "unhealthy") throw new Error(`Adapter unhealthy: ${health.reason}`);
    // 3. 使能流量
    await this.adapter.start((response) => this.handleReply(response));  // handleReply returns Promise<void>
  }

  async stop(): Promise<void> {
    for (const [, entry] of this.pendingMap) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error("Bridge shutting down"));
    }
    this.pendingMap.clear();
    this.store.clear().catch(() => {});
    await this.adapter.stop();
  }

  // ── 频控 ──

  private checkDecisionRateLimit(): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    this.decisionTimestamps = this.decisionTimestamps.filter((t) => now - t < 60000);
    if (this.decisionTimestamps.length >= 5) {
      const retryAfterMs = this.decisionTimestamps[0] + 60000 - now + 100;
      return { allowed: false, retryAfterMs };
    }
    this.decisionTimestamps.push(now);
    return { allowed: true };
  }

  private checkNotificationRateLimit(): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    this.notificationTimestamps = this.notificationTimestamps.filter((t) => now - t < 1000);
    if (this.notificationTimestamps.length >= 3) {
      const retryAfterMs = this.notificationTimestamps[0] + 1000 - now + 50;
      return { allowed: false, retryAfterMs };
    }
    this.notificationTimestamps.push(now);
    return { allowed: true };
  }

  // ── 决策请求 ──

  async requestDecision(question: string, options?: string[], timeoutMs?: number): Promise<string> {
    const check = this.checkDecisionRateLimit();
    if (!check.allowed) throw new RateLimitError(check.retryAfterMs!);

    const id = crypto.randomUUID();
    const timeout = timeoutMs || config.defaultTimeoutMs;
    const request: DecisionRequest = { id, question, options, timeoutMs: timeout, createdAt: Date.now() };

    let resolveFn!: (answer: string) => void;
    let rejectFn!: (err: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
      resolveFn = resolve; rejectFn = reject;
    });

    const entry: PendingDecision = { request, resolve: resolveFn, reject: rejectFn };
    this.pendingMap.set(id, entry);                       // 同步 Map
    await this.store.set(id, entry).catch(() => {});      // 持久化 (异步, 可失败)

    const abortController = new AbortController();
    try {
      await Promise.race([
        this.adapter.sendDecision(request, { signal: abortController.signal }).catch((err: any) => {
          if (err.name === "AbortError") return;
          throw err;
        }),
        new Promise<void>((_, reject) =>
          setTimeout(() => {
            abortController.abort();
            reject(new Error("IM发送超时 (网关无响应)"));
          }, SEND_TIMEOUT_MS)
        ),
      ]);

      const timer = setTimeout(() => {
        this.store.delete(id).catch((err) =>
          console.error(`[bridge] 超时决策清理失败: ${err.message}`)
        );
        rejectFn(new Error(`决策超时 (${Math.round(timeout / 1000)}s): "${question.slice(0, 80)}"`));
      }, timeout);
      entry.timer = timer;

    } catch (err) {
      if (entry.timer) clearTimeout(entry.timer);
      await this.store.delete(id).catch(() => {});
      throw err;
    }

    return promise;
  }

  // ── 通知 ──

  async sendMessage(text: string): Promise<void> {
    const check = this.checkNotificationRateLimit();
    if (!check.allowed) throw new RateLimitError(check.retryAfterMs!);
    await this.adapter.sendNotification(text);
  }

  // ── 状态查询 ──

  async getStatus(): Promise<{ imType: string; ready: boolean; pendingCount: number; detail: any }> {
    return {
      imType: config.im.type,
      ready: this.adapter.isReady(),
      pendingCount: this.pendingMap.size,
      detail: this.adapter.getStatus(),
    };
  }

  async getPendingDecisions(): Promise<{ id: string; question: string; elapsedMs: number }[]> {
    const now = Date.now();
    return Array.from(this.pendingMap.values()).map((p) => ({
      id: p.request.id,
      question: p.request.question,
      elapsedMs: now - p.request.createdAt,
    }));
  }

  // ── 回复匹配 (同步 resolve, 异步清理) ──

  /** 返回 void 而非 Promise<void>, SDK cardAction 不阻塞 */
  private handleReply(response: DecisionResponse): void {
    // 先收集所有 pending (同步遍历内存)
    const entries = Array.from(this.pendingMap.entries());

    if (entries.length === 0) return;

    let matched: PendingDecision | undefined;

    // 1. decisionId 精确匹配
    if (response.decisionId) {
      matched = this.pendingMap.get(response.decisionId);
    }

    // 2. 选项匹配
    if (!matched) {
      for (const [, pending] of entries) {
        if (pending.request.options?.includes(response.answer)) {
          matched = pending;
          break;
        }
      }
    }

    // 3. FIFO
    if (!matched) {
      entries.sort((a, b) => a[1].request.createdAt - b[1].request.createdAt);
      if (entries.length > 0) matched = entries[0][1];
    }

    if (matched) {
      if (matched.timer) clearTimeout(matched.timer);
      this.pendingMap.delete(matched.request.id);
      matched.resolve(response.answer);
      // 持久化清理异步执行
      this.store.delete(matched.request.id).catch(() => {});
    }
  }

  // 内存 pending Map (同步查找, 同步 resolve)
  private pendingMap = new Map<string, PendingDecision>();
}
