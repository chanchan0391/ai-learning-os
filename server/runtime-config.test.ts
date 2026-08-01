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
    expect(() => readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning", SYNC_ALLOWED_ORIGINS: "https://learn.example",
      OIDC_ISSUER: "https://identity.example",
    })).toThrow(/configured together/);
  });

  it("loads a complete provider-neutral OIDC configuration", () => {
    expect(readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning",
      SYNC_ALLOWED_ORIGINS: "https://learn.example",
      OIDC_ISSUER: "https://identity.example",
      OIDC_CLIENT_ID: "learning-client",
      OIDC_REDIRECT_URI: "https://learn.example/api/auth/callback",
      OIDC_TRANSACTION_SECRET: "a-secure-random-value-with-32-characters",
    })?.oidc).toEqual({
      issuer: "https://identity.example",
      clientId: "learning-client",
      redirectUri: "https://learn.example/api/auth/callback",
      transactionSecret: "a-secure-random-value-with-32-characters",
    });
  });

  it("allows an HTTP issuer only for local development", () => {
    expect(readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning",
      SYNC_ALLOWED_ORIGINS: "http://127.0.0.1:5173",
      OIDC_ISSUER: "http://127.0.0.1:5556/dex",
      OIDC_CLIENT_ID: "learning-client",
      OIDC_REDIRECT_URI: "http://127.0.0.1:5173/api/auth/callback",
      OIDC_TRANSACTION_SECRET: "a-secure-random-value-with-32-characters",
    })?.oidc?.issuer).toBe("http://127.0.0.1:5556/dex");
    expect(() => readSyncRuntimeConfig({
      DATABASE_URL: "postgres://localhost/learning",
      SYNC_ALLOWED_ORIGINS: "https://learn.example",
      OIDC_ISSUER: "http://identity.example",
      OIDC_CLIENT_ID: "learning-client",
      OIDC_REDIRECT_URI: "https://learn.example/api/auth/callback",
      OIDC_TRANSACTION_SECRET: "a-secure-random-value-with-32-characters",
    })).toThrow(/exact HTTPS/);
  });
});
