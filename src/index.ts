#!/usr/bin/env node

import { runMcpServer } from "./mcp-server.js";
import { runSetup } from "./setup.js";
import { runInit } from "./init.js";

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "-h" || cmd === "--help" || cmd === "help") {
  console.log(`notify-bridge — AI Agent 与 IM 的 Human-in-the-Loop 桥梁

用法:
  notify-bridge                    启动 MCP Server (stdin/stdout)
  notify-bridge init               交互式初始化向导
  notify-bridge setup              .mcp.json 写入当前项目
  notify-bridge setup --global     写入 ~/.claude.json (所有项目)
  notify-bridge -h                 显示此帮助

环境变量:
  FEISHU_APP_SECRET                飞书应用密钥 (必需)
  FEISHU_APP_ID                    飞书应用 ID
  BRIDGE_IM_TYPE                   IM 类型 (feishu | telegram | mock)

示例:
  notify-bridge init               # 首次使用: 填凭证 + 检查权限 + 配 MCP
  notify-bridge setup --global     # 在已初始化后快速配全局 MCP
`);
  process.exit(0);
} else if (cmd === "init") {
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
