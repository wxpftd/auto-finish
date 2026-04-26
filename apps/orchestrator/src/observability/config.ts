/**
 * Langfuse observability configuration.
 *
 * Resolves runtime config from environment variables. The orchestrator calls
 * `loadLangfuseConfig()` at startup, then hands the result to
 * `createObservabilityClient()`. Tests pass an explicit `env` map.
 *
 * Disabled by default — observability is opt-in. When `enabled: true` we
 * require `publicKey` and `secretKey`; everything else has sane defaults.
 */

/** Runtime configuration for the Langfuse client wrapper. */
export interface LangfuseConfig {
  /** Master switch. When false, the client is a no-op. */
  enabled: boolean;
  /** Langfuse public key (`pk-lf-...`). Required when `enabled`. */
  publicKey?: string;
  /** Langfuse secret key (`sk-lf-...`). Required when `enabled`. */
  secretKey?: string;
  /**
   * Langfuse server base URL. Defaults to `http://localhost:3001` to match
   * the docker-compose Langfuse service. Override for self-hosted deployments
   * or when routing through a separate LLM proxy.
   */
  baseUrl?: string;
  /**
   * Whether to set `ANTHROPIC_BASE_URL` on `claude` subprocesses (Path A).
   * Off by default because Langfuse v3 does not ship a built-in Anthropic
   * proxy — users typically point this at a LiteLLM proxy that fronts both
   * Anthropic and Langfuse.
   */
  enableProxy?: boolean;
  /**
   * Span sampling rate in `[0, 1]`. Traces are always created so run-level
   * timing is preserved; per-stage spans are sampled. Defaults to 1.
   */
  sampleRate?: number;
}

/** Default Langfuse server URL — matches the docker-compose Agent N service. */
const DEFAULT_BASE_URL = 'http://localhost:3001';

/**
 * Read environment variables and return a fully-resolved `LangfuseConfig`.
 *
 * Recognised vars:
 * - `LANGFUSE_ENABLED` — set to `'true'` to enable; anything else disables.
 * - `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` — required when enabled.
 * - `LANGFUSE_BASE_URL` — defaults to `http://localhost:3001`.
 * - `LANGFUSE_PROXY_ENABLED` — `'true'` to set `ANTHROPIC_BASE_URL` on `claude`.
 * - `LANGFUSE_SAMPLE_RATE` — float in `[0, 1]`; defaults to 1.
 *
 * @throws Error when `enabled` is true but `publicKey` or `secretKey` is missing.
 */
export function loadLangfuseConfig(
  env: Record<string, string | undefined> = process.env,
): LangfuseConfig {
  const enabled = env['LANGFUSE_ENABLED'] === 'true';

  const publicKey = env['LANGFUSE_PUBLIC_KEY'];
  const secretKey = env['LANGFUSE_SECRET_KEY'];
  const baseUrl = env['LANGFUSE_BASE_URL'] ?? DEFAULT_BASE_URL;
  const enableProxy = env['LANGFUSE_PROXY_ENABLED'] === 'true';

  const rawSampleRate = env['LANGFUSE_SAMPLE_RATE'];
  let sampleRate = 1;
  if (rawSampleRate !== undefined && rawSampleRate !== '') {
    const parsed = Number(rawSampleRate);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      throw new Error(
        `LANGFUSE_SAMPLE_RATE must be a number in [0, 1]; got '${rawSampleRate}'.`,
      );
    }
    sampleRate = parsed;
  }

  if (enabled) {
    const missing: string[] = [];
    if (publicKey === undefined || publicKey === '') {
      missing.push('LANGFUSE_PUBLIC_KEY');
    }
    if (secretKey === undefined || secretKey === '') {
      missing.push('LANGFUSE_SECRET_KEY');
    }
    if (missing.length > 0) {
      throw new Error(
        `Langfuse is enabled (LANGFUSE_ENABLED=true) but required env vars are missing: ${missing.join(
          ', ',
        )}.`,
      );
    }
  }

  const config: LangfuseConfig = {
    enabled,
    baseUrl,
    enableProxy,
    sampleRate,
  };
  if (publicKey !== undefined && publicKey !== '') {
    config.publicKey = publicKey;
  }
  if (secretKey !== undefined && secretKey !== '') {
    config.secretKey = secretKey;
  }
  return config;
}
