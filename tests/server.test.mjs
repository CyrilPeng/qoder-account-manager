import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(ROOT, 'scripts', 'server.mjs');
const TOKEN = 'a'.repeat(32);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function request(port, pathname, { method = 'GET', headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: { host: host || `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('server 鉴权、安全响应头与自我退出', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qam-server-'));
  const client = path.join(home, 'client');
  fs.mkdirSync(path.join(home, 'snapshots', 'acct1'), { recursive: true });
  fs.mkdirSync(client, { recursive: true });
  fs.writeFileSync(path.join(home, 'credits.json'), JSON.stringify({
    version: 1,
    accounts: {
      acct1: {
        ok: true, kind: 'qoder', fetchedAtMs: Date.now(), planTier: 'Pro', segments: [], batches: [],
        summary: {
          batchCount: 0, byExpiry: 0, total: 0, used: 0, remaining: 0, percentage: 0,
          serverPercentage: null, nearestExpiryMs: null, expiredTotal: 0, blockedRemaining: 0,
          unknownExpiryTotal: 0, segmentCount: 0,
        },
      },
    },
  }));
  // 切号锁（pid 用测试进程自身，保证"活着"），用于验证额度只回缓存
  const lockFile = path.join(home, 'switch.lock');
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: process.pid, target: 'acct2', startedAt: Date.now(), source: 'test',
  }));

  const port = await freePort();
  const child = spawn(process.execPath, ['--no-warnings', SERVER], {
    env: {
      ...process.env,
      QODER_AM_HOME: home,
      QODER_DATA_DIR: client,
      QAM_TOKEN: TOKEN,
      QAM_PORT: String(port),
      QAM_QODER_PROC_NAME: '__qam_test_absent__.exe',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  t.after(() => {
    if (child.exitCode === null) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/F'], { windowsHide: true });
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const portFile = path.join(home, 'server.json');
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(portFile)) break;
    await sleep(100);
  }
  assert.ok(fs.existsSync(portFile), `服务未能启动:\n${out}`);

  // 没 token：403 提示页，且安全响应头齐全
  const denied = await request(port, '/');
  assert.equal(denied.status, 403);
  assert.match(denied.body, /需要访问令牌/);
  assert.equal(denied.headers['referrer-policy'], 'no-referrer');
  assert.equal(denied.headers['x-content-type-options'], 'nosniff');
  assert.equal(denied.headers['x-frame-options'], 'DENY');
  assert.equal(denied.headers['cache-control'], 'no-store');

  // 带 token 但 Host 不是本机：挡 DNS rebinding
  const badHost = await request(port, `/api/ping?t=${TOKEN}`, { host: 'evil.example:80' });
  assert.equal(badHost.status, 403);

  // 正常打开页面，并换发同站 HttpOnly 会话 cookie
  const page = await request(port, `/?t=${TOKEN}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /id="btn-credits"/);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  const setCookie = (page.headers['set-cookie'] || []).find((c) => c.startsWith('qam_session='));
  assert.ok(setCookie, '用 token 打开页面时应下发会话 cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];

  // 地址栏抹掉 token 后，刷新只带 cookie 也要能打开
  const reload = await request(port, '/', { headers: { cookie } });
  assert.equal(reload.status, 200);
  const byCookie = await request(port, '/api/status', { headers: { cookie } });
  assert.equal(byCookie.status, 200);
  assert.equal(JSON.parse(byCookie.body).ok, true);

  // 状态接口不含 token 明文
  const status = await request(port, '/api/status', { headers: { 'x-qam-token': TOKEN } });
  assert.equal(status.status, 200);
  assert.equal(JSON.parse(status.body).ok, true);
  assert.ok(!status.body.includes(TOKEN), '响应体不得出现访问 token');

  // 切换进行中：额度只回缓存并标注 switching
  const credits = await request(port, '/api/credits', { headers: { 'x-qam-token': TOKEN } });
  assert.equal(credits.status, 200);
  const cj = JSON.parse(credits.body);
  assert.equal(cj.ok, true);
  assert.equal(cj.credits.acct1.deferredBy, 'switching');
  assert.equal(cj.credits.acct1.fromCache, true);
  assert.equal(cj.requested, 0);

  // 有切号锁时拒绝停止服务
  const busyStop = await request(port, '/api/shutdown', { method: 'POST', headers: { 'x-qam-token': TOKEN } });
  assert.equal(busyStop.status, 409);

  fs.rmSync(lockFile, { force: true });

  // 未带 token 的停机请求同样被拒
  const noToken = await request(port, '/api/shutdown', { method: 'POST' });
  assert.equal(noToken.status, 403);

  const bye = await request(port, '/api/shutdown', { method: 'POST', headers: { 'x-qam-token': TOKEN } });
  assert.equal(bye.status, 200);
  assert.equal(JSON.parse(bye.body).ok, true);

  const exited = await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', (code) => resolve(code));
    setTimeout(() => resolve(null), 5000);
  });
  assert.equal(exited, 0, `服务应自行退出，实际输出:\n${out}`);
  assert.equal(fs.existsSync(portFile), false, '退出后应删除 server.json');
});
