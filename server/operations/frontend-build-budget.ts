import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface FrontendBuildMeasurement {
  rawBytes: number;
  gzipBytes: number;
}

export interface FrontendBuildBudgetResult {
  html: FrontendBuildMeasurement;
  javascript: FrontendBuildMeasurement;
  css: FrontendBuildMeasurement;
  total: FrontendBuildMeasurement;
  files: number;
}

export const FRONTEND_BUILD_BUDGETS = {
  html: { rawBytes: 16 * 1024 },
  javascript: { rawBytes: 512 * 1024, gzipBytes: 160 * 1024 },
  css: { rawBytes: 64 * 1024, gzipBytes: 24 * 1024 },
  total: { rawBytes: 640 * 1024, gzipBytes: 224 * 1024 },
} as const;

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Build output must not contain symbolic links: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      return collectFiles(path);
    }
    if (!entry.isFile()) {
      throw new Error(`Build output contains an unsupported entry: ${entry.name}`);
    }
    return [path];
  });
}

function add(measurement: FrontendBuildMeasurement, contents: Buffer) {
  measurement.rawBytes += contents.byteLength;
  measurement.gzipBytes += gzipSync(contents, { level: 9 }).byteLength;
}

export function measureFrontendBuild(directory: string): FrontendBuildBudgetResult {
  const root = resolve(directory);
  const files = collectFiles(root);
  const result: FrontendBuildBudgetResult = {
    html: { rawBytes: 0, gzipBytes: 0 },
    javascript: { rawBytes: 0, gzipBytes: 0 },
    css: { rawBytes: 0, gzipBytes: 0 },
    total: { rawBytes: 0, gzipBytes: 0 },
    files: files.length,
  };

  if (!files.some((path) => relative(root, path) === "index.html")) {
    throw new Error("Build output is missing index.html");
  }

  for (const path of files) {
    const contents = readFileSync(path);
    const name = relative(root, path);
    add(result.total, contents);
    if (name.endsWith(".html")) add(result.html, contents);
    if (name.endsWith(".js")) add(result.javascript, contents);
    if (name.endsWith(".css")) add(result.css, contents);
  }

  return result;
}

export function assertFrontendBuildBudget(
  result: FrontendBuildBudgetResult,
  budgets = FRONTEND_BUILD_BUDGETS,
) {
  const violations: string[] = [];
  for (const category of Object.keys(budgets) as Array<keyof typeof budgets>) {
    const budget = budgets[category];
    for (const encoding of Object.keys(budget) as Array<keyof typeof budget>) {
      const actual = result[category][encoding];
      const limit = budget[encoding];
      if (actual > limit) {
        violations.push(`${category}.${encoding} is ${actual} bytes; limit is ${limit} bytes`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Frontend build budget exceeded:\n${violations.join("\n")}`);
  }
}

export function verifyFrontendBuild(directory: string) {
  const result = measureFrontendBuild(directory);
  assertFrontendBuildBudget(result);
  return result;
}
