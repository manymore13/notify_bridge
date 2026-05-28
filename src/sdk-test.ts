import * as Lark from "@larksuiteoapi/node-sdk";

const APP_ID = process.env.FEISHU_APP_ID || "YOUR_APP_ID";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "YOUR_APP_SECRET";

async function main() {
  console.log("=== 飞书官方 SDK 长连接测试 ===\n");

  const wsClient = new Lark.WSClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
    loggerLevel: Lark.LoggerLevel.info,
  });

  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": (data: any) => {
      const event = data.event || data;
      const msg = event.message;
      const sender = event.sender;
      const openId = sender?.sender_id?.open_id;
      const chatId = msg?.chat_id;
      let text = "";

      try {
        text = JSON.parse(msg?.content || "{}").text || "";
      } catch {}

      console.log("\n📩 === 收到消息 ===");
      console.log(`   open_id : ${openId}`);
      console.log(`   chat_id : ${chatId}`);
      console.log(`   内容    : ${text}`);
      console.log("==================\n");
      console.log("✅ 长连接正常工作！按 Ctrl+C 退出");
      return Promise.resolve();
    },
  });

  console.log("启动长连接...\n");
  try {
    await wsClient.start({ eventDispatcher: dispatcher });
    console.log("✅ 长连接已建立！");
    console.log("============================================");
    console.log("  去飞书给机器人发一条消息测试");
    console.log("  按 Ctrl+C 退出");
    console.log("============================================\n");
  } catch (err: any) {
    console.error("❌ 连接失败:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("错误:", err.message);
  process.exit(1);
});
