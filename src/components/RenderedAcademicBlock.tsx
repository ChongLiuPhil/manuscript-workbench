import React, { useMemo, useState } from 'react';
import katex from 'katex';
import { Maximize2, X } from 'lucide-react';

export interface FigureRef {
  caption: string;
  rawPath: string;
  fileName: string;
  anchor?: string;
}

function normalizeLatex(tex: string): string {
  // KaTeX interprets `\\[` inside aligned/array as an optional vertical spacing argument;
  // inserting `\relax` preserves the literal `[` bracket as in MathJax/LaTeX.
  return tex.replace(/\\\\(\s*)\[/g, '\\\\$1\\relax [');
}

function renderKatexHtml(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(normalizeLatex(tex.trim()), {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
    });
  } catch {
    return tex;
  }
}

function formatCitationBlock(raw: string): string {
  // Convert `[@Woodward_2003_Makingthingshappen; @Pearl_2009_Causality]` -> `(Woodward 2003; Pearl 2009)`
  const inner = raw.replace(/^\[/, '').replace(/\]$/, '').trim();
  const parts = inner
    .split(/\s*;\s*/)
    .map((part) => {
      const m = part.match(/@([A-Za-z0-9_:-]+)/);
      if (!m) return part;
      const key = m[1];
      const segs = key.split('_');
      if (segs.length >= 2 && /^\d{4}/.test(segs[1])) {
        return `${segs[0]} ${segs[1]}`;
      }
      if (segs.length >= 3 && /^\d{4}/.test(segs[2])) {
        return `${segs[0]} & ${segs[1]} ${segs[2]}`;
      }
      return key;
    })
    .filter(Boolean);
  return parts.length > 0 ? `(${parts.join('; ')})` : raw;
}

export function extractFigureRefs(text: string): FigureRef[] {
  const results: FigureRef[] = [];
  const re = /!\[([^\]]*)\]\(([^)]+)\)(?:\{#([^}]+)\})?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const rawPath = m[2].trim();
    const fileName = rawPath.split('/').pop() || rawPath;
    if (fileName.toLowerCase().endsWith('.svg')) {
      results.push({
        caption: m[1].trim(),
        rawPath,
        fileName,
        anchor: m[3]?.trim(),
      });
    }
  }
  return results;
}

/**
 * Split a Quarto/Markdown document into logical blocks (preserving multi-line $$...$$
 * display equations and Markdown tables as single blocks) for 1:1 bilingual alignment.
 */
export function splitAlignedMarkdownBlocks(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let buf: string[] = [];
  let inDisplayMath = false;

  const flush = () => {
    const joined = buf.join('\n').trim();
    if (joined) blocks.push(joined);
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '$$') {
      if (!inDisplayMath) {
        flush();
        inDisplayMath = true;
        buf.push(line);
      } else {
        buf.push(line);
        inDisplayMath = false;
        flush();
      }
      continue;
    }

    if (inDisplayMath) {
      buf.push(line);
      continue;
    }

    if (trimmed === '') {
      flush();
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed) || /^!\[[^\]]*\]\([^)]+\)/.test(trimmed)) {
      flush();
      blocks.push(trimmed);
      continue;
    }

    buf.push(line);
  }
  flush();
  return blocks;
}

function findBalancedFootnoteEnd(str: string, openBracketIdx: number): number {
  let depth = 0;
  for (let i = openBracketIdx; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function renderInlineNodes(
  text: string,
  footnotes: string[],
  keyPrefix: string
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let plainStart = 0;
  let nodeIdx = 0;

  const flushPlain = (end: number) => {
    if (end > plainStart) {
      nodes.push(<React.Fragment key={`${keyPrefix}-t-${nodeIdx++}`}>{text.slice(plainStart, end)}</React.Fragment>);
    }
  };

  while (i < text.length) {
    // 1. Inline Quarto Footnote ^[ ... ]
    if (text[i] === '^' && text[i + 1] === '[') {
      const endIdx = findBalancedFootnoteEnd(text, i + 1);
      if (endIdx !== -1) {
        flushPlain(i);
        const fnBody = text.slice(i + 2, endIdx);
        footnotes.push(fnBody);
        const num = footnotes.length;
        nodes.push(
          <sup
            key={`${keyPrefix}-fn-${nodeIdx++}`}
            className="mx-0.5 font-sans text-[10.5px] font-semibold text-emerald-800 select-none"
            title={`脚注 ${num}`}
          >
            [{num}]
          </sup>
        );
        i = endIdx + 1;
        plainStart = i;
        continue;
      }
    }

    // 2. Display math accidentally inline $$...$$
    if (text[i] === '$' && text[i + 1] === '$') {
      const close = text.indexOf('$$', i + 2);
      if (close !== -1) {
        flushPlain(i);
        const tex = text.slice(i + 2, close);
        nodes.push(
          <span
            key={`${keyPrefix}-dm-${nodeIdx++}`}
            className="block my-2 overflow-x-auto text-center"
            dangerouslySetInnerHTML={{ __html: renderKatexHtml(tex, true) }}
          />
        );
        i = close + 2;
        plainStart = i;
        continue;
      }
    }

    // 3. Inline Math $...$
    if (text[i] === '$' && text[i + 1] !== '$' && (i === 0 || text[i - 1] !== '\\')) {
      let close = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] === '\\') {
          j++;
          continue;
        }
        if (text[j] === '$') {
          close = j;
          break;
        }
      }
      if (close !== -1 && close > i + 1) {
        flushPlain(i);
        const tex = text.slice(i + 1, close);
        nodes.push(
          <span
            key={`${keyPrefix}-m-${nodeIdx++}`}
            className="inline-block align-baseline px-0.5"
            dangerouslySetInnerHTML={{ __html: renderKatexHtml(tex, false) }}
          />
        );
        i = close + 1;
        plainStart = i;
        continue;
      }
    }

    // 4. Bold **...**
    if (text[i] === '*' && text[i + 1] === '*') {
      const close = text.indexOf('**', i + 2);
      if (close !== -1) {
        flushPlain(i);
        const inner = text.slice(i + 2, close);
        nodes.push(
          <strong key={`${keyPrefix}-b-${nodeIdx++}`} className="font-semibold text-stone-950">
            {renderInlineNodes(inner, footnotes, `${keyPrefix}-b${nodeIdx}`)}
          </strong>
        );
        i = close + 2;
        plainStart = i;
        continue;
      }
    }

    // 5. Italic *...*
    if (text[i] === '*' && text[i + 1] !== '*' && text[i + 1] !== ' ') {
      const close = text.indexOf('*', i + 1);
      if (close !== -1 && close > i + 1 && text[close - 1] !== ' ') {
        flushPlain(i);
        const inner = text.slice(i + 1, close);
        nodes.push(
          <em key={`${keyPrefix}-em-${nodeIdx++}`} className="italic">
            {renderInlineNodes(inner, footnotes, `${keyPrefix}-em${nodeIdx}`)}
          </em>
        );
        i = close + 1;
        plainStart = i;
        continue;
      }
    }

    // 6. Inline code `...`
    if (text[i] === '`') {
      const close = text.indexOf('`', i + 1);
      if (close !== -1) {
        flushPlain(i);
        nodes.push(
          <code
            key={`${keyPrefix}-c-${nodeIdx++}`}
            className="font-mono text-[0.86em] bg-stone-100 text-stone-800 px-1 py-0.5 rounded border border-stone-200/70"
          >
            {text.slice(i + 1, close)}
          </code>
        );
        i = close + 1;
        plainStart = i;
        continue;
      }
    }

    // 7. Citation [@Key; @Key2]
    if (text[i] === '[' && text[i + 1] === '@') {
      const close = text.indexOf(']', i + 2);
      if (close !== -1) {
        flushPlain(i);
        const rawCite = text.slice(i, close + 1);
        nodes.push(
          <span
            key={`${keyPrefix}-cite-${nodeIdx++}`}
            title={rawCite}
            className="mx-0.5 font-sans text-[0.84em] text-stone-600 bg-stone-100/90 px-1.5 py-0.5 rounded border border-stone-200/70"
          >
            {formatCitationBlock(rawCite)}
          </span>
        );
        i = close + 1;
        plainStart = i;
        continue;
      }
    }

    i++;
  }

  flushPlain(text.length);
  return nodes;
}

function SvgFigureCard({
  fig,
  footnotes,
  keyPrefix,
  onZoom,
}: {
  fig: FigureRef;
  footnotes: string[];
  keyPrefix: string;
  onZoom: (fig: FigureRef) => void;
}) {
  const src = `/api/workbench/figure-svg?name=${encodeURIComponent(fig.fileName)}`;
  return (
    <figure className="my-4 rounded-lg border border-stone-200 bg-white p-3 sm:p-4 shadow-2xs space-y-2.5">
      <div className="flex items-center justify-between text-[11px] font-mono text-stone-500 border-b border-stone-100 pb-1.5">
        <span className="truncate">
          {fig.anchor ? `#${fig.anchor} · ` : ''}
          {fig.fileName}
        </span>
        <button
          type="button"
          onClick={() => onZoom(fig)}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-stone-200 bg-stone-50 hover:bg-stone-100 text-stone-700 font-sans shrink-0"
        >
          <Maximize2 className="h-3 w-3" />
          放大查看
        </button>
      </div>
      <div className="bg-white rounded overflow-x-auto flex justify-center">
        <img
          src={src}
          alt={fig.caption || fig.fileName}
          onClick={() => onZoom(fig)}
          className="w-full max-w-[960px] h-auto cursor-zoom-in rounded"
        />
      </div>
      {fig.caption && (
        <figcaption className="text-[12.5px] font-serif text-stone-600 leading-relaxed pt-1 border-t border-stone-100">
          {renderInlineNodes(fig.caption, footnotes, `${keyPrefix}-cap`)}
        </figcaption>
      )}
    </figure>
  );
}

export function FigurePreviewStrip({
  figures,
  title = '关联矢量插图实时渲染预览',
}: {
  figures: FigureRef[];
  title?: string;
}) {
  const [zoomed, setZoomed] = useState<FigureRef | null>(null);
  if (figures.length === 0) return null;

  return (
    <div className="mt-3 rounded-lg border border-blue-200/80 bg-blue-50/30 p-3 space-y-2">
      <div className="text-[11px] font-semibold text-blue-900 font-sans">{title}</div>
      <div className="grid grid-cols-1 gap-3">
        {figures.map((fig, idx) => (
          <SvgFigureCard
            key={`${fig.fileName}-${idx}`}
            fig={fig}
            footnotes={[]}
            keyPrefix={`strip-${idx}`}
            onZoom={setZoomed}
          />
        ))}
      </div>
      {zoomed && <FigureZoomModal fig={zoomed} onClose={() => setZoomed(null)} />}
    </div>
  );
}

function FigureZoomModal({ fig, onClose }: { fig: FigureRef; onClose: () => void }) {
  const src = `/api/workbench/figure-svg?name=${encodeURIComponent(fig.fileName)}`;
  return (
    <div
      className="fixed inset-0 z-50 bg-stone-950/75 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl border border-stone-200 shadow-2xl max-w-[95vw] max-h-[92vh] w-[1120px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 bg-stone-900 text-stone-100 flex items-center justify-between text-xs font-mono">
          <span className="truncate">
            {fig.fileName} {fig.anchor ? `(#${fig.anchor})` : ''}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-stone-800 hover:bg-stone-700 text-white font-sans"
          >
            <X className="h-3.5 w-3.5" />
            关闭
          </button>
        </div>
        <div className="p-4 sm:p-6 overflow-auto bg-white flex flex-col items-center gap-3">
          <img src={src} alt={fig.caption || fig.fileName} className="w-full max-w-[1040px] h-auto" />
          {fig.caption && (
            <p className="text-xs font-serif text-stone-700 leading-relaxed max-w-4xl text-center">
              {renderInlineNodes(fig.caption, [], 'zoom-cap')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function RenderedAcademicBlock({
  content,
  fontSizeClass = 'text-[14.5px]',
  className = '',
}: {
  content: string;
  fontSizeClass?: string;
  className?: string;
}) {
  const [zoomedFig, setZoomedFig] = useState<FigureRef | null>(null);

  const parsed = useMemo(() => {
    const blocks = splitAlignedMarkdownBlocks(content || '');
    const footnotes: string[] = [];
    return { blocks, footnotes };
  }, [content]);

  // Build rendered elements while collecting footnotes in reading order
  const footnotes: string[] = [];

  const renderedBlocks = parsed.blocks.map((block, bIdx) => {
    const trimmed = block.trim();
    if (!trimmed) return null;

    // 1. Display Math $$ ... $$
    if (trimmed.startsWith('$$') && trimmed.endsWith('$$')) {
      const inner = trimmed.slice(2, -2).trim();
      return (
        <div
          key={`b-${bIdx}`}
          className="my-3 py-2 px-3 overflow-x-auto text-center bg-stone-50/70 rounded border border-stone-200/60"
          dangerouslySetInnerHTML={{ __html: renderKatexHtml(inner, true) }}
        />
      );
    }

    // 2. Headings
    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      const anchorMatch = hMatch[2].match(/\s*\{#([^}]+)\}\s*$/);
      const cleanTitle = hMatch[2].replace(/\s*\{#[^}]+\}\s*$/, '').trim();
      const children = renderInlineNodes(cleanTitle, footnotes, `h-${bIdx}`);
      const anchorBadge = anchorMatch ? (
        <span className="ml-2 font-mono text-[10.5px] font-normal text-stone-400">
          #{anchorMatch[1]}
        </span>
      ) : null;

      if (level === 1) {
        return (
          <h1
            key={`b-${bIdx}`}
            className="text-xl sm:text-2xl font-bold text-stone-950 font-serif tracking-tight pb-2 mb-3 border-b border-stone-200"
          >
            {children}
            {anchorBadge}
          </h1>
        );
      }
      if (level === 2) {
        return (
          <h2
            key={`b-${bIdx}`}
            className="text-lg font-bold text-stone-900 font-serif mt-5 mb-2.5 pb-1 border-b border-stone-200/70"
          >
            {children}
            {anchorBadge}
          </h2>
        );
      }
      if (level === 3) {
        return (
          <h3
            key={`b-${bIdx}`}
            className="text-[15.5px] font-semibold text-stone-900 font-serif mt-4 mb-2"
          >
            {children}
            {anchorBadge}
          </h3>
        );
      }
      return (
        <h4
          key={`b-${bIdx}`}
          className="text-sm font-semibold text-stone-800 font-serif mt-3 mb-1.5"
        >
          {children}
          {anchorBadge}
        </h4>
      );
    }

    // 3. Standalone Figure ![caption](path){#anchor}
    const figMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)(?:\{#([^}]+)\})?$/);
    if (figMatch) {
      const rawPath = figMatch[2].trim();
      const fileName = rawPath.split('/').pop() || rawPath;
      if (fileName.toLowerCase().endsWith('.svg')) {
        const fig: FigureRef = {
          caption: figMatch[1].trim(),
          rawPath,
          fileName,
          anchor: figMatch[3]?.trim(),
        };
        return (
          <SvgFigureCard
            key={`b-${bIdx}`}
            fig={fig}
            footnotes={footnotes}
            keyPrefix={`fig-${bIdx}`}
            onZoom={setZoomedFig}
          />
        );
      }
    }

    // 4. Markdown Table
    const blockLines = trimmed.split('\n');
    if (
      blockLines.length >= 2 &&
      blockLines[0].includes('|') &&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(blockLines[1])
    ) {
      const parseRow = (row: string) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const headers = parseRow(blockLines[0]);
      const rows = blockLines.slice(2).filter((r) => r.includes('|')).map(parseRow);
      return (
        <div key={`b-${bIdx}`} className="my-3 overflow-x-auto rounded border border-stone-200">
          <table className="w-full text-left border-collapse text-xs sm:text-[13px] font-serif">
            <thead className="bg-stone-100/90 border-b border-stone-200">
              <tr>
                {headers.map((h, hi) => (
                  <th key={hi} className="px-3 py-2 font-semibold text-stone-900">
                    {renderInlineNodes(h, footnotes, `th-${bIdx}-${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200/70 bg-white">
              {rows.map((r, ri) => (
                <tr key={ri} className="hover:bg-stone-50/70">
                  {r.map((cell, ci) => (
                    <td key={ci} className="px-3 py-2 align-top text-stone-800 leading-relaxed">
                      {renderInlineNodes(cell, footnotes, `td-${bIdx}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    // 5. Blockquote
    if (blockLines.every((l) => l.trim().startsWith('>'))) {
      const quoteText = blockLines.map((l) => l.replace(/^\s*>\s?/, '')).join(' ');
      return (
        <blockquote
          key={`b-${bIdx}`}
          className={`my-3 pl-3.5 border-l-3 border-stone-300 text-stone-700 font-serif ${fontSizeClass} leading-[1.8] italic`}
        >
          {renderInlineNodes(quoteText, footnotes, `bq-${bIdx}`)}
        </blockquote>
      );
    }

    // 6. Unordered / Ordered List
    if (blockLines.every((l) => /^\s*([-*+]|\d+\.)\s+/.test(l))) {
      const isOrdered = /^\s*\d+\.\s+/.test(blockLines[0]);
      const ListTag = isOrdered ? 'ol' : 'ul';
      return (
        <ListTag
          key={`b-${bIdx}`}
          className={`my-2.5 pl-5 space-y-1.5 font-serif ${fontSizeClass} leading-[1.8] text-stone-900 ${
            isOrdered ? 'list-decimal' : 'list-disc'
          }`}
        >
          {blockLines.map((item, li) => (
            <li key={li}>
              {renderInlineNodes(item.replace(/^\s*([-*+]|\d+\.)\s+/, ''), footnotes, `li-${bIdx}-${li}`)}
            </li>
          ))}
        </ListTag>
      );
    }

    // 7. Standard Paragraph
    return (
      <p
        key={`b-${bIdx}`}
        className={`my-2.5 font-serif ${fontSizeClass} leading-[1.85] text-stone-900 break-words`}
      >
        {renderInlineNodes(trimmed, footnotes, `p-${bIdx}`)}
      </p>
    );
  });

  return (
    <div className={`academic-rendered-block ${className}`}>
      {renderedBlocks}
      {footnotes.length > 0 && (
        <aside className="mt-4 pt-3 border-t border-stone-200 space-y-1.5 text-xs font-serif text-stone-600">
          <div className="font-sans text-[11px] font-semibold text-stone-500">脚注</div>
          {footnotes.map((fn, idx) => (
            <div key={idx} className="flex items-start gap-2 leading-relaxed">
              <span className="font-sans font-semibold text-emerald-800 shrink-0">[{idx + 1}]</span>
              <div>{renderInlineNodes(fn, [], `fn-body-${idx}`)}</div>
            </div>
          ))}
        </aside>
      )}
      {zoomedFig && <FigureZoomModal fig={zoomedFig} onClose={() => setZoomedFig(null)} />}
    </div>
  );
}
