import { createLarkChannel, type LarkChannel } from "@larksuiteoapi/node-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { IMBotAdapter, DecisionRequest, DecisionResponse, HealthStatus, SendOptions } from "./types.js";
import type { FeishuConfig } from "../config.js";

const BINDING_DIR = join(homedir(), ".notify-bridge");
const BINDING_PATH = join(BINDING_DIR, "binding.json");

enum AuthState { UNBOUND = 0, BOUND_LOCKED = 1, PENDING_REBIND = 2 }

const IDENTITY_INVALID_CODES = new Set([
  "user_not_found", "chat_not_found", "no_permission", "receive_id_not_authorized",
]);

export class FeishuAdapter implements IMBotAdapter {
  private cfg: FeishuConfig;
  private channel: LarkChannel | null = null;
  private onReply: ((r: DecisionResponse) => Promise<void>) | null = null;

  private authState = AuthState.UNBOUND;
  private lockedOpenId: string | null = null;
  private capturedChatId: string | null = null;
  private allowedUsers: Set<string>;
  private identityFailures = 0;

  constructor(cfg: FeishuConfig) {
    this.cfg = cfg;
    this.allowedUsers = new Set(cfg.allowedUserIds || []);
    if (cfg.receiveId) {
      this.lockedOpenId = cfg.receiveId;
      this.authState = AuthState.BOUND_LOCKED;
    }
  }

  // ── IMBotAdapter ──

  async init(): Promise<void> {
    this.loadBinding();
  }

  async start(callback: (r: DecisionResponse) => Promise<void>): Promise<void> {
    this.onReply = callback;
    this.channel = createLarkChannel({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      includeRawEvent: true,
      loggerLevel: 1,
      outbound: { streamThrottleMs: 400 },
    });
    this.channel.on({
      message: (msg) => this.handleMessage(msg),
      cardAction: (evt) => { this.handleCardAction(evt); },
    });
    await this.channel.connect();
    console.error(`[feishu] 长连接已建立 (Channel API + CardKit 2.0)`);
  }

  async stop(): Promise<void> {
    try { await this.channel?.disconnect(); } catch {}
    this.channel = null;
  }

  async sendDecision(request: DecisionRequest): Promise<void> {
    this.ensureReady();
    await this.sendCardkitCard(request);
  }

  async sendNotification(message: string): Promise<void> {
    this.ensureReady();
    await this.sendTextMsg(`📢 ${message}`);
  }

  async checkHealth(): Promise<HealthStatus> {
    if (!this.cfg.appId || !this.cfg.appSecret) return { status: "unhealthy", reason: "缺少飞书凭证" };
    return { status: "healthy", details: { authState: AuthState[this.authState], lockedOpenId: this.lockedOpenId } };
  }

  isReady(): boolean { return this.lockedOpenId !== null || this.capturedChatId !== null; }
  getStatus(): Record<string, any> {
    return {
      authState: AuthState[this.authState], openId: this.lockedOpenId, chatId: this.capturedChatId,
      source: this.cfg.receiveId ? "config" : this.lockedOpenId ? "captured" : "none",
    };
  }

  // ── 发送 ──

  private ensureReady(): void {
    if (!this.isReady()) throw new Error("机器人尚未绑定用户。请先在飞书给机器人发一条消息。");
  }

  private get receiveId() { return this.capturedChatId || this.lockedOpenId || ""; }
  private get receiveIdType() { return this.capturedChatId ? "chat_id" : "open_id"; }

  private async sendTextMsg(text: string): Promise<void> {
    if (!this.channel) return;
    await this.channel.rawClient.im.v1.message.create({
      params: { receive_id_type: this.receiveIdType as any },
      data: { receive_id: this.receiveId, msg_type: "text" as any, content: JSON.stringify({ text }) },
    });
  }

  private async sendCardkitCard(request: DecisionRequest): Promise<void> {
    if (!this.channel) throw new Error("Channel 未初始化");

    const cardJson = this.buildCardkitCard(request);
    const cardData = JSON.stringify(cardJson);

    const created: any = await this.channel.rawClient.cardkit.v1.card.create({
      data: { type: "card_json", data: cardData },
    });
    const cardId = created?.data?.card_id;
    if (!cardId) throw new Error(`CardKit 创建失败: ${JSON.stringify(created).slice(0, 200)}`);

    const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
    await this.channel.rawClient.im.v1.message.create({
      params: { receive_id_type: this.receiveIdType as any },
      data: { receive_id: this.receiveId, msg_type: "interactive" as any, content },
    });
  }

  /** CardKit 2.0 schema 格式 (关键: schema:"2.0", body.elements) */
  private buildCardkitCard(request: DecisionRequest): object {
    const elements: any[] = [
      {
        tag: "div",
        text: {
          tag: "lark_md" as const,
          content: `🤖 **Agent 需要你的决策**\n\n${request.question}\n\n⏰ ${Math.round(request.timeoutMs / 1000)}秒内回复`,
        },
      },
    ];

    if (request.options?.length) {
      elements.push({ tag: "hr" });
      // CardKit 2.0: 按钮直接放 elements, 不用 action 包裹
      for (let i = 0; i < request.options.length; i++) {
        elements.push({
          tag: "button",
          text: { tag: "plain_text" as const, content: request.options[i] },
          value: { id: request.id, option: request.options[i] },
          type: i === 0 ? "primary" : "default",
        });
      }
    }

    return {
      schema: "2.0",
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text" as const, content: "Agent Decision" } },
      body: { elements },
    };
  }

  // ── 事件处理 ──

  private handleMessage(msg: any): void {
    try {
      const senderOpenId = msg.senderId;
      if (!this.gateIncoming(senderOpenId)) return;

      if (msg.chatId && msg.chatId !== this.capturedChatId) {
        this.capturedChatId = msg.chatId;
        this.saveBinding();
      }

      const text = (msg.content || "").trim();
      if (!text) return;

      console.error(`[feishu] 📩 收到: "${text.slice(0, 50)}"`);
      this.onReply?.({ decisionId: `fe-${msg.messageId || Date.now()}`, answer: text, respondedAt: Date.now() })
        ?.catch((err) => console.error(`[feishu] onReply 异常: ${err.message}`));
    } catch (err: any) {
      console.error(`[feishu] 消息处理错误: ${err.message}`);
    }
  }

  private handleCardAction(evt: any): void {
    try {
      const operatorOpenId = evt.operator?.openId || evt.operator?.open_id;
      if (!this.gateIncoming(operatorOpenId)) return;

      const value = evt.action?.value || {};
      const answer = value.option || "";
      const decisionId = value.id || "";

      console.error(`[feishu] 🃏 卡片按钮: "${answer}" (${decisionId.slice(0, 8)})`);
      // 立即 resolve, 不 await, 让 SDK 快速响应飞书 (3秒限制)
      this.onReply?.({ decisionId, answer, respondedAt: Date.now() })
        ?.catch((err) => console.error(`[feishu] onReply 异常: ${err.message}`));
    } catch (err: any) {
      console.error(`[feishu] 卡片处理错误: ${err.message}`);
    }
  }

  // ── 安全门禁 ──

  private gateIncoming(operatorOpenId: string | undefined): boolean {
    if (this.authState === AuthState.PENDING_REBIND) {
      console.warn(`[feishu] PENDING_REBIND: 拒绝事件`); return false;
    }
    if (!operatorOpenId) return true;
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(operatorOpenId)) {
      console.warn(`[feishu] 非白名单用户 ${operatorOpenId}`); return false;
    }
    if (this.lockedOpenId && operatorOpenId !== this.lockedOpenId) {
      console.warn(`[feishu] 非锁定用户 ${operatorOpenId}`); return false;
    }
    if (!this.lockedOpenId) {
      this.lockedOpenId = operatorOpenId;
      this.authState = AuthState.BOUND_LOCKED;
      this.saveBinding();
      console.error(`[feishu] 🔒 锁定用户: ${operatorOpenId}`);
    }
    return true;
  }

  // ── 持久化 ──

  private loadBinding(): void {
    try {
      if (existsSync(BINDING_PATH)) {
        const data = JSON.parse(readFileSync(BINDING_PATH, "utf-8"));
        if (data.openId) {
          this.lockedOpenId = data.openId;
          this.capturedChatId = data.chatId || null;
          this.authState = AuthState.BOUND_LOCKED;
          console.error(`[feishu] 📂 加载绑定: ${data.openId}`);
        }
      }
    } catch {}
  }

  private saveBinding(): void {
    try {
      if (!existsSync(BINDING_DIR)) mkdirSync(BINDING_DIR, { recursive: true });
      writeFileSync(BINDING_PATH, JSON.stringify({
        openId: this.lockedOpenId, chatId: this.capturedChatId, updatedAt: new Date().toISOString(),
      }, null, 2));
    } catch {}
  }
}
