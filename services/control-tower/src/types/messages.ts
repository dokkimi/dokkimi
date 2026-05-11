export interface HttpLogMessage {
  instanceId: string;
  instanceItemId?: string;
  method: string;
  url: string;
  statusCode?: number;
  requestBody?: unknown;
  responseBody?: unknown;
  requestHeaders?: Record<string, unknown>;
  responseHeaders?: Record<string, unknown>;
  isMocked?: boolean;
  timestamp?: string;
  origin?: string;
  target?: string;
  targetId?: string;
  requestSentAt?: string; // ISO timestamp when request was sent
  responseReceivedAt?: string; // ISO timestamp when response was received
}

export interface ConsoleLogMessage {
  instanceId: string;
  instanceItemId?: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  message: string;
  timestamp?: string;
}
