export interface Env {
  TOKEN_STORE: KVNamespace;
  OPENAI_OAUTH_CLIENT_ID: string;
  OPENAI_ACCESS_TOKEN: string;
  OPENAI_REFRESH_TOKEN: string;
  PROXY_SECRET: string;
  CHATGPT_ACCOUNT_ID?: string;
}

interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
}

const CODEX_RESPONSES_API_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_MODEL = "gpt-5.3-codex";

function withCors(headersInit?: HeadersInit): Headers {
  const headers = new Headers(headersInit);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-api-key, OpenAI-Organization, OpenAI-Project, session_id, x-codex-turn-state, x-codex-turn-metadata, x-codex-beta-features",
  );
  return headers;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toBase64(base64url: string): string {
  const normalized = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (normalized.length % 4)) % 4;
  return normalized + "=".repeat(padLength);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = atob(toBase64(parts[1]));
    const parsed = JSON.parse(payload);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractAccountIdFromClaims(claims: Record<string, unknown>): string | undefined {
  const direct = asString(claims.chatgpt_account_id);
  if (direct) return direct;

  const authClaim = claims["https://api.openai.com/auth"];
  if (isObject(authClaim)) {
    const nested = asString(authClaim.chatgpt_account_id);
    if (nested) return nested;
  }

  const organizations = claims.organizations;
  if (Array.isArray(organizations) && organizations.length > 0) {
    const first = organizations[0];
    if (isObject(first)) {
      const orgId = asString(first.id);
      if (orgId) return orgId;
    }
  }

  return undefined;
}

function extractAccountId(token?: string): string | undefined {
  if (!token) return undefined;
  const claims = decodeJwtPayload(token);
  if (!claims) return undefined;
  return extractAccountIdFromClaims(claims);
}

function validateProxyAuth(request: Request, env: Env): boolean {
  const authorization = request.headers.get("Authorization");
  if (authorization) {
    const [type, token] = authorization.split(" ");
    if (type === "Bearer" && token === env.PROXY_SECRET) {
      return true;
    }
  }

  return request.headers.get("x-api-key") === env.PROXY_SECRET;
}

function buildUpstreamHeaders(request: Request, accessToken: string, accountId?: string): Headers {
  const headers = new Headers(request.headers);

  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("host");
  headers.delete("content-length");

  headers.set("authorization", `Bearer ${accessToken}`);

  if (!headers.get("user-agent")) {
    headers.set("user-agent", "gpt-codex-proxy/1.0");
  }

  if (!headers.get("originator")) {
    headers.set("originator", "codex_cli_rs");
  }

  if (!headers.get("content-type")) {
    headers.set("content-type", "application/json");
  }

  if (!headers.get("version")) {
    headers.set("version", "proxy-1.0");
  }

  if (accountId) {
    headers.set("ChatGPT-Account-ID", accountId);
  }

  return headers;
}

function normalizeRequestBody(raw: unknown): Record<string, unknown> {
  const body = isObject(raw) ? { ...raw } : {};

  if (!body.model) {
    body.model = DEFAULT_MODEL;
  }

  if (body.store === undefined) {
    body.store = false;
  }

  return body;
}

async function refreshAndCacheTokens(env: Env, refreshToken: string): Promise<TokenData> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.OPENAI_OAUTH_CLIENT_ID,
  });

  const response = await fetch(OPENAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const accessToken = asString(payload.access_token);
  if (!accessToken) {
    throw new Error("Token refresh failed: missing access_token");
  }

  const newRefreshToken = asString(payload.refresh_token) ?? refreshToken;

  const expiresInRaw = payload.expires_in;
  const expiresInSec =
    typeof expiresInRaw === "number" && Number.isFinite(expiresInRaw)
      ? expiresInRaw
      : Number(asString(expiresInRaw) ?? "3600");
  const safeExpiresInSec = Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 3600;

  const idToken = asString(payload.id_token);
  const accountId = extractAccountId(idToken) ?? extractAccountId(accessToken) ?? env.CHATGPT_ACCOUNT_ID;

  const tokenData: TokenData = {
    accessToken,
    refreshToken: newRefreshToken,
    expiresAt: Date.now() + safeExpiresInSec * 1000,
    accountId,
  };

  await env.TOKEN_STORE.put("tokens", JSON.stringify(tokenData), {
    expirationTtl: 86400,
  });

  return tokenData;
}

async function getValidToken(env: Env): Promise<TokenData> {
  const cached = (await env.TOKEN_STORE.get("tokens", "json")) as TokenData | null;
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached;
  }

  const refreshToken = cached?.refreshToken || env.OPENAI_REFRESH_TOKEN;
  return refreshAndCacheTokens(env, refreshToken);
}

async function sendToCodex(
  request: Request,
  body: Record<string, unknown>,
  accessToken: string,
  accountId?: string,
): Promise<Response> {
  return fetch(CODEX_RESPONSES_API_URL, {
    method: "POST",
    headers: buildUpstreamHeaders(request, accessToken, accountId),
    body: JSON.stringify(body),
  });
}

async function handleResponses(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: withCors(),
    });
  }

  if (!validateProxyAuth(request, env)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: withCors(),
    });
  }

  let parsedBody: Record<string, unknown>;
  try {
    parsedBody = normalizeRequestBody(await request.json());
  } catch {
    return new Response("Invalid JSON body", {
      status: 400,
      headers: withCors(),
    });
  }

  let tokenData: TokenData;
  try {
    tokenData = await getValidToken(env);
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: "token_error",
        message: String(error),
      }),
      {
        status: 500,
        headers: withCors({ "Content-Type": "application/json" }),
      },
    );
  }

  let upstream = await sendToCodex(
    request,
    parsedBody,
    tokenData.accessToken,
    tokenData.accountId ?? env.CHATGPT_ACCOUNT_ID,
  );

  if (upstream.status === 401) {
    try {
      tokenData = await refreshAndCacheTokens(env, tokenData.refreshToken);
      upstream = await sendToCodex(
        request,
        parsedBody,
        tokenData.accessToken,
        tokenData.accountId ?? env.CHATGPT_ACCOUNT_ID,
      );
    } catch {
      return new Response(
        JSON.stringify({
          error: "authentication_error",
          message: "Codex OAuth authentication failed. Re-run the login script and update secrets.",
        }),
        {
          status: 401,
          headers: withCors({ "Content-Type": "application/json" }),
        },
      );
    }
  }

  const responseHeaders = withCors(upstream.headers);
  if (parsedBody.stream === true && upstream.body) {
    responseHeaders.set("Cache-Control", "no-cache");
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

function modelsResponse(): Response {
  const models = {
    object: "list",
    data: [
      { id: "gpt-5.3-codex", object: "model", owned_by: "openai" },
      { id: "gpt-5.2-codex", object: "model", owned_by: "openai" },
      { id: "gpt-5.1-codex", object: "model", owned_by: "openai" },
      { id: "gpt-5.1-codex-max", object: "model", owned_by: "openai" },
      { id: "gpt-5.1-codex-mini", object: "model", owned_by: "openai" },
      { id: "gpt-5-codex", object: "model", owned_by: "openai" },
      { id: "gpt-5-codex-mini", object: "model", owned_by: "openai" },
    ],
  };

  return new Response(JSON.stringify(models), {
    headers: withCors({ "Content-Type": "application/json" }),
  });
}

async function healthResponse(env: Env): Promise<Response> {
  let tokenStatus = "unknown";
  try {
    const cached = (await env.TOKEN_STORE.get("tokens", "json")) as TokenData | null;
    if (!cached) {
      tokenStatus = "not_cached (will refresh on first request)";
    } else if (cached.expiresAt > Date.now()) {
      const remainingMinutes = Math.round((cached.expiresAt - Date.now()) / 1000 / 60);
      tokenStatus = `valid (expires in ${remainingMinutes} minutes)`;
    } else {
      tokenStatus = "expired (will refresh on next request)";
    }
  } catch (error) {
    tokenStatus = `error: ${String(error)}`;
  }

  return new Response(
    JSON.stringify({
      status: "ok",
      service: "gpt-codex-proxy",
      tokenStatus,
    }),
    {
      headers: withCors({ "Content-Type": "application/json" }),
    },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: withCors(),
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/v1/responses" || path === "/openai/v1/responses") {
      return handleResponses(request, env);
    }

    if (path === "/v1/models" || path === "/openai/v1/models") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: withCors(),
        });
      }
      return modelsResponse();
    }

    if (path === "/" || path === "/health") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: withCors(),
        });
      }
      return healthResponse(env);
    }

    return new Response("Not found", {
      status: 404,
      headers: withCors(),
    });
  },
};
