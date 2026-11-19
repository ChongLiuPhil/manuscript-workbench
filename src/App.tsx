/**
 * @license
 * @spdx-license-identifier Apache-2.0
 */

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  CheckCircle2,
  FileText,
  BookOpen,
  Columns,
  AlignLeft,
  Sparkles,
  Edit3,
  RotateCcw,
  Copy,
  Check,
  FlaskConical,
  RefreshCw,
  LayoutDashboard,
  Play,
  ExternalLink,
  Layers,
  Search,
  AlertTriangle,
  Save,
  Type,
  FileCode2,
  X,
  ChevronDown,
  ChevronRight,
  Eye,
  MessageSquare,
  Send,
  PanelLeftClose,
  PanelLeftOpen,
  ClipboardList,
  MoreHorizontal,
  ArrowLeft,
  Languages,
  GitBranch,
  FolderGit2,
} from 'lucide-react';
import type {
  DiffSection,
  FullVolumeDocument,
  LintReport,
  ParagraphPair,
  PullRequestSummary,
  RepoFileItem,
  RepoStatus,
} from './types/workbench';
import {
  REVIEW_STATUS_LABEL,
  type ReviewMetaMap,
  type ReviewStatus,
  buildActionBriefMarkdown,
  buildParagraphGeminiPacket,
  buildSectionGeminiPacket,
  buildVolumeSelectionGeminiPacket,
  getReviewEntry,
  nextReviewStatus,
} from './utils/aiHandoff';
import { ExportBriefModal } from './components/ExportBriefModal';
import { UtilityDrawer, type UtilityDrawerMode } from './components/UtilityDrawer';
import { RepoConfigModal } from './components/RepoConfigModal';

type DiffOp = {
  type: 'equal' | 'delete' | 'insert';
  text: string;
};

type ViewMode = 'side-by-side' | 'inline' | 'clean-ai';
type FontSize = 'sm' | 'md' | 'lg';
type StatusFilter = 'all' | ReviewStatus | 'modified';
type CustomEditsMap = Record<string, { cn?: string; en?: string }>;

const SCRATCH_BEFORE_KEY = 'manuscript_workbench_scratch_before_v1';
const SCRATCH_AFTER_KEY = 'manuscript_workbench_scratch_after_v1';
const VOLUME_LANG_KEY = 'manuscript_workbench_volume_lang_v1';

const DEFAULT_SCRATCH_BEFORE =
  '在此粘贴任意中文或英文学术段落（支持 $LaTeX$ 数学表达式），在右侧修改即可实时查看词元级高亮差异。';
const DEFAULT_SCRATCH_AFTER =
  '在此粘贴任意中文或英文学术段落（支持 $LaTeX$ 数学公式），在右侧直接改写即可实时检视词元级高亮差异。';

function tokenizeForDiff(text: string): string[] {
  if (!text) return [];
  const pattern =
    /\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\operatorname\{[^}]+\}(?:\([^)]*\))?|\\mathcal\s+[A-Za-z]|\\[A-Za-z]+|\[\@[A-Za-z0-9_:-]+[^\]]*\]|[A-Za-z0-9_]+(?:'[A-Za-z]+)?|\s+|[\u4e00-\u9fff]|[^\sA-Za-z0-9_\u4e00-\u9fff]/g;
  return text.match(pattern) ?? [text];
}

function computeTokenDiff(oldStr: string, newStr: string): DiffOp[] {
  if (!oldStr && !newStr) return [];
  if (!oldStr) return [{ type: 'insert', text: newStr }];
  if (!newStr) return [{ type: 'delete', text: oldStr }];

  const a = tokenizeForDiff(oldStr);
  const b = tokenizeForDiff(newStr);
  const n = a.length;
  const m = b.length;

  // Guard against extreme hunk size causing O(n*m) lag
  if (n * m > 350000) {
    return [
      { type: 'delete', text: oldStr },
      { type: 'insert', text: newStr },
    ];
  }

  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const raw: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ type: 'equal', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ type: 'delete', text: a[i] });
      i++;
    } else {
      raw.push({ type: 'insert', text: b[j] });
      j++;
    }
  }
  while (i < n) raw.push({ type: 'delete', text: a[i++] });
  while (j < m) raw.push({ type: 'insert', text: b[j++] });

  const merged: DiffOp[] = [];
  for (const op of raw) {
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) {
      last.text += op.text;
    } else {
      merged.push({ ...op });
    }
  }
  return merged;
}

function HighlightedDiffBlock({
  oldText,
  newText,
  mode,
  baselineLabel,
  afterLabel,
  fontSizeClass,
}: {
  oldText: string;
  newText: string;
  mode: 'side-by-side' | 'inline';
  baselineLabel: string;
  afterLabel: string;
  fontSizeClass: string;
}) {
  const ops = useMemo(() => computeTokenDiff(oldText, newText), [oldText, newText]);
  const isIdentical = oldText === newText;

  if (mode === 'inline') {
    return (
      <div
        className={`rounded border border-stone-200 bg-stone-50/70 p-3.5 font-serif ${fontSizeClass} leading-relaxed text-stone-800 whitespace-pre-wrap`}
      >
        <div className="mb-2 flex items-center justify-between text-xs font-sans text-stone-500 border-b border-stone-200/80 pb-1.5">
          <span>
            行内融合对比 · 红色删除线表示 [{baselineLabel}] · 绿色加粗表示 [{afterLabel}]
          </span>
          {isIdentical && (
            <span className="text-emerald-700 font-medium">当前文本与所选基准无差异</span>
          )}
        </div>
        {ops.map((op, i) => {
          if (op.type === 'equal') return <span key={i}>{op.text}</span>;
          if (op.type === 'delete') {
            return (
              <del
                key={i}
                className="bg-rose-100/90 text-rose-900 line-through decoration-rose-500 px-0.5"
              >
                {op.text}
              </del>
            );
          }
          return (
            <ins
              key={i}
              className="bg-emerald-100/95 text-emerald-950 font-semibold no-underline px-0.5 border-b border-emerald-500"
            >
              {op.text}
            </ins>
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
      <div className="rounded border border-stone-200 bg-stone-50/80 p-3.5">
        <div className="mb-2 flex items-center justify-between text-xs font-mono text-stone-500 border-b border-stone-200/80 pb-1">
          <span className="truncate">{baselineLabel}</span>
          <span className="text-rose-700 font-semibold shrink-0">[- 修订前]</span>
        </div>
        <div className={`font-serif ${fontSizeClass} leading-relaxed text-stone-700 whitespace-pre-wrap`}>
          {ops.map((op, i) => {
            if (op.type === 'insert') return null;
            if (op.type === 'delete') {
              return (
                <span
                  key={i}
                  className="bg-rose-100/95 text-rose-900 line-through decoration-rose-500 px-0.5 font-medium"
                >
                  {op.text}
                </span>
              );
            }
            return <span key={i}>{op.text}</span>;
          })}
        </div>
      </div>

      <div className="rounded border border-emerald-300/90 bg-emerald-50/20 p-3.5">
        <div className="mb-2 flex items-center justify-between text-xs font-mono text-emerald-900 border-b border-emerald-200/80 pb-1">
          <span className="font-semibold truncate">{afterLabel}</span>
          <span className="text-emerald-700 font-semibold shrink-0">[+ 修订后]</span>
        </div>
        <div className={`font-serif ${fontSizeClass} leading-relaxed text-stone-900 whitespace-pre-wrap`}>
          {ops.map((op, i) => {
            if (op.type === 'delete') return null;
            if (op.type === 'insert') {
              return (
                <span
                  key={i}
                  className="bg-emerald-100/95 text-emerald-950 font-semibold px-0.5 border-b border-emerald-500"
                >
                  {op.text}
                </span>
              );
            }
            return <span key={i}>{op.text}</span>;
          })}
        </div>
      </div>
    </div>
  );
}

function statusTone(status: ReviewStatus): string {
  if (status === 'approved') {
    return 'border-emerald-200 bg-emerald-50/70 text-emerald-800 hover:bg-emerald-100/70';
  }
  if (status === 'discuss') {
    return 'border-amber-200 bg-amber-50/80 text-amber-900 hover:bg-amber-100/80';
  }
  return 'border-stone-200 bg-stone-50 text-stone-600 hover:bg-stone-100';
}

export function App() {
  // Primary navigation & drawers
  const [activeTab, setActiveTab] = useState<'fullvolume' | 'diff' | 'inspector'>('diff');
  const [returnTab, setReturnTab] = useState<'fullvolume' | 'diff'>('diff');
  const [utilityDrawer, setUtilityDrawer] = useState<UtilityDrawerMode>('closed');
  const [moreMenuOpen, setMoreMenuOpen] = useState<boolean>(false);
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [showRepoModal, setShowRepoModal] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);

  // Target repository & Git diff comparison state
  const [repoStatus, setRepoStatus] = useState<RepoStatus | null>(null);
  const [pulls, setPulls] = useState<PullRequestSummary[]>([]);
  const [mountingRepo, setMountingRepo] = useState<boolean>(false);
  const [mountError, setMountError] = useState<string | null>(null);
  const [syncingGithub, setSyncingGithub] = useState<boolean>(false);
  const [runningTests, setRunningTests] = useState<boolean>(false);
  const [showTestDetails, setShowTestDetails] = useState<boolean>(false);
  const [testResults, setTestResults] = useState<{
    allPassed: boolean;
    detectedCount: number;
    checkedAt: string;
    results: Array<{ name: string; passed: boolean; summary: string }>;
  } | null>(null);
  const [workflowSpec, setWorkflowSpec] = useState<string>('');

  // Dynamic diff comparison selectors
  const [baseRef, setBaseRef] = useState<string>('main');
  const [targetRef, setTargetRef] = useState<string>('WORKING_TREE');
  const [compareLabel, setCompareLabel] = useState<string>('');
  const [diffSections, setDiffSections] = useState<DiffSection[]>([]);
  const [diffLoading, setDiffLoading] = useState<boolean>(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  // Diff viewer controls
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [showDiffOverview, setShowDiffOverview] = useState<boolean>(false);
  const [activeLang, setActiveLang] = useState<'zh' | 'en' | 'both'>('both');
  const [viewMode, setViewMode] = useState<ViewMode>('side-by-side');
  const [fontSize, setFontSize] = useState<FontSize>('sm');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [globalEditOpen, setGlobalEditOpen] = useState<boolean>(false);
  const [openEditors, setOpenEditors] = useState<Record<string, boolean>>({});
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});

  // Scope-isolated review metadata & custom edits (isolated by repo + base..target)
  const scopeKey = useMemo(() => {
    const slug = repoStatus?.repoSlug || 'unmounted';
    return `${slug}::${baseRef}..${targetRef}`;
  }, [repoStatus?.repoSlug, baseRef, targetRef]);

  const [customEdits, setCustomEdits] = useState<CustomEditsMap>({});
  const [reviewMeta, setReviewMeta] = useState<ReviewMetaMap>({});
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  // Full-Volume Reading View State
  const [volumeDocs, setVolumeDocs] = useState<FullVolumeDocument[]>([]);
  const [volumeLoading, setVolumeLoading] = useState<boolean>(false);
  const [volumeScope, setVolumeScope] = useState<string>('single');
  const [selectedDocId, setSelectedDocId] = useState<string>('');
  const [volumeLang, setVolumeLang] = useState<'zh' | 'en' | 'both'>(() => {
    try {
      const saved = localStorage.getItem(VOLUME_LANG_KEY);
      if (saved === 'zh' || saved === 'en' || saved === 'both') return saved;
      return 'zh';
    } catch {
      return 'zh';
    }
  });
  const [volumeSearch, setVolumeSearch] = useState<string>('');
  const [jumpLineInput, setJumpLineInput] = useState<string>('');
  const [showVolumeToc, setShowVolumeToc] = useState<boolean>(true);
  const [highlightedLine, setHighlightedLine] = useState<{ docId: string; lineNo: number } | null>(null);
  const [volumeSelection, setVolumeSelection] = useState<{
    docId: string;
    startLine: number;
    endLine: number;
  } | null>(null);

  // Wide-screen Corpus Inspector State
  const [repoFiles, setRepoFiles] = useState<RepoFileItem[]>([]);
  const [inspectorFile, setInspectorFile] = useState<string>('');
  const [inspectorCustomPath, setInspectorCustomPath] = useState<string>('');
  const [inspectorViewMode, setInspectorViewMode] = useState<'read' | 'edit'>('read');
  const [inspectorSearch, setInspectorSearch] = useState<string>('');
  const [inspectorContent, setInspectorContent] = useState<string>('');
  const [inspectorLines, setInspectorLines] = useState<number>(0);
  const [inspectorSha, setInspectorSha] = useState<string>('');
  const [inspectorLoading, setInspectorLoading] = useState<boolean>(false);
  const [inspectorLint, setInspectorLint] = useState<LintReport | null>(null);
  const [inspectorSaving, setInspectorSaving] = useState<boolean>(false);

  // Scratchpad
  const [scratchBefore, setScratchBefore] = useState<string>(() => {
    try {
      return localStorage.getItem(SCRATCH_BEFORE_KEY) || DEFAULT_SCRATCH_BEFORE;
    } catch {
      return DEFAULT_SCRATCH_BEFORE;
    }
  });
  const [scratchAfter, setScratchAfter] = useState<string>(() => {
    try {
      return localStorage.getItem(SCRATCH_AFTER_KEY) || DEFAULT_SCRATCH_AFTER;
    } catch {
      return DEFAULT_SCRATCH_AFTER;
    }
  });

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => setToastMessage(null), 2600);
  }, []);

  // Load isolated customEdits & reviewMeta whenever scopeKey changes
  useEffect(() => {
    const editsKey = `mw_edits::${scopeKey}`;
    const metaKey = `mw_meta::${scopeKey}`;
    try {
      const savedEdits = localStorage.getItem(editsKey);
      setCustomEdits(savedEdits ? JSON.parse(savedEdits) : {});
    } catch {
      setCustomEdits({});
    }
    try {
      const savedMeta = localStorage.getItem(metaKey);
      setReviewMeta(savedMeta ? JSON.parse(savedMeta) : {});
    } catch {
      setReviewMeta({});
    }
  }, [scopeKey]);

  useEffect(() => {
    try {
      localStorage.setItem(`mw_edits::${scopeKey}`, JSON.stringify(customEdits));
    } catch {
      // Ignore storage quota error
    }
  }, [scopeKey, customEdits]);

  useEffect(() => {
    try {
      localStorage.setItem(`mw_meta::${scopeKey}`, JSON.stringify(reviewMeta));
    } catch {
      // Ignore storage quota error
    }
  }, [scopeKey, reviewMeta]);

  useEffect(() => {
    try {
      localStorage.setItem(VOLUME_LANG_KEY, volumeLang);
    } catch {
      // ignore
    }
  }, [volumeLang]);

  useEffect(() => {
    if (!selectedDocId || !repoStatus?.repoSlug) return;
    try {
      localStorage.setItem(`mw_doc::${repoStatus.repoSlug}`, selectedDocId);
    } catch {
      // ignore
    }
  }, [selectedDocId, repoStatus?.repoSlug]);

  useEffect(() => {
    try {
      localStorage.setItem(SCRATCH_BEFORE_KEY, scratchBefore);
      localStorage.setItem(SCRATCH_AFTER_KEY, scratchAfter);
    } catch {
      // ignore
    }
  }, [scratchBefore, scratchAfter]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const loadInspectorFile = useCallback(
    (filePath: string) => {
      if (!filePath) return;
      setInspectorFile(filePath);
      setInspectorLoading(true);
      fetch('/api/workbench/file?path=' + encodeURIComponent(filePath))
        .then((r) => r.json())
        .then((d) => {
          if (d.ok) {
            setInspectorContent(d.content || '');
            setInspectorLines(d.lines || 0);
            setInspectorSha(d.sha256 || '');
            setInspectorLint(d.lint || null);
          } else {
            showToast(d.error || '读取文件失败');
          }
        })
        .catch(() => showToast('读取文件失败'))
        .finally(() => setInspectorLoading(false));
    },
    [showToast]
  );

  const loadFullVolume = useCallback(
    (repoSlugHint?: string) => {
      setVolumeLoading(true);
      fetch('/api/workbench/full-volume')
        .then((r) => r.json())
        .then((d) => {
          if (d.ok && Array.isArray(d.documents)) {
            const docs = d.documents as FullVolumeDocument[];
            setVolumeDocs(docs);
            if (docs.length > 0) {
              const savedId = repoSlugHint
                ? localStorage.getItem(`mw_doc::${repoSlugHint}`) || ''
                : '';
              setSelectedDocId((prev) => {
                if (prev && docs.some((item) => item.id === prev)) return prev;
                if (savedId && docs.some((item) => item.id === savedId)) return savedId;
                return docs[0].id;
              });
            } else {
              setSelectedDocId('');
            }
          }
        })
        .catch(() => showToast('加载合卷全文失败'))
        .finally(() => setVolumeLoading(false));
    },
    [showToast]
  );

  const loadRepoFiles = useCallback(() => {
    fetch('/api/workbench/files')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && Array.isArray(d.files)) {
          const list = d.files as RepoFileItem[];
          setRepoFiles(list);
          if (list.length > 0) {
            setInspectorFile((prev) => {
              if (prev && list.some((f) => f.path === prev)) return prev;
              loadInspectorFile(list[0].path);
              return list[0].path;
            });
          } else {
            setInspectorFile('');
            setInspectorContent('');
          }
        }
      })
      .catch(() => {});
  }, [loadInspectorFile]);

  const loadPulls = useCallback(() => {
    fetch('/api/repo/pulls')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && Array.isArray(d.pulls)) {
          setPulls(d.pulls);
        }
      })
      .catch(() => {});
  }, []);

  const loadDiff = useCallback((base: string, target: string) => {
    setDiffLoading(true);
    setDiffError(null);
    fetch(`/api/diff?base=${encodeURIComponent(base)}&target=${encodeURIComponent(target)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          const nextSections = (d.sections || []) as DiffSection[];
          setDiffSections(nextSections);
          setCompareLabel(d.compareLabel || `${base} ... ${target}`);
          setExpandedSections(nextSections.length > 0 ? { [nextSections[0].id]: true } : {});
        } else {
          setDiffSections([]);
          setDiffError(d.error || '计算 Git 差异失败');
        }
      })
      .catch((err) => {
        setDiffSections([]);
        setDiffError(String(err));
      })
      .finally(() => setDiffLoading(false));
  }, []);

  const refreshRepoContext = useCallback(
    (overrideBase?: string, overrideTarget?: string) => {
      fetch('/api/repo-status')
        .then((r) => r.json())
        .then((d: RepoStatus & { ok?: boolean }) => {
          if (!d.ok) return;
          setRepoStatus(d);
          if (d.cloned) {
            const nextBase = overrideBase || d.defaultBase || 'main';
            const nextTarget =
              overrideTarget ||
              (d.hasLocalDraftEdits
                ? 'WORKING_TREE'
                : d.branch && d.branch !== nextBase
                ? d.branch
                : 'WORKING_TREE');
            setBaseRef(nextBase);
            setTargetRef(nextTarget);
            loadDiff(nextBase, nextTarget);
            loadFullVolume(d.repoSlug);
            loadRepoFiles();
            loadPulls();
          } else {
            setDiffSections([]);
            setVolumeDocs([]);
            setRepoFiles([]);
            setPulls([]);
          }
        })
        .catch(() => {});
    },
    [loadDiff, loadFullVolume, loadRepoFiles, loadPulls]
  );

  useEffect(() => {
    refreshRepoContext();
    fetch('/api/workflow-spec')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.markdown) setWorkflowSpec(d.markdown);
      })
      .catch(() => {});
  }, [refreshRepoContext]);

  const handleMountRepo = (repoSlug: string, defaultBase: string) => {
    setMountingRepo(true);
    setMountError(null);
    fetch('/api/repo/mount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoSlug, baseBranch: defaultBase }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setRepoStatus(d);
          setShowRepoModal(false);
          const nextBase = d.defaultBase || defaultBase || 'main';
          const nextTarget = d.hasLocalDraftEdits ? 'WORKING_TREE' : 'WORKING_TREE';
          setBaseRef(nextBase);
          setTargetRef(nextTarget);
          loadDiff(nextBase, nextTarget);
          loadFullVolume(d.repoSlug);
          loadRepoFiles();
          loadPulls();
          showToast(`已成功挂载仓库 ${d.repoSlug}`);
        } else {
          setMountError(d.error || '挂载失败');
        }
      })
      .catch((err) => setMountError(String(err)))
      .finally(() => setMountingRepo(false));
  };

  const handleSyncGithub = () => {
    if (!repoStatus?.cloned) {
      setShowRepoModal(true);
      return;
    }
    setSyncingGithub(true);
    fetch('/api/sync-github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: false }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setRepoStatus(d);
          loadDiff(baseRef, targetRef);
          loadFullVolume(d.repoSlug);
          loadRepoFiles();
          loadPulls();
          showToast('已拉取远端最新分支并刷新差异视图');
        } else {
          showToast(d.error || '拉取同步失败');
        }
      })
      .catch(() => showToast('拉取同步失败'))
      .finally(() => setSyncingGithub(false));
  };

  const handleRunTests = () => {
    if (!repoStatus?.cloned) return;
    setRunningTests(true);
    fetch('/api/run-tests', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setTestResults(d);
          setShowTestDetails(true);
          if (d.detectedCount === 0) {
            showToast('当前目标仓库未检测到内置校验脚本');
          } else {
            showToast(
              d.allPassed
                ? `✓ ${d.detectedCount} 项仓库校验脚本全部通过`
                : '⚠ 部分仓库校验脚本未通过'
            );
          }
        }
      })
      .catch(() => showToast('校验脚本执行失败'))
      .finally(() => setRunningTests(false));
  };

  const saveInspectorFile = () => {
    if (!inspectorFile) return;
    setInspectorSaving(true);
    fetch('/api/workbench/save-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: inspectorFile,
        content: inspectorContent,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setInspectorSha(d.sha256 || '');
          if (d.lint) setInspectorLint(d.lint);
          showToast(`已保存 ${inspectorFile} 至 /tmp/target-repo`);
          refreshRepoContext(baseRef, 'WORKING_TREE');
        } else {
          showToast(d.error || '保存失败');
        }
      })
      .catch(() => showToast('保存失败'))
      .finally(() => setInspectorSaving(false));
  };

  const handleCopy = (_id: string, text: string, toastLabel = '已复制到剪贴板') => {
    navigator.clipboard.writeText(text);
    showToast(toastLabel);
  };

  // Volume reading helpers
  const volumeGroups = useMemo(() => {
    const map = new Map<string, { group: string; label: string; docs: FullVolumeDocument[] }>();
    for (const doc of volumeDocs) {
      if (!map.has(doc.group)) {
        map.set(doc.group, { group: doc.group, label: doc.groupLabel, docs: [] });
      }
      map.get(doc.group)!.docs.push(doc);
    }
    return Array.from(map.values());
  }, [volumeDocs]);

  const visibleVolumeDocs = useMemo(() => {
    if (volumeScope === 'single') {
      const found = volumeDocs.find((d) => d.id === selectedDocId);
      return found ? [found] : volumeDocs.slice(0, 1);
    }
    if (volumeScope === 'all') return volumeDocs;
    return volumeDocs.filter((d) => d.group === volumeScope);
  }, [volumeDocs, volumeScope, selectedDocId]);

  const getDocSearchMatches = (doc: FullVolumeDocument, query: string): number[] => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const total = Math.max(doc.lines.length, doc.enLines.length);
    const matched: number[] = [];
    for (let i = 0; i < total; i++) {
      const zh = doc.lines[i] ?? '';
      const en = doc.enLines[i] ?? '';
      if (zh.toLowerCase().includes(q) || en.toLowerCase().includes(q)) {
        matched.push(i + 1);
      }
    }
    return matched;
  };

  const handleSelectOrScrollDoc = (docId: string, targetLine?: number) => {
    setSelectedDocId(docId);
    const doc = volumeDocs.find((d) => d.id === docId);
    if (doc && volumeScope !== 'single' && volumeScope !== 'all' && volumeScope !== doc.group) {
      setVolumeScope('single');
    }

    if (targetLine && targetLine > 0) {
      setHighlightedLine({ docId, lineNo: targetLine });
      window.setTimeout(() => {
        const lineEl = document.getElementById(`${docId}-L${targetLine}`);
        if (lineEl) lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 80);
      return;
    }

    if (volumeScope === 'single') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    window.setTimeout(() => {
      const el = document.getElementById(`volume-doc-${docId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  };

  const handleJumpToLine = () => {
    const lineNo = parseInt(jumpLineInput.replace(/[^0-9]/g, ''), 10);
    if (!lineNo || isNaN(lineNo)) return;
    const targetDocId = selectedDocId || visibleVolumeDocs[0]?.id;
    if (!targetDocId) return;
    const el = document.getElementById(`${targetDocId}-L${lineNo}`);
    if (el) {
      setHighlightedLine({ docId: targetDocId, lineNo });
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      showToast(`已定位至第 L${lineNo} 行`);
    } else {
      showToast(`当前篇目未找到第 L${lineNo} 行`);
    }
  };

  const handleLineNumberClick = (docId: string, lineNo: number, shiftKey: boolean) => {
    setVolumeSelection((prev) => {
      if (!prev || prev.docId !== docId) {
        return { docId, startLine: lineNo, endLine: lineNo };
      }
      if (shiftKey || prev.startLine === prev.endLine) {
        return {
          docId,
          startLine: Math.min(prev.startLine, lineNo),
          endLine: Math.max(prev.startLine, lineNo),
        };
      }
      return { docId, startLine: lineNo, endLine: lineNo };
    });
  };

  const handleCopyVolumeSelection = (doc: FullVolumeDocument) => {
    if (!volumeSelection || volumeSelection.docId !== doc.id) return;
    const effectiveLang = !doc.hasEn ? 'zh' : volumeLang;
    const maxLines =
      effectiveLang === 'zh'
        ? doc.lineCount
        : effectiveLang === 'en'
        ? doc.enLineCount
        : Math.max(doc.lineCount, doc.enLineCount);
    const start = Math.max(1, volumeSelection.startLine);
    const end = Math.min(maxLines, volumeSelection.endLine);
    const selectedLines: Array<{ lineNo: number; zhText: string; enText: string }> = [];
    for (let ln = start; ln <= end; ln++) {
      selectedLines.push({
        lineNo: ln,
        zhText: doc.lines[ln - 1] ?? '',
        enText: doc.enLines[ln - 1] ?? '',
      });
    }
    const packet = buildVolumeSelectionGeminiPacket({
      repoSlug: repoStatus?.repoSlug,
      orderLabel: doc.orderLabel,
      title: doc.title,
      enTitle: doc.enTitle,
      path: doc.path,
      enPath: doc.enPath,
      hasEn: doc.hasEn,
      lang: effectiveLang,
      startLine: start,
      endLine: end,
      selectedLines,
    });
    const rangeLabel = start === end ? `L${start}` : `L${start}–L${end}`;
    handleCopy(`vol-sel-${doc.id}`, packet, `已复制 ${doc.orderLabel} (${rangeLabel}) 审阅包`);
  };

  const fontSizeClass = useMemo(() => {
    if (fontSize === 'md') return 'text-[14.5px]';
    if (fontSize === 'lg') return 'text-[16.5px]';
    return 'text-[13px]';
  }, [fontSize]);

  const isManuallyModified = useCallback(
    (pair: ParagraphPair): boolean => {
      const custom = customEdits[pair.id];
      if (!custom) return false;
      const cnChanged = pair.hasCn && custom.cn !== undefined && custom.cn !== pair.cnAfter;
      const enChanged = pair.hasEn && custom.en !== undefined && custom.en !== pair.enAfter;
      return cnChanged || enChanged;
    },
    [customEdits]
  );

  const getEffectiveAfter = useCallback(
    (pair: ParagraphPair, lang: 'zh' | 'en'): string => {
      const custom = customEdits[pair.id];
      if (lang === 'zh') return custom?.cn !== undefined ? custom.cn : pair.cnAfter;
      return custom?.en !== undefined ? custom.en : pair.enAfter;
    },
    [customEdits]
  );

  const handleCycleReviewStatus = (key: string) => {
    setReviewMeta((prev) => {
      const current = getReviewEntry(prev, key);
      return {
        ...prev,
        [key]: {
          ...current,
          status: nextReviewStatus(current.status),
          updatedAt: Date.now(),
        },
      };
    });
  };

  const handleReviewNoteChange = (key: string, note: string) => {
    setReviewMeta((prev) => {
      const current = getReviewEntry(prev, key);
      return {
        ...prev,
        [key]: {
          ...current,
          note,
          updatedAt: Date.now(),
        },
      };
    });
  };

  const filteredSections = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return diffSections.filter((sec) => {
      const secMeta = getReviewEntry(reviewMeta, sec.id);
      if (statusFilter !== 'all') {
        if (statusFilter === 'modified') {
          if (!sec.paragraphs.some((p) => isManuallyModified(p))) return false;
        } else {
          const matchesSection = secMeta.status === statusFilter;
          const matchesAnyPara = sec.paragraphs.some(
            (p) => getReviewEntry(reviewMeta, p.id).status === statusFilter
          );
          if (!matchesSection && !matchesAnyPara) return false;
        }
      }
      if (!q) return true;
      const matchMeta =
        sec.chapter.toLowerCase().includes(q) ||
        sec.shortTitle.toLowerCase().includes(q) ||
        sec.location.toLowerCase().includes(q) ||
        sec.issue.toLowerCase().includes(q) ||
        secMeta.note.toLowerCase().includes(q);
      const matchParas = sec.paragraphs.some((p) => {
        const pMeta = getReviewEntry(reviewMeta, p.id);
        return (
          p.label.toLowerCase().includes(q) ||
          p.cnBefore.toLowerCase().includes(q) ||
          p.cnAfter.toLowerCase().includes(q) ||
          p.enBefore.toLowerCase().includes(q) ||
          p.enAfter.toLowerCase().includes(q) ||
          pMeta.note.toLowerCase().includes(q)
        );
      });
      return matchMeta || matchParas;
    });
  }, [diffSections, searchQuery, statusFilter, reviewMeta, isManuallyModified]);

  const isSearchActive = searchQuery.trim().length > 0 || statusFilter !== 'all';

  const isSectionExpanded = (secId: string): boolean => {
    if (isSearchActive) {
      return expandedSections[secId] !== undefined ? expandedSections[secId] : true;
    }
    return !!expandedSections[secId];
  };

  const toggleSectionExpanded = (secId: string) => {
    const currentlyExpanded = isSectionExpanded(secId);
    setExpandedSections((prev) => ({ ...prev, [secId]: !currentlyExpanded }));
  };

  const expandAllFilteredSections = () => {
    setExpandedSections((prev) => {
      const next = { ...prev };
      for (const sec of filteredSections) next[sec.id] = true;
      return next;
    });
  };

  const collapseAllFilteredSections = () => {
    setExpandedSections((prev) => {
      const next = { ...prev };
      for (const sec of filteredSections) next[sec.id] = false;
      return next;
    });
  };

  const collapseSectionAndScroll = (currentId: string, nextId?: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [currentId]: false,
      ...(nextId ? { [nextId]: true } : {}),
    }));
    const targetId = nextId ? `diff-section-${nextId}` : `diff-section-${currentId}`;
    requestAnimationFrame(() => {
      const el = document.getElementById(targetId);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const expandedFilteredCount = useMemo(
    () => filteredSections.filter((sec) => isSectionExpanded(sec.id)).length,
    [filteredSections, expandedSections, isSearchActive]
  );

  const totalParagraphs = useMemo(
    () => diffSections.reduce((s, x) => s + x.paragraphs.length, 0),
    [diffSections]
  );

  const modifiedCount = useMemo(() => {
    let count = 0;
    for (const sec of diffSections) {
      for (const p of sec.paragraphs) {
        if (isManuallyModified(p)) count++;
      }
    }
    return count;
  }, [diffSections, isManuallyModified]);

  const reviewCounts = useMemo(() => {
    let pending = 0;
    let discuss = 0;
    let approved = 0;
    let actionable = 0;
    for (const sec of diffSections) {
      const sMeta = getReviewEntry(reviewMeta, sec.id);
      if (sMeta.status === 'discuss' || sMeta.note.trim()) actionable++;
      for (const p of sec.paragraphs) {
        const pMeta = getReviewEntry(reviewMeta, p.id);
        if (pMeta.status === 'pending') pending++;
        if (pMeta.status === 'discuss') discuss++;
        if (pMeta.status === 'approved') approved++;
        if (pMeta.status === 'discuss' || pMeta.note.trim() || isManuallyModified(p)) {
          actionable++;
        }
      }
    }
    return { pending, discuss, approved, actionable };
  }, [diffSections, reviewMeta, isManuallyModified]);

  const handleEditChange = (pairId: string, lang: 'zh' | 'en', value: string) => {
    setCustomEdits((prev) => ({
      ...prev,
      [pairId]: {
        ...prev[pairId],
        [lang === 'zh' ? 'cn' : 'en']: value,
      },
    }));
  };

  const handleResetToCurrent = (pair: ParagraphPair) => {
    setCustomEdits((prev) => {
      const next = { ...prev };
      delete next[pair.id];
      return next;
    });
    showToast('已恢复为当前比对目标版本');
  };

  const handleLoadBaseline = (pair: ParagraphPair) => {
    setCustomEdits((prev) => ({
      ...prev,
      [pair.id]: {
        ...(pair.hasCn ? { cn: pair.cnBefore } : {}),
        ...(pair.hasEn ? { en: pair.enBefore } : {}),
      },
    }));
    showToast('已载入修订前基准内容');
  };

  const handleCopyBilingualMarkdown = (pair: ParagraphPair) => {
    const parts: string[] = [`### ${pair.label}`];
    if (pair.hasCn) {
      parts.push('', pair.hasEn ? '**中文/主稿：**' : '**当前文本：**', '', getEffectiveAfter(pair, 'zh'));
    }
    if (pair.hasEn) {
      parts.push('', '**English / Counterpart:**', '', getEffectiveAfter(pair, 'en'));
    }
    handleCopy(`${pair.id}-both`, parts.join('\n'), '已复制双语 Markdown');
  };

  const activeBranch = repoStatus?.branch || baseRef || 'main';
  const activeCommit = repoStatus?.localShort || '—';
  const activeRepoSlug = repoStatus?.repoSlug || '';

  const generatedChangeRecordJson = useMemo(() => {
    const allEdits = diffSections.flatMap((sec) =>
      sec.paragraphs.map((p) => {
        const pMeta = getReviewEntry(reviewMeta, p.id);
        return {
          sectionId: sec.id,
          paragraphId: p.id,
          label: p.label,
          location: sec.location,
          reviewStatus: pMeta.status,
          reviewNote: pMeta.note,
          manuallyCustomized: isManuallyModified(p),
          ...(p.hasCn ? { cnAfter: getEffectiveAfter(p, 'zh') } : {}),
          ...(p.hasEn ? { enAfter: getEffectiveAfter(p, 'en') } : {}),
        };
      })
    );
    return JSON.stringify(
      {
        id: 'manuscript-workbench-review-record',
        repo: activeRepoSlug || 'unmounted',
        compare: compareLabel || `${baseRef}..${targetRef}`,
        branch: activeBranch,
        baseCommit: activeCommit,
        sectionCount: diffSections.length,
        modifiedParagraphCount: modifiedCount,
        discussCount: reviewCounts.discuss,
        approvedCount: reviewCounts.approved,
        sectionNotes: Object.fromEntries(
          diffSections.map((sec) => [sec.id, getReviewEntry(reviewMeta, sec.id)])
        ),
        edits: allEdits,
      },
      null,
      2
    );
  }, [
    diffSections,
    reviewMeta,
    isManuallyModified,
    getEffectiveAfter,
    activeRepoSlug,
    compareLabel,
    baseRef,
    targetRef,
    activeBranch,
    activeCommit,
    modifiedCount,
    reviewCounts,
  ]);

  const markdownBriefActionable = useMemo(
    () =>
      buildActionBriefMarkdown({
        repoSlug: activeRepoSlug,
        compareLabel: compareLabel || `${baseRef} ... ${targetRef}`,
        sections: diffSections,
        branch: activeBranch,
        baseCommit: activeCommit,
        reviewMeta,
        isManuallyModified,
        getCnAfter: (p) => getEffectiveAfter(p, 'zh'),
        getEnAfter: (p) => getEffectiveAfter(p, 'en'),
        scope: 'actionable',
      }),
    [
      activeRepoSlug,
      compareLabel,
      baseRef,
      targetRef,
      diffSections,
      activeBranch,
      activeCommit,
      reviewMeta,
      isManuallyModified,
      getEffectiveAfter,
    ]
  );

  const markdownBriefAll = useMemo(
    () =>
      buildActionBriefMarkdown({
        repoSlug: activeRepoSlug,
        compareLabel: compareLabel || `${baseRef} ... ${targetRef}`,
        sections: diffSections,
        branch: activeBranch,
        baseCommit: activeCommit,
        reviewMeta,
        isManuallyModified,
        getCnAfter: (p) => getEffectiveAfter(p, 'zh'),
        getEnAfter: (p) => getEffectiveAfter(p, 'en'),
        scope: 'all',
      }),
    [
      activeRepoSlug,
      compareLabel,
      baseRef,
      targetRef,
      diffSections,
      activeBranch,
      activeCommit,
      reviewMeta,
      isManuallyModified,
      getEffectiveAfter,
    ]
  );

  // Sync review state to local /tmp persistence periodically when modified
  useEffect(() => {
    if (!activeRepoSlug) return;
    if (Object.keys(customEdits).length === 0 && Object.keys(reviewMeta).length === 0) return;
    const timer = window.setTimeout(() => {
      fetch('/api/sync-edits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopeKey,
          customEdits,
          reviewMeta,
        }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.ok && d.updatedAt) setLastSyncedAt(d.updatedAt);
        })
        .catch(() => {});
    }, 900);
    return () => window.clearTimeout(timer);
  }, [activeRepoSlug, scopeKey, customEdits, reviewMeta]);

  const isCleanAiMode = viewMode === 'clean-ai';

  const branchOptions = useMemo(() => {
    const raw = repoStatus?.branches || [];
    const unique = new Set<string>([repoStatus?.defaultBase || 'main', ...raw]);
    return Array.from(unique).filter(Boolean);
  }, [repoStatus]);

  return (
    <div className="min-h-screen bg-[#fbfbf9] text-stone-900 font-sans pb-16 antialiased selection:bg-stone-200">
      {/* Toast */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 bg-stone-900 text-stone-100 text-xs px-4 py-2.5 rounded shadow-lg flex items-center gap-2 border border-stone-700">
          <Check className="h-4 w-4 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Slim Single-Row Header */}
      <header className="border-b border-stone-200 bg-white/95 backdrop-blur px-4 sm:px-6 py-2.5 sticky top-0 z-30 shadow-2xs">
        <div className="mx-auto max-w-7xl flex flex-wrap items-center justify-between gap-3">
          {/* Brand Title */}
          <div className="flex items-center gap-2.5 min-w-0">
            <BookOpen className="h-4.5 w-4.5 text-stone-800 shrink-0" />
            <div className="flex items-baseline gap-2 min-w-0">
              <h1 className="text-sm sm:text-base font-semibold tracking-tight text-stone-900 whitespace-nowrap">
                Manuscript Workbench
              </h1>
              <span className="hidden md:inline text-xs text-stone-500 whitespace-nowrap">
                双语学术文稿研审台
              </span>
              {diffSections.length > 0 && (
                <span className="hidden xl:inline text-xs font-mono text-stone-400 whitespace-nowrap tabular-nums">
                  · {diffSections.length} 卡片 · 已确认 {reviewCounts.approved} · 需讨论 {reviewCounts.discuss}
                </span>
              )}
            </div>
          </div>

          {/* Primary 2-Tab Navigation + More Tools + Export */}
          <div className="flex flex-wrap items-center gap-2">
            <nav
              aria-label="主工作区视图"
              className="inline-flex rounded border border-stone-200 bg-stone-100 p-0.5 text-xs"
            >
              <button
                type="button"
                onClick={() => {
                  setReturnTab('diff');
                  setActiveTab('diff');
                }}
                className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'diff'
                    ? 'bg-stone-900 text-white font-medium'
                    : 'text-stone-700 hover:text-stone-900'
                }`}
              >
                <FileText className="h-3.5 w-3.5" />
                词元比对审阅
              </button>
              <button
                type="button"
                onClick={() => {
                  setReturnTab('fullvolume');
                  setActiveTab('fullvolume');
                }}
                className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'fullvolume'
                    ? 'bg-stone-900 text-white font-medium'
                    : 'text-stone-700 hover:text-stone-900'
                }`}
              >
                <BookOpen className="h-3.5 w-3.5" />
                合卷全文阅读
              </button>
            </nav>

            {/* Secondary Tools Dropdown */}
            <div className="relative" ref={moreMenuRef}>
              <button
                type="button"
                onClick={() => setMoreMenuOpen((prev) => !prev)}
                aria-expanded={moreMenuOpen}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded border text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'inspector'
                    ? 'border-stone-900 bg-stone-100 text-stone-900'
                    : 'border-stone-200 bg-white hover:bg-stone-50 text-stone-700'
                }`}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
                更多工具
                {activeTab === 'inspector' && (
                  <span className="text-[11px] font-mono text-stone-500">· 直检</span>
                )}
                <ChevronDown className="h-3 w-3 text-stone-400" />
              </button>

              {moreMenuOpen && (
                <div className="absolute right-0 mt-1.5 w-64 bg-white border border-stone-200 rounded shadow-lg py-1 z-40 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      if (activeTab !== 'inspector') setReturnTab(activeTab);
                      setActiveTab('inspector');
                      setMoreMenuOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 hover:bg-stone-50 flex items-center gap-2 ${
                      activeTab === 'inspector' ? 'bg-stone-100/80 text-stone-950' : 'text-stone-800'
                    }`}
                  >
                    <FileCode2 className="h-3.5 w-3.5 text-stone-600 shrink-0" />
                    <div>
                      <div className="font-medium">全库文稿直检</div>
                      <div className="text-[11px] text-stone-500">宽屏查验 .bib / 配置 / 源码行号</div>
                    </div>
                  </button>
                  <div className="my-1 border-t border-stone-100" />
                  <button
                    type="button"
                    onClick={() => {
                      setUtilityDrawer('scratchpad');
                      setMoreMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-stone-50 flex items-center gap-2 text-stone-800"
                  >
                    <FlaskConical className="h-3.5 w-3.5 text-stone-600 shrink-0" />
                    <div>
                      <div className="font-medium">自由推敲沙盒</div>
                      <div className="text-[11px] text-stone-500">右侧抽屉 · 实时词元比对</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setUtilityDrawer('workflow');
                      setMoreMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-stone-50 flex items-center gap-2 text-stone-800"
                  >
                    <Layers className="h-3.5 w-3.5 text-stone-600 shrink-0" />
                    <div>
                      <div className="font-medium">协作流程规范</div>
                      <div className="text-[11px] text-stone-500">右侧抽屉 · 查阅与复制规范</div>
                    </div>
                  </button>

                  {/* Dynamically shown ONLY when the mounted target repo provides its own dashboard HTML */}
                  {repoStatus?.hasCustomDashboard && (
                    <>
                      <div className="my-1 border-t border-stone-100" />
                      <a
                        href="/api/repo/dashboard"
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setMoreMenuOpen(false)}
                        className="w-full text-left px-3 py-2 hover:bg-stone-50 flex items-center justify-between gap-2 text-stone-800"
                      >
                        <span className="flex items-center gap-2">
                          <LayoutDashboard className="h-3.5 w-3.5 text-stone-600 shrink-0" />
                          <span>
                            <span className="block font-medium">仓库自定义速查页</span>
                            <span className="block text-[11px] text-stone-500">
                              来自目标仓库 · 新标签页打开
                            </span>
                          </span>
                        </span>
                        <ExternalLink className="h-3.5 w-3.5 text-stone-400 shrink-0" />
                      </a>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Export Action Brief Button */}
            <button
              type="button"
              onClick={() => setShowExportModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-stone-900 bg-stone-900 hover:bg-stone-800 text-white text-xs font-medium transition-colors whitespace-nowrap shrink-0 tabular-nums"
            >
              <ClipboardList className="h-3.5 w-3.5" />
              导出指令包{reviewCounts.actionable > 0 ? ` · ${reviewCounts.actionable}` : ''}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-4 space-y-4">
        {/* Compact Single-Line Dynamic Git & Repo Switcher Strip */}
        <section
          aria-label="目标仓库与分支比对控制条"
          className="bg-white border border-stone-200/90 rounded px-3.5 py-2 shadow-2xs text-xs space-y-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Left: Target Repo Picker + Base vs Head Dropdowns + Status */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-stone-600 min-w-0">
              <button
                type="button"
                onClick={() => {
                  setMountError(null);
                  setShowRepoModal(true);
                }}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-stone-300 bg-stone-50 hover:bg-stone-100 text-stone-900 font-mono font-medium transition-colors whitespace-nowrap shrink-0"
                title="点击设置或切换目标 GitHub 仓库 (owner/repo)"
              >
                <FolderGit2 className="h-3.5 w-3.5 text-stone-700 shrink-0" />
                <span className="truncate max-w-[200px]">
                  {activeRepoSlug || '设置目标仓库 (owner/repo)'}
                </span>
              </button>

              {repoStatus?.cloned && (
                <>
                  <span className="text-stone-300">·</span>
                  {/* Base Branch Selector */}
                  <label className="inline-flex items-center gap-1 whitespace-nowrap">
                    <span className="text-stone-500">基准</span>
                    <select
                      aria-label="选择基准分支"
                      value={baseRef}
                      onChange={(e) => {
                        const next = e.target.value;
                        setBaseRef(next);
                        loadDiff(next, targetRef);
                      }}
                      className="rounded border border-stone-200 bg-stone-50 px-2 py-0.5 font-mono text-xs text-stone-900 focus:border-stone-700 focus:outline-none max-w-[140px]"
                    >
                      {branchOptions.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </label>

                  <span className="font-mono text-stone-400">vs</span>

                  {/* Target Branch / PR / Working Tree Selector */}
                  <label className="inline-flex items-center gap-1 whitespace-nowrap">
                    <span className="text-stone-500">审阅</span>
                    <select
                      aria-label="选择审阅目标分支、PR 或当前工作区"
                      value={targetRef}
                      onChange={(e) => {
                        const next = e.target.value;
                        setTargetRef(next);
                        loadDiff(baseRef, next);
                      }}
                      className="rounded border border-stone-300 bg-white px-2 py-0.5 font-mono text-xs text-stone-900 focus:border-stone-800 focus:outline-none max-w-[220px]"
                    >
                      <option value="WORKING_TREE">
                        当前工作区{repoStatus.hasLocalDraftEdits ? ` (${repoStatus.dirtyCount} 改动)` : ''}
                      </option>
                      <option value="HEAD">本地 HEAD ({activeCommit})</option>
                      {pulls.length > 0 && (
                        <optgroup label="开放 Pull Requests">
                          {pulls.map((pr) => (
                            <option key={`pr-${pr.number}`} value={`pr/${pr.number}`}>
                              PR #{pr.number}: {pr.title.slice(0, 34)}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label="仓库分支">
                        {branchOptions.map((b) => (
                          <option key={`t-${b}`} value={b}>
                            {b}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </label>

                  <span className="hidden sm:inline text-stone-300">·</span>
                  <span className="hidden sm:inline font-mono tabular-nums text-stone-500">
                    HEAD <strong className="text-stone-800">{activeCommit}</strong>
                  </span>
                  {lastSyncedAt && (
                    <>
                      <span className="hidden lg:inline text-stone-300">·</span>
                      <span className="hidden lg:inline font-mono tabular-nums text-stone-400">
                        已暂存 {new Date(lastSyncedAt).toLocaleTimeString()}
                      </span>
                    </>
                  )}
                </>
              )}
            </div>

            {/* Right: Sync + Dynamic Verification Runner */}
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleSyncGithub}
                disabled={syncingGithub}
                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-stone-200 bg-stone-50 hover:bg-stone-100 text-stone-700 font-medium disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`h-3 w-3 ${syncingGithub ? 'animate-spin' : ''}`} />
                {syncingGithub ? '同步中...' : '拉取同步'}
              </button>

              {repoStatus?.cloned && (
                <button
                  type="button"
                  onClick={handleRunTests}
                  disabled={runningTests || repoStatus.detectedScripts.length === 0}
                  title={
                    repoStatus.detectedScripts.length > 0
                      ? `运行目标仓库内检测到的 ${repoStatus.detectedScripts.length} 项校验脚本`
                      : '当前目标仓库 scripts/ 下未检测到可自动运行的校验脚本'
                  }
                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 font-medium disabled:opacity-45 whitespace-nowrap shrink-0 tabular-nums"
                >
                  <Play className="h-3 w-3 text-stone-600" />
                  {runningTests
                    ? '校验中...'
                    : repoStatus.detectedScripts.length > 0
                    ? `守卫校验 (${repoStatus.detectedScripts.length})`
                    : '无校验脚本'}
                </button>
              )}
            </div>
          </div>

          {/* Dynamic Test Results Tray */}
          {testResults && showTestDetails && (
            <div className="pt-2 border-t border-stone-100 flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
              <div className="flex flex-wrap items-center gap-2.5">
                <span
                  className={
                    testResults.allPassed
                      ? 'text-emerald-700 font-semibold'
                      : 'text-rose-700 font-semibold'
                  }
                >
                  {testResults.detectedCount === 0
                    ? '未检测到仓库内置校验脚本'
                    : testResults.allPassed
                    ? '✓ 仓库校验全部通过：'
                    : '⚠ 部分校验发现异常：'}
                </span>
                {testResults.results.map((r) => (
                  <span key={r.name} className="text-stone-600">
                    {r.name}: {r.summary}
                  </span>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setShowTestDetails(false)}
                className="text-stone-400 hover:text-stone-600 font-sans whitespace-nowrap"
              >
                收起
              </button>
            </div>
          )}
        </section>

        {/* Modals & Drawers */}
        <RepoConfigModal
          open={showRepoModal}
          onClose={() => setShowRepoModal(false)}
          currentRepoSlug={activeRepoSlug}
          currentBaseBranch={repoStatus?.defaultBase || 'main'}
          hasToken={Boolean(repoStatus?.hasToken)}
          mounting={mountingRepo}
          errorMessage={mountError}
          onMount={handleMountRepo}
        />

        <ExportBriefModal
          open={showExportModal}
          onClose={() => setShowExportModal(false)}
          repoSlug={activeRepoSlug}
          compareLabel={compareLabel || `${baseRef} ... ${targetRef}`}
          markdownActionable={markdownBriefActionable}
          markdownAll={markdownBriefAll}
          recordJson={generatedChangeRecordJson}
          branch={activeBranch}
          baseCommit={activeCommit}
          actionableCount={reviewCounts.actionable}
          onCopy={handleCopy}
        />

        <UtilityDrawer
          mode={utilityDrawer}
          onClose={() => setUtilityDrawer('closed')}
          onSwitchMode={(next) => setUtilityDrawer(next)}
          scratchBefore={scratchBefore}
          scratchAfter={scratchAfter}
          onChangeBefore={setScratchBefore}
          onChangeAfter={setScratchAfter}
          scratchPreview={
            <HighlightedDiffBlock
              oldText={scratchBefore}
              newText={scratchAfter}
              mode={viewMode === 'inline' ? 'inline' : 'side-by-side'}
              baselineLabel="基准文本 (Before)"
              afterLabel="沙盒修改稿 (After)"
              fontSizeClass={fontSizeClass}
            />
          }
          workflowSpec={workflowSpec}
          repoSlug={activeRepoSlug}
          branch={activeBranch}
          baseCommit={activeCommit}
          onCopy={handleCopy}
        />

        {/* UNMOUNTED STATE */}
        {!repoStatus?.cloned && (
          <section className="bg-white border border-stone-200/90 rounded p-8 sm:p-12 text-center space-y-5 max-w-3xl mx-auto">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-lg border border-stone-200 bg-stone-50 text-stone-800 mx-auto">
              <GitBranch className="h-5 w-5" />
            </div>
            <div className="space-y-2">
              <h2 className="text-lg font-semibold text-stone-900">
                挂载任意学术文稿 GitHub 仓库开始研审
              </h2>
              <p className="text-sm text-stone-600 leading-relaxed max-w-xl mx-auto">
                输入任意公开或授权访问的 <code className="font-mono text-stone-900">owner/repo</code>，系统将在单工作区{' '}
                <code className="font-mono text-stone-900">/tmp/target-repo</code> 中自动识别中英文双语配对文稿（
                <code className="font-mono">.qmd</code> / <code className="font-mono">.tex</code> /{' '}
                <code className="font-mono">.md</code> / <code className="font-mono">.bib</code>
                ），开启词元级 Diff 比对、AI 洁净读屏协作与合卷单章精读。
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => {
                  setMountError(null);
                  setShowRepoModal(true);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-stone-900 hover:bg-stone-800 text-white text-xs font-medium whitespace-nowrap"
              >
                <FolderGit2 className="h-4 w-4" />
                设置并挂载目标仓库
              </button>
              <button
                type="button"
                onClick={() => setUtilityDrawer('scratchpad')}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded border border-stone-300 bg-white hover:bg-stone-50 text-stone-800 text-xs font-medium whitespace-nowrap"
              >
                <FlaskConical className="h-4 w-4" />
                先试用自由推敲沙盒
              </button>
            </div>
          </section>
        )}

        {/* VIEW 1: DYNAMIC GIT DIFF TOKEN REVIEW */}
        {repoStatus?.cloned && activeTab === 'diff' && (
          <section className="space-y-4">
            {/* Compact Review Control Bar */}
            <div className="bg-white border border-stone-200/90 rounded p-3.5 shadow-2xs space-y-3">
              {/* Row 1: Search + Expand/Collapse + Language */}
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="relative flex-1 min-w-[200px] max-w-md">
                  <Search className="h-3.5 w-3.5 absolute left-2.5 top-2 text-stone-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="检索变更文件、正文关键词或批注..."
                    className="w-full pl-8 pr-7 py-1.5 rounded border border-stone-200 bg-stone-50/70 text-xs text-stone-800 placeholder-stone-400 focus:outline-none focus:border-stone-600 focus:bg-white"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2 top-2 text-stone-400 hover:text-stone-600"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <div className="inline-flex rounded border border-stone-200 bg-stone-100 p-0.5">
                    <button
                      type="button"
                      onClick={() => setActiveLang('both')}
                      className={`px-2 py-1 rounded transition-colors whitespace-nowrap shrink-0 ${
                        activeLang === 'both'
                          ? 'bg-stone-900 text-white font-medium'
                          : 'text-stone-700 hover:text-stone-900'
                      }`}
                    >
                      中英同屏
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveLang('zh')}
                      className={`px-2 py-1 rounded transition-colors whitespace-nowrap shrink-0 ${
                        activeLang === 'zh'
                          ? 'bg-stone-900 text-white font-medium'
                          : 'text-stone-700 hover:text-stone-900'
                      }`}
                    >
                      仅看主稿
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveLang('en')}
                      className={`px-2 py-1 rounded transition-colors whitespace-nowrap shrink-0 ${
                        activeLang === 'en'
                          ? 'bg-stone-900 text-white font-medium'
                          : 'text-stone-700 hover:text-stone-900'
                      }`}
                    >
                      仅看译稿
                    </button>
                  </div>

                  {filteredSections.length > 0 && (
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={expandAllFilteredSections}
                        className="px-2 py-1 rounded border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 whitespace-nowrap shrink-0"
                      >
                        全部展开
                      </button>
                      <button
                        type="button"
                        onClick={collapseAllFilteredSections}
                        className="px-2 py-1 rounded border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 whitespace-nowrap shrink-0"
                      >
                        全部收起
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Row 2: View Mode + Font Size + Overview & Global Edit */}
              <div className="pt-2.5 border-t border-stone-100 flex flex-wrap items-center justify-between gap-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex rounded border border-stone-200 bg-stone-100 p-0.5">
                    <button
                      type="button"
                      onClick={() => setViewMode('side-by-side')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded transition-colors whitespace-nowrap shrink-0 ${
                        viewMode === 'side-by-side'
                          ? 'bg-stone-900 text-white font-medium'
                          : 'text-stone-700 hover:text-stone-900'
                      }`}
                    >
                      <Columns className="h-3 w-3" />
                      并排对比
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('inline')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded transition-colors whitespace-nowrap shrink-0 ${
                        viewMode === 'inline'
                          ? 'bg-stone-900 text-white font-medium'
                          : 'text-stone-700 hover:text-stone-900'
                      }`}
                    >
                      <AlignLeft className="h-3 w-3" />
                      行内融合
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('clean-ai')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded transition-colors whitespace-nowrap shrink-0 ${
                        viewMode === 'clean-ai'
                          ? 'bg-emerald-800 text-white font-medium'
                          : 'text-stone-700 hover:text-stone-900'
                      }`}
                    >
                      <Eye className="h-3 w-3" />
                      洁净读屏 (Gemini)
                    </button>
                  </div>

                  {/* Font Size */}
                  <div className="inline-flex items-center gap-1 text-stone-600 border border-stone-200 rounded px-1.5 py-0.5 bg-stone-50">
                    <Type className="h-3 w-3 text-stone-400" />
                    {(['sm', 'md', 'lg'] as const).map((sz) => (
                      <button
                        key={sz}
                        type="button"
                        onClick={() => setFontSize(sz)}
                        className={`px-1 rounded ${
                          fontSize === sz ? 'font-bold text-stone-900' : 'text-stone-500'
                        }`}
                      >
                        {sz === 'sm' ? '小' : sz === 'md' ? '中' : '大'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  {diffSections.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowDiffOverview((prev) => !prev)}
                      aria-expanded={showDiffOverview}
                      className="inline-flex items-center gap-1 text-stone-600 hover:text-stone-900 whitespace-nowrap shrink-0"
                    >
                      <Sparkles className="h-3 w-3" />
                      {showDiffOverview ? '收起变更目录' : '变更卡片速览'}
                    </button>
                  )}

                  {!isCleanAiMode && diffSections.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setGlobalEditOpen(!globalEditOpen)}
                      className="inline-flex items-center gap-1 text-stone-700 hover:text-stone-900 font-medium whitespace-nowrap shrink-0"
                    >
                      <Edit3 className="h-3 w-3" />
                      {globalEditOpen ? '收起全部编辑框' : '展开全部编辑框'}
                    </button>
                  )}
                </div>
              </div>

              {/* Row 3: Review Status Filter Bar */}
              {diffSections.length > 0 && (
                <div className="pt-2.5 border-t border-stone-100 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-stone-500 mr-1">审阅筛选：</span>
                    {(
                      [
                        { id: 'all', label: '全部', count: totalParagraphs },
                        { id: 'pending', label: '待审', count: reviewCounts.pending },
                        { id: 'discuss', label: '需讨论', count: reviewCounts.discuss },
                        { id: 'approved', label: '已确认', count: reviewCounts.approved },
                        { id: 'modified', label: '有微调', count: modifiedCount },
                      ] as const
                    ).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setStatusFilter(item.id)}
                        className={`px-2 py-0.5 rounded border transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                          statusFilter === item.id
                            ? 'border-stone-900 bg-stone-900 text-white font-medium'
                            : 'border-stone-200 bg-stone-50 hover:bg-stone-100 text-stone-700'
                        }`}
                      >
                        {item.label} ({item.count})
                      </button>
                    ))}
                  </div>
                  {statusFilter !== 'all' && (
                    <button
                      type="button"
                      onClick={() => setStatusFilter('all')}
                      className="text-stone-500 hover:text-stone-900 whitespace-nowrap"
                    >
                      重置筛选
                    </button>
                  )}
                </div>
              )}

              {/* AI Clean Reader Mode Banner */}
              {isCleanAiMode && diffSections.length > 0 && (
                <div className="px-3 py-2 rounded border border-emerald-200 bg-emerald-50/70 flex flex-wrap items-center justify-between gap-2 text-xs text-emerald-950">
                  <span>
                    <strong>AI 洁净读屏已开启：</strong>
                    已隐藏所有红绿删除线与旧版对照，当前页面仅呈现最新文本、精确行号与审阅批注。
                  </span>
                  {expandedFilteredCount < filteredSections.length && (
                    <button
                      type="button"
                      onClick={expandAllFilteredSections}
                      className="px-2.5 py-1 rounded bg-emerald-800 hover:bg-emerald-900 text-white font-medium whitespace-nowrap shrink-0"
                    >
                      展开全部 {filteredSections.length} 张卡片供读屏
                    </button>
                  )}
                </div>
              )}

              {/* Dynamic Overview */}
              {showDiffOverview && diffSections.length > 0 && (
                <div className="p-3 bg-stone-50/90 rounded border border-stone-200/80 text-xs text-stone-700 space-y-1.5">
                  <div className="font-semibold text-stone-900">
                    当前对比变更速览（{compareLabel} · 共 {diffSections.length} 张卡片）
                  </div>
                  <ol className="space-y-1 text-stone-600 list-decimal list-inside">
                    {diffSections.map((sec) => (
                      <li key={sec.id} className="leading-relaxed">
                        <span className="font-medium text-stone-800">{sec.shortTitle}</span>
                        <span className="text-stone-400"> · </span>
                        <span className="font-mono text-stone-500">{sec.location}</span>
                        <span className="text-stone-400"> · </span>
                        <span className="font-mono tabular-nums">{sec.paragraphs.length} 处区块</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>

            {/* Loading / Error / Empty / Diff Cards */}
            {diffLoading ? (
              <div className="bg-white border border-stone-200/90 rounded p-10 text-center text-xs text-stone-500">
                正在基于 Git 差异引擎计算词元比对卡片...
              </div>
            ) : diffError ? (
              <div className="bg-white border border-rose-200 rounded p-8 text-center space-y-3">
                <p className="text-sm font-medium text-rose-800">{diffError}</p>
                <button
                  type="button"
                  onClick={() => loadDiff(baseRef, targetRef)}
                  className="px-3 py-1.5 rounded border border-stone-300 bg-white hover:bg-stone-50 text-xs font-medium text-stone-800"
                >
                  重新加载比对
                </button>
              </div>
            ) : diffSections.length === 0 ? (
              <div className="bg-white border border-stone-200/90 rounded p-10 text-center space-y-3.5">
                <p className="text-sm font-semibold text-stone-900">
                  当前对比区间（{compareLabel || `${baseRef} ... ${targetRef}`}）暂无文本差异
                </p>
                <p className="text-xs text-stone-500 max-w-lg mx-auto leading-relaxed">
                  可在上方「审阅」下拉框切换至其他修订分支或开放 PR，或直接进入「合卷全文阅读」精读当前仓库全文，亦可在「全库文稿直检」中编辑文件后实时查看工作区差异。
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setReturnTab('fullvolume');
                      setActiveTab('fullvolume');
                    }}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-stone-900 hover:bg-stone-800 text-white text-xs font-medium whitespace-nowrap"
                  >
                    <BookOpen className="h-3.5 w-3.5" />
                    进入合卷全文阅读
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setReturnTab('diff');
                      setActiveTab('inspector');
                    }}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded border border-stone-300 bg-white hover:bg-stone-50 text-stone-800 text-xs font-medium whitespace-nowrap"
                  >
                    <FileCode2 className="h-3.5 w-3.5" />
                    打开全库文稿直检
                  </button>
                </div>
              </div>
            ) : filteredSections.length === 0 ? (
              <div className="bg-white border border-stone-200/90 rounded p-10 text-center space-y-3">
                <p className="text-sm font-medium text-stone-800">当前筛选或搜索条件下无匹配卡片</p>
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setStatusFilter('all');
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-stone-300 bg-white hover:bg-stone-50 text-xs font-medium text-stone-800"
                >
                  重置筛选条件
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredSections.map((sec, secIdx) => {
                  const isExpanded = isSectionExpanded(sec.id);
                  const secMeta = getReviewEntry(reviewMeta, sec.id);
                  const secNoteOpen =
                    !!openNotes[sec.id] || (isCleanAiMode && secMeta.note.trim().length > 0);
                  const secModifiedCount = sec.paragraphs.filter((p) => isManuallyModified(p)).length;
                  const secDiscussCount = sec.paragraphs.filter(
                    (p) => getReviewEntry(reviewMeta, p.id).status === 'discuss'
                  ).length;
                  const nextSec = secIdx < filteredSections.length - 1 ? filteredSections[secIdx + 1] : null;
                  const orderNumber = String(secIdx + 1).padStart(2, '0');

                  return (
                    <article
                      key={sec.id}
                      id={`diff-section-${sec.id}`}
                      className={`scroll-mt-16 bg-white border rounded transition-colors ${
                        isExpanded
                          ? 'border-stone-300 shadow-2xs'
                          : 'border-stone-200/90 hover:border-stone-300'
                      }`}
                    >
                      {/* Card Header */}
                      <div
                        className={`px-4 py-3 flex flex-wrap items-start justify-between gap-3 transition-colors rounded ${
                          isExpanded ? 'bg-stone-50/70 rounded-b-none' : 'bg-white hover:bg-stone-50/60'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => toggleSectionExpanded(sec.id)}
                          aria-expanded={isExpanded}
                          aria-controls={`diff-section-panel-${sec.id}`}
                          className="flex items-start gap-2.5 text-left min-w-0 flex-1"
                        >
                          <span className="mt-0.5 text-stone-500 shrink-0">
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4 text-stone-800" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-stone-500" />
                            )}
                          </span>

                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                              <span className="text-xs font-mono tabular-nums text-stone-400">
                                {orderNumber}
                              </span>
                              <h2 className="text-sm font-semibold text-stone-900">{sec.shortTitle}</h2>
                              <span className="text-xs text-stone-500">
                                {sec.kind === 'bilingual' ? '双语配对' : '单文件'}
                              </span>
                            </div>

                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-stone-500">
                              <span className="text-stone-700">{sec.chapter}</span>
                              <span className="text-stone-300">·</span>
                              <span className="font-mono break-all">{sec.location}</span>
                              <span className="text-stone-300">·</span>
                              <span className="font-mono tabular-nums text-emerald-700">
                                +{sec.stats.additions}
                              </span>
                              <span className="font-mono tabular-nums text-rose-700">
                                -{sec.stats.deletions}
                              </span>
                              <span className="text-stone-300">·</span>
                              <span className="font-mono tabular-nums">{sec.paragraphs.length} 处区块</span>
                              {secDiscussCount > 0 && (
                                <>
                                  <span className="text-stone-300">·</span>
                                  <span className="font-mono text-amber-800 font-medium tabular-nums">
                                    需讨论 {secDiscussCount}
                                  </span>
                                </>
                              )}
                              {secModifiedCount > 0 && (
                                <>
                                  <span className="text-stone-300">·</span>
                                  <span className="font-mono text-amber-800 font-medium tabular-nums">
                                    微调 {secModifiedCount}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </button>

                        {/* Card Actions */}
                        <div className="flex flex-wrap items-center gap-1.5 text-xs shrink-0">
                          <button
                            type="button"
                            onClick={() => handleCycleReviewStatus(sec.id)}
                            className={`px-2 py-0.5 rounded border font-medium transition-colors whitespace-nowrap shrink-0 ${statusTone(
                              secMeta.status
                            )}`}
                          >
                            {REVIEW_STATUS_LABEL[secMeta.status]}
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              setOpenNotes((prev) => ({ ...prev, [sec.id]: !prev[sec.id] }))
                            }
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border transition-colors whitespace-nowrap shrink-0 ${
                              secMeta.note.trim()
                                ? 'border-amber-200 bg-amber-50/70 text-amber-900'
                                : 'border-stone-200 bg-white hover:bg-stone-50 text-stone-600'
                            }`}
                          >
                            <MessageSquare className="h-3 w-3" />
                            {secMeta.note.trim() ? '有批注' : '批注'}
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              const packet = buildSectionGeminiPacket({
                                repoSlug: activeRepoSlug,
                                section: sec,
                                sectionReview: secMeta,
                                reviewMeta,
                                getCn: (p) => getEffectiveAfter(p, 'zh'),
                                getEn: (p) => getEffectiveAfter(p, 'en'),
                                lang: activeLang,
                              });
                              handleCopy(
                                `sec-gemini-${sec.id}`,
                                packet,
                                `已复制「${sec.shortTitle}」整卡审阅包`
                              );
                            }}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-stone-300 bg-white hover:bg-stone-100 text-stone-800 font-medium whitespace-nowrap shrink-0"
                          >
                            <Send className="h-3 w-3 text-stone-600" />
                            复制给 Gemini
                          </button>

                          <button
                            type="button"
                            onClick={() => toggleSectionExpanded(sec.id)}
                            className="px-1.5 py-0.5 text-stone-500 hover:text-stone-900 font-mono whitespace-nowrap shrink-0"
                          >
                            {isExpanded ? '收起' : '展开'}
                          </button>
                        </div>
                      </div>

                      {/* Section Note */}
                      {secNoteOpen && (
                        <div className="px-4 py-2.5 border-t border-stone-200/70 bg-amber-50/30 space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium text-stone-800">
                              卡片审阅批注 / 待讨论事项
                            </span>
                            {!isCleanAiMode && (
                              <button
                                type="button"
                                onClick={() => setOpenNotes((prev) => ({ ...prev, [sec.id]: false }))}
                                className="text-stone-400 hover:text-stone-700"
                              >
                                收起批注框
                              </button>
                            )}
                          </div>
                          {isCleanAiMode ? (
                            <p className="text-xs text-stone-800 leading-relaxed whitespace-pre-wrap">
                              {secMeta.note}
                            </p>
                          ) : (
                            <textarea
                              value={secMeta.note}
                              onChange={(e) => handleReviewNoteChange(sec.id, e.target.value)}
                              rows={2}
                              placeholder="记录本卡片待核查、待讨论或下轮修改的要点（按仓库与分支自动隔离保存）..."
                              className="w-full rounded border border-stone-300 bg-white px-2.5 py-1.5 text-xs text-stone-800 focus:border-stone-800 focus:outline-none"
                            />
                          )}
                        </div>
                      )}

                      {/* Card Body */}
                      {isExpanded && (
                        <div
                          id={`diff-section-panel-${sec.id}`}
                          className="border-t border-stone-200/80 px-4 py-4 space-y-4"
                        >
                          <div className="text-xs text-stone-600 leading-relaxed bg-stone-50/90 px-3.5 py-2 rounded border border-stone-200/70 font-mono">
                            {sec.issue}
                          </div>

                          <div className="divide-y divide-stone-200/80">
                            {sec.paragraphs.map((pair, idx) => {
                              const isCardEditorOpen =
                                !isCleanAiMode &&
                                (openEditors[pair.id] !== undefined
                                  ? openEditors[pair.id]
                                  : globalEditOpen);
                              const modified = isManuallyModified(pair);
                              const pMeta = getReviewEntry(reviewMeta, pair.id);
                              const pNoteOpen =
                                !!openNotes[pair.id] ||
                                (isCleanAiMode && pMeta.note.trim().length > 0);
                              const currentCn = getEffectiveAfter(pair, 'zh');
                              const currentEn = getEffectiveAfter(pair, 'en');

                              const showCnBlock =
                                pair.hasCn && (activeLang === 'zh' || activeLang === 'both' || !pair.hasEn);
                              const showEnBlock =
                                pair.hasEn && (activeLang === 'en' || activeLang === 'both' || !pair.hasCn);

                              return (
                                <section
                                  key={pair.id}
                                  className={`py-4 first:pt-1 last:pb-1 space-y-3 ${
                                    modified && !isCleanAiMode ? 'bg-amber-50/30 -mx-2 px-2 rounded' : ''
                                  }`}
                                >
                                  {/* Hunk Header */}
                                  <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-stone-100">
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                      <h3 className="text-xs font-semibold text-stone-900">
                                        {idx + 1}. {pair.label}
                                      </h3>
                                      <span className="text-xs font-mono text-stone-500">
                                        {pair.hasCn && pair.hasEn
                                          ? `· 主稿 ${pair.cnLines} / 译稿 ${pair.enLines}`
                                          : pair.hasCn
                                          ? `· ${pair.cnLines}`
                                          : `· ${pair.enLines}`}
                                      </span>
                                      {modified && (
                                        <span className="text-xs font-mono text-amber-800">
                                          · 已手动微调
                                        </span>
                                      )}
                                    </div>

                                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                      <button
                                        type="button"
                                        onClick={() => handleCycleReviewStatus(pair.id)}
                                        className={`px-2 py-0.5 rounded border font-medium transition-colors whitespace-nowrap shrink-0 ${statusTone(
                                          pMeta.status
                                        )}`}
                                      >
                                        {REVIEW_STATUS_LABEL[pMeta.status]}
                                      </button>

                                      <button
                                        type="button"
                                        onClick={() =>
                                          setOpenNotes((prev) => ({
                                            ...prev,
                                            [pair.id]: !prev[pair.id],
                                          }))
                                        }
                                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border transition-colors whitespace-nowrap shrink-0 ${
                                          pMeta.note.trim()
                                            ? 'border-amber-200 bg-amber-50/70 text-amber-900'
                                            : 'border-stone-200 bg-white hover:bg-stone-50 text-stone-600'
                                        }`}
                                      >
                                        <MessageSquare className="h-3 w-3" />
                                        {pMeta.note.trim() ? '有批注' : '批注'}
                                      </button>

                                      <button
                                        type="button"
                                        onClick={() => {
                                          const packet = buildParagraphGeminiPacket({
                                            repoSlug: activeRepoSlug,
                                            section: sec,
                                            pair,
                                            baselineLabel: baseRef,
                                            baseCn: pair.cnBefore,
                                            currentCn,
                                            baseEn: pair.enBefore,
                                            currentEn,
                                            review: pMeta,
                                            lang: activeLang,
                                          });
                                          handleCopy(
                                            `pair-gemini-${pair.id}`,
                                            packet,
                                            `已复制「${pair.label}」审阅提示包`
                                          );
                                        }}
                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-stone-300 bg-white hover:bg-stone-100 text-stone-800 font-medium whitespace-nowrap shrink-0"
                                      >
                                        <Send className="h-3 w-3 text-stone-600" />
                                        复制给 Gemini
                                      </button>

                                      {!isCleanAiMode && (
                                        <>
                                          <button
                                            type="button"
                                            onClick={() => handleCopyBilingualMarkdown(pair)}
                                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-stone-200 bg-stone-50 hover:bg-stone-100 text-stone-700 whitespace-nowrap shrink-0"
                                          >
                                            <Copy className="h-3 w-3 text-stone-500" />
                                            复制文本
                                          </button>

                                          <button
                                            type="button"
                                            onClick={() =>
                                              setOpenEditors((prev) => ({
                                                ...prev,
                                                [pair.id]: !isCardEditorOpen,
                                              }))
                                            }
                                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-stone-300 bg-white hover:bg-stone-50 text-stone-800 font-medium whitespace-nowrap shrink-0"
                                          >
                                            <Edit3 className="h-3 w-3 text-stone-600" />
                                            {isCardEditorOpen ? '收起编辑' : '在线推敲'}
                                          </button>

                                          {modified && (
                                            <button
                                              type="button"
                                              onClick={() => handleResetToCurrent(pair)}
                                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100 whitespace-nowrap shrink-0"
                                            >
                                              <RotateCcw className="h-3 w-3" />
                                              恢复原稿
                                            </button>
                                          )}

                                          <button
                                            type="button"
                                            onClick={() => handleLoadBaseline(pair)}
                                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-stone-200 bg-white text-stone-600 hover:bg-stone-50 whitespace-nowrap shrink-0"
                                          >
                                            载入基准
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  </div>

                                  {/* Paragraph Note */}
                                  {pNoteOpen && (
                                    <div className="px-3 py-2 rounded border border-amber-200/80 bg-amber-50/40 space-y-1">
                                      <div className="flex items-center justify-between text-xs">
                                        <span className="font-medium text-amber-950">
                                          区块批注 / 待讨论要点：
                                        </span>
                                        {!isCleanAiMode && (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setOpenNotes((prev) => ({ ...prev, [pair.id]: false }))
                                            }
                                            className="text-stone-400 hover:text-stone-700"
                                          >
                                            收起
                                          </button>
                                        )}
                                      </div>
                                      {isCleanAiMode ? (
                                        <p className="text-xs text-stone-800 leading-relaxed whitespace-pre-wrap">
                                          {pMeta.note}
                                        </p>
                                      ) : (
                                        <textarea
                                          value={pMeta.note}
                                          onChange={(e) =>
                                            handleReviewNoteChange(pair.id, e.target.value)
                                          }
                                          rows={2}
                                          placeholder="输入待讨论问题、术语意见或改稿指令..."
                                          className="w-full rounded border border-stone-300 bg-white px-2.5 py-1.5 text-xs text-stone-800 focus:border-stone-800 focus:outline-none"
                                        />
                                      )}
                                    </div>
                                  )}

                                  {/* Primary / Chinese Block */}
                                  {showCnBlock && (
                                    <div className="space-y-2">
                                      <div className="flex items-center justify-between text-xs text-stone-500 font-mono">
                                        <span className="truncate">
                                          {pair.hasEn ? '主稿' : '文件'} · {pair.fileCn ?? sec.fileCn} (
                                          {pair.cnLines})
                                        </span>
                                        {!isCleanAiMode && (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              handleCopy(`${pair.id}-zh`, currentCn, '已复制主稿文本')
                                            }
                                            className="hover:text-stone-800 flex items-center gap-1 whitespace-nowrap shrink-0"
                                          >
                                            <Copy className="h-3 w-3" />
                                            复制
                                          </button>
                                        )}
                                      </div>

                                      {isCardEditorOpen && (
                                        <div className="p-3 rounded border border-stone-300 bg-stone-50/50 space-y-1.5">
                                          <div className="flex items-center justify-between text-xs text-stone-600">
                                            <span className="font-semibold text-stone-800">
                                              在线推敲微调：
                                            </span>
                                            <span className="font-mono tabular-nums text-stone-500">
                                              {currentCn.length} 字符
                                            </span>
                                          </div>
                                          <textarea
                                            value={currentCn}
                                            onChange={(e) =>
                                              handleEditChange(pair.id, 'zh', e.target.value)
                                            }
                                            rows={Math.max(4, Math.min(10, Math.ceil(currentCn.length / 55)))}
                                            className="w-full rounded border border-stone-300 bg-white p-2.5 font-serif text-[13.5px] leading-relaxed text-stone-900 focus:border-stone-800 focus:outline-none"
                                          />
                                        </div>
                                      )}

                                      {isCleanAiMode ? (
                                        <div
                                          className={`rounded border border-stone-200 bg-white p-3.5 font-serif ${fontSizeClass} leading-relaxed text-stone-900 whitespace-pre-wrap`}
                                        >
                                          {currentCn}
                                        </div>
                                      ) : (
                                        <HighlightedDiffBlock
                                          oldText={pair.cnBefore}
                                          newText={currentCn}
                                          mode={viewMode}
                                          baselineLabel={baseRef}
                                          afterLabel={
                                            modified
                                              ? '工作台微调稿 (*)'
                                              : targetRef === 'WORKING_TREE'
                                              ? '当前工作区'
                                              : targetRef
                                          }
                                          fontSizeClass={fontSizeClass}
                                        />
                                      )}
                                    </div>
                                  )}

                                  {/* Counterpart / English Block */}
                                  {showEnBlock && (
                                    <div
                                      className={`space-y-2 ${
                                        showCnBlock ? 'pt-3 border-t border-stone-200/80' : ''
                                      }`}
                                    >
                                      <div className="flex items-center justify-between text-xs text-stone-500 font-mono">
                                        <span className="truncate">
                                          译稿 / EN · {pair.fileEn ?? sec.fileEn} ({pair.enLines})
                                        </span>
                                        {!isCleanAiMode && (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              handleCopy(`${pair.id}-en`, currentEn, '已复制英文译稿')
                                            }
                                            className="hover:text-stone-800 flex items-center gap-1 whitespace-nowrap shrink-0"
                                          >
                                            <Copy className="h-3 w-3" />
                                            复制
                                          </button>
                                        )}
                                      </div>

                                      {isCardEditorOpen && (
                                        <div className="p-3 rounded border border-stone-300 bg-stone-50/50 space-y-1.5">
                                          <div className="flex items-center justify-between text-xs text-stone-600">
                                            <span className="font-semibold text-stone-800">
                                              在线推敲英文译稿：
                                            </span>
                                            <span className="font-mono tabular-nums text-stone-500">
                                              {currentEn.length} chars
                                            </span>
                                          </div>
                                          <textarea
                                            value={currentEn}
                                            onChange={(e) =>
                                              handleEditChange(pair.id, 'en', e.target.value)
                                            }
                                            rows={Math.max(4, Math.min(10, Math.ceil(currentEn.length / 80)))}
                                            className="w-full rounded border border-stone-300 bg-white p-2.5 font-serif text-[13.5px] leading-relaxed text-stone-900 focus:border-stone-800 focus:outline-none"
                                          />
                                        </div>
                                      )}

                                      {isCleanAiMode ? (
                                        <div
                                          className={`rounded border border-stone-200 bg-white p-3.5 font-serif ${fontSizeClass} leading-relaxed text-stone-900 whitespace-pre-wrap`}
                                        >
                                          {currentEn}
                                        </div>
                                      ) : (
                                        <HighlightedDiffBlock
                                          oldText={pair.enBefore}
                                          newText={currentEn}
                                          mode={viewMode}
                                          baselineLabel={baseRef}
                                          afterLabel={
                                            modified
                                              ? 'Workbench Edited (*)'
                                              : targetRef === 'WORKING_TREE'
                                              ? 'Working Tree'
                                              : targetRef
                                          }
                                          fontSizeClass={fontSizeClass}
                                        />
                                      )}
                                    </div>
                                  )}
                                </section>
                              );
                            })}
                          </div>

                          {/* Card Footer */}
                          <div className="pt-3 border-t border-stone-200/80 flex flex-wrap items-center justify-between gap-2 text-xs">
                            <span className="text-stone-500 font-mono tabular-nums">
                              {orderNumber} · {sec.shortTitle} ({sec.paragraphs.length} 处区块)
                            </span>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => collapseSectionAndScroll(sec.id)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 whitespace-nowrap shrink-0"
                              >
                                收起本卡片
                              </button>
                              {nextSec && (
                                <button
                                  type="button"
                                  onClick={() => collapseSectionAndScroll(sec.id, nextSec.id)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-stone-900 bg-stone-900 hover:bg-stone-800 text-white font-medium whitespace-nowrap shrink-0"
                                >
                                  收起并展开下一卡片：{nextSec.shortTitle}
                                  <ChevronRight className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* VIEW 2: FULL-VOLUME BILINGUAL READER */}
        {repoStatus?.cloned && activeTab === 'fullvolume' && (
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {showVolumeToc && (
              <aside className="lg:col-span-3 lg:sticky lg:top-20 space-y-3 bg-white border border-stone-200/90 rounded p-3.5 shadow-2xs max-h-[calc(100vh-6rem)] overflow-y-auto">
                <div className="border-b border-stone-200 pb-2.5 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-stone-900">合卷文稿目录</span>
                    <span className="text-xs font-mono text-stone-500 tabular-nums">
                      {volumeDocs.length} 篇
                    </span>
                  </div>
                  <p className="text-[11px] text-stone-500 leading-relaxed">
                    默认单章独立精读，避免侧边栏 AI 上下文截断；下方检索覆盖全部已发现文稿。
                  </p>
                </div>

                {/* Cross-volume Search */}
                <div className="space-y-1">
                  <div className="relative">
                    <Search className="h-3.5 w-3.5 absolute left-2.5 top-2 text-stone-400" />
                    <input
                      type="text"
                      value={volumeSearch}
                      onChange={(e) => setVolumeSearch(e.target.value)}
                      placeholder="在合卷全文中检索关键词..."
                      className="w-full pl-8 pr-6 py-1.5 rounded border border-stone-200 bg-stone-50/70 text-xs text-stone-800 placeholder-stone-400 focus:outline-none focus:border-stone-500 focus:bg-white"
                    />
                    {volumeSearch && (
                      <button
                        type="button"
                        onClick={() => setVolumeSearch('')}
                        className="absolute right-2 top-2 text-stone-400 hover:text-stone-600"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {volumeSearch.trim() && (() => {
                    const hitDocs = volumeDocs
                      .map((d) => ({ doc: d, lines: getDocSearchMatches(d, volumeSearch) }))
                      .filter((x) => x.lines.length > 0);
                    const totalHits = hitDocs.reduce((acc, x) => acc + x.lines.length, 0);
                    return (
                      <div className="text-[11px] font-mono text-stone-500 px-0.5 tabular-nums">
                        全卷命中 <strong className="text-stone-900">{hitDocs.length}</strong> 篇 · 共{' '}
                        <strong className="text-emerald-700">{totalHits}</strong> 行
                      </div>
                    );
                  })()}
                </div>

                {/* Quick Line Jump */}
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={jumpLineInput}
                    onChange={(e) => setJumpLineInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleJumpToLine();
                    }}
                    placeholder="当前篇跳行 (如 42)..."
                    className="flex-1 min-w-0 px-2.5 py-1 rounded border border-stone-200 bg-white text-xs font-mono text-stone-800 placeholder-stone-400 focus:outline-none focus:border-stone-500"
                  />
                  <button
                    type="button"
                    onClick={handleJumpToLine}
                    className="px-2.5 py-1 rounded bg-stone-900 hover:bg-stone-800 text-white text-xs font-medium shrink-0 whitespace-nowrap"
                  >
                    跳行
                  </button>
                </div>

                {/* Dynamic Document Groups */}
                {volumeGroups.map((grp, gIdx) => (
                  <div
                    key={grp.group}
                    className={`space-y-1 ${gIdx > 0 ? 'pt-2 border-t border-stone-200' : 'pt-1'}`}
                  >
                    <div className="text-[11px] font-semibold text-stone-500 px-1">
                      {grp.label} ({grp.docs.length})
                    </div>
                    {grp.docs.map((doc) => {
                      const isActive = selectedDocId === doc.id;
                      const matchedLines = volumeSearch.trim()
                        ? getDocSearchMatches(doc, volumeSearch)
                        : [];
                      const displayCount =
                        volumeLang === 'en' && doc.hasEn
                          ? doc.enLineCount
                          : volumeLang === 'both' && doc.hasEn
                          ? Math.max(doc.lineCount, doc.enLineCount)
                          : doc.lineCount;
                      return (
                        <button
                          type="button"
                          key={doc.id}
                          onClick={() => handleSelectOrScrollDoc(doc.id, matchedLines[0])}
                          className={`w-full text-left px-2.5 py-2 rounded border transition-colors text-xs ${
                            isActive
                              ? 'border-stone-900 bg-stone-900 text-white font-medium'
                              : matchedLines.length > 0
                              ? 'border-amber-300 bg-amber-50/60 hover:bg-amber-100/70 text-stone-800'
                              : 'border-stone-200/70 bg-stone-50/50 hover:bg-stone-100 text-stone-700'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-semibold truncate">{doc.orderLabel}</span>
                            <span
                              className={`font-mono text-[11px] shrink-0 tabular-nums ${
                                isActive ? 'text-stone-300' : 'text-stone-500'
                              }`}
                            >
                              L1–L{displayCount}
                            </span>
                          </div>
                          <div
                            className={`text-[11px] truncate mt-0.5 ${
                              isActive ? 'text-stone-200' : 'text-stone-600'
                            }`}
                          >
                            {volumeLang === 'en' && doc.hasEn ? doc.enTitle : doc.title}
                          </div>
                          {matchedLines.length > 0 && (
                            <div
                              className={`text-[11px] font-mono mt-1 tabular-nums ${
                                isActive ? 'text-emerald-300' : 'text-emerald-700 font-semibold'
                              }`}
                            >
                              匹配 {matchedLines.length} 行 · 首个 L{matchedLines[0]}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </aside>
            )}

            <div className={showVolumeToc ? 'lg:col-span-9 space-y-4 min-w-0' : 'lg:col-span-12 space-y-4 min-w-0'}>
              {/* Reader Toolbar */}
              <div className="bg-white border border-stone-200/90 rounded p-3.5 shadow-2xs space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2.5 pb-2.5 border-b border-stone-100">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-stone-900 flex items-center gap-2">
                      <BookOpen className="h-4 w-4 text-stone-800 shrink-0" />
                      <span>合卷全文阅读（自动发现 {volumeDocs.length} 篇文稿）</span>
                    </h2>
                    <p className="text-xs text-stone-500 mt-0.5">
                      点击左侧行号 <code className="font-mono">L#</code> 设定起点，再点或{' '}
                      <kbd className="font-mono">Shift+点击</kbd> 另一行号即可一键复制选段给 Gemini。
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div
                      role="group"
                      aria-label="阅读语种切换"
                      className="inline-flex items-center rounded border border-stone-200 bg-stone-100 p-0.5 text-xs"
                    >
                      <Languages className="h-3.5 w-3.5 text-stone-500 mx-1.5 shrink-0" />
                      {(
                        [
                          { id: 'zh', label: '中文/主稿' },
                          { id: 'en', label: '英文' },
                          { id: 'both', label: '中英对照' },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setVolumeLang(opt.id)}
                          className={`px-2 py-1 rounded transition-colors whitespace-nowrap shrink-0 ${
                            volumeLang === opt.id
                              ? 'bg-stone-900 text-white font-medium'
                              : 'text-stone-700 hover:text-stone-900'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => setShowVolumeToc((prev) => !prev)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-stone-200 bg-white hover:bg-stone-50 text-xs font-medium text-stone-700 whitespace-nowrap shrink-0"
                    >
                      {showVolumeToc ? (
                        <>
                          <PanelLeftClose className="h-3.5 w-3.5" />
                          收起目录
                        </>
                      ) : (
                        <>
                          <PanelLeftOpen className="h-3.5 w-3.5" />
                          展开目录
                        </>
                      )}
                    </button>

                    <div className="inline-flex items-center gap-1 text-xs text-stone-600 border border-stone-200 rounded px-2 py-1 bg-stone-50">
                      <Type className="h-3.5 w-3.5 text-stone-400" />
                      {(['sm', 'md', 'lg'] as const).map((sz) => (
                        <button
                          key={sz}
                          type="button"
                          onClick={() => setFontSize(sz)}
                          className={`px-1.5 py-0.5 rounded ${
                            fontSize === sz
                              ? 'bg-stone-900 text-white font-medium'
                              : 'text-stone-600 hover:text-stone-900'
                          }`}
                        >
                          {sz === 'sm' ? '标准' : sz === 'md' ? '适中' : '大字'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Secondary Scope Select & Prev/Next */}
                <div className="flex flex-wrap items-center justify-between gap-2.5 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-1.5 text-stone-600">
                      <span className="font-medium whitespace-nowrap">渲染范围</span>
                      <select
                        value={volumeScope}
                        onChange={(e) => setVolumeScope(e.target.value)}
                        className="rounded border border-stone-300 bg-white px-2.5 py-1 text-xs text-stone-900 focus:outline-none focus:border-stone-800"
                      >
                        <option value="single">单章/单篇独立精读（默认 · 适配侧边栏）</option>
                        {volumeGroups.map((g) => (
                          <option key={g.group} value={g.group}>
                            连续滚动：仅看 {g.label} ({g.docs.length} 篇)
                          </option>
                        ))}
                        <option value="all">连续滚动：全部 {volumeDocs.length} 篇同时展开</option>
                      </select>
                    </label>

                    {volumeScope === 'single' && volumeDocs.length > 0 && (
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            const idx = volumeDocs.findIndex((d) => d.id === selectedDocId);
                            if (idx > 0) handleSelectOrScrollDoc(volumeDocs[idx - 1].id);
                          }}
                          disabled={volumeDocs.findIndex((d) => d.id === selectedDocId) <= 0}
                          className="px-2 py-1 rounded border border-stone-200 bg-white hover:bg-stone-50 text-stone-800 disabled:opacity-40 whitespace-nowrap shrink-0"
                        >
                          ← 上一篇
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const idx = volumeDocs.findIndex((d) => d.id === selectedDocId);
                            if (idx >= 0 && idx < volumeDocs.length - 1) {
                              handleSelectOrScrollDoc(volumeDocs[idx + 1].id);
                            }
                          }}
                          disabled={
                            volumeDocs.findIndex((d) => d.id === selectedDocId) >=
                            volumeDocs.length - 1
                          }
                          className="px-2 py-1 rounded border border-stone-200 bg-white hover:bg-stone-50 text-stone-800 disabled:opacity-40 whitespace-nowrap shrink-0"
                        >
                          下一篇 →
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="font-mono text-stone-500 tabular-nums">
                    当前渲染 <strong className="text-stone-900">{visibleVolumeDocs.length}</strong> 篇
                  </div>
                </div>
              </div>

              {volumeLoading ? (
                <div className="bg-white border border-stone-200 rounded p-8 text-center text-xs text-stone-500">
                  正在扫描并加载目标仓库文稿...
                </div>
              ) : visibleVolumeDocs.length === 0 ? (
                <div className="bg-white border border-stone-200 rounded p-8 text-center text-xs text-stone-500">
                  目标仓库中未发现可阅读的 `.qmd` / `.tex` / `.md` 文稿文件。
                </div>
              ) : (
                <div className="space-y-6">
                  {visibleVolumeDocs.map((doc, docIdx) => {
                    const effectiveLang = !doc.hasEn ? 'zh' : volumeLang;
                    const q = volumeSearch.trim().toLowerCase();
                    const rowCount =
                      effectiveLang === 'zh'
                        ? doc.lineCount
                        : effectiveLang === 'en'
                        ? doc.enLineCount
                        : Math.max(doc.lineCount, doc.enLineCount);
                    const langTag =
                      effectiveLang === 'zh' ? '主稿' : effectiveLang === 'en' ? '英文' : '中英对照';

                    const buildFullCopyText = (numbered: boolean) => {
                      if (effectiveLang === 'zh') {
                        return numbered
                          ? doc.lines.map((line, i) => `L${i + 1}: ${line}`).join('\n')
                          : doc.lines.join('\n');
                      }
                      if (effectiveLang === 'en') {
                        return numbered
                          ? doc.enLines.map((line, i) => `L${i + 1}: ${line}`).join('\n')
                          : doc.enLines.join('\n');
                      }
                      return Array.from({ length: rowCount }, (_, i) => {
                        const zh = doc.lines[i] ?? '';
                        const en = doc.enLines[i] ?? '';
                        return numbered
                          ? `L${i + 1} [ZH]: ${zh}\nL${i + 1} [EN]: ${en}`
                          : `[ZH] ${zh}\n[EN] ${en}`;
                      }).join('\n');
                    };

                    return (
                      <article
                        key={doc.id}
                        id={`volume-doc-${doc.id}`}
                        className="bg-white border border-stone-200/90 rounded shadow-2xs overflow-hidden scroll-mt-20"
                      >
                        <div className="bg-stone-900 text-stone-100 px-4 sm:px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 border-b border-stone-800">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-mono">
                              <span className="text-emerald-400 font-semibold">
                                {volumeScope === 'single'
                                  ? doc.orderLabel
                                  : `[${docIdx + 1}/${visibleVolumeDocs.length}] ${doc.orderLabel}`}
                              </span>
                              <span className="text-stone-500">·</span>
                              <span className="text-stone-300 break-all">
                                {effectiveLang === 'zh'
                                  ? doc.path
                                  : effectiveLang === 'en'
                                  ? doc.enPath
                                  : `${doc.path} ↔ ${doc.enPath}`}
                              </span>
                            </div>
                            <h3 className="text-sm sm:text-base font-semibold text-white mt-0.5">
                              {effectiveLang === 'en'
                                ? doc.enTitle
                                : effectiveLang === 'both' && doc.enTitle !== doc.title
                                ? `${doc.title} / ${doc.enTitle}`
                                : doc.title}
                            </h3>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-mono text-stone-300 bg-stone-800 px-2 py-1 rounded tabular-nums">
                              {effectiveLang === 'both'
                                ? `L1–L${doc.lineCount} / EN L1–L${doc.enLineCount}`
                                : effectiveLang === 'en'
                                ? `L1–L${doc.enLineCount} · ${doc.enSha256}`
                                : `L1–L${doc.lineCount} · ${doc.sha256}`}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                handleCopy(
                                  `copy-numbered-${doc.id}-${effectiveLang}`,
                                  buildFullCopyText(true),
                                  `已复制《${doc.orderLabel}》${langTag}带行号全文`
                                )
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-stone-800 hover:bg-stone-700 text-stone-100 font-medium border border-stone-700 whitespace-nowrap shrink-0"
                            >
                              <Copy className="h-3 w-3" />
                              复制带行号
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                handleCopy(
                                  `copy-raw-${doc.id}-${effectiveLang}`,
                                  buildFullCopyText(false),
                                  `已复制《${doc.orderLabel}》${langTag}纯文本`
                                )
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-700 whitespace-nowrap shrink-0"
                            >
                              <Copy className="h-3 w-3" />
                              复制纯文本
                            </button>
                          </div>
                        </div>

                        {volumeSelection && volumeSelection.docId === doc.id && (
                          <div className="sticky top-[52px] z-20 px-4 py-2 bg-emerald-50 border-b border-emerald-200 flex flex-wrap items-center justify-between gap-2 text-xs">
                            <span className="font-mono text-emerald-900 tabular-nums">
                              已选中 {doc.orderLabel}（{langTag}）·{' '}
                              <strong>
                                {volumeSelection.startLine === volumeSelection.endLine
                                  ? `L${volumeSelection.startLine}`
                                  : `L${volumeSelection.startLine}–L${volumeSelection.endLine}`}
                              </strong>{' '}
                              （共 {volumeSelection.endLine - volumeSelection.startLine + 1} 行）
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleCopyVolumeSelection(doc)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-stone-900 hover:bg-stone-800 text-white font-medium whitespace-nowrap shrink-0"
                              >
                                <Send className="h-3 w-3" />
                                复制选段给 Gemini
                              </button>
                              <button
                                type="button"
                                onClick={() => setVolumeSelection(null)}
                                className="px-2 py-1 rounded border border-emerald-300 bg-white hover:bg-emerald-100/50 text-emerald-900 whitespace-nowrap shrink-0"
                              >
                                清除选区
                              </button>
                            </div>
                          </div>
                        )}

                        {effectiveLang === 'both' && (
                          <div className="hidden xl:grid xl:grid-cols-2 gap-4 pl-20 pr-4 py-1.5 bg-stone-50 border-b border-stone-200 text-[11px] font-mono text-stone-500">
                            <span>主稿 · {doc.path}</span>
                            <span>译稿 · {doc.enPath}</span>
                          </div>
                        )}

                        <div className="divide-y divide-stone-100/90">
                          {Array.from({ length: rowCount }, (_, i) => {
                            const lineNo = i + 1;
                            const zhText = doc.lines[i] ?? '';
                            const enText = doc.enLines[i] ?? '';
                            const isSelected =
                              volumeSelection?.docId === doc.id &&
                              lineNo >= volumeSelection.startLine &&
                              lineNo <= volumeSelection.endLine;
                            const isHighlighted =
                              highlightedLine?.docId === doc.id && highlightedLine.lineNo === lineNo;
                            const isMatched =
                              q.length > 0 &&
                              (zhText.toLowerCase().includes(q) || enText.toLowerCase().includes(q));

                            return (
                              <div
                                key={lineNo}
                                id={`${doc.id}-L${lineNo}`}
                                className={`flex items-start px-3 sm:px-4 py-1 transition-colors scroll-mt-28 ${
                                  isSelected
                                    ? 'bg-emerald-50/90'
                                    : isHighlighted
                                    ? 'bg-amber-100/80'
                                    : isMatched
                                    ? 'bg-amber-50/70'
                                    : 'hover:bg-stone-50/80'
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={(e) => handleLineNumberClick(doc.id, lineNo, e.shiftKey)}
                                  title="点击选定行号区间以复制给 Gemini"
                                  className={`w-14 shrink-0 select-none pr-3 text-right font-mono text-[11px] tabular-nums pt-0.5 ${
                                    isSelected
                                      ? 'text-emerald-800 font-bold'
                                      : 'text-stone-400 hover:text-stone-800'
                                  }`}
                                >
                                  L{lineNo}
                                </button>

                                {effectiveLang === 'both' ? (
                                  <div
                                    className={`flex-1 grid grid-cols-1 xl:grid-cols-2 gap-3 font-serif ${fontSizeClass} leading-relaxed text-stone-900 min-w-0`}
                                  >
                                    <div className="whitespace-pre-wrap break-words">
                                      {zhText === '' ? '\u00A0' : zhText}
                                    </div>
                                    <div className="whitespace-pre-wrap break-words text-stone-700 xl:border-l xl:border-stone-200/70 xl:pl-3">
                                      {enText === '' ? '\u00A0' : enText}
                                    </div>
                                  </div>
                                ) : (
                                  <div
                                    className={`flex-1 font-serif ${fontSizeClass} leading-relaxed text-stone-900 whitespace-pre-wrap break-words min-w-0`}
                                  >
                                    {effectiveLang === 'en'
                                      ? enText === ''
                                        ? '\u00A0'
                                        : enText
                                      : zhText === ''
                                      ? '\u00A0'
                                      : zhText}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        )}

        {/* VIEW 3: STANDALONE WIDE CORPUS INSPECTOR */}
        {repoStatus?.cloned && activeTab === 'inspector' && (() => {
          const targetGroups = Array.from(new Set(repoFiles.map((f) => f.group)));
          const rawLines = inspectorContent.split('\n');
          const iq = inspectorSearch.trim().toLowerCase();

          return (
            <section className="bg-white border border-stone-200/90 rounded shadow-2xs overflow-hidden">
              <div className="px-4 sm:px-5 py-2.5 bg-stone-900 text-stone-100 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => setActiveTab(returnTab)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-stone-800 hover:bg-stone-700 border border-stone-700 text-white font-medium whitespace-nowrap shrink-0"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    返回{returnTab === 'fullvolume' ? '「合卷全文阅读」' : '「词元比对审阅」'}
                  </button>
                  <span className="font-semibold text-stone-100 truncate">
                    全库文稿与源码宽屏直检（{repoFiles.length} 个已索引文件）
                  </span>
                </div>

                <div className="inline-flex rounded border border-stone-700 bg-stone-800 p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setInspectorViewMode('read')}
                    className={`px-2.5 py-1 rounded transition-colors whitespace-nowrap ${
                      inspectorViewMode === 'read'
                        ? 'bg-white text-stone-900 font-medium'
                        : 'text-stone-300 hover:text-white'
                    }`}
                  >
                    行号直检视图
                  </button>
                  <button
                    type="button"
                    onClick={() => setInspectorViewMode('edit')}
                    className={`px-2.5 py-1 rounded transition-colors whitespace-nowrap ${
                      inspectorViewMode === 'edit'
                        ? 'bg-white text-stone-900 font-medium'
                        : 'text-stone-300 hover:text-white'
                    }`}
                  >
                    源码编辑模式
                  </button>
                </div>
              </div>

              <div className="p-4 sm:p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-stone-200 pb-3.5">
                  <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
                    <select
                      aria-label="选择仓库文件"
                      value={repoFiles.some((f) => f.path === inspectorFile) ? inspectorFile : ''}
                      onChange={(e) => {
                        if (e.target.value) {
                          loadInspectorFile(e.target.value);
                          setInspectorCustomPath('');
                        }
                      }}
                      className="rounded border border-stone-300 bg-white px-3 py-1.5 text-xs font-mono text-stone-900 focus:outline-none focus:border-stone-800 max-w-md"
                    >
                      {!repoFiles.some((f) => f.path === inspectorFile) && inspectorFile && (
                        <option value="">自定义路径: {inspectorFile}</option>
                      )}
                      {targetGroups.map((grp) => (
                        <optgroup key={grp} label={grp}>
                          {repoFiles
                            .filter((f) => f.group === grp)
                            .map((f) => (
                              <option key={f.path} value={f.path}>
                                {f.label}
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>

                    <div className="flex items-center gap-1.5 flex-1 min-w-[220px] max-w-md">
                      <input
                        type="text"
                        value={inspectorCustomPath}
                        onChange={(e) => setInspectorCustomPath(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && inspectorCustomPath.trim()) {
                            loadInspectorFile(inspectorCustomPath.trim());
                          }
                        }}
                        placeholder="输入任意仓库相对路径 (如 refs.bib 或 _quarto.yml)"
                        className="flex-1 min-w-0 rounded border border-stone-200 bg-stone-50/70 px-2.5 py-1.5 text-xs font-mono text-stone-800 placeholder-stone-400 focus:outline-none focus:border-stone-600 focus:bg-white"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (inspectorCustomPath.trim()) loadInspectorFile(inspectorCustomPath.trim());
                        }}
                        className="px-2.5 py-1.5 rounded border border-stone-300 bg-white hover:bg-stone-50 text-stone-800 text-xs font-medium whitespace-nowrap shrink-0"
                      >
                        加载路径
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        handleCopy(
                          'inspector-file-numbered',
                          rawLines.map((l, i) => `L${i + 1}: ${l}`).join('\n'),
                          `已复制 ${inspectorFile} 带行号全文`
                        )
                      }
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 text-xs font-medium whitespace-nowrap"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      复制带行号
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        handleCopy('inspector-file-text', inspectorContent, `已复制 ${inspectorFile} 纯文本`)
                      }
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 text-xs font-medium whitespace-nowrap"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      复制纯文本
                    </button>
                    {inspectorViewMode === 'edit' && (
                      <button
                        type="button"
                        onClick={saveInspectorFile}
                        disabled={inspectorSaving || inspectorLoading}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-stone-900 hover:bg-stone-800 text-white text-xs font-medium disabled:opacity-50 whitespace-nowrap"
                      >
                        <Save className="h-3.5 w-3.5" />
                        {inspectorSaving ? '保存中...' : '保存至工作区'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Metadata & Generic Syntax Check */}
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs bg-stone-50 p-3 rounded border border-stone-200 font-mono">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>
                      路径: <strong className="text-stone-900">{inspectorFile || '—'}</strong>
                    </span>
                    <span className="text-stone-300">·</span>
                    <span className="tabular-nums">
                      总行数: <strong className="text-stone-900">{inspectorLines} 行</strong>
                    </span>
                    <span className="text-stone-300">·</span>
                    <span>
                      SHA-256: <strong className="text-stone-700">{inspectorSha || '—'}</strong>
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    {inspectorViewMode === 'read' && (
                      <div className="relative">
                        <Search className="h-3 w-3 absolute left-2 top-2 text-stone-400" />
                        <input
                          type="text"
                          value={inspectorSearch}
                          onChange={(e) => setInspectorSearch(e.target.value)}
                          placeholder="在当前文件中检索..."
                          className="pl-7 pr-6 py-1 rounded border border-stone-300 bg-white text-xs font-sans text-stone-800 placeholder-stone-400 focus:outline-none focus:border-stone-700 w-48"
                        />
                        {inspectorSearch && (
                          <button
                            type="button"
                            onClick={() => setInspectorSearch('')}
                            className="absolute right-1.5 top-1.5 text-stone-400 hover:text-stone-600"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    )}

                    {inspectorLint?.passed && inspectorLint.warnCount === 0 ? (
                      <span className="text-emerald-700 font-semibold font-sans flex items-center gap-1 whitespace-nowrap">
                        <CheckCircle2 className="h-4 w-4" />
                        语法体检通过
                      </span>
                    ) : inspectorLint ? (
                      <span className="text-amber-800 font-semibold font-sans flex items-center gap-1 whitespace-nowrap">
                        <AlertTriangle className="h-4 w-4" />
                        提示 {inspectorLint.totalFindings} 项
                      </span>
                    ) : null}
                  </div>
                </div>

                {inspectorLint && inspectorLint.findings.length > 0 && (
                  <div className="p-3 bg-amber-50/60 rounded border border-amber-200 text-xs space-y-2">
                    <div className="font-semibold text-amber-900">
                      文件检查提示 ({inspectorLint.findings.length} 项)：
                    </div>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto font-mono">
                      {inspectorLint.findings.map((f, i) => (
                        <div key={i} className="text-stone-800 bg-white p-2 rounded border border-amber-100">
                          <span className="text-amber-900 font-semibold">
                            [L{f.line}] {f.title}
                          </span>
                          {f.replacement && (
                            <span className="text-emerald-800 ml-2">→ {f.replacement}</span>
                          )}
                          {f.rationale && (
                            <div className="text-stone-500 font-sans mt-0.5">{f.rationale}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {inspectorLoading ? (
                  <div className="p-8 text-center text-xs text-stone-500 border border-stone-200 rounded bg-stone-50/50">
                    正在读取 {inspectorFile} ...
                  </div>
                ) : inspectorViewMode === 'read' ? (
                  <div className="rounded border border-stone-200 bg-white overflow-x-auto max-h-[70vh] overflow-y-auto">
                    <div className="divide-y divide-stone-100 font-mono text-xs">
                      {rawLines.map((line, i) => {
                        const lineNo = i + 1;
                        const matched = iq ? line.toLowerCase().includes(iq) : false;
                        return (
                          <div
                            key={lineNo}
                            className={`flex items-start px-3 py-1 ${
                              matched ? 'bg-amber-50/90' : 'hover:bg-stone-50'
                            }`}
                          >
                            <span className="w-14 shrink-0 select-none pr-3 text-right text-stone-400 tabular-nums">
                              L{lineNo}
                            </span>
                            <span className="flex-1 whitespace-pre-wrap break-words text-stone-800 leading-relaxed">
                              {line === '' ? '\u00A0' : line}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="text-xs text-stone-500">
                      源码编辑器（修改后点击「保存至工作区」将直接写入 `/tmp/target-repo` 并在词元比对页生成实时 Diff）：
                    </div>
                    <textarea
                      value={inspectorContent}
                      onChange={(e) => {
                        setInspectorContent(e.target.value);
                        setInspectorLines(e.target.value.split('\n').length);
                      }}
                      rows={24}
                      className="w-full rounded border border-stone-300 bg-white p-3 font-mono text-xs leading-relaxed text-stone-900 focus:border-stone-800 focus:outline-none shadow-2xs"
                    />
                  </div>
                )}
              </div>
            </section>
          );
        })()}
      </main>
    </div>
  );
}

export default App;
