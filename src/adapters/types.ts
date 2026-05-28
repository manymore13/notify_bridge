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

export interface HealthStatus {
  status: "healthy" | "unhealthy" | "connecting";
  reason?: string;
  details?: Record<string, any>;
}

export interface SendOptions {
  signal?: AbortSignal;
}

export interface IMBotAdapter {
  init(): Promise<void>;
  start(callback: (response: DecisionResponse) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  sendDecision(request: DecisionRequest, opts?: SendOptions): Promise<void>;
  sendNotification(message: string, opts?: SendOptions): Promise<void>;
  checkHealth(): Promise<HealthStatus>;
  isReady(): boolean;
  getStatus(): Record<string, any>;
}
