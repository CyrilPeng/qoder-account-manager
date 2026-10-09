// server.mjs — 本地账号控制台 HTTP 服务
//
// 只监听 127.0.0.1。虽然是本机服务，但任意网页都能向 localhost 发请求（CSRF），
// 而本服务能重启 IDE、读取账号信息，因此：
//   · 启动时生成一次性 token，所有 /api 请求必须携带（?t= 或 x-qam-token 头）
//   · 校验 Host 头，挡 DNS rebinding
//   · 绝不返回任何 token 明文（status 只出脱敏字段）
//
// 必须以 detached 方式启动（见 console.mjs）：切换账号会杀掉 Qoder，若本服务是
// IDE 的子进程会跟着死，浏览器页面就失去后端、看不到切换进度。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  SCRIPT_DIR, PLUGIN_ROOT, MGR_DIR, ensureDirs, loadConfig, saveConfig,
  readSigninLog, loadRegistry, saveRegistry, findAccount, isValidSlotId, maskUid,
  snapshotWhitelist, detectLayout, getDataDir, rollbackSnapshot, readSwitchLock,
  writeSwitchLock, clearSwitchLock, qoderRunning, DEFAULT_EXIT_AFTER_NO_QODER_SEC,
} from './qoder_lib.mjs';
import { collectStatus, sessionVisibility } from './status.mjs';

const HTML_PATH = path.join(PLUGIN_ROOT, 'assets', 'console.html');
const SWITCH_LOG = path.join(MGR_DIR, 'switch.log');
const PORT_FILE = path.join(MGR_DIR, 'server.json');
const DEFAULT_PORT = Number(process.env.QAM_PORT || 38117);

const TOKEN = process.env.QAM_TOKEN || crypto.randomBytes(16).toString('hex');

// ── CLI 调用 ──────────────────────────────────────────────────────────────
/** 跑一个 CLI 脚本并解析 QAM_JSON: 行（不靠猜 stdout 排版） */
function runCli(script, args, { timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--no-warnings', path.join(SCRIPT_DIR, script), ...args],
      { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '');
        const line = out.split('\n').filter((l) => l.startsWith('QAM_JSON:')).pop();
        let json = null;
        if (line) { try { json = JSON.parse(line.slice('QAM_JSON:'.length)); } catch { /* 保留 null */ } }
        resolve({
          ok: !err && json?.ok !== false,
          exitCode: err?.code ?? 0,
          json,
          // 去掉 QAM_JSON 行后的可读输出，直接给 UI 当日志展示
          text: out.split('\n').filter((l) => !l.startsWith('QAM_JSON:') && !l.startsWith('EVENTS_JSON:')).join('\n').trim(),
          stderr: String(stderr || '').trim(),
          error: err ? String(err.message || err) : null,
        });
      });
  });
}

/**
 * 以 detached 方式跑切换脚本。
 * 切换会关闭并重启 Qoder，本服务若作为其子进程存活即可继续汇报进度；
 * 输出重定向到 switch.log，前端轮询 tail 展示。
 *
 * 先写一把 source:'server' 的占位锁，再由子进程接管 —— 目的是把「同一时刻只允许一个
 * 切换」这件事在启动前就定下来。本进程内再用 switchInFlight 挡住两次点击的毫秒级竞态
 * （锁文件的 pid 此时还不是切换进程自己的 pid）。
 */
let switchInFlight = null;   // {pid, target, startedAt}
function runSwitchDetached(args) {
  ensureDirs();
  if (switchInFlight && isAlive(switchInFlight.pid)) {
    throw new HttpError(409, `已有切换在进行中（目标 ${switchInFlight.target}，pid=${switchInFlight.pid}）`);
  }
  const out = fs.openSync(SWITCH_LOG, 'w');
  let child;
  try {
    child = spawn(process.execPath,
      ['--no-warnings', path.join(SCRIPT_DIR, 'switch.mjs'), ...args, '--json'],
      { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  } catch (e) {
    // 起不来就必须把占位锁撤掉：锁的 pid 是 null，只能靠 15 分钟超时判陈旧，
    // 留着它会让控制台白等一刻钟。
    fs.closeSync(out);
    clearSwitchLock();
    throw e;
  }
  fs.closeSync(out);
  child.unref();
  switchInFlight = { pid: child.pid, target: args[1] || '', startedAt: Date.now() };
  writeSwitchLock({ pid: null, target: args[1] || '', source: 'server', startedAt: Date.now() });
  child.on('exit', () => { switchInFlight = null; });
  return child.pid;
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** 槽位 id 会拼进删除/覆盖路径，服务入口处一律校验，别让 ../ 走到 CLI */
function requireSlotId(raw, field = 'id') {
  const id = String(raw ?? '').trim();
  if (!isValidSlotId(id)) {
    throw new HttpError(400, `${field} 非法（字母/数字/_/-，1~64 字符）`);
  }
  return id;
}

/** 切换进行中拒绝一切会动快照/数据目录的写操作 */
function assertNotSwitching(action) {
  const lock = readSwitchLock() || (switchInFlight && isAlive(switchInFlight.pid)
    ? { ...switchInFlight, ageMs: Date.now() - switchInFlight.startedAt, source: 'server' } : null);
  if (lock) {
    throw new HttpError(409, `切换进行中（目标 ${lock.target || '?'}），暂不执行${action}。`
      + '等本次切换结束再试。');
  }
}

// ── 空闲自动退出 ──────────────────────────────────────────────────────────
// Qoder 通常在半分钟内就会被切换流程重新拉起来；连续 3 分钟探测不到 IDE 进程，基本
// 就是用户真的退出了。此时留一个能重启 IDE 的 HTTP 服务在后台只是白占内存
// （实测约 50MB RSS），所以自己收掉。阈值可在 config.exitAfterNoQoderSec 调，0 = 常驻。
let idleSince = null;
let watchdogTimer = null;
let lastProbe = { running: null, checkedAt: 0 };

/** 切换是否正在进行（本进程起的子进程 / 别处写的锁）。切换中 IDE 必然是关着的，绝不能退出 */
function switchActive() {
  if (switchInFlight && isAlive(switchInFlight.pid)) return true;
  return Boolean(readSwitchLock());
}

function watchdogConfig() {
  const raw = Number(loadConfig().exitAfterNoQoderSec);
  const sec = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_EXIT_AFTER_NO_QODER_SEC;
  const limitMs = sec * 1000;
  // 轮询间隔取阈值的 1/6（夹在 1~15s）：把阈值调小到几秒时也测得出效果，默认 180s → 15s 一探
  const everyMs = limitMs > 0 ? Math.max(1000, Math.min(15000, Math.round(limitMs / 6))) : 15000;
  return { enabled: limitMs > 0, limitMs, everyMs, sec };
}

function watchdogState() {
  const cfg = watchdogConfig();
  if (!cfg.enabled) return { enabled: false, sec: 0, idleSec: null, remainingSec: null };
  const idleMs = idleSince ? Date.now() - idleSince : null;
  return {
    enabled: true, sec: cfg.sec,
    idleSec: idleMs === null ? null : Math.round(idleMs / 1000),
    remainingSec: idleMs === null ? null : Math.max(0, Math.round((cfg.limitMs - idleMs) / 1000)),
    qoderSeenRunning: lastProbe.running,
  };
}

function tickWatchdog() {
  let running;
  try { running = qoderRunning(); }
  catch { running = true; }   // tasklist 探测失败时按"还在跑"处理：宁可少杀不可误杀
  lastProbe = { running, checkedAt: Date.now() };
  if (running || switchActive()) { idleSince = null; return; }
  const now = Date.now();
  if (!idleSince) { idleSince = now; return; }
  const cfg = watchdogConfig();
  if (now - idleSince >= cfg.limitMs) {
    const waited = Math.round((now - idleSince) / 1000);
    console.log(`Qoder 已连续 ${waited}s 未运行，控制台服务自动退出（pid=${process.pid}）。`
      + '槽位与登录数据都在 ~/.qoder-account-manager/，下次打开 Qoder 重新运行 /account-console 即可。');
    try { fs.rmSync(PORT_FILE, { force: true }); } catch { /* ignore */ }
    clearInterval(watchdogTimer);
    process.exit(0);
  }
}

function armWatchdog() {
  clearInterval(watchdogTimer);
  const cfg = watchdogConfig();
  idleSince = null;
  if (!cfg.enabled) {
    console.log('自动退出已关闭（config.exitAfterNoQoderSec=0）：服务将常驻，需手动 --stop');
    return;
  }
  watchdogTimer = setInterval(tickWatchdog, cfg.everyMs);
  console.log(`自动退出已启用：Qoder 连续 ${cfg.sec}s 不在运行就结束本进程（每 ${Math.round(cfg.everyMs / 1000)}s 探测一次）`);
}

// ── HTTP 辅助 ─────────────────────────────────────────────────────────────
/** 带状态码的错误：客户端输入问题应回 4xx，不该被兜底成 500 */
class HttpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    // 页面由 token 保护，不需要 cookie；显式关掉减少误用面
    'Set-Cookie': '',
  });
  res.end(buf);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      // 拒绝非法 UTF-8：解码出替换符说明调用方发的不是 UTF-8（实测 Windows 下
      // curl 经 Git Bash 传参会被转成 GBK）。静默存下去会把备注名写成乱码，
      // 属于不可逆的数据损坏，必须挡在写盘之前。
      if (raw.includes('\uFFFD')) {
        return reject(new HttpError(400, '请求体不是合法 UTF-8（中文可能被 shell 按本地代码页转码了）；'
          + '请改用浏览器控制台，或确保以 UTF-8 发送'));
      }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new HttpError(400, '请求体非合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function authorized(req, url) {
  const t = url.searchParams.get('t') || req.headers['x-qam-token'];
  if (typeof t !== 'string' || t.length < 16) return false;
  // 定长比较，避免时序侧信道
  const a = Buffer.from(t.padEnd(64, '\0').slice(0, 64));
  const b = Buffer.from(TOKEN.padEnd(64, '\0').slice(0, 64));
  if (!crypto.timingSafeEqual(a, b)) return false;
  // Host 白名单：挡 DNS rebinding（外部域名解析到 127.0.0.1 后仍带自己的 Host 头）
  const host = String(req.headers.host || '');
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

// ── 路由 ──────────────────────────────────────────────────────────────────
async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method || 'GET';

  if (route === '/api/ping') return send(res, 200, { ok: true, pong: Date.now() });

  if (route === '/api/status' && method === 'GET') {
    try {
      const s = collectStatus();
      // 自动退出倒计时属服务进程自己的状态，故在这里附加，不进 collectStatus
      s.watchdog = watchdogState();
      return send(res, 200, { ok: true, status: s });
    } catch (e) {
      return send(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (route === '/api/log' && method === 'GET') {
    const n = Math.min(200, Math.max(1, parseInt(url.searchParams.get('n') || '30', 10) || 30));
    return send(res, 200, { ok: true, log: readSigninLog(n).reverse() });
  }

  if (route === '/api/save' && method === 'POST') {
    const b = await readBody(req);
    const id = requireSlotId(b.id);
    assertNotSwitching('保存槽位');
    const args = ['save', id, '--json'];
    if (b.name) args.push('--name', String(b.name).slice(0, 80));
    if (b.kill) args.push('--kill');
    const r = await runCli('accounts.mjs', args, { timeout: b.kill ? 120000 : 300000 });
    return send(res, r.ok ? 200 : 500, { ...r, cmd: 'save', id });
  }

  if (route === '/api/remove' && method === 'POST') {
    const b = await readBody(req);
    const id = requireSlotId(b.id);
    assertNotSwitching('删除槽位');
    const r = await runCli('accounts.mjs', ['remove', id, '--yes', '--json']);
    return send(res, r.ok ? 200 : 500, { ...r, cmd: 'remove', id });
  }

  // 覆盖式保存之后找回上一代快照。只动 snapshots 目录，不碰实时数据目录，
  // 所以 Qoder 运行中也能执行；再点一次即换回来（互换是对称操作）。
  if (route === '/api/rollback' && method === 'POST') {
    const b = await readBody(req);
    const id = requireSlotId(b.id);
    assertNotSwitching('回退快照');
    if (!b.confirm) {
      return send(res, 400, { ok: false, error: '未确认。回退会把当前主快照与上一代互换。' });
    }
    try {
      const after = rollbackSnapshot(id);
      return send(res, 200, {
        ok: true, cmd: 'rollback', id,
        text: `已把槽位 ${id} 回退到上一代快照（uid=${maskUid(after.uid)}，`
          + `保存于 ${after.savedAtMs ? new Date(after.savedAtMs).toLocaleString('zh-CN', { hour12: false }) : '-'}）。`
          + '再执行一次即可换回来。',
      });
    } catch (e) {
      return send(res, 500, { ok: false, cmd: 'rollback', id, error: String(e?.message || e) });
    }
  }

  if (route === '/api/rename' && method === 'POST') {
    const b = await readBody(req);
    const id = String(b.id || '').trim();
    const reg = loadRegistry();
    const a = findAccount(reg, id);
    if (!a) return send(res, 404, { ok: false, error: `槽位不存在: ${id}` });
    a.name = String(b.name || '').slice(0, 80) || a.name;
    saveRegistry(reg);
    return send(res, 200, { ok: true, cmd: 'rename', id, name: a.name });
  }

  if (route === '/api/signin' && method === 'POST') {
    const b = await readBody(req);
    assertNotSwitching('签到');
    const ids = Array.isArray(b.ids) ? b.ids.map((x) => String(x)).filter(Boolean) : [];
    for (const x of ids) requireSlotId(x, '签到槽位 id');
    const args = ['signin', '--json', ...ids];
    // 签到含 1~3s 抖动 + 多活动，给足超时
    const r = await runCli('signin.mjs', args, { timeout: 300000 });
    return send(res, r.ok ? 200 : 500, { ...r, cmd: 'signin' });
  }

  // ⚠ 切换会关闭并重启 Qoder IDE。用 detached 子进程执行，
  //   立即返回 202，前端轮询 /api/switch-log 看进度。
  if (route === '/api/switch' && method === 'POST') {
    const b = await readBody(req);
    const target = requireSlotId(b.target, 'target');
    if (b.saveAs) requireSlotId(b.saveAs, 'saveAs');
    if (!b.confirm) {
      return send(res, 400, {
        ok: false,
        error: '未确认。切换会关闭并重启 Qoder IDE，未保存的编辑内容会丢失。',
      });
    }
    const args = ['switch', target];
    if (b.noRestart) args.push('--no-restart');
    if (b.noSaveCurrent) args.push('--no-save-current');
    if (b.saveAs) args.push('--save-as', String(b.saveAs));
    let pid = null;
    try {
      pid = runSwitchDetached(args);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      return send(res, 500, { ok: false, error: `启动切换进程失败: ${e?.message || e}` });
    }
    return send(res, 202, {
      ok: true, cmd: 'switch', target, pid, started: true,
      message: '切换已启动，Qoder 即将关闭并重启。本页会尽量显示进度；若页面随 Qoder '
        + '一起失去响应属正常现象（服务位于 Qoder 的作业对象内），数据都已落盘，'
        + '重新打开 Qoder 后再运行 /account-console 即可继续。',
    });
  }

  if (route === '/api/switch-log' && method === 'GET') {
    let text = '';
    try { text = fs.readFileSync(SWITCH_LOG, 'utf8'); } catch { text = ''; }
    // 只回最后 8KB，够看进度又不至于把整份日志灌进浏览器
    return send(res, 200, { ok: true, text: text.slice(-8192) });
  }

  if (route === '/api/config' && method === 'GET') {
    return send(res, 200, { ok: true, config: loadConfig() });
  }
  if (route === '/api/config' && method === 'POST') {
    const b = await readBody(req);
    // 档位决定"下一次交换哪些文件"，切换进行中改它会让正在跑的恢复用错白名单
    assertNotSwitching('修改快照档位');
    const cfg = loadConfig();
    if (b.tiers && typeof b.tiers === 'object') {
      for (const k of ['core', 'browser', 'appdata']) {
        if (typeof b.tiers[k] === 'boolean') cfg.tiers[k] = b.tiers[k];
      }
      // core 关掉会导致快照缺身份文件，直接拒绝
      if (cfg.tiers.core === false) {
        return send(res, 400, { ok: false, error: 'core 档不可关闭（缺身份文件快照必然不可用）' });
      }
    }
    if (b.exitAfterNoQoderSec !== undefined) {
      const sec = Number(b.exitAfterNoQoderSec);
      if (!Number.isFinite(sec) || sec < 0 || sec > 86400) {
        return send(res, 400, { ok: false, error: 'exitAfterNoQoderSec 需为 0~86400 的秒数（0 = 常驻）' });
      }
      cfg.exitAfterNoQoderSec = Math.round(sec);
    }
    const oldSec = Number(loadConfig().exitAfterNoQoderSec);   // 先记下旧值，saveConfig 之后就取不到了
    saveConfig(cfg);
    // 阈值改了要重新计时并换轮询间隔，否则新值要等服务重启才生效
    armWatchdog();
    const after = watchdogConfig();
    if (oldSec !== after.sec) {
      console.log(`自动退出策略已更新：${oldSec}s → ${after.sec}s`);
    }
    return send(res, 200, {
      ok: true, config: cfg, watchdog: watchdogState(),
      whitelist: snapshotWhitelist(detectLayout(getDataDir()), cfg),
    });
  }

  // 会话可见性：只读 main.sqlite，回答"切号后对话还在不在"
  if (route === '/api/sessions' && method === 'GET') {
    try {
      return send(res, 200, { ok: true, sessions: sessionVisibility() });
    } catch (e) {
      return send(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (route === '/api/doctor' && method === 'GET') {
    const r = await runCli('accounts.mjs', ['doctor', '--json']);
    return send(res, 200, { ...r, cmd: 'doctor' });
  }

  return send(res, 404, { ok: false, error: `未知接口: ${method} ${route}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');

  // 首页：无 token 也给一个提示页，避免用户直接访问端口时看到裸错误
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (!authorized(req, url)) {
      return send(res, 403, '<!doctype html><meta charset="utf-8">'
        + '<body style="font:14px system-ui;padding:40px;color:#333">'
        + '<h3>需要访问令牌</h3><p>请通过 <code>/account-console</code> 命令或 console.mjs 启动器打开本页。</p>'
        + '<p style="color:#888">直接在地址栏输入端口是打不开的——本服务能重启 IDE，故加了令牌校验。</p>',
      'text/html; charset=utf-8');
    }
    try {
      const html = fs.readFileSync(HTML_PATH, 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    } catch (e) {
      return send(res, 500, { ok: false, error: `读取 console.html 失败: ${e?.message || e}` });
    }
  }

  if (url.pathname.startsWith('/api/')) {
    if (!authorized(req, url)) return send(res, 403, { ok: false, error: '未授权（缺少或错误的 token）' });
    try {
      return await handleApi(req, res, url);
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 500;
      return send(res, code, { ok: false, error: String(e?.message || e) });
    }
  }

  return send(res, 404, { ok: false, error: 'not found' });
});

// 端口被占时自动 +1 递增重试（最多 10 次）。
// 注意：listening 回调必须只注册一次。旧写法把回调传给每次递归的 server.listen()，
// 第一次尝试失败时那个监听器还挂着，第二次成功就会【同时触发两份】——启动横幅、
// server.json 写入、armWatchdog 全部执行两遍（表现为日志里"已启动"重复出现、
// 两个 setInterval 在跑）。
let listeningDone = false;
server.on('listening', () => {
  if (listeningDone) return;
  listeningDone = true;
  const actual = server.address().port;
  ensureDirs();
  const url = `http://127.0.0.1:${actual}/?t=${TOKEN}`;
  // 服务是 detached 启动的，父进程拿不到 stdout，故把访问地址落到状态文件，
  // 由 console.mjs 读取后开浏览器。该文件与明文 creds 同目录、同信任级别。
  try {
    fs.writeFileSync(PORT_FILE, JSON.stringify({
      port: actual, pid: process.pid, token: TOKEN, url, startedAt: Date.now(),
    }, null, 2), { mode: 0o600 });
  } catch { /* 写不进也不影响服务本身，只是启动器需要手动开地址 */ }
  console.log(`Qoder 账号控制台已启动  pid=${process.pid}`);
  console.log(`CONSOLE_URL:${url}`);
  armWatchdog();
  tickWatchdog();   // 立刻探一次，别让首个倒计时空等一个轮询周期
});

function listen(port, tries = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 10) {
      console.log(`端口 ${port} 被占用，试 ${port + 1}…`);
      return listen(port + 1, tries + 1);
    }
    console.error(`服务启动失败: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1');
}

listen(DEFAULT_PORT);
