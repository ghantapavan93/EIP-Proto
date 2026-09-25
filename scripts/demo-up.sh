#!/usr/bin/env bash
# Start Backstop for a demo and prove it is ready, through the same gateway a
# viewer will use (http://localhost:$PORT/api/...), not the API port.
#
#   ./scripts/demo-up.sh            build + start, wait for health, print the URL
#   ./scripts/demo-up.sh --fresh    also drop the database volume first (reseeds everything)
#
# Works offline after the images are built: frozen page snapshots, recorded
# cassettes; Ollama is optional.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${BACKSTOP_UI_PORT:-5173}"
BASE="http://localhost:${PORT}"

if [[ "${1:-}" == "--fresh" ]]; then
  echo "==> dropping the database volume (demo data is reseeded on start)"
  docker compose down -v
fi

echo "==> docker compose up --build -d"
docker compose up --build -d

PY="$(command -v python3 2>/dev/null || command -v python)"
ready() { "$PY" -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ready") else 1)' <<<"$1"; }

echo "==> waiting for ${BASE}/api/health/deep"
health=""
for _ in $(seq 1 90); do
  if candidate="$(curl -fsS "${BASE}/api/health/deep" 2>/dev/null)" && ready "$candidate"; then
    health="$candidate"
    break
  fi
  sleep 2
done
if [[ -z "$health" ]]; then
  echo "error: not ready after 180 s — see: docker compose logs api" >&2
  docker compose ps
  exit 1
fi

"$PY" - "$health" <<'PYEOF'
import json, sys
h = json.loads(sys.argv[1])
print()
for c in h["components"]:
    tag = "" if c["required"] else "  (optional)"
    print(f"  {c['name']:<10} {c['state']:<9} {c['detail']}{tag}")
print(f"\n  overall    {h['status'].upper()}")
if h.get("default_credentials"):
    print("\n  NOTE: demo accounts still use password == username. Fine on localhost;")
    print("        set BACKSTOP_USERS in .env before running scripts/demo-tunnel.sh.")
PYEOF

echo
echo "Backstop is up:  ${BASE}"
echo "Public URL:      ./scripts/demo-tunnel.sh   (Cloudflare Quick Tunnel → port ${PORT})"
