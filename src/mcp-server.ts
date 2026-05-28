import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NotifyBridge, RateLimitError } from "./bridge.js";
import { createAdapter } from "./adapters/index.js";

export async function runMcpServer() {
  const adapter = createAdapter();
  const bridge = new NotifyBridge(adapter);

  await bridge.start();

  const server = new McpServer({
    name: "notify-bridge",
    version: "0.11.0",
  });

  // Tool: request_decision
  server.tool(
    "request_decision",
    "向人类发送决策请求并等待回复。返回值来自IM, 严格按 selected_option 执行, 不要自行解读 raw_reply。",
    {
      question: z.string().describe("需要人类决策的问题内容"),
      options: z.array(z.string()).optional().describe("可选的选项列表"),
      timeout_ms: z.number().optional().describe("等待超时（毫秒），默认300000（5分钟）"),
    },
    async ({ question, options, timeout_ms }) => {
      try {
        const answer = await bridge.requestDecision(question, options, timeout_ms);
        const isOption = options && options.includes(answer);
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "answered",
            selected_option: isOption ? answer : null,
            raw_reply: answer,
            source: "im",
            warning: isOption ? undefined
              : "回复不是预设选项, 请检查是否为有效决策。若为无关文本请忽略并重新询问。",
          }) }],
        };
      } catch (err: any) {
        if (err instanceof RateLimitError) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              status: "rate_limited",
              retry_after_ms: err.retryAfterMs,
              hint: `频控保护, 请在 ${Math.round(err.retryAfterMs / 1000)} 秒后重试。不要连续重试。`,
            }) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "timeout",
            error: err.message,
            original_question: question,
            hint: "人类未在IM上回复。请在终端重新展示问题，直接获取回复。",
          }) }],
          isError: true,
        };
      }
    }
  );

  // Tool: send_notification
  server.tool(
    "send_notification",
    "向人类发送一条通知消息，不等待回复。用于汇报进度、通知完成等场景。",
    {
      message: z.string().describe("要发送的通知内容"),
    },
    async ({ message }) => {
      try {
        await bridge.sendMessage(message);
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "sent" }) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "rate_limited",
            error: err.message,
          }) }],
          isError: true,
        };
      }
    }
  );

  // Tool: check_pending
  server.tool(
    "check_pending",
    "查看当前挂起的等待人类决策的请求列表",
    {},
    async () => {
      const pending = await bridge.getPendingDecisions();
      return {
        content: [{ type: "text", text: JSON.stringify({ pending }) }],
      };
    }
  );

  // Tool: bridge_status
  server.tool(
    "bridge_status",
    "检查 notify-bridge 的连接状态，确认是否已经连上人类的IM",
    {},
    async () => {
      const status = await bridge.getStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(status) }],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
