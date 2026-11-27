export interface RepoProtectionInput {
  hasRepo: boolean;
  dirtyCount: number;
  aheadOfRemote: number;
  currentBranch: string;
  defaultBase: string;
}

export interface GuardDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Prevents any automatic or accidental deletion/re-cloning of the local target repository
 * whenever uncommitted edits, unpushed local commits, or an active non-base revision branch exist.
 */
export function canSafelyDeleteOrRecloneRepo(input: RepoProtectionInput): GuardDecision {
  if (!input.hasRepo) {
    return { allowed: true };
  }
  const reasons: string[] = [];
  if (input.dirtyCount > 0) {
    reasons.push(`存在 ${input.dirtyCount} 处未提交本地修改`);
  }
  if (input.aheadOfRemote > 0) {
    reasons.push(`存在 ${input.aheadOfRemote} 个未推送本地提交`);
  }
  if (input.currentBranch && input.defaultBase && input.currentBranch !== input.defaultBase) {
    reasons.push(`当前正位于修订分支 ${input.currentBranch}`);
  }
  if (reasons.length > 0) {
    return {
      allowed: false,
      reason: `本地防丢失保护已拦截清空或重新克隆操作（${reasons.join('；')}）。在您确认提交 PR 前，系统不会自动清理本地已修改内容。`,
    };
  }
  return { allowed: true };
}

/**
 * Prevents /api/sync-github from ever switching branches or resetting local work.
 * Remote fetch is always safe; fast-forwarding the local default base branch is ONLY allowed
 * when already on defaultBase with zero uncommitted edits and zero unpushed commits.
 */
export function canSafelyFastForwardBase(input: Omit<RepoProtectionInput, 'hasRepo'>): GuardDecision {
  if (input.dirtyCount > 0) {
    return {
      allowed: false,
      reason: '工作区存在未提交改动，已仅执行 fetch，保留本地修改。',
    };
  }
  if (input.aheadOfRemote > 0) {
    return {
      allowed: false,
      reason: '本地存在未推送提交，已仅执行 fetch，保留本地提交历史。',
    };
  }
  if (!input.currentBranch || input.currentBranch !== input.defaultBase) {
    return {
      allowed: false,
      reason: `当前位于修订分支 ${input.currentBranch || 'HEAD'}，已仅执行 fetch，不切换或覆盖本地分支。`,
    };
  }
  return { allowed: true };
}
