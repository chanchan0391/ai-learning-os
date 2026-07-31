import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LearningGoal } from "../src/types";
import { AgentOutputError, createPlannerAgent } from "./agents/planner-agent";
import { ModelProviderError, type ModelProvider } from "./ai/model-provider";

const MAX_BODY_BYTES = 1_000_000;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RangeError("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createApp(provider: ModelProvider) {
  const planner = createPlannerAgent(provider);
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/api/health") {
        return sendJson(response, 200, { status: "ok", provider: provider.id, aiEnabled: provider.isAiEnabled });
      }
      if (request.method === "POST" && request.url === "/api/plans") {
        const goal = await readJson(request) as LearningGoal;
        return sendJson(response, 201, await planner.createPlan(goal));
      }
      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) return sendJson(response, 400, { error: error.message });
      if (error instanceof RangeError) return sendJson(response, 413, { error: error.message });
      if (error instanceof AgentOutputError) return sendJson(response, 502, { error: error.message });
      if (error instanceof ModelProviderError) return sendJson(response, error.status, { error: error.message, requestId: error.requestId });
      console.error("Unexpected API error", error);
      return sendJson(response, 500, { error: "Internal server error" });
    }
  });
}
