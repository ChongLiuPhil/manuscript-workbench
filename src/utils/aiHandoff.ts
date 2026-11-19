import type { DiffSection, ParagraphPair } from '../types/workbench';

export type ReviewStatus = 'pending' | 'discuss' | 'approved';

export interface ReviewMetaEntry {
  status: ReviewStatus;
  note: string;
  updatedAt: number;
}

export type ReviewMetaMap = Record<string, ReviewMetaEntry>;

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: '待审',
  discuss: '需讨论',
  approved: '已确认',
};

export function nextReviewStatus(current: ReviewStatus): ReviewStatus {
  if (current === 'pending') return 'discuss';
  if (current === 'discuss') return 'approved';
  return 'pending';
}

export function getReviewEntry(map: ReviewMetaMap, key: string): ReviewMetaEntry {
  return (
    map[key] ?? {
      status: 'pending',
      note: '',
      updatedAt: 0,
    }
  );
}

const ACADEMIC_GUARDRAILS = [
  '- 严格保持双语文本 1:1 行号或段落结构对齐，不增删无关段落或破坏原有排版。',
  '- 严格保持行内与行间 LaTeX 数学公式数量、交叉引用键与符号体系守恒。',
  '- 遵循当前文稿既有学术术语规范，避免引入不必要的冗余修饰。',
  '- 仅就指出之处给出可直接落盘的最小局部替换建议，勿改写无关句子。',
].join('\n');

function formatFileLineMeta(section: DiffSection, pair: ParagraphPair): string {
  const parts: string[] = [];
  if (pair.hasCn) {
    parts.push(`主稿 \`${pair.fileCn ?? section.fileCn ?? ''}\` (${pair.cnLines})`);
  }
  if (pair.hasEn) {
    parts.push(`译稿 \`${pair.fileEn ?? section.fileEn ?? ''}\` (${pair.enLines})`);
  }
  return parts.join(' ｜ ') || section.location;
}

export function buildParagraphGeminiPacket(params: {
  repoSlug?: string;
  section: DiffSection;
  pair: ParagraphPair;
  baselineLabel: string;
  baseCn: string;
  currentCn: string;
  baseEn: string;
  currentEn: string;
  review: ReviewMetaEntry;
  lang: 'zh' | 'en' | 'both';
}): string {
  const { repoSlug, section, pair, baselineLabel, baseCn, currentCn, baseEn, currentEn, review, lang } = params;
  const lines: string[] = [
    `## 审阅请求 · ${section.shortTitle} / ${pair.label}`,
    '',
  ];
  if (repoSlug) {
    lines.push(`- **目标仓库**：\`${repoSlug}\``);
  }
  lines.push(
    `- **所属文档**：${section.chapter}`,
    `- **文件与行号**：${formatFileLineMeta(section, pair)}`,
    `- **审阅状态**：${REVIEW_STATUS_LABEL[review.status]}`
  );

  if (review.note.trim()) {
    lines.push(`- **作者批注 / 待讨论问题**：${review.note.trim()}`);
  }
  if (pair.rationale) {
    lines.push(`- **变更说明**：${pair.rationale}`);
  }

  lines.push('');

  const showCn = pair.hasCn && (lang === 'zh' || lang === 'both' || !pair.hasEn);
  const showEn = pair.hasEn && (lang === 'en' || lang === 'both' || !pair.hasCn);

  if (showCn) {
    lines.push(pair.hasEn ? '### 当前中文稿 / 主稿' : '### 当前文本');
    lines.push(currentCn);
    lines.push('');
    if (baseCn !== currentCn) {
      lines.push(`### 对比基准（${baselineLabel}）`);
      lines.push(baseCn);
      lines.push('');
    }
  }

  if (showEn) {
    lines.push('### Current English / Counterpart Draft');
    lines.push(currentEn);
    lines.push('');
    if (baseEn !== currentEn) {
      lines.push(`### Baseline (${baselineLabel} · English)`);
      lines.push(baseEn);
      lines.push('');
    }
  }

  lines.push('### 协作审阅约束');
  lines.push(ACADEMIC_GUARDRAILS);
  lines.push('');
  lines.push('请围绕论证严密性、双语表达对等性与学术写作风格审阅以上片段；如有更佳表述，请给出最小局部替换方案。');

  return lines.join('\n');
}

export function buildSectionGeminiPacket(params: {
  repoSlug?: string;
  section: DiffSection;
  sectionReview: ReviewMetaEntry;
  reviewMeta: ReviewMetaMap;
  getCn: (pair: ParagraphPair) => string;
  getEn: (pair: ParagraphPair) => string;
  lang: 'zh' | 'en' | 'both';
}): string {
  const { repoSlug, section, sectionReview, reviewMeta, getCn, getEn, lang } = params;
  const lines: string[] = [
    `# 变更卡片审阅包 · ${section.shortTitle}`,
    '',
  ];
  if (repoSlug) {
    lines.push(`- **目标仓库**：\`${repoSlug}\``);
  }
  lines.push(
    `- **所属文档**：${section.chapter}`,
    `- **路径定位**：${section.location}`,
    `- **卡片审阅状态**：${REVIEW_STATUS_LABEL[sectionReview.status]}`,
    `- **变更概览**：${section.issue}`
  );

  if (sectionReview.note.trim()) {
    lines.push(`- **卡片批注**：${sectionReview.note.trim()}`);
  }

  lines.push('');

  section.paragraphs.forEach((pair, index) => {
    const pReview = getReviewEntry(reviewMeta, pair.id);
    lines.push(`## ${index + 1}. ${pair.label}（${REVIEW_STATUS_LABEL[pReview.status]}）`);
    lines.push(`- 文件与行号：${formatFileLineMeta(section, pair)}`);
    if (pReview.note.trim()) {
      lines.push(`- 区块批注：${pReview.note.trim()}`);
    }
    lines.push('');
    const showCn = pair.hasCn && (lang === 'zh' || lang === 'both' || !pair.hasEn);
    const showEn = pair.hasEn && (lang === 'en' || lang === 'both' || !pair.hasCn);
    if (showCn) {
      lines.push(pair.hasEn ? '**主稿当前文本：**' : '**当前文本：**');
      lines.push(getCn(pair));
      lines.push('');
    }
    if (showEn) {
      lines.push('**English / Counterpart Draft:**');
      lines.push(getEn(pair));
      lines.push('');
    }
  });

  lines.push('### 协作审阅约束');
  lines.push(ACADEMIC_GUARDRAILS);
  lines.push('');
  lines.push('请逐块核查论证严密性、双语一致性与术语规范，并优先回应上述批注中的待讨论问题。');

  return lines.join('\n');
}

export function buildVolumeSelectionGeminiPacket(params: {
  repoSlug?: string;
  orderLabel: string;
  title: string;
  enTitle?: string;
  path: string;
  enPath?: string;
  hasEn?: boolean;
  lang: 'zh' | 'en' | 'both';
  startLine: number;
  endLine: number;
  selectedLines: Array<{ lineNo: number; zhText: string; enText: string }>;
}): string {
  const { repoSlug, orderLabel, title, enTitle, path, enPath, hasEn = true, lang, startLine, endLine, selectedLines } = params;
  const effectiveLang = !hasEn ? 'zh' : lang;
  const rangeLabel = startLine === endLine ? `L${startLine}` : `L${startLine}–L${endLine}`;

  const langLabel = effectiveLang === 'zh' ? '主稿/中文' : effectiveLang === 'en' ? 'English' : '中英对照';
  const headerTitle =
    effectiveLang === 'en' && enTitle
      ? enTitle
      : effectiveLang === 'both' && enTitle && enTitle !== title
      ? `${title} / ${enTitle}`
      : title;
  const pathMeta =
    effectiveLang === 'zh'
      ? `\`${path}\``
      : effectiveLang === 'en'
      ? `\`${enPath || path}\``
      : `主稿 \`${path}\` ｜ 译稿 \`${enPath || path}\``;

  const body = selectedLines
    .map((item) => {
      if (effectiveLang === 'zh') return `L${item.lineNo}: ${item.zhText}`;
      if (effectiveLang === 'en') return `L${item.lineNo}: ${item.enText}`;
      return `L${item.lineNo} [ZH]: ${item.zhText}\nL${item.lineNo} [EN]: ${item.enText}`;
    })
    .join('\n');

  const lines = [
    `## 合卷原文摘录（${langLabel}）· ${orderLabel} (${rangeLabel})`,
    '',
  ];
  if (repoSlug) {
    lines.push(`- **目标仓库**：\`${repoSlug}\``);
  }
  lines.push(
    `- **篇目**：${headerTitle}`,
    `- **源码路径**：${pathMeta}`,
    `- **行号范围**：${rangeLabel}（共 ${selectedLines.length} 行）`,
    '',
    '```text',
    body,
    '```',
    '',
    '### 审阅说明',
    ACADEMIC_GUARDRAILS,
    '',
    effectiveLang === 'both'
      ? '请结合以上逐行双语对照原文片段，核查论证严密性、双语表达对等性与术语一致性，并给出精准的局部修改建议。'
      : '请结合以上带行号原文片段协助分析论证结构、术语一致性或提出精准修订建议。'
  );
  return lines.join('\n');
}

export function buildActionBriefMarkdown(params: {
  repoSlug?: string;
  compareLabel: string;
  sections: DiffSection[];
  branch: string;
  baseCommit: string;
  reviewMeta: ReviewMetaMap;
  isManuallyModified: (pair: ParagraphPair) => boolean;
  getCnAfter: (pair: ParagraphPair) => string;
  getEnAfter: (pair: ParagraphPair) => string;
  scope: 'actionable' | 'all';
}): string {
  const {
    repoSlug,
    compareLabel,
    sections,
    branch,
    baseCommit,
    reviewMeta,
    isManuallyModified,
    getCnAfter,
    getEnAfter,
    scope,
  } = params;

  const totalParagraphs = sections.reduce((sum, sec) => sum + sec.paragraphs.length, 0);
  let discussCount = 0;
  let approvedCount = 0;
  let modifiedCount = 0;
  let noteCount = 0;

  for (const sec of sections) {
    const sMeta = getReviewEntry(reviewMeta, sec.id);
    if (sMeta.note.trim()) noteCount++;
    for (const pair of sec.paragraphs) {
      const pMeta = getReviewEntry(reviewMeta, pair.id);
      if (pMeta.status === 'discuss') discussCount++;
      if (pMeta.status === 'approved') approvedCount++;
      if (isManuallyModified(pair)) modifiedCount++;
      if (pMeta.note.trim()) noteCount++;
    }
  }

  const lines: string[] = [
    '# 学术文稿审阅与修订执行指令包',
    '',
  ];
  if (repoSlug) {
    lines.push(`- **目标仓库**：\`${repoSlug}\``);
  }
  lines.push(
    `- **比对区间**：\`${compareLabel}\``,
    `- **当前分支 / 提交**：\`${branch}\` @ \`${baseCommit}\``,
    `- **导出范围**：${scope === 'actionable' ? '仅含「需讨论 / 有批注 / 有手动微调」项' : '全部变更卡片'}`,
    `- **统计概览**：共 ${sections.length} 张卡片 / ${totalParagraphs} 处变更区块 ｜ 需讨论 ${discussCount} ｜ 已确认 ${approvedCount} ｜ 手动微调 ${modifiedCount} ｜ 批注 ${noteCount}`,
    '',
    '## 执行硬性约束',
    ACADEMIC_GUARDRAILS,
    '',
    '---',
    ''
  );

  let exportedSectionCount = 0;

  sections.forEach((sec, secIdx) => {
    const secMeta = getReviewEntry(reviewMeta, sec.id);
    const matchingPairs = sec.paragraphs.filter((pair) => {
      if (scope === 'all') return true;
      const pMeta = getReviewEntry(reviewMeta, pair.id);
      return pMeta.status === 'discuss' || pMeta.note.trim().length > 0 || isManuallyModified(pair);
    });

    const sectionItselfActionable =
      secMeta.status === 'discuss' || secMeta.note.trim().length > 0;

    if (scope === 'actionable' && !sectionItselfActionable && matchingPairs.length === 0) {
      return;
    }

    exportedSectionCount++;
    const pairsToRender =
      scope === 'actionable' && matchingPairs.length > 0
        ? matchingPairs
        : scope === 'all'
        ? sec.paragraphs
        : [];

    lines.push(`## ${String(secIdx + 1).padStart(2, '0')}. ${sec.shortTitle}`);
    lines.push(`- **所属文档**：${sec.chapter}`);
    lines.push(`- **路径定位**：${sec.location}`);
    lines.push(`- **卡片状态**：${REVIEW_STATUS_LABEL[secMeta.status]}`);
    if (secMeta.note.trim()) {
      lines.push(`- **卡片批注**：${secMeta.note.trim()}`);
    }
    lines.push('');

    pairsToRender.forEach((pair) => {
      const pMeta = getReviewEntry(reviewMeta, pair.id);
      const modified = isManuallyModified(pair);
      const cnAfter = getCnAfter(pair);
      const enAfter = getEnAfter(pair);

      lines.push(`### ${pair.label}`);
      lines.push(
        `- **文件与行号**：${formatFileLineMeta(sec, pair)} ｜ **状态**：${REVIEW_STATUS_LABEL[pMeta.status]}${modified ? ' · 已在工作台微调' : ''}`
      );
      if (pMeta.note.trim()) {
        lines.push(`- **批注 / 修改要求**：${pMeta.note.trim()}`);
      }
      lines.push('');

      if (modified) {
        if (pair.hasCn && cnAfter !== pair.cnAfter) {
          lines.push('**主稿 · 原稿（替换前）：**');
          lines.push(pair.cnAfter);
          lines.push('');
          lines.push('**主稿 · 工作台微调稿（目标替换为）：**');
          lines.push(cnAfter);
          lines.push('');
        }
        if (pair.hasEn && enAfter !== pair.enAfter) {
          lines.push('**English · Previous Draft (Before):**');
          lines.push(pair.enAfter);
          lines.push('');
          lines.push('**English · Workbench Edited Draft (Target):**');
          lines.push(enAfter);
          lines.push('');
        }
      } else {
        if (pair.hasCn) {
          lines.push(pair.hasEn ? '**主稿当前文本：**' : '**当前文本：**');
          lines.push(cnAfter);
          lines.push('');
        }
        if (pair.hasEn) {
          lines.push('**English Current Text:**');
          lines.push(enAfter);
          lines.push('');
        }
      }
    });

    lines.push('---');
    lines.push('');
  });

  if (exportedSectionCount === 0) {
    lines.push('当前暂无标记为「需讨论」、含批注或含手动微调的条目。可在上方切换为「全部卡片」导出完整审阅包。');
  }

  return lines.join('\n').trim();
}
