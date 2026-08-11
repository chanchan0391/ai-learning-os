export type RequestOutcome = "success" | "rejected" | "failed";

export interface RequestLogEvent {
  occurredAt: string;
  requestId: string;
  releaseRevision: string | null;
  method: string;
  path: string;
  status: number;
  outcome: RequestOutcome;
  durationMs: number;
  termination?: "client-disconnected";
}

export interface RequestLogSink {
  record(event: RequestLogEvent): void | Promise<void>;
}

export class JsonLineRequestLogSink implements RequestLogSink {
  record(event: RequestLogEvent): void {
    console.info(JSON.stringify({ type: "http_request", ...event }));
  }
}

export function requestOutcome(status: number): RequestOutcome {
  if (status < 400) return "success";
  if (status < 500) return "rejected";
  return "failed";
}
