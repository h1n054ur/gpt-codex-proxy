#!/usr/bin/env node

import crypto from "crypto";
import http from "http";
import fs from "fs";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const OAUTH_AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const OAUTH_TOKEN_URL = `${ISSUER}/oauth/token`;
const OAUTH_SCOPE = "openid profile email offline_access";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function generateState() {
  return base64url(crypto.randomBytes(32));
}

function parseJwtClaims(token) {
  if (!token || typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function extractAccountId(tokens) {
  const from = (claims) => {
    if (!claims || typeof claims !== "object") return undefined;
    if (typeof claims.chatgpt_account_id === "string") return claims.chatgpt_account_id;
    const nested = claims["https://api.openai.com/auth"];
    if (nested && typeof nested === "object" && typeof nested.chatgpt_account_id === "string") {
      return nested.chatgpt_account_id;
    }
    if (Array.isArray(claims.organizations) && claims.organizations[0]?.id) {
      return claims.organizations[0].id;
    }
    return undefined;
  };

  return from(parseJwtClaims(tokens.id_token)) || from(parseJwtClaims(tokens.access_token));
}

function buildAuthorizeURL(redirectUri, challenge, state) {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("originator", "codex_cli_rs");
  return url.toString();
}

async function exchangeCodeForTokens({ code, verifier, redirectUri }) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${error}`);
  }

  return response.json();
}

function openBrowser(url) {
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "start"
        : "xdg-open";

  import("child_process")
    .then(({ exec }) => exec(`${command} "${url}"`))
    .catch(() => {
      // No-op, user can open manually.
    });
}

async function waitForOAuthCallback({ state, redirectUri }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${CALLBACK_PORT}`);

      if (url.pathname !== CALLBACK_PATH) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const incomingState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      if (error) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<h1>Authorization failed</h1><p>Return to the terminal.</p>");
        cleanup();
        reject(new Error(errorDescription || error));
        return;
      }

      if (incomingState !== state) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<h1>State mismatch</h1><p>Return to the terminal.</p>");
        cleanup();
        reject(new Error("State mismatch in OAuth callback"));
        return;
      }

      if (!code) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<h1>Missing code</h1><p>Return to the terminal.</p>");
        cleanup();
        reject(new Error("Missing authorization code"));
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<h1>Authorization successful</h1><p>You can close this tab.</p>");
      cleanup();
      resolve({ code, redirectUri });
    });

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for OAuth callback"));
    }, CALLBACK_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      server.close();
    }

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      // Server ready.
    });
  });
}

async function main() {
  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
  const { verifier, challenge } = generatePKCE();
  const state = generateState();
  const authorizeURL = buildAuthorizeURL(redirectUri, challenge, state);

  console.log("=".repeat(60));
  console.log("GPT Codex OAuth Login");
  console.log("=".repeat(60));
  console.log();
  console.log("Open this URL to authenticate:");
  console.log(authorizeURL);
  console.log();
  console.log(`Waiting for callback on ${redirectUri}`);
  console.log("(If browser does not open, copy-paste the URL manually)");
  console.log();

  openBrowser(authorizeURL);

  const callback = await waitForOAuthCallback({ state, redirectUri });
  const tokens = await exchangeCodeForTokens({
    code: callback.code,
    verifier,
    redirectUri,
  });

  const accountId = extractAccountId(tokens);

  const output = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token,
    expires_in: tokens.expires_in,
    chatgpt_account_id: accountId,
    obtained_at: new Date().toISOString(),
    issuer: ISSUER,
    client_id: CLIENT_ID,
  };

  fs.writeFileSync(".tokens.json", JSON.stringify(output, null, 2));

  console.log();
  console.log("=".repeat(60));
  console.log("SUCCESS! Tokens saved to .tokens.json");
  console.log("=".repeat(60));
  console.log();
  if (accountId) {
    console.log(`Detected ChatGPT account id: ${accountId}`);
    console.log();
  } else {
    console.log("No account id found in token claims (you can still proceed).");
    console.log();
  }

  console.log("Run these commands to set worker secrets:");
  console.log();
  console.log("echo '" + output.access_token + "' | wrangler secret put OPENAI_ACCESS_TOKEN");
  console.log("echo '" + output.refresh_token + "' | wrangler secret put OPENAI_REFRESH_TOKEN");
  console.log('echo "your-proxy-secret" | wrangler secret put PROXY_SECRET');
  if (accountId) {
    console.log("echo '" + accountId + "' | wrangler secret put CHATGPT_ACCOUNT_ID");
  }
  console.log();
}

main().catch((error) => {
  console.error("OAuth login failed:", error.message || String(error));
  process.exit(1);
});
