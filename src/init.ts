import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import axios from "axios";

// ── helpers ──

function loadJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}
function saveJson(path: string, data: any) {
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ── main ──

export async function runInit() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, def = "") =>
    new Promise<string>((r) => rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => r(a.trim() || def)));

  console.log("\n⚙️  notify-bridge 初始化\n");

  // ═══ Step 1: 加载已有配置 ═══
  const homeConfig = join(homedir(), ".notify-bridge", "config.json");
  const localConfig = join(process.cwd(), "config.json");
  const claudeJson = join(homedir(), ".claude.json");

  const existing = loadJson(homeConfig) || loadJson(localConfig) || {};
  const mcpEntry = loadJson(claudeJson)?.mcpServers?.["notify-bridge"] || {};
  const savedSecret = mcpEntry.env?.FEISHU_APP_SECRET || "";

  let appId = process.env.FEISHU_APP_ID || existing.im?.feishu?.appId || "";
  let appSecret = process.env.FEISHU_APP_SECRET || savedSecret || "";
  const imType = existing.im?.type || "feishu";

  console.log(`平台: ${imType === "feishu" ? "飞书" : "Telegram"}`);

  // ═══ Step 2: 填写凭证 ═══
  console.log("\n📋 凭证");
  console.log("  没有应用? https://open.feishu.cn/app?createApp=1");

  if (appId) console.log(`  App ID: ${appId}`);
  else appId = await ask("  App ID", "");

  while (!appSecret) {
    appSecret = await ask("  App Secret", "");
    if (!appSecret) console.log("  不能为空");
  }
  if (savedSecret && savedSecret === appSecret) console.log("  (从已保存配置读取)");

  // ═══ Step 3: 验证凭证 ═══
  let token = "";
  console.log("\n🔍 验证连接...");
  while (!token) {
    try {
      const res = await axios.post(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        { app_id: appId, app_secret: appSecret }
      );
      if (res.data.code !== 0) {
        console.log(`  ❌ ${res.data.msg}`);
        appSecret = await ask("  重新输入 App Secret", "");
        continue;
      }
      token = res.data.tenant_access_token;
      console.log("  ✅ 连接成功");
    } catch (e: any) {
      console.log(`  ❌ ${e.message}`);
      appSecret = await ask("  重新输入 App Secret", "");
    }
  }

  // ═══ Step 4: 检查权限 ═══
  console.log("\n📋 检查权限...");
  const perms = [
    { id: "im:message:send_as_bot", name: "发送消息" },
    { id: "im:message:read_as_bot", name: "读取消息" },
  ];
  const missing: string[] = [];
  for (const p of perms) {
    const ok = await testPerm(token, p.id);
    console.log(`  ${ok ? "✅" : "❌"} ${p.name}`);
    if (!ok) missing.push(p.id);
  }
  if (missing.length) {
    console.log(`  🔗 一键开通: https://open.feishu.cn/app/${appId}/auth?q=${missing.join(",")}`);
    console.log("  开通后需发布版本");
  }

  // ═══ Step 5: 检查事件订阅 ═══
  console.log("\n📡 检查事件订阅...");
  const hasEvents = await checkEvents(token);
  if (hasEvents) {
    console.log("  ✅ 已配置");
  } else {
    console.log("  ⚠️  未配置");
    console.log(`  🔗 一键配置: https://open.feishu.cn/app/${appId}/events`);
    console.log("  1. 订阅方式 → 长连接");
    console.log("  2. 添加事件: im.message.receive_v1");
    console.log("  3. 发布版本");
  }

  // ═══ Step 6: 长连接验证 ═══
  const doVerify = await ask("\n启动长连接验证? (y/n)", "y");
  if (doVerify === "y") {
    console.log("🔗 连接中... 请在飞书后台点击「验证连接状态」");
    const { createLarkChannel } = await import("@larksuiteoapi/node-sdk");
    const ch = createLarkChannel({ appId, appSecret });
    let ok = false;
    ch.on({ message: () => { ok = true; } });
    await ch.connect();
    console.log("  ✅ 已连接, 等待验证 (30秒)...");
    for (let i = 30; i > 0 && !ok; i--) {
      process.stdout.write(`\r  ⏳ ${i}s `);
      await sleep(1000);
    }
    console.log(ok ? "\n  ✅ 验证通过!" : "\n  ⏰ 超时");
    await ch.disconnect();
  }

  // ═══ Step 7: 写入配置 (统一作用域) ═══
  console.log("\n📂 配置写入位置:");
  console.log("  1. 全局 (~/.notify-bridge + ~/.claude.json + ~/.claude/CLAUDE.md) → 回车");
  console.log("  2. 当前项目 (./config.json + .mcp.json + CLAUDE.md)");
  const scope = await ask("请选择", "1");
  const isGlobal = scope !== "2";
  const root = isGlobal ? join(homedir(), ".notify-bridge") : process.cwd();

  // config.json
  saveJson(join(root, "config.json"), {
    im: { type: "feishu", feishu: { appId } },
    defaultTimeoutMs: existing.defaultTimeoutMs || 300000,
  });

  // MCP config
  const mcpPath = isGlobal
    ? join(homedir(), ".claude.json")
    : join(process.cwd(), ".mcp.json");
  const mcp = loadJson(mcpPath) || {};
  mcp.mcpServers = mcp.mcpServers || {};
  mcp.mcpServers["notify-bridge"] = {
    command: "notify-bridge",
    args: [],
    env: { FEISHU_APP_SECRET: appSecret },
  };
  saveJson(mcpPath, mcp);

  // Agent rules
  const mdPath = isGlobal
    ? join(homedir(), ".claude", "CLAUDE.md")
    : join(process.cwd(), "CLAUDE.md");
  const rule = `# Human-in-the-Loop 决策规则

你有 notify-bridge MCP 工具向飞书发消息。**所有 agent（包括子 agent）都必须遵守**。

## 核心原则
任何需要人类介入的场景，都必须发飞书，禁止使用 AskUserQuestion 弹窗。

## 必须发飞书的场景
### 需要决策/选择 → request_decision
- 删除文件、git push/force push、安装依赖等不可逆操作
- 架构选型、方案选择 → 列出选项
- 头脑风暴有多个方案 → 发飞书选
- 需要澄清/补充需求 → 发飞书问

### 只需通知 → send_notification
- 长任务（>30秒）完成 → "完成: xxx"

调用: request_decision("问题", ["选项1","选项2"]) 发飞书卡片阻塞等回复
`;
  const existingMd = existsSync(mdPath) ? readFileSync(mdPath, "utf-8") : "";
  if (!existingMd.includes("notify-bridge")) {
    writeFileSync(mdPath, (existingMd ? existingMd + "\n\n" : "") + rule);
  }

  console.log(`\n  写入完成 (${isGlobal ? "全局" : "当前项目"}):`);
  console.log(`  ✅ ${join(root, "config.json")}`);
  console.log(`  ✅ ${mcpPath}`);
  console.log(`  ✅ ${mdPath}`);

  console.log("\n🎉 完成! 重启 Claude Code 后生效。\n");
  rl.close();
}

// ── utils ──

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function checkEvents(token: string): Promise<boolean> {
  try {
    const r = await axios.get(
      "https://open.feishu.cn/open-apis/event/v1/outbound/subscription/list",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return (r.data?.data?.items || []).some((i: any) => i.event_type === "im.message.receive_v1");
  } catch { return false; }
}

async function testPerm(token: string, perm: string): Promise<boolean> {
  try {
    const H = { Authorization: `Bearer ${token}` };
    if (perm === "im:message:send_as_bot") {
      return (await axios.get("https://open.feishu.cn/open-apis/bot/v3/info", { headers: H })).data.code === 0;
    }
    const r = await axios.get("https://open.feishu.cn/open-apis/im/v1/messages", {
      headers: H, params: { receive_id_type: "open_id", receive_id: "ou_dummy", page_size: 1 }
    });
    const msg = r.data?.msg || "";
    return !msg.includes("Access denied") && !msg.includes("scope");
  } catch (e: any) {
    const msg = e.response?.data?.msg || "";
    return !msg.includes("Access denied") && !msg.includes("scope");
  }
}
