import axios from "axios";

const APP_ID = "cli_aa9fe0750a7c9bc4";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "";

async function main() {
  const { data: tokenData } = await axios.post(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    { app_id: APP_ID, app_secret: APP_SECRET }
  );
  const token = tokenData.tenant_access_token;
  const H = { Authorization: `Bearer ${token}` };

  console.log("=== 权限诊断 ===\n");

  // 1. App visibility & type
  console.log("[1] 应用信息:");
  const app = await axios.get("https://open.feishu.cn/open-apis/bot/v3/info", { headers: H });
  console.log(`  名称: ${app.data.bot?.app_name}`);
  console.log(`  激活: ${app.data.bot?.activate_status} (1=未激活, 2=已激活)`);
  console.log(`  open_id: ${app.data.bot?.open_id}`);

  // 2. Test: try to read a message directly
  console.log("\n[2] IM 消息权限测试 (im/v1/messages):");
  try {
    const r = await axios.get("https://open.feishu.cn/open-apis/im/v1/messages", {
      headers: H,
      params: { receive_id_type: "open_id", receive_id: app.data.bot?.open_id, page_size: 1 }
    });
    console.log(`  code=${r.data.code} msg=${r.data.msg || "ok"}`);
  } catch (e: any) {
    console.log(`  HTTP ${e.response?.status}: ${e.response?.data?.msg?.slice(0, 100)}`);
  }

  // 3. Check if bot can receive events by trying subscription API via body
  console.log("\n[3] 事件订阅状态 (POST subscription):");
  try {
    const r = await axios.post(
      "https://open.feishu.cn/open-apis/event/v1/outbound/subscription",
      {},
      { headers: H }
    );
    console.log(`  code=${r.data.code} msg=${r.data.msg || "ok"}`);
  } catch (e: any) {
    console.log(`  HTTP ${e.response?.status}: ${e.response?.data?.msg?.slice(0, 150)}`);
  }

  // 4. Try to get subscription list
  console.log("\n[4] 已订阅事件列表:");
  try {
    const r = await axios.get(
      "https://open.feishu.cn/open-apis/event/v1/outbound/subscription/list",
      { headers: H }
    );
    if (r.data.code === 0) {
      const events = r.data.data?.items || [];
      if (events.length === 0) {
        console.log("  ⚠️ 没有订阅任何事件! 需要在后台添加 im.message.receive_v1");
      } else {
        for (const e of events) {
          console.log(`  - ${e.event_type || JSON.stringify(e)}`);
        }
      }
    } else {
      console.log(`  code=${r.data.code} msg=${r.data.msg}`);
    }
  } catch (e: any) {
    const msg = e.response?.data?.msg || e.message;
    console.log(`  HTTP ${e.response?.status}: ${msg?.slice(0, 150)}`);
    if (e.response?.status === 404) {
      console.log("  ⚠️ 事件订阅API不可用 — 可能长连接模式未启用，或应用未发布");
    }
  }

  // 5. Check if we can send messages (verify send permission works)
  console.log("\n[5] 发送权限测试 (仅测API权限, 不实际发送):");
  try {
    const r = await axios.get(
      "https://open.feishu.cn/open-apis/im/v1/messages/dummy",
      { headers: H }
    );
  } catch (e: any) {
    // 404 on dummy is expected, we're checking if we get a permission error instead
    const msg = e.response?.data?.msg || "";
    if (msg.includes("permission") || msg.includes("scope")) {
      console.log(`  ⚠️ 缺少权限: ${msg.slice(0, 100)}`);
    } else {
      console.log(`  API可访问 (返回 ${e.response?.status}, 正常的no-route响应)`);
    }
  }

  console.log("\n=== 诊断完成 ===");
  console.log(`
关键检查清单:
  [ ] 应用已发布 (发布管理 > 创建版本并发布)
  [ ] 权限已开通: im:message:read_as_bot (读取机器人消息)
  [ ] 权限已开通: im:message:send_as_bot (发送消息)
  [ ] 事件订阅: 长连接模式 + im.message.receive_v1
  [ ] 在飞书客户端给机器人发一条私信
`);
}

main().catch(e => console.error("FAIL:", e.message));
