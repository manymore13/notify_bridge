#!/usr/bin/env node

import { NotifyBridge } from "./bridge.js";
import type { IMBotAdapter, DecisionRequest, DecisionResponse } from "./adapters/types.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${testName}${detail ? ` — ${detail}` : ""}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Mock Adapter ----
class MockAdapter implements IMBotAdapter {
  public sendDecisionCalls: DecisionRequest[] = [];
  public sendNotificationCalls: string[] = [];
  private callback: ((r: DecisionResponse) => void) | null = null;

  async sendDecision(request: DecisionRequest): Promise<void> {
    this.sendDecisionCalls.push(request);
  }
  async sendNotification(message: string): Promise<void> {
    this.sendNotificationCalls.push(message);
  }
  async start(cb: (response: DecisionResponse) => void): Promise<void> {
    this.callback = cb;
  }
  async stop(): Promise<void> {}
  triggerReply(answer: string): void {
    this.callback?.({ decisionId: "test-1", answer, respondedAt: Date.now() });
  }
  getLastDecision(): DecisionRequest | undefined {
    return this.sendDecisionCalls[this.sendDecisionCalls.length - 1];
  }
}

async function flushMicrotasks() {
  await sleep(0);
}

// ---- Tests ----
async function runTests() {
  console.log("=== notify-bridge Test Suite ===\n");

  // Test 1: Bridge initialization
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();
    assert(mock.callback !== null, "bridge.start() 注册回调");
    await bridge.stop();
  }

  // Test 2: send_message
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();
    await bridge.sendMessage("测试通知");
    assert(
      mock.sendNotificationCalls.length === 1 && mock.sendNotificationCalls[0] === "测试通知",
      "bridge.sendMessage() 发送通知"
    );
    await bridge.stop();
  }

  // Test 3: request_decision with reply
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();

    const promise = bridge.requestDecision("是否继续？", ["是", "否"], 5000);

    // Verify decision was sent
    const decision = mock.getLastDecision();
    assert(decision?.question === "是否继续？", "requestDecision 发送问题");
    assert(
      JSON.stringify(decision?.options) === JSON.stringify(["是", "否"]),
      "requestDecision 包含选项"
    );

    // Simulate human reply
    setTimeout(() => mock.triggerReply("是"), 100);

    const answer = await promise;
    assert(answer === "是", "requestDecision 收到回复");
    await bridge.stop();
  }

  // Test 4: request_decision timeout
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();

    try {
      await bridge.requestDecision("超时测试", [], 500);
      assert(false, "requestDecision 超时应该抛出异常");
    } catch (err: any) {
      assert(
        err.message.includes("超时"),
        "requestDecision 超时抛出正确异常"
      );
    }
    await bridge.stop();
  }

  // Test 5: getPendingDecisions
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();

    assert(bridge.getPendingDecisions().length === 0, "初始无挂起决策");

    // Start a decision
    const promise = bridge.requestDecision("测试挂起", ["A", "B"], 30000);
    await flushMicrotasks();

    const pending = bridge.getPendingDecisions();
    assert(pending.length === 1, "有一个挂起决策");
    assert(pending[0].question === "测试挂起", "挂起决策内容正确");

    mock.triggerReply("A");
    await promise;
    assert(bridge.getPendingDecisions().length === 0, "回复后无挂起决策");
    await bridge.stop();
  }

  // Test 6: Shutdown rejects pending
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();

    const promise = bridge.requestDecision("关机测试", [], 30000);
    await flushMicrotasks();
    await bridge.stop();

    try {
      await promise;
      assert(false, "关机应该拒绝挂起决策");
    } catch (err: any) {
      assert(
        err.message.includes("shutting down"),
        "关机正确拒绝挂起决策"
      );
    }
  }

  // Test 7: Multiple pending decisions - FIFO resolution
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();

    const p1 = bridge.requestDecision("第一个问题", ["A", "B"], 10000);
    await flushMicrotasks();
    const p2 = bridge.requestDecision("第二个问题", [], 10000);
    await flushMicrotasks();

    assert(bridge.getPendingDecisions().length === 2, "两个挂起决策");

    // Reply with non-matching text (should go to oldest = p1)
    mock.triggerReply("随便回复");
    const answer1 = await p1;
    assert(answer1 === "随便回复", "FIFO: 第一个问题收到回复");

    mock.triggerReply("知道了");
    const answer2 = await p2;
    assert(answer2 === "知道了", "第二个问题收到回复");

    await bridge.stop();
  }

  // Test 8: Option matching prioritizes over FIFO
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();

    const p1 = bridge.requestDecision("选颜色", ["红", "蓝"], 10000);
    await flushMicrotasks();
    const p2 = bridge.requestDecision("选大小", ["大", "小"], 10000);
    await flushMicrotasks();

    // Reply with "蓝" — should match p1's options
    mock.triggerReply("蓝");
    const answer1 = await p1;
    assert(answer1 === "蓝", "选项匹配: p1收到'蓝'");

    mock.triggerReply("大");
    const answer2 = await p2;
    assert(answer2 === "大", "选项匹配: p2收到'大'");

    await bridge.stop();
  }

  // Test 9: Bridge stop clears all state
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();

    const p = bridge.requestDecision("stop测试", [], 30000);
    await flushMicrotasks();
    assert(bridge.getPendingDecisions().length === 1, "stop前有挂起");

    await bridge.stop();
    assert(bridge.getPendingDecisions().length === 0, "stop后无挂起");
  }

  // Summary
  console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("测试运行失败:", err);
  process.exit(1);
});
