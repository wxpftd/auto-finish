/**
 * In-memory fixtures used by the dashboard's MockApi (Storybook /
 * `?mock=1` designer mode / unit tests). The shapes here mirror
 * `apps/orchestrator/src/db/schema.ts`; see `types.ts` for the row contracts.
 */

import type {
  Artifact,
  Pipeline,
  PipelineRun,
  Project,
  PullRequest,
  Repo,
  Requirement,
  StageExecution,
} from './types.js';

// Fixtures recompute each module load so relative timestamps in the UI
// look current rather than two years stale.
const now = Date.now();

export const mockPipeline: Pipeline = {
  id: 'pipeline-default',
  name: 'Default 4-stage pipeline',
  version: '1.0.0',
  stages: [
    {
      name: 'requirement-analysis',
      agent_config: {
        system_prompt: 'Translate the user request into a PRD.',
        allowed_tools: ['Read', 'Write'],
      },
      artifacts: [
        { path: '.auto-finish/artifacts/requirement-analysis/prd.md', type: 'markdown', required: true },
      ],
      on_failure: 'pause',
    },
    {
      name: 'design',
      agent_config: {
        system_prompt: 'Produce a cross-repo design document.',
        allowed_tools: ['Read', 'Write'],
      },
      artifacts: [
        { path: '.auto-finish/artifacts/design/design.md', type: 'markdown', required: true },
      ],
      gate: { required: true, review_targets: ['.auto-finish/artifacts/design/design.md'] },
      on_failure: 'pause',
    },
    {
      name: 'implementation',
      agent_config: {
        system_prompt: 'Implement the changes per the approved design.',
        allowed_tools: ['Read', 'Write', 'Edit', 'Bash(npm test:*)'],
      },
      artifacts: [
        { path: '.auto-finish/artifacts/implementation/diff.patch', type: 'diff', required: true },
      ],
      on_failure: 'pause',
    },
    {
      name: 'verification',
      agent_config: {
        system_prompt: 'Run per-repo tests and aggregate results.',
        allowed_tools: ['Bash(npm test:*)', 'Read'],
      },
      artifacts: [
        { path: '.auto-finish/artifacts/verification/test-report.md', type: 'markdown', required: true },
      ],
      gate: { required: true, review_targets: ['.auto-finish/artifacts/verification/test-report.md'] },
      on_failure: 'pause',
    },
  ],
};

export const mockProjects: Project[] = [
  {
    id: 'proj-web-stack',
    name: 'Web Stack',
    description: 'Frontend (SvelteKit) + Backend (Hono) reference project.',
    default_pipeline_id: mockPipeline.id,
    sandbox_config_json: {
      provider: 'opensandbox',
      image: 'auto-finish/base:latest',
      warm_strategy: 'cold_only',
    },
    claude_config_json: { credentials_source: 'host_mount' },
    created_at: now - 86_400_000 * 7,
    updated_at: now - 86_400_000,
  },
];

export const mockRepos: Repo[] = [
  {
    id: 'repo-frontend',
    project_id: 'proj-web-stack',
    name: 'frontend',
    git_url: 'git@github.com:example/frontend.git',
    default_branch: 'main',
    working_dir: '/workspace/frontend',
    test_command: 'npm test',
    pr_template: null,
    created_at: now - 86_400_000 * 7,
  },
  {
    id: 'repo-backend',
    project_id: 'proj-web-stack',
    name: 'backend',
    git_url: 'git@github.com:example/backend.git',
    default_branch: 'main',
    working_dir: '/workspace/backend',
    test_command: 'pytest',
    pr_template: null,
    created_at: now - 86_400_000 * 7,
  },
];

export const mockRequirements: Requirement[] = [
  {
    id: 'req-001',
    project_id: 'proj-web-stack',
    pipeline_id: mockPipeline.id,
    title: 'Add /health endpoint and frontend status indicator',
    description:
      'Backend exposes GET /health returning {status:"ok"}. Frontend renders a green/red dot in the navbar based on this endpoint.',
    source: 'manual',
    source_ref: null,
    status: 'awaiting_gate',
    current_stage_id: 'design',
    created_at: now - 3_600_000 * 6,
    updated_at: now - 3_600_000,
  },
  {
    id: 'req-002',
    project_id: 'proj-web-stack',
    pipeline_id: mockPipeline.id,
    title: 'Dark mode toggle in user settings',
    description:
      'Persist user dark-mode preference in backend, surface a toggle in the frontend settings page.',
    source: 'manual',
    source_ref: null,
    status: 'running',
    current_stage_id: 'implementation',
    created_at: now - 3_600_000 * 3,
    updated_at: now - 60_000 * 5,
  },
  {
    id: 'req-003',
    project_id: 'proj-web-stack',
    pipeline_id: mockPipeline.id,
    title: 'Rate-limit signup endpoint',
    description:
      'Add a 5-req/min rate limit to POST /signup; show a friendly retry message in the UI.',
    source: 'github',
    source_ref: 'example/backend#42',
    status: 'awaiting_changes',
    current_stage_id: 'verification',
    created_at: now - 86_400_000 * 2,
    updated_at: now - 3_600_000 * 2,
  },
];

const stageExecutionsForReq001: StageExecution[] = [
  {
    id: 'se-001-1',
    run_id: 'run-001',
    stage_name: 'requirement-analysis',
    status: 'succeeded',
    claude_subprocess_pid: null,
    claude_session_id: null,
    started_at: now - 3_600_000 * 6,
    finished_at: now - 3_600_000 * 5,
    events_json: [],
  },
  {
    id: 'se-001-2',
    run_id: 'run-001',
    stage_name: 'design',
    status: 'awaiting_gate',
    claude_subprocess_pid: null,
    claude_session_id: null,
    started_at: now - 3_600_000 * 5,
    finished_at: now - 3_600_000 * 4,
    events_json: [],
  },
  {
    id: 'se-001-3',
    run_id: 'run-001',
    stage_name: 'implementation',
    status: 'pending',
    claude_subprocess_pid: null,
    claude_session_id: null,
    started_at: 0,
    finished_at: null,
    events_json: [],
  },
  {
    id: 'se-001-4',
    run_id: 'run-001',
    stage_name: 'verification',
    status: 'pending',
    claude_subprocess_pid: null,
    claude_session_id: null,
    started_at: 0,
    finished_at: null,
    events_json: [],
  },
];

const stageExecutionsForReq002: StageExecution[] = [
  {
    id: 'se-002-1',
    run_id: 'run-002',
    stage_name: 'requirement-analysis',
    status: 'succeeded',
    claude_subprocess_pid: null,
    claude_session_id: null,
    started_at: now - 3_600_000 * 3,
    finished_at: now - 3_600_000 * 2.5,
    events_json: [],
  },
  {
    id: 'se-002-2',
    run_id: 'run-002',
    stage_name: 'design',
    status: 'succeeded',
    claude_subprocess_pid: null,
    claude_session_id: null,
    started_at: now - 3_600_000 * 2.5,
    finished_at: now - 3_600_000 * 2,
    events_json: [],
  },
  {
    id: 'se-002-3',
    run_id: 'run-002',
    stage_name: 'implementation',
    status: 'running',
    claude_subprocess_pid: null,
    claude_session_id: null,
    started_at: now - 60_000 * 30,
    finished_at: null,
    events_json: [],
  },
  {
    id: 'se-002-4',
    run_id: 'run-002',
    stage_name: 'verification',
    status: 'pending',
    claude_subprocess_pid: null,
    claude_session_id: null,
    started_at: 0,
    finished_at: null,
    events_json: [],
  },
];

const stageExecutionsForReq003: StageExecution[] = [
  {
    id: 'se-003-1',
    run_id: 'run-003',
    stage_name: 'requirement-analysis',
    status: 'succeeded',
    claude_subprocess_pid: null,
    claude_session_id: null,
    started_at: now - 86_400_000 * 2,
    finished_at: now - 86_400_000 * 2 + 1_800_000,
    events_json: [],
  },
  {
    id: 'se-003-2',
    run_id: 'run-003',
    stage_name: 'design',
    status: 'succeeded',
    claude_subprocess_pid: null,
    claude_session_id: null,
    started_at: now - 86_400_000 * 2 + 1_800_000,
    finished_at: now - 86_400_000 * 2 + 3_600_000,
    events_json: [],
  },
  {
    id: 'se-003-3',
    run_id: 'run-003',
    stage_name: 'implementation',
    status: 'succeeded',
    claude_subprocess_pid: null,
    claude_session_id: null,
    started_at: now - 86_400_000 * 2 + 3_600_000,
    finished_at: now - 86_400_000,
    events_json: [],
  },
  {
    id: 'se-003-4',
    run_id: 'run-003',
    stage_name: 'verification',
    status: 'awaiting_gate',
    claude_subprocess_pid: null,
    claude_session_id: null,
    started_at: now - 86_400_000,
    finished_at: now - 3_600_000 * 2,
    events_json: [],
  },
];

export const mockRuns: PipelineRun[] = [
  {
    id: 'run-001',
    requirement_id: 'req-001',
    pipeline_snapshot_json: mockPipeline,
    sandbox_session_id: 'sandbox-aaa',
    per_repo_branches_json: {
      'repo-frontend': 'auto-finish/req-001',
      'repo-backend': 'auto-finish/req-001',
    },
    per_repo_branches: {
      'repo-frontend': 'auto-finish/req-001',
      'repo-backend': 'auto-finish/req-001',
    },
    started_at: now - 3_600_000 * 6,
    finished_at: null,
    stage_executions: stageExecutionsForReq001,
  },
  {
    id: 'run-002',
    requirement_id: 'req-002',
    pipeline_snapshot_json: mockPipeline,
    sandbox_session_id: 'sandbox-bbb',
    per_repo_branches_json: {
      'repo-frontend': 'auto-finish/req-002',
      'repo-backend': 'auto-finish/req-002',
    },
    per_repo_branches: {
      'repo-frontend': 'auto-finish/req-002',
      'repo-backend': 'auto-finish/req-002',
    },
    started_at: now - 3_600_000 * 3,
    finished_at: null,
    stage_executions: stageExecutionsForReq002,
  },
  {
    id: 'run-003',
    requirement_id: 'req-003',
    pipeline_snapshot_json: mockPipeline,
    sandbox_session_id: 'sandbox-ccc',
    per_repo_branches_json: {
      'repo-backend': 'auto-finish/req-003',
    },
    per_repo_branches: {
      'repo-backend': 'auto-finish/req-003',
    },
    started_at: now - 86_400_000 * 2,
    finished_at: null,
    stage_executions: stageExecutionsForReq003,
  },
];

export const mockArtifacts: Artifact[] = [
  {
    id: 'art-001-design',
    stage_execution_id: 'se-001-2',
    path: '.auto-finish/artifacts/design/design.md',
    type: 'markdown',
    schema_id: null,
    content_hash: 'sha256:fixture-design',
    size: 312,
    preview:
      '# Design: /health endpoint\n\n- backend: add Hono route GET /health\n- frontend: add HealthDot in nav, polls /api/health every 10s\n',
    storage_uri: 'file://fixture/design.md',
    created_at: now - 3_600_000 * 4,
  },
  {
    id: 'art-003-tests',
    stage_execution_id: 'se-003-4',
    path: '.auto-finish/artifacts/verification/test-report.md',
    type: 'markdown',
    schema_id: null,
    content_hash: 'sha256:fixture-tests',
    size: 248,
    preview:
      '# Test Report\n\n- backend: 12/12 passed\n- frontend: 18/19 passed (1 flake)\n',
    storage_uri: 'file://fixture/test-report.md',
    created_at: now - 3_600_000 * 2,
  },
];

/** Pending-gate stage executions used by the gates page in mock mode. */
export const mockGateExecutions: StageExecution[] = [
  // Pull design + verification stages that the mock requirements are awaiting.
  ...stageExecutionsForReq001.filter((s) => s.status === 'awaiting_gate'),
  ...stageExecutionsForReq003.filter((s) => s.status === 'awaiting_gate'),
];

export const mockPullRequests: PullRequest[] = [
  {
    id: 'pr-003-frontend',
    run_id: 'run-003',
    repo_id: 'repo-frontend',
    pr_url: 'https://github.com/example/frontend/pull/87',
    pr_number: 87,
    status: 'changes_requested',
    created_at: now - 86_400_000,
    updated_at: now - 3_600_000 * 2,
  },
  {
    id: 'pr-003-backend',
    run_id: 'run-003',
    repo_id: 'repo-backend',
    pr_url: 'https://github.com/example/backend/pull/45',
    pr_number: 45,
    status: 'open',
    created_at: now - 86_400_000,
    updated_at: now - 3_600_000 * 2,
  },
];
