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

interface StartupFailureOptions {
  timeoutMs?: number;
  setTimer?: typeof setTimeout;
  onStartupFailure?: (errorType: string) => void;
  onCleanupFailure?: (errorType: string) => void;
  onForcedCleanup?: () => void;
}

export function lifecycleErrorType(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  if (/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "UnknownError";
}

/** Closes initialized dependencies and exits once when the HTTP listener cannot start. */
export function createStartupFailureHandler(
  closeDependencies: () => Promise<void>,
  exit: (code: number) => void,
  options: StartupFailureOptions = {},
): (error: unknown) => void {
  let handling = false;
  let finished = false;
  const timeoutMs = options.timeoutMs ?? HTTP_SERVER_LIMITS.shutdownTimeoutMs;
  const setTimer = options.setTimer ?? setTimeout;

  return (error) => {
    if (handling) return;
    handling = true;
    options.onStartupFailure?.(lifecycleErrorType(error));

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      exit(1);
    };
    const deadline = setTimer(() => {
      if (finished) return;
      options.onForcedCleanup?.();
      finish();
    }, timeoutMs);
    deadline.unref?.();

    void Promise.resolve()
      .then(closeDependencies)
      .then(finish)
      .catch((cleanupError) => {
        options.onCleanupFailure?.(lifecycleErrorType(cleanupError));
        finish();
      });
  };
}

/** Returns an idempotent signal handler that drains requests before forcing a bounded exit. */
export function createShutdownHandler(
  server: ShutdownServer,
  closeDependencies: () => Promise<void>,
  exit: (code: number) => void,
  options: ShutdownOptions = {},
): (exitCode?: 0 | 1) => void {
  let shuttingDown = false;
  let finished = false;
  let closingDependencies = false;
  let requestedExitCode: 0 | 1 = 0;
  const timeoutMs = options.timeoutMs ?? HTTP_SERVER_LIMITS.shutdownTimeoutMs;
  const setTimer = options.setTimer ?? setTimeout;

  return (exitCode = 0) => {
    if (exitCode === 1) requestedExitCode = 1;
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
      if (finished || closingDependencies) return;
      closingDependencies = true;
      void Promise.resolve()
        .then(closeDependencies)
        .then(() => {
          if (finished) return;
          finished = true;
          clearTimeout(deadline);
          exit(error ? 1 : requestedExitCode);
        })
        .catch(() => {
          if (finished) return;
          finished = true;
          clearTimeout(deadline);
          exit(1);
        });
    });
    server.closeIdleConnections();
  };
}
