import axios from "axios";
import type { IMBotAdapter, DecisionRequest, DecisionResponse } from "./types.js";

export class TelegramAdapter implements IMBotAdapter {
  private botToken: string;
  private chatId: string;
  private polling = false;
  private lastUpdateId = 0;

  constructor(botToken: string, chatId: string) {
    this.botToken = botToken;
    this.chatId = chatId;
  }

  private get apiBase() {
    return `https://api.telegram.org/bot${this.botToken}`;
  }

  private buildInlineKeyboard(options?: string[]) {
    if (!options || options.length === 0) return undefined;
    return {
      inline_keyboard: [
        options.map((opt) => ({
          text: opt,
          callback_data: opt,
        })),
      ],
    };
  }

  private buildReplyKeyboard(options?: string[]) {
    if (!options || options.length === 0) return undefined;
    return {
      keyboard: options.map((opt) => [{ text: opt }]),
      one_time_keyboard: true,
      resize_keyboard: true,
    };
  }

  async sendDecision(request: DecisionRequest): Promise<void> {
    const header = `🤖 **Agent 需要你的决策**\n\n${request.question}`;
    const footer =
      request.options && request.options.length > 0
        ? `\n\n请在 ${Math.round(request.timeoutMs / 1000)} 秒内选择一个选项回复。`
        : `\n\n请在 ${Math.round(request.timeoutMs / 1000)} 秒内回复你的决定。`;

    const text = header + footer;

    await axios.post(`${this.apiBase}/sendMessage`, {
      chat_id: this.chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: this.buildReplyKeyboard(request.options),
    });
  }

  async sendNotification(message: string): Promise<void> {
    await axios.post(`${this.apiBase}/sendMessage`, {
      chat_id: this.chatId,
      text: `📢 ${message}`,
      parse_mode: "Markdown",
    });
  }

  async start(callback: (response: DecisionResponse) => void): Promise<void> {
    this.polling = true;
    this.poll(callback);
  }

  private async poll(callback: (response: DecisionResponse) => void): Promise<void> {
    while (this.polling) {
      try {
        const res = await axios.get(`${this.apiBase}/getUpdates`, {
          params: {
            offset: this.lastUpdateId + 1,
            timeout: 30,
            allowed_updates: ["message"],
          },
        });

        for (const update of res.data.result) {
          this.lastUpdateId = update.update_id;
          const msg = update.message;
          if (!msg || !msg.text) continue;

          const text = msg.text.trim();
          callback({
            decisionId: `tg-${msg.message_id}`,
            answer: text,
            respondedAt: Date.now(),
          });
        }
      } catch {
        await sleep(3000);
      }
    }
  }

  async stop(): Promise<void> {
    this.polling = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
