// console.mjs — 本地账号控制台启动器
// 用法:
//   node --no-warnings console.mjs            启动（或复用已在跑的）服务并打开浏览器
//   node --no-warnings console.mjs --no-browser   只启动服务，打印地址
//   node --no-warnings console.mjs --stop     停止服务
//   node --no-warnings console.mjs --restart  重启服务
//
// 为什么服务要 detached：切换账号会关闭并重启 Qoder IDE。若服务是 IDE/agent 的
// 子进程，会随 IDE 一起被杀，浏览器页面立刻失去后端、看不到切换进度也拿不到结果。
// detached 后服务独立存活，能全程汇报并在 IDE 重启后继续可用。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MGR_DIR, ensureDirs, readSwitchLock } from './qoder_lib.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(SCRIPT_DIR, 'server.mjs');
const PORT_FILE = path.join(MGR_DIR, 'server.json');

const args = process.argv.slice(2);
const wantBrowser = !args.includes('--no-browser');

function readPortFile() {
  try {
    if (!fs.existsSync(PORT_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'));
    return j?.port && j?.token ? j : null;
  } catch { return null; }
}

async function ping(info, timeoutMs = 1500) {
  if (!info) return false;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/ping?t=${info.token}`, { signal: ctl.signal });
    return res.ok;
  } catch { return false; } finally { clearTimeout(t); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openBrowser(url) {
  // Windows：start 的第一个引号参数是窗口标题，必须留空位，否则 URL 被当标题
  const r = spawnSync('cmd.exe', ['/c', 'start', '', url], { windowsHide: true });
  if (r.error || r.status !== 0) {
    const r2 = spawnSync('explorer.exe', [url], { windowsHide: true });
    return !(r2.error || r2.status !== 0);
  }
  return true;
}

function stopServer(info) {
  if (!info?.pid) return false;
  // 切换子进程是本服务 spawn 出来的，taskkill /T 会把它一起带走 —— 那等于在
  // 交换文件的过程中把切换进程杀掉。所以先查切换锁，正在切换时拒绝停止。
  const lock = readSwitchLock();
  if (lock) {
    console.error(`错误: 切换进行中（目标 ${lock.target || '?'}，已 ${Math.round(lock.ageMs / 1000)}s），`
      + '不要停止服务。等切换完成（或确认其已卡死后手工结束 switch.mjs 进程）再试。');
    process.exit(1);
  }
  const r = spawnSync('taskkill', ['/PID', String(info.pid), '/T', '/F'], { windowsHide: true });
  try { fs.rmSync(PORT_FILE, { force: true }); } catch { /* ignore */ }
  return !r.error;
}

function spawnServer() {
  ensureDirs();
  try { fs.rmSync(PORT_FILE, { force: true }); } catch { /* ignore */ }
  const child = spawn(process.execPath, ['--no-warnings', SERVER], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();
  return child.pid;
}

async function main() {
  ensureDirs();

  if (args.includes('--stop')) {
    const info = readPortFile();
    console.log(info ? (stopServer(info) ? `已停止控制台服务 (pid=${info.pid})` : '停止失败，请手动结束进程') : '服务未在运行');
    return;
  }

  let info = readPortFile();
  if (info && (await ping(info))) {
    if (!args.includes('--restart')) {
      console.log(`复用已在运行的控制台服务 (pid=${info.pid}, port=${info.port})`);
      if (wantBrowser) openBrowser(info.url);
      console.log(`CONSOLE_URL:${info.url}`);
      return;
    }
    stopServer(info);
    await sleep(400);
  }

  const pid = spawnServer();
  // 等服务写出地址并可用（最多 ~12s）
  let ready = null;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const cur = readPortFile();
    if (cur && (await ping(cur))) { ready = cur; break; }
  }
  if (!ready) {
    console.error('错误: 控制台服务启动超时。可手动排查:');
    console.error(`  node --no-warnings "${SERVER}"`);
    process.exit(1);
  }
  console.log(`控制台服务已启动 (pid=${ready.pid}, port=${ready.port})；启动器 pid=${pid}`);
  if (wantBrowser) {
    const opened = openBrowser(ready.url);
    if (!opened) console.log('自动打开浏览器失败，请手动访问下面的地址。');
  }
  console.log(`CONSOLE_URL:${ready.url}`);
  console.log('\n提示: 登录数据固化在 ~/.qoder-account-manager/，与服务是否常驻无关。');
  console.log('      服务默认在 Qoder 连续 3 分钟不在运行后自行退出（省内存）；');
  console.log('      要常驻就设 config.json 的 exitAfterNoQoderSec = 0，或在控制台「快照策略」里改。');
  console.log('      停止服务: node --no-warnings scripts/console.mjs --stop');
}

main().catch((e) => {
  console.error(`错误: ${e?.message || e}`);
  process.exit(1);
});
