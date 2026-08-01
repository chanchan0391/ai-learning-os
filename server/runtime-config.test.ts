import { describe, expect, it } from "vitest";
import { readSyncRuntimeConfig } from "./runtime-config";

describe("sync runtime configuration", () => {
  it("keeps sync disabled when no database is configured", () => {
    expect(readSyncRuntimeConfig({})).toBeNull();
  });

  it("loads a database with deduplicated exact origins", () => {
    expect(readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning",
      SYNC_ALLOWED_ORIGINS: "http://127.0.0.1:5173, https://learn.example,https://learn.example",
      SESSION_COOKIE_NAME: "learning_session",
    })).toEqual({
      connectionString: "postgres://localhost/learning",
      allowedOrigins: ["http://127.0.0.1:5173", "https://learn.example"],
      sessionCookieName: "learning_session",
    });
  });

  it("fails fast for incomplete or unsafe sync configuration", () => {
    expect(() => readSyncRuntimeConfig({ SYNC_ALLOWED_ORIGINS: "https://learn.example" })).toThrow(/DATABASE_URL/);
    expect(() => readSyncRuntimeConfig({ DATABASE_URL: "postgres://localhost/learning" })).toThrow(/SYNC_ALLOWED_ORIGINS/);
    expect(() => readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning", SYNC_ALLOWED_ORIGINS: "http://learn.example",
    })).toThrow(/exact HTTPS/);
    expect(() => readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning", SYNC_ALLOWED_ORIGINS: "https://learn.example/path",
    })).toThrow(/exact HTTPS/);
  });
});
