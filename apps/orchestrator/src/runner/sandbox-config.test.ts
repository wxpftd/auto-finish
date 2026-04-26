/**
 * Unit tests for the runner's two `*SandboxConfig` helpers — the bridge
 * between project-schema's `SandboxConfig` (with warm-strategy fields) and
 * the lower-level `SandboxConfig` consumed by `SandboxProvider.create`.
 *
 *   - `buildSandboxCreateConfig`  — happy-path warm boot
 *   - `buildColdSandboxConfig`    — Tier 2 cold-restart path
 *
 * The helpers are private to the runner module, exported solely for these
 * tests. Each branch of the `warm_strategy` switch is exercised below;
 * regressions in volume wiring or image selection would surface here.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSandboxCreateConfig,
  buildColdSandboxConfig,
} from './runner.js';
import type { SandboxConfig as ProjectSandboxConfig } from '@auto-finish/project-schema';

const baseProjectCfg: ProjectSandboxConfig = {
  provider: 'opensandbox',
  warm_strategy: 'cold_only',
  // Phase 1.6 decision 3: the schema's default for warm_volume_backend is
  // 'host', and zod's `.default()` widens the inferred type so the field is
  // required at the type level. We always include it here so each test can
  // override only the field it cares about.
  warm_volume_backend: 'host',
};

describe('buildSandboxCreateConfig', () => {
  it('cold_only: passes image and env through unchanged', () => {
    const result = buildSandboxCreateConfig({
      ...baseProjectCfg,
      warm_strategy: 'cold_only',
      image: 'node:20',
      env: { NODE_ENV: 'production' },
      setup_commands: ['npm ci'],
    });
    expect(result).toEqual({
      image: 'node:20',
      env: { NODE_ENV: 'production' },
      setup_commands: ['npm ci'],
    });
    expect(result.volumes).toBeUndefined();
  });

  it('cold_only: omits image when not set (provider default kicks in)', () => {
    const result = buildSandboxCreateConfig({
      ...baseProjectCfg,
      warm_strategy: 'cold_only',
    });
    expect(result.image).toBeUndefined();
    expect(result.volumes).toBeUndefined();
  });

  it('baked_image: selects warm_image and ignores image', () => {
    const result = buildSandboxCreateConfig({
      ...baseProjectCfg,
      warm_strategy: 'baked_image',
      warm_image: 'auto-finish/proj:warm',
      base_image: 'auto-finish/proj:base',
      image: 'node:20', // should NOT win
    });
    expect(result.image).toBe('auto-finish/proj:warm');
    expect(result.volumes).toBeUndefined();
  });

  it('shared_volume: emits a single read-only VolumeBinding from claim+mount_path (default host backend)', () => {
    const result = buildSandboxCreateConfig({
      ...baseProjectCfg,
      warm_strategy: 'shared_volume',
      warm_volume_claim: 'proj-deps',
      warm_mount_path: '/workspace/.deps',
      image: 'node:20',
    });
    expect(result.image).toBe('node:20');
    expect(result.volumes).toEqual([
      {
        name: 'proj-deps',
        mountPath: '/workspace/.deps',
        readOnly: true,
        backend: { kind: 'host' },
      },
    ]);
  });

  it('shared_volume backend=host: VolumeBinding.backend.kind === "host"', () => {
    const result = buildSandboxCreateConfig({
      ...baseProjectCfg,
      warm_strategy: 'shared_volume',
      warm_volume_claim: 'proj-deps',
      warm_mount_path: '/workspace/.deps',
      warm_volume_backend: 'host',
    });
    expect(result.volumes).toBeDefined();
    expect(result.volumes![0]!.backend).toEqual({ kind: 'host' });
  });

  it('shared_volume backend=pvc: VolumeBinding.backend.kind === "pvc" with claimName from warm_volume_claim', () => {
    const result = buildSandboxCreateConfig({
      ...baseProjectCfg,
      warm_strategy: 'shared_volume',
      warm_volume_claim: 'proj-deps',
      warm_mount_path: '/workspace/.deps',
      warm_volume_backend: 'pvc',
    });
    expect(result.volumes).toBeDefined();
    expect(result.volumes![0]!.backend).toEqual({
      kind: 'pvc',
      claimName: 'proj-deps',
    });
    // The top-level VolumeBinding.name still mirrors warm_volume_claim so
    // legacy code paths (in-memory provider, tests) still see a name.
    expect(result.volumes![0]!.name).toBe('proj-deps');
  });

  it('shared_volume backend=ossfs: throws "not yet implemented"', () => {
    expect(() =>
      buildSandboxCreateConfig({
        ...baseProjectCfg,
        warm_strategy: 'shared_volume',
        warm_volume_claim: 'proj-bucket',
        warm_mount_path: '/workspace/.deps',
        warm_volume_backend: 'ossfs',
      }),
    ).toThrow(/ossfs.*not yet implemented/);
  });
});

describe('buildColdSandboxConfig', () => {
  it('cold_only: same as buildSandboxCreateConfig (cold-restart is a fresh boot)', () => {
    const cfg: ProjectSandboxConfig = {
      ...baseProjectCfg,
      warm_strategy: 'cold_only',
      image: 'node:20',
    };
    expect(buildColdSandboxConfig(cfg)).toEqual(buildSandboxCreateConfig(cfg));
  });

  it('baked_image: uses base_image, NOT warm_image', () => {
    const result = buildColdSandboxConfig({
      ...baseProjectCfg,
      warm_strategy: 'baked_image',
      warm_image: 'auto-finish/proj:warm',
      base_image: 'auto-finish/proj:base',
    });
    expect(result.image).toBe('auto-finish/proj:base');
    expect(result.volumes).toBeUndefined();
  });

  it('baked_image: throws if base_image is missing', () => {
    expect(() =>
      buildColdSandboxConfig({
        ...baseProjectCfg,
        warm_strategy: 'baked_image',
        warm_image: 'auto-finish/proj:warm',
        // base_image deliberately omitted
      }),
    ).toThrow(/base_image/);
  });

  it('shared_volume: drops volumes so deps install can write fresh', () => {
    const result = buildColdSandboxConfig({
      ...baseProjectCfg,
      warm_strategy: 'shared_volume',
      warm_volume_claim: 'proj-deps',
      warm_mount_path: '/workspace/.deps',
      image: 'node:20',
    });
    expect(result.image).toBe('node:20');
    expect(result.volumes).toBeUndefined();
  });

  it('shared_volume + backend=pvc: still drops volumes on cold-restart (regression)', () => {
    // Cold-restart must escape the warm volume regardless of which OSEP-0003
    // backend was selected; the warm cache is precisely what it's escaping.
    const result = buildColdSandboxConfig({
      ...baseProjectCfg,
      warm_strategy: 'shared_volume',
      warm_volume_claim: 'proj-deps',
      warm_mount_path: '/workspace/.deps',
      warm_volume_backend: 'pvc',
      image: 'node:20',
    });
    expect(result.volumes).toBeUndefined();
  });
});
