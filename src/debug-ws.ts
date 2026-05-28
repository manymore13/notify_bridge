import * as Lark from "@larksuiteoapi/node-sdk";

const APP_ID = "cli_aa9fe0750a7c9bc4";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "";

if (!APP_SECRET) {
  console.error("请设置 FEISHU_APP_SECRET 环境变量");
  process.exit(1);
}

async function main() {
  console.log("=== WebSocket 调试模式 ===\n");

  const wsClient = new Lark.WSClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
    loggerLevel: Lark.LoggerLevel.debug,  // 开启 debug 日志
  });

  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": (data: any) => {
      console.log("\n📩 im.message.receive_v1 事件!");
      console.log(JSON.stringify(data, null, 2).slice(0, 500));
      return Promise.resolve();
    },
    "card.action.trigger": (data: any) => {
      console.log("\n🃏 card.action.trigger 事件!");
      console.log(JSON.stringify(data, null, 2).slice(0, 500));
      return Promise.resolve();
    },
  });

  // 注册通配事件监听，捕获所有事件类型
  (dispatcher as any).register({
    "*": (data: any) => {
      console.log("\n🌐 未知事件:", JSON.stringify(data, null, 2).slice(0, 300));
      return Promise.resolve();
    },
  });

  console.log("启动长连接...\n");
  await wsClient.start({ eventDispatcher: dispatcher });
  console.log("✅ 已连接! 去飞书发消息...\n");
  console.log("按 Ctrl+C 退出\n");
}

main().catch((err) => {
  console.error("错误:", err.message);
  process.exit(1);
});
