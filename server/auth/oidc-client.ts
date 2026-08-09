import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { VerifiedOidcIdentity } from "./postgres-session-lifecycle";
import { readBoundedJson } from "../http/bounded-json-response";

const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const MAX_OIDC_DISCOVERY_BYTES = 64 * 1_024;
const MAX_OIDC_TOKEN_RESPONSE_BYTES = 256 * 1_024;
export const DEFAULT_OIDC_UPSTREAM_TIMEOUT_MS = 10_000;
export const MAX_OIDC_UPSTREAM_TIMEOUT_MS = 60_000;

export interface OidcConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  transactionSecret: string;
  transactionCookieName?: string;
  upstreamTimeoutMs?: number;
}

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface LoginTransaction {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
}

export interface OidcAuthorization {
  authorizationUrl: string;
  transactionCookie: string;
}

export interface OidcCallbackResult {
  identity: VerifiedOidcIdentity;
  returnTo: string;
}

export interface OidcAuthenticator {
  transactionCookieName: string;
  begin(returnTo?: string): Promise<OidcAuthorization>;
  complete(callbackUrl: URL, cookieHeader: string | undefined, deviceLabel: string): Promise<OidcCallbackResult>;
}

type IdTokenVerifier = (
  token: string,
  discovery: OidcDiscovery,
  config: OidcConfig,
  nonce: string,
) => Promise<{ issuer: string; subject: string }>;

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function safeReturnTo(value: string | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    throw new TypeError("returnTo must be a same-origin absolute path");
  }
  return value;
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const entry of header?.split(";") ?? []) {
    const [key, ...rest] = entry.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function isSafeProviderUrl(value: string, issuer: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    const issuerUrl = new URL(issuer);
    const localIssuer = issuerUrl.hostname === "127.0.0.1" || issuerUrl.hostname === "localhost";
    return localIssuer && issuerUrl.protocol === "http:" && url.protocol === "http:" && url.origin === issuerUrl.origin;
  } catch {
    return false;
  }
}

export class StandardOidcClient implements OidcAuthenticator {
  readonly transactionCookieName: string;
  private readonly upstreamTimeoutMs: number;
  private discoveryCache?: { value: OidcDiscovery; expiresAt: number };
  private readonly jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(
    private readonly config: OidcConfig,
    private readonly now: () => number = () => Date.now(),
    private readonly random: (bytes: number) => Buffer = randomBytes,
    private readonly fetcher: typeof fetch = fetch,
    private readonly verifyToken: IdTokenVerifier = async (token, discovery, config, nonce) => {
      let keySet = this.jwks.get(discovery.jwks_uri);
      if (!keySet) {
        keySet = createRemoteJWKSet(new URL(discovery.jwks_uri), { timeoutDuration: this.upstreamTimeoutMs });
        this.jwks.set(discovery.jwks_uri, keySet);
      }
      const verified = await jwtVerify(token, keySet, {
        issuer: discovery.issuer,
        audience: config.clientId,
      });
      if (verified.payload.nonce !== nonce) throw new Error("OIDC ID token nonce mismatch");
      if (!verified.payload.sub) throw new Error("OIDC ID token subject is missing");
      return { issuer: verified.payload.iss!, subject: verified.payload.sub };
    },
  ) {
    this.transactionCookieName = config.transactionCookieName ?? "ai_learning_oidc";
    this.upstreamTimeoutMs = config.upstreamTimeoutMs ?? DEFAULT_OIDC_UPSTREAM_TIMEOUT_MS;
    if (config.transactionSecret.length < 32) throw new TypeError("OIDC transaction secret must be at least 32 characters");
    if (!Number.isSafeInteger(this.upstreamTimeoutMs) || this.upstreamTimeoutMs <= 0
      || this.upstreamTimeoutMs > MAX_OIDC_UPSTREAM_TIMEOUT_MS) {
      throw new TypeError(`OIDC upstream timeout must be a positive integer no greater than ${MAX_OIDC_UPSTREAM_TIMEOUT_MS} milliseconds`);
    }
  }

  async begin(returnTo?: string): Promise<OidcAuthorization> {
    const discovery = await this.discover();
    const verifier = base64url(this.random(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const transaction: LoginTransaction = {
      state: base64url(this.random(24)),
      nonce: base64url(this.random(24)),
      verifier,
      returnTo: safeReturnTo(returnTo),
      expiresAt: this.now() + TRANSACTION_TTL_MS,
    };
    const authorizationUrl = new URL(discovery.authorization_endpoint);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      scope: "openid",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return { authorizationUrl: authorizationUrl.toString(), transactionCookie: this.sign(transaction) };
  }

  async complete(callbackUrl: URL, cookieHeader: string | undefined, deviceLabel: string): Promise<OidcCallbackResult> {
    const providerError = callbackUrl.searchParams.get("error");
    if (providerError) throw new TypeError(`OIDC provider rejected login: ${providerError}`);
    const code = callbackUrl.searchParams.get("code");
    const state = callbackUrl.searchParams.get("state");
    if (!code || !state) throw new TypeError("OIDC callback requires code and state");
    const encoded = cookieValue(cookieHeader, this.transactionCookieName);
    const transaction = encoded ? this.verify(encoded) : null;
    if (!transaction || transaction.expiresAt <= this.now()) throw new TypeError("OIDC login transaction is missing or expired");
    if (transaction.state !== state) throw new TypeError("OIDC state mismatch");

    const discovery = await this.discover();
    const tokenResponse = await this.fetcher(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: this.config.clientId,
        redirect_uri: this.config.redirectUri,
        code_verifier: transaction.verifier,
      }),
      signal: AbortSignal.timeout(this.upstreamTimeoutMs),
    });
    if (!tokenResponse.ok) throw new Error(`OIDC token exchange failed with status ${tokenResponse.status}`);
    const tokens = await readBoundedJson<{ id_token?: unknown }>(tokenResponse, MAX_OIDC_TOKEN_RESPONSE_BYTES);
    if (typeof tokens.id_token !== "string") throw new Error("OIDC token response is missing id_token");
    const verified = await this.verifyToken(tokens.id_token, discovery, this.config, transaction.nonce);
    return {
      identity: { issuer: verified.issuer, subject: verified.subject, deviceLabel: deviceLabel.slice(0, 100) || "Browser" },
      returnTo: transaction.returnTo,
    };
  }

  private async discover(): Promise<OidcDiscovery> {
    if (this.discoveryCache && this.discoveryCache.expiresAt > this.now()) return this.discoveryCache.value;
    const issuer = this.config.issuer.replace(/\/$/, "");
    const response = await this.fetcher(`${issuer}/.well-known/openid-configuration`, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(this.upstreamTimeoutMs),
    });
    if (!response.ok) throw new Error(`OIDC discovery failed with status ${response.status}`);
    const value = await readBoundedJson<Partial<OidcDiscovery>>(response, MAX_OIDC_DISCOVERY_BYTES);
    if (value.issuer?.replace(/\/$/, "") !== issuer) throw new Error("OIDC discovery issuer mismatch");
    for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
      if (typeof value[key] !== "string" || !isSafeProviderUrl(value[key], issuer)) {
        throw new Error(`OIDC discovery ${key} must be HTTPS or use the same local HTTP origin as the issuer`);
      }
    }
    const discovery = value as OidcDiscovery;
    this.discoveryCache = { value: discovery, expiresAt: this.now() + DISCOVERY_TTL_MS };
    return discovery;
  }

  private sign(transaction: LoginTransaction): string {
    const payload = base64url(JSON.stringify(transaction));
    const signature = createHmac("sha256", this.config.transactionSecret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  private verify(value: string): LoginTransaction | null {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra) return null;
    const expected = createHmac("sha256", this.config.transactionSecret).update(payload).digest();
    let actual: Buffer;
    try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const transaction = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<LoginTransaction>;
      if (
        typeof transaction.state !== "string" || !transaction.state
        || typeof transaction.nonce !== "string" || !transaction.nonce
        || typeof transaction.verifier !== "string" || !transaction.verifier
        || typeof transaction.returnTo !== "string"
        || typeof transaction.expiresAt !== "number"
      ) return null;
      return { ...transaction, returnTo: safeReturnTo(transaction.returnTo) } as LoginTransaction;
    } catch { return null; }
  }
}
