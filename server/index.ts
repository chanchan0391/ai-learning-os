import { createApp } from "./app";
import { createModelProvider } from "./ai/provider-factory";
import { configureHttpServer, createShutdownHandler } from "./http-server-lifecycle";
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

server.listen(port, host, () => {
  const syncStatus = syncRuntime.appOptions.syncStore ? ", sync enabled" : ", sync disabled";
  console.log(`AI Learning OS API ready on http://${host}:${port} (${provider.id}${syncStatus})`);
});

const shutdown = createShutdownHandler(server, syncRuntime.close, (code) => process.exit(code), {
  onForcedShutdown: () => console.error("API shutdown deadline exceeded; closing active connections"),
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
