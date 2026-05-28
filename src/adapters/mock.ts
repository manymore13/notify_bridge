import type { IMBotAdapter, DecisionRequest, DecisionResponse, HealthStatus, SendOptions } from "./types.js";

export class MockAdapter implements IMBotAdapter {
  public sendDecisionCalls: DecisionRequest[] = [];
  public sendNotificationCalls: string[] = [];
  private callback: ((r: DecisionResponse) => void) | null = null;

  async init(): Promise<void> {}
  async start(cb: (response: DecisionResponse) => void): Promise<void> { this.callback = cb; }
  async stop(): Promise<void> {}

  async sendDecision(request: DecisionRequest, _opts?: SendOptions): Promise<void> {
    this.sendDecisionCalls.push(request);
  }
  async sendNotification(message: string, _opts?: SendOptions): Promise<void> {
    this.sendNotificationCalls.push(message);
  }

  async checkHealth(): Promise<HealthStatus> {
    return { status: "healthy" };
  }
  isReady(): boolean { return true; }
  getStatus(): Record<string, any> { return {}; }

  triggerReply(answer: string): void {
    this.callback?.({ decisionId: "mock-1", answer, respondedAt: Date.now() });
  }
  getLastDecision(): DecisionRequest | undefined {
    return this.sendDecisionCalls[this.sendDecisionCalls.length - 1];
  }
}
