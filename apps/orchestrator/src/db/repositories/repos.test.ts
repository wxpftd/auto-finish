import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, runMigrations } from '../client.js';
import type { Db } from '../client.js';
import * as repos from './repos.js';
import { seedProject } from '../__fixtures__/seed.js';

let db: Db;

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  db = handle.db;
});

describe('repos repository', () => {
  it('adds a repo for a project and lists it', () => {
    const project = seedProject(db);
    const repo = repos.addRepo(db, {
      project_id: project.id,
      name: 'frontend',
      git_url: 'git@example.com:frontend.git',
      default_branch: 'main',
      working_dir: '/workspace/frontend',
      test_command: 'npm test',
      pr_template: null,
    });
    expect(repo.id).toBeTruthy();

    const list = repos.listReposForProject(db, project.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('frontend');
  });

  it('listReposForProject is empty for a project with no repos', () => {
    const project = seedProject(db);
    expect(repos.listReposForProject(db, project.id)).toHaveLength(0);
  });

  it('rejects duplicate (project_id, name)', () => {
    const project = seedProject(db);
    repos.addRepo(db, {
      project_id: project.id,
      name: 'frontend',
      git_url: 'git@example.com:frontend.git',
      default_branch: 'main',
      working_dir: '/workspace/frontend',
      test_command: null,
      pr_template: null,
    });
    expect(() =>
      repos.addRepo(db, {
        project_id: project.id,
        name: 'frontend',
        git_url: 'git@example.com:other.git',
        default_branch: 'main',
        working_dir: '/workspace/frontend2',
        test_command: null,
        pr_template: null,
      }),
    ).toThrow();
  });
});
