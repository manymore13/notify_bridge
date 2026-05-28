#!/usr/bin/env node

import { NotifyBridge, MemoryDecisionStore } from "./bridge.js";
import { MockAdapter } from "./adapters/mock.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) { passed++; }
  else { failed++; console.error(`  FAIL: ${testName}${detail ? ` — ${detail}` : ""}`); }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function runTests() {
  console.log("=== notify-bridge Test Suite ===\n");

  // Test 1: Bridge init
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();
    assert(true, "bridge.start() 成功");
    await bridge.stop();
  }

  // Test 2: sendMessage
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();
    await bridge.sendMessage("测试通知");
    assert(mock.sendNotificationCalls.length === 1, "sendMessage 发送通知");
    await bridge.stop();
  }

  // Test 3: requestDecision with reply
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();

    const promise = bridge.requestDecision("是否继续？", ["是", "否"], 5000);
    await sleep(10);
    const decision = mock.getLastDecision();
    assert(decision?.question === "是否继续？", "requestDecision 发送问题");
    assert(JSON.stringify(decision?.options) === JSON.stringify(["是", "否"]), "requestDecision 包含选项");

    setTimeout(() => mock.triggerReply("是"), 100);
    const answer = await promise;
    assert(answer === "是", "requestDecision 收到回复");
    await bridge.stop();
  }

  // Test 4: timeout
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();

    try {
      await bridge.requestDecision("超时测试", [], 500);
      assert(false, "超时应该抛出异常");
    } catch (err: any) {
      assert(err.message.includes("超时"), "超时抛出正确异常");
    }
    await bridge.stop();
  }

  // Test 5: getPendingDecisions
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();

    assert((await bridge.getPendingDecisions()).length === 0, "初始无挂起决策");

    const promise = bridge.requestDecision("测试挂起", ["A", "B"], 30000);
    await sleep(20);
    const pending = await bridge.getPendingDecisions();
    assert(pending.length === 1, "有一个挂起决策");

    mock.triggerReply("A");
    await promise;
    assert((await bridge.getPendingDecisions()).length === 0, "回复后无挂起决策");
    await bridge.stop();
  }

  // Test 6: stop rejects pending
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();

    const promise = bridge.requestDecision("关机测试", [], 30000);
    await sleep(20);
    await bridge.stop();

    try {
      await promise;
      assert(false, "关机应该拒绝挂起决策");
    } catch (err: any) {
      assert(err.message.includes("shutting down"), "关机正确拒绝");
    }
  }

  // Test 7: FIFO resolution
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();

    const p1 = bridge.requestDecision("第一个问题", ["A", "B"], 10000);
    await sleep(20);
    const p2 = bridge.requestDecision("第二个问题", [], 10000);

    assert((await bridge.getPendingDecisions()).length === 2, "两个挂起决策");

    mock.triggerReply("随便回复");
    const answer1 = await p1;
    assert(answer1 === "随便回复", "FIFO: 第一个问题收到回复");

    mock.triggerReply("知道了");
    const answer2 = await p2;
    assert(answer2 === "知道了", "第二个问题收到回复");
    await bridge.stop();
  }

  // Test 8: Option matching
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();

    const p1 = bridge.requestDecision("选颜色", ["红", "蓝"], 10000);
    await sleep(20);
    const p2 = bridge.requestDecision("选大小", ["大", "小"], 10000);

    mock.triggerReply("蓝");
    const answer1 = await p1;
    assert(answer1 === "蓝", "选项匹配: p1收到'蓝'");

    mock.triggerReply("大");
    const answer2 = await p2;
    assert(answer2 === "大", "选项匹配: p2收到'大'");
    await bridge.stop();
  }

  // Test 9: MemoryDecisionStore
  {
    const store = new MemoryDecisionStore();
    assert((await store.getSize()) === 0, "MemoryStore 初始为空");

    const entry: any = { request: { id: "test", question: "q", options: [], timeoutMs: 1000, createdAt: Date.now() }, resolve: () => {}, reject: () => {} };
    await store.set("test", entry);
    assert((await store.getSize()) === 1, "MemoryStore set");

    await store.delete("test");
    assert((await store.getSize()) === 0, "MemoryStore delete");
  }

  // Test 10: Rate limiting
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();

    // 发起 5 个请求填满桶
    for (let i = 0; i < 5; i++) {
      const p = bridge.requestDecision(`测试${i}`, ["是", "否"], 5000);
      mock.triggerReply("是");
      await p;
    }

    // 第 6 个应被频控
    try {
      await bridge.requestDecision("频控测试", ["是", "否"], 5000);
      assert(false, "频控应抛出异常");
    } catch (err: any) {
      assert(err.message.includes("频控") || err.message.includes("retryAfterMs"), "频控异常");
    }
    await bridge.stop();
  }

  // Test 11: getStatus
  {
    const mock = new MockAdapter();
    const bridge = new NotifyBridge(mock);
    await bridge.start();
    const status = await bridge.getStatus();
    assert(typeof status.pendingCount === "number", "getStatus 返回 pendingCount");
    assert(typeof status.ready === "boolean", "getStatus 返回 ready");
    await bridge.stop();
  }

  console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => { console.error("测试运行失败:", err); process.exit(1); });
