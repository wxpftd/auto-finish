#!/usr/bin/env bash
# Bootstrap the auto-finish e2e smoke: pipeline + project + requirement.
#
# Re-runnable: each call creates fresh DB rows. To reset state, stop pnpm dev,
# rm .auto-finish/orchestrator.sqlite*, restart.
#
# Prerequisites:
#   - orchestrator running on http://localhost:4000 (override via ORCHESTRATOR_API)
#   - `gh` authenticated on the host (we pull the token via `gh auth token`)
#   - Docker image built:
#       docker build -f examples/warm-image.Dockerfile \
#         -t auto-finish/two-repo-smoke:base --target=base .
#   - Two GitHub repos seeded:
#       wxpftd/auto-finish-fe-smoke
#       wxpftd/auto-finish-be-smoke
#   - jq + curl on host PATH

set -euo pipefail

API="${ORCHESTRATOR_API:-http://localhost:4000}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SMOKE="$ROOT/scripts/e2e-smoke"

echo "[bootstrap] orchestrator API: $API"
echo "[bootstrap] root: $ROOT"

# Sanity: orchestrator alive?
if ! curl -fsS -o /dev/null "$API/healthz"; then
  echo "[bootstrap] FATAL: orchestrator not responding on $API/healthz"
  echo "[bootstrap] start it with: pnpm dev (from repo root)"
  exit 1
fi

# Pull host gh token (kept out of yaml on disk and git history).
GH_TOKEN_VALUE="$(gh auth token)"
if [[ -z "$GH_TOKEN_VALUE" ]]; then
  echo "[bootstrap] FATAL: gh auth token returned empty"
  exit 1
fi
echo "[bootstrap] gh token loaded: ${GH_TOKEN_VALUE:0:8}..."

# 1) POST /api/pipelines — pipeline yaml as a string field.
PIPELINE_YAML="$(cat "$ROOT/examples/two-repo-demo/pipeline.yaml")"
PIPELINE_RESP="$(curl -fsS -X POST "$API/api/pipelines" \
  -H 'content-type: application/json' \
  -d "$(jq -n \
    --arg name "E2E two-repo (smoke)" \
    --arg yaml "$PIPELINE_YAML" \
    '{name:$name, yaml:$yaml}')")"
PIPELINE_ID="$(echo "$PIPELINE_RESP" | jq -r '.pipeline.id')"
if [[ "$PIPELINE_ID" == "null" || -z "$PIPELINE_ID" ]]; then
  echo "[bootstrap] FATAL: could not extract pipeline.id from:"
  echo "$PIPELINE_RESP"
  exit 1
fi
echo "[bootstrap] pipeline_id=$PIPELINE_ID"

# 2) POST /api/projects/from-yaml — substitute placeholders in project.yaml first.
PROJECT_YAML="$(sed \
  -e "s|__PIPELINE_ID__|$PIPELINE_ID|g" \
  -e "s|__GH_TOKEN__|$GH_TOKEN_VALUE|g" \
  "$SMOKE/project.yaml")"
PROJECT_RESP="$(curl -fsS -X POST "$API/api/projects/from-yaml" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg yaml "$PROJECT_YAML" '{project_yaml:$yaml}')")"
PROJECT_ID="$(echo "$PROJECT_RESP" | jq -r '.project.id')"
if [[ "$PROJECT_ID" == "null" || -z "$PROJECT_ID" ]]; then
  echo "[bootstrap] FATAL: could not extract project.id from:"
  echo "$PROJECT_RESP"
  exit 1
fi
echo "[bootstrap] project_id=$PROJECT_ID"

# 3) POST /api/requirements
REQ_DESCRIPTION='在 backend 加一个 GET /api/echo?msg=... 端点，返回 JSON {"echoed": <msg>, "at": <ISO timestamp>}。
在 frontend 接好 #msg 输入框 + #send 按钮：点击后向 backend 的 /api/echo 端点发请求（默认 backend 跑在 http://localhost:3001），把响应里的 echoed 字段渲染到 #result。
两个 repo 的 npm test 已经是占位（exit 0），不需要新增测试。'

REQ_RESP="$(curl -fsS -X POST "$API/api/requirements" \
  -H 'content-type: application/json' \
  -d "$(jq -n \
    --arg pid "$PROJECT_ID" \
    --arg lid "$PIPELINE_ID" \
    --arg desc "$REQ_DESCRIPTION" \
    '{project_id:$pid, pipeline_id:$lid,
      title:"add /api/echo + frontend input wiring",
      description:$desc}')")"
REQ_ID="$(echo "$REQ_RESP" | jq -r '.requirement.id')"
if [[ "$REQ_ID" == "null" || -z "$REQ_ID" ]]; then
  echo "[bootstrap] FATAL: could not extract requirement.id from:"
  echo "$REQ_RESP"
  exit 1
fi
echo "[bootstrap] requirement_id=$REQ_ID"

# 4) POST /api/runs/start — fire-and-forget; runner spins up in orchestrator process.
START_RESP="$(curl -fsS -X POST "$API/api/runs/start" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg rid "$REQ_ID" '{requirement_id:$rid}')")"
ACCEPTED="$(echo "$START_RESP" | jq -r '.accepted')"
if [[ "$ACCEPTED" != "true" ]]; then
  echo "[bootstrap] FATAL: /api/runs/start did not accept the requirement:"
  echo "$START_RESP"
  exit 1
fi
echo "[bootstrap] runner triggered (background task in orchestrator process)"
echo
echo "[bootstrap] DONE"
echo "[bootstrap] dashboard:    http://localhost:5173/requirements/$REQ_ID"
echo "[bootstrap] gates:        http://localhost:5173/gates"
echo "[bootstrap] runs api:     curl $API/api/requirements/$REQ_ID/runs | jq"
