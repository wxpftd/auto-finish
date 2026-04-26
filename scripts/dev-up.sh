#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# scripts/dev-up.sh — bring up the auto-finish dev infrastructure stack.
#
# What it does:
#   1. Copies .env.example to .env if missing (so docker compose can interpolate).
#   2. Runs `docker compose up -d`.
#   3. Waits for every service to report healthy (or surfaces a clear error).
#   4. Prints the next steps (URLs, seeding command, pnpm dev hint).
#
# Usage:
#   bash scripts/dev-up.sh
# -----------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found on PATH. Install Docker Desktop / OrbStack / colima first." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' subcommand unavailable. You probably have legacy docker-compose; please upgrade to compose v2." >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "[dev-up] .env not found — copying from .env.example"
  cp .env.example .env
  echo "[dev-up] WARNING: .env contains placeholder secrets. Edit it before any non-laptop use."
fi

# Load .env so we can echo back the right ports below.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

LANGFUSE_PORT="${LANGFUSE_PORT:-3001}"
DAYTONA_PORT="${DAYTONA_PORT:-3986}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"
ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-4000}"
DASHBOARD_PORT="${DASHBOARD_PORT:-5173}"

echo "[dev-up] starting compose stack (this can take ~2-3 min on first run while clickhouse + langfuse warm up)..."
docker compose up -d

# Poll for healthy state. We give Langfuse a generous window because clickhouse
# migrations on first boot are slow.
SERVICES="postgres redis langfuse-db langfuse-clickhouse langfuse-minio langfuse-worker langfuse-web daytona-stub"
DEADLINE=$(( $(date +%s) + 300 ))

echo "[dev-up] waiting for services to report healthy..."
while :; do
  ALL_OK=1
  for svc in $SERVICES; do
    cid="$(docker compose ps -q "$svc" 2>/dev/null || true)"
    if [ -z "$cid" ]; then
      ALL_OK=0
      break
    fi
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo "unknown")"
    case "$state" in
      healthy|running)
        # `running` is acceptable for services without healthcheck (none of ours,
        # but be defensive).
        ;;
      *)
        ALL_OK=0
        break
        ;;
    esac
  done

  if [ "$ALL_OK" -eq 1 ]; then
    break
  fi

  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "ERROR: services did not become healthy within 5 minutes." >&2
    echo "Run 'docker compose ps' and 'docker compose logs <service>' to investigate." >&2
    exit 1
  fi
  sleep 3
done

echo
echo "[dev-up] all services healthy."
echo
echo "  Langfuse UI:        http://localhost:${LANGFUSE_PORT}"
echo "  Daytona stub:       http://localhost:${DAYTONA_PORT}  (placeholder — install Daytona OSS separately)"
echo "  Postgres:           localhost:${POSTGRES_PORT}"
echo "  Redis:              localhost:${REDIS_PORT}"
echo
echo "Next steps:"
echo "  1. Seed Langfuse (creates project + writes API keys to .env):"
echo "       bash scripts/seed-langfuse.sh"
echo "  2. Start orchestrator + dashboard on the host:"
echo "       pnpm install"
echo "       pnpm dev"
echo "  3. Orchestrator will be at http://localhost:${ORCHESTRATOR_PORT}, dashboard at http://localhost:${DASHBOARD_PORT}"
