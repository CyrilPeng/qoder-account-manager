import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOC_FILES = ['README.md', ...fs.readdirSync(path.join(ROOT, 'docs'))
  .filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];

function slugOf(heading) {
  return heading.trim().toLowerCase()
    .replace(/[（）()·,，。:：!！?？/\\'"“”`]/g, '')
    .replace(/\s+/g, '-');
}

test('README 保持在一屏可读的长度内', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').split(/\r?\n/).length;
  assert.ok(lines <= 200, `README 已有 ${lines} 行，超过 200 行的预算（细节移到 docs/）`);
});

test('文档内链都能落到文件与标题', () => {
  const problems = [];
  let checked = 0;
  for (const f of DOC_FILES) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
      const href = m[1].trim();
      if (/^(https?:|mailto:|#)/.test(href)) continue;
      checked++;
      const [rel, anchor] = href.split('#');
      const target = path.resolve(path.dirname(path.join(ROOT, f)), rel);
      if (!fs.existsSync(target)) {
        problems.push(`${f} → ${href}（文件不存在）`);
        continue;
      }
      if (!anchor) continue;
      const body = fs.readFileSync(target, 'utf8');
      const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((h) => slugOf(h[1]));
      if (!headings.includes(anchor.toLowerCase())) problems.push(`${f} → ${href}（标题锚点不存在）`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(checked >= 10, `只检查到 ${checked} 个内链，样例可能被改坏了`);
});

test('README 覆盖 docs 全部入口', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const f of DOC_FILES.filter((x) => x.startsWith('docs/'))) {
    assert.ok(readme.includes(`](${f})`) || readme.includes(`](${f}#`), `README 未链接 ${f}`);
  }
});
