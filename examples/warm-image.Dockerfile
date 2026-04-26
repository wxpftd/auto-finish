# =============================================================================
# Warm image template — see decision 4 ("warm workspace strategy") in the plan.
# =============================================================================
#
# Purpose
# -------
# Pre-bake a per-project Docker image with all the project's repos cloned and
# their dependencies installed, so `auto-finish` sandboxes can boot in seconds
# instead of minutes. Used when `sandbox_config.warm_strategy = "baked_image"`.
#
# The orchestrator boots this image as the sandbox base for every Requirement.
# At sandbox startup it does a lightweight `git fetch && git checkout
# auto-finish/req-<id>` per repo — code is already there, deps are already
# installed, the only work is fast-forwarding to the per-Requirement branch.
#
# Build a warm image
# ------------------
#   # 1. Copy this file to your project root and rename if you'd like:
#   cp examples/warm-image.Dockerfile ./warm-image.Dockerfile
#
#   # 2. Edit the COPY / RUN steps below to match your project's package
#   #    managers, lock files, and pre-build commands. The default below is
#   #    a two-repo Node project (frontend + backend); strip or replicate as
#   #    needed.
#
#   # 3. Build:
#   docker build \
#     -f warm-image.Dockerfile \
#     -t auto-finish/<project-id>:warm \
#     .
#
#   # 4. (Optional) Push to the registry your sandbox runtime can reach.
#
# Build the cold-restart base image
# ---------------------------------
# `sandbox_config.base_image` is used by the Tier 2 cold-restart fallback
# (when an in-flight stage tries to mutate dependencies and trips the warm
# layer's RO/shared-volume guard). It MUST contain the same runtime as the
# warm image (same Node / Python / JDK version) but should NOT have the
# project's deps baked in — Tier 2 reinstalls fresh.
#
# Easiest path: a `--target=base` stage. We provide one below.
#
#   docker build \
#     -f warm-image.Dockerfile \
#     -t auto-finish/<project-id>:base \
#     --target=base \
#     .
#
# Refresh cadence (MVP)
# ---------------------
# Today: rebuild the warm image whenever a lock file changes (manual, or via
# CI on `package-lock.json` / `pnpm-lock.yaml` / `pyproject.toml` etc. diff).
# Phase 2 will add an automatic refresh (Tier 3, see the plan).

# -----------------------------------------------------------------------------
# Stage 1 — base: matches the runtime versions used by the project. NO deps
# installed here. This is also the image you tag as `<project-id>:base` for
# the cold-restart fallback.
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS base

# Tools the orchestrator's sandbox bootstrap needs inside the image:
#   - git: per-Requirement branch fast-forward
#   - openssh-client: SSH-style git URLs (git@github.com:org/repo.git)
#   - ca-certificates: TLS for HTTPS git, npm, pip, etc.
#   - curl: useful for the `gh` CLI install + general fetches
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      openssh-client \
      ca-certificates \
      curl \
 && rm -rf /var/lib/apt/lists/*

# `gh` CLI for the PR-creation stage. Install via the official tarball so we
# don't depend on apt-source signing keys. Pin to a known good version.
ARG GH_VERSION=2.55.0
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      -o /tmp/gh.tar.gz \
 && tar -xzf /tmp/gh.tar.gz -C /tmp \
 && mv /tmp/gh_${GH_VERSION}_linux_amd64/bin/gh /usr/local/bin/gh \
 && rm -rf /tmp/gh.tar.gz /tmp/gh_${GH_VERSION}_linux_amd64

# `claude` CLI is what each stage runs as a subprocess inside the sandbox.
# Pin to a recent release; adjust as the team upgrades.
ARG CLAUDE_VERSION=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}"

WORKDIR /workspace

# -----------------------------------------------------------------------------
# Stage 2 — warm: layer code + deps on top of `base`. EDIT THIS for your
# project's actual repos and package managers. The block below is a worked
# example for the bundled `examples/two-repo-demo` project (frontend + backend
# Node repos). Strip or duplicate the per-repo blocks to match your repos.
# -----------------------------------------------------------------------------
FROM base AS warm

# --- frontend repo ---
# Replace REPO_URL / REF with your actual values, or use a build-arg.
ARG FRONTEND_REPO_URL=https://github.com/auto-finish-examples/two-repo-frontend.git
ARG FRONTEND_REF=main
RUN git clone --depth=50 -b "${FRONTEND_REF}" "${FRONTEND_REPO_URL}" /workspace/frontend
WORKDIR /workspace/frontend
# Install deps using the lock file — `npm ci` is reproducible and fails
# clearly when package-lock.json is stale.
RUN npm ci

# --- backend repo ---
ARG BACKEND_REPO_URL=https://github.com/auto-finish-examples/two-repo-backend.git
ARG BACKEND_REF=main
RUN git clone --depth=50 -b "${BACKEND_REF}" "${BACKEND_REPO_URL}" /workspace/backend
WORKDIR /workspace/backend
RUN npm ci

# --- (optional) pre-build steps ---
# Bake any expensive build artefacts the agent shouldn't have to redo:
#   RUN npm run build
# Skip if your stages always rebuild from source.

WORKDIR /workspace

# Default entrypoint is shell — the orchestrator drives execution by spawning
# `claude` subprocesses via the sandbox `run()`/`startStream()` interface.
CMD ["/bin/bash"]
