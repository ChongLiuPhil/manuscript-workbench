import { execFile, execFileSync } from 'child_process';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { canSafelyDeleteOrRecloneRepo, canSafelyFastForwardBase } from './src/utils/repoGuard.ts';

dotenv.config();

const WORKBENCH_DATA_DIR = path.resolve(
  (process.env.WORKBENCH_DATA_DIR || '').trim() || path.join(process.cwd(), '.workbench-data')
);
// Keep cloned target repo outside the app workspace by default so cloud IDE / snapshot syncs
// never overwrite or delete its .git metadata or working-tree files.
const TARGET_REPO_DIR = path.resolve(
  (process.env.WORKBENCH_REPO_DIR || '').trim() || path.join(os.tmpdir(), 'manuscript-workbench-repo')
);
const CONFIG_FILE = path.join(WORKBENCH_DATA_DIR, 'config.json');
const STATE_FILE = path.join(WORKBENCH_DATA_DIR, 'state.json');
const LEGACY_WORKSPACE_REPO_DIR = path.join(WORKBENCH_DATA_DIR, 'target-repo');
const LEGACY_TMP_REPO_DIR = '/tmp/target-repo';
const LEGACY_TMP_CONFIG_FILE = '/tmp/manuscript-workbench-config.json';
const LEGACY_TMP_STATE_FILE = '/tmp/manuscript-workbench-state.json';
const WORKFLOW_MD_FILE = path.resolve(process.cwd(), 'WORKFLOW_INSTRUCTIONS.md');
const DEFAULT_BASE_BRANCH = 'main';
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_REF_RE = /^[A-Za-z0-9_./@^~-]+$/;

function atomicWriteFileSync(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function migrateLegacyTmpWorkspaceIfNeeded(): void {
  try {
    fs.mkdirSync(WORKBENCH_DATA_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(LEGACY_TMP_CONFIG_FILE)) {
      fs.copyFileSync(LEGACY_TMP_CONFIG_FILE, CONFIG_FILE);
    }
    if (!fs.existsSync(STATE_FILE) && fs.existsSync(LEGACY_TMP_STATE_FILE)) {
      fs.copyFileSync(LEGACY_TMP_STATE_FILE, STATE_FILE);
    }
    if (!fs.existsSync(TARGET_REPO_DIR)) {
      const legacySource =
        LEGACY_WORKSPACE_REPO_DIR !== TARGET_REPO_DIR &&
        fs.existsSync(path.join(LEGACY_WORKSPACE_REPO_DIR, '.git'))
          ? LEGACY_WORKSPACE_REPO_DIR
          : LEGACY_TMP_REPO_DIR !== TARGET_REPO_DIR &&
              fs.existsSync(path.join(LEGACY_TMP_REPO_DIR, '.git'))
            ? LEGACY_TMP_REPO_DIR
            : null;
      if (legacySource) {
        fs.mkdirSync(path.dirname(TARGET_REPO_DIR), { recursive: true });
        fs.cpSync(legacySource, TARGET_REPO_DIR, { recursive: true });
      }
    }
  } catch (err) {
    console.warn('Legacy workspace migration warning:', String(err));
  }
}

interface RuntimeConfig {
  repoSlug: string;
  defaultBase: string;
}

const autoMountState: {
  inProgress: boolean;
  error: string | null;
  attemptedAt: number;
} = {
  inProgress: false,
  error: null,
  attemptedAt: 0,
};

function computeWorktreeDigest(dirtyLines: string[]): string {
  if (dirtyLines.length === 0) return '';
  const parts: string[] = [];
  for (const rawLine of dirtyLines) {
    const body = rawLine.slice(2).trim();
    const relPath = body.includes(' -> ') ? body.split(' -> ').pop()!.trim() : body;
    const unquoted = relPath.replace(/^"|"$/g, '');
    const full = safeResolveRepoPath(unquoted);
    if (full && fs.existsSync(full)) {
      try {
        const st = fs.statSync(full);
        parts.push(`${rawLine}:${st.size}:${Math.floor(st.mtimeMs)}`);
        continue;
      } catch {
        // fall back to raw status line
      }
    }
    parts.push(`${rawLine}:missing`);
  }
  return sha256Text(parts.join('\n'));
}

interface BilingualPairInfo {
  id: string;
  group: string;
  groupLabel: string;
  orderLabel: string;
  title: string;
  enTitle: string;
  canonical: string;
  translation?: string;
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  beforeLines: string[];
  afterLines: string[];
}

interface FileDiffRaw {
  filePath: string;
  status: string;
  additions: number;
  deletions: number;
  hunks: ParsedHunk[];
  isBinary: boolean;
}

function getGithubToken(): string {
  return (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
}

function getGitAuthArgs(): string[] {
  const token = getGithubToken();
  if (!token) return [];
  const encoded = Buffer.from(`git:${token}`, 'utf-8').toString('base64');
  return ['-c', `http.extraHeader=AUTHORIZATION: Basic ${encoded}`];
}

function loadConfig(): RuntimeConfig {
  const envRepo = (process.env.GITHUB_REPO || '').trim();
  let fileCfg: Partial<RuntimeConfig> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      fileCfg = {};
    }
  }
  const repoSlug = (
    fileCfg.repoSlug ||
    (REPO_SLUG_RE.test(envRepo) ? envRepo : '')
  ).trim();
  const defaultBase = (fileCfg.defaultBase || DEFAULT_BASE_BRANCH).trim() || DEFAULT_BASE_BRANCH;
  return { repoSlug, defaultBase };
}

function saveConfig(cfg: RuntimeConfig): void {
  atomicWriteFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function isRepoCloned(): boolean {
  return fs.existsSync(path.join(TARGET_REPO_DIR, '.git'));
}

function runGit(args: string[], opts?: { auth?: boolean; cwd?: string }): string {
  const cmdArgs = ['-c', 'core.quotePath=false'];
  if (opts?.auth) {
    cmdArgs.push(...getGitAuthArgs());
  }
  cmdArgs.push(...args);
  return execFileSync('git', cmdArgs, {
    cwd: opts?.cwd ?? TARGET_REPO_DIR,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function safeResolveRepoPath(relPath: string): string | null {
  const cleaned = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0')) return null;
  const resolved = path.resolve(TARGET_REPO_DIR, cleaned);
  const rootWithSep = path.resolve(TARGET_REPO_DIR) + path.sep;
  if (!resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

function sha256Text(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 12);
}

function detectCustomDashboard(): string | null {
  if (!isRepoCloned()) return null;
  const candidates = [
    'research-dashboard.html',
    'public/research-dashboard.html',
    'docs/research-dashboard.html',
  ];
  for (const rel of candidates) {
    const full = safeResolveRepoPath(rel);
    if (full && fs.existsSync(full) && fs.statSync(full).isFile()) {
      return rel;
    }
  }
  return null;
}

function detectRepoVerificationScripts(): Array<{
  id: string;
  name: string;
  relPath: string;
  runner: 'python3' | 'node';
}> {
  if (!isRepoCloned()) return [];
  const scriptsDir = path.join(TARGET_REPO_DIR, 'scripts');
  const found: Array<{ id: string; name: string; relPath: string; runner: 'python3' | 'node' }> = [];
  if (fs.existsSync(scriptsDir) && fs.statSync(scriptsDir).isDirectory()) {
    const entries = fs.readdirSync(scriptsDir).sort();
    for (const file of entries) {
      if (
        file.endsWith('.py') &&
        /^(test_|check_|verify_)/.test(file) &&
        !file.includes('ci_regression_runner')
      ) {
        found.push({
          id: `py:${file}`,
          name: file,
          relPath: `scripts/${file}`,
          runner: 'python3',
        });
      }
    }
  }
  return found.slice(0, 8);
}

function extractTitleFromContent(content: string, fallback: string): string {
  const lines = content.split('\n').slice(0, 60);
  for (const line of lines) {
    const t = line.trim();
    const yamlTitle = t.match(/^title:\s*["']?(.+?)["']?\s*$/);
    if (yamlTitle && yamlTitle[1]) return yamlTitle[1].trim();
    const mdHeading = t.match(/^#\s+(.+)$/);
    if (mdHeading && mdHeading[1]) return mdHeading[1].replace(/\{#[^}]+\}/g, '').trim();
    const texTitle = t.match(/^\\title(?:\[[^\]]*\])?\{(.+)\}/);
    if (texTitle && texTitle[1]) return texTitle[1].replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1').trim();
  }
  return fallback;
}

function discoverBilingualPairs(): BilingualPairInfo[] {
  if (!isRepoCloned()) return [];

  const seenCanonical = new Set<string>();
  const seenAny = new Set<string>();
  const pairs: BilingualPairInfo[] = [];

  const addPair = (info: BilingualPairInfo) => {
    const cnFull = safeResolveRepoPath(info.canonical);
    if (!cnFull || !fs.existsSync(cnFull) || !fs.statSync(cnFull).isFile()) return;
    if (seenCanonical.has(info.canonical)) return;
    seenCanonical.add(info.canonical);
    seenAny.add(info.canonical);

    let translation = info.translation;
    if (translation) {
      const enFull = safeResolveRepoPath(translation);
      if (!enFull || !fs.existsSync(enFull) || !fs.statSync(enFull).isFile()) {
        translation = undefined;
      } else {
        seenAny.add(translation);
      }
    }
    const cnContent = fs.readFileSync(cnFull, 'utf-8');
    const enContent = translation ? fs.readFileSync(path.join(TARGET_REPO_DIR, translation), 'utf-8') : '';
    const title = info.title || extractTitleFromContent(cnContent, path.basename(info.canonical));
    const enTitle =
      info.enTitle ||
      (translation ? extractTitleFromContent(enContent, path.basename(translation)) : title);

    pairs.push({
      ...info,
      title,
      enTitle,
      translation,
    });
  };

  // 1. Structured discovery via content/source-manifest.json if present
  const manifestPath = path.join(TARGET_REPO_DIR, 'content/source-manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const indexCn = 'content/index.qmd';
      if (fs.existsSync(path.join(TARGET_REPO_DIR, indexCn))) {
        addPair({
          id: 'doc-index',
          group: 'book',
          groupLabel: '书稿与章节',
          orderLabel: '导言 · Index',
          title: '',
          enTitle: '',
          canonical: indexCn,
          translation: 'content/en/index.qmd',
        });
      }
      const guideCn = 'content/reading-guide.qmd';
      if (fs.existsSync(path.join(TARGET_REPO_DIR, guideCn))) {
        addPair({
          id: 'doc-guide',
          group: 'book',
          groupLabel: '书稿与章节',
          orderLabel: '阅读说明 · Guide',
          title: '',
          enTitle: '',
          canonical: guideCn,
          translation: 'content/en/reading-guide.qmd',
        });
      }
      const chapters = manifest?.book?.chapters;
      if (Array.isArray(chapters)) {
        chapters.forEach((ch: Record<string, string>, idx: number) => {
          if (ch?.source) {
            addPair({
              id: ch.id || `chapter-${idx + 1}`,
              group: 'book',
              groupLabel: '书稿与章节',
              orderLabel: `第 ${idx + 1} 篇`,
              title: ch.title || '',
              enTitle: ch.en_title || ch.enTitle || '',
              canonical: ch.source,
              translation: ch.translation,
            });
          }
        });
      }
      const appendices = manifest?.appendices;
      if (Array.isArray(appendices)) {
        appendices.forEach((app: Record<string, string>, idx: number) => {
          if (!app?.source || seenAny.has(app.source)) return;
          if (app.language && app.language.toLowerCase().startsWith('en')) return;
          let enMatch: string | undefined;
          if (app.id && app.id.endsWith('-cn')) {
            const counterpart = appendices.find(
              (a: Record<string, string>) => a.id === `${app.id.slice(0, -3)}-en`
            );
            enMatch = counterpart?.source;
          }
          addPair({
            id: app.id || `appendix-${idx + 1}`,
            group: 'papers',
            groupLabel: '论文与附录',
            orderLabel: `附录 ${idx + 1}`,
            title: app.title || '',
            enTitle: '',
            canonical: app.source,
            translation: enMatch,
          });
        });
      }
    } catch {
      // Fall through to translations.json / heuristic scan
    }
  }

  // 2. Bilingual mapping via content/translations.json if present
  const transPath = path.join(TARGET_REPO_DIR, 'content/translations.json');
  if (fs.existsSync(transPath)) {
    try {
      const transData = JSON.parse(fs.readFileSync(transPath, 'utf-8'));
      const entries = Array.isArray(transData?.pages)
        ? transData.pages
        : Array.isArray(transData?.pairs)
        ? transData.pairs
        : [];
      entries.forEach((entry: Record<string, string>, idx: number) => {
        const cn = entry.canonical || entry.source || entry.zh;
        const en = entry.translation || entry.target || entry.en;
        if (cn && !seenAny.has(cn)) {
          const isTex = cn.endsWith('.tex');
          addPair({
            id: entry.id || `pair-${idx + 1}`,
            group: isTex ? 'papers' : 'book',
            groupLabel: isTex ? '论文与 LaTeX' : '文档与章节',
            orderLabel: path.basename(cn),
            title: entry.title || '',
            enTitle: entry.en_title || entry.enTitle || '',
            canonical: cn,
            translation: en,
          });
        }
      });
    } catch {
      // Ignore invalid JSON
    }
  }

  // 3. Heuristic discovery across all tracked .qmd / .tex / .md files
  let trackedFiles: string[] = [];
  try {
    trackedFiles = runGit(['ls-files']).split('\n').filter(Boolean);
  } catch {
    trackedFiles = [];
  }
  const trackedSet = new Set(trackedFiles);
  const manuscriptExts = /\.(qmd|tex|md)$/i;

  const findCounterpart = (rel: string): string | undefined => {
    const candidates: string[] = [];
    if (rel.startsWith('content/book/')) {
      candidates.push(rel.replace(/^content\/book\//, 'content/en/book/'));
    } else if (rel.startsWith('content/') && !rel.startsWith('content/en/')) {
      candidates.push(rel.replace(/^content\//, 'content/en/'));
    }
    if (rel.includes('/zh/')) {
      candidates.push(rel.replace('/zh/', '/en/'));
    }
    if (/_cn(\.[a-z]+)$/i.test(rel)) {
      const base = rel.replace(/_cn(\.[a-z]+)$/i, '');
      const ext = rel.match(/(\.[a-z]+)$/i)?.[1] || '';
      candidates.push(`${base}_en${ext}`, `${base}_en_later${ext}`);
    }
    if (/_zh(\.[a-z]+)$/i.test(rel)) {
      const base = rel.replace(/_zh(\.[a-z]+)$/i, '');
      const ext = rel.match(/(\.[a-z]+)$/i)?.[1] || '';
      candidates.push(`${base}_en${ext}`);
    }
    if (/\.zh(\.[a-z]+)$/i.test(rel)) {
      candidates.push(rel.replace(/\.zh(\.[a-z]+)$/i, '.en$1'));
    }
    for (const c of candidates) {
      if (trackedSet.has(c) && !seenAny.has(c)) return c;
    }
    return undefined;
  };

  // First pass: pair obvious primary files
  const remaining = trackedFiles.filter(
    (f) =>
      manuscriptExts.test(f) &&
      !seenAny.has(f) &&
      !f.startsWith('.github/') &&
      !f.startsWith('node_modules/')
  );

  for (const rel of remaining) {
    if (seenAny.has(rel)) continue;
    // Skip obvious translation files in first pass so their canonical counterpart claims them
    if (
      rel.startsWith('content/en/') ||
      rel.includes('/en/') ||
      /_en(?:_later)?\.[a-z]+$/i.test(rel) ||
      /\.en\.[a-z]+$/i.test(rel)
    ) {
      continue;
    }
    const enMatch = findCounterpart(rel);
    const isTex = rel.endsWith('.tex');
    const isDoc = rel.startsWith('docs/') || /^README/i.test(rel);
    addPair({
      id: `auto-${pairs.length + 1}`,
      group: isTex ? 'papers' : isDoc ? 'docs' : 'book',
      groupLabel: isTex ? '论文 (.tex)' : isDoc ? '项目文档' : '文稿章节',
      orderLabel: path.basename(rel),
      title: '',
      enTitle: '',
      canonical: rel,
      translation: enMatch,
    });
  }

  // Second pass: add any unpaired remaining markdown/tex/qmd files
  for (const rel of remaining) {
    if (seenAny.has(rel)) continue;
    const isTex = rel.endsWith('.tex');
    const isDoc = rel.startsWith('docs/') || /^README/i.test(rel);
    addPair({
      id: `auto-${pairs.length + 1}`,
      group: isTex ? 'papers' : isDoc ? 'docs' : 'book',
      groupLabel: isTex ? '论文 (.tex)' : isDoc ? '项目文档' : '文稿章节',
      orderLabel: path.basename(rel),
      title: '',
      enTitle: '',
      canonical: rel,
    });
  }

  return pairs;
}

function getRepoStatusPayload() {
  const cfg = loadConfig();
  const hasToken = Boolean(getGithubToken());
  const cloned = isRepoCloned();
  if (!cloned) {
    return {
      ok: true,
      configured: Boolean(cfg.repoSlug),
      cloned: false,
      repoSlug: cfg.repoSlug,
      repoDir: TARGET_REPO_DIR,
      defaultBase: cfg.defaultBase,
      branch: '',
      localShort: '',
      remoteShort: '',
      aheadOfRemote: 0,
      inSyncWithRemote: false,
      hasLocalDraftEdits: false,
      dirtyCount: 0,
      dirtyFiles: [],
      worktreeDigest: '',
      autoMounting: autoMountState.inProgress,
      autoMountError: autoMountState.error,
      recentCommits: [],
      branches: [],
      hasCustomDashboard: false,
      dashboardPath: null,
      detectedScripts: [],
      hasToken,
    };
  }

  let repoSlug = cfg.repoSlug;
  try {
    const remoteUrl = runGit(['remote', 'get-url', 'origin']).trim();
    const m = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    if (m && m[1]) repoSlug = m[1];
  } catch {
    // ignore
  }

  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const localHead = runGit(['rev-parse', 'HEAD']).trim();
  const localShort = runGit(['rev-parse', '--short', 'HEAD']).trim();

  let remoteHead = localHead;
  let remoteShort = localShort;
  for (const ref of [`origin/${branch}`, `origin/${cfg.defaultBase}`]) {
    try {
      remoteHead = runGit(['rev-parse', ref]).trim();
      remoteShort = runGit(['rev-parse', '--short', ref]).trim();
      break;
    } catch {
      // try next
    }
  }

  let aheadOfRemote = 0;
  try {
    aheadOfRemote = parseInt(runGit(['rev-list', '--count', `${remoteHead}..HEAD`]).trim(), 10) || 0;
  } catch {
    aheadOfRemote = 0;
  }

  const dirtyFiles = runGit(['status', '--short'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const recentCommits = runGit(['log', '-n', '6', '--oneline'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const branchSet = new Set<string>();
  try {
    const localRefs = runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    localRefs.forEach((b) => branchSet.add(b));
    const remoteRefs = runGit(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && s !== 'origin/HEAD' && !s.endsWith('/HEAD'));
    remoteRefs.forEach((b) => branchSet.add(b));
  } catch {
    // ignore
  }

  const dashboardPath = detectCustomDashboard();
  const detectedScripts = detectRepoVerificationScripts();

  return {
    ok: true,
    configured: Boolean(repoSlug),
    cloned: true,
    repoSlug,
    repoDir: TARGET_REPO_DIR,
    defaultBase: cfg.defaultBase,
    branch,
    localHead,
    localShort,
    remoteHead,
    remoteShort,
    aheadOfRemote,
    inSyncWithRemote: localHead === remoteHead && dirtyFiles.length === 0,
    hasLocalDraftEdits: dirtyFiles.length > 0,
    dirtyCount: dirtyFiles.length,
    dirtyFiles,
    worktreeDigest: computeWorktreeDigest(dirtyFiles),
    autoMounting: false,
    autoMountError: null,
    recentCommits,
    branches: Array.from(branchSet),
    hasCustomDashboard: Boolean(dashboardPath),
    dashboardPath,
    detectedScripts,
    hasToken,
  };
}

function parseUnifiedDiff(diffText: string): FileDiffRaw[] {
  const files: FileDiffRaw[] = [];
  const lines = diffText.split('\n');
  let current: FileDiffRaw | null = null;
  let currentHunk: ParsedHunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      if (current) {
        if (currentHunk) current.hunks.push(currentHunk);
        files.push(current);
      }
      currentHunk = null;
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const filePath = m ? m[2] : line.slice('diff --git '.length);
      current = {
        filePath,
        status: 'modified',
        additions: 0,
        deletions: 0,
        hunks: [],
        isBinary: false,
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('Binary files ')) {
      current.isBinary = true;
      continue;
    }
    if (line.startsWith('+++ b/')) {
      current.filePath = line.slice('+++ b/'.length);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ')) {
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (currentHunk) current.hunks.push(currentHunk);
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
        beforeLines: [],
        afterLines: [],
      };
      continue;
    }

    if (currentHunk) {
      if (line.startsWith('-')) {
        currentHunk.beforeLines.push(line.slice(1));
        current.deletions++;
      } else if (line.startsWith('+')) {
        currentHunk.afterLines.push(line.slice(1));
        current.additions++;
      } else if (line.startsWith(' ')) {
        currentHunk.beforeLines.push(line.slice(1));
        currentHunk.afterLines.push(line.slice(1));
      }
    }
  }

  if (current) {
    if (currentHunk) current.hunks.push(currentHunk);
    files.push(current);
  }

  return files;
}

function readFileLinesAtRef(ref: string, relPath: string): string[] {
  if (ref === 'WORKING_TREE') {
    const full = safeResolveRepoPath(relPath);
    if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return [];
    const raw = fs.readFileSync(full, 'utf-8');
    return raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n');
  }
  try {
    const raw = runGit(['show', `${ref}:${relPath}`]);
    return raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n');
  } catch {
    return [];
  }
}

function formatLineRange(start: number, count: number): string {
  if (count <= 0) return `L${start}`;
  if (count === 1) return `L${start}`;
  return `L${start}–L${start + count - 1}`;
}

function sliceLineRange(lines: string[], start: number, count: number): string {
  if (!lines.length) return '';
  const s = Math.max(1, start);
  const e = Math.min(lines.length, Math.max(s, s + Math.max(1, count) - 1));
  return lines.slice(s - 1, e).join('\n');
}

function lintGenericManuscript(text: string, relPath: string) {
  const lines = String(text || '').split('\n');
  const findings: Array<{
    ruleId: string;
    severity: string;
    line: number;
    matched: string;
    title: string;
    replacement: string;
    rationale: string;
    context: string;
  }> = [];

  // Optional repo-local custom lint rules (.workbench-lint.json)
  let customRules: Array<{
    id: string;
    severity?: string;
    pattern: string;
    title: string;
    replacement?: string;
    rationale?: string;
  }> = [];
  const customRulesPath = path.join(TARGET_REPO_DIR, '.workbench-lint.json');
  if (isRepoCloned() && fs.existsSync(customRulesPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(customRulesPath, 'utf-8'));
      if (Array.isArray(parsed?.rules)) customRules = parsed.rules;
    } catch {
      customRules = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(<<<<<<<|=======|>>>>>>>)/.test(line)) {
      findings.push({
        ruleId: 'GIT_CONFLICT_MARKER',
        severity: 'ERROR',
        line: i + 1,
        matched: line.slice(0, 20),
        title: '检测到未解决的 Git 合并冲突标记',
        replacement: '解决冲突并移除冲突标记',
        rationale: '文稿中残留合并冲突标记会导致编译或渲染失败。',
        context: line.trim().slice(0, 140),
      });
    }

    if (/\.(qmd|tex|md)$/i.test(relPath)) {
      const stripped = line.replace(/\\\$/g, '').replace(/\$\$/g, '');
      const dollarCount = (stripped.match(/\$/g) || []).length;
      if (dollarCount % 2 === 1) {
        findings.push({
          ruleId: 'UNBALANCED_INLINE_MATH',
          severity: 'WARN',
          line: i + 1,
          matched: '$',
          title: '行内数学公式 $ 分隔符数量为奇数',
          replacement: '核查成对 $...$ 闭合',
          rationale: '同一行内出现未闭合的 $ 可能导致公式渲染异常（若为跨行公式可忽略）。',
          context: line.trim().slice(0, 140),
        });
      }
    }

    for (const rule of customRules) {
      try {
        const re = new RegExp(rule.pattern, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          findings.push({
            ruleId: rule.id || 'CUSTOM_RULE',
            severity: rule.severity || 'WARN',
            line: i + 1,
            matched: m[0],
            title: rule.title || '仓库自定义术语规则提示',
            replacement: rule.replacement || '',
            rationale: rule.rationale || '',
            context: line.trim().slice(0, 140),
          });
        }
      } catch {
        // Ignore malformed custom regex
      }
    }
  }

  return {
    path: relPath,
    totalFindings: findings.length,
    errorCount: findings.filter((f) => f.severity === 'ERROR').length,
    warnCount: findings.filter((f) => f.severity === 'WARN').length,
    passed: findings.filter((f) => f.severity === 'ERROR').length === 0,
    findings: findings.slice(0, 50),
  };
}

function autoMountFromEnvIfNeeded() {
  migrateLegacyTmpWorkspaceIfNeeded();
  const cfg = loadConfig();
  if (isRepoCloned() || autoMountState.inProgress) return;
  if (!cfg.repoSlug || !REPO_SLUG_RE.test(cfg.repoSlug)) return;

  // Never delete a non-empty TARGET_REPO_DIR automatically: protect local files unconditionally.
  if (fs.existsSync(TARGET_REPO_DIR)) {
    try {
      const entries = fs.readdirSync(TARGET_REPO_DIR);
      if (entries.length > 0) {
        autoMountState.error =
          '持久化工作目录已存在非空文件但缺少 .git 元数据，为防止丢失本地内容已中止自动清空与重新克隆。';
        return;
      }
      fs.rmdirSync(TARGET_REPO_DIR);
    } catch (err) {
      autoMountState.error = `检查持久化工作目录失败：${String(err)}`;
      return;
    }
  }

  autoMountState.inProgress = true;
  autoMountState.error = null;
  autoMountState.attemptedAt = Date.now();

  try {
    fs.mkdirSync(path.dirname(TARGET_REPO_DIR), { recursive: true });
  } catch (err) {
    autoMountState.inProgress = false;
    autoMountState.error = `初始化目标仓库运行目录失败：${String(err)}`;
    return;
  }

  const cleanUrl = `https://github.com/${cfg.repoSlug}.git`;
  const cmdArgs = ['-c', 'core.quotePath=false', ...getGitAuthArgs(), 'clone', cleanUrl, TARGET_REPO_DIR];

  execFile(
    'git',
    cmdArgs,
    { cwd: path.dirname(TARGET_REPO_DIR), encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, timeout: 90_000 },
    (err, _stdout, stderr) => {
      autoMountState.inProgress = false;
      if (err) {
        const sanitized = String(stderr || err.message || err)
          .replace(/AUTHORIZATION:\s*Basic\s+[A-Za-z0-9+/=]+/gi, 'AUTHORIZATION: Basic [REDACTED]')
          .trim()
          .split('\n')
          .slice(-2)
          .join(' ');
        autoMountState.error = sanitized || '自动拉取仓库失败，请点击重新挂载。';
      } else {
        autoMountState.error = null;
      }
    }
  );
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // 1. Unified Repo Status API
  app.get('/api/repo-status', (_req, res) => {
    try {
      res.json(getRepoStatusPayload());
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // 2. Mount or Switch Target Repository (persistent workspace .workbench-data/target-repo)
  app.post('/api/repo/mount', (req, res) => {
    try {
      const rawSlug = String(req.body?.repoSlug || '')
        .trim()
        .replace(/^https?:\/\/github\.com\//, '')
        .replace(/\.git$/, '');
      const baseBranch = String(req.body?.baseBranch || DEFAULT_BASE_BRANCH).trim() || DEFAULT_BASE_BRANCH;

      if (!REPO_SLUG_RE.test(rawSlug)) {
        res.status(400).json({ ok: false, error: '无效的仓库格式，请输入 owner/repo。' });
        return;
      }
      if (!SAFE_REF_RE.test(baseBranch)) {
        res.status(400).json({ ok: false, error: '无效的分支名称。' });
        return;
      }

      const cleanUrl = `https://github.com/${rawSlug}.git`;
      let needFreshClone = !isRepoCloned();
      if (!needFreshClone) {
        try {
          const curUrl = runGit(['remote', 'get-url', 'origin']).trim();
          if (!curUrl.toLowerCase().includes(rawSlug.toLowerCase())) {
            needFreshClone = true;
          }
        } catch {
          needFreshClone = true;
        }
      }

      const forceResetBrokenDir = Boolean(req.body?.forceResetBrokenDir);
      if (needFreshClone) {
        if (isRepoCloned()) {
          const currentStatus = getRepoStatusPayload();
          const guard = canSafelyDeleteOrRecloneRepo({
            hasRepo: true,
            dirtyCount: currentStatus.dirtyCount,
            aheadOfRemote: currentStatus.aheadOfRemote,
            currentBranch: currentStatus.branch,
            defaultBase: currentStatus.defaultBase,
          });
          if (!guard.allowed) {
            res.status(409).json({ ok: false, error: guard.reason });
            return;
          }
          fs.rmSync(TARGET_REPO_DIR, { recursive: true, force: true });
        } else if (fs.existsSync(TARGET_REPO_DIR)) {
          const entries = fs.readdirSync(TARGET_REPO_DIR);
          if (entries.length > 0 && !forceResetBrokenDir) {
            res.status(409).json({
              ok: false,
              error:
                '目标仓库目录包含非空文件但缺少 .git 元数据，防丢失保护已阻止自动清空。如需强制重建，请传入 forceResetBrokenDir: true。',
            });
            return;
          }
          fs.rmSync(TARGET_REPO_DIR, { recursive: true, force: true });
        }
        fs.mkdirSync(path.dirname(TARGET_REPO_DIR), { recursive: true });
        runGit(['clone', cleanUrl, TARGET_REPO_DIR], { auth: true, cwd: path.dirname(TARGET_REPO_DIR) });
      } else {
        runGit(['remote', 'set-url', 'origin', cleanUrl]);
        runGit(['fetch', 'origin', '--prune'], { auth: true });
      }

      // Ensure baseBranch exists or fall back to current default HEAD branch
      let effectiveBase = baseBranch;
      try {
        runGit(['rev-parse', '--verify', `origin/${baseBranch}`]);
      } catch {
        try {
          effectiveBase = runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim() || DEFAULT_BASE_BRANCH;
        } catch {
          effectiveBase = DEFAULT_BASE_BRANCH;
        }
      }

      autoMountState.inProgress = false;
      autoMountState.error = null;
      saveConfig({ repoSlug: rawSlug, defaultBase: effectiveBase });
      res.json(getRepoStatusPayload());
    } catch (err: unknown) {
      const msg =
        (err as { stderr?: string; message?: string })?.stderr ||
        (err as { message?: string })?.message ||
        String(err);
      res.status(500).json({
        ok: false,
        error: `挂载仓库失败：${msg.split('\n').slice(-2).join(' ')}`,
      });
    }
  });

  // 3. Sync remote refs safely (NEVER overwrite dirty edits, unpushed commits, or active revision branches)
  app.post('/api/sync-github', (_req, res) => {
    try {
      if (!isRepoCloned()) {
        res.status(400).json({ ok: false, error: '尚未挂载目标仓库，请先设置 owner/repo。' });
        return;
      }
      const cfg = loadConfig();
      runGit(['fetch', 'origin', '--prune'], { auth: true });
      const statusBefore = getRepoStatusPayload();
      const ffGuard = canSafelyFastForwardBase({
        dirtyCount: statusBefore.dirtyCount,
        aheadOfRemote: statusBefore.aheadOfRemote,
        currentBranch: statusBefore.branch,
        defaultBase: cfg.defaultBase,
      });
      if (ffGuard.allowed) {
        try {
          runGit(['merge', '--ff-only', `origin/${cfg.defaultBase}`]);
        } catch {
          // Keep local branch untouched if non-fast-forward
        }
      }
      res.json({
        ...getRepoStatusPayload(),
        syncNotice: ffGuard.allowed ? null : ffGuard.reason || null,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // 4. Fetch open GitHub Pull Requests for mounted repo (for dropdown selection)
  app.get('/api/repo/pulls', async (_req, res) => {
    try {
      const status = getRepoStatusPayload();
      if (!status.cloned || !status.repoSlug) {
        res.json({ ok: true, pulls: [] });
        return;
      }
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'manuscript-workbench',
      };
      const token = getGithubToken();
      if (token) headers.Authorization = `Bearer ${token}`;

      const resp = await fetch(
        `https://api.github.com/repos/${status.repoSlug}/pulls?state=open&per_page=20`,
        { headers }
      );
      if (!resp.ok) {
        res.json({ ok: true, pulls: [] });
        return;
      }
      const data = (await resp.json()) as Array<{
        number: number;
        title: string;
        draft?: boolean;
        updated_at?: string;
        head?: { ref?: string; sha?: string };
        base?: { ref?: string };
      }>;
      const pulls = data.map((pr) => ({
        number: pr.number,
        title: pr.title,
        headRef: pr.head?.ref || `pr/${pr.number}`,
        headSha: (pr.head?.sha || '').slice(0, 7),
        baseRef: pr.base?.ref || status.defaultBase,
        draft: Boolean(pr.draft),
        updatedAt: pr.updated_at || '',
      }));
      res.json({ ok: true, pulls });
    } catch {
      res.json({ ok: true, pulls: [] });
    }
  });

  // 4a. Read-only PR inspection (status, mergeability, check-runs, reviews, comments)
  app.get('/api/repo/pr/:number', async (req, res) => {
    try {
      const prNum = Number(req.params.number);
      if (!Number.isInteger(prNum) || prNum <= 0) {
        res.status(400).json({ ok: false, error: '无效 PR 编号。' });
        return;
      }
      const cfg = loadConfig();
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'manuscript-workbench',
      };
      const token = getGithubToken();
      if (token) headers.Authorization = `Bearer ${token}`;

      const prResp = await fetch(`https://api.github.com/repos/${cfg.repoSlug}/pulls/${prNum}`, { headers });
      if (!prResp.ok) {
        res.status(prResp.status).json({ ok: false, error: `GitHub API 错误: HTTP ${prResp.status}` });
        return;
      }
      const pr = (await prResp.json()) as {
        number: number;
        title: string;
        state: string;
        draft?: boolean;
        merged?: boolean;
        mergeable?: boolean | null;
        mergeable_state?: string;
        html_url: string;
        head?: { ref?: string; sha?: string };
        base?: { ref?: string; sha?: string };
        changed_files?: number;
        additions?: number;
        deletions?: number;
        commits?: number;
      };
      const headSha = pr.head?.sha || '';

      const [checksResp, reviewsResp, reviewCommentsResp, issueCommentsResp] = await Promise.all([
        headSha
          ? fetch(`https://api.github.com/repos/${cfg.repoSlug}/commits/${headSha}/check-runs?per_page=50`, { headers })
          : Promise.resolve(null),
        fetch(`https://api.github.com/repos/${cfg.repoSlug}/pulls/${prNum}/reviews?per_page=50`, { headers }),
        fetch(`https://api.github.com/repos/${cfg.repoSlug}/pulls/${prNum}/comments?per_page=50`, { headers }),
        fetch(`https://api.github.com/repos/${cfg.repoSlug}/issues/${prNum}/comments?per_page=50`, { headers }),
      ]);

      const checkRuns =
        checksResp && checksResp.ok
          ? (
              ((await checksResp.json()) as {
                check_runs?: Array<{
                  name: string;
                  status: string;
                  conclusion: string | null;
                  completed_at?: string;
                  html_url?: string;
                }>;
              }).check_runs || []
            ).map((c) => ({
              name: c.name,
              status: c.status,
              conclusion: c.conclusion,
              completedAt: c.completed_at || '',
            }))
          : [];

      const reviews = reviewsResp.ok
        ? (
            (await reviewsResp.json()) as Array<{
              user?: { login?: string };
              state?: string;
              commit_id?: string;
              body?: string;
              submitted_at?: string;
            }>
          ).map((rv) => ({
            author: rv.user?.login || '',
            state: rv.state || '',
            commitId: (rv.commit_id || '').slice(0, 7),
            body: (rv.body || '').slice(0, 800),
            submittedAt: rv.submitted_at || '',
          }))
        : [];

      const reviewComments = reviewCommentsResp.ok
        ? (
            (await reviewCommentsResp.json()) as Array<{
              user?: { login?: string };
              path?: string;
              line?: number;
              commit_id?: string;
              original_commit_id?: string;
              body?: string;
              created_at?: string;
            }>
          ).map((cm) => ({
            author: cm.user?.login || '',
            path: cm.path || '',
            line: cm.line || null,
            commitId: (cm.commit_id || '').slice(0, 7),
            originalCommitId: (cm.original_commit_id || '').slice(0, 7),
            body: (cm.body || '').slice(0, 800),
            createdAt: cm.created_at || '',
          }))
        : [];

      const issueComments = issueCommentsResp.ok
        ? (
            (await issueCommentsResp.json()) as Array<{
              user?: { login?: string };
              body?: string;
              created_at?: string;
            }>
          ).map((cm) => ({
            author: cm.user?.login || '',
            body: (cm.body || '').slice(0, 800),
            createdAt: cm.created_at || '',
          }))
        : [];

      res.json({
        ok: true,
        pr: {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: Boolean(pr.draft),
          merged: Boolean(pr.merged),
          mergeable: pr.mergeable,
          mergeableState: pr.mergeable_state || '',
          htmlUrl: pr.html_url,
          headRef: pr.head?.ref || '',
          headSha,
          baseRef: pr.base?.ref || '',
          baseSha: pr.base?.sha || '',
          changedFiles: pr.changed_files || 0,
          additions: pr.additions || 0,
          deletions: pr.deletions || 0,
          commits: pr.commits || 0,
        },
        checkRuns,
        reviews,
        reviewComments,
        issueComments,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // 4b. Push a clean non-main feature branch and open (or reuse) a GitHub Pull Request
  app.post('/api/repo/push-pr', async (req, res) => {
    try {
      if (!isRepoCloned()) {
        res.status(400).json({ ok: false, error: '尚未挂载目标仓库。' });
        return;
      }
      const token = getGithubToken();
      if (!token) {
        res.status(400).json({ ok: false, error: '未配置 GITHUB_TOKEN，无法推送远端分支。' });
        return;
      }
      const cfg = loadConfig();
      const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      if (
        !branch ||
        branch === 'HEAD' ||
        branch === 'main' ||
        branch === 'master' ||
        branch === cfg.defaultBase ||
        !SAFE_REF_RE.test(branch)
      ) {
        res.status(400).json({ ok: false, error: `拒绝推送受保护分支或非法分支：${branch}` });
        return;
      }
      const dirty = runGit(['status', '--short']).trim();
      if (dirty) {
        res.status(400).json({ ok: false, error: '当前工作区存在未提交改动，请先提交后再推送。' });
        return;
      }
      const headSha = runGit(['rev-parse', 'HEAD']).trim();
      runGit(['push', '-u', 'origin', branch], { auth: true });

      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'manuscript-workbench',
      };
      const owner = cfg.repoSlug.split('/')[0];
      const existingResp = await fetch(
        `https://api.github.com/repos/${cfg.repoSlug}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
        { headers }
      );
      const requestedTitle = String(req.body?.title || '').trim();
      const requestedBody = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
      if (existingResp.ok) {
        const existing = (await existingResp.json()) as Array<{ number: number; html_url: string }>;
        if (existing.length > 0) {
          let updated = false;
          if (requestedTitle || requestedBody) {
            const patchPayload: Record<string, string> = {};
            if (requestedTitle) patchPayload.title = requestedTitle;
            if (requestedBody) patchPayload.body = requestedBody;
            const patchResp = await fetch(
              `https://api.github.com/repos/${cfg.repoSlug}/pulls/${existing[0].number}`,
              {
                method: 'PATCH',
                headers,
                body: JSON.stringify(patchPayload),
              }
            );
            updated = patchResp.ok;
          }
          res.json({
            ok: true,
            branch,
            headSha,
            prNumber: existing[0].number,
            prUrl: existing[0].html_url,
            created: false,
            updated,
          });
          return;
        }
      }

      const title = requestedTitle || `chore: ${branch}`;
      const body = requestedBody;
      const draft = Boolean(req.body?.draft);
      const createResp = await fetch(`https://api.github.com/repos/${cfg.repoSlug}/pulls`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title,
          body,
          head: branch,
          base: cfg.defaultBase,
          draft,
        }),
      });
      if (!createResp.ok) {
        const errText = await createResp.text();
        res.status(createResp.status).json({ ok: false, error: `GitHub PR 创建失败: ${errText.slice(0, 300)}` });
        return;
      }
      const createdPr = (await createResp.json()) as { number: number; html_url: string };
      res.json({
        ok: true,
        branch,
        headSha,
        prNumber: createdPr.number,
        prUrl: createdPr.html_url,
        created: true,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/repo/pr/:number/merge', async (req, res) => {
    try {
      const prNum = Number(req.params.number);
      if (!Number.isInteger(prNum) || prNum <= 0) {
        res.status(400).json({ ok: false, error: '无效的 PR 编号。' });
        return;
      }
      const expectedSha = String(req.body?.sha || '').trim();
      if (!/^[0-9a-f]{40}$/i.test(expectedSha)) {
        res.status(400).json({ ok: false, error: '必须提供 40 位精确 head SHA 才能合并 PR。' });
        return;
      }
      const mergeMethod = String(req.body?.mergeMethod || 'merge').trim();
      if (!['merge', 'squash', 'rebase'].includes(mergeMethod)) {
        res.status(400).json({ ok: false, error: '无效的 mergeMethod。' });
        return;
      }
      const token = getGithubToken();
      if (!token) {
        res.status(400).json({ ok: false, error: '未配置 GITHUB_TOKEN，无法合并 PR。' });
        return;
      }
      const cfg = loadConfig();
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'manuscript-workbench',
      };

      // Verify exact head SHA and open state before merging
      const prResp = await fetch(`https://api.github.com/repos/${cfg.repoSlug}/pulls/${prNum}`, { headers });
      if (!prResp.ok) {
        const errText = await prResp.text();
        res.status(prResp.status).json({ ok: false, error: `读取 PR 失败: ${errText.slice(0, 300)}` });
        return;
      }
      const prData = (await prResp.json()) as {
        state: string;
        mergeable: boolean | null;
        head: { sha: string; ref: string };
        base: { ref: string };
      };
      if (prData.state !== 'open') {
        res.status(409).json({ ok: false, error: `PR #${prNum} 当前状态为 ${prData.state}，无法合并。` });
        return;
      }
      if (prData.head.sha !== expectedSha) {
        res.status(409).json({
          ok: false,
          error: `PR #${prNum} head SHA 已变化（期望 ${expectedSha}，实际 ${prData.head.sha}），拒绝合并。`,
        });
        return;
      }

      // Verify all check runs on exact head SHA succeeded
      const checksResp = await fetch(
        `https://api.github.com/repos/${cfg.repoSlug}/commits/${expectedSha}/check-runs`,
        { headers }
      );
      if (!checksResp.ok) {
        res.status(502).json({ ok: false, error: '无法验证 CI 检查状态，拒绝合并。' });
        return;
      }
      const checksJson = (await checksResp.json()) as {
        check_runs?: Array<{ name: string; status: string; conclusion: string | null }>;
      };
      const runs = checksJson.check_runs || [];
      if (runs.length === 0) {
        res.status(409).json({ ok: false, error: '精确 HEAD 上尚未找到 CI 检查记录，拒绝合并。' });
        return;
      }
      const badRun = runs.find((r) => r.status !== 'completed' || r.conclusion !== 'success');
      if (badRun) {
        res.status(409).json({
          ok: false,
          error: `CI 检查未全部通过（${badRun.name}: status=${badRun.status}, conclusion=${badRun.conclusion}），拒绝合并。`,
        });
        return;
      }

      // Execute GitHub PR merge with sha lock
      const mergeResp = await fetch(`https://api.github.com/repos/${cfg.repoSlug}/pulls/${prNum}/merge`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          sha: expectedSha,
          merge_method: mergeMethod,
        }),
      });
      const mergeBody = (await mergeResp.json()) as { merged?: boolean; sha?: string; message?: string };
      if (!mergeResp.ok || !mergeBody.merged) {
        res.status(mergeResp.status).json({
          ok: false,
          error: `GitHub 合并失败: ${mergeBody.message || JSON.stringify(mergeBody).slice(0, 300)}`,
        });
        return;
      }

      res.json({
        ok: true,
        merged: true,
        prNumber: prNum,
        mergeSha: mergeBody.sha,
        headRef: prData.head.ref,
        baseRef: prData.base.ref,
        message: mergeBody.message,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // 5. Dynamic Git Diff Token Engine (base...target or WORKING_TREE)
  app.get('/api/diff', (req, res) => {
    try {
      if (!isRepoCloned()) {
        res.json({
          ok: true,
          cloned: false,
          baseRef: DEFAULT_BASE_BRANCH,
          targetRef: 'WORKING_TREE',
          compareLabel: '',
          sections: [],
        });
        return;
      }

      const cfg = loadConfig();
      const requestedBase = String(req.query.base || cfg.defaultBase || DEFAULT_BASE_BRANCH).trim();
      const requestedTarget = String(req.query.target || 'WORKING_TREE').trim();

      if (!SAFE_REF_RE.test(requestedBase) || !SAFE_REF_RE.test(requestedTarget)) {
        res.status(400).json({ ok: false, error: '无效的 Git 分支或引用名称。' });
        return;
      }

      // Resolve base ref (prefer local branch, fallback to origin/<base>)
      let resolvedBase = requestedBase;
      try {
        runGit(['rev-parse', '--verify', resolvedBase]);
      } catch {
        try {
          runGit(['rev-parse', '--verify', `origin/${requestedBase}`]);
          resolvedBase = `origin/${requestedBase}`;
        } catch {
          resolvedBase = 'HEAD';
        }
      }

      // Resolve target ref (support WORKING_TREE, HEAD, branches, or pr/<num>)
      let resolvedTarget = requestedTarget;
      const prMatch = requestedTarget.match(/^pr\/(\d+)$/);
      if (prMatch) {
        const prNum = prMatch[1];
        try {
          runGit(['fetch', 'origin', `pull/${prNum}/head:refs/remotes/origin/pr/${prNum}`], {
            auth: true,
          });
          resolvedTarget = `origin/pr/${prNum}`;
        } catch (err) {
          res.status(400).json({ ok: false, error: `拉取 PR #${prNum} 失败：${String(err)}` });
          return;
        }
      } else if (requestedTarget !== 'WORKING_TREE') {
        try {
          runGit(['rev-parse', '--verify', resolvedTarget]);
        } catch {
          try {
            runGit(['rev-parse', '--verify', `origin/${requestedTarget}`]);
            resolvedTarget = `origin/${requestedTarget}`;
          } catch {
            res.status(400).json({ ok: false, error: `未找到目标分支或引用：${requestedTarget}` });
            return;
          }
        }
      }

      // Compute unified=0 diff so each hunk corresponds to exact changed blocks
      let diffOutput = '';
      if (resolvedTarget === 'WORKING_TREE') {
        diffOutput = runGit(['diff', '--unified=0', '--no-color', resolvedBase]);
      } else {
        diffOutput = runGit(['diff', '--unified=0', '--no-color', `${resolvedBase}...${resolvedTarget}`]);
      }

      const rawFiles = parseUnifiedDiff(diffOutput).filter((f) => !f.isBinary && f.hunks.length > 0);
      const rawMap = new Map<string, FileDiffRaw>();
      for (const f of rawFiles) rawMap.set(f.filePath, f);

      // Build bilingual pairing lookup from repository discovery
      const pairs = discoverBilingualPairs();
      const cnToPair = new Map<string, BilingualPairInfo>();
      const enToPair = new Map<string, BilingualPairInfo>();
      for (const p of pairs) {
        cnToPair.set(p.canonical, p);
        if (p.translation) enToPair.set(p.translation, p);
      }

      const consumedFiles = new Set<string>();
      const sections: Array<{
        id: string;
        kind: 'bilingual' | 'single';
        shortTitle: string;
        chapter: string;
        location: string;
        fileCn?: string;
        fileEn?: string;
        issue: string;
        stats: { additions: number; deletions: number; hunks: number };
        paragraphs: Array<{
          id: string;
          label: string;
          fileCn?: string;
          fileEn?: string;
          cnLines: string;
          enLines: string;
          cnBefore: string;
          cnAfter: string;
          enBefore: string;
          enAfter: string;
          hasCn: boolean;
          hasEn: boolean;
          rationale?: string;
        }>;
      }> = [];

      const buildSectionId = (key: string) =>
        'sec-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);

      for (const raw of rawFiles) {
        if (consumedFiles.has(raw.filePath)) continue;

        const pairInfo = cnToPair.get(raw.filePath) || enToPair.get(raw.filePath);
        if (pairInfo && pairInfo.translation) {
          const cnPath = pairInfo.canonical;
          const enPath = pairInfo.translation;
          const cnRaw = rawMap.get(cnPath);
          const enRaw = rawMap.get(enPath);
          consumedFiles.add(cnPath);
          consumedFiles.add(enPath);

          const cnBaseLines = readFileLinesAtRef(resolvedBase, cnPath);
          const cnTargetLines = readFileLinesAtRef(resolvedTarget, cnPath);
          const enBaseLines = readFileLinesAtRef(resolvedBase, enPath);
          const enTargetLines = readFileLinesAtRef(resolvedTarget, enPath);

          const primaryHunks = (cnRaw?.hunks || []).length >= (enRaw?.hunks || []).length
            ? cnRaw?.hunks || []
            : enRaw?.hunks || [];
          const cnHunks = cnRaw?.hunks || [];
          const enHunks = enRaw?.hunks || [];

          const paragraphs = primaryHunks.map((_, idx) => {
            const cH = cnHunks[idx];
            const eH = enHunks[idx];
            const refStart = cH?.newStart ?? eH?.newStart ?? 1;
            const refCount = cH?.newCount ?? eH?.newCount ?? 1;

            const cnBefore = cH
              ? cH.beforeLines.join('\n')
              : sliceLineRange(cnBaseLines, refStart, refCount);
            const cnAfter = cH
              ? cH.afterLines.join('\n')
              : sliceLineRange(cnTargetLines, refStart, refCount);
            const enBefore = eH
              ? eH.beforeLines.join('\n')
              : sliceLineRange(enBaseLines, refStart, refCount);
            const enAfter = eH
              ? eH.afterLines.join('\n')
              : sliceLineRange(enTargetLines, refStart, refCount);

            const cnLinesLabel = cH
              ? formatLineRange(cH.newStart, cH.newCount)
              : formatLineRange(refStart, refCount);
            const enLinesLabel = eH
              ? formatLineRange(eH.newStart, eH.newCount)
              : formatLineRange(refStart, refCount);

            return {
              id: `${buildSectionId(`${cnPath}::${enPath}`)}-h${idx + 1}`,
              label: `变更区块 #${idx + 1} · ${cnLinesLabel}`,
              fileCn: cnPath,
              fileEn: enPath,
              cnLines: cnLinesLabel,
              enLines: enLinesLabel,
              cnBefore,
              cnAfter,
              enBefore,
              enAfter,
              hasCn: true,
              hasEn: true,
            };
          });

          const additions = (cnRaw?.additions || 0) + (enRaw?.additions || 0);
          const deletions = (cnRaw?.deletions || 0) + (enRaw?.deletions || 0);
          sections.push({
            id: buildSectionId(`${cnPath}::${enPath}`),
            kind: 'bilingual',
            shortTitle: pairInfo.title || path.basename(cnPath),
            chapter: `${pairInfo.groupLabel} · ${pairInfo.orderLabel}`,
            location: `${cnPath} ↔ ${enPath}`,
            fileCn: cnPath,
            fileEn: enPath,
            issue: `双语配对变更 · +${additions} / -${deletions} 行 · ${paragraphs.length} 处变更区块`,
            stats: { additions, deletions, hunks: paragraphs.length },
            paragraphs,
          });
        } else {
          consumedFiles.add(raw.filePath);
          const secId = buildSectionId(raw.filePath);
          const isEnOnly =
            raw.filePath.startsWith('content/en/') ||
            raw.filePath.includes('/en/') ||
            /_en(?:_later)?\.[a-z]+$/i.test(raw.filePath);

          const paragraphs = raw.hunks.map((h, idx) => {
            const rangeLabel = formatLineRange(h.newStart, h.newCount);
            const beforeText = h.beforeLines.join('\n');
            const afterText = h.afterLines.join('\n');
            return {
              id: `${secId}-h${idx + 1}`,
              label: `变更区块 #${idx + 1} · ${rangeLabel}`,
              fileCn: isEnOnly ? undefined : raw.filePath,
              fileEn: isEnOnly ? raw.filePath : undefined,
              cnLines: isEnOnly ? '—' : rangeLabel,
              enLines: isEnOnly ? rangeLabel : '—',
              cnBefore: isEnOnly ? '' : beforeText,
              cnAfter: isEnOnly ? '' : afterText,
              enBefore: isEnOnly ? beforeText : '',
              enAfter: isEnOnly ? afterText : '',
              hasCn: !isEnOnly,
              hasEn: isEnOnly,
            };
          });

          sections.push({
            id: secId,
            kind: 'single',
            shortTitle: pairInfo?.title || path.basename(raw.filePath),
            chapter: pairInfo ? `${pairInfo.groupLabel} · ${pairInfo.orderLabel}` : path.dirname(raw.filePath) || '根目录',
            location: raw.filePath,
            fileCn: isEnOnly ? undefined : raw.filePath,
            fileEn: isEnOnly ? raw.filePath : undefined,
            issue: `单文件变更 (${raw.status}) · +${raw.additions} / -${raw.deletions} 行 · ${paragraphs.length} 处变更区块`,
            stats: {
              additions: raw.additions,
              deletions: raw.deletions,
              hunks: paragraphs.length,
            },
            paragraphs,
          });
        }
      }

      const compareLabel = `${requestedBase} ... ${
        requestedTarget === 'WORKING_TREE' ? '当前工作区' : requestedTarget
      }`;

      res.json({
        ok: true,
        cloned: true,
        baseRef: requestedBase,
        targetRef: requestedTarget,
        compareLabel,
        totalFilesChanged: rawFiles.length,
        sections,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // 6. Run auto-detected verification / guard scripts inside /tmp/target-repo
  app.post('/api/run-tests', (_req, res) => {
    try {
      if (!isRepoCloned()) {
        res.status(400).json({ ok: false, error: '尚未挂载目标仓库。' });
        return;
      }
      const scripts = detectRepoVerificationScripts();
      if (scripts.length === 0) {
        res.json({
          ok: true,
          allPassed: true,
          detectedCount: 0,
          checkedAt: new Date().toISOString(),
          results: [],
        });
        return;
      }

      const results = scripts.map((s) => {
        try {
          const out = execFileSync(s.runner, [path.join(TARGET_REPO_DIR, s.relPath)], {
            cwd: TARGET_REPO_DIR,
            encoding: 'utf-8',
            timeout: 30000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return {
            name: s.name,
            passed: true,
            summary: out.trim().split('\n').slice(-2).join(' ') || 'OK',
          };
        } catch (e: unknown) {
          const errObj = e as { stdout?: string; stderr?: string; message?: string };
          const combined = `${errObj.stdout || ''}\n${errObj.stderr || ''}`.trim();
          const passed = combined.includes('OK') && !combined.includes('FAILED');
          return {
            name: s.name,
            passed,
            summary: combined.split('\n').slice(-2).join(' ') || String(errObj.message || 'Error'),
          };
        }
      });

      res.json({
        ok: true,
        allPassed: results.every((r) => r.passed),
        detectedCount: scripts.length,
        checkedAt: new Date().toISOString(),
        results,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // 7. Dynamic Custom Dashboard Route (only active when target repo supplies research-dashboard.html)
  app.get('/api/repo/dashboard', (_req, res) => {
    const rel = detectCustomDashboard();
    if (!rel) {
      res.status(404).send('Target repository does not provide a custom dashboard HTML.');
      return;
    }
    const full = safeResolveRepoPath(rel);
    if (!full || !fs.existsSync(full)) {
      res.status(404).send('Dashboard file not found.');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(fs.readFileSync(full, 'utf-8'));
  });

  // 8. Workflow specification markdown
  app.get('/api/workflow-spec', (_req, res) => {
    try {
      const markdown = fs.existsSync(WORKFLOW_MD_FILE)
        ? fs.readFileSync(WORKFLOW_MD_FILE, 'utf-8')
        : '';
      res.json({ ok: true, markdown });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // 9. Dynamic Repo File List for Wide Inspector
  app.get('/api/workbench/files', (_req, res) => {
    try {
      if (!isRepoCloned()) {
        res.json({ ok: true, files: [] });
        return;
      }
      const tracked = runGit(['ls-files']).split('\n').filter(Boolean);
      const untracked = runGit(['ls-files', '--others', '--exclude-standard'])
        .split('\n')
        .filter(Boolean);
      const allPaths = Array.from(new Set([...tracked, ...untracked]));
      const files = allPaths
        .filter((f) => !/\.(png|jpg|jpeg|gif|webp|pdf|zip|woff2?|ttf|ico)$/i.test(f))
        .map((rel) => {
          let group = '其他文件 (Other)';
          if (/\.(qmd|tex|md)$/i.test(rel)) group = '文稿与文档 (.qmd / .tex / .md)';
          else if (/\.svg$/i.test(rel)) group = '矢量插图 (.svg)';
          else if (/\.bib$/i.test(rel)) group = '参考文献库 (.bib)';
          else if (/\.(ya?ml|json|toml|jsonc)$/i.test(rel)) group = '配置与清单 (.yml / .json)';
          else if (/\.(py|ts|tsx|js|mjs|sh)$/i.test(rel)) group = '脚本与代码 (Scripts)';
          return {
            group,
            path: rel,
            label: rel,
          };
        });
      res.json({ ok: true, files });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // 10. Read single file from /tmp/target-repo
  app.get('/api/workbench/file', (req, res) => {
    try {
      if (!isRepoCloned()) {
        res.status(400).json({ ok: false, error: '尚未挂载目标仓库。' });
        return;
      }
      const relPath = String(req.query.path || '').trim();
      const fullPath = safeResolveRepoPath(relPath);
      if (!fullPath || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        res.status(404).json({ ok: false, error: `未找到文件：${relPath}` });
        return;
      }
      const content = fs.readFileSync(fullPath, 'utf-8');
      res.json({
        ok: true,
        path: relPath,
        lines: content.split('\n').length,
        bytes: Buffer.byteLength(content, 'utf-8'),
        sha256: sha256Text(content),
        content,
        lint: lintGenericManuscript(content, relPath),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // 11. Save file directly to single workspace /tmp/target-repo
  app.post('/api/workbench/save-file', (req, res) => {
    try {
      if (!isRepoCloned()) {
        res.status(400).json({ ok: false, error: '尚未挂载目标仓库。' });
        return;
      }
      const relPath = String(req.body?.path || '').trim();
      const content = String(req.body?.content ?? '');
      const fullPath = safeResolveRepoPath(relPath);
      if (!fullPath) {
        res.status(400).json({ ok: false, error: '无效的文件路径。' });
        return;
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf-8');
      res.json({
        ok: true,
        path: relPath,
        savedAt: new Date().toISOString(),
        sha256: sha256Text(content),
        lines: content.split('\n').length,
        lint: lintGenericManuscript(content, relPath),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // 12. Dynamic SVG figure proxy from /tmp/target-repo/publication/figures
  app.get('/api/workbench/figure-svg', (req, res) => {
    const name = path.basename(String(req.query.name || ''));
    if (!name.endsWith('.svg') || !isRepoCloned()) {
      res.status(400).send('Invalid SVG request');
      return;
    }
    const fullPath = safeResolveRepoPath(`publication/figures/${name}`);
    if (fullPath && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(fs.readFileSync(fullPath, 'utf-8'));
    } else {
      res.status(404).send('SVG not found');
    }
  });

  // 13. Dynamic Full-Volume Reader Discovery
  app.get('/api/workbench/full-volume', (_req, res) => {
    try {
      if (!isRepoCloned()) {
        res.json({ ok: true, totalDocuments: 0, totalLines: 0, totalChars: 0, documents: [] });
        return;
      }

      const pairs = discoverBilingualPairs();
      const readLines = (relPath?: string) => {
        if (!relPath) return { lines: [], lineCount: 0, charCount: 0, sha256: '' };
        const full = safeResolveRepoPath(relPath);
        if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
          return { lines: [], lineCount: 0, charCount: 0, sha256: '' };
        }
        const raw = fs.readFileSync(full, 'utf-8');
        const normalized = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
        const lines = raw.length > 0 ? normalized.split('\n') : [];
        return {
          lines,
          lineCount: lines.length,
          charCount: raw.replace(/\s+/g, '').length,
          sha256: sha256Text(raw),
        };
      };

      const documents = pairs.map((item) => {
        const zh = readLines(item.canonical);
        const en = readLines(item.translation);
        return {
          id: item.id,
          group: item.group,
          groupLabel: item.groupLabel,
          orderLabel: item.orderLabel,
          title: item.title,
          enTitle: item.enTitle,
          path: item.canonical,
          enPath: item.translation || '',
          hasEn: Boolean(item.translation),
          lineCount: zh.lineCount,
          enLineCount: en.lineCount,
          charCount: zh.charCount,
          enCharCount: en.charCount,
          sha256: zh.sha256,
          enSha256: en.sha256,
          lines: zh.lines,
          enLines: en.lines,
          figures: [],
        };
      });

      const totalLines = documents.reduce((acc, d) => acc + d.lineCount, 0);
      const totalChars = documents.reduce((acc, d) => acc + d.charCount, 0);

      res.json({
        ok: true,
        totalDocuments: documents.length,
        totalLines,
        totalChars,
        documents,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // 14. Review annotations & custom edits state persistence (stored in persistent .workbench-data)
  app.post('/api/sync-edits', (req, res) => {
    try {
      const scopeKey = String(req.body?.scopeKey || 'default');
      let store: Record<string, unknown> = {};
      if (fs.existsSync(STATE_FILE)) {
        try {
          store = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        } catch {
          store = {};
        }
      }
      const updatedAt = new Date().toISOString();
      store[scopeKey] = {
        updatedAt,
        ...req.body,
      };
      atomicWriteFileSync(STATE_FILE, JSON.stringify(store, null, 2));
      res.json({ ok: true, updatedAt });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get('/api/sync-edits', (req, res) => {
    try {
      const scopeKey = String(req.query.scopeKey || 'default');
      if (fs.existsSync(STATE_FILE)) {
        const store = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        res.json({ ok: true, data: store[scopeKey] ?? null });
      } else {
        res.json({ ok: true, data: null });
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    process.env.DISABLE_HMR = 'true';
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: 'spa',
      plugins: [
        {
          name: 'suppress-hmr-ws-unhandled-rejection',
          transform(code, id) {
            if (id.includes('client.mjs')) {
              return {
                code: code.replace(
                  'transport.connect(createHMRHandler(handleMessage));',
                  '/* HMR WebSocket disabled */'
                ),
                map: null,
              };
            }
          },
        },
      ],
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Manuscript Workbench server listening on http://localhost:${PORT}`);
    autoMountFromEnvIfNeeded();
  });
}

startServer();
