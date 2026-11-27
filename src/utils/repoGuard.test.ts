import assert from 'node:assert/strict';
import test from 'node:test';
import { canSafelyDeleteOrRecloneRepo, canSafelyFastForwardBase } from './repoGuard.ts';

test('canSafelyDeleteOrRecloneRepo blocks when uncommitted edits exist', () => {
  const res = canSafelyDeleteOrRecloneRepo({
    hasRepo: true,
    dirtyCount: 3,
    aheadOfRemote: 0,
    currentBranch: 'main',
    defaultBase: 'main',
  });
  assert.equal(res.allowed, false);
  assert.match(res.reason || '', /未提交本地修改/);
});

test('canSafelyDeleteOrRecloneRepo blocks when unpushed commits exist', () => {
  const res = canSafelyDeleteOrRecloneRepo({
    hasRepo: true,
    dirtyCount: 0,
    aheadOfRemote: 2,
    currentBranch: 'main',
    defaultBase: 'main',
  });
  assert.equal(res.allowed, false);
  assert.match(res.reason || '', /未推送本地提交/);
});

test('canSafelyDeleteOrRecloneRepo blocks when on a revision feature branch', () => {
  const res = canSafelyDeleteOrRecloneRepo({
    hasRepo: true,
    dirtyCount: 0,
    aheadOfRemote: 0,
    currentBranch: 'revise/chapter-1-notation-upgrade',
    defaultBase: 'main',
  });
  assert.equal(res.allowed, false);
  assert.match(res.reason || '', /修订分支/);
});

test('canSafelyDeleteOrRecloneRepo allows when clean and synced on base branch', () => {
  const res = canSafelyDeleteOrRecloneRepo({
    hasRepo: true,
    dirtyCount: 0,
    aheadOfRemote: 0,
    currentBranch: 'main',
    defaultBase: 'main',
  });
  assert.equal(res.allowed, true);
});

test('canSafelyFastForwardBase blocks on feature branch or dirty tree even if clean', () => {
  assert.equal(
    canSafelyFastForwardBase({
      dirtyCount: 0,
      aheadOfRemote: 0,
      currentBranch: 'revise/chapter-1-notation-upgrade',
      defaultBase: 'main',
    }).allowed,
    false
  );
  assert.equal(
    canSafelyFastForwardBase({
      dirtyCount: 1,
      aheadOfRemote: 0,
      currentBranch: 'main',
      defaultBase: 'main',
    }).allowed,
    false
  );
  assert.equal(
    canSafelyFastForwardBase({
      dirtyCount: 0,
      aheadOfRemote: 1,
      currentBranch: 'main',
      defaultBase: 'main',
    }).allowed,
    false
  );
  assert.equal(
    canSafelyFastForwardBase({
      dirtyCount: 0,
      aheadOfRemote: 0,
      currentBranch: 'main',
      defaultBase: 'main',
    }).allowed,
    true
  );
});
