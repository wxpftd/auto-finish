#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# scripts/dev-down.sh — tear down the auto-finish dev infrastructure stack.
#
# Usage:
#   bash scripts/dev-down.sh              # stop containers, keep volumes
#   bash scripts/dev-down.sh --volumes    # stop AND wipe all volumes (full reset)
# -----------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found on PATH." >&2
  exit 1
fi

WIPE_VOLUMES=0
for arg in "$@"; do
  case "$arg" in
    --volumes|-v)
      WIPE_VOLUMES=1
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--volumes]" >&2
      exit 2
      ;;
  esac
done

if [ "$WIPE_VOLUMES" -eq 1 ]; then
  echo "[dev-down] stopping stack AND removing volumes (full reset)..."
  docker compose down -v --remove-orphans
  echo "[dev-down] done. All data wiped."
else
  echo "[dev-down] stopping stack (volumes preserved)..."
  docker compose down --remove-orphans
  echo "[dev-down] done. Bring back up with: bash scripts/dev-up.sh"
fi
