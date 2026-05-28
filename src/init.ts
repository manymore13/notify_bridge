import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import axios from "axios";

export async function runInit() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  function ask(q: string): Promise<string> {
    return new Promise((r) => rl.question(q, (a) => { r(a.trim()); }));
  }

  console.log("\n⚙️  notify-bridge 初始化向导\n");

  // 1. IM type
  console.log("选择 IM 平台:");
  console.log("  1. 飞书 (Feishu)");
  console.log("  2. Telegram");
  const imChoice = await ask("请选择 (1/2, 默认1): ");
  const imType = imChoice === "2" ? "telegram" : "feishu";

  // 2. Feishu credentials
  let appId = process.env.FEISHU_APP_ID || "";
  let appSecret = process.env.FEISHU_APP_SECRET || "";

  if (imType === "feishu") {
    console.log("\n📋 飞书应用凭证:");
    console.log("  🔗 没有应用? 一键创建: https://open.feishu.cn/app?createApp=1");

    if (!appId) appId = await ask("  App ID: ");
    else console.log(`  App ID: ${appId} (从环境变量读取)`);

    if (!appSecret) appSecret = await ask("  App Secret: ");
    else console.log("  App Secret: *** (从环境变量读取)");

    // 3. Check permissions
    console.log("\n🔍 检查应用权限...");
    try {
      const tokenRes = await axios.post(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        { app_id: appId, app_secret: appSecret }
      );

      if (tokenRes.data.code !== 0) {
        console.log(`  ❌ 无法获取 token: ${tokenRes.data.msg}`);
      } else {
        console.log("  ✅ 飞书连接成功!");
        const token = tokenRes.data.tenant_access_token;
        const H = { Authorization: `Bearer ${token}` };

        // Required permissions
        const requiredPerms = [
          { id: "im:message:send_as_bot", name: "发送消息", desc: "以机器人身份发送消息" },
          { id: "im:message:read_as_bot", name: "读取消息", desc: "读取机器人收到的消息" },
        ];

        console.log("\n📋 必要权限:");
        const missing: typeof requiredPerms = [];
        for (const perm of requiredPerms) {
          // Try to test the permission
          const ok = await testPermission(token, perm.id);
          const icon = ok ? "✅" : "❌";
          console.log(`  ${icon} ${perm.name} (${perm.id})`);
          if (!ok) missing.push(perm);
        }

        if (missing.length > 0) {
          console.log(`\n⚠️  缺少 ${missing.length} 项权限:`);
          for (const m of missing) {
            console.log(`  - ${m.name}: ${m.desc}`);
          }
          console.log(`\n🔗 一键开通链接 (复制到浏览器打开):`);
          const permsParam = missing.map((m) => m.id).join(",");
          const permUrl = `https://open.feishu.cn/app/${appId}/auth?q=${permsParam}&op_from=init`;
          console.log(`  ${permUrl}`);
          console.log(`\n  开通后需要在「发布管理」中创建版本并发布才能生效。`);
        } else {
          console.log("\n  ✅ 所有必要权限已开通!");
        }

        // Check event subscription
        console.log("\n📡 检查事件订阅...");
        const eventsOk = await checkEvents(token, appId);
        if (!eventsOk) {
          console.log("\n⚠️  事件订阅未配置!");
          console.log(`  🔗 一键配置: https://open.feishu.cn/app/${appId}/events`);
          console.log("  1. 订阅方式选「长连接」");
          console.log("  2. 添加事件: im.message.receive_v1");
          console.log("  3. 发布管理 → 创建版本并发布");
          console.log("\n  配置完成后，这里启动长连接帮你验证...");
        }

        // Start WS client for verification
        console.log("\n🔗 启动长连接 (30秒)...");
        console.log("  请在飞书后台点击「验证连接状态」按钮");
        const { createLarkChannel } = await import("@larksuiteoapi/node-sdk");
        const channel = createLarkChannel({ appId, appSecret });
        let verified = false;
        channel.on({
          message: () => { verified = true; },
        });
        await channel.connect();
        console.log("  ✅ 长连接已建立!");

        if (!eventsOk) {
          console.log("\n  配置好事件订阅后点击验证...");
        }

        // Wait 30s for verification
        await new Promise<void>((resolve) => {
          let remaining = 30;
          const timer = setInterval(() => {
            remaining--;
            process.stdout.write(`\r  等待验证... ${remaining}s `);
            if (remaining <= 0 || verified) {
              clearInterval(timer);
              console.log(verified ? "\n  ✅ 验证通过!" : "\n  ⏰ 超时, 请检查配置");
              resolve();
            }
          }, 1000);
        });
        await channel.disconnect();
      }
    } catch (e: any) {
      console.log(`  ❌ 连接失败: ${e.message}`);
    }
  } else {
    console.log("\n📋 Telegram 配置:");
    const botToken = process.env.TELEGRAM_BOT_TOKEN || await ask("  Bot Token: ");
    const chatId = process.env.TELEGRAM_CHAT_ID || await ask("  Chat ID: ");
  }

  // 4. Save config
  console.log("\n📂 配置文件保存位置:");
  console.log("  1. 全局 (~/.notify-bridge/config.json)");
  console.log("  2. 当前项目 (./config.json)");
  const scope = await ask("请选择 (1/2, 默认1): ");
  const isGlobal = scope !== "2";

  const configDir = isGlobal ? join(homedir(), ".notify-bridge") : process.cwd();
  const configPath = join(configDir, "config.json");
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

  const config = {
    im: imType === "feishu"
      ? { type: "feishu", feishu: { appId } }
      : { type: "telegram", telegram: { botToken: process.env.TELEGRAM_BOT_TOKEN || "", chatId: process.env.TELEGRAM_CHAT_ID || "" } },
    defaultTimeoutMs: 300000,
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`✅ 配置已保存: ${configPath}`);

  // 5. Setup MCP
  console.log("\n🔌 配置 Claude Code MCP:");
  console.log("  1. 用户级 (~/.claude.json, 所有项目生效)");
  console.log("  2. 项目级 (当前目录 .mcp.json)");
  const mcpScope = await ask("请选择 (1/2, 默认1): ");
  const isGlobalMCP = mcpScope !== "2";

  const mcpConfigPath = isGlobalMCP
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

  // 6. Done
  console.log("\n🎉 初始化完成! 重启 Claude Code 后即可使用。\n");
  rl.close();
}

/** Check if event subscription is configured for the app */
async function checkEvents(token: string, appId: string): Promise<boolean> {
  const H = { Authorization: `Bearer ${token}` };
  try {
    // Try to list event subscriptions
    const r = await axios.get(
      "https://open.feishu.cn/open-apis/event/v1/outbound/subscription/list",
      { headers: H }
    );
    if (r.data?.code === 0) {
      const items = r.data?.data?.items || [];
      const hasMessageEvent = items.some((i: any) =>
        i.event_type === "im.message.receive_v1"
      );
      return hasMessageEvent;
    }
    // API not available — likely events not configured at all
    return false;
  } catch {
    return false;
  }
}

/** Test a single Feishu permission by trying the relevant API */
async function testPermission(token: string, permId: string): Promise<boolean> {
  const H = { Authorization: `Bearer ${token}` };
  try {
    if (permId === "im:message:send_as_bot") {
      // Can't fully test without receiveId, assume ok if no explicit deny
      const r = await axios.get("https://open.feishu.cn/open-apis/bot/v3/info", { headers: H });
      return r.data.code === 0;
    }
    if (permId === "im:message:read_as_bot") {
      const r = await axios.get("https://open.feishu.cn/open-apis/im/v1/messages", {
        headers: H, params: { receive_id_type: "open_id", receive_id: "ou_dummy", page_size: 1 }
      });
      // Not "access denied" → permission is active (even if the receive_id is wrong)
      const msg = r.data?.msg || "";
      return !msg.includes("Access denied") && !msg.includes("scope");
    }
    return false;
  } catch (e: any) {
    const msg = e.response?.data?.msg || e.message || "";
    return !msg.includes("Access denied") && !msg.includes("scope");
  }
}
