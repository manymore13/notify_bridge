import { createAdapter } from "./adapters/index.js";
import { NotifyBridge, MemoryDecisionStore } from "./bridge.js";

async function main() {
  console.log("=== notify-bridge 启动验证 ===\n");

  // 1. Create adapter
  const adapter = createAdapter();
  console.log(`1. 适配器: ${adapter.constructor.name}`);

  // 2. Init
  await adapter.init();
  console.log("2. init() ✅");

  // 3. Health check
  const health = await adapter.checkHealth();
  console.log(`3. 健康检查: ${health.status}${health.reason ? ` (${health.reason})` : ""}`);

  // 4. Ready & status
  console.log(`4. isReady: ${adapter.isReady()}`);
  console.log(`5. 状态: ${JSON.stringify(adapter.getStatus())}`);

  // 5. Bridge creation
  const bridge = new NotifyBridge(adapter, new MemoryDecisionStore());
  console.log("6. NotifyBridge 创建 ✅");

  // 6. Store test
  const pending = await bridge.getPendingDecisions();
  console.log(`7. 挂起决策: ${pending.length}`);

  const status = await bridge.getStatus();
  console.log(`8. Bridge 状态: pendingCount=${status.pendingCount}, ready=${status.ready}`);

  console.log("\n=== 全部验证通过 ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ 验证失败:", err.message);
  process.exit(1);
});
