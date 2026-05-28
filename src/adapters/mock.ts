import type { IMBotAdapter, DecisionRequest, DecisionResponse } from "./types.js";

/**
 * Mock adapter for integration testing.
 * Logs all calls and simulates a no-op IM backend.
 */
export class MockAdapter implements IMBotAdapter {
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

  /** Trigger a simulated reply from the mock adapter */
  triggerReply(answer: string): void {
    this.callback?.({ decisionId: "mock-1", answer, respondedAt: Date.now() });
  }
}
