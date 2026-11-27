import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTokenDiff, tokenizeForDiff } from './textDiff';

function reconstructOld(ops: ReturnType<typeof computeTokenDiff>): string {
  return ops
    .filter((o) => o.type !== 'insert')
    .map((o) => o.text)
    .join('');
}

function reconstructNew(ops: ReturnType<typeof computeTokenDiff>): string {
  return ops
    .filter((o) => o.type !== 'delete')
    .map((o) => o.text)
    .join('');
}

test('identical strings emit a single equal op with zero highlights', () => {
  const s = '给定边界条件 $[x_1,\\alpha,\\beta]\\to\\mathcal Y_1$ 在当前模型下成立。';
  const ops = computeTokenDiff(s, s);
  assert.deepEqual(ops, [{ type: 'equal', text: s }]);
});

test('localized LaTeX and wording edits only mark changed tokens', () => {
  const before =
    '在参数条件 $(\\alpha,\\beta)$ 一定的情况下，输入项 $\\mathcal X$ 的局部变化与输出项 $\\mathcal Y$ 对应。';
  const after =
    '在参数条件 $(\\alpha,\\beta)$ 一定的情况下，输入变量 $X$ 的离散局部变化与输出项 $\\mathcal Y$ 对应。';
  const ops = computeTokenDiff(before, after);

  assert.equal(reconstructOld(ops), before);
  assert.equal(reconstructNew(ops), after);

  const equalChars = ops
    .filter((o) => o.type === 'equal')
    .reduce((sum, o) => sum + o.text.length, 0);
  assert.ok(equalChars / before.length > 0.7, `expected mostly equal text, got ${equalChars}/${before.length}`);
  assert.ok(ops.some((o) => o.type === 'delete' && o.text.includes('\\mathcal X')));
  assert.ok(ops.some((o) => o.type === 'insert' && o.text.includes('$X$')));
});

test('long academic paragraph (>1000 tokens, n*m > 1,000,000) never falls back to whole-paragraph diff', () => {
  const unchangedSentence =
    '在通用的学术文本与形式化符号对照系统中，稳定的边界参数共同约束目标输出的统计分布，这一结构特征独立于具体实验设备的采样误差。';
  const before =
    unchangedSentence.repeat(10) +
    '此前示例以单一阈值作为判别稳定基线的独立经验标准。' +
    unchangedSentence.repeat(10);
  const after =
    unchangedSentence.repeat(10) +
    '现在示例将其明确为简化前提，并结合多组对照样本与既有实验记录校验基线。' +
    unchangedSentence.repeat(10);

  assert.ok(tokenizeForDiff(before).length > 1000);
  assert.ok(tokenizeForDiff(before).length * tokenizeForDiff(after).length > 1_000_000);

  const t0 = Date.now();
  const ops = computeTokenDiff(before, after);
  const elapsedMs = Date.now() - t0;

  assert.equal(reconstructOld(ops), before);
  assert.equal(reconstructNew(ops), after);
  assert.ok(elapsedMs < 200, `diff took too long: ${elapsedMs}ms`);

  const equalChars = ops
    .filter((o) => o.type === 'equal')
    .reduce((sum, o) => sum + o.text.length, 0);
  assert.ok(equalChars >= unchangedSentence.length * 20, 'all unchanged prefix/suffix sentences must remain equal');
});

test('multi-paragraph hunk preserves unchanged paragraphs as equal when a middle paragraph is edited or added', () => {
  const p1 = '第一段完全保持不变，用于验证多段比对时不会整块误高亮。';
  const p2Old = '第二段将旧符号 $[\\mathcal X_1,\\alpha,\\beta]$ 改写为新符号。';
  const p2New = '第二段将旧符号 $[x_1,\\alpha,\\beta]$ 改写为新符号。';
  const p3 = '第三段同样完全保持不变，验证换行后的锚定精度。';

  const before = `${p1}\n\n${p2Old}\n\n${p3}`;
  const after = `${p1}\n\n${p2New}\n\n${p3}`;
  const ops = computeTokenDiff(before, after);

  assert.equal(reconstructOld(ops), before);
  assert.equal(reconstructNew(ops), after);

  const deletedText = ops
    .filter((o) => o.type === 'delete')
    .map((o) => o.text)
    .join('');
  const insertedText = ops
    .filter((o) => o.type === 'insert')
    .map((o) => o.text)
    .join('');

  assert.ok(!deletedText.includes('第一段'));
  assert.ok(!deletedText.includes('第三段'));
  assert.ok(!insertedText.includes('第一段'));
  assert.ok(!insertedText.includes('第三段'));
  assert.ok(deletedText.includes('\\mathcal X_1'));
  assert.ok(insertedText.includes('x_1'));
});
