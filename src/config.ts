import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  receiveId?: string;
  receiveIdType?: "open_id" | "user_id" | "email";
  allowedUserIds?: string[];
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  allowedUserIds?: string[];
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

/** 向上递归查找 config.json, 回退到 ~/.notify-bridge/config.json */
function findConfigPath(): string | null {
  let dir = process.cwd();
  while (true) {
    const p = join(dir, "config.json");
    if (existsSync(p)) return p;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  const homePath = join(homedir(), ".notify-bridge", "config.json");
  if (existsSync(homePath)) return homePath;
  return null;
}

function loadConfig(): BridgeConfig {
  let fileConfig: any = {};
  const configPath = findConfigPath();
  if (configPath) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      console.error(`[config] ${configPath} 解析失败，将使用环境变量`);
    }
  }

  const imType = (process.env.BRIDGE_IM_TYPE || fileConfig.im?.type || "telegram") as any;
  const fcfg = fileConfig.im?.feishu || {};
  const tcfg = fileConfig.im?.telegram || {};

  const parseIds = (raw: string | undefined): string[] | undefined => {
    if (!raw) return undefined;
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  };

  const im: IMConfig = {
    type: imType,
    feishu: {
      appId: process.env.FEISHU_APP_ID || fcfg.appId || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
      receiveId: process.env.FEISHU_RECEIVE_ID || fcfg.receiveId || undefined,
      receiveIdType: (process.env.FEISHU_RECEIVE_ID_TYPE || fcfg.receiveIdType || "open_id") as any,
      allowedUserIds: parseIds(process.env.FEISHU_ALLOWED_USER_IDS)
        || (fcfg.allowedUserIds?.length ? fcfg.allowedUserIds : undefined),
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || "",
      chatId: process.env.TELEGRAM_CHAT_ID || tcfg.chatId || "",
      allowedUserIds: parseIds(process.env.TELEGRAM_ALLOWED_USER_IDS)
        || (tcfg.allowedUserIds?.length ? tcfg.allowedUserIds : undefined),
    },
  };

  return {
    im,
    defaultTimeoutMs:
      Number(process.env.BRIDGE_DEFAULT_TIMEOUT_MS) ||
      fileConfig.defaultTimeoutMs ||
      300000,
  };
}

export const config = loadConfig();
