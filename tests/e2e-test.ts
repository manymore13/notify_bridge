import { FeishuAdapter } from "../src/adapters/feishu.js";
import { NotifyBridge } from "../src/bridge.js";
import { config } from "../src/config.js";

async function main() {
  console.log("=== notify-bridge 端到端测试 ===\n");
  console.log(`IM: ${config.im.type}`);
  console.log(`超时: ${config.defaultTimeoutMs / 1000}s\n`);

  const adapter = new FeishuAdapter(config.im.feishu!);
  const bridge = new NotifyBridge(adapter);

  await bridge.start();

  // Wait for user to bind
  console.log("⏳ 等待你在飞书给机器人发消息...\n");

  let bound = false;
  const checkInterval = setInterval(async () => {
    const status = await bridge.getStatus();
    if (status.ready && !bound) {
      bound = true;
      console.log("✅ 绑定成功！");
      console.log(`   openId: ${status.detail.openId}`);
      console.log(`   chatId: ${status.detail.chatId || "(未捕获)"}\n`);

      // Send a test notification
      console.log("发送测试通知...");
      await bridge.sendMessage("✅ notify-bridge 端到端测试成功！Agent 需要决策时会通过我联系你。");
      console.log("测试通知已发送，请检查飞书。\n");

      console.log("============================================");
      console.log("  端到端测试通过！按 Ctrl+C 退出");
      console.log("  接下来可以配置 Claude Code MCP 了");
      console.log("============================================");
    }
  }, 1000);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    clearInterval(checkInterval);
    console.log("\n正在关闭...");
    await bridge.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("测试失败:", err.message);
  process.exit(1);
});
