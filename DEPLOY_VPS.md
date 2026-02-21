# VPS Deploy Guide (Sanitized)

This guide deploys `gpt-codex-proxy` to a remote Linux VPS with Docker, then exposes it with Cloudflare Tunnel.

All values below are placeholders. Do not commit real credentials.

## 1) Prerequisites

- Ubuntu/Debian VPS with Docker + Docker Compose plugin
- SSH access (`root` or sudo user)
- Cloudflare domain + `cloudflared` installed locally

## 2) Clone on VPS

```bash
ssh -i ~/.ssh/your_key root@your-server-ip
mkdir -p /opt
git clone https://github.com/your-user/gpt-codex-proxy.git /opt/gpt-codex-proxy
cd /opt/gpt-codex-proxy
```

## 3) Create runtime env (on VPS)

Create `/opt/gpt-codex-proxy/.env`:

```env
OPENAI_OAUTH_CLIENT_ID=app_EMoamEEZ73f0CkXaXp7hrann
OPENAI_ACCESS_TOKEN=...
OPENAI_REFRESH_TOKEN=...
CHATGPT_ACCOUNT_ID=...
PROXY_SECRET=...
PROXY_BIND_PORT=28080
CLOUDFLARED_TUNNEL_TOKEN=...
```

Use a non-conflicting `PROXY_BIND_PORT` if `8080` is already used.

## 4) Tunnel setup

Option A: token mode (simple)

```bash
cloudflared tunnel create codex-proxy
cloudflared tunnel route dns codex-proxy codex-proxy.yourdomain.com
cloudflared tunnel token codex-proxy
```

Set that token in `.env` as `CLOUDFLARED_TUNNEL_TOKEN`.

Option B: config mode (recommended if you want explicit ingress)

Create `config/cloudflared/config.yml` (gitignored):

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /etc/cloudflared/credentials.json

ingress:
  - hostname: codex-proxy.yourdomain.com
    service: http://codex-proxy:8080
  - service: http_status:404
```

Add `config/cloudflared/credentials.json` (gitignored) from `~/.cloudflared/<tunnel-id>.json`.

## 5) Start services

Token mode:

```bash
cd /opt/gpt-codex-proxy
docker compose --profile tunnel up -d --build
```

Config mode:

```bash
cd /opt/gpt-codex-proxy
docker compose --profile tunnel-config up -d --build
```

## 6) Verify

```bash
curl -sS https://codex-proxy.yourdomain.com/health
```

```bash
curl -sS -X POST https://codex-proxy.yourdomain.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PROXY_SECRET" \
  -d '{"input":"Reply with exactly VPS_OK","stream":false}'
```

## 7) Update on new commits

```bash
ssh -i ~/.ssh/your_key root@your-server-ip
cd /opt/gpt-codex-proxy
git fetch origin
git checkout main
git pull --ff-only
docker compose --profile tunnel-config up -d --build
```

## 8) Safety checklist

- Never commit `.env`, `.tokens.json`, `.proxy-secret`
- Never commit tunnel credentials JSON files
- Keep public docs/examples placeholder-only
- Rotate `PROXY_SECRET` if it is ever exposed
