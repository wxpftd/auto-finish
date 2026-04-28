import { eq, asc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Db } from '../client.js';
import { artifacts, stage_executions } from '../schema.js';
import type { Artifact, NewArtifact } from '../schema.js';

export type CreateArtifactInput = Omit<
  NewArtifact,
  'id' | 'created_at' | 'content_hash' | 'size'
> & {
  id?: string;
  /**
   * Either provide a content body (we'll compute size + sha256 ourselves) OR
   * provide content_hash + size explicitly (for offsite-stored blobs).
   */
  content?: string;
  content_hash?: string;
  size?: number;
};

const INLINE_URI = 'inline://';

export function isInlineArtifact(a: Artifact): boolean {
  return a.storage_uri.startsWith(INLINE_URI);
}

export function createArtifact(db: Db, input: CreateArtifactInput): Artifact {
  let content_hash: string;
  let size: number;
  if (input.content !== undefined) {
    content_hash = sha256(input.content);
    size = Buffer.byteLength(input.content, 'utf8');
  } else if (input.content_hash !== undefined && input.size !== undefined) {
    content_hash = input.content_hash;
    size = input.size;
  } else {
    throw new Error(
      'createArtifact: must supply either content or (content_hash + size)',
    );
  }

  const row: NewArtifact = {
    stage_execution_id: input.stage_execution_id,
    path: input.path,
    type: input.type,
    schema_id: input.schema_id ?? null,
    content_hash,
    size,
    preview: input.preview ?? null,
    storage_uri: input.storage_uri,
  };
  const rows = db.insert(artifacts).values(row).returning().all();
  const inserted = rows[0];
  if (!inserted) throw new Error('createArtifact: insert returned no row');
  return inserted;
}

export function getArtifact(db: Db, id: string): Artifact | undefined {
  return db.select().from(artifacts).where(eq(artifacts.id, id)).get();
}

export function listArtifactsForStage(
  db: Db,
  stageExecutionId: string,
): Artifact[] {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.stage_execution_id, stageExecutionId))
    .orderBy(asc(artifacts.created_at))
    .all();
}

export function listArtifactsForRun(db: Db, runId: string): Artifact[] {
  return db
    .select({
      id: artifacts.id,
      stage_execution_id: artifacts.stage_execution_id,
      path: artifacts.path,
      type: artifacts.type,
      schema_id: artifacts.schema_id,
      content_hash: artifacts.content_hash,
      size: artifacts.size,
      preview: artifacts.preview,
      storage_uri: artifacts.storage_uri,
      created_at: artifacts.created_at,
    })
    .from(artifacts)
    .innerJoin(
      stage_executions,
      eq(stage_executions.id, artifacts.stage_execution_id),
    )
    .where(eq(stage_executions.run_id, runId))
    .orderBy(asc(artifacts.created_at))
    .all();
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export const ARTIFACT_INLINE_URI = INLINE_URI;
