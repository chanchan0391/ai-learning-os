import { describe, expect, it, vi } from "vitest";
import {
  configureHttpServer,
  createShutdownHandler,
  createStartupFailureHandler,
  HTTP_SERVER_LIMITS,
} from "./http-server-lifecycle";

describe("HTTP server lifecycle", () => {
  it("applies bounded HTTP transport settings", () => {
    const server = {
      headersTimeout: 0,
      requestTimeout: 0,
      keepAliveTimeout: 0,
      maxHeadersCount: null,
      maxRequestsPerSocket: 0,
    };

    configureHttpServer(server as never);

    expect(server).toMatchObject({
      headersTimeout: HTTP_SERVER_LIMITS.headersTimeoutMs,
      requestTimeout: HTTP_SERVER_LIMITS.requestTimeoutMs,
      keepAliveTimeout: HTTP_SERVER_LIMITS.keepAliveTimeoutMs,
      maxHeadersCount: HTTP_SERVER_LIMITS.maxHeadersCount,
      maxRequestsPerSocket: HTTP_SERVER_LIMITS.maxRequestsPerSocket,
    });
  });

  it("closes initialized dependencies and exits on a listener startup failure", async () => {
    const closeDependencies = vi.fn(async () => undefined);
    const exit = vi.fn();
    const report = vi.fn();
    const handler = createStartupFailureHandler(closeDependencies, exit, {
      timeoutMs: 60_000,
      onStartupFailure: report,
    });
    const error = new Error("listen EADDRINUSE: address already in use 127.0.0.1:8787") as NodeJS.ErrnoException;
    error.code = "EADDRINUSE";

    handler(error);
    handler(new Error("must be ignored"));

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith("EADDRINUSE");
    expect(closeDependencies).toHaveBeenCalledOnce();
  });

  it("bounds startup cleanup and does not exit twice when cleanup settles late", async () => {
    let deadline: (() => void) | undefined;
    let finishDependencies: (() => void) | undefined;
    const closeDependencies = vi.fn(() => new Promise<void>((resolve) => { finishDependencies = resolve; }));
    const exit = vi.fn();
    const forced = vi.fn();
    const setTimer = vi.fn((callback: () => void) => {
      deadline = callback;
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;

    createStartupFailureHandler(closeDependencies, exit, {
      timeoutMs: 25,
      setTimer,
      onForcedCleanup: forced,
    })(new Error("bind failed"));
    deadline?.();
    finishDependencies?.();
    await Promise.resolve();

    expect(forced).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("reports startup dependency cleanup failures with a stable type", async () => {
    const exit = vi.fn();
    const reportCleanup = vi.fn();
    createStartupFailureHandler(
      () => { throw Object.assign(new Error("postgres://private.example failed"), { name: "DatabaseCleanupError" }); },
      exit,
      { timeoutMs: 60_000, onCleanupFailure: reportCleanup },
    )(Object.assign(new Error("bad bind"), { name: "invalid name with spaces" }));

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(reportCleanup).toHaveBeenCalledWith("DatabaseCleanupError");
  });

  it("drains once, closes dependencies, and exits successfully", async () => {
    let finishClose: ((error?: Error) => void) | undefined;
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => { finishClose = callback; }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    const closeDependencies = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = createShutdownHandler(server, closeDependencies, exit, { timeoutMs: 60_000 });

    shutdown();
    shutdown();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);

    finishClose?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(closeDependencies).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });

  it("forces lingering connections at the shutdown deadline", () => {
    let deadline: (() => void) | undefined;
    const server = {
      close: vi.fn(),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    const forced = vi.fn();
    const exit = vi.fn();
    const setTimer = vi.fn((callback: () => void) => {
      deadline = callback;
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;

    createShutdownHandler(server, async () => undefined, exit, {
      timeoutMs: 25,
      setTimer,
      onForcedShutdown: forced,
    })();
    deadline?.();

    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 25);
    expect(forced).toHaveBeenCalledOnce();
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("keeps the shutdown deadline active while dependencies close", async () => {
    let finishClose: ((error?: Error) => void) | undefined;
    let deadline: (() => void) | undefined;
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => { finishClose = callback; }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    const closeDependencies = vi.fn(() => new Promise<void>(() => undefined));
    const exit = vi.fn();
    const setTimer = vi.fn((callback: () => void) => {
      deadline = callback;
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;

    createShutdownHandler(server, closeDependencies, exit, { timeoutMs: 25, setTimer })();
    finishClose?.();
    await vi.waitFor(() => expect(closeDependencies).toHaveBeenCalledOnce());
    deadline?.();

    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not exit twice when dependency cleanup settles after the deadline", async () => {
    let finishClose: ((error?: Error) => void) | undefined;
    let deadline: (() => void) | undefined;
    let finishDependencies: (() => void) | undefined;
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => { finishClose = callback; }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    const closeDependencies = vi.fn(() => new Promise<void>((resolve) => { finishDependencies = resolve; }));
    const exit = vi.fn();
    const setTimer = vi.fn((callback: () => void) => {
      deadline = callback;
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;

    createShutdownHandler(server, closeDependencies, exit, { timeoutMs: 25, setTimer })();
    finishClose?.();
    await vi.waitFor(() => expect(closeDependencies).toHaveBeenCalledOnce());
    deadline?.();
    finishDependencies?.();
    await Promise.resolve();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("uses a failing exit code when dependency shutdown fails", async () => {
    let finishClose: ((error?: Error) => void) | undefined;
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => { finishClose = callback; }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    const exit = vi.fn();
    createShutdownHandler(server, async () => { throw new Error("database close failed"); }, exit, { timeoutMs: 60_000 })();

    finishClose?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it("uses a failing exit code when dependency shutdown throws synchronously", async () => {
    let finishClose: ((error?: Error) => void) | undefined;
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => { finishClose = callback; }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    const exit = vi.fn();
    createShutdownHandler(server, () => { throw new Error("database close failed"); }, exit, { timeoutMs: 60_000 })();

    finishClose?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
