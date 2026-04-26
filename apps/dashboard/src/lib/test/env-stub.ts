/**
 * Stub for `$env/dynamic/public` and `$env/static/public` used only inside
 * vitest. SvelteKit's virtual modules aren't materialised when running plain
 * vitest (no SvelteKit Vite plugin in that pipeline), so we redirect those
 * imports here.
 *
 * Tests should not depend on real env vars. When a test wants a specific
 * value, override it via the constructor argument (`new HttpApi({ baseUrl })`)
 * or via `vi.stubGlobal`.
 */
export const env: Record<string, string | undefined> = {};
export const PUBLIC_API_BASE_URL: string | undefined = undefined;
export const PUBLIC_WS_BASE_URL: string | undefined = undefined;
