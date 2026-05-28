export interface DecisionRequest {
  id: string;
  question: string;
  options?: string[];
  timeoutMs: number;
  createdAt: number;
}

export interface DecisionResponse {
  decisionId: string;
  answer: string;
  respondedAt: number;
}

export interface IMBotAdapter {
  /** Send a decision request message to the human */
  sendDecision(request: DecisionRequest): Promise<void>;

  /** Send a one-way notification */
  sendNotification(message: string): Promise<void>;

  /** Start listening for incoming replies (webhook or polling) */
  start(callback: (response: DecisionResponse) => void): Promise<void>;

  /** Stop the adapter */
  stop(): Promise<void>;
}
