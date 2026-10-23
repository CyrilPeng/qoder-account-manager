import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, 'assets', 'console.html'), 'utf8');

test('控制台内联脚本可解析', () => {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(blocks.length, 1, '预期只有一个内联脚本块');
  const tmp = path.join(os.tmpdir(), `qam-console-${process.pid}.js`);
  fs.writeFileSync(tmp, blocks[0]);
  try {
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('页面零外部依赖，离线可用', () => {
  assert.ok(!/<script[^>]+\bsrc\s*=/i.test(html), '不应有外链脚本');
  assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html), '不应有外链样式');
  assert.ok(!/@import\s+url\(\s*['"]?https?:/i.test(html), '不应 import 远程样式');
  assert.ok(!/<iframe\b/i.test(html));
});

test('token 不留在地址栏与浏览器历史', () => {
  assert.match(html, /history\.replaceState\(/);
  assert.match(html, /sessionStorage\.setItem\('qam_token'/);
  assert.match(html, /sessionStorage\.getItem\('qam_token'\)/);
  assert.match(html, /searchParams\.delete\('t'\)/);
});

test('到期条悬停与键盘聚焦都能出详情', () => {
  assert.match(html, /\.cred-seg:hover \.tip\b/);
  assert.match(html, /\.cred-seg:focus-visible \.tip\b/);
  assert.match(html, /tabindex="0"/);
});

test('用户可控文本经 esc() 转义', () => {
  assert.match(html, /(function esc\(|const esc\s*=)/);
  assert.match(html, /esc\(rec\.note\)/);
  assert.match(html, /esc\(a\.name\)/);
});
