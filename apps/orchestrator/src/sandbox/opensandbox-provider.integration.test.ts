/**
 * Integration tests for OpenSandboxProvider.
 *
 * These exercise the full SandboxProvider contract against a *real*
 * OpenSandbox sandbox-server (the FastAPI service on port 8080 brought up
 * by `docker compose up -d opensandbox-server`). They are skipped by
 * default so `pnpm test` on a dev machine doesn't need any OpenSandbox
 * service running.
 *
 * To run:
 *
 *   docker compose up -d opensandbox-server     # start the service
 *   curl http://localhost:8080/healthz          # sanity check
 *
 *   OPENSANDBOX_INTEGRATION=1 \
 *   pnpm test src/sandbox/opensandbox-provider.integration.test.ts
 *
 * Optional env overrides:
 *   - OPENSANDBOX_ENDPOINT   override the sandbox-server URL (default
 *                            http://localhost:8080)
 *   - OPENSANDBOX_API_KEY    bearer token if the server requires auth
 *
 * The contract test creates and destroys multiple sandboxes per case;
 * expect a multi-minute run on first invocation while the base image
 * (`ubuntu:24.04`) is pulled.
 */

import { describe, vi } from 'vitest';
import { runProviderContract } from './contract.js';
import { OpenSandboxProvider } from './opensandbox-provider.js';

const RUN_INTEGRATION = process.env['OPENSANDBOX_INTEGRATION'] === '1';

describe.skipIf(!RUN_INTEGRATION)('OpenSandboxProvider [integration]', () => {
  // Each contract test creates a real Docker container via the
  // sandbox-server. Even with images cached, a single create+ready-poll
  // is 1-3s and several tests do create+destroy twice; the first invocation
  // of all also pays the ubuntu:24.04 pull (file header warns multi-minute).
  // Vitest's 5s default timeout fires before the SDK can finish a single
  // lifecycle, so override here. Only affects this integration suite —
  // InMemoryProvider's contract run keeps the strict default.
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  runProviderContract('OpenSandboxProvider', () => new OpenSandboxProvider());
});
