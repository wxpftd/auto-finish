/**
 * Process entry point for the orchestrator.
 *
 * All wiring (DB, Hono app, http+ws server) lives in `wire/server.ts`; this
 * file is just the CLI shim that reads env vars, starts the server, and
 * arranges graceful shutdown on SIGINT / SIGTERM.
 */

import { startServer } from './wire/server.js';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return n;
}

function envString(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.length > 0 ? v : fallback;
}

async function main(): Promise<void> {
  const handle = await startServer({
    port: envInt('PORT', 3000),
    dbPath: envString('DB_PATH', './auto-finish.sqlite'),
  });
  console.log(`auto-finish orchestrator listening at ${handle.url}`);

  const shutdown = (): void => {
    handle
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error('[orchestrator] shutdown error:', err);
        process.exit(1);
      });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('[orchestrator] fatal:', err);
  process.exit(1);
});
