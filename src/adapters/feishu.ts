import axios from "axios";
import * as Lark from "@larksuiteoapi/node-sdk";
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
  "user_not_found",
  "chat_not_found",
  "no_permission",
  "receive_id_not_authorized",
]);

export class FeishuAdapter implements IMBotAdapter {
  private cfg: FeishuConfig;
  private wsClient: Lark.WSClient | null = null;
  private stopped = false;
  private onReply: ((r: DecisionResponse) => Promise<void>) | null = null;

  // 身份管理
  private authState = AuthState.UNBOUND;
  private lockedOpenId: string | null = null;
  private capturedChatId: string | null = null;
  private allowedUsers: Set<string>;
  private identityFailures = 0;

  // Token
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

  // ── IMBotAdapter 接口 ──

  async init(): Promise<void> {
    this.stopped = false;
    this.loadBinding();
    await this.getAccessToken();
  }

  async start(callback: (response: DecisionResponse) => Promise<void>): Promise<void> {
    this.onReply = callback;

    this.wsClient = new Lark.WSClient({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": (data: any) => {
        this.handleMessageEvent(data);
        return Promise.resolve();
      },
      "card.action.trigger": (data: any) => {
        this.handleCardAction(data);
        return Promise.resolve();
      },
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    console.error(`[feishu] 长连接已建立`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try { (this.wsClient as any)?.stop?.(); } catch {}
    try { (this.wsClient as any)?.close?.(); } catch {}
    this.wsClient = null;
  }

  async sendDecision(request: DecisionRequest, opts?: SendOptions): Promise<void> {
    this.ensureReady();
    const token = await this.getAccessToken();
    await this.sendImMessage(token, "interactive", this.buildCardBody(request), opts);
  }

  async sendNotification(message: string, opts?: SendOptions): Promise<void> {
    this.ensureReady();
    const token = await this.getAccessToken();
    await this.sendImMessage(token, "text", JSON.stringify({ text: `📢 ${message}` }), opts);
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

  // ── 持久化绑定 ──

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
    } catch { /* ignore */ }
  }

  private saveBinding(): void {
    try {
      if (!existsSync(BINDING_DIR)) mkdirSync(BINDING_DIR, { recursive: true });
      writeFileSync(BINDING_PATH, JSON.stringify({
        openId: this.lockedOpenId,
        chatId: this.capturedChatId,
        updatedAt: new Date().toISOString(),
      }, null, 2));
    } catch { /* ignore */ }
  }

  private clearBinding(): void {
    try { if (existsSync(BINDING_PATH)) writeFileSync(BINDING_PATH, "{}"); } catch {}
  }

  // ── 安全门禁 ──

  private gateIncoming(operatorOpenId: string | undefined): boolean {
    // PENDING_REBIND: 拒绝所有人
    if (this.authState === AuthState.PENDING_REBIND) {
      console.warn(`[feishu] PENDING_REBIND: 拒绝事件, 需管理员重置`);
      return false;
    }
    if (!operatorOpenId) return true;

    // 白名单检查
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(operatorOpenId)) {
      console.warn(`[feishu] 非白名单用户 ${operatorOpenId} 已丢弃`);
      return false;
    }
    // 锁定检查
    if (this.lockedOpenId && operatorOpenId !== this.lockedOpenId) {
      console.warn(`[feishu] 非锁定用户 ${operatorOpenId} 已丢弃`);
      return false;
    }
    // 首次捕获 → 持久化
    if (!this.lockedOpenId) {
      this.lockedOpenId = operatorOpenId;
      this.authState = AuthState.BOUND_LOCKED;
      this.saveBinding();
      console.error(`[feishu] 🔒 锁定用户: ${operatorOpenId}`);
    }
    return true;
  }

  // ── 事件处理 ──

  private handleMessageEvent(data: any): void {
    try {
      const event = data.event || data;
      const operatorOpenId = event.sender?.sender_id?.open_id;
      if (!this.gateIncoming(operatorOpenId)) return;

      if (event.message?.chat_id && event.message.chat_id !== this.capturedChatId) {
        this.capturedChatId = event.message.chat_id;
        this.saveBinding();
      }

      if (!event.message?.content) return;
      const msgContent = JSON.parse(event.message.content);
      const text = (msgContent.text || "").trim();
      if (!text) return;

      console.error(`[feishu] 📩 收到: "${text.slice(0, 50)}"`);
      this.onReply?.({
        decisionId: `fe-${event.message.message_id || Date.now()}`,
        answer: text,
        respondedAt: Date.now(),
      })?.catch((err) => console.error(`[feishu] onReply 异常: ${err.message}`));
    } catch (err: any) {
      console.error(`[feishu] 消息处理错误: ${err.message}`);
    }
  }

  private handleCardAction(data: any): void {
    try {
      const operatorOpenId = data.event?.operator?.open_id || data.event?.operator?.user_id;
      if (!this.gateIncoming(operatorOpenId)) return;

      const raw = data.event?.action?.value || data.action?.value || "";
      let decisionId = "";
      let answer = raw;
      try {
        const parsed = JSON.parse(raw);
        decisionId = parsed.id || "";
        answer = parsed.option || raw;
      } catch { /* 兼容旧格式 */ }

      console.error(`[feishu] 🃏 卡片: "${answer}"`);
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

  private async sendImMessage(
    token: string, msgType: string, content: string, opts?: SendOptions
  ): Promise<void> {
    const receiveId = this.capturedChatId || this.lockedOpenId || "";
    const receiveIdType = this.capturedChatId ? "chat_id" : "open_id";

    try {
      const res = await axios.post(
        "https://open.feishu.cn/open-apis/im/v1/messages",
        { receive_id: receiveId, msg_type: msgType, content },
        {
          headers: { Authorization: `Bearer ${token}` },
          params: { receive_id_type: receiveIdType },
          signal: opts?.signal,
        }
      );
      const code = res.data?.code;
      if (code === 0) { this.identityFailures = 0; return; }

      const errorType = res.data?.msg || "";
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
      if (err.name === "AbortError") return;
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

  // ── 卡片 ──

  private buildCardBody(request: DecisionRequest): string {
    const optionsText = request.options?.length
      ? `\n\n**选项**: ${request.options.join(" / ")}`
      : "";

    const elements: any[] = [
      {
        tag: "div",
        text: {
          tag: "lark_md" as const,
          content: `🤖 **Agent 需要你的决策**\n\n${request.question}${optionsText}\n\n⏰ ${Math.round(request.timeoutMs / 1000)}秒内回复\n\n请直接回复文字（如"是"或"否"）`,
        },
      },
    ];

    elements.push({ tag: "hr" });
    elements.push({
      tag: "note",
      elements: [{ tag: "plain_text", content: `ID:${request.id.slice(0, 8)} — 回复文本即可，无需点按钮` }],
    });

    return JSON.stringify({
      config: { wide_screen_mode: true },
      header: { template: "blue", title: { tag: "plain_text" as const, content: "Agent Decision" } },
      elements,
    });
  }
}
