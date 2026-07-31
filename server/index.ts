import { createApp } from "./app";
import { createModelProvider } from "./ai/provider-factory";

try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const port = Number(process.env.AI_API_PORT ?? 8787);
const provider = createModelProvider();
const server = createApp(provider);

server.listen(port, "127.0.0.1", () => {
  console.log(`AI Learning OS API ready on http://127.0.0.1:${port} (${provider.id})`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
