import { useState, useEffect } from 'react';
import { GitBranch, RefreshCw, ShieldCheck, X } from 'lucide-react';

interface RepoConfigModalProps {
  open: boolean;
  onClose: () => void;
  currentRepoSlug: string;
  currentBaseBranch: string;
  hasToken: boolean;
  mounting: boolean;
  errorMessage: string | null;
  onMount: (repoSlug: string, baseBranch: string) => void;
}

export function RepoConfigModal({
  open,
  onClose,
  currentRepoSlug,
  currentBaseBranch,
  hasToken,
  mounting,
  errorMessage,
  onMount,
}: RepoConfigModalProps) {
  const [slugInput, setSlugInput] = useState(currentRepoSlug);
  const [baseInput, setBaseInput] = useState(currentBaseBranch || 'main');

  useEffect(() => {
    if (open) {
      setSlugInput(currentRepoSlug);
      setBaseInput(currentBaseBranch || 'main');
    }
  }, [open, currentRepoSlug, currentBaseBranch]);

  if (!open) return null;

  const trimmedSlug = slugInput.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const validSlug = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmedSlug);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validSlug || mounting) return;
    onMount(trimmedSlug, baseInput.trim() || 'main');
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-stone-900/55 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="目标仓库设置与切换"
    >
      <div className="bg-white rounded-md border border-stone-300 shadow-xl max-w-lg w-full overflow-hidden">
        <div className="px-5 py-3.5 border-b border-stone-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-stone-800 shrink-0" />
            <h3 className="text-sm font-semibold text-stone-900">目标 GitHub 仓库设置 / 切换</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭仓库设置弹窗"
            className="text-stone-400 hover:text-stone-700 p-1 rounded"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          <div className="space-y-1.5">
            <label htmlFor="repo-slug-input" className="block font-semibold text-stone-800">
              目标仓库（owner/repo）
            </label>
            <input
              id="repo-slug-input"
              type="text"
              value={slugInput}
              onChange={(e) => setSlugInput(e.target.value)}
              placeholder="例如：owner/repo"
              autoFocus
              className="w-full rounded border border-stone-300 bg-white px-3 py-2 font-mono text-xs text-stone-900 placeholder-stone-400 focus:border-stone-900 focus:outline-none"
            />
            <p className="text-stone-500 leading-relaxed">
              支持直接输入 <code className="font-mono">owner/repo</code> 或粘贴 GitHub 仓库地址。克隆与所有读写操作统一在本地单工作区{' '}
              <code className="font-mono">/tmp/target-repo</code> 中进行。
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="base-branch-input" className="block font-semibold text-stone-800">
              默认基准分支
            </label>
            <input
              id="base-branch-input"
              type="text"
              value={baseInput}
              onChange={(e) => setBaseInput(e.target.value)}
              placeholder="main"
              className="w-full rounded border border-stone-300 bg-white px-3 py-2 font-mono text-xs text-stone-900 placeholder-stone-400 focus:border-stone-900 focus:outline-none"
            />
          </div>

          <div className="p-3 rounded border border-stone-200 bg-stone-50/80 text-stone-600 space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-stone-800">
              <ShieldCheck className="h-3.5 w-3.5 text-stone-700 shrink-0" />
              运行环境访问权限说明
            </div>
            <p className="leading-relaxed">
              {hasToken
                ? '当前服务端运行环境已注入 GITHUB_TOKEN，可直接挂载公开或私有仓库并拉取分支 / PR。'
                : '当前未检测到环境变量 GITHUB_TOKEN，可直接挂载任意公开仓库；如需挂载私有仓库，请在服务运行环境中注入 GITHUB_TOKEN（前端不采集也不保存任何密钥）。'}
            </p>
          </div>

          {errorMessage && (
            <div className="p-3 rounded border border-rose-200 bg-rose-50 text-rose-800 leading-relaxed">
              {errorMessage}
            </div>
          )}

          <div className="pt-2 border-t border-stone-100 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded border border-stone-200 bg-stone-100 hover:bg-stone-200 text-stone-700 whitespace-nowrap"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={!validSlug || mounting}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-stone-900 hover:bg-stone-800 text-white font-medium disabled:opacity-40 whitespace-nowrap"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${mounting ? 'animate-spin' : ''}`} />
              {mounting ? '正在挂载与拉取...' : '挂载目标仓库'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
