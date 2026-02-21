# GPT Codex Proxy (Local Docker + Cloudflare Tunnel)

Local Node proxy for Codex OAuth traffic, exposed through Cloudflare Tunnel.

This replaces the Worker-based runtime for this project because Worker egress was blocked by upstream challenge responses.

## What is deployed now

- Local containerized proxy service (`codex-proxy`) on `127.0.0.1:8080`
- Cloudflare Tunnel (`codex-proxy`) mapped to `codex-proxy.h1n054ur.dev`
- Tunnel traffic forwarded to `http://codex-proxy:8080`

## Files

- `src/server.mjs` - runtime proxy server (token refresh + `/v1/responses` forwarding)
- `docker-compose.yml` - app + tunnel services
- `Dockerfile` - minimal Node runtime image
- `.env` - local secrets/config (ignored)
- `config/cloudflared/config.yml` - tunnel ingress config (ignored)

## Environment

Use `.env` (copy from `.env.example`):

- `OPENAI_OAUTH_CLIENT_ID`
- `OPENAI_ACCESS_TOKEN`
- `OPENAI_REFRESH_TOKEN`
- `CHATGPT_ACCOUNT_ID`
- `PROXY_SECRET`
- `CLOUDFLARED_TUNNEL_TOKEN`

## Run

Start proxy + tunnel (token mode):

```bash
docker compose --profile tunnel up -d --build
```

Start proxy + tunnel (config/credentials mode):

```bash
docker compose --profile tunnel-config up -d --build
```

Stop everything:

```bash
docker compose down
```

## Tunnel setup (already done for this repo)

```bash
cloudflared tunnel create codex-proxy
cloudflared tunnel route dns codex-proxy codex-proxy.h1n054ur.dev
cloudflared tunnel token codex-proxy
```

If using config mode, place credentials at `config/cloudflared/credentials.json` and set tunnel id in `config/cloudflared/config.yml`.

## Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/responses`

Base URLs:

- Local: `http://127.0.0.1:8080`
- Tunnel: `https://codex-proxy.h1n054ur.dev`

## Auth

Calls require your proxy key:

`Authorization: Bearer <PROXY_SECRET>`

or

`x-api-key: <PROXY_SECRET>`

## Quick test

```bash
curl -sS https://codex-proxy.h1n054ur.dev/health
```

```bash
curl -sS -X POST https://codex-proxy.h1n054ur.dev/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PROXY_SECRET" \
  -d '{
    "model": "gpt-5.2-codex",
    "input": "Reply with exactly: OK",
    "stream": true
  }'
```

## Notes

- `gpt-5.3-codex` access depends on account entitlement and may return `model_not_found`.
- The proxy defaults reasoning effort to `high` and normalizes `gpt-5.3-codex-high` alias to `gpt-5.3-codex`.
- Keep `.env`, `.tokens.json`, `.proxy-secret`, and tunnel credentials out of git.
