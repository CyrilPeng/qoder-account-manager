import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEXT = /\.(md|html|mjs|js|json|svg|ps1|txt|ya?ml)$|^LICENSE$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function patterns() {
  const user = (() => { try { return os.userInfo().username; } catch { return ''; } })();
  const home = (() => { try { return os.homedir(); } catch { return ''; } })();
  return [
    user && user.length >= 3 ? ['本机用户名', new RegExp(`\\b${escapeRe(user)}\\b`, 'i')] : null,
    home ? ['本机 home 路径', new RegExp(home.split(/[\\/]/).map(escapeRe).join('[\\\\/]'), 'i')] : null,
    ['Windows 用户目录', /C:[\\/]Users[\\/](?!<|%|\{|\.\.\.|your|USER)[A-Za-z0-9._-]{2,}/i],
    ['完整邮箱', /\b[A-Za-z0-9._%+-]+@(?:qq|gmail|outlook|hotmail|163|126|yeah|foxmail)\.(?:com|cn|net)\b/i],
    ['手机号', /(^|[^\d])1[3-9]\d{9}([^\d]|$)/],
    ['token 明文', /\b(?:dt|drt|jrt)-[A-Za-z0-9_-]{16,}\b/],
  ].filter(Boolean);
}

test('仓库文本文件里没有本机个人信息或令牌明文', () => {
  const files = walk(ROOT).filter((f) => TEXT.test(path.relative(ROOT, f)));
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [name, re] of patterns()) {
      const m = text.match(re);
      if (m) hits.push(`${path.relative(ROOT, file)}: ${name} → ${JSON.stringify(m[0]).slice(0, 60)}`);
    }
  }
  assert.deepEqual(hits, [], `发现疑似个人信息，别提交:\n${hits.join('\n')}`);
  assert.ok(files.length > 15, '扫描文件数异常，递归可能出错');
});
