import { createApp } from "./app";
import { createModelProvider } from "./ai/provider-factory";
import {
  configureHttpServer,
  createShutdownHandler,
  createStartupFailureHandler,
  lifecycleErrorType,
} from "./http-server-lifecycle";
import {
  assertModelUsageSafety,
  createSyncRuntime,
  readApiListenConfig,
  readAgentConcurrencyLimit,
  readTrustedProxyAddresses,
} from "./runtime-config";
import { InMemoryConcurrencyLimiter } from "./security/request-security";
import { readReleaseRevision } from "./release-provenance";

try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const { port, host } = readApiListenConfig(process.env);
const provider = createModelProvider();
const syncRuntime = createSyncRuntime(process.env);
assertModelUsageSafety(provider.isAiEnabled, Boolean(syncRuntime.appOptions.modelUsageLedger), process.env);
const agentConcurrencyLimit = readAgentConcurrencyLimit(process.env);
syncRuntime.appOptions.releaseRevision = readReleaseRevision();
syncRuntime.appOptions.trustedProxyAddresses = readTrustedProxyAddresses(process.env);
if (agentConcurrencyLimit) {
  syncRuntime.appOptions.agentConcurrencyLimiter = new InMemoryConcurrencyLimiter(agentConcurrencyLimit);
}
const server = createApp(provider, syncRuntime.appOptions);
configureHttpServer(server);

let closeRuntimePromise: Promise<void> | undefined;
const closeRuntime = () => {
  closeRuntimePromise ??= syncRuntime.close();
  return closeRuntimePromise;
};
const reportLifecycleError = (category: string, errorType: string) => console.error(JSON.stringify({
  type: "lifecycle_error",
  category,
  releaseRevision: syncRuntime.appOptions.releaseRevision,
  errorType,
}));
const startupFailure = createStartupFailureHandler(closeRuntime, (code) => process.exit(code), {
  onStartupFailure: (errorType) => reportLifecycleError("http-listen", errorType),
  onCleanupFailure: (errorType) => reportLifecycleError("startup-cleanup", errorType),
  onForcedCleanup: () => reportLifecycleError("startup-cleanup-timeout", "StartupCleanupTimeoutError"),
});
server.once("error", startupFailure);

server.listen(port, host, () => {
  server.off("error", startupFailure);
  const syncStatus = syncRuntime.appOptions.syncStore ? ", sync enabled" : ", sync disabled";
  console.log(`AI Learning OS API ready on http://${host}:${port} (${provider.id}${syncStatus})`);
});

const shutdown = createShutdownHandler(server, closeRuntime, (code) => process.exit(code), {
  onForcedShutdown: () => console.error("API shutdown deadline exceeded; closing active connections"),
});
const fatalShutdown = (category: "uncaught-exception" | "unhandled-rejection") => (error: unknown) => {
  reportLifecycleError(category, lifecycleErrorType(error));
  shutdown(1);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", fatalShutdown("uncaught-exception"));
process.on("unhandledRejection", fatalShutdown("unhandled-rejection"));
