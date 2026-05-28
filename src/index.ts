#!/usr/bin/env node

import { runMcpServer } from "./mcp-server.js";
import { runSetup } from "./setup.js";

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "setup") {
  const globalMode = args.includes("--global") || args.includes("-g");
  runSetup({ global: globalMode }).catch((err) => {
    console.error("Setup failed:", err.message);
    process.exit(1);
  });
} else {
  // Default: run as MCP server
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  runMcpServer().catch((err) => {
    console.error("Fatal: notify-bridge failed to start:", err);
    process.exit(1);
  });
}
