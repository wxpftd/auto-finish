/**
 * The Pipeline Runner: drives a single Requirement through its configured
 * Pipeline end-to-end.
 *
 * Responsibilities:
 *  1. Load Requirement + Project + Repos + Pipeline from DB
 *  2. Create a sandbox via the project's SandboxProvider
 *  3. Inject Claude Code credentials into the sandbox
 *  4. Clone all repos and write the per-requirement manifest
 *  5. For each Stage: build claude argv → spawn → stream events → persist
 *  6. Block at gates: bus subscription racing a DB poll fallback
 *  7. After all stages: detect diffs and publish PRs
 *  8. Emit PipelineEvents to the bus throughout
 *
 * Most external interactions (sandbox, claude, git, gh) are pluggable so the
 * same code drives prod and tests with no special branches.
 *
 * Event ordering for gated stages (Fix #13, Option A)
 * --------------------------------------------------
 * For a stage that has a gate we emit `gate_required` BEFORE `stage_completed`.
 * The two outcomes diverge:
 *   - Approved: emit `gate_decided(approved)`, then `stage_completed`. Now
 *     `stage_completed` truly means "stage done, no further action".
 *   - Rejected: emit `gate_decided(rejected)`, transition the run to
 *     `awaiting_changes`, and DO NOT emit `stage_completed` (the stage did
 *     not really complete — the operator wants rework). The state machine
 *     handles either order because `reduceRunStatus` is idempotent and
 *     order-tolerant by design.
 *
 * For non-gated stages, emit order is unchanged: `stage_completed` fires as
 * soon as the agent work succeeds.
 */

import {
  projects,
  repos as reposRepo,
  pipelines as pipelinesRepo,
  requirements as requirementsRepo,
  pipeline_runs,
  stage_executions,
  gate_decisions,
  pull_requests as prsRepo,
} from '../db/index.js';
import type { StageEvent } from '../db/schema.js';
import type { PipelineEvent } from '../pipeline/index.js';
import { buildExecutionPlan } from '../pipeline/index.js';
import { buildClaudeInvocation } from '../claude/argv.js';
import { runClaudeStage } from '../claude/spawn.js';
import { injectClaudeCredentials } from '../claude/credentials.js';
import { cloneRepos, writeManifest, detectChanges } from '../multi-repo/index.js';
import { publishPullRequests } from '../pr/index.js';
import type {
  RunnerDeps,
  RunResult,
  BootstrapEnvFn,
  RunClaudeFn,
  DetectChangesFn,
  OpenPrsFn,
  InjectCredentialsFn,
} from './types.js';
import type {
  SandboxProvider,
  SandboxSession,
} from '../sandbox/interface.js';
import type { RepoSpec } from '../multi-repo/index.js';
import type { StageAgentConfig } from '@auto-finish/pipeline-schema';

const DEFAULT_MAX_TURNS = 25;

const defaultBranchName = (requirementId: string): string =>
  `auto-finish/req-${requirementId}`;

const defaultRunClaude: RunClaudeFn = (args) => runClaudeStage(args);

const defaultInjectCredentials: InjectCredentialsFn = (session) =>
  injectClaudeCredentials({ session });

const defaultDetectChanges: DetectChangesFn = (args) => detectChanges(args);

const defaultOpenPrs: OpenPrsFn = (args) =>
  publishPullRequests({
    session: args.session,
    requirementId: args.requirement.id,
    requirementTitle: args.requirement.title,
    requirementDescription: args.requirement.description,
    perRepo: args.perRepo,
    baseBranch: args.baseBranch,
    branchName: args.branchName,
  });

const defaultBootstrap: BootstrapEnvFn = async (args) => {
  const report = await cloneRepos({
    session: args.session,
    repos: args.repos,
    branchName: args.branchName,
  });
  await writeManifest({
    session: args.session,
    requirementId: args.requirementId,
    cloneReport: report,
  });
  return report;
};

interface PublishEventArgs {
  bus: RunnerDeps['bus'];
  run_id: string;
  event: PipelineEvent;
}

function publishEvent({ bus, run_id, event }: PublishEventArgs): void {
  bus.publish({
    topic: `run:${run_id}`,
    event,
    emitted_at: new Date().toISOString(),
  });
}

function asStageEvent(kind: string, payload: Record<string, unknown>): StageEvent {
  return { type: kind, ts: Date.now(), ...payload };
}

/**
 * Wait for a gate decision to be recorded.
 *
 * Two signals race:
 *  - bus subscription on `run:${run_id}` filtered for a `gate_decided` event
 *    matching our current stage. This is the "instant" path — when the HTTP
 *    gate route publishes through the same bus, we wake up in microseconds.
 *  - DB poll loop (kept as fallback in case the bus isn't connected to the
 *    publisher, e.g. multi-process deployments or tests that bypass the API).
 *
 * Whichever fires first wins; the other is unsubscribed/cancelled.
 *
 * IMPORTANT: we subscribe to the bus BEFORE the first DB read to avoid a
 * TOCTOU window where a decision recorded between read-and-subscribe would
 * be lost. After subscribing, an immediate DB read covers the case where the
 * decision was already there before we got here.
 */
async function waitForGateDecision(
  deps: Pick<RunnerDeps, 'db' | 'bus' | 'gatePollIntervalMs' | 'signal'>,
  args: { runId: string; stageName: string; stageExecutionId: string },
): Promise<{ decision: 'approved' | 'rejected'; feedback?: string }> {
  const interval = deps.gatePollIntervalMs ?? 1000;
  const deadline = Date.now() + 24 * 60 * 60 * 1000;

  // Subscribe FIRST so we can't miss a decision that lands during setup.
  let busResolve:
    | ((value: { decision: 'approved' | 'rejected'; feedback?: string }) => void)
    | null = null;
  const busPromise = new Promise<{
    decision: 'approved' | 'rejected';
    feedback?: string;
  }>((resolve) => {
    busResolve = resolve;
  });
  const unsub = deps.bus.subscribe(`run:${args.runId}`, (msg) => {
    const e = msg.event;
    if (
      e.kind === 'gate_decided' &&
      e.stage_name === args.stageName &&
      busResolve !== null
    ) {
      const r = busResolve;
      busResolve = null;
      r({
        decision: e.decision,
        ...(e.feedback !== undefined ? { feedback: e.feedback } : {}),
      });
    }
  });

  // Now check the DB once — covers a decision that was already recorded
  // before we subscribed (e.g. on resumption after a crash).
  const existing = gate_decisions.getDecision(deps.db, args.stageExecutionId);
  if (existing !== undefined) {
    unsub();
    const decisionStr =
      existing.decision === 'approved' ? 'approved' : 'rejected';
    return {
      decision: decisionStr,
      ...(existing.feedback !== null ? { feedback: existing.feedback } : {}),
    };
  }

  // Poll loop as a fallback. Returns null on a poll-cycle miss; the loop
  // exits as soon as either the bus path resolves or a poll hits.
  let polling = true;
  const pollPromise = (async (): Promise<{
    decision: 'approved' | 'rejected';
    feedback?: string;
  }> => {
    while (polling && Date.now() < deadline) {
      if (deps.signal?.aborted) {
        throw new Error('runner: gate wait aborted');
      }
      await sleep(interval, deps.signal);
      if (!polling) {
        // Bus already won — bail out cleanly.
        return { decision: 'approved' };
      }
      const dec = gate_decisions.getDecision(deps.db, args.stageExecutionId);
      if (dec) {
        const decisionStr =
          dec.decision === 'approved' ? 'approved' : 'rejected';
        return {
          decision: decisionStr,
          ...(dec.feedback !== null ? { feedback: dec.feedback } : {}),
        };
      }
    }
    throw new Error('runner: gate wait exceeded 24h cap');
  })();

  try {
    const winner = await Promise.race([busPromise, pollPromise]);
    return winner;
  } finally {
    polling = false;
    unsub();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const handle = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(handle);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface StageOutcome {
  status: 'completed' | 'failed';
  error?: string;
  artifacts: { path: string; type: string }[];
}

/**
 * Runs one stage end-to-end: builds the claude invocation, spawns it,
 * persists every emitted event into stage_executions.events_json, and
 * reports the final outcome.
 *
 * Side-effect: when the FIRST `session_init` event arrives, the row's
 * `claude_session_id` column is populated so dashboards / debug tooling
 * can grep for the session without scanning `events_json`.
 */
async function runOneStage(
  deps: Required<Pick<RunnerDeps, 'db' | 'bus'>> & {
    runClaude: RunClaudeFn;
  },
  args: {
    session: SandboxSession;
    runId: string;
    stageExecutionId: string;
    stageName: string;
    invocation: ReturnType<typeof buildClaudeInvocation>;
  },
): Promise<StageOutcome> {
  const events = deps.runClaude({
    session: args.session,
    invocation: args.invocation,
  });

  let outcome: StageOutcome = { status: 'completed', artifacts: [] };
  // Guard so we only lift the first session_init; a hypothetical replay /
  // multi-init does not re-write the row.
  let sessionCaptured = false;

  try {
    for await (const event of events) {
      stage_executions.appendEvent(
        deps.db,
        args.stageExecutionId,
        asStageEvent(event.kind, event as unknown as Record<string, unknown>),
      );

      if (event.kind === 'session_init' && !sessionCaptured) {
        sessionCaptured = true;
        // ClaudeStageEvent.session_init only carries session_id (plus
        // model/tools); the subprocess PID is NOT part of this stream and
        // would need a separate signal from the spawn coordinator. For now
        // we lift only the session id.
        stage_executions.setClaudeSession(deps.db, args.stageExecutionId, {
          claude_session_id: event.session_id,
        });
      }

      if (event.kind === 'failed') {
        outcome = {
          ...outcome,
          status: 'failed',
          error: event.reason,
        };
      }
      if (event.kind === 'finished' && event.exit_code !== 0) {
        outcome = {
          ...outcome,
          status: 'failed',
          error: `claude exited with code ${event.exit_code}`,
        };
      }
    }
  } catch (err) {
    outcome = {
      ...outcome,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return outcome;
}

/**
 * Drive a single Requirement through its Pipeline end-to-end.
 *
 * Returns when the run reaches a terminal or paused state. The DB carries
 * authoritative state throughout, so a crashed runner can be restarted and
 * read its position from there (full resumption logic is a future enhancement).
 */
export async function runRequirement(
  deps: RunnerDeps,
  requirementId: string,
): Promise<RunResult> {
  const { db, bus } = deps;
  const branchNameFn = deps.branchName ?? defaultBranchName;
  const runClaude = deps.runClaude ?? defaultRunClaude;
  const inject = deps.injectCredentials ?? defaultInjectCredentials;
  const bootstrap = deps.bootstrapEnv ?? defaultBootstrap;
  const detect = deps.detectChanges ?? defaultDetectChanges;
  const openPrs = deps.openPrs ?? defaultOpenPrs;

  // 1. Load aggregates --------------------------------------------------------
  const requirement = requirementsRepo.getRequirement(db, requirementId);
  if (!requirement) {
    throw new Error(`runner: requirement not found: ${requirementId}`);
  }
  const project = projects.getProject(db, requirement.project_id);
  if (!project) {
    throw new Error(`runner: project not found: ${requirement.project_id}`);
  }
  const repoRows = reposRepo.listReposForProject(db, project.id);
  if (repoRows.length === 0) {
    throw new Error(`runner: project has no repos: ${project.id}`);
  }
  const pipelineRow = pipelinesRepo.getPipeline(db, requirement.pipeline_id);
  if (!pipelineRow) {
    throw new Error(`runner: pipeline not found: ${requirement.pipeline_id}`);
  }

  const plan = buildExecutionPlan(pipelineRow.definition_json);
  const branchName = branchNameFn(requirement.id);
  const repoSpecs: RepoSpec[] = repoRows.map((r) => ({
    id: r.id,
    name: r.name,
    git_url: r.git_url,
    default_branch: r.default_branch,
    working_dir: r.working_dir,
  }));
  const perRepoBranches = Object.fromEntries(
    repoRows.map((r) => [r.id, branchName]),
  );

  // 2. Create sandbox + run row ---------------------------------------------
  let provider: SandboxProvider | null = null;
  let session: SandboxSession | null = null;
  let runId = '';

  try {
    provider = deps.makeSandboxProvider(project.sandbox_config_json);
    session = await provider.create({
      env: project.sandbox_config_json.env,
      image: project.sandbox_config_json.image,
      setup_commands: project.sandbox_config_json.setup_commands,
    });

    const run = pipeline_runs.createRun(db, {
      requirement_id: requirement.id,
      pipeline_snapshot_json: pipelineRow.definition_json,
      sandbox_session_id: session.id,
      per_repo_branches_json: perRepoBranches,
    });
    runId = run.id;

    publishEvent({
      bus,
      run_id: run.id,
      event: {
        kind: 'run_started',
        run_id: run.id,
        requirement_id: requirement.id,
        at: new Date().toISOString(),
      },
    });
    requirementsRepo.updateRequirementStatus(db, requirement.id, 'running');

    // 3. Inject credentials, clone repos, write manifest ---------------------
    await inject(session);
    const cloneReport = await bootstrap({
      session,
      repos: repoSpecs,
      branchName,
      requirementId: requirement.id,
    });
    if (cloneReport.failed.length > 0) {
      throw new Error(
        `runner: clone failed: ${cloneReport.failed
          .map((f) => `${f.repo_id}: ${f.error}`)
          .join('; ')}`,
      );
    }

    // 4. Run each stage -------------------------------------------------------
    for (const stage of plan.stages) {
      // Persist a row up front so events can be appended.
      const stageExec = stage_executions.createStageExecution(db, {
        run_id: run.id,
        stage_name: stage.name,
        status: 'running',
      });

      requirementsRepo.updateRequirementStatus(
        db,
        requirement.id,
        'running',
        stageExec.id,
      );
      const startedAt = new Date().toISOString();
      publishEvent({
        bus,
        run_id: run.id,
        event: {
          kind: 'stage_started',
          run_id: run.id,
          stage_name: stage.name,
          at: startedAt,
        },
      });

      // Apply the runner-level default max_turns when the stage didn't set
      // its own. We CLONE the agent config rather than mutating the stage's
      // pipeline snapshot — the stage's persisted definition must stay
      // unchanged so re-runs with different runner configs are reproducible.
      const stageAgentConfig: StageAgentConfig =
        stage.agent_config.max_turns === undefined
          ? {
              ...stage.agent_config,
              max_turns: deps.defaultMaxTurns ?? DEFAULT_MAX_TURNS,
            }
          : stage.agent_config;

      const invocation = buildClaudeInvocation({
        stageAgentConfig,
        prompt: `${requirement.title}\n\n${requirement.description}`,
        workingDir: '/workspace',
      });

      const stageStart = Date.now();
      const outcome = await runOneStage(
        { db, bus, runClaude },
        {
          session,
          runId: run.id,
          stageExecutionId: stageExec.id,
          stageName: stage.name,
          invocation,
        },
      );
      const durationMs = Date.now() - stageStart;

      if (outcome.status === 'failed') {
        stage_executions.finishStageExecution(db, stageExec.id, {
          status: 'failed',
        });
        publishEvent({
          bus,
          run_id: run.id,
          event: {
            kind: 'stage_failed',
            run_id: run.id,
            stage_name: stage.name,
            at: new Date().toISOString(),
            error: outcome.error ?? 'unknown error',
          },
        });

        if (stage.on_failure === 'pause') {
          requirementsRepo.updateRequirementStatus(
            db,
            requirement.id,
            'paused',
            stageExec.id,
          );
          pipeline_runs.finishRun(db, run.id);
          publishEvent({
            bus,
            run_id: run.id,
            event: {
              kind: 'run_paused',
              run_id: run.id,
              at: new Date().toISOString(),
              reason: outcome.error ?? 'stage failed',
            },
          });
          return {
            status: 'paused',
            stage_name: stage.name,
            reason: outcome.error ?? 'stage failed',
          };
        }
        // 'retry' is not yet supported — for MVP we treat it like 'abort'.
        throw new Error(
          `stage failed (${stage.on_failure}): ${stage.name}: ${outcome.error}`,
        );
      }

      // Gated stage: emit `gate_required` BEFORE `stage_completed`, then
      // wait for a decision. `stage_completed` is only emitted on the
      // approval path, so consumers grouping by `stage_completed` know the
      // stage truly finished. (See file header: Fix #13, Option A.)
      if (stage.has_gate) {
        publishEvent({
          bus,
          run_id: run.id,
          event: {
            kind: 'gate_required',
            run_id: run.id,
            stage_name: stage.name,
            review_targets: stage.gate?.review_targets ?? [],
            at: new Date().toISOString(),
          },
        });
        // Mark the row as awaiting_gate so the dashboard's `GET /pending`
        // surfaces it. We deliberately do NOT call finishStageExecution
        // here — the stage hasn't really finished yet.
        stage_executions.finishStageExecution(db, stageExec.id, {
          status: 'awaiting_gate',
        });
        requirementsRepo.updateRequirementStatus(
          db,
          requirement.id,
          'awaiting_gate',
          stageExec.id,
        );

        const decision = await waitForGateDecision(deps, {
          runId: run.id,
          stageName: stage.name,
          stageExecutionId: stageExec.id,
        });

        publishEvent({
          bus,
          run_id: run.id,
          event: {
            kind: 'gate_decided',
            run_id: run.id,
            stage_name: stage.name,
            decision: decision.decision,
            feedback: decision.feedback,
          },
        });

        if (decision.decision === 'rejected') {
          // No `stage_completed` on the rejection path — the stage didn't
          // truly complete. Row stage status reflects "agent work is done
          // but rework is needed".
          stage_executions.finishStageExecution(db, stageExec.id, {
            status: 'awaiting_changes',
          });
          requirementsRepo.updateRequirementStatus(
            db,
            requirement.id,
            'awaiting_changes',
            stageExec.id,
          );
          pipeline_runs.finishRun(db, run.id);
          return {
            status: 'awaiting_changes',
            stage_name: stage.name,
            feedback: decision.feedback,
          };
        }
        // Approved path: now the stage truly completed.
        stage_executions.finishStageExecution(db, stageExec.id, {
          status: 'completed',
        });
        publishEvent({
          bus,
          run_id: run.id,
          event: {
            kind: 'stage_completed',
            run_id: run.id,
            stage_name: stage.name,
            at: new Date().toISOString(),
            duration_ms: durationMs,
          },
        });
        requirementsRepo.updateRequirementStatus(
          db,
          requirement.id,
          'running',
          stageExec.id,
        );
      } else {
        // Non-gated stage: `stage_completed` immediately, no gate wait.
        stage_executions.finishStageExecution(db, stageExec.id, {
          status: 'completed',
        });
        publishEvent({
          bus,
          run_id: run.id,
          event: {
            kind: 'stage_completed',
            run_id: run.id,
            stage_name: stage.name,
            at: new Date().toISOString(),
            duration_ms: durationMs,
          },
        });
      }
    }

    // 5. Detect diffs + open PRs ---------------------------------------------
    const baseBranches = new Map(repoRows.map((r) => [r.id, r.default_branch]));
    const diffs = await detect({
      session,
      repos: repoSpecs,
      baseBranch: repoRows[0]?.default_branch ?? 'main',
      workingBranch: branchName,
    });

    const perRepoForPr = repoSpecs.map((repo) => {
      const diff = diffs.find((d) => d.repo_id === repo.id) ?? {
        repo_id: repo.id,
        working_dir: repo.working_dir,
        has_changes: false,
        files_changed: 0,
        insertions: 0,
        deletions: 0,
        changed_files: [],
      };
      return { repo, diff };
    });

    const publishedPrs = await openPrs({
      session,
      requirement: {
        id: requirement.id,
        title: requirement.title,
        description: requirement.description,
      },
      perRepo: perRepoForPr,
      branchName,
      baseBranch: (repo) => baseBranches.get(repo.id) ?? 'main',
    });

    for (const pr of publishedPrs) {
      prsRepo.recordPR(db, {
        run_id: run.id,
        repo_id: pr.repo_id,
        pr_url: pr.pr_url,
        pr_number: pr.pr_number,
        status: 'open',
      });
    }

    requirementsRepo.updateRequirementStatus(db, requirement.id, 'completed');
    pipeline_runs.finishRun(db, run.id);
    publishEvent({
      bus,
      run_id: run.id,
      event: {
        kind: 'run_completed',
        run_id: run.id,
        at: new Date().toISOString(),
      },
    });

    return { status: 'completed', prs: publishedPrs };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (runId) {
      requirementsRepo.updateRequirementStatus(db, requirement.id, 'failed');
      pipeline_runs.finishRun(db, runId);
      publishEvent({
        bus,
        run_id: runId,
        event: {
          kind: 'run_failed',
          run_id: runId,
          at: new Date().toISOString(),
          error,
        },
      });
    } else {
      requirementsRepo.updateRequirementStatus(db, requirement.id, 'failed');
    }
    return { status: 'failed', error };
  } finally {
    if (session) {
      try {
        await session.destroy();
      } catch {
        // sandbox teardown errors must not mask the real outcome
      }
    }
  }
}
