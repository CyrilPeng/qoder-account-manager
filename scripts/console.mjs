// console.mjs — 本地账号控制台启动器
// 用法:
//   node --no-warnings console.mjs            启动（或复用已在跑的）服务，只打印地址
//   node --no-warnings console.mjs --browser  再用系统默认浏览器打开页面
//   node --no-warnings console.mjs --stop     停止服务
//   node --no-warnings console.mjs --restart  重启服务
//
// 默认不弹系统浏览器：页面是在 IDE 里看的，agent 拿到 CONSOLE_URL 后用内置浏览器打开，
// 启动器再 start 一次等于同一个页面开两遍。
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
const wantBrowser = args.includes('--browser');

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

function printUrl(url) {
  console.log(`CONSOLE_URL:${url}`);
  if (!wantBrowser) {
    console.log('提示: 未弹系统浏览器。在 Qoder 内置浏览器里打开上面的地址，或加 --browser 用默认浏览器。');
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** 请求服务自己退出；成功等它真的消失，返回 'ok' | 'switching' | 'busy' | 其它失败标记 */
async function requestShutdown(info) {
  if (!info?.token) return 'no-token';
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, {
      method: 'POST',
      headers: { 'x-qam-token': info.token },
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      for (let i = 0; i < 50; i++) {          // 最多等 5s：等在跑的请求收尾
        if (!isAlive(info.pid)) return 'ok';
        await sleep(100);
      }
      return 'timeout';
    }
    if (res.status === 409) {
      const body = await res.json().catch(() => null);
      return /切换/.test(String(body?.error || '')) ? 'switching' : 'busy';
    }
    return `http-${res.status}`;
  } catch { return 'unreachable'; }
}

/** 兜底前的身份核对：同 pid 可能已被别的进程复用，命令行必须仍是 server.mjs */
function verifyServerPid(info) {
  if (!isAlive(info.pid)) return { ok: false, detail: '进程已不存在' };
  const cmd = '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(info.pid) + '";'
    + ' if ($p) { $c = [DateTime]$p.CreationDate; Write-Output ($c.ToUniversalTime().ToString("o") + "|" + $p.CommandLine) }';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
    { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  if (r.error || r.status !== 0) return { ok: false, detail: '查询进程信息失败' };
  const out = String(r.stdout || '').trim();
  const [created, ...rest] = out.split('|');
  const line = rest.join('|');
  if (!/server\.mjs/i.test(line)) return { ok: false, detail: `pid=${info.pid} 不是控制台服务（${out.slice(0, 120)}）` };
  const createdMs = Date.parse(created);
  if (info.startedAt && Number.isFinite(createdMs) && Math.abs(createdMs - info.startedAt) > 60_000) {
    return { ok: false, detail: `pid=${info.pid} 的启动时间与 server.json 不符，可能是 pid 复用` };
  }
  return { ok: true, detail: line.slice(0, 160) };
}

async function stopServer(info) {
  if (!info?.pid) return false;
  // 切换进行中一律不停止：服务里可能还有切换子进程，停掉就看不到进度
  const lock = readSwitchLock();
  if (lock) {
    console.error(`错误: 切换进行中（目标 ${lock.target || '?'}，已 ${Math.round(lock.ageMs / 1000)}s），`
      + '不要停止服务。等切换完成（或确认其已卡死后手工结束 switch.mjs 进程）再试。');
    return false;
  }
  const how = await requestShutdown(info);
  if (how === 'ok') return true;
  if (how === 'switching') {
    console.error('错误: 服务端报告切换进行中，拒绝停止。等切换完成再试。');
    return false;
  }
  if (how === 'busy') {
    console.error('错误: 有保存/签到等操作正在执行，等它完成再停服务。');
    return false;
  }
  // 服务没响应（卡死/旧版本没有 /api/shutdown）：核对身份后再结束，且不带 /T
  const id = verifyServerPid(info);
  if (!id.ok) {
    console.error(`错误: 无法确认 pid=${info.pid} 仍是控制台服务（${id.detail}）。`);
    console.error(`已放弃结束进程。请核对 ${PORT_FILE}，或手工确认后结束该 pid。`);
    return false;
  }
  const r = spawnSync('taskkill', ['/PID', String(info.pid), '/F'], { windowsHide: true });
  try { fs.rmSync(PORT_FILE, { force: true }); } catch { /* ignore */ }
  if (r.error || r.status !== 0) {
    console.error(`错误: taskkill 失败（${String(r.stderr || r.error?.message || r.status)}）。`);
    return false;
  }
  return true;
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
    if (!info) return console.log('服务未在运行');
    const ok = await stopServer(info);
    console.log(ok ? `已停止控制台服务 (pid=${info.pid})` : '停止失败，请按上面的提示处理');
    if (!ok) process.exitCode = 1;
    return;
  }

  let info = readPortFile();
  if (info && (await ping(info))) {
    if (!args.includes('--restart')) {
      console.log(`复用已在运行的控制台服务 (pid=${info.pid}, port=${info.port})`);
      if (wantBrowser) openBrowser(info.url);
      printUrl(info.url);
      return;
    }
    const stopped = await stopServer(info);
    if (!stopped) {
      console.error('错误: 旧服务未能停止，已取消重启（不会再起一个抢端口的新服务）。');
      process.exit(1);
    }
    await sleep(300);
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
  printUrl(ready.url);
  console.log('\n提示: 登录数据固化在 ~/.qoder-account-manager/，与服务是否常驻无关。');
  console.log('      服务默认在 Qoder 连续 3 分钟不在运行后自行退出（省内存）；');
  console.log('      要常驻就设 config.json 的 exitAfterNoQoderSec = 0，或在控制台「快照策略」里改。');
  console.log('      停止服务: node --no-warnings scripts/console.mjs --stop');
}

main().catch((e) => {
  console.error(`错误: ${e?.message || e}`);
  process.exit(1);
});
