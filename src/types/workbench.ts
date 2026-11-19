export interface ParagraphPair {
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
}

export interface DiffSection {
  id: string;
  kind: 'bilingual' | 'single';
  shortTitle: string;
  chapter: string;
  location: string;
  fileCn?: string;
  fileEn?: string;
  issue: string;
  stats: {
    additions: number;
    deletions: number;
    hunks: number;
  };
  paragraphs: ParagraphPair[];
}

export interface VolumeFigure {
  afterLine: number;
  svgName: string;
  label: string;
  caption: string;
}

export interface FullVolumeDocument {
  id: string;
  group: string;
  groupLabel: string;
  orderLabel: string;
  title: string;
  enTitle: string;
  path: string;
  enPath: string;
  hasEn: boolean;
  lineCount: number;
  enLineCount: number;
  charCount: number;
  enCharCount: number;
  sha256: string;
  enSha256: string;
  lines: string[];
  enLines: string[];
  figures: VolumeFigure[];
}

export interface DetectedScript {
  id: string;
  name: string;
  relPath: string;
  runner: 'python3' | 'node';
}

export interface PullRequestSummary {
  number: number;
  title: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  draft: boolean;
  updatedAt: string;
}

export interface RepoStatus {
  configured: boolean;
  cloned: boolean;
  repoSlug: string;
  repoDir: string;
  defaultBase: string;
  branch: string;
  localShort: string;
  remoteShort: string;
  aheadOfRemote: number;
  inSyncWithRemote: boolean;
  hasLocalDraftEdits: boolean;
  dirtyCount: number;
  dirtyFiles: string[];
  recentCommits: string[];
  branches: string[];
  hasCustomDashboard: boolean;
  dashboardPath: string | null;
  detectedScripts: DetectedScript[];
  hasToken: boolean;
}

export interface RepoFileItem {
  group: string;
  path: string;
  label: string;
}

export interface LintFinding {
  ruleId: string;
  severity: 'ERROR' | 'WARN' | string;
  line: number;
  matched: string;
  title: string;
  replacement: string;
  rationale: string;
  context: string;
}

export interface LintReport {
  path: string;
  totalFindings: number;
  errorCount: number;
  warnCount: number;
  passed: boolean;
  findings: LintFinding[];
}
