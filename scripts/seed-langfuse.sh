#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# scripts/seed-langfuse.sh — seed a Langfuse project + API key, write into .env
#
# Status: PARTIAL STUB. Langfuse's "create org / project / key" admin API is
# session-cookie protected, so a fully-headless flow requires either:
#   (a) the LANGFUSE_INIT_* env vars set in .env BEFORE first boot (preferred —
#       see the LANGFUSE_INIT_* block in .env.example), in which case Langfuse
#       creates the project itself and you don't need this script; OR
#   (b) hitting the public API with an admin's personal access token.
#
# This script:
#   1. Sanity-checks Langfuse is reachable.
#   2. Detects whether LANGFUSE_INIT_* was used (then just copies the keys).
#   3. Otherwise prints the curl shape you'd run by hand (TODO: full automation).
#
# Usage:
#   bash scripts/seed-langfuse.sh
# -----------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  echo "ERROR: .env not found. Run 'bash scripts/dev-up.sh' first." >&2
  exit 1
fi

# Load env.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

LANGFUSE_HOST="${LANGFUSE_HOST:-http://localhost:${LANGFUSE_PORT:-3001}}"

echo "[seed-langfuse] checking Langfuse health at ${LANGFUSE_HOST}..."
if ! curl -fsS "${LANGFUSE_HOST}/api/public/health" >/dev/null 2>&1; then
  echo "ERROR: Langfuse is not reachable at ${LANGFUSE_HOST}." >&2
  echo "Bring up the stack first: bash scripts/dev-up.sh" >&2
  exit 1
fi
echo "[seed-langfuse] Langfuse is up."

# ---------------------------------------------------------------------------
# Path A — LANGFUSE_INIT_* was used. Keys are already known.
# ---------------------------------------------------------------------------
if [ -n "${LANGFUSE_INIT_PROJECT_PUBLIC_KEY:-}" ] && [ -n "${LANGFUSE_INIT_PROJECT_SECRET_KEY:-}" ]; then
  echo "[seed-langfuse] LANGFUSE_INIT_* keys detected; mirroring into LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY in .env"
  # Use a portable in-place sed (BSD sed needs '' after -i; GNU doesn't). Write
  # to a temp then move, to dodge the difference entirely.
  tmp="$(mktemp)"
  awk -v pk="${LANGFUSE_INIT_PROJECT_PUBLIC_KEY}" -v sk="${LANGFUSE_INIT_PROJECT_SECRET_KEY}" '
    /^LANGFUSE_PUBLIC_KEY=/  { print "LANGFUSE_PUBLIC_KEY=" pk; next }
    /^LANGFUSE_SECRET_KEY=/  { print "LANGFUSE_SECRET_KEY=" sk; next }
    { print }
  ' .env > "$tmp"
  mv "$tmp" .env
  echo "[seed-langfuse] done. Restart pnpm dev to pick up the new keys."
  exit 0
fi

# ---------------------------------------------------------------------------
# Path B — manual fallback. TODO: automate once Langfuse exposes a stable
# admin-token-based API for org+project+key creation.
# ---------------------------------------------------------------------------
cat <<'EOF'
[seed-langfuse] LANGFUSE_INIT_* not set, so this script cannot finish unattended.

Two options:

(1) Re-run with init vars (recommended):
    Set these in .env, then `bash scripts/dev-down.sh --volumes && bash scripts/dev-up.sh`:

      LANGFUSE_INIT_ORG_ID=auto-finish
      LANGFUSE_INIT_ORG_NAME=auto-finish
      LANGFUSE_INIT_PROJECT_ID=auto-finish-dev
      LANGFUSE_INIT_PROJECT_NAME=auto-finish-dev
      LANGFUSE_INIT_PROJECT_PUBLIC_KEY=pk-lf-dev-$(openssl rand -hex 8)
      LANGFUSE_INIT_PROJECT_SECRET_KEY=sk-lf-dev-$(openssl rand -hex 16)
      LANGFUSE_INIT_USER_EMAIL=dev@auto-finish.local
      LANGFUSE_INIT_USER_NAME=dev
      LANGFUSE_INIT_USER_PASSWORD=changeme-dev-only

    Then re-run `bash scripts/seed-langfuse.sh` and it will mirror those keys
    into LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY automatically.

(2) Manual via the web UI:
    a. Open the Langfuse URL printed by dev-up.sh (default http://localhost:3001).
    b. Sign up (first user becomes owner).
    c. Create a project, then go to Settings -> API Keys -> Create new key.
    d. Paste the public + secret keys into .env:
         LANGFUSE_PUBLIC_KEY=pk-lf-...
         LANGFUSE_SECRET_KEY=sk-lf-...

# Curl shape (FYI — not run by this script; the project-create endpoint
# requires an authenticated session cookie, not a static API key):
#
#   curl -X POST "${LANGFUSE_HOST}/api/public/projects" \
#     -H "Content-Type: application/json" \
#     -u "$ADMIN_PUBLIC_KEY:$ADMIN_SECRET_KEY" \
#     -d '{"name":"auto-finish-dev"}'
EOF

exit 0
