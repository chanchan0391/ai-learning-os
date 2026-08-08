import type { Server } from "node:http";

export const HTTP_SERVER_LIMITS = {
  headersTimeoutMs: 15_000,
  requestTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
  maxHeadersCount: 100,
  maxRequestsPerSocket: 1_000,
  shutdownTimeoutMs: 10_000,
} as const;

/** Applies conservative transport limits without constraining model response time. */
export function configureHttpServer(server: Server): void {
  server.headersTimeout = HTTP_SERVER_LIMITS.headersTimeoutMs;
  server.requestTimeout = HTTP_SERVER_LIMITS.requestTimeoutMs;
  server.keepAliveTimeout = HTTP_SERVER_LIMITS.keepAliveTimeoutMs;
  server.maxHeadersCount = HTTP_SERVER_LIMITS.maxHeadersCount;
  server.maxRequestsPerSocket = HTTP_SERVER_LIMITS.maxRequestsPerSocket;
}

interface ShutdownServer {
  close(callback: (error?: Error) => void): void;
  closeIdleConnections(): void;
  closeAllConnections(): void;
}

interface ShutdownOptions {
  timeoutMs?: number;
  setTimer?: typeof setTimeout;
  onForcedShutdown?: () => void;
}

/** Returns an idempotent signal handler that drains requests before forcing a bounded exit. */
export function createShutdownHandler(
  server: ShutdownServer,
  closeDependencies: () => Promise<void>,
  exit: (code: number) => void,
  options: ShutdownOptions = {},
): () => void {
  let shuttingDown = false;
  let finished = false;
  const timeoutMs = options.timeoutMs ?? HTTP_SERVER_LIMITS.shutdownTimeoutMs;
  const setTimer = options.setTimer ?? setTimeout;

  return () => {
    if (shuttingDown) return;
    shuttingDown = true;

    const deadline = setTimer(() => {
      if (finished) return;
      finished = true;
      options.onForcedShutdown?.();
      server.closeAllConnections();
      exit(1);
    }, timeoutMs);
    deadline.unref?.();

    server.close((error) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      void closeDependencies()
        .then(() => exit(error ? 1 : 0))
        .catch(() => exit(1));
    });
    server.closeIdleConnections();
  };
}
