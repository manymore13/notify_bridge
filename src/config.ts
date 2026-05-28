import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /** 可选：如果配置了直接使用，否则从第一条消息中自动捕获 */
  receiveId?: string;
  receiveIdType?: "open_id" | "user_id" | "email";
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface IMConfig {
  type: "feishu" | "telegram" | "mock";
  feishu?: FeishuConfig;
  telegram?: TelegramConfig;
}

export interface BridgeConfig {
  im: IMConfig;
  defaultTimeoutMs: number;
}

function loadConfig(): BridgeConfig {
  const configPath = resolve(process.cwd(), "config.json");
  let fileConfig: any = {};
  try {
    fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    // No config file, use env vars
  }

  // 环境变量优先于 config.json
  const imType = process.env.BRIDGE_IM_TYPE || fileConfig.im?.type || "telegram";
  const fcfg = fileConfig.im?.feishu || {};

  const im: IMConfig = {
    type: imType,
    feishu: {
      // 凭证强制从环境变量读取，不允许在 config.json 中明文存储
      appId: process.env.FEISHU_APP_ID || fcfg.appId || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
      receiveId: process.env.FEISHU_RECEIVE_ID || fcfg.receiveId || undefined,
      receiveIdType: (process.env.FEISHU_RECEIVE_ID_TYPE || fcfg.receiveIdType || "open_id") as any,
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || "",
      chatId: process.env.TELEGRAM_CHAT_ID || fileConfig.im?.telegram?.chatId || "",
    },
  };

  return {
    im,
    defaultTimeoutMs: fileConfig.defaultTimeoutMs || Number(process.env.BRIDGE_DEFAULT_TIMEOUT_MS) || 300000,
  };
}

export const config = loadConfig();
