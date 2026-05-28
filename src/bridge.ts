import crypto from "node:crypto";
import type { IMBotAdapter, DecisionRequest, DecisionResponse } from "./adapters/types.js";
import { config } from "./config.js";

interface PendingDecision {
  request: DecisionRequest;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class NotifyBridge {
  private adapter: IMBotAdapter;
  private pending = new Map<string, PendingDecision>();

  // 频控：最多 5 个决策/分钟，1 个通知/秒
  private decisionTimestamps: number[] = [];
  private notificationTimestamps: number[] = [];
  private readonly maxDecisionsPerMinute = 5;
  private readonly maxNotificationsPerSecond = 3;

  constructor(adapter: IMBotAdapter) {
    this.adapter = adapter;
  }

  async start(): Promise<void> {
    await this.adapter.start((response) => this.handleReply(response));
  }

  async stop(): Promise<void> {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bridge shutting down"));
    }
    this.pending.clear();
    await this.adapter.stop();
  }

  private checkDecisionRateLimit(): void {
    const now = Date.now();
    this.decisionTimestamps = this.decisionTimestamps.filter(t => now - t < 60000);
    if (this.decisionTimestamps.length >= this.maxDecisionsPerMinute) {
      throw new Error(`决策频控: 每分钟最多 ${this.maxDecisionsPerMinute} 次请求，请稍后再试。如果 Agent 陷入循环请手动介入。`);
    }
    this.decisionTimestamps.push(now);
  }

  private checkNotificationRateLimit(): void {
    const now = Date.now();
    this.notificationTimestamps = this.notificationTimestamps.filter(t => now - t < 1000);
    if (this.notificationTimestamps.length >= this.maxNotificationsPerSecond) {
      throw new Error(`通知频控: 每秒最多 ${this.maxNotificationsPerSecond} 条`);
    }
    this.notificationTimestamps.push(now);
  }

  /** Send a decision request to human and block until reply or timeout */
  async requestDecision(question: string, options?: string[], timeoutMs?: number): Promise<string> {
    this.checkDecisionRateLimit();
    const id = crypto.randomUUID();
    const timeout = timeoutMs || config.defaultTimeoutMs;

    const request: DecisionRequest = {
      id,
      question,
      options,
      timeoutMs: timeout,
      createdAt: Date.now(),
    };

    // Set up the pending entry BEFORE sending the IM message,
    // so getPendingDecisions() works synchronously for the caller
    let resolveFn!: (answer: string) => void;
    let rejectFn!: (err: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const timer = setTimeout(() => {
      this.pending.delete(id);
      rejectFn(new Error(`决策超时 (${Math.round(timeout / 1000)}s): "${question.slice(0, 80)}"`));
    }, timeout);

    this.pending.set(id, { request, resolve: resolveFn, reject: rejectFn, timer });

    // Now send the IM message — might fail, but pending is already tracked
    try {
      await this.adapter.sendDecision(request);
    } catch (err: any) {
      clearTimeout(timer);
      this.pending.delete(id);
      throw new Error(`发送IM消息失败: ${err.message}`);
    }

    return promise;
  }

  /** Send a one-way notification, no reply expected */
  async sendMessage(text: string): Promise<void> {
    this.checkNotificationRateLimit();
    await this.adapter.sendNotification(text);
  }

  /** Check bridge + adapter status */
  getStatus(): { imType: string; ready: boolean; pendingCount: number; detail: any } {
    const adapterStatus = (this.adapter as any).getStatus?.() || {};
    return {
      imType: config.im.type,
      ready: (this.adapter as any).isReady?.() ?? true,
      pendingCount: this.pending.size,
      detail: adapterStatus,
    };
  }

  /** Get list of pending decisions */
  getPendingDecisions(): { id: string; question: string; elapsedMs: number }[] {
    const now = Date.now();
    return Array.from(this.pending.values()).map((p) => ({
      id: p.request.id,
      question: p.request.question,
      elapsedMs: now - p.request.createdAt,
    }));
  }

  private handleReply(response: DecisionResponse): void {
    if (this.pending.size === 0) return;

    let matched: PendingDecision | undefined;

    // Step 1: Try option-based matching (exact match on option value)
    for (const [, pending] of this.pending) {
      if (pending.request.options && pending.request.options.length > 0) {
        if (pending.request.options.includes(response.answer)) {
          matched = pending;
          break;
        }
      }
    }

    // Step 2: If no option match, use FIFO (oldest pending)
    if (!matched) {
      const entries = Array.from(this.pending.entries());
      entries.sort((a, b) => a[1].request.createdAt - b[1].request.createdAt);
      if (entries.length > 0) {
        matched = entries[0][1];
      }
    }

    if (matched) {
      clearTimeout(matched.timer);
      this.pending.delete(matched.request.id);
      matched.resolve(response.answer);
    }
  }
}
