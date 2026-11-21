export interface SessionCoordinationRequest {
  operation: 'list' | 'status' | 'send' | 'read' | 'acknowledge' | 'pause' | 'stop' | 'resume' | 'handover' | 'controlStatus';
  toSessionId?: string;
  messageId?: string;
  text?: string;
  activity?: 'working' | 'blocked' | 'idle';
  note?: string;
  messageIds?: string[];
  operationId?: string;
  expectedTurnId?: string;
  handoverToSessionId?: string;
  start?: boolean;
}

export interface CoordinationMessage {
  id: string;
  fromSessionId: string;
  toSessionId: string;
  text: string;
  createdAt: number;
  acknowledgedAt?: number;
}

export interface SessionCoordinationResult {
  peers?: Array<{ sessionId: string; title?: string; runtimeStatus?: string; activity?: string; note?: string; updatedAt?: number }>;
  messages?: CoordinationMessage[];
  message?: CoordinationMessage;
  acknowledged?: number;
  more?: boolean;
  warning?: string;
  control?: { operationId: string; status: 'pending' | 'completed' | 'unknown'; message: string; targetSessionId: string };
}
