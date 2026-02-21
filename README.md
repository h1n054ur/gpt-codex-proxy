# GPT Codex Proxy (Local Docker + Cloudflare Tunnel)

Local Node proxy for Codex OAuth traffic, exposed through Cloudflare Tunnel.

This replaces the Worker-based runtime for this project because Worker egress was blocked by upstream challenge responses.

## Deployment model

- Local containerized proxy service (`codex-proxy`) on `127.0.0.1:${PROXY_BIND_PORT:-8080}`
- Cloudflare Tunnel (`codex-proxy`) mapped to `codex-proxy.yourdomain.com`
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
- `PROXY_BIND_PORT` (optional, defaults to `8080`)

## Run

For a full remote deployment workflow, see `DEPLOY_VPS.md`.

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

## Tunnel setup

```bash
cloudflared tunnel create codex-proxy
cloudflared tunnel route dns codex-proxy codex-proxy.yourdomain.com
cloudflared tunnel token codex-proxy
```

If using config mode, place credentials at `config/cloudflared/credentials.json` and set tunnel id in `config/cloudflared/config.yml`.

## Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/responses`

Base URLs:

- Local: `http://127.0.0.1:8080`
- Tunnel: `https://codex-proxy.yourdomain.com`

## Auth

Calls require your proxy key:

`Authorization: Bearer <PROXY_SECRET>`

or

`x-api-key: <PROXY_SECRET>`

## Quick test

```bash
curl -sS https://codex-proxy.yourdomain.com/health
```

```bash
curl -sS -X POST https://codex-proxy.yourdomain.com/v1/responses \
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
- The proxy default model is `gpt-5.3-codex-high` (normalized upstream to `gpt-5.3-codex` with `reasoning.effort=high`).
- Upstream defaults mimic Codex CLI headers (`originator=codex_cli_rs`, `version=0.98.0`).
- Keep `.env`, `.tokens.json`, `.proxy-secret`, and tunnel credentials out of git.
