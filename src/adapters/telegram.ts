import axios from "axios";
import type { IMBotAdapter, DecisionRequest, DecisionResponse, HealthStatus, SendOptions } from "./types.js";
import type { TelegramConfig } from "../config.js";

export class TelegramAdapter implements IMBotAdapter {
  private botToken: string;
  private chatId: string;
  private allowedUserIds: Set<string>;
  private onReplyCallback: ((r: DecisionResponse) => Promise<void>) | null = null;

  // 长轮询
  private polling = false;
  private lastUpdateId = 0;
  private pollAbortController = new AbortController();
  private lastPollSuccess = 0;

  // 用户锁定
  private lockedUserId: string | null = null;

  constructor(botToken: string, chatId: string, allowedUserIds?: string[]) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.allowedUserIds = new Set(allowedUserIds || []);
  }

  private get apiBase() {
    return `https://api.telegram.org/bot${this.botToken}`;
  }

  // ── IMBotAdapter 接口 ──

  async init(): Promise<void> {
    try {
      const res = await axios.get(`${this.apiBase}/getMe`);
      if (!res.data.ok) throw new Error("Telegram Token 验证失败");
    } catch (err: any) {
      throw new Error(`Telegram 初始化失败: ${err.message}`);
    }
  }

  async start(callback: (response: DecisionResponse) => Promise<void>): Promise<void> {
    this.onReplyCallback = callback;
    if (this.polling) return;
    this.polling = true;
    this.pollAbortController = new AbortController();
    this.pollUpdates(); // fire-and-forget
  }

  async stop(): Promise<void> {
    this.polling = false;
    try { this.pollAbortController.abort(); } catch {}
  }

  async sendDecision(request: DecisionRequest, opts?: SendOptions): Promise<void> {
    const header = `🤖 **Agent 需要你的决策**\n\n${request.question}`;
    const footer = request.options?.length
      ? `\n\n请在 ${Math.round(request.timeoutMs / 1000)} 秒内选择回复。`
      : `\n\n请在 ${Math.round(request.timeoutMs / 1000)} 秒内回复。`;

    await axios.post(`${this.apiBase}/sendMessage`, {
      chat_id: this.chatId,
      text: header + footer,
      parse_mode: "Markdown",
      reply_markup: this.buildReplyKeyboard(request.options),
    }, { signal: opts?.signal });
  }

  async sendNotification(message: string, opts?: SendOptions): Promise<void> {
    await axios.post(`${this.apiBase}/sendMessage`, {
      chat_id: this.chatId,
      text: `📢 ${message}`,
      parse_mode: "Markdown",
    }, { signal: opts?.signal });
  }

  async checkHealth(): Promise<HealthStatus> {
    if (!this.botToken) return { status: "unhealthy", reason: "缺少 Telegram Token" };
    const stale = Date.now() - this.lastPollSuccess > 60000;
    if (stale) return { status: "unhealthy", reason: "最近 60s 内无成功轮询" };
    return { status: "healthy", details: { lockedUserId: this.lockedUserId } };
  }

  isReady(): boolean {
    return true; // Telegram chat_id 在配置中已指定
  }

  getStatus(): Record<string, any> {
    return { chatId: this.chatId, lockedUserId: this.lockedUserId, lastPollSuccess: this.lastPollSuccess };
  }

  // ── 长轮询 ──

  private async pollUpdates(): Promise<void> {
    while (this.polling) {
      try {
        const res = await axios.get(`${this.apiBase}/getUpdates`, {
          params: { offset: this.lastUpdateId + 1, timeout: 30, allowed_updates: ["message"] },
          signal: this.pollAbortController.signal,
        });
        this.lastPollSuccess = Date.now();

        for (const update of res.data.result) {
          this.lastUpdateId = update.update_id;
          const msg = update.message;
          if (!msg?.text) continue;

          const senderId = msg.from?.id?.toString();
          if (!senderId) continue;

          // 身份校验
          if (!this.gateIncoming(senderId)) continue;

          const text = msg.text.trim();
          this.onReplyCallback?.({
            decisionId: `tg-${msg.message_id}`,
            answer: text,
            respondedAt: Date.now(),
          })?.catch((err) => console.error(`[telegram] onReply 异常: ${err.message}`));
        }
      } catch (err: any) {
        if (err.name === "AbortError") return;
        console.warn(`[telegram] 轮询异常: ${err.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // ── 身份校验 ──

  private gateIncoming(senderId: string): boolean {
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(senderId)) {
      console.warn(`[telegram] 非授权用户 ${senderId} 消息已丢弃`);
      return false;
    }

    if (!this.lockedUserId) {
      this.lockedUserId = senderId;
      console.log(`[telegram] 🔒 锁定用户: ${senderId}`);
      return true;
    }

    if (senderId !== this.lockedUserId) {
      console.warn(`[telegram] 非锁定用户 ${senderId} 消息已丢弃`);
      return false;
    }

    return true;
  }

  // ── 键盘 ──

  private buildReplyKeyboard(options?: string[]) {
    if (!options?.length) return undefined;
    return {
      keyboard: options.map((opt) => [{ text: opt }]),
      one_time_keyboard: true,
      resize_keyboard: true,
    };
  }
}
