import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StandardOidcClient } from "./oidc-client";

const config = {
  issuer: "https://identity.example",
  clientId: "learning-client",
  redirectUri: "https://learn.example/api/auth/callback",
  transactionSecret: "test-secret-that-is-longer-than-thirty-two-characters",
};

function discovery() {
  return new Response(JSON.stringify({
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/authorize`,
    token_endpoint: `${config.issuer}/token`,
    jwks_uri: `${config.issuer}/keys`,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("standard OIDC client", () => {
  it("supports a same-origin local HTTP provider for development", async () => {
    const localConfig = {
      ...config,
      issuer: "http://127.0.0.1:5556/dex",
      redirectUri: "http://127.0.0.1:5173/api/auth/callback",
    };
    const localDiscovery = new Response(JSON.stringify({
      issuer: localConfig.issuer,
      authorization_endpoint: `${localConfig.issuer}/auth`,
      token_endpoint: `${localConfig.issuer}/token`,
      jwks_uri: `${localConfig.issuer}/keys`,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    const randomValues = [Buffer.alloc(32, 1), Buffer.alloc(24, 2), Buffer.alloc(24, 3)];
    const client = new StandardOidcClient(
      localConfig,
      () => 1_000,
      () => randomValues.shift()!,
      vi.fn(async () => localDiscovery) as typeof fetch,
    );

    await expect(client.begin()).resolves.toMatchObject({ authorizationUrl: expect.stringContaining("http://127.0.0.1:5556/dex/auth") });
  });

  it("starts login with state, nonce, and an S256 PKCE challenge", async () => {
    const fetcher = vi.fn(async () => discovery());
    const randomValues = [Buffer.alloc(32, 1), Buffer.alloc(24, 2), Buffer.alloc(24, 3)];
    const client = new StandardOidcClient(config, () => 1_000, () => randomValues.shift()!, fetcher as typeof fetch);

    const result = await client.begin("/progress?day=2");
    const authorization = new URL(result.authorizationUrl);
    const verifier = Buffer.alloc(32, 1).toString("base64url");
    const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");

    expect(authorization.origin + authorization.pathname).toBe("https://identity.example/authorize");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toBe(expectedChallenge);
    expect(authorization.searchParams.get("nonce")).toBe(Buffer.alloc(24, 3).toString("base64url"));
    expect(result.transactionCookie).not.toContain(verifier);
  });

  it("exchanges the code and returns only a verified identity", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, _init) => String(input).endsWith("/token")
      ? new Response(JSON.stringify({ id_token: "signed-id-token", access_token: "never-returned" }), { status: 200 })
      : discovery());
    const verifyToken = vi.fn(async (_token, _discovery, _config, nonce) => {
      expect(nonce).toBe(Buffer.alloc(24, 3).toString("base64url"));
      return { issuer: config.issuer, subject: "subject-123" };
    });
    const randomValues = [Buffer.alloc(32, 1), Buffer.alloc(24, 2), Buffer.alloc(24, 3)];
    const client = new StandardOidcClient(config, () => 1_000, () => randomValues.shift()!, fetcher as typeof fetch, verifyToken);
    const started = await client.begin("/progress");
    const state = new URL(started.authorizationUrl).searchParams.get("state");

    const result = await client.complete(
      new URL(`https://learn.example/api/auth/callback?code=auth-code&state=${state}`),
      `${client.transactionCookieName}=${started.transactionCookie}`,
      "Test Browser",
    );

    expect(result).toEqual({
      identity: { issuer: config.issuer, subject: "subject-123", deviceLabel: "Test Browser" },
      returnTo: "/progress",
    });
    const tokenRequest = fetcher.mock.calls.find(([input]) => String(input).endsWith("/token"));
    expect(String(tokenRequest?.[1]?.body)).toContain("code_verifier=");
    expect(verifyToken).toHaveBeenCalledWith("signed-id-token", expect.anything(), config, expect.any(String));
  });

  it("rejects unsafe redirects and tampered or mismatched transactions", async () => {
    const randomValues = [Buffer.alloc(32, 1), Buffer.alloc(24, 2), Buffer.alloc(24, 3)];
    const client = new StandardOidcClient(config, () => 1_000, () => randomValues.shift()!, vi.fn(async () => discovery()) as typeof fetch);
    await expect(client.begin("https://evil.example")).rejects.toThrow(/same-origin/);

    const freshRandom = [Buffer.alloc(32, 1), Buffer.alloc(24, 2), Buffer.alloc(24, 3)];
    const fresh = new StandardOidcClient(config, () => 1_000, () => freshRandom.shift()!, vi.fn(async () => discovery()) as typeof fetch);
    const started = await fresh.begin();
    await expect(fresh.complete(
      new URL("https://learn.example/api/auth/callback?code=x&state=wrong"),
      `${fresh.transactionCookieName}=${started.transactionCookie}tampered`,
      "Browser",
    )).rejects.toThrow(/missing or expired/);
  });

  it("rejects oversized discovery responses before parsing them", async () => {
    const oversizedDiscovery = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(40_000));
        controller.enqueue(new Uint8Array(30_000));
        controller.close();
      },
    }));
    const client = new StandardOidcClient(
      config,
      () => 1_000,
      undefined,
      vi.fn(async () => oversizedDiscovery) as typeof fetch,
    );

    await expect(client.begin()).rejects.toThrow(/65536 byte limit/);
  });
});
