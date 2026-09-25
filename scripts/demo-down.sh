#!/usr/bin/env bash
# Stop the Backstop demo stack.
#
#   ./scripts/demo-down.sh           # stop, keep the data
#   ./scripts/demo-down.sh --reset   # stop and delete the database volume
#
# A public tunnel (demo-tunnel.sh) is a separate process: stop it first.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--reset" ]]; then
  echo "==> docker compose down -v (deletes the database volume; the demo reseeds on next start)"
  docker compose down -v
else
  echo "==> docker compose down (the database volume is kept)"
  docker compose down
fi
