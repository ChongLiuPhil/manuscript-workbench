import test from 'node:test';
import assert from 'node:assert/strict';
import type { RepoStatus } from '../types/workbench';
import { buildRepoSignature, resolveTargetRef, shouldReloadRepoContext } from './repoSync';

function makeStatus(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return {
    configured: true,
    cloned: true,
    repoSlug: 'example/manuscript-repo',
    repoDir: '/tmp/manuscript-workbench-repo',
    defaultBase: 'main',
    branch: 'revise/chapter-notation-alignment',
    localShort: '579d4f6',
    remoteShort: '579d4f6',
    aheadOfRemote: 0,
    inSyncWithRemote: false,
    hasLocalDraftEdits: true,
    dirtyCount: 2,
    dirtyFiles: ['M content/book/chapter-01.qmd', 'M content/en/book/chapter-01.qmd'],
    worktreeDigest: 'aaa111bbb222',
    autoMounting: false,
    autoMountError: null,
    recentCommits: [],
    branches: ['main'],
    hasCustomDashboard: false,
    dashboardPath: null,
    detectedScripts: [],
    hasToken: true,
    ...overrides,
  };
}

test('empty previous signature (after initial fetch failure) triggers reload once repo is cloned', () => {
  const status = makeStatus();
  assert.equal(shouldReloadRepoContext('', status), true);
});

test('identical signature does not trigger redundant reload', () => {
  const status = makeStatus();
  const sig = buildRepoSignature(status);
  assert.equal(shouldReloadRepoContext(sig, status), false);
});

test('content edit inside already-dirty file changes worktreeDigest and triggers reload', () => {
  const before = makeStatus({ worktreeDigest: 'aaa111bbb222' });
  const after = makeStatus({ worktreeDigest: 'ccc333ddd444' });
  const prevSig = buildRepoSignature(before);
  assert.equal(shouldReloadRepoContext(prevSig, after), true);
});

test('transition from autoMounting uncloned state to cloned state triggers reload', () => {
  const mounting = makeStatus({ cloned: false, autoMounting: true, dirtyCount: 0, dirtyFiles: [], worktreeDigest: '' });
  const mounted = makeStatus({ cloned: true, autoMounting: false });
  assert.equal(shouldReloadRepoContext('', mounting), false);
  const mountingSig = buildRepoSignature(mounting);
  assert.equal(shouldReloadRepoContext(mountingSig, mounted), true);
});

test('resolveTargetRef prefers override, then WORKING_TREE for draft edits, then feature branch', () => {
  assert.equal(resolveTargetRef({ hasLocalDraftEdits: true, branch: 'feat' }, 'main', 'HEAD'), 'HEAD');
  assert.equal(resolveTargetRef({ hasLocalDraftEdits: true, branch: 'feat' }, 'main'), 'WORKING_TREE');
  assert.equal(resolveTargetRef({ hasLocalDraftEdits: false, branch: 'feat' }, 'main'), 'feat');
  assert.equal(resolveTargetRef({ hasLocalDraftEdits: false, branch: 'main' }, 'main'), 'WORKING_TREE');
});
