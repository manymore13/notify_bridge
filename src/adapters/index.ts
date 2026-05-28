import type { IMBotAdapter } from "./types.js";
import { config } from "../config.js";
import { TelegramAdapter } from "./telegram.js";
import { FeishuAdapter } from "./feishu.js";
import { MockAdapter } from "./mock.js";

export function createAdapter(): IMBotAdapter {
  if (config.im.type === "mock") return new MockAdapter();

  if (config.im.type === "feishu") {
    const feishu = config.im.feishu!;
    if (!feishu.appId || !feishu.appSecret) {
      throw new Error("飞书配置缺失: 需要 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量");
    }
    return new FeishuAdapter(feishu);
  }

  if (config.im.type === "telegram") {
    const tg = config.im.telegram!;
    if (!tg.botToken || !tg.chatId) {
      throw new Error("Telegram 配置缺失: 需要 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID 环境变量");
    }
    return new TelegramAdapter(tg.botToken, tg.chatId, tg.allowedUserIds);
  }

  throw new Error(`不支持的 IM 类型: ${config.im.type}`);
}

export type { IMBotAdapter } from "./types.js";
