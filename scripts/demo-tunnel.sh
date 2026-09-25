#!/usr/bin/env bash
# Expose the UI gateway (and only it) through a Cloudflare Quick Tunnel.
#
#   ./scripts/demo-tunnel.sh
#
# Quick Tunnels are for demos and development: a random *.trycloudflare.com URL,
# no uptime guarantee, a new URL every start. Production would use a named
# tunnel behind Cloudflare Access, or a normal cloud deployment (infra/terraform).
#
# Refuses to publish while the demo accounts still use password == username.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${BACKSTOP_UI_PORT:-5173}"
BASE="http://localhost:${PORT}"

command -v cloudflared >/dev/null 2>&1 || {
  echo "cloudflared is not installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
  exit 1
}

health="$(curl -fsS "${BASE}/api/health/deep")" || { echo "Backstop is not running — ./scripts/demo-up.sh first" >&2; exit 1; }
PY="$(command -v python3 || command -v python)"
if "$PY" -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("default_credentials") else 1)' <<<"$health"; then
  cat >&2 <<'MSG'
Refusing to publish: the demo accounts still use password == username, and a
Quick Tunnel URL is reachable by anyone who has it.

Set real passwords in .env, then restart the API:
  BACKSTOP_USERS=pavan:<long-password>:engineer,reviewer:<long-password>:analyst,admin:<long-password>:admin
  docker compose up -d api
MSG
  exit 1
fi

echo "==> publishing ${BASE} (UI + /api only; Postgres, the API port and Ollama stay private)"
echo "    fallback if the tunnel dies: run this again (new URL), or screen-share ${BASE}"
exec cloudflared tunnel --no-autoupdate --url "${BASE}"
