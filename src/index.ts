#!/usr/bin/env node

import { runMcpServer } from "./mcp-server.js";
import { runSetup } from "./setup.js";
import { runInit } from "./init.js";

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "init") {
  runInit().catch((err) => {
    console.error("初始化失败:", err.message);
    process.exit(1);
  });
} else if (cmd === "setup") {
  const globalMode = args.includes("--global") || args.includes("-g");
  runSetup({ global: globalMode }).catch((err) => {
    console.error("Setup failed:", err.message);
    process.exit(1);
  });
} else {
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  runMcpServer().catch((err) => {
    console.error("Fatal: notify-bridge failed to start:", err);
    console.error("提示: 运行 `notify-bridge init` 进入交互式初始化向导");
    process.exit(1);
  });
}
