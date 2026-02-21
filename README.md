# GPT Codex Proxy

Cloudflare Worker proxy for OpenAI Codex requests using your ChatGPT OAuth tokens (instead of API usage billing keys).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/h1n054ur/gpt-codex-proxy)

## What this is

This project mirrors the same pattern as `claude-max-proxy`, but for Codex:

1. Authenticate once via OAuth (ChatGPT account)
2. Store refreshable tokens in Worker secrets + KV
3. Proxy client requests to `https://chatgpt.com/backend-api/codex/responses`
4. Keep access controlled with your own `PROXY_SECRET`

## Requirements

- ChatGPT plan with Codex access
- Cloudflare account (Workers + KV)
- Node.js 18+

## Quick Start

### Option 1: One-click deploy

1. Click the deploy button above
2. Complete Cloudflare deploy flow
3. Continue with OAuth token setup below

### Option 2: Manual deploy

```bash
git clone https://github.com/h1n054ur/gpt-codex-proxy.git
cd gpt-codex-proxy
npm install
wrangler kv namespace create TOKEN_STORE
wrangler deploy
```

## Setup Guide

### 1) Get OAuth tokens

```bash
node scripts/oauth-login.js
```

This opens browser auth, captures callback on `http://localhost:1455/auth/callback`, and writes `.tokens.json`.

### 2) Set Worker secrets

```bash
node -e "console.log(require('./.tokens.json').access_token)" | wrangler secret put OPENAI_ACCESS_TOKEN
node -e "console.log(require('./.tokens.json').refresh_token)" | wrangler secret put OPENAI_REFRESH_TOKEN
echo "your-proxy-secret" | wrangler secret put PROXY_SECRET

# optional but recommended if present in .tokens.json
node -e "const t=require('./.tokens.json'); if(t.chatgpt_account_id) console.log(t.chatgpt_account_id)" | wrangler secret put CHATGPT_ACCOUNT_ID
```

### 3) Deploy

```bash
npm run deploy
```

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Health check |
| `/health` | GET | Health + token cache status |
| `/v1/responses` | POST | OpenAI Responses-compatible proxy endpoint |
| `/openai/v1/responses` | POST | Alias endpoint |
| `/v1/models` | GET | Compatibility model list |

## Client usage

Use your Worker URL as base URL and `PROXY_SECRET` as bearer token.

Example request:

```bash
curl https://your-worker.workers.dev/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-proxy-secret" \
  -d '{
    "model": "gpt-5.3-codex",
    "input": [{"role":"user","content":[{"type":"input_text","text":"hello"}]}],
    "stream": false
  }'
```

## Codex/OpenCode alignment notes

- OAuth client id: `app_EMoamEEZ73f0CkXaXp7hrann`
- OAuth token endpoint: `https://auth.openai.com/oauth/token`
- Upstream endpoint: `https://chatgpt.com/backend-api/codex/responses`
- Account header: `ChatGPT-Account-ID`
- Preserves Codex transport headers like `session_id`, `x-codex-turn-state`, and `x-codex-turn-metadata`

## Cloudflare config

`wrangler.toml` includes:

- KV binding: `TOKEN_STORE`
- public var: `OPENAI_OAUTH_CLIENT_ID`
- secrets you set: `OPENAI_ACCESS_TOKEN`, `OPENAI_REFRESH_TOKEN`, `PROXY_SECRET`, optional `CHATGPT_ACCOUNT_ID`

## Security notes

- Keep `PROXY_SECRET` private
- Anyone with your proxy URL + secret can consume your account capacity
- Do not commit `.tokens.json`

## Disclaimer

Use at your own risk and ensure your usage complies with OpenAI terms.

## References

- [anomalyco/opencode](https://github.com/anomalyco/opencode)
- [openai/codex](https://github.com/openai/codex)
- [h1n054ur/claude-max-proxy](https://github.com/h1n054ur/claude-max-proxy)
