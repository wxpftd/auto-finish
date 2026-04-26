/**
 * Integration tests for DaytonaProvider.
 *
 * These exercise the full SandboxProvider contract against a *real*
 * Daytona instance. They are skipped by default so `pnpm test` on a dev
 * machine doesn't need any Daytona credentials.
 *
 * To run:
 *
 *   DAYTONA_INTEGRATION=1 \
 *   DAYTONA_API_URL=... \
 *   DAYTONA_API_KEY=... \
 *   pnpm test src/sandbox/daytona-provider.integration.test.ts
 *
 * The contract test creates and destroys multiple sandboxes per case;
 * expect a multi-minute run.
 */

import { describe } from 'vitest';
import { runProviderContract } from './contract.js';
import { DaytonaProvider } from './daytona-provider.js';

const RUN_INTEGRATION = process.env['DAYTONA_INTEGRATION'] === '1';

describe.skipIf(!RUN_INTEGRATION)('DaytonaProvider [integration]', () => {
  runProviderContract('DaytonaProvider', () => new DaytonaProvider());
});
