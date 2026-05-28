import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import axios from "axios";

export async function runInit() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // 回车 = 使用默认值
  function ask(q: string): Promise<string>;
  function ask(q: string, def: string): Promise<string>;
  function ask(q: string, def?: string): Promise<string> {
    const prompt = def ? `${q} [${def}]: ` : `${q}: `;
    return new Promise((r) => rl.question(prompt, (a) => { r(a.trim() || def || ""); }));
  }

  console.log("\n⚙️  notify-bridge 初始化向导\n");

  // Try to load existing config
  const existingPaths = [
    join(homedir(), ".notify-bridge", "config.json"),
    join(process.cwd(), "config.json"),
  ];
  let existingConfig: any = null;
  let existingPath = "";
  for (const p of existingPaths) {
    if (existsSync(p)) {
      try {
        existingConfig = JSON.parse(readFileSync(p, "utf-8"));
        existingPath = p;
        break;
      } catch {}
    }
  }

  // Also read appSecret from MCP config env (previously saved by init)
  let savedSecret = "";
  const claudeJsonPath = join(homedir(), ".claude.json");
  if (existsSync(claudeJsonPath)) {
    try {
      const claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
      savedSecret = claudeJson?.mcpServers?.["notify-bridge"]?.env?.FEISHU_APP_SECRET || "";
    } catch {}
  }

  // 1. IM type — pre-fill from existing config if available
  let appId = process.env.FEISHU_APP_ID || "";
  let appSecret = process.env.FEISHU_APP_SECRET || savedSecret || "";
  let imType = (existingConfig?.im?.type || process.env.BRIDGE_IM_TYPE || "") as string;

  if (imType) {
    console.log(`IM 平台: ${imType === "feishu" ? "飞书" : "Telegram"} (从 ${existingPath || "环境变量"} 读取)`);
    appId = process.env.FEISHU_APP_ID || existingConfig?.im?.feishu?.appId || "";
  } else {
    console.log("选择 IM 平台:");
    console.log("  1. 飞书 (Feishu)");
    console.log("  2. Telegram");
    const imChoice = await ask("选择平台 (1=飞书 2=Telegram)", "1");
    imType = imChoice === "2" ? "telegram" : "feishu";
  }

  // 2. Credentials
  if (imType === "feishu") {
    console.log("\n📋 飞书应用凭证:");
    console.log("  🔗 没有应用? 一键创建: https://open.feishu.cn/app?createApp=1");

    if (appId) console.log(`  App ID: ${appId}`);
    else appId = await ask("  App ID", "");

    if (appSecret) console.log("  App Secret: ***");
    else appSecret = await ask("  App Secret: ");

    // 3. Check permissions & events
    console.log("\n🔍 验证飞书连接...");
    try {
      const tokenRes = await axios.post(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        { app_id: appId, app_secret: appSecret }
      );
      if (tokenRes.data.code !== 0) {
        console.log(`  ❌ 飞书返回错误: ${tokenRes.data.msg}`);
      } else {
        console.log("  ✅ 飞书连接成功!");
        const token = tokenRes.data.tenant_access_token;
        const H = { Authorization: `Bearer ${token}` };

        // Permissions
        const requiredPerms = [
          { id: "im:message:send_as_bot", name: "发送消息", desc: "以机器人身份发送消息" },
          { id: "im:message:read_as_bot", name: "读取消息", desc: "读取机器人收到的消息" },
        ];
        console.log("\n📋 必要权限:");
        const missing: typeof requiredPerms = [];
        for (const perm of requiredPerms) {
          const ok = await testPermission(token, perm.id);
          console.log(`  ${ok ? "✅" : "❌"} ${perm.name}`);
          if (!ok) missing.push(perm);
        }
        if (missing.length > 0) {
          console.log(`\n⚠️  缺少 ${missing.length} 项权限:`);
          const permsParam = missing.map((m) => m.id).join(",");
          console.log(`  🔗 一键开通: https://open.feishu.cn/app/${appId}/auth?q=${permsParam}`);
          console.log("  开通后需发布版本才能生效");
        } else {
          console.log("  ✅ 全部就绪");
        }

        // Events
        console.log("\n📡 检查事件订阅...");
        const eventsOk = await checkEvents(token, appId);
        if (!eventsOk) {
          console.log("  ⚠️  事件订阅未配置");
          console.log(`  🔗 一键配置: https://open.feishu.cn/app/${appId}/events`);
          console.log("  1. 订阅方式 → 长连接");
          console.log("  2. 添加事件: im.message.receive_v1");
          console.log("  3. 发布版本");
        } else {
          console.log("  ✅ 已配置");
        }

        // Verify WS connection
        if (eventsOk || await confirm(ask, "\n是否启动长连接验证? (y/n, 默认y): ")) {
          console.log("\n🔗 启动长连接 (30秒)...");
          console.log("  请在飞书后台点击「验证连接状态」");
          const { createLarkChannel } = await import("@larksuiteoapi/node-sdk");
          const channel = createLarkChannel({ appId, appSecret });
          let verified = false;
          channel.on({ message: () => { verified = true; } });
          await channel.connect();
          console.log("  ✅ 已连接! 等待验证...");
          await new Promise<void>((resolve) => {
            let remaining = 30;
            const timer = setInterval(() => {
              remaining--;
              process.stdout.write(`\r  ⏳ ${remaining}s `);
              if (remaining <= 0 || verified) {
                clearInterval(timer);
                console.log(verified ? "\n  ✅ 验证通过!" : "\n  ⏰ 超时, 请检查飞书后台配置");
                resolve();
              }
            }, 1000);
          });
          await channel.disconnect();
        }
      }
    } catch (e: any) {
      console.log(`  ❌ 连接失败: ${e.message}`);
    }
  } else {
    // Telegram
    const botToken = process.env.TELEGRAM_BOT_TOKEN || existingConfig?.im?.telegram?.botToken || await ask("  Bot Token: ");
    const chatId = process.env.TELEGRAM_CHAT_ID || existingConfig?.im?.telegram?.chatId || await ask("  Chat ID: ");
  }

  // 4. Save config
  const configDir = existingPath ? join(existingPath, "..") : join(homedir(), ".notify-bridge");
  const configPath = join(configDir, "config.json");
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

  const config = {
    im: imType === "feishu"
      ? { type: "feishu", feishu: { appId } }
      : { type: "telegram", telegram: { botToken: process.env.TELEGRAM_BOT_TOKEN || "", chatId: process.env.TELEGRAM_CHAT_ID || "" } },
    defaultTimeoutMs: existingConfig?.defaultTimeoutMs || 300000,
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`\n✅ 配置已保存: ${configPath}`);

  // 5. Setup MCP
  // Auto-save appSecret to MCP config so next init picks it up
  if (appSecret) {
    saveMcpConfig(appSecret, true); // default: global
  }

  // 5. Setup MCP
  console.log("\n🔌 Claude Code MCP 配置:");
  console.log("  1. 用户级 (~/.claude.json, 所有项目) → 回车");
  console.log("  2. 项目级 (./.mcp.json, 仅当前项目)");
  const mcpScope = await ask("请选择", "1");
  const isGlobal = mcpScope !== "2";
  saveMcpConfig(appSecret, isGlobal);

  console.log("\n🎉 完成! 重启 Claude Code 后生效。\n");
  rl.close();
}

function saveMcpConfig(appSecret: string, isGlobal: boolean) {
  const mcpConfigPath = isGlobal
    ? join(homedir(), ".claude.json")
    : join(process.cwd(), ".mcp.json");

  let mcpConfig: any = {};
  if (existsSync(mcpConfigPath)) {
    try { mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch {}
  }
  mcpConfig.mcpServers = mcpConfig.mcpServers || {};
  const prev = mcpConfig.mcpServers["notify-bridge"] || {};
  mcpConfig.mcpServers["notify-bridge"] = {
    command: "notify-bridge",
    args: [],
    env: appSecret ? { ...prev.env, FEISHU_APP_SECRET: appSecret } : prev.env,
  };
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  console.log(`✅ MCP 配置已写入: ${mcpConfigPath}`);
}

async function confirm(ask: (q: string) => Promise<string>, q: string): Promise<boolean> {
  const a = await ask(q);
  return a === "" || a.toLowerCase() === "y" || a === "1";
}

async function checkEvents(token: string, appId: string): Promise<boolean> {
  try {
    const r = await axios.get(
      "https://open.feishu.cn/open-apis/event/v1/outbound/subscription/list",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (r.data?.code === 0) {
      return (r.data?.data?.items || []).some((i: any) =>
        i.event_type === "im.message.receive_v1"
      );
    }
    return false;
  } catch { return false; }
}

async function testPermission(token: string, permId: string): Promise<boolean> {
  const H = { Authorization: `Bearer ${token}` };
  try {
    if (permId === "im:message:send_as_bot") {
      const r = await axios.get("https://open.feishu.cn/open-apis/bot/v3/info", { headers: H });
      return r.data.code === 0;
    }
    if (permId === "im:message:read_as_bot") {
      const r = await axios.get("https://open.feishu.cn/open-apis/im/v1/messages", {
        headers: H, params: { receive_id_type: "open_id", receive_id: "ou_dummy", page_size: 1 }
      });
      const msg = r.data?.msg || "";
      return !msg.includes("Access denied") && !msg.includes("scope");
    }
    return false;
  } catch (e: any) {
    const msg = e.response?.data?.msg || e.message || "";
    return !msg.includes("Access denied") && !msg.includes("scope");
  }
}
