export type DiffOp = {
  type: 'equal' | 'delete' | 'insert';
  text: string;
};

/**
 * Tokenize academic Chinese/English/LaTeX prose so math formulas, citations,
 * English words, whitespace, and individual CJK characters diff cleanly.
 */
export function tokenizeForDiff(text: string): string[] {
  if (!text) return [];
  const pattern =
    /\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\operatorname\{[^}]+\}(?:\([^)]*\))?|\\mathcal\s*\{?[A-Za-z]\}?|\\[A-Za-z]+|\[\@[A-Za-z0-9_:-]+[^\]]*\]|[A-Za-z0-9_]+(?:'[A-Za-z]+)?|\r?\n|[ \t]+|[\u4e00-\u9fff]|[^\sA-Za-z0-9_\u4e00-\u9fff]/g;
  return text.match(pattern) ?? [text];
}

function mergeOps(raw: DiffOp[]): DiffOp[] {
  const merged: DiffOp[] = [];
  for (const op of raw) {
    if (!op.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) {
      last.text += op.text;
    } else {
      merged.push({ type: op.type, text: op.text });
    }
  }
  return merged;
}

/**
 * Myers O((N + M) * D) shortest edit script over arbitrary string arrays.
 * Returns null only if edit distance exceeds maxD.
 */
function myersDiffTokens(a: string[], b: string[], maxD: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(maxD, n + m);
  const offset = limit;
  const v = new Int32Array(2 * limit + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const idx = k + offset;
      let x: number;
      if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
        x = v[idx + 1];
      } else {
        x = v[idx - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[idx] = x;
      if (x >= n && y >= m) {
        // Backtrack shortest edit path
        const ops: DiffOp[] = [];
        let bx = n;
        let by = m;
        for (let step = d; step > 0; step--) {
          const prevV = trace[step];
          const curK = bx - by;
          let prevK: number;
          if (
            curK === -step ||
            (curK !== step && prevV[curK - 1 + offset] < prevV[curK + 1 + offset])
          ) {
            prevK = curK + 1;
          } else {
            prevK = curK - 1;
          }
          const prevX = prevV[prevK + offset];
          const prevY = prevX - prevK;

          while (bx > prevX && by > prevY) {
            ops.push({ type: 'equal', text: a[bx - 1] });
            bx--;
            by--;
          }

          if (bx === prevX) {
            ops.push({ type: 'insert', text: b[by - 1] });
            by--;
          } else {
            ops.push({ type: 'delete', text: a[bx - 1] });
            bx--;
          }
        }
        while (bx > 0 && by > 0) {
          ops.push({ type: 'equal', text: a[bx - 1] });
          bx--;
          by--;
        }
        while (bx > 0) {
          ops.push({ type: 'delete', text: a[bx - 1] });
          bx--;
        }
        while (by > 0) {
          ops.push({ type: 'insert', text: b[by - 1] });
          by--;
        }
        ops.reverse();
        return mergeOps(ops);
      }
    }
  }
  return null;
}

/**
 * Standard LCS fallback for moderate segments when Myers exceeds maxD.
 */
function lcsDiffTokens(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
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
  return mergeOps(raw);
}

/**
 * Split text into clause/sentence chunks (keeping delimiters attached) for
 * coarse alignment of very long heavily-edited hunks before fine token diffing.
 */
function splitIntoClauses(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/[^。；！？\n.!?;]+[。；！？\n.!?;]*|[。；！？\n.!?;]+/g);
  return matches ?? [text];
}

function diffTokenArrays(a: string[], b: string[]): DiffOp[] {
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return [{ type: 'insert', text: b.join('') }];
  if (b.length === 0) return [{ type: 'delete', text: a.join('') }];

  // 1. Trim exact matching prefix and suffix in O(min(N, M))
  let prefix = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefix < minLen && a[prefix] === b[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const prefixText = prefix > 0 ? a.slice(0, prefix).join('') : '';
  const suffixText = suffix > 0 ? a.slice(a.length - suffix).join('') : '';
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  let midOps: DiffOp[];
  if (midA.length === 0 && midB.length === 0) {
    midOps = [];
  } else if (midA.length === 0) {
    midOps = [{ type: 'insert', text: midB.join('') }];
  } else if (midB.length === 0) {
    midOps = [{ type: 'delete', text: midA.join('') }];
  } else {
    // Try fast Myers shortest-edit-script first (handles long paragraphs with localized edits in < 2ms)
    const myers = myersDiffTokens(midA, midB, 1400);
    if (myers) {
      midOps = myers;
    } else if (midA.length * midB.length <= 2_500_000) {
      midOps = lcsDiffTokens(midA, midB);
    } else {
      // Fallback for extreme multi-kilobyte rewrites: align by clause first, then token-diff paired changed clauses
      const clausesA = splitIntoClauses(midA.join(''));
      const clausesB = splitIntoClauses(midB.join(''));
      const clauseOps =
        myersDiffTokens(clausesA, clausesB, 2000) ??
        (clausesA.length * clausesB.length <= 1_000_000
          ? lcsDiffTokens(clausesA, clausesB)
          : [
              { type: 'delete', text: midA.join('') },
              { type: 'insert', text: midB.join('') },
            ]);

      midOps = [];
      let idx = 0;
      while (idx < clauseOps.length) {
        const cur = clauseOps[idx];
        const next = clauseOps[idx + 1];
        if (cur.type === 'delete' && next && next.type === 'insert') {
          const subA = tokenizeForDiff(cur.text);
          const subB = tokenizeForDiff(next.text);
          const subMyers = myersDiffTokens(subA, subB, 800);
          if (subMyers) {
            midOps.push(...subMyers);
          } else {
            midOps.push(cur, next);
          }
          idx += 2;
        } else {
          midOps.push(cur);
          idx++;
        }
      }
    }
  }

  const combined: DiffOp[] = [];
  if (prefixText) combined.push({ type: 'equal', text: prefixText });
  combined.push(...midOps);
  if (suffixText) combined.push({ type: 'equal', text: suffixText });
  return mergeOps(combined);
}

/**
 * Compute precise token-level diff ops so unchanged sentences and phrases are
 * always emitted as `equal` (never highlighted), even on long multi-paragraph hunks.
 */
export function computeTokenDiff(oldStr: string, newStr: string): DiffOp[] {
  if (!oldStr && !newStr) return [];
  if (oldStr === newStr) return [{ type: 'equal', text: oldStr }];
  if (!oldStr) return [{ type: 'insert', text: newStr }];
  if (!newStr) return [{ type: 'delete', text: oldStr }];

  // When multi-line hunks are compared, align unchanged lines first so paragraphs stay anchored
  if (oldStr.includes('\n') || newStr.includes('\n')) {
    const oldLines = oldStr.split(/(\n)/);
    const newLines = newStr.split(/(\n)/);
    const lineOps = myersDiffTokens(oldLines, newLines, 1000) ?? lcsDiffTokens(oldLines, newLines);

    const refined: DiffOp[] = [];
    let i = 0;
    while (i < lineOps.length) {
      const cur = lineOps[i];
      const next = lineOps[i + 1];
      if (cur.type === 'delete' && next && next.type === 'insert') {
        refined.push(...diffTokenArrays(tokenizeForDiff(cur.text), tokenizeForDiff(next.text)));
        i += 2;
      } else {
        refined.push(cur);
        i++;
      }
    }
    return mergeOps(refined);
  }

  return diffTokenArrays(tokenizeForDiff(oldStr), tokenizeForDiff(newStr));
}
