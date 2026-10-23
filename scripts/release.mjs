// release.mjs — 发版检查与打包
//
// 用法:
//   node scripts/release.mjs              检查 + 构建 zip（本地，不联网）
//   node scripts/release.mjs --dry-run    只跑检查，不写 zip
//   node scripts/release.mjs --publish    额外打 tag、推送、创建 GitHub Release 并核对 digest
//
// 检查项就是过去手工容易漏的那几件事：清单/CHANGELOG/tag 三处版本一致、离线校验器、
// 单元测试、发布包里没有账号数据、整棵树里没有本机用户名/邮箱/手机/令牌明文。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SCRIPT_DIR);
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const PUBLISH = args.includes('--publish');
const SKIP_VALIDATOR = args.includes('--skip-validator');

const say = (msg = '') => console.log(msg);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);

class Fail extends Error {}
const need = (cond, msg) => { if (!cond) throw new Fail(msg); };

function run(cmd, argv, opts = {}) {
  const { allowFail, ...spawnOpts } = opts;
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', windowsHide: true, ...spawnOpts });
  if (r.error && !allowFail) throw new Fail(`无法执行 ${cmd}: ${r.error.message}`);
  return r;
}

function firstWorking(cands, argv) {
  for (const c of cands) {
    const r = spawnSync(c, argv, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

function git(argv, opts = {}) {
  const r = run('git', argv, opts);
  if (!opts.allowFail && r.status !== 0) throw new Fail(`git ${argv.join(' ')} 失败: ${(r.stderr || r.stdout).trim()}`);
  return String(r.stdout || '').trim();
}

function gh(argv) {
  const r = run('gh', argv);
  if (r.status !== 0) throw new Fail(`gh ${argv.join(' ')} 失败: ${(r.stderr || r.stdout).trim()}`);
  return String(r.stdout || '').trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## v${version}`);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n').trim();
}

function findValidator() {
  const home = os.homedir();
  const cands = [
    process.env.QAM_VALIDATOR,
    path.join(home, '.qoder-cn', 'plugins', 'cache', 'qoder-bundler', 'qoder-create-plugin',
      'skills', 'create-plugin', 'scripts', 'validate_qoder_plugin.py'),
    path.join(home, '.qoder-cn', 'plugins', 'qoder-bundler',
      'skills', 'create-plugin', 'scripts', 'validate_qoder_plugin.py'),
  ];
  return cands.find((p) => p && fs.existsSync(p)) || null;
}

function piiPatterns() {
  const user = (() => { try { return os.userInfo().username; } catch { return ''; } })();
  const home = (() => { try { return os.homedir(); } catch { return ''; } })();
  const homeRe = home
    ? new RegExp(home.split(/[\\/]/).map(escapeRe).join('[\\\\/]'), 'i')
    : null;
  return [
    user && user.length >= 3 ? { name: '本机用户名', re: new RegExp(`\\b${escapeRe(user)}\\b`, 'i') } : null,
    homeRe ? { name: '本机 home 路径', re: homeRe } : null,
    { name: 'Windows 用户目录', re: /C:[\\/]Users[\\/](?!<|%|\{|\.\.\.|your|USER)[A-Za-z0-9._-]{2,}/i },
    { name: '完整邮箱', re: /\b[A-Za-z0-9._%+-]+@(?:qq|gmail|outlook|hotmail|163|126|yeah|foxmail)\.(?:com|cn|net)\b/i },
    { name: '手机号', re: /(^|[^\d])1[3-9]\d{9}([^\d]|$)/ },
    { name: 'token 明文', re: /\b(?:dt|drt|jrt)-[A-Za-z0-9_-]{16,}\b/ },
  ].filter(Boolean);
}

const TEXT_FILE = /\.(md|html|mjs|js|json|svg|ps1|txt|ya?ml|gitignore)$|^LICENSE$/i;

function main() {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.qoder-plugin', 'plugin.json'), 'utf8'));
  const version = String(plugin.version || '');
  const tag = `v${version}`;
  say(`发版检查 · ${tag}${DRY ? ' · dry-run' : ''}${PUBLISH ? ' · publish' : ''}`);
  say();

  // 1) 版本三处一致
  say('[1/6] 版本与 CHANGELOG');
  need(/^\d+\.\d+\.\d+$/.test(version), `清单 version 非法: ${JSON.stringify(version)}`);
  ok(`清单 version = ${version}`);

  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const section = changelogSection(changelog, version);
  need(section, `CHANGELOG.md 缺少「## v${version}」段（先把「未发布」改写成版本段）`);
  ok(`CHANGELOG 含 v${version} 段（${section.split('\n').length} 行）`);

  const headPlugin = JSON.parse(git(['show', 'HEAD:.qoder-plugin/plugin.json']));
  need(headPlugin.version === version, `HEAD 里的清单版本是 ${headPlugin.version}，与工作区 ${version} 不一致（先提交）`);
  ok('HEAD 提交里的清单版本一致');

  const dirty = git(['status', '--porcelain'], { allowFail: true });
  if (dirty) {
    const lines = dirty.split('\n').filter(Boolean);
    PUBLISH ? need(false, `工作区有未提交改动，不能发版：\n    ${lines.join('\n    ')}`) : warn(`工作区有 ${lines.length} 处未提交改动（发版前必须提交）`);
  } else {
    ok('工作区干净');
  }

  const tagCommit = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], { allowFail: true });
  const head = git(['rev-parse', 'HEAD']);
  if (tagCommit) {
    if (tagCommit !== head) {
      const msg = `tag ${tag} 指向 ${tagCommit.slice(0, 7)}，HEAD 是 ${head.slice(0, 7)}（改了代码没升版本或没重打 tag）`;
      PUBLISH ? need(false, msg) : warn(msg);
    } else {
      ok(`tag ${tag} 已存在并指向 HEAD`);
    }
  } else {
    ok(`tag ${tag} 尚不存在${PUBLISH ? '，发布时创建' : ''}`);
  }

  // 2) 离线校验器
  say();
  say('[2/6] 插件清单校验');
  if (SKIP_VALIDATOR) {
    warn('已按 --skip-validator 跳过');
  } else {
    const validator = findValidator();
    if (!validator) {
      const msg = '未找到 validate_qoder_plugin.py（可用 QAM_VALIDATOR 指定）';
      PUBLISH ? need(false, msg) : warn(`${msg}，本地跳过`);
    } else {
      const pyExe = firstWorking(['python', 'python3', 'py'], ['--version']);
      need(pyExe, '未找到可用的 python 解释器');
      const r = run(pyExe, [validator, ROOT], { allowFail: true });
      need(r.status === 0, `校验器未通过:\n${(r.stdout || '') + (r.stderr || '')}`);
      ok('校验器：no issues found');
    }
  }

  // 3) 单元测试
  say();
  say('[3/6] 单元测试');
  const tests = run(process.execPath, ['--test', 'tests/*.test.mjs'], { allowFail: true, timeout: 180000 });
  need(tests.status === 0, `测试失败:\n${tests.stdout || tests.stderr}`);
  const summary = String(tests.stdout || '').split('\n').filter((l) => /^# (tests|pass|fail) /.test(l)).join(' · ');
  ok(summary || 'node --test 通过');

  // 4) 发布包内容
  say();
  say('[4/6] 发布包内容');
  const tree = git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  const forbidden = [
    /(^|\/)\.git(\/|$)/, /(^|\/)node_modules\//, /(^|\/)creds\//, /(^|\/)snapshots\//,
    /(^|\/)(accounts|server|config|credits|signin-log)\.json$/, /(^|\/)switch\.(log|lock)$/,
    /\.sqlite(-wal|-shm)?$/, /\.log$/, /\.tmp$/,
  ];
  const bad = tree.filter((f) => forbidden.some((re) => re.test(f)));
  need(bad.length === 0, `发布包里混入了不该有的文件:\n    ${bad.join('\n    ')}`);
  ok(`${tree.length} 个文件，无快照/凭据/日志/数据库`);

  // 5) 个人信息与令牌扫描
  say();
  say('[5/6] 个人信息扫描（扫描 HEAD 树）');
  const patterns = piiPatterns();
  const hits = [];
  for (const file of tree.filter((f) => TEXT_FILE.test(f))) {
    const text = git(['show', `HEAD:${file}`]);
    for (const p of patterns) {
      const m = text.match(p.re);
      if (m) hits.push(`${file}: ${p.name} → ${JSON.stringify(m[0]).slice(0, 80)}`);
    }
  }
  need(hits.length === 0, `发现疑似个人信息/令牌:\n    ${hits.join('\n    ')}`);
  ok(`扫描 ${tree.filter((f) => TEXT_FILE.test(f)).length} 个文本文件，无用户名/邮箱/手机/令牌明文`);

  // 6) 打包
  say();
  say('[6/6] 发布包');
  if (DRY) {
    warn('dry-run：跳过打包');
  } else {
    const zipPath = path.resolve(ROOT, '..', `qoder-account-manager-${tag}.zip`);
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
    git(['archive', '--format=zip', '--prefix=qoder-account-manager/', '-o', zipPath, 'HEAD']);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
    ok(`${path.basename(zipPath)}（${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB）`);
    ok(`sha256 ${sha}`);

    if (!PUBLISH) {
      say();
      say('本地检查与打包完成。确认无误后加 --publish 推送并创建 Release。');
      return;
    }

    say();
    say('发布');
    if (!tagCommit) {
      git(['tag', '-a', tag, '-m', tag]);
      ok(`已创建注解 tag ${tag}`);
    }
    const branch = (args.find((a) => a.startsWith('--branch=')) || '--branch=main').split('=')[1];
    git(['push', 'origin', branch, tag]);
    ok(`已推送 ${branch} 与 ${tag}`);

    const notes = `${section}\n\n`
      + `> 安装：下载下面的 \`qoder-account-manager-${tag}.zip\`，解压后在 Qoder 插件管理里选“从本地安装”，指向解压出的 \`qoder-account-manager/\` 目录。\n`
      + '> 本包不含 git 历史，也不含任何账号数据；账号快照与额度缓存只存在于本机 `~/.qoder-account-manager/`。\n';
    const notesFile = path.join(os.tmpdir(), `qam-notes-${tag}.md`);
    fs.writeFileSync(notesFile, notes);
    try {
      const titleArg = args.find((a) => a.startsWith('--title='));
      const title = titleArg ? titleArg.slice('--title='.length) : tag;
      const r = run('gh', ['release', 'create', tag, zipPath, '--title', title, '--notes-file', notesFile], { allowFail: true });
      need(r.status === 0, `gh release create 失败:\n${(r.stdout || '') + (r.stderr || '')}`);
      ok(`Release 已创建: ${String(r.stdout || '').trim()}`);
    } finally {
      fs.rmSync(notesFile, { force: true });
    }

    const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
    const digest = gh(['api', `repos/${repo}/releases/tags/${tag}`, '--jq',
      `.assets[] | select(.name=="${path.basename(zipPath)}") | .digest`]);
    need(digest === `sha256:${sha}`, `上传后的 digest 与本地不一致：本地 sha256:${sha}，远端 ${digest || '(空)'}`);
    ok('远端 asset digest 与本地 sha256 一致');
  }

  say();
  say(DRY ? 'dry-run 完成（未写任何文件）。' : '完成。');
}

try {
  main();
} catch (e) {
  console.error(`\n失败: ${e instanceof Fail ? e.message : e?.stack || e}`);
  process.exitCode = 1;
}
