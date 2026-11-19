import { useState } from 'react';
import { ClipboardList, Code2, Copy, Download, X } from 'lucide-react';

interface ExportBriefModalProps {
  open: boolean;
  onClose: () => void;
  repoSlug: string;
  compareLabel: string;
  markdownActionable: string;
  markdownAll: string;
  recordJson: string;
  branch: string;
  baseCommit: string;
  actionableCount: number;
  onCopy: (id: string, text: string, label: string) => void;
}

export function ExportBriefModal({
  open,
  onClose,
  repoSlug,
  compareLabel,
  markdownActionable,
  markdownAll,
  recordJson,
  branch,
  baseCommit,
  actionableCount,
  onCopy,
}: ExportBriefModalProps) {
  const [activeFormat, setActiveFormat] = useState<'markdown' | 'json'>('markdown');
  const [mdScope, setMdScope] = useState<'actionable' | 'all'>(
    actionableCount > 0 ? 'actionable' : 'all'
  );

  if (!open) return null;

  const activeMarkdown = mdScope === 'actionable' ? markdownActionable : markdownAll;
  const activeContent = activeFormat === 'markdown' ? activeMarkdown : recordJson;

  const handleDownload = () => {
    const ext = activeFormat === 'markdown' ? 'md' : 'json';
    const mime =
      activeFormat === 'markdown'
        ? 'text/markdown;charset=utf-8'
        : 'application/json;charset=utf-8';
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `manuscript-review-brief-${stamp}.${ext}`;
    const blob = new Blob([activeContent], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-stone-900/55 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="导出协作指令包"
    >
      <div className="bg-white rounded-md border border-stone-300 shadow-xl max-w-4xl w-full max-h-[88vh] flex flex-col">
        {/* Modal Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 border-b border-stone-200">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <ClipboardList className="h-4 w-4 text-stone-800 shrink-0" />
            <h3 className="text-sm font-semibold text-stone-900">
              导出人机协作指令包
            </h3>
            <span className="text-xs font-mono text-stone-500 truncate">
              · {repoSlug || '未挂载仓库'} · {compareLabel || `${branch} @ ${baseCommit}`}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭导出弹窗"
            className="text-stone-400 hover:text-stone-700 p-1 rounded"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Format & Scope Controls */}
        <div className="px-5 py-3 bg-stone-50/70 border-b border-stone-200/80 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="inline-flex rounded border border-stone-200 bg-stone-100 p-0.5">
            <button
              type="button"
              onClick={() => setActiveFormat('markdown')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded transition-colors whitespace-nowrap shrink-0 ${
                activeFormat === 'markdown'
                  ? 'bg-stone-900 text-white font-medium'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              <ClipboardList className="h-3.5 w-3.5" />
              结构化 Markdown 指令包 (推荐发给 AI)
            </button>
            <button
              type="button"
              onClick={() => setActiveFormat('json')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded transition-colors whitespace-nowrap shrink-0 ${
                activeFormat === 'json'
                  ? 'bg-stone-900 text-white font-medium'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              <Code2 className="h-3.5 w-3.5" />
              溯源记录 JSON
            </button>
          </div>

          {activeFormat === 'markdown' && (
            <div className="inline-flex rounded border border-stone-200 bg-white p-0.5">
              <button
                type="button"
                onClick={() => setMdScope('actionable')}
                className={`px-2.5 py-1 rounded transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                  mdScope === 'actionable'
                    ? 'bg-stone-900 text-white font-medium'
                    : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                仅需讨论 / 批注 / 微调项 ({actionableCount})
              </button>
              <button
                type="button"
                onClick={() => setMdScope('all')}
                className={`px-2.5 py-1 rounded transition-colors whitespace-nowrap shrink-0 ${
                  mdScope === 'all'
                    ? 'bg-stone-900 text-white font-medium'
                    : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                全部卡片
              </button>
            </div>
          )}
        </div>

        {/* Preview Area */}
        <div className="p-5 overflow-y-auto flex-1 space-y-2">
          <p className="text-xs text-stone-500">
            {activeFormat === 'markdown'
              ? '可直接粘贴至浏览器侧边栏 Gemini 讨论，或发给执行助手按精确路径与行号落盘修改（自动附带双语对齐与公式守恒约束）。'
              : '机器可读的完整审阅元数据快照，含审阅状态、批注及工作台微调内容。'}
          </p>
          <pre className="text-xs font-mono bg-stone-50 p-4 rounded border border-stone-200 overflow-x-auto max-h-[52vh] text-stone-800 whitespace-pre-wrap leading-relaxed">
            {activeContent}
          </pre>
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3 border-t border-stone-200 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-mono tabular-nums text-stone-500">
            长度：{activeContent.length.toLocaleString()} 字符
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-stone-300 bg-white hover:bg-stone-50 text-stone-800 text-xs font-medium whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" />
              下载 .{activeFormat === 'markdown' ? 'md' : 'json'}
            </button>
            <button
              type="button"
              onClick={() =>
                onCopy(
                  `export-${activeFormat}`,
                  activeContent,
                  activeFormat === 'markdown' ? '结构化 Markdown 指令包已复制' : '溯源记录 JSON 已复制'
                )
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-stone-900 hover:bg-stone-800 text-white text-xs font-medium whitespace-nowrap shrink-0"
            >
              <Copy className="h-3.5 w-3.5" />
              {activeFormat === 'markdown' ? '复制 Markdown 指令包' : '复制 JSON'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded border border-stone-200 bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs whitespace-nowrap shrink-0"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
