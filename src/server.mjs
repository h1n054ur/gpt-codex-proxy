import { createServer } from "node:http";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || "8080");
const CODEX_RESPONSES_API_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_MODEL_ALIAS = "gpt-5.3-codex-high";
const DEFAULT_UPSTREAM_MODEL = "gpt-5.3-codex";
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_ORIGINATOR = "codex_cli_rs";
const DEFAULT_CLIENT_VERSION = "0.98.0";
const DEFAULT_USER_AGENT = `codex_cli_rs/${DEFAULT_CLIENT_VERSION}`;
const DEFAULT_INSTRUCTIONS =
  "You are Codex, a coding agent based on GPT-5. Follow the user request and keep responses concise.";

const REQUIRED_ENV = ["OPENAI_REFRESH_TOKEN", "PROXY_SECRET"];
for (const name of REQUIRED_ENV) {
  if (!process.env[name]) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

const OPENAI_OAUTH_CLIENT_ID = process.env.OPENAI_OAUTH_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";
const PROXY_SECRET = process.env.PROXY_SECRET;
const CHATGPT_ACCOUNT_ID = process.env.CHATGPT_ACCOUNT_ID || undefined;
const BOOT_ACCESS_TOKEN = process.env.OPENAI_ACCESS_TOKEN || "";

function tokenExpiryMs(token) {
  const claims = decodeJwtPayload(token);
  if (!claims || typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    return 0;
  }
  return claims.exp * 1000;
}

let tokenState = {
  accessToken: BOOT_ACCESS_TOKEN,
  refreshToken: process.env.OPENAI_REFRESH_TOKEN,
  expiresAt: tokenExpiryMs(BOOT_ACCESS_TOKEN),
  accountId: extractAccountId(BOOT_ACCESS_TOKEN) || CHATGPT_ACCOUNT_ID,
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-api-key, session_id, originator, version, x-codex-turn-state, x-codex-turn-metadata, x-codex-beta-features",
  };
}

function sendJson(res, status, data, extra = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsHeaders(),
    ...extra,
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, extra = {}) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    ...corsHeaders(),
    ...extra,
  });
  res.end(text);
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function asString(value) {
  return typeof value === "string" ? value : undefined;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function toBase64(base64url) {
  const normalized = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (normalized.length % 4)) % 4;
  return normalized + "=".repeat(padLength);
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const json = Buffer.from(toBase64(parts[1]), "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractAccountIdFromClaims(claims) {
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

function extractAccountId(token) {
  if (!token) return undefined;
  const claims = decodeJwtPayload(token);
  if (!claims) return undefined;
  return extractAccountIdFromClaims(claims);
}

function normalizeCodexModel(model) {
  const requested = asString(model)?.trim().toLowerCase();
  if (!requested) return DEFAULT_UPSTREAM_MODEL;

  const highAliases = new Set([
    "gpt-5.3-codex-high",
    "gpt-5.3-codex:high",
    "gpt-5.3-codex-high-reasoning",
    "codex-5.3-high",
  ]);
  if (highAliases.has(requested)) return DEFAULT_UPSTREAM_MODEL;
  return requested;
}

function textToInputMessage(text) {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function normalizeInput(body) {
  if (Array.isArray(body.input)) return body.input;

  const inputString = asString(body.input);
  if (inputString && inputString.trim()) return [textToInputMessage(inputString)];

  if (Array.isArray(body.messages)) {
    const converted = [];
    for (const message of body.messages) {
      if (!isObject(message)) continue;
      const role = asString(message.role) || "user";
      if (typeof message.content !== "string") continue;
      converted.push({
        type: "message",
        role,
        content: [{ type: "input_text", text: message.content }],
      });
    }
    if (converted.length) return converted;
  }

  return [textToInputMessage("Hello")];
}

function normalizeReasoning(body, requestedModel) {
  const explicit = isObject(body.reasoning) ? asString(body.reasoning.effort)?.toLowerCase() : undefined;
  if (explicit) return { effort: explicit };
  if (requestedModel.includes("high")) return { effort: DEFAULT_REASONING_EFFORT };
  return { effort: DEFAULT_REASONING_EFFORT };
}

function normalizeRequestBody(raw) {
  const body = isObject(raw) ? { ...raw } : {};
  const requestedModel = asString(body.model)?.trim().toLowerCase() || DEFAULT_MODEL_ALIAS;

  body.model = normalizeCodexModel(requestedModel);
  body.instructions = asString(body.instructions)?.trim() || DEFAULT_INSTRUCTIONS;
  body.input = normalizeInput(body);
  body.reasoning = normalizeReasoning(body, requestedModel);
  body.tools = Array.isArray(body.tools) ? body.tools : [];
  body.tool_choice = asString(body.tool_choice) || "auto";
  body.parallel_tool_calls = typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : true;
  body.include = isStringArray(body.include) ? body.include : [];
  body.store = false;
  body.stream = true;

  return body;
}

function parseSSE(text) {
  const events = [];
  let currentEvent = "message";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      continue;
    }

    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;

    try {
      events.push({ event: currentEvent, data: JSON.parse(payload) });
    } catch {
      // ignore malformed lines
    }
  }

  return events;
}

function buildNonStreamResponseFromSSE(sseText) {
  const events = parseSSE(sseText);
  let completed = null;
  let error = null;
  let outputText = "";

  for (const entry of events) {
    const data = entry.data;
    if (!isObject(data)) continue;

    if (data.type === "error" && isObject(data.error)) {
      error = data.error;
    }

    if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
      outputText += data.delta;
    }

    if (data.type === "response.output_text.done" && typeof data.text === "string" && !outputText) {
      outputText = data.text;
    }

    if (data.type === "response.completed" && isObject(data.response)) {
      completed = data.response;
    }

    if (data.type === "response.failed" && isObject(data.response)) {
      completed = data.response;
      if (!error && isObject(data.response.error)) {
        error = data.response.error;
      }
    }
  }

  return { completed, error, outputText, eventCount: events.length };
}

function normalizeSecretValue(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
}

function getAuthDebugInfo(req) {
  const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  const xApiKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"].trim() : "";
  const apiKey = typeof req.headers["api-key"] === "string" ? req.headers["api-key"].trim() : "";

  let authScheme = "none";
  if (authHeader) {
    const first = authHeader.split(/\s+/, 1)[0] || "unknown";
    authScheme = first;
  }

  return {
    authScheme,
    authHeaderLength: authHeader.length,
    xApiKeyLength: xApiKey.length,
    apiKeyLength: apiKey.length,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
  };
}

function validateProxyAuth(req) {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.trim().length > 0) {
    const trimmed = authHeader.trim();
    const raw = normalizeSecretValue(trimmed);

    if (raw === PROXY_SECRET) {
      return true;
    }

    const match = trimmed.match(/^Bearer\s+(.+)$/i);
    if (match && normalizeSecretValue(match[1]) === PROXY_SECRET) {
      return true;
    }

    const basic = trimmed.match(/^Basic\s+(.+)$/i);
    if (basic) {
      try {
        const decoded = Buffer.from(basic[1], "base64").toString("utf8");
        const [user = "", pass = ""] = decoded.split(":", 2);
        if (normalizeSecretValue(user) === PROXY_SECRET || normalizeSecretValue(pass) === PROXY_SECRET) {
          return true;
        }
      } catch {
        // ignore invalid basic auth encoding
      }
    }
  }

  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && normalizeSecretValue(xApiKey) === PROXY_SECRET) {
    return true;
  }

  const apiKey = req.headers["api-key"];
  return typeof apiKey === "string" && normalizeSecretValue(apiKey) === PROXY_SECRET;
}

function buildUpstreamHeaders(req, accessToken, accountId) {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  headers.set("originator", req.headers.originator || DEFAULT_ORIGINATOR);
  headers.set("user-agent", req.headers["user-agent"] || DEFAULT_USER_AGENT);
  headers.set("version", req.headers.version || DEFAULT_CLIENT_VERSION);
  headers.set("session_id", req.headers.session_id || randomUUID());

  if (accountId) {
    headers.set("ChatGPT-Account-ID", accountId);
  }

  const passthrough = ["x-codex-turn-state", "x-codex-turn-metadata", "x-codex-beta-features"];
  for (const key of passthrough) {
    const value = req.headers[key];
    if (typeof value === "string" && value.length > 0) {
      headers.set(key, value);
    }
  }

  return headers;
}

async function refreshAccessToken(refreshToken) {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OPENAI_OAUTH_CLIENT_ID,
  });

  const response = await fetch(OPENAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`token refresh failed: ${response.status} ${text}`);
  }

  const payload = await response.json();
  const accessToken = asString(payload.access_token);
  if (!accessToken) throw new Error("token refresh failed: missing access_token");

  const newRefreshToken = asString(payload.refresh_token) || refreshToken;
  const expiresIn = Number(payload.expires_in || 3600);
  const safeExpiresIn = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
  const accountId = extractAccountId(asString(payload.id_token)) || extractAccountId(accessToken) || CHATGPT_ACCOUNT_ID;

  tokenState = {
    accessToken,
    refreshToken: newRefreshToken,
    expiresAt: Date.now() + safeExpiresIn * 1000,
    accountId,
  };

  return tokenState;
}

async function getValidToken() {
  if (tokenState.accessToken && tokenState.expiresAt > Date.now() + 60_000) {
    return tokenState;
  }
  return refreshAccessToken(tokenState.refreshToken);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 2 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function modelList() {
  return {
    object: "list",
    data: [
      { id: "gpt-5.3-codex-high", object: "model", owned_by: "openai" },
      { id: "gpt-5.3-codex", object: "model", owned_by: "openai" },
      { id: "gpt-5.2-codex", object: "model", owned_by: "openai" },
      { id: "gpt-5.1-codex", object: "model", owned_by: "openai" },
      { id: "gpt-5.1-codex-max", object: "model", owned_by: "openai" },
      { id: "gpt-5.1-codex-mini", object: "model", owned_by: "openai" },
      { id: "gpt-5-codex", object: "model", owned_by: "openai" },
      { id: "gpt-5-codex-mini", object: "model", owned_by: "openai" },
    ],
  };
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      const status = tokenState.accessToken
        ? tokenState.expiresAt > Date.now()
          ? `valid (expires in ${Math.round((tokenState.expiresAt - Date.now()) / 60000)} minutes)`
          : "expired (will refresh on next request)"
        : "not_cached (will refresh on first request)";
      sendJson(res, 200, {
        status: "ok",
        service: "gpt-codex-proxy-local",
        tokenStatus: status,
      });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/openai/v1/models")) {
      sendJson(res, 200, modelList());
      return;
    }

    if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/openai/v1/responses")) {
      if (!validateProxyAuth(req)) {
        console.warn(
          `[auth] unauthorized ${new Date().toISOString()} ${JSON.stringify(getAuthDebugInfo(req))}`,
        );
        sendText(res, 401, "Unauthorized");
        return;
      }

      let rawBody;
      try {
        rawBody = await readJsonBody(req);
      } catch {
        sendText(res, 400, "Invalid JSON body");
        return;
      }

      const clientRequestedStream = isObject(rawBody) ? rawBody.stream === true : false;
      const body = normalizeRequestBody(rawBody);

      let token;
      try {
        token = await getValidToken();
      } catch (error) {
        sendJson(res, 500, { error: "token_error", message: String(error) });
        return;
      }

      const send = async (accessToken, accountId) =>
        fetch(CODEX_RESPONSES_API_URL, {
          method: "POST",
          headers: buildUpstreamHeaders(req, accessToken, accountId),
          body: JSON.stringify(body),
        });

      let upstream = await send(token.accessToken, token.accountId || CHATGPT_ACCOUNT_ID);
      if (upstream.status === 401) {
        token = await refreshAccessToken(token.refreshToken);
        upstream = await send(token.accessToken, token.accountId || CHATGPT_ACCOUNT_ID);
      }

      const responseHeaders = {
        ...corsHeaders(),
        "Content-Type": upstream.headers.get("content-type") || "application/json",
      };

      if (clientRequestedStream) {
        res.writeHead(upstream.status, responseHeaders);
        if (upstream.body) {
          Readable.fromWeb(upstream.body).pipe(res);
          return;
        }

        const text = await upstream.text();
        res.end(text);
        return;
      }

      const sseText = await upstream.text();
      const parsed = buildNonStreamResponseFromSSE(sseText);

      if (parsed.error) {
        sendJson(res, 400, {
          error: parsed.error,
          output_text: parsed.outputText || "",
        });
        return;
      }

      if (parsed.completed) {
        sendJson(res, 200, {
          ...parsed.completed,
          output_text: parsed.outputText || "",
        });
        return;
      }

      sendJson(res, upstream.status, {
        status: "unknown_upstream_response",
        event_count: parsed.eventCount,
        raw: sseText,
      });
      return;
    }

    sendText(res, 404, "Not found");
  } catch (error) {
    sendJson(res, 500, { error: "internal_error", message: String(error) });
  }
})
  .listen(PORT, "0.0.0.0", () => {
    console.log(`gpt-codex-proxy-local listening on http://0.0.0.0:${PORT}`);
  });
