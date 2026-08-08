import { createApp } from "./app";
import { createModelProvider } from "./ai/provider-factory";
import { configureHttpServer, createShutdownHandler } from "./http-server-lifecycle";
import { createSyncRuntime, readAgentConcurrencyLimit } from "./runtime-config";
import { InMemoryConcurrencyLimiter } from "./security/request-security";

try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const port = Number(process.env.AI_API_PORT ?? 8787);
const host = process.env.AI_API_HOST?.trim() || "127.0.0.1";
const provider = createModelProvider();
const syncRuntime = createSyncRuntime(process.env);
const agentConcurrencyLimit = readAgentConcurrencyLimit(process.env);
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
