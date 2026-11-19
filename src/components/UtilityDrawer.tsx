import type { ReactNode } from 'react';
import { Copy, FlaskConical, GitBranch, Layers, X } from 'lucide-react';

export type UtilityDrawerMode = 'closed' | 'scratchpad' | 'workflow';

interface UtilityDrawerProps {
  mode: UtilityDrawerMode;
  onClose: () => void;
  onSwitchMode: (next: 'scratchpad' | 'workflow') => void;
  scratchBefore: string;
  scratchAfter: string;
  onChangeBefore: (val: string) => void;
  onChangeAfter: (val: string) => void;
  scratchPreview: ReactNode;
  workflowSpec: string;
  repoSlug: string;
  branch: string;
  baseCommit: string;
  onCopy: (id: string, text: string, label: string) => void;
}

export function UtilityDrawer({
  mode,
  onClose,
  onSwitchMode,
  scratchBefore,
  scratchAfter,
  onChangeBefore,
  onChangeAfter,
  scratchPreview,
  workflowSpec,
  repoSlug,
  branch,
  baseCommit,
  onCopy,
}: UtilityDrawerProps) {
  if (mode === 'closed') return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-stone-900/40 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="次级协作工具抽屉"
    >
      <div className="flex-1" onClick={onClose} />

      <aside className="w-full max-w-3xl bg-[#fbfbf9] border-l border-stone-300 shadow-2xl h-full flex flex-col">
        <div className="px-5 py-3.5 bg-white border-b border-stone-200 flex items-center justify-between gap-3">
          <div className="inline-flex rounded border border-stone-200 bg-stone-100 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => onSwitchMode('scratchpad')}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded transition-colors whitespace-nowrap shrink-0 ${
                mode === 'scratchpad'
                  ? 'bg-stone-900 text-white font-medium'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              <FlaskConical className="h-3.5 w-3.5" />
              自由推敲沙盒
            </button>
            <button
              type="button"
              onClick={() => onSwitchMode('workflow')}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded transition-colors whitespace-nowrap shrink-0 ${
                mode === 'workflow'
                  ? 'bg-stone-900 text-white font-medium'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              协作流程规范
            </button>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="关闭次级工具抽屉"
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-stone-500 hover:text-stone-900 hover:bg-stone-100"
          >
            <X className="h-4 w-4" />
            关闭
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {mode === 'scratchpad' && (
            <div className="bg-white border border-stone-200/90 rounded p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-stone-100">
                <div>
                  <h3 className="text-sm font-semibold text-stone-900">
                    自由段落推敲沙盒（实时 LaTeX 词元级比对）
                  </h3>
                  <p className="text-xs text-stone-500 mt-0.5">
                    粘贴任意中英文学术段落实时微调字词与公式；不离开当前审阅位置即可随时试验表述。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onCopy('scratch-after', scratchAfter, '已复制沙盒修改稿')}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-stone-300 bg-white hover:bg-stone-50 text-xs font-medium text-stone-800 whitespace-nowrap shrink-0"
                >
                  <Copy className="h-3.5 w-3.5" />
                  复制修改稿
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-stone-700">
                    比对基准文本（Before）
                  </label>
                  <textarea
                    value={scratchBefore}
                    onChange={(e) => onChangeBefore(e.target.value)}
                    rows={6}
                    placeholder="在此粘贴原句或基准段落..."
                    className="w-full rounded border border-stone-300 bg-stone-50/60 p-3 font-serif text-xs leading-relaxed text-stone-800 focus:border-stone-900 focus:bg-white focus:outline-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-stone-800">
                    推敲修改文本（After）
                  </label>
                  <textarea
                    value={scratchAfter}
                    onChange={(e) => onChangeAfter(e.target.value)}
                    rows={6}
                    placeholder="在此修改并实时查看词元级高亮..."
                    className="w-full rounded border border-stone-400 bg-white p-3 font-serif text-xs leading-relaxed text-stone-900 focus:border-stone-900 focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-semibold text-stone-700">实时差异高亮预览</div>
                {scratchPreview}
              </div>
            </div>
          )}

          {mode === 'workflow' && (
            <div className="space-y-4">
              <div className="bg-white border border-stone-200/90 rounded p-4 space-y-3">
                <h3 className="text-sm font-semibold text-stone-900">
                  通用双语学术文稿审阅与 AI 协同流程
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div className="p-3 rounded border border-stone-200 bg-stone-50/70 space-y-1">
                    <div className="font-semibold text-stone-900">1. 挂载仓库与分支比对</div>
                    <p className="text-stone-600 leading-relaxed">
                      当前挂载 <code className="font-mono">{repoSlug || 'owner/repo'}</code>（分支{' '}
                      <code className="font-mono">{branch}</code> @{' '}
                      <code className="font-mono">{baseCommit}</code>），支持任意分支、PR 与当前工作区实时 Diff。
                    </p>
                  </div>
                  <div className="p-3 rounded border border-stone-200 bg-stone-50/70 space-y-1">
                    <div className="font-semibold text-stone-900">2. 洁净读屏与讨论</div>
                    <p className="text-stone-600 leading-relaxed">
                      开启浏览器右侧 Gemini 侧边栏时，切至「洁净读屏 (Gemini)」隐藏删除线，或一键复制带行号的结构化提示包。
                    </p>
                  </div>
                  <div className="p-3 rounded border border-stone-200 bg-stone-50/70 space-y-1">
                    <div className="font-semibold text-stone-900">3. 批注汇总与落盘</div>
                    <p className="text-stone-600 leading-relaxed">
                      逐卡标记「待审 / 需讨论 / 已确认」并记下批注，导出结构化 Markdown 指令包交由执行工具精准改稿。
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-white border border-stone-200/90 rounded p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-stone-100">
                  <div className="text-sm font-semibold text-stone-900 flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-stone-700" />
                    通用工作流规范 (WORKFLOW_INSTRUCTIONS.md)
                  </div>
                  <button
                    type="button"
                    onClick={() => onCopy('workflow-spec-text', workflowSpec, '通用工作流规范已复制')}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-stone-900 hover:bg-stone-800 text-white text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    复制工作流规范
                  </button>
                </div>
                <pre className="text-xs font-mono bg-stone-50 p-3.5 rounded border border-stone-200 whitespace-pre-wrap leading-relaxed text-stone-800 max-h-[55vh] overflow-y-auto">
                  {workflowSpec || '正在读取 WORKFLOW_INSTRUCTIONS.md...'}
                </pre>
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
