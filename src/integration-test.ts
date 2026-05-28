#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    passed++;
    console.error(`  PASS: ${testName}`);
  } else {
    failed++;
    console.error(`  FAIL: ${testName}${detail ? ` — ${detail}` : ""}`);
  }
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: any;
}

async function runIntegrationTests() {
  console.error("=== notify-bridge MCP Integration Tests ===\n");

  const serverPath = resolve("dist/index.js");

  // Use a test config that uses mock mode
  const env = {
    ...process.env,
    BRIDGE_IM_TYPE: "mock",
  };

  const proc = spawn("node", [serverPath], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rl = createInterface({ input: proc.stdout! });
  let requestId = 0;

  function sendRequest(method: string, params: any = {}): Promise<JsonRpcResponse> {
    const id = ++requestId;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const line = JSON.stringify(req) + "\n";
    proc.stdin!.write(line);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Request ${id} timeout`)), 10000);
      const handler = (line: string) => {
        try {
          const res: JsonRpcResponse = JSON.parse(line);
          if (res.id === id || "result" in res || "error" in res) {
            clearTimeout(timeout);
            rl.removeListener("line", handler);
            resolve(res);
          }
        } catch {}
      };
      rl.on("line", handler);
    });
  }

  // Test 1: Initialize
  {
    console.error("\n[Test 1] MCP Initialize");
    const res = await sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    assert(
      res.result?.serverInfo?.name === "notify-bridge",
      "Server name is notify-bridge"
    );
    assert(
      res.result?.protocolVersion != null,
      "Protocol version returned"
    );
    assert(
      res.result?.capabilities?.tools != null,
      "Server supports tools"
    );
  }

  // Test 2: Send initialized notification
  {
    console.error("\n[Test 2] Initialized notification");
    const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
    proc.stdin!.write(notif);
    // No response expected for notification
    await new Promise((r) => setTimeout(r, 500));
    assert(true, "Initialized notification sent");
  }

  // Test 3: List tools
  {
    console.error("\n[Test 3] List tools");
    const res = await sendRequest("tools/list", {});
    const tools = res.result?.tools || [];
    const toolNames = tools.map((t: any) => t.name);

    assert(toolNames.includes("request_decision"), "request_decision tool exists");
    assert(toolNames.includes("send_notification"), "send_notification tool exists");
    assert(toolNames.includes("check_pending"), "check_pending tool exists");
    assert(toolNames.includes("bridge_status"), "bridge_status tool exists");
    assert(tools.length === 4, `4 tools total, got ${tools.length}`);

    // Verify tool schemas
    const rd = tools.find((t: any) => t.name === "request_decision");
    assert(rd?.inputSchema?.required?.includes("question"), "request_decision requires 'question'");
  }

  // Test 4: Call send_notification
  {
    console.error("\n[Test 4] send_notification tool");
    const res = await sendRequest("tools/call", {
      name: "send_notification",
      arguments: { message: "集成测试通知" },
    });
    const text = res.result?.content?.[0]?.text;
    assert(text?.includes("sent"), "send_notification returns success");
  }

  // Test 5: Call check_pending
  {
    console.error("\n[Test 5] check_pending tool");
    const res = await sendRequest("tools/call", {
      name: "check_pending",
      arguments: {},
    });
    const result = JSON.parse(res.result?.content?.[0]?.text || "{}");
    assert(Array.isArray(result.pending), "check_pending returns pending array");
    assert(result.pending.length === 0, "No pending decisions initially");
  }

  // Test 6: Call bridge_status
  {
    console.error("\n[Test 6] bridge_status tool");
    const res = await sendRequest("tools/call", {
      name: "bridge_status",
      arguments: {},
    });
    const result = JSON.parse(res.result?.content?.[0]?.text || "{}");
    assert(result.imType === "mock", "bridge_status returns imType=mock");
    assert(typeof result.ready === "boolean", "bridge_status returns ready flag");
    assert(typeof result.pendingCount === "number", "bridge_status returns pendingCount");
  }

  // Summary
  console.error(`\n=== 集成测试: ${passed} 通过, ${failed} 失败 ===`);

  proc.kill();
  process.exit(failed > 0 ? 1 : 0);
}

runIntegrationTests().catch((err) => {
  console.error("集成测试失败:", err);
  process.exit(1);
});
