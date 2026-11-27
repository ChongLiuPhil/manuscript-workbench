import type { RepoStatus } from '../types/workbench';

/**
 * Compute a stable signature of the mounted repository state, including
 * `worktreeDigest` so further edits to already-modified files still trigger
 * a live diff refresh.
 */
export function buildRepoSignature(d: RepoStatus): string {
  return [
    d.cloned ? '1' : '0',
    d.autoMounting ? '1' : '0',
    d.repoSlug || '',
    d.branch || '',
    d.localShort || '',
    String(d.dirtyCount || 0),
    (d.dirtyFiles || []).join(','),
    d.worktreeDigest || '',
  ].join('|');
}

/**
 * Determine whether the frontend should (re)load diff/volume/file payloads
 * given the previously observed signature and the latest `/api/repo-status`.
 * Crucially handles the empty-signature case (`prevSig === ''`) so recovery
 * after a transient initial fetch failure or background auto-clone always loads.
 */
export function shouldReloadRepoContext(prevSig: string, nextStatus: RepoStatus): boolean {
  if (!nextStatus.cloned) return false;
  const nextSig = buildRepoSignature(nextStatus);
  return !prevSig || nextSig !== prevSig;
}

/**
 * Pick the default comparison target ref for a mounted repository.
 */
export function resolveTargetRef(
  status: Pick<RepoStatus, 'hasLocalDraftEdits' | 'branch'>,
  nextBase: string,
  overrideTarget?: string
): string {
  if (overrideTarget) return overrideTarget;
  if (status.hasLocalDraftEdits) return 'WORKING_TREE';
  if (status.branch && status.branch !== nextBase) return status.branch;
  return 'WORKING_TREE';
}
