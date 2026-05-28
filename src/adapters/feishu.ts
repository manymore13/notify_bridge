import axios from "axios";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { IMBotAdapter, DecisionRequest, DecisionResponse } from "./types.js";
import type { FeishuConfig } from "../config.js";

export class FeishuAdapter implements IMBotAdapter {
  private cfg: FeishuConfig;
  private wsClient: Lark.WSClient | null = null;
  private stopped = false;
  private onReply: ((r: DecisionResponse) => void) | null = null;

  /** 从收到的消息中自动捕获 */
  private capturedOpenId: string | null = null;
  private capturedChatId: string | null = null;
  private capturedIdType: "open_id" | "chat_id" = "open_id";

  constructor(cfg: FeishuConfig) {
    this.cfg = cfg;
    if (cfg.receiveId) {
      this.capturedOpenId = cfg.receiveId;
    }
  }

  isReady(): boolean {
    return this.capturedOpenId !== null || this.capturedChatId !== null;
  }

  getStatus(): { ready: boolean; openId: string | null; chatId: string | null; source: string } {
    return {
      ready: this.isReady(),
      openId: this.capturedOpenId,
      chatId: this.capturedChatId,
      source: this.cfg.receiveId ? "config" : this.capturedOpenId ? "captured" : "none",
    };
  }

  private get receiveId(): string {
    return this.capturedChatId || this.capturedOpenId || "";
  }

  private get receiveIdType(): "open_id" | "chat_id" {
    return this.capturedChatId ? "chat_id" : "open_id";
  }

  // ── Message Sending (keep axios for simplicity) ──

  async sendDecision(request: DecisionRequest): Promise<void> {
    this.ensureReady();
    await this.sendImMessage("interactive", this.buildCardBody(request));
  }

  async sendNotification(message: string): Promise<void> {
    this.ensureReady();
    await this.sendImMessage("text", JSON.stringify({ text: `📢 ${message}` }));
  }

  private ensureReady(): void {
    if (!this.isReady()) {
      throw new Error(
        "机器人尚未收到你的消息，无法发送。\n请先在飞书给机器人发一条消息（如 \"ready\"）。"
      );
    }
  }

  private async sendImMessage(msgType: string, content: string): Promise<void> {
    try {
      const token = await this.getAccessToken();
      const res = await axios.post(
        "https://open.feishu.cn/open-apis/im/v1/messages",
        { receive_id: this.receiveId, msg_type: msgType, content },
        {
          headers: { Authorization: `Bearer ${token}` },
          params: { receive_id_type: this.receiveIdType },
        }
      );
      if (res.data?.code !== 0) {
        console.error(`[feishu] 发送失败: code=${res.data?.code} msg=${res.data?.msg}`);
      }
    } catch (err: any) {
      console.error(`[feishu] 发送错误:`, err.message);
    }
  }

  private tenantAccessToken = "";
  private tokenExpireAt = 0;

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

  private buildCardBody(request: DecisionRequest): string {
    const optionsText = request.options?.length
      ? `选项: ${request.options.join(" / ")}`
      : "";

    const elements: any[] = [
      {
        tag: "div",
        text: {
          tag: "lark_md" as const,
          content: `🤖 **Agent 需要你的决策**\n\n${request.question}\n\n${optionsText}\n\n⏰ ${Math.round(request.timeoutMs / 1000)}秒内回复`,
        },
      },
    ];

    if (request.options?.length) {
      elements.push({ tag: "hr" });
      elements.push({
        tag: "action",
        actions: request.options.map((opt, i) => ({
          tag: "button",
          text: { tag: "lark_md" as const, content: opt },
          value: opt,
          type: (i === 0 ? "primary" : "default") as "primary" | "default",
        })),
      });
    }

    elements.push({ tag: "hr" });
    elements.push({
      tag: "note",
      elements: [{ tag: "plain_text", content: `ID:${request.id.slice(0, 8)} — 也可以直接回复文本` }],
    });

    return JSON.stringify({
      config: { wide_screen_mode: true },
      header: { template: "blue", title: { tag: "plain_text" as const, content: "Agent Decision" } },
      elements,
    });
  }

  // ── Official SDK WebSocket Client ──

  async start(callback: (response: DecisionResponse) => void): Promise<void> {
    this.onReply = callback;
    this.stopped = false;

    console.error("[feishu] 启动长连接 (官方SDK)...");

    this.wsClient = new Lark.WSClient({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    const dispatcher = new Lark.EventDispatcher({}).register({
      // 接收用户文本消息
      "im.message.receive_v1": (data: any) => {
        this.handleMessageEvent(data);
        return Promise.resolve();
      },
      // 卡片按钮点击
      "card.action.trigger": (data: any) => {
        this.handleCardAction(data);
        return Promise.resolve();
      },
    });

    try {
      await this.wsClient.start({ eventDispatcher: dispatcher });
      console.error("[feishu] ✅ 长连接已建立，等待消息...");

      if (this.isReady()) {
        console.error(`[feishu] 已就绪: ${this.receiveIdType}=${this.receiveId}`);
      } else {
        console.error("[feishu] ⚠️  请在飞书给机器人发一条消息完成绑定");
      }
    } catch (err: any) {
      console.error("[feishu] 长连接启动失败:", err.message);
      // SDK 内部有自动重连，不需要手动处理
    }
  }

  private handleMessageEvent(data: any): void {
    try {
      const event = data.event || data;
      const message = event.message;
      const sender = event.sender;

      // 自动捕获发送者的 open_id 和 chat_id
      if (sender?.sender_id?.open_id) {
        const openId = sender.sender_id.open_id;

        if (openId && openId !== this.capturedOpenId) {
          this.capturedOpenId = openId;
          console.error(`[feishu] ✅ 捕获用户 open_id=${openId}`);
        }
      }

      if (message?.chat_id) {
        this.capturedChatId = message.chat_id;
      }

      // 如果收到的第一条消息，发送确认
      if (!this.isReady()) return;

      // 解析消息内容
      if (message?.content) {
        try {
          const msgContent = JSON.parse(message.content);
          const text = msgContent.text || "";
          if (text.trim()) {
            console.error(`[feishu] 📩 收到: "${text.slice(0, 50)}"`);
            this.onReply?.({
              decisionId: `fe-${message.message_id || Date.now()}`,
              answer: text.trim(),
              respondedAt: Date.now(),
            });
          }
        } catch {
          // Non-JSON content
        }
      }
    } catch (err: any) {
      console.error("[feishu] 消息处理错误:", err.message);
    }
  }

  private handleCardAction(data: any): void {
    try {
      const action = data.event?.action || data.action;
      const value = action?.value || action?.option;
      if (value) {
        console.error(`[feishu] 🃏 卡片按钮: "${value}"`);
        this.onReply?.({
          decisionId: `fe-card-${Date.now()}`,
          answer: value,
          respondedAt: Date.now(),
        });
      }
    } catch (err: any) {
      console.error("[feishu] 卡片事件处理错误:", err.message);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.wsClient) {
      try {
        // SDK WSClient 可能支持 close/stop 方法
        (this.wsClient as any).stop?.();
        (this.wsClient as any).close?.();
      } catch { /* ignore */ }
      this.wsClient = null;
    }
  }
}
