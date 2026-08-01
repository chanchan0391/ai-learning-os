import { createApp } from "./app";
import { createModelProvider } from "./ai/provider-factory";
import { createSyncRuntime } from "./runtime-config";

try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const port = Number(process.env.AI_API_PORT ?? 8787);
const host = process.env.AI_API_HOST?.trim() || "127.0.0.1";
const provider = createModelProvider();
const syncRuntime = createSyncRuntime(process.env);
const server = createApp(provider, syncRuntime.appOptions);

server.listen(port, host, () => {
  const syncStatus = syncRuntime.appOptions.syncStore ? ", sync enabled" : ", sync disabled";
  console.log(`AI Learning OS API ready on http://${host}:${port} (${provider.id}${syncStatus})`);
});

function shutdown() {
  server.close(() => {
    void syncRuntime.close().finally(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
