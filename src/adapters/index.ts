import type { IMBotAdapter } from "./types.js";
import { config } from "../config.js";
import { TelegramAdapter } from "./telegram.js";
import { FeishuAdapter } from "./feishu.js";
import { MockAdapter } from "./mock.js";

export function createAdapter(): IMBotAdapter {
  if (config.im.type === "mock") {
    return new MockAdapter();
  }

  if (config.im.type === "feishu") {
    const feishu = config.im.feishu!;
    if (!feishu.appId || !feishu.appSecret) {
      throw new Error("Feishu 配置缺失: 需要 appId 和 appSecret");
    }
    // receiveId 可选 — 如果不填，从用户第一条消息中自动捕获
    return new FeishuAdapter(feishu);
  }

  if (config.im.type === "telegram") {
    const tg = config.im.telegram!;
    if (!tg.botToken || !tg.chatId) {
      throw new Error("Telegram 配置缺失: 需要 botToken 和 chatId");
    }
    return new TelegramAdapter(tg.botToken, tg.chatId);
  }

  throw new Error(`不支持的 IM 类型: ${config.im.type}，支持: feishu, telegram, mock`);
}

export type { IMBotAdapter } from "./types.js";
