import { resolve } from "node:path";
import { verifyFrontendBuild } from "./frontend-build-budget.js";

try {
  const result = verifyFrontendBuild(resolve(process.cwd(), "dist"));
  console.log(
    `Frontend build budget passed: ${result.files} files, ${result.total.rawBytes} raw bytes, ${result.total.gzipBytes} gzip bytes.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Frontend build budget failed");
  process.exitCode = 1;
}
