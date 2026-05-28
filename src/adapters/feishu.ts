import axios from "axios";
import { createLarkChannel, type LarkChannel } from "@larksuiteoapi/node-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { IMBotAdapter, DecisionRequest, DecisionResponse, HealthStatus, SendOptions } from "./types.js";
import type { FeishuConfig } from "../config.js";

const BINDING_DIR = join(homedir(), ".notify-bridge");
const BINDING_PATH = join(BINDING_DIR, "binding.json");

enum AuthState {
  UNBOUND = 0,
  BOUND_LOCKED = 1,
  PENDING_REBIND = 2,
}

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

  private tenantAccessToken = "";
  private tokenExpireAt = 0;

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
    await this.getAccessToken();
  }

  async start(callback: (r: DecisionResponse) => Promise<void>): Promise<void> {
    this.onReply = callback;

    this.channel = createLarkChannel({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
    });

    this.channel.on({
      message: (msg) => { this.handleMessage(msg); },
      cardAction: (evt) => { this.handleCardAction(evt); },
    });

    await this.channel.connect();
    console.error(`[feishu] 长连接已建立 (Channel API)`);
  }

  async stop(): Promise<void> {
    try { await this.channel?.disconnect(); } catch {}
    this.channel = null;
  }

  async sendDecision(request: DecisionRequest, _opts?: SendOptions): Promise<void> {
    this.ensureReady();
    await this.sendCardkitCard(request);
  }

  async sendNotification(message: string, opts?: SendOptions): Promise<void> {
    this.ensureReady();
    await this.sendImMessage("text", JSON.stringify({ text: `📢 ${message}` }), opts);
  }

  async checkHealth(): Promise<HealthStatus> {
    if (!this.cfg.appId || !this.cfg.appSecret) {
      return { status: "unhealthy", reason: "缺少飞书凭证" };
    }
    try {
      await this.getAccessToken();
      return { status: "healthy", details: { authState: AuthState[this.authState], lockedOpenId: this.lockedOpenId } };
    } catch (err: any) {
      return { status: "unhealthy", reason: err.message };
    }
  }

  isReady(): boolean {
    return this.lockedOpenId !== null || this.capturedChatId !== null;
  }

  getStatus(): Record<string, any> {
    return {
      authState: AuthState[this.authState],
      openId: this.lockedOpenId,
      chatId: this.capturedChatId,
      source: this.cfg.receiveId ? "config" : this.lockedOpenId ? "captured" : "none",
    };
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
          console.error(`[feishu] 📂 加载持久化绑定: ${data.openId}`);
        }
      }
    } catch {}
  }

  private saveBinding(): void {
    try {
      if (!existsSync(BINDING_DIR)) mkdirSync(BINDING_DIR, { recursive: true });
      writeFileSync(BINDING_PATH, JSON.stringify({
        openId: this.lockedOpenId,
        chatId: this.capturedChatId,
        updatedAt: new Date().toISOString(),
      }, null, 2));
    } catch {}
  }

  private clearBinding(): void {
    try { if (existsSync(BINDING_PATH)) writeFileSync(BINDING_PATH, "{}"); } catch {}
  }

  // ── 安全门禁 ──

  private gateIncoming(senderOpenId: string | undefined): boolean {
    if (this.authState === AuthState.PENDING_REBIND) {
      console.warn(`[feishu] PENDING_REBIND: 拒绝事件`);
      return false;
    }
    if (!senderOpenId) return true;
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(senderOpenId)) {
      console.warn(`[feishu] 非白名单用户 ${senderOpenId} 已丢弃`);
      return false;
    }
    if (this.lockedOpenId && senderOpenId !== this.lockedOpenId) {
      console.warn(`[feishu] 非锁定用户 ${senderOpenId} 已丢弃`);
      return false;
    }
    if (!this.lockedOpenId) {
      this.lockedOpenId = senderOpenId;
      this.authState = AuthState.BOUND_LOCKED;
      this.saveBinding();
      console.error(`[feishu] 🔒 锁定用户: ${senderOpenId}`);
    }
    return true;
  }

  // ── 事件处理 (createLarkChannel normalized events) ──

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
      this.onReply?.({
        decisionId: `fe-${msg.messageId || Date.now()}`,
        answer: text,
        respondedAt: Date.now(),
      })?.catch((err) => console.error(`[feishu] onReply 异常: ${err.message}`));
    } catch (err: any) {
      console.error(`[feishu] 消息处理错误: ${err.message}`);
    }
  }

  private handleCardAction(evt: any): void {
    try {
      // createLarkChannel 的 cardAction 事件: operator 在 evt.operator.openId
      const operatorOpenId = evt.operator?.openId || evt.operator?.open_id;
      if (!this.gateIncoming(operatorOpenId)) return;

      // SDK 已解析 action.value 为 {id, option} 对象 (卡片传了对象value)
      const value = evt.action?.value || {};
      const answer = value.option || "";
      const decisionId = value.id || "";

      console.error(`[feishu] 🃏 卡片按钮: "${answer}" (decisionId: ${decisionId.slice(0, 8)})`);
      this.onReply?.({ decisionId, answer, respondedAt: Date.now() })
        ?.catch((err) => console.error(`[feishu] onReply 异常: ${err.message}`));
    } catch (err: any) {
      console.error(`[feishu] 卡片处理错误: ${err.message}`);
    }
  }

  // ── 消息发送 ──

  private ensureReady(): void {
    if (!this.isReady()) {
      throw new Error("机器人尚未绑定用户。请先在飞书给机器人发一条消息。");
    }
  }

  /** 通过 CardKit 2.0 发送交互卡片 (支持长连接按钮回调) */
  private async sendCardkitCard(request: DecisionRequest): Promise<void> {
    if (!this.channel) throw new Error("Channel 未初始化");
    const receiveId = this.capturedChatId || this.lockedOpenId || "";
    const receiveIdType = this.capturedChatId ? "chat_id" : "open_id";

    try {
      // 1. 创建 CardKit 2.0 卡片模板
      const cardJson = this.buildCardJson(request);
      const cardData = JSON.stringify(cardJson);
      console.error(`[feishu] CardKit cardData length: ${cardData.length}`);

      // Try without `data` wrapper (like raw im message API)
      const created: any = await (this.channel.rawClient as any).cardkit.v1.card.create(
        { type: "card_json", data: cardData },
      );
      console.error(`[feishu] CardKit 响应: ${JSON.stringify(created).slice(0, 400)}`);
      const cardId = created?.data?.card_id || created?.card_id;
      if (!cardId) throw new Error(`cardkit.card.create 返回空 card_id: ${JSON.stringify(created).slice(0, 200)}`);

      // 2. 发送引用卡片的消息
      const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
      await this.channel.rawClient.im.v1.message.create({
        params: { receive_id_type: receiveIdType as any },
        data: { receive_id: receiveId, msg_type: "interactive" as any, content },
      });
    } catch (err: any) {
      console.error(`[feishu] CardKit 发送错误: ${err.message}`);
      throw err;
    }
  }

  private async sendImMessage(msgType: string, content: string, opts?: SendOptions): Promise<void> {
    if (!this.channel) throw new Error("Channel 未初始化");
    const receiveId = this.capturedChatId || this.lockedOpenId || "";
    const receiveIdType = this.capturedChatId ? "chat_id" : "open_id";

    try {
      const res: any = await this.channel.rawClient.im.v1.message.create({
        params: { receive_id_type: receiveIdType as any },
        data: { receive_id: receiveId, msg_type: msgType as any, content },
      });
      const code = res?.code;
      if (code === 0) { this.identityFailures = 0; return; }

      const errorType = res?.msg || "";
      if (IDENTITY_INVALID_CODES.has(errorType)) {
        this.identityFailures++;
        if (this.identityFailures >= 3) {
          console.error(`[feishu] 🚨 身份失效 (${errorType}), 进入 PENDING_REBIND`);
          this.authState = AuthState.PENDING_REBIND;
          this.lockedOpenId = null;
          this.capturedChatId = null;
          this.identityFailures = 0;
          this.clearBinding();
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError" || err.code === "ERR_CANCELED") return;
      console.error(`[feishu] 发送错误: ${err.message}`);
    }
  }

  // ── Token ──

  private async getAccessToken(): Promise<string> {
    if (this.tenantAccessToken && Date.now() < this.tokenExpireAt - 60000) {
      return this.tenantAccessToken;
    }
    const res = await axios.post(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      { app_id: this.cfg.appId, app_secret: this.cfg.appSecret }
    );
    if (res.data.code !== 0) throw new Error(`飞书 token 失败: ${res.data.msg}`);
    this.tenantAccessToken = res.data.tenant_access_token;
    this.tokenExpireAt = Date.now() + (res.data.expire || 7200) * 1000;
    return this.tenantAccessToken;
  }

  // ── 卡片 (带回传按钮, createLarkChannel 长连接支持 cardAction) ──

  private buildCardJson(request: DecisionRequest): object {
    const optionsText = request.options?.length
      ? `\n\n**选项**: ${request.options.join(" / ")}`
      : "";

    const elements: any[] = [
      {
        tag: "div",
        text: {
          tag: "lark_md" as const,
          content: `🤖 **Agent 需要你的决策**\n\n${request.question}${optionsText}\n\n⏰ ${Math.round(request.timeoutMs / 1000)}秒内回复`,
        },
      },
    ];

    // 交互按钮 — createLarkChannel 的 cardAction 事件通过长连接接收
    if (request.options?.length) {
      elements.push({ tag: "hr" });
      elements.push({
        tag: "action",
        actions: request.options.map((opt, i) => ({
          tag: "button",
          text: { tag: "lark_md" as const, content: opt },
          value: { id: request.id, option: opt },  // value 传对象, SDK 自动处理
          type: (i === 0 ? "primary" : "default") as "primary" | "default",
        })),
      });
    }

    elements.push({ tag: "hr" });
    elements.push({
      tag: "note",
      elements: [{ tag: "plain_text", content: `ID:${request.id.slice(0, 8)} — 可点按钮或直接回文字` }],
    });

    return {
      config: { wide_screen_mode: true },
      header: { template: "blue", title: { tag: "plain_text" as const, content: "Agent Decision" } },
      elements,
    };
  }
}
