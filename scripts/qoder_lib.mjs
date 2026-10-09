// qoder_lib.mjs — Qoder 多账号管理共享库
//
// ══ 布局支持（v2 = 当前主线）══════════════════════════════════════════════
// v2「electron-root」布局 —— Qoder CN 0.4.3+，实测 2026-10-08：
//   数据目录 %APPDATA%\com.qodercn.app.stable（由进程命令行 --user-data-dir 决定）
//   登录态真源 auth.v1.dat（整文件即裸 v10 密文，非 JSON 包裹）
//   明文结构 {schemaVersion:1, token, refreshToken, expiresAt,
//             refreshTokenExpiresAt, user:{id,name,email,phone,avatarUrl}}
//   auth-profile-overlays.v1.dat 仅头像/昵称装饰层（avatarUrl/avatarColor/about，≤16）
//   对话历史在 main.sqlite（51MB+）与 chat-session-*.sqlite，永不交换 → 切号保留
//   客户端只存单账号，无原生多账号切换（app.asar 内仅 switchAccountIfNeeded
//   这一内部缓存失效函数），故只能走快照交换。
//
// v1「icube / VSCode fork」布局 —— Qoder CN ≤0.4.2，仅向后兼容保留：
//   数据目录 %APPDATA%\QoderCN
//   登录态真源 User\globalStorage\state.vscdb ItemTable 键 secret://aicoding.auth.userInfo
//
// 两种布局共用同一条解密链（Electron safeStorage = Chromium os_crypt）：
//   Local State → os_crypt.encrypted_key → base64 → DPAPI → AES-256-GCM 32B 密钥
//   → 'v10' + nonce(12) + ct + tag(16)
// ⚠ 实测两个数据目录的 os_crypt 密钥【不相同】，因此 Local State 必须与凭证文件
//   同进同出，否则恢复后的密文解不开。
//
// 签到端点 openapi.qoder.com.cn/sash/api/v1/me/campaigns（Bearer + Cosy-ClientType:10）
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.dirname(SCRIPT_DIR);

// ── 管理数据目录（与插件目录解耦，卸载插件不丢账号）───────────────────────
export const MGR_DIR = process.env.QODER_AM_HOME
  ? path.resolve(process.env.QODER_AM_HOME)
  : path.join(os.homedir(), '.qoder-account-manager');
export const SNAP_DIR = path.join(MGR_DIR, 'snapshots');
export const CREDS_DIR = path.join(MGR_DIR, 'creds');
export const REGISTRY_FILE = path.join(MGR_DIR, 'accounts.json');
export const SIGNIN_LOG_FILE = path.join(MGR_DIR, 'signin-log.json');
export const CONFIG_FILE = path.join(MGR_DIR, 'config.json');
export const SWITCH_LOCK_FILE = path.join(MGR_DIR, 'switch.lock');

// 槽位 id 即快照目录名，会被拼进 path.join(SNAP_DIR, id) 做递归删除 / 覆盖写入。
// 因此 id 校验必须在拼接处强制，而不是只信调用方 —— remove/switch 的 id 来自命令行
// 与 HTTP body，`../../something` 一旦落到 snapSlotDir 就是「删掉任意目录」或
// 「把任意目录的文件覆盖进实时数据目录」。
const SLOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 校验槽位 id；非法直接抛错（调用方负责转成 4xx / 友好报错） */
export function assertSlotId(id) {
  if (typeof id !== 'string' || !SLOT_ID_RE.test(id)) {
    throw new Error(`槽位 id 非法（只允许字母/数字/_/-，1~64 字符）: ${JSON.stringify(String(id).slice(0, 64))}`);
  }
  return id;
}

export function isValidSlotId(id) {
  return typeof id === 'string' && SLOT_ID_RE.test(id);
}

// ── API 常量 ──────────────────────────────────────────────────────────────
export const OPEN_API_BASE = 'https://openapi.qoder.com.cn';
export const COSY_CLIENT_TYPE = '10'; // 缺失时 sash 返回空 campaigns（最隐蔽的坑）
export const CLIENT_UA = 'Qoder';
// 登录态键（v1 用；运行时拼接，避免写入时被凭证脱敏管道误改写）
export const SECRET_KEY = ['secret:/', '/aicoding.', 'auth.userInfo'].join('');
// 硬编码兜底活动 id（每日轮换会过期，优先从列表反学当日 id）
export const KNOWN_DAILY_CAMPAIGNS = [
  ['01a0f1cd-945c-7217-b373-f62e70da792d', '每日领 100 Credits'],
];
export const QODER_PROC_NAME = process.env.QAM_QODER_PROC_NAME || 'Qoder CN.exe';

// ── 快照白名单 ────────────────────────────────────────────────────────────
// v2 分三档，分档依据是实测的「谁决定身份 / 谁决定视图」：
//   core    = 身份本体，必须交换（否则等于没切号）
//   browser = 浏览器侧状态，默认【不】交换 —— 原因见下
//   appdata = 应用级数据（含按账号作用域投影的 agent 配置），默认不交换
//
// ⚠ browser 档默认关闭，这直接决定「切号后能否继续之前的对话」：
//   Local Storage/leveldb 内实测存在 workspaceSessions / workspaceLayout /
//   workspace 等键，属渲染层的【会话与工作区视图状态】，不是身份。若随账号一起
//   交换，等于把目标账号上次留下的视图状态盖上来，表现为"会话消失了"。
//   而 main.sqlite 的 chat_sessions 表无任何账号列，列表 SQL 也无任何账号过滤
//   （实测为 `SELECT session_id, updated_at FROM chat_sessions`，连 WHERE 都没有），
//   工作区仅按 root_paths 匹配、workspace_id 为随机 UUIDv4（非账号派生）。
//   因此只要 main.sqlite 与视图状态都不动，切号后原对话应照常可见可续。
//   Network(cookies) 同理：身份走 auth.v1.dat 的 Bearer token，不依赖 cookie。
//   若你更想要彻底隔离（宁可看不到另一账号的会话），再把 browser 档打开。
export const SNAPSHOT_V2 = {
  core: [
    'auth.v1.dat',                    // 凭证本体
    'Local State',                    // os_crypt 密钥（与凭证必须同进同出）
    'auth.machine-id',                // 设备标识
    'auth-profile-overlays.v1.dat',   // 头像/昵称装饰层
  ],
  browser: [
    'Preferences',
    'first-launch-onboarding.v1.json',
    'Network',                        // cookies（目录）
    'Local Storage/leveldb',          // 目录：含 workspaceSessions 等视图状态
    'Session Storage',                // 目录
  ],
  appdata: [
    'qoder-data.v1.json',             // 含 agentAccountScope（当前作用域的投影）
    'qoder-data.v1.ext.json',         // 含 accounts.<scope> 各账号 agent 配置
    'Partitions',                     // 目录
    'app-plugin-data',                // 目录
  ],
};

// 绝对禁止交换：对话历史、缓存、运行时锁。误交换会丢对话或导致启动异常。
// 这条是硬红线，任何配置都绕不过去（snapshotWhitelist / restoreSnapshot 双重过滤）。
export const SNAPSHOT_NEVER = [
  'main.sqlite', 'main.sqlite-wal', 'main.sqlite-shm', 'main.sqlite.pre-migration-backup',
  'chat-session-turn-payload-buffer.sqlite',
  'chat-session-turn-payload-buffer.sqlite-wal',
  'chat-session-turn-payload-buffer.sqlite-shm',
  'sessionMigration.sqlite', 'memoryMigration.sqlite',
  'logs', 'lockfile', 'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache',
  'DawnWebGPUCache', 'blob_storage', 'crash-feedback-v1', 'Crashpad', 'DIPS', 'DIPS-wal',
  'Shared Dictionary', 'SharedStorage', 'SharedStorage-wal', 'updates',
  'application-icons', 'dynamic-text', 'partner-plan-assets', 'rum-electron-store',
];

// v1 旧布局白名单（向后兼容，勿改）
export const SNAPSHOT_FILES = [
  'User/globalStorage/storage.json',
  'User/globalStorage/state.vscdb',
  'User/globalStorage/state.vscdb-wal',
  'User/globalStorage/state.vscdb-shm',
  'User/globalStorage/state.vscdb.backup',
  'machineid',
  'Preferences',
  'Local State',
  'SharedClientCache/cache/id',
  'SharedClientCache/cache/machine_token.json',
  'SharedClientCache/cache/client.json',
  'SharedClientCache/cache/status.json',
];
export const SNAPSHOT_DIRS = [
  'Local Storage/leveldb',
  'Network',
  'Session Storage',
];

// ── 基础工具 ──────────────────────────────────────────────────────────────
export function ensureDirs() {
  for (const d of [MGR_DIR, SNAP_DIR, CREDS_DIR]) fs.mkdirSync(d, { recursive: true });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** claim 间隔抖动 1~3s（风控合规：不可预测间隔） */
export function jitterMs() {
  return 1000 + (crypto.randomBytes(4).readUInt32BE(0) % 2000);
}

export function nowMs() { return Date.now(); }

export function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 信封穿透取值：obj[k] 或 obj.data[k]（服务端 {data:{...}} 包裹兼容） */
export function dig(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    if (obj.data && typeof obj.data === 'object' && obj.data[k] !== undefined && obj.data[k] !== null) {
      return obj.data[k];
    }
  }
  return undefined;
}

export function maskUid(uid) {
  if (!uid) return '(无)';
  return uid.length <= 12 ? uid : `${uid.slice(0, 8)}…${uid.slice(-4)}`;
}

/** 邮箱脱敏：ab***@domain（仅用于展示，不还原） */
export function maskEmail(email) {
  if (!email || typeof email !== 'string') return '';
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

// ── 用户配置（快照档位开关 / 手动指定数据目录 / exe）──────────────────────
/**
 * 档位默认值。browser 默认关闭是刻意的：它含 leveldb 里的会话视图状态，
 * 交换会让切号后看不到原对话（详见 SNAPSHOT_V2 注释）。
 */
export const TIER_DEFAULTS = { core: true, browser: false, appdata: false };

/**
 * Qoder 连续不在运行多少秒后，控制台服务自己结束进程。
 * 默认 180s：切换账号通常半分钟内就会把 IDE 拉起来，超过 3 分钟还没起来基本就是用户
 * 真退出了，此时留着一个 HTTP 服务只是白占内存（实测约 50MB RSS）。
 * 设成 0 = 常驻（想在 IDE 关着的时候也从页面点签到/切换就用这个）。
 */
export const DEFAULT_EXIT_AFTER_NO_QODER_SEC = 180;

export function loadConfig() {
  const base = {
    dataDir: null,          // 手动覆盖探测结果（null = 自动）
    layout: null,           // 保留字段；布局一律按目录内容实测
    tiers: { ...TIER_DEFAULTS },
    exePath: null,          // 手动覆盖 exe
    launchArgs: [],         // 重启 Qoder 时附加的命令行参数（自定义 --user-data-dir 等）
    exitAfterNoQoderSec: DEFAULT_EXIT_AFTER_NO_QODER_SEC,
  };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const t = { ...base.tiers, ...(c.tiers || {}) };
      // 旧档位名迁移：session→browser、extra→appdata。
      // 语义已变（browser 由默认开改为默认关，因为它会带走会话视图状态），
      // 因此旧值不直接沿用，只在用户没显式配过新键时落到新默认值。
      if (t.session !== undefined && c.tiers?.browser === undefined) t.browser = TIER_DEFAULTS.browser;
      if (t.extra !== undefined && c.tiers?.appdata === undefined) t.appdata = TIER_DEFAULTS.appdata;
      delete t.session;
      delete t.extra;
      // launchArgs 只接受字符串数组，避免坏配置把对象塞进 spawn argv
      const la = Array.isArray(c.launchArgs) ? c.launchArgs.filter((x) => typeof x === 'string') : [];
      const out = { ...base, ...c, tiers: t, launchArgs: la };
      // 自动退出阈值：只接受 >=0 的有限数，坏值一律回落到默认（0 是合法的"关闭"）
      const sec = Number(out.exitAfterNoQoderSec);
      out.exitAfterNoQoderSec = Number.isFinite(sec) && sec >= 0 ? sec : DEFAULT_EXIT_AFTER_NO_QODER_SEC;
      return out;
    }
  } catch { /* 配置损坏则用默认，不因坏配置卡死 */ }
  return base;
}

export function saveConfig(cfg) {
  ensureDirs();
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

// ── 数据目录 / 布局探测 ───────────────────────────────────────────────────
const APPDATA = process.env.APPDATA || '';
// 候选顺序：新版 electron-root 在前，旧版 icube 兜底
export const DATA_DIR_CANDIDATES = [
  path.join(APPDATA, 'com.qodercn.app.stable'),
  path.join(APPDATA, 'QoderCN'),
];

/** 从运行中进程的 --user-data-dir 取真实数据目录（最权威，不受版本升级影响） */
function dataDirFromRunningProcess() {
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "Name='${QODER_PROC_NAME}'" `
        + '| Select-Object -ExpandProperty CommandLine) -join "`n"'],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const m = out.match(/--user-data-dir=([^\r\n]+)/);
    if (m && m[1]) {
      const p = path.resolve(m[1].trim().replace(/^"|"$/g, ''));
      if (fs.existsSync(p)) return p;
    }
  } catch { /* 进程不在或 PowerShell 不可用 */ }
  return null;
}

/** 该目录属于哪种布局；都不匹配返回 null */
export function detectLayout(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  if (fs.existsSync(path.join(dir, 'auth.v1.dat'))) return 'v2';
  if (fs.existsSync(path.join(dir, 'User', 'globalStorage', 'state.vscdb'))) return 'v1';
  return null;
}

let _cachedDataDir = null;
/**
 * 解析当前生效的数据目录。优先级：
 *   环境变量 QODER_DATA_DIR > config.dataDir > 运行中进程命令行
 *   > 首个布局有效的候选目录 > 首个存在的候选目录
 * 旧实现把目录写死成 %APPDATA%\QoderCN，客户端升到 0.4.3 后指向了停用目录，
 * 导致读出的全是过期登录态——这里改为运行时动态解析并缓存。
 */
export function getDataDir({ refresh = false } = {}) {
  if (_cachedDataDir && !refresh) return _cachedDataDir;
  const cfg = loadConfig();
  const pick = (p) => (p && fs.existsSync(p) ? path.resolve(p) : null);

  const fromEnv = pick(process.env.QODER_DATA_DIR);
  if (fromEnv) return (_cachedDataDir = fromEnv);
  const fromCfg = pick(cfg.dataDir);
  if (fromCfg) return (_cachedDataDir = fromCfg);

  const fromProc = dataDirFromRunningProcess();
  if (fromProc && detectLayout(fromProc)) return (_cachedDataDir = fromProc);
  for (const c of DATA_DIR_CANDIDATES) {
    if (detectLayout(c)) return (_cachedDataDir = c);
  }
  if (fromProc) return (_cachedDataDir = fromProc);
  for (const c of DATA_DIR_CANDIDATES) {
    if (fs.existsSync(c)) return (_cachedDataDir = c);
  }
  return (_cachedDataDir = DATA_DIR_CANDIDATES[0]);
}

/** 兼容旧引用：模块加载时解析一次 */
export const QODER_DATA_DIR = getDataDir();
export const QODER_LAYOUT = detectLayout(QODER_DATA_DIR);

/** 安装/环境概况（供 UI 与 status 展示） */
export function describeInstall() {
  const dir = getDataDir({ refresh: true });
  const layout = detectLayout(dir);
  return {
    dataDir: dir,
    layout,
    layoutLabel: layout === 'v2' ? 'electron-root（Qoder CN 0.4.3+）'
      : layout === 'v1' ? 'icube / VSCode fork（≤0.4.2，旧版）' : '未识别',
    running: qoderRunning(),
    mgrDir: MGR_DIR,
    candidates: DATA_DIR_CANDIDATES.map((p) => ({
      path: p, exists: fs.existsSync(p), layout: detectLayout(p), active: p === dir,
    })),
  };
}

/** 按布局 + 配置档位算出实际要交换的相对路径清单 */
export function snapshotWhitelist(layout = QODER_LAYOUT, cfg = loadConfig()) {
  if (layout === 'v1') return [...SNAPSHOT_FILES, ...SNAPSHOT_DIRS];
  const t = { ...TIER_DEFAULTS, ...(cfg.tiers || {}) };
  const out = [];
  if (t.core !== false) out.push(...SNAPSHOT_V2.core);
  // browser / appdata 默认关闭：开启会连视图状态与 agent 作用域投影一起换，
  // 表现为切号后看不到原对话。默认只换身份，最大化"切号续聊"。
  if (t.browser === true) out.push(...SNAPSHOT_V2.browser);
  if (t.appdata === true) out.push(...SNAPSHOT_V2.appdata);
  // 双保险：任何情况下都不得混入禁交换项
  return out.filter((rel) => !SNAPSHOT_NEVER.some((n) => rel === n || rel.startsWith(n + '/')));
}

/** 快照完整性必需项（缺任一即视为不可用快照） */
export function snapshotRequired(layout = QODER_LAYOUT) {
  return layout === 'v1'
    ? ['User/globalStorage/state.vscdb', 'Local State']
    : ['auth.v1.dat', 'Local State'];
}

// ── 注册表 ────────────────────────────────────────────────────────────────
export function loadRegistry() {
  ensureDirs();
  if (!fs.existsSync(REGISTRY_FILE)) return { version: 2, exePath: null, accounts: [] };
  try {
    const r = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    if (!Array.isArray(r.accounts)) r.accounts = [];
    return r;
  } catch {
    return { version: 2, exePath: null, accounts: [] };
  }
}

export function saveRegistry(reg) {
  ensureDirs();
  reg.version = 2;
  if (!Array.isArray(reg.accounts)) reg.accounts = [];
  const tmp = REGISTRY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, REGISTRY_FILE);
}

export function findAccount(reg, id) {
  return reg.accounts.find((a) => a.id === id) || null;
}

// ── 凭证缓存（刷新令牌一次性轮换：刷新成功必须立即持久化，否则账号锁死）──
export function credsFile(id) { return path.join(CREDS_DIR, `${assertSlotId(id)}.json`); }

export function loadCreds(id) {
  const f = credsFile(id);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

export function saveCreds(id, creds) {
  ensureDirs();
  const tmp = credsFile(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...creds, updatedAt: nowMs() }, null, 2));
  fs.renameSync(tmp, credsFile(id));
}

/** scanLogin 结果 → creds 缓存形状（统一形状，避免 signin/backup 两处各写一套） */
export function credsFromLogin(v) {
  return {
    uid: v.uid || '',
    name: v.name || '',
    access_token: v.token || '',
    refresh_token: v.refreshToken || '',
    expires_at_ms: v.expiresAtMs ?? null,
    refresh_expires_at_ms: v.refreshExpiresAtMs ?? null,
  };
}

/**
 * 纯函数：非活跃账号签到时，凭证该用缓存还是用槽位快照解密？
 *
 * 背景：refreshToken 一次性轮换，缓存里那份一旦被服务端轮换取走就永久作废；而用户
 * 在 IDE 里重新登录该账号并 save 后，快照里的才是有效凭证。旧实现无条件优先用缓存，
 * 于是「重新登录 + 重新 save」之后签到仍报 permanent_auth。
 * 规则：快照的保存时间（或快照令牌本身的过期时间）不早于缓存更新时间才可能胜出，
 * 谁更新用谁；快照不可读时只能用缓存。
 * @returns {'snapshot'|'cache'|'none'}
 */
export function pickCredsSource({ cached, snap, savedAtMs, tokenTtlMs = 10 * 60 * 1000 } = {}) {
  const now = Date.now();
  const cacheUsable = Boolean(cached?.access_token);
  const snapUsable = Boolean(snap?.token);
  if (!snapUsable) return cacheUsable ? 'cache' : 'none';
  if (!cacheUsable) return 'snapshot';
  const cacheAt = Number(cached.updatedAt || cached.expires_at_ms || 0);
  const snapAt = Number(savedAtMs || 0);
  // 快照是客户端自己的最新状态：只要不旧于缓存就用它
  if (snapAt && snapAt >= cacheAt) return 'snapshot';
  // 缓存快过期而快照令牌还很长 → 用快照（缓存里可能已是被轮换掉的旧令牌）
  const cacheLeft = Number(cached.expires_at_ms || 0) - now;
  const snapLeft = Number(snap.expiresAtMs || 0) - now;
  if (cacheLeft < tokenTtlMs && snapLeft > cacheLeft) return 'snapshot';
  return 'cache';
}

// ── 切换互斥锁 ────────────────────────────────────────────────────────────
/**
 * 同一时刻只允许一个切换在跑：两个进程同时交换同一个数据目录 = 未定义行为。
 * 控制台（/api/switch 的 detached 子进程）与用户手敲的 CLI 都会走这里。
 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) {
    // EPERM 说明进程在但没权限查；ESRCH 才是「不存在」
    return e?.code === 'EPERM';
  }
}

export function writeSwitchLock(info) {
  ensureDirs();
  fs.writeFileSync(SWITCH_LOCK_FILE, JSON.stringify({ ...info, pid: info.pid ?? null, startedAt: info.startedAt || nowMs() }, null, 2));
}

export function clearSwitchLock() {
  try { fs.rmSync(SWITCH_LOCK_FILE, { force: true }); } catch { /* ignore */ }
}

/**
 * 读取有效的切换锁。无锁 / 进程已死 / 超过 maxAgeMs 视为陈旧并顺手清理。
 * 陈旧判定必须有：切换进程被 Job Object 连带回收时不会执行清理代码。
 * @returns {null|{pid:number|null,target:string,startedAt:number,source:string,ageMs:number}}
 */
export function readSwitchLock({ maxAgeMs = 15 * 60 * 1000, reclaim = true } = {}) {
  if (!fs.existsSync(SWITCH_LOCK_FILE)) return null;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(SWITCH_LOCK_FILE, 'utf8')); }
  catch { if (reclaim) clearSwitchLock(); return null; }
  const startedAt = Number(j?.startedAt) || 0;
  const ageMs = startedAt ? Date.now() - startedAt : Infinity;
  const pid = Number(j?.pid) || 0;
  const alive = pid ? isPidAlive(pid) : true;   // pid 为 null（服务端预占位）时按时间判活
  if (ageMs > maxAgeMs || !alive) {
    if (reclaim) clearSwitchLock();
    return null;
  }
  return { pid: pid || null, target: String(j?.target || ''), startedAt, source: String(j?.source || 'cli'), ageMs };
}

// ── DPAPI / 解密链 ────────────────────────────────────────────────────────
function dpapiUnprotect(buf) {
  const ps1 = path.join(SCRIPT_DIR, 'dpapi_unprotect.ps1');
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
    { input: buf.toString('base64'), encoding: 'utf8', windowsHide: true });
  return Buffer.from(out.trim(), 'base64');
}

/**
 * Local State → os_crypt.encrypted_key → DPAPI → AES-256-GCM 32B 密钥。
 * 按 Local State 绝对路径缓存：status 要为实时目录和每个槽位各取一次钥，每次都新起
 * 一个 PowerShell 跑 DPAPI 太慢（实测约 200ms/次），UI 每 20s 刷新会明显卡顿。
 * 密钥只存在于进程内存，不落盘、不出现在任何输出里。
 */
const _keyCache = new Map();
export function getAesKey(dataDir = QODER_DATA_DIR) {
  const lp = path.join(dataDir, 'Local State');
  const ck = path.resolve(lp);
  if (_keyCache.has(ck)) return _keyCache.get(ck);
  if (!fs.existsSync(lp)) throw new Error(`缺 Local State: ${lp}`);
  const state = JSON.parse(fs.readFileSync(lp, 'utf8'));
  const b64 = state?.os_crypt?.encrypted_key;
  if (!b64) throw new Error('Local State 无 os_crypt.encrypted_key');
  if (state?.os_crypt?.app_bound_encrypted_key) {
    // app-bound encryption 把密钥绑定到进程完整性校验，外部进程无法复用
    throw new Error('该目录启用了 app-bound encryption，外部进程无法解密');
  }
  const raw = Buffer.from(b64, 'base64');
  if (raw.length < 5 || raw.toString('latin1', 0, 5) !== 'DPAPI') {
    throw new Error('encrypted_key 前缀非 DPAPI');
  }
  const key = dpapiUnprotect(raw.subarray(5));
  if (key.length !== 32) throw new Error(`AES 密钥长度异常: ${key.length}`);
  _keyCache.set(ck, key);
  return key;
}

/** 数据目录热切换 / 测试时清空密钥缓存 */
export function clearAesKeyCache() { _keyCache.clear(); }

/** v10 密文解密：'v10' + nonce(12) + ct + tag(16) → AES-256-GCM */
export function decryptV10(enc, key) {
  if (!enc || enc.length < 19 || enc.toString('latin1', 0, 3) !== 'v10') return null;
  const nonce = enc.subarray(3, 15);
  const tag = enc.subarray(enc.length - 16);
  const ct = enc.subarray(15, enc.length - 16);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * decryptV10 的逆运算：把续期后的令牌写回 auth.v1.dat 用。
 * Chromium os_crypt 格式 'v10' + 随机 nonce(12) + AES-256-GCM(ct) + tag(16)。
 * 调用方写回后必须再用 decryptV10 自校验（见 writeAuthV2）。
 */
export function encryptV10(plain, key) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ct, c.getAuthTag()]);
}

// ── 登录态读取：v2（auth.v1.dat）──────────────────────────────────────────
export function authV2Path(dataDir) { return path.join(dataDir, 'auth.v1.dat'); }

/** ISO8601 字符串 / 秒 / 毫秒 → 毫秒时间戳 */
function toMs(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v >= 1_000_000_000_000 ? v : v * 1000;
  }
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n >= 1_000_000_000_000 ? n : n * 1000;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * 读 v2 登录态。返回 {layout:'v2', uid, name, email, phone, avatarUrl, token,
 * refreshToken, expiresAtMs, refreshExpiresAtMs, raw}。失败抛错。
 */
export function scanLoginV2(dataDir) {
  const f = authV2Path(dataDir);
  if (!fs.existsSync(f)) throw new Error('无 auth.v1.dat（未登录或布局不符）');
  const key = getAesKey(dataDir);
  const plain = decryptV10(fs.readFileSync(f), key);
  if (!plain) throw new Error('auth.v1.dat 解密失败（Local State 密钥与密文不匹配）');
  let v;
  try { v = JSON.parse(plain); } catch { throw new Error('auth.v1.dat 明文非合法 JSON'); }
  if (v?.schemaVersion !== 1) throw new Error(`auth.v1.dat schemaVersion 未知: ${v?.schemaVersion}`);
  const uid = String(v?.user?.id || '');
  if (!uid) throw new Error('auth.v1.dat 无 user.id');
  return {
    layout: 'v2',
    uid,
    name: String(v?.user?.name || ''),
    email: String(v?.user?.email || ''),
    phone: String(v?.user?.phone || ''),
    avatarUrl: String(v?.user?.avatarUrl || ''),
    token: String(v?.token || ''),
    refreshToken: String(v?.refreshToken || ''),
    expiresAtMs: toMs(v?.expiresAt),
    refreshExpiresAtMs: toMs(v?.refreshTokenExpiresAt),
    raw: v,
  };
}

/**
 * 把续期后的令牌写回 v2 auth.v1.dat（保留原结构，仅替换令牌与过期时间）。
 * 原子写 + 解密自校验 + 失败回滚。
 * ⚠ 要求 Qoder 已关闭：客户端在内存里持有旧令牌，运行中写回会被它覆写。
 */
export function writeAuthV2(dataDir, { token, refreshToken, expiresAtMs, refreshExpiresAtMs }) {
  const f = authV2Path(dataDir);
  if (!fs.existsSync(f)) throw new Error('auth.v1.dat 不存在，无法写回');
  const key = getAesKey(dataDir);
  const cur = scanLoginV2(dataDir);
  const next = { ...cur.raw };
  if (token) next.token = String(token);
  if (refreshToken) next.refreshToken = String(refreshToken);
  if (expiresAtMs) next.expiresAt = new Date(expiresAtMs).toISOString();
  if (refreshExpiresAtMs) next.refreshTokenExpiresAt = new Date(refreshExpiresAtMs).toISOString();
  const blob = encryptV10(JSON.stringify(next), key);
  if (decryptV10(blob, key) === null) throw new Error('写回前自校验失败：新密文无法解回');
  const bak = f + '.qam-bak';
  const tmp = f + '.qam-tmp';
  fs.copyFileSync(f, bak);
  try {
    fs.writeFileSync(tmp, blob);
    fs.renameSync(tmp, f);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    fs.copyFileSync(bak, f); // 回滚到写前状态
    throw e;
  } finally {
    fs.rmSync(bak, { force: true });
  }
  return true;
}

// ── 登录态读取：v1（state.vscdb，向后兼容）────────────────────────────────
/**
 * 读 ItemTable 单键。直接打开原库查询（SQLite WAL 支持读写并发，一致性由
 * SQLite 保证）。切勿手工拷贝 db+wal+shm 再读：Qoder 运行中 checkpoint 会使
 * 拷贝不一致，仅存于 WAL 的新行（如刚刷新的 userInfo）会丢失（实测踩坑）。
 */
export function readVscdbKey(dbPath, key) {
  if (!fs.existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
    if (!row) return null;
    const v = row.value;
    if (typeof v === 'string') return v;
    if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8');
    return null;
  } finally {
    db.close();
  }
}

/** 写 ItemTable 单键（保持原存储类型：传入 Uint8Array 写 BLOB，string 写 TEXT） */
export function writeVscdbKey(dbPath, key, value) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  } finally {
    db.close();
  }
}

/** secret:// 值形态：TEXT JSON {"type":"Buffer","data":[...]} → 字节 */
function parseBuffer(text) {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v?.data)) return Buffer.from(v.data);
  } catch { /* fallthrough */ }
  return null;
}

/** expireTime 归一：>=1e12 毫秒原样，否则秒×1000 */
function expireMsOf(v) {
  const raw = v?.expireTime;
  if (raw === undefined || raw === null) return null;
  const ts = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return ts >= 1_000_000_000_000 ? ts : ts * 1000;
}

export function scanLoginV1(dataDir) {
  const key = getAesKey(dataDir);
  const vscdb = path.join(dataDir, 'User', 'globalStorage', 'state.vscdb');
  const raw = readVscdbKey(vscdb, SECRET_KEY);
  if (!raw) throw new Error('state.vscdb 无登录态（可能未登录或已清除）');
  const bytes = parseBuffer(raw);
  if (!bytes) throw new Error('登录态键值形态不识别');
  const plain = decryptV10(bytes, key);
  if (!plain) throw new Error('登录态解密失败（密钥或密文不匹配）');
  const v = JSON.parse(plain);
  const uid = String(v.id || '');
  if (!uid) throw new Error('userInfo 无 id');
  return {
    layout: 'v1',
    uid,
    name: String(v.name || ''),
    email: String(v.email || ''),
    phone: '',
    avatarUrl: '',
    token: String(v.token || ''),
    refreshToken: String(v.refreshToken || ''),
    expiresAtMs: expireMsOf(v),
    refreshExpiresAtMs: null,
  };
}

/**
 * 统一登录态入口：按目录实际布局自动分派。
 * dataDir 可传数据目录根，也可传快照槽位目录（两种布局各自识别）。
 */
export function scanLogin(dataDir = getDataDir()) {
  const layout = detectLayout(dataDir);
  if (layout === 'v2') return scanLoginV2(dataDir);
  if (layout === 'v1') return scanLoginV1(dataDir);
  throw new Error(`无法识别数据目录布局（既无 auth.v1.dat 也无 state.vscdb）: ${dataDir}`);
}

// ── 快照备份 / 恢复 ───────────────────────────────────────────────────────
export function snapSlotDir(id) { return path.join(SNAP_DIR, assertSlotId(id)); }
export function snapMetaFile(id) { return path.join(SNAP_DIR, `${assertSlotId(id)}.meta.json`); }
/** 上一代快照的元数据（与 .bak 目录配对；缺了它回退后的槽位会丢掉布局/告警信息）*/
export function snapMetaBakFile(id) { return path.join(SNAP_DIR, `${assertSlotId(id)}.meta.json.bak`); }

export function listSnapshots() {
  if (!fs.existsSync(SNAP_DIR)) return [];
  return fs.readdirSync(SNAP_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    // .bak 是单代回滚保护目录，不是账号槽位。不过滤会被 signin/list 当成账号，
    // 实测导致给 "acct1.bak" 也跑了一次签到并写进日志。
    .filter((n) => !n.endsWith('.bak'))
    // id 不合法的目录（手工造出来的、含 ../ 之类）一律不参与：宁可看不见，
    // 也不能让它进到 snapSlotDir 的删除/覆盖路径拼接里。
    .filter((n) => isValidSlotId(n));
}

/** 槽位的 .bak 回滚目录是否存在（供 UI 提示可回退） */
export function hasSnapBak(id) {
  try { return fs.existsSync(snapSlotDir(id) + '.bak'); } catch { return false; }
}

export function readSnapMeta(id) {
  const f = snapMetaFile(id);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function copyItem(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.statSync(src).isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.copyFileSync(src, dest);
  }
  return true;
}

/**
 * 容错递归拷贝：逐文件复制，单个文件失败不中断整体，失败项记入 errors。
 * 必需项（如 auth.v1.dat）由调用方判定是否致命。
 * 背景：Qoder 运行中 Chromium 会独占 Network/Cookies、leveldb LOCK 等文件，
 * 旧实现用 cpSync 整目录复制，一遇占用就整体抛错，save 全败且留下半个槽位。
 */
function copyTreeTolerant(src, dest, relBase, errors) {
  let n = 0;
  const st = fs.statSync(src);
  if (!st.isDirectory()) {
    if (copyOneFile(src, dest, relBase, errors)) n++;
    return n;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    const rel = `${relBase}/${ent.name}`;
    if (ent.isDirectory()) {
      n += copyTreeTolerant(s, d, rel, errors);
    } else if (copyOneFile(s, d, rel, errors)) {
      n++;
    }
  }
  return n;
}

/**
 * 单文件拷贝，CopyFileW 失败时回退到 read+write。
 * Chromium 运行中会以拒绝共享的方式持有 Network/Cookies，copyFileSync 直接 EBUSY；
 * 但 SQLite 打开文件时通常允许共享读，因此按字节读出来再写往往能成功。
 * 回退仍失败才记入 errors（由调用方判断是否致命）。
 */
function copyOneFile(src, dest, rel, errors) {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  } catch (e) {
    try {
      const buf = fs.readFileSync(src);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return true;
    } catch (e2) {
      errors.push({ path: rel, error: shortErr(e2), fallbackOf: shortErr(e) });
      return false;
    }
  }
}

/** 错误信息压缩成一行（EBUSY/EPERM 之类只需 code + 首句） */
function shortErr(e) {
  const m = String(e?.message || e).split('\n')[0];
  return e?.code ? `${e.code}: ${m}` : m;
}

/**
 * 覆盖槽位前旧快照挪 .bak（单代回滚保护，防拷贝中断丢上一份）。
 * meta 一起轮转：只挪目录不挪 meta 的话，回退出来的快照会带着新一代的布局/告警信息，
 * restoreSnapshot 的「不完整目录降级」判定就会用错依据。
 */
function rotateBak(slotDir, metaFile) {
  if (!fs.existsSync(slotDir)) return false;
  const bak = slotDir + '.bak';
  fs.rmSync(bak, { recursive: true, force: true });
  fs.renameSync(slotDir, bak);
  fs.rmSync(metaFile + '.bak', { force: true });
  if (fs.existsSync(metaFile)) fs.renameSync(metaFile, metaFile + '.bak');
  return true;
}

/** 把 .bak（及其 meta）还原回主槽位。返回是否真的还原了。 */
function restoreFromBak(id) {
  const slotDir = snapSlotDir(id);
  const bakDir = slotDir + '.bak';
  const metaFile = snapMetaFile(id);
  if (!fs.existsSync(bakDir)) return false;
  try {
    fs.rmSync(slotDir, { recursive: true, force: true });   // 只清半成品，主槽位此时应已不存在
    fs.renameSync(bakDir, slotDir);
    if (fs.existsSync(metaFile + '.bak')) fs.renameSync(metaFile + '.bak', metaFile);
    else fs.rmSync(metaFile, { force: true });              // 没有配对 meta 就别留新 meta 误导
    return true;
  } catch { return false; }
}

/**
 * 备份当前登录态到槽位。返回 {copied, layout, warnings, failed, failedCore, incomplete}。
 *
 * 容错分级：core 档任一文件拷贝失败即致命（身份不完整），中止并清理现场；
 * browser/appdata 档失败只记 warning（Qoder 运行中 cookies/leveldb 被独占属正常，
 * 身份靠 auth.v1.dat 而非 cookies，缺这些不影响切号后能登录）。
 *
 * 稳妥起见仍建议关闭 Qoder 后保存（--kill）；运行中保存会自动降级并如实告警。
 */
export function backupSnapshot(id, detectedUid = null, dataDir = getDataDir()) {
  ensureDirs();
  if (!fs.existsSync(dataDir)) throw new Error(`数据目录不存在: ${dataDir}`);
  const layout = detectLayout(dataDir);
  if (!layout) throw new Error(`数据目录布局无法识别: ${dataDir}`);
  const cfg = loadConfig();
  const whitelist = snapshotWhitelist(layout, cfg);
  const required = snapshotRequired(layout);
  // core 档 = 致命集合（v1 布局整体视为致命，沿用旧的全有或全无语义）
  const critical = new Set(layout === 'v1' ? whitelist : SNAPSHOT_V2.core);

  const slotDir = snapSlotDir(id);
  const metaFile = snapMetaFile(id);
  const bakDir = slotDir + '.bak';
  // 未登录预检放在轮转之前：失败时不把上一代好快照挤出主槽
  for (const must of required) {
    if (!fs.existsSync(path.join(dataDir, must))) {
      throw new Error(`当前数据目录缺 ${must}（从未登录/启动过？）`);
    }
  }

  const hadSlot = fs.existsSync(slotDir);
  rotateBak(slotDir, metaFile);
  fs.mkdirSync(slotDir, { recursive: true });

  const errors = [];
  const incomplete = new Set();   // 白名单项粒度：哪些条目这次没拷全（恢复时降级用）
  let copied = 0;
  let snapView = null;
  try {
    for (const rel of whitelist) {
      const src = path.join(dataDir, rel);
      if (!fs.existsSync(src)) {
        if (rel.includes('/') && fs.existsSync(path.dirname(src))) incomplete.add(rel);
        continue;
      }
      const before = errors.length;
      copied += copyTreeTolerant(src, path.join(slotDir, rel), rel, errors);
      const newlyFailed = errors.slice(before);
      if (newlyFailed.length) incomplete.add(rel);   // 部分失败也要记，否则恢复时整目录替换会删实时数据
      if (newlyFailed.length && critical.has(rel)) {
        throw new Error(`核心文件 ${rel} 拷贝失败（${newlyFailed[0].error}）——`
          + '请关闭 Qoder 后重试（save ' + id + ' --kill）');
      }
    }
    // 拷贝后二次校验：凭证文件与 Local State 必须都在（缺一即快照不可解密）
    for (const must of required) {
      if (!fs.existsSync(path.join(slotDir, must))) {
        throw new Error(`快照不完整（缺 ${must}）`);
      }
    }
    // 三次校验：必须真能解密出登录态，否则这份快照等于废的
    snapView = scanLogin(slotDir);
  } catch (e) {
    // 清理现场：删掉半成品槽位，把上一代快照（含 meta）还原回主槽位。
    // 这里的判据是「轮转前主槽位存在」= 这次确实把上一代挪进了 .bak，必须还回去；
    // 旧代码写成 !hadSlot && hadBak，条件反了，结果是：对已存在的槽位重新 save 一旦失败，
    // 主槽位被删、上一代留在 .bak 里，而 .bak 被 listSnapshots 过滤 —— 账号在列表和
    // 控制台里直接消失，用户看到的是「我的槽位没了」。
    fs.rmSync(metaFile, { force: true });
    const rolledBack = hadSlot ? restoreFromBak(id) : false;
    if (!hadSlot) fs.rmSync(slotDir, { recursive: true, force: true });
    throw new Error(`${e?.message || e}（已清理未完成快照${rolledBack ? '，上一代快照已还原' : '，无上一代快照'}）`);
  }

  const coreFiles = layout === 'v1' ? [] : SNAPSHOT_V2.core;
  const failedCore = errors.filter((x) => coreFiles.some((c) => x.path === c || x.path.startsWith(c + '/')));
  const running = qoderRunning();
  // 令牌缓存随快照一并刷新。不做这步，用户「重新登录该账号 + 重新 save」之后，
  // creds/<id>.json 里仍是上一个已被服务端轮换作废的 refreshToken，签到会误报
  // permanent_auth，让人以为账号死了。缓存只是副本，快照才是真源。
  // 先写缓存、后写 meta：这样 meta.savedAtMs 总不早于缓存的 updatedAt，
  // 「缓存比快照新」这个展示位与签到取新者的判据才都是真话。
  let credsSaved = false;
  try {
    saveCreds(id, credsFromLogin(snapView || scanLogin(slotDir)));
    credsSaved = true;
  } catch { /* 缓存写不进不影响快照本身，签到仍能回落到直接解快照 */ }
  fs.writeFileSync(metaFile, JSON.stringify({
    slot: id, layout, dataDir, savedAtMs: nowMs(), detectedUid, copied,
    warnings: errors,
    incomplete: [...incomplete],
    savedWhileRunning: running,
  }, null, 2));
  return {
    copied,
    layout,
    failed: errors,
    warnings: errors,
    failedCore,
    incomplete: [...incomplete],
    credsSaved,
    savedWhileRunning: running,
  };
}

/**
 * 同卷换名（a ↔ b，容忍其中一侧不存在 = 退化成一个 move）。
 * 自身即逆运算，再调一次即可还原。全程 rename，不复制，因此不额外占用磁盘、
 * 也不会出现「两个目录内容都只有一半」的中间态（rename 是原子操作）。
 */
function swapPath(a, b) {
  const t = a + '.qam-swap-tmp';
  fs.rmSync(t, { recursive: true, force: true });
  const aEx = fs.existsSync(a), bEx = fs.existsSync(b);
  if (!aEx && !bEx) return false;
  if (aEx) fs.renameSync(a, t);
  if (bEx) fs.renameSync(b, a);
  if (aEx) fs.renameSync(t, b);
  fs.rmSync(t, { recursive: true, force: true });
  return true;
}

/**
 * 回退到槽位的上一代快照（主槽位 ↔ .bak 互换，meta 一起换）。
 * 只动 ~/.qoder-account-manager/snapshots 下的内容，不碰实时数据目录，
 * 因此 Qoder 运行中也能安全执行。回退后校验新主槽位可解密，解不开就换回去。
 */
export function rollbackSnapshot(id) {
  const slotDir = snapSlotDir(id);
  const bakDir = slotDir + '.bak';
  const metaFile = snapMetaFile(id);
  if (!fs.existsSync(bakDir)) throw new Error(`槽位 ${id} 没有上一代备份（缺 ${bakDir}）`);
  swapPath(slotDir, bakDir);
  swapPath(metaFile, metaFile + '.bak');
  try {
    const v = scanLogin(slotDir);
    try { saveCreds(id, credsFromLogin(v)); } catch { /* 缓存非关键 */ }
    return {
      uid: v.uid, layout: detectLayout(slotDir),
      savedAtMs: readSnapMeta(id)?.savedAtMs ?? null,
    };
  } catch (e) {
    swapPath(slotDir, bakDir);              // 换回去，保持原状
    swapPath(metaFile, metaFile + '.bak');
    throw new Error(`上一代快照不可用（${e?.message || e}），已还原原状`);
  }
}

/**
 * 恢复槽位快照到数据目录。要求 Qoder 已关闭。返回 {restored, layout}。
 * 会校验槽位布局与目标目录布局一致——v1 快照恢复进 v2 目录必然失败，
 * 这种情况直接报清楚原因，不做半吊子恢复。
 */
export function restoreSnapshot(id, dataDir = getDataDir()) {
  const slotDir = snapSlotDir(id);
  if (!fs.existsSync(slotDir)) {
    if (fs.existsSync(slotDir + '.bak')) {
      throw new Error(`槽位 ${id} 主快照缺失，但存在上一代备份 ${id}.bak ——`
        + `请执行 rollback ${id} 把它换回来（控制台槽位卡片上的「回退到上一代」按钮同理）`);
    }
    throw new Error(`槽位 ${id} 不存在`);
  }
  const meta = readSnapMeta(id);
  const slotLayout = meta?.layout || detectLayout(slotDir);
  const targetLayout = detectLayout(dataDir);
  if (slotLayout && targetLayout && slotLayout !== targetLayout) {
    throw new Error(`布局不兼容：槽位 ${id} 是 ${slotLayout} 快照，当前数据目录是 ${targetLayout}。`
      + '客户端已升级，该槽位无法恢复——请在新客户端登录该账号后重新 save。');
  }
  const layout = slotLayout || targetLayout;
  if (!layout) throw new Error(`无法确定槽位 ${id} 的布局，拒绝恢复`);
  const whitelist = snapshotWhitelist(layout);
  for (const must of snapshotRequired(layout)) {
    if (!fs.existsSync(path.join(slotDir, must))) {
      throw new Error(`快照 ${id} 不完整（缺 ${must}），拒绝恢复`);
    }
  }
  // v1 专属：删主库残留 wal/shm（强杀残留会被启动回放，污染恢复结果）
  if (layout === 'v1') {
    const vscdb = path.join(dataDir, 'User', 'globalStorage', 'state.vscdb');
    for (const ext of ['-wal', '-shm']) fs.rmSync(vscdb + ext, { force: true });
  }
  let restored = 0;
  const skipped = [];
  // 保存时没拷全的白名单条目 → 恢复时对这些目录只做【合并】，不做整目录替换。
  // 否则会把实时数据删掉又没有备份可补（实测：运行中 save 时 Network/Cookies 被
  // Chromium 独占而缺失，若整目录替换会清空浏览器 cookie）。
  // meta.incomplete 是白名单项粒度，正是这里需要的口径。旧 meta 没有该字段时，
  // 只能从 warnings 的文件路径反推 —— 注意 warnings 形如
  // "Local Storage/leveldb/000012.ldb"，取首段得到 "Local Storage"，与白名单项
  // "Local Storage/leveldb" 永不相等，旧实现就是这么漏判的（嵌套目录因此被整目录
  // 替换）。这里改成双向前缀匹配，两种写法都能命中。
  const incomplete = new Set(Array.isArray(meta?.incomplete) ? meta.incomplete : []);
  if (!Array.isArray(meta?.incomplete)) {
    for (const w of (meta?.warnings || [])) {
      const p = String(w?.path || '');
      const first = p.split('/')[0];
      for (const rel of whitelist) {
        if (p === rel || p.startsWith(rel + '/') || rel === first || rel.startsWith(first + '/')) {
          incomplete.add(rel);
        }
      }
    }
  }

  // 排序：身份凭证文件 auth.v1.dat 【最先】落地。
  // 理由：所有槽位都取自同一个实时目录，实测 Local State 字节完全相同（共用同一把
  // os_crypt 钥），machine-id / overlays 只是设备与装饰信息 —— 所以账号切换实质等价于
  // "原子替换 auth.v1.dat 一个文件"，各文件之间没有先后依赖。
  // 把它放第一位 + 用同卷 rename 原子落地，意味着即便本进程在后续步骤被中断
  // （本进程可能处于 Qoder 的 Job Object 内，实测 IsProcessInJob=True，Qoder 退出时
  // 存在被连带回收的可能），结果也只会是"账号已切换成功"，而不是"IDE 关了但没切过来"。
  // 两种中断点都不存在半交换的损坏状态。
  const ordered = [...whitelist].sort((a, b) => {
    const ka = a === 'auth.v1.dat' ? 0 : 1, kb = b === 'auth.v1.dat' ? 0 : 1;
    return ka - kb;
  });

  for (const rel of ordered) {
    if (SNAPSHOT_NEVER.some((n) => rel === n || rel.startsWith(n + '/'))) continue;
    const src = path.join(slotDir, rel);
    const dst = path.join(dataDir, rel);
    if (!fs.existsSync(src)) continue;

    if (rel === 'auth.v1.dat') {
      // 原子落地：先写临时文件再同卷 rename（Windows 上同卷 rename 是原子的）
      const st = fs.statSync(src);
      try {
        if (fs.existsSync(dst) && fs.statSync(dst).size === st.size
          && fs.readFileSync(dst).equals(fs.readFileSync(src))) {
          skipped.push(rel); continue; // 已是目标账号，无需写
        }
      } catch { /* 比对失败则照常写 */ }
      const tmp = dst + '.qam-switch-tmp';
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dst);
      restored++;
      continue;
    }

    if (fs.statSync(src).isDirectory()) {
      // 目录类默认整目录替换（而非合并）：否则上个账号残留的 cookie/leveldb 会混进来。
      // 但视图状态类目录在默认档位下根本不进白名单，走到这里说明用户显式开了 browser 档。
      // 两个前提：该目录这次保存时是完整的（不在 incomplete 里），且快照里确实有内容
      //（空目录当备份用不得，删掉实时数据再复制个空的进去等于净丢失）。
      let slotHasContent = false;
      try { slotHasContent = fs.readdirSync(src).length > 0; } catch { slotHasContent = false; }
      if (fs.existsSync(dst) && !incomplete.has(rel) && slotHasContent) {
        fs.rmSync(dst, { recursive: true, force: true });
      }
    } else if (fs.existsSync(dst)) {
      // 小文件字节相同则跳过，减少无谓写入（Local State 实测恒定不变）
      try {
        const a = fs.statSync(src), b = fs.statSync(dst);
        if (a.size === b.size && a.size <= 4 * 1024 * 1024
          && fs.readFileSync(src).equals(fs.readFileSync(dst))) {
          skipped.push(rel); continue;
        }
      } catch { /* 比对失败则照常写 */ }
    }
    // 类型不一致（快照里是目录、实时目录里是文件，或反之）时 copyFileSync/cpSync 会抛，
    // 而抛在这里意味着 auth.v1.dat 已经换了、后面的文件没换 —— 与其半途崩掉，
    // 不如跳过该项并如实记进 skipped，让切换至少完成身份交换。
    // 触发条件只可能是数据目录被第三方改过形状（例如 auth.machine-id 变成了目录）。
    try {
      if (fs.existsSync(dst)) {
        const srcIsDir = fs.statSync(src).isDirectory();
        if (fs.statSync(dst).isDirectory() !== srcIsDir) {
          skipped.push(`${rel}(类型不一致，已跳过)`);
          continue;
        }
      }
    } catch { /* 读不到就按原样试一次拷贝 */ }
    if (copyItem(src, dst)) restored++;
  }
  if (restored <= 0 && !skipped.length) throw new Error('快照为空或损坏（0 项恢复）');
  return { restored, layout, merged: [...incomplete], skipped };
}

// ── 进程管理 ──────────────────────────────────────────────────────────────
export function qoderRunning() {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${QODER_PROC_NAME}`, '/NH'],
    { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').includes(QODER_PROC_NAME);
}

function ps(cmd, timeout = 20000) {
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', cmd],
    { encoding: 'utf8', windowsHide: true, timeout }).trim();
}

/** 运行中进程的 exe 全路径（最权威：一定与当前实际版本一致） */
function exeFromRunningProcess() {
  try {
    const out = ps(`(Get-Process -Name 'Qoder CN' -ErrorAction SilentlyContinue `
      + '| Where-Object { $_.Path } | Select-Object -First 1).Path');
    if (out && fs.existsSync(out)) return out;
  } catch { /* ignore */ }
  return null;
}

const cmpVer = (a, b) => {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

/**
 * 扫描 .qoder-versions 取最新版 exe。
 * 旧实现把 exe 路径写死进 registry，客户端 0.4.2→0.4.3 升级后即失效，
 * 故改为动态解析：根目录由 registry.exePath 反推 + 常见安装位置。
 */
function exeFromVersionScan(reg) {
  const roots = new Set();
  const fromReg = reg?.exePath;
  if (fromReg) {
    // ...\Qoder CN\.qoder-versions\0.4.3\Qoder CN.exe → ...\Qoder CN
    const vdir = path.dirname(fromReg);
    roots.add(path.basename(vdir) === '.qoder-versions' ? path.dirname(vdir) : vdir);
  }
  const bases = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs'),
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ];
  for (const base of bases) {
    if (!base || !fs.existsSync(base)) continue;
    for (const name of ['Qoder CN', 'Qoder', 'qoder-cn']) {
      const p = path.join(base, name);
      if (fs.existsSync(p)) roots.add(p);
    }
  }
  let best = null;
  for (const root of roots) {
    const vroot = path.join(root, '.qoder-versions');
    if (!fs.existsSync(vroot)) {
      // 非多版本布局：直接找根目录下的 exe
      try {
        for (const f of fs.readdirSync(root)) {
          if (/^Qoder.*\.exe$/i.test(f)) {
            const p = path.join(root, f);
            if (!best) best = { exe: p, ver: '0' };
          }
        }
      } catch { /* ignore */ }
      continue;
    }
    try {
      for (const v of fs.readdirSync(vroot)) {
        const exe = path.join(vroot, v, 'Qoder CN.exe');
        if (!fs.existsSync(exe)) continue;
        if (!best || cmpVer(v, best.ver) > 0) best = { exe, ver: v };
      }
    } catch { /* ignore */ }
  }
  return best?.exe || null;
}

/** exe 解析优先级：环境变量 > config > 运行中进程 > 版本扫描 > registry（可能已过期） */
export function findQoderExe(reg = loadRegistry()) {
  if (process.env.QODER_EXE && fs.existsSync(process.env.QODER_EXE)) return process.env.QODER_EXE;
  const cfg = loadConfig();
  if (cfg.exePath && fs.existsSync(cfg.exePath)) return cfg.exePath;
  const live = exeFromRunningProcess();
  if (live) return live;
  const scanned = exeFromVersionScan(reg);
  if (scanned) return scanned;
  if (reg?.exePath && fs.existsSync(reg.exePath)) return reg.exePath;
  return null;
}

/**
 * 关 Qoder：先温和 taskkill，等待 8s，仍在则强杀。返回是否成功关闭。
 *
 * ⚠ 绝不能用 /T。/T 会连「匹配进程的整棵子进程树」一起杀，而本插件的
 *   switch.mjs / server.mjs 都是 node.exe，是 Qoder 的后代进程（实测
 *   IsProcessInJob=True，同在一个 Job Object 内）。用 /T 会在交换文件的过程中
 *   把自己杀掉，留下半完成的数据目录。
 *   去掉 /T 依然够用：/IM 按映像名匹配，13 个进程全都叫 "Qoder CN.exe"，
 *   而 node.exe 名字不匹配，故不受影响。
 */
export function killQoder() {
  if (!qoderRunning()) return true;
  spawnSync('taskkill', ['/IM', QODER_PROC_NAME], { windowsHide: true });
  for (let i = 0; i < 16; i++) {
    spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500'],
      { windowsHide: true });
    if (!qoderRunning()) return true;
  }
  // 仍未退出（比有模态对话框阻塞）：按名强杀，依旧不带 /T
  spawnSync('taskkill', ['/IM', QODER_PROC_NAME, '/F'], { windowsHide: true });
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2'],
    { windowsHide: true });
  return !qoderRunning();
}

/**
 * 重启 Qoder。
 * cfg.launchArgs 是给「用自定义 --user-data-dir 启动」的用户留的口子：切换写的是
 * 探测到的那个数据目录，若你平时靠命令行参数指定另一个目录，直接重启会让客户端读
 * 回它自己的默认目录，看起来就像「切换没生效」。把需要的参数写进 config.launchArgs
 * 即可保持启动方式与探测结果一致。
 */
export function startQoder(exePath, cfg = loadConfig()) {
  if (!exePath || !fs.existsSync(exePath)) {
    throw new Error('找不到 Qoder 可执行文件路径（config.exePath / QODER_EXE 环境变量可修复）');
  }
  const args = (Array.isArray(cfg.launchArgs) ? cfg.launchArgs : []).filter((x) => typeof x === 'string');
  const child = spawn(exePath, args, { detached: true, stdio: 'ignore', cwd: path.dirname(exePath) });
  child.unref();
  return args;
}

// ── HTTP / 签到 API ───────────────────────────────────────────────────────
export function apiHeaders(creds) {
  return {
    'Authorization': `Bearer ${creds.access_token || creds.token}`,
    'Cosy-ClientType': COSY_CLIENT_TYPE,
    'User-Agent': CLIENT_UA,
    'Content-Type': 'application/json',
  };
}

async function httpJson(url, { method = 'GET', headers = {}, body = null, emptyBody = false } = {}) {
  const opts = { method, headers: { ...headers } };
  if (emptyBody) {
    // R-4 抓包实测：claim 请求 Content-Length: 0，非 JSON {}
    opts.body = null;
    delete opts.headers['Content-Type'];
    opts.headers['Content-Length'] = '0';
  } else if (body !== null) {
    opts.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, opts);
    const raw = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
    return { status: res.status, body: parsed, raw };
  } catch (e) {
    return { status: 0, body: null, raw: String(e?.message || e) };
  }
}

export function normalizeExpiresIn(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  // 量级判别：>=30 天秒数视为毫秒（设备端点回 2591999994 ms）
  return n >= 2_592_000 ? n : n * 1000;
}

/**
 * 无签名刷新端点：jrt- → jobToken/refresh，其余（drt- / drt--）→ deviceToken/refresh。
 * 成功返回新 creds 形状；失败返回 {error, kind: transient|auth_dead}。
 */
export async function refreshCreds(creds) {
  const rt = creds.refresh_token || creds.refreshToken;
  if (!rt) return { error: '无刷新令牌', kind: 'auth_dead' };
  const endpoint = rt.startsWith('jrt-') ? '/api/v1/jobToken/refresh' : '/api/v1/deviceToken/refresh';
  const headers = apiHeaders(creds);
  delete headers['Authorization'];
  const { status, body } = await httpJson(OPEN_API_BASE + endpoint,
    { method: 'POST', headers, body: { refresh_token: rt } });
  if (status === 0) return { error: '网络不可达', kind: 'transient' };
  if (status !== 200) {
    const kind = (status === 429 || status === 408 || status >= 500) ? 'transient' : 'auth_dead';
    return { error: `刷新失败 HTTP ${status}`, kind };
  }
  const acc = dig(body, ['accessToken', 'access_token', 'token']);
  if (!acc) return { error: '刷新响应无 accessToken', kind: 'transient' };
  const now = nowMs();
  const out = {
    uid: creds.uid || '',
    name: creds.name || '',
    access_token: String(acc),
    refresh_token: String(dig(body, ['refreshToken', 'refresh_token']) || rt),
    expires_at_ms: (() => {
      const e = dig(body, ['expiresIn', 'expires_in']);
      const n = e !== undefined ? normalizeExpiresIn(e) : null;
      return n ? now + n : now + 12 * 3_600_000; // 缺 expiresIn 落保守 12h
    })(),
  };
  const rExpires = dig(body, ['refresh_token_expires_in', 'refreshTokenExpiresIn']);
  if (rExpires !== undefined) {
    const rn = normalizeExpiresIn(rExpires);
    if (rn) out.refresh_expires_at_ms = now + rn;
  }
  return { creds: out };
}

export async function listCampaigns(creds) {
  const { status, body, raw } = await httpJson(
    `${OPEN_API_BASE}/sash/api/v1/me/campaigns`, { headers: apiHeaders(creds) });
  if (status === 401) return { kind: 'auth', message: '登录态失效（401）' };
  if (status === 0) return { kind: 'fail', message: `网络不可达: ${raw.slice(0, 120)}` };
  if (status !== 200 && status !== 201) return { kind: 'fail', message: `campaigns 不可用（HTTP ${status}）` };
  const campaigns = dig(body, ['campaigns']);
  if (!Array.isArray(campaigns) || campaigns.length === 0) {
    return { kind: 'fail', message: 'empty_campaigns：活动列表为空（活动未开始或不可用）' };
  }
  return { kind: 'ok', campaigns };
}

const idSafe = (s) => typeof s === 'string' && s.length > 0 && /^[A-Za-z0-9_-]+$/.test(s);

/** 领取单个活动。claim 幂等：重复调用返回 status=CLAIMED + replayed=true。 */
export async function claimCampaign(creds, campaign) {
  const campaignId = String(dig(campaign, ['campaignId', 'campaign_id']) || '');
  if (!idSafe(campaignId)) return { kind: 'fail', message: `campaignId 非法或缺失（len=${campaignId.length}）` };
  const knownReward = Number(campaign?.benefit?.amount) || null;
  const url = `${OPEN_API_BASE}/sash/api/v1/me/campaigns/${campaignId}/claim`;
  await sleep(jitterMs());
  const { status, body, raw } = await httpJson(url, { method: 'POST', headers: apiHeaders(creds), emptyBody: true });
  if (status === 401) return { kind: 'auth', message: '登录态失效（401）' };
  if (status === 0) {
    // 网络不可达 ≠ 必然失败：claim 可能已到达服务端；复查列表定真话
    const recheck = await recheckClaimed(creds, campaignId);
    if (recheck) return { kind: 'already', message: 'claim 网络异常，复查确认已领取', reward: knownReward };
    return { kind: 'fail', message: '网络不可达（claim）' };
  }
  if (status === 200 || status === 201) {
    const replayed = Boolean(dig(body, ['replayed']));
    const claimedStatus = String(dig(body, ['status']) || '').toUpperCase();
    const bodyReward = Number(body?.benefit?.amount) || null;
    const reward = knownReward ?? bodyReward;
    if (replayed) return { kind: 'already', message: '今日已领取（幂等回放）', reward };
    if (claimedStatus === 'CLAIMED') return { kind: 'success', message: '领取成功', reward };
    // 2xx 但无明确状态：宽容视为成功（claim 幂等，重试无副作用）
    return { kind: 'success', message: body ? '领取成功' : '领取成功（响应体读取失败）', reward };
  }
  const msg = dig(body, ['message', 'msg']) || raw.slice(0, 160);
  return { kind: 'fail', message: `claim 失败（HTTP ${status}）: ${msg}` };
}

/** 盲发后复查：GET campaigns，指定 id 当日已 CLAIMED → true */
export async function recheckClaimed(creds, campaignId) {
  const r = await listCampaigns(creds);
  if (r.kind !== 'ok') return false;
  const now = Math.floor(nowMs() / 1000);
  return r.campaigns.some((c) =>
    String(dig(c, ['campaignId', 'campaign_id']) || '') === campaignId
    && String(dig(c, ['claimStatus', 'claim_status']) || '').toUpperCase() === 'CLAIMED'
    && inWindow(c, now));
}

function inWindow(c, nowSecs) {
  const start = Number(c?.startAt ?? c?.start_at) || 0;
  const end = Number(c?.endAt ?? c?.end_at) || 0;
  if (!start || !end) return false; // 字段缺失视为不命中（从严）
  const s = start >= 1e12 ? start / 1000 : start;
  const e = end >= 1e12 ? end / 1000 : end;
  return s <= nowSecs && nowSecs <= e;
}

export function filterClaimable(campaigns) {
  return campaigns.filter((c) =>
    String(dig(c, ['claimStatus', 'claim_status']) || '').toUpperCase() === 'CLAIMABLE');
}

/** 「每日 Credits」已领判定（从严：CLAIMED + CLAIM_BENEFIT + CREDITS + 当日窗口） */
export function dailyCreditsClaimed(campaigns) {
  const now = Math.floor(nowMs() / 1000);
  return campaigns.some((c) =>
    String(dig(c, ['claimStatus', 'claim_status']) || '').toUpperCase() === 'CLAIMED'
    && String(c?.actionType || '').toUpperCase() === 'CLAIM_BENEFIT'
    && String(c?.benefit?.kind || '').toUpperCase() === 'CREDITS'
    && inWindow(c, now));
}

/** 从列表反学当日每日 Credits 活动 id（硬编码必然过期，列表条目本身照常返回） */
export function learnDailyCampaignIds(campaigns) {
  const now = Math.floor(nowMs() / 1000);
  const out = [];
  for (const c of campaigns) {
    if (String(c?.actionType || '').toUpperCase() !== 'CLAIM_BENEFIT') continue;
    if (String(c?.benefit?.kind || '').toUpperCase() !== 'CREDITS') continue;
    if (!inWindow(c, now)) continue;
    const id = String(dig(c, ['campaignId', 'campaign_id']) || '');
    if (!idSafe(id)) continue;
    const name = String(c?.name || c?.title || c?.campaignName || c?.campaign_name || id.slice(0, 8));
    if (!out.some((x) => x[0] === id)) out.push([id, name]);
  }
  return out;
}

// ── 签到日志 ──────────────────────────────────────────────────────────────
export function appendSigninLog(entries) {
  ensureDirs();
  let log = [];
  if (fs.existsSync(SIGNIN_LOG_FILE)) {
    try { log = JSON.parse(fs.readFileSync(SIGNIN_LOG_FILE, 'utf8')); } catch { log = []; }
  }
  log.push(...entries);
  if (log.length > 200) log = log.slice(-200); // 滚动保留 200 条
  fs.writeFileSync(SIGNIN_LOG_FILE, JSON.stringify(log, null, 2));
}

export function readSigninLog(limit = 30) {
  if (!fs.existsSync(SIGNIN_LOG_FILE)) return [];
  try {
    const log = JSON.parse(fs.readFileSync(SIGNIN_LOG_FILE, 'utf8'));
    return log.slice(-limit);
  } catch { return []; }
}

// ── 最近打开列表跨账号保留 ────────────────────────────────────────────────
// 仅 v1 需要合并：全局键存在 state.vscdb，而该库在白名单内会被快照覆盖。
// v2 无需处理：最近打开存于 main.sqlite，而 main.sqlite 属禁交换项，切号天然保留。
const KEY_RECENT_PATHS = 'history.recentlyOpenedPathsList';

export function readRecentPaths(dataDir = getDataDir()) {
  if (detectLayout(dataDir) !== 'v1') return null;
  try {
    const raw = readVscdbKey(path.join(dataDir, 'User', 'globalStorage', 'state.vscdb'), KEY_RECENT_PATHS);
    return raw || null;
  } catch { return null; }
}

/** 恢复快照后把切换前的最近打开合并回写（v1 有效；v2 直接返回 null） */
export function mergeRecentPaths(preJson, dataDir = getDataDir()) {
  if (!preJson) return null;
  if (detectLayout(dataDir) !== 'v1') return null;
  const vscdb = path.join(dataDir, 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(vscdb)) return null;
  let pre, cur;
  try { pre = JSON.parse(preJson); } catch { return null; }
  const curRaw = readRecentPaths(dataDir);
  try { cur = curRaw ? JSON.parse(curRaw) : { entries: [] }; } catch { cur = { entries: [] }; }
  if (!Array.isArray(pre?.entries) || !Array.isArray(cur.entries)) return null;
  const keyOf = (e) => e?.folderUri || e?.fileUri || e?.workspace?.configPath || JSON.stringify(e);
  const have = new Set(cur.entries.map(keyOf));
  const added = pre.entries.filter((e) => !have.has(keyOf(e)));
  if (added.length === 0) return null;
  const merged = { ...cur, entries: [...cur.entries, ...added] };
  // 备份后写回（单代 .bak 回滚保护）
  fs.copyFileSync(vscdb, vscdb + '.qam-bak');
  try {
    writeVscdbKey(vscdb, KEY_RECENT_PATHS, JSON.stringify(merged));
    return `最近打开 +${added.length}`;
  } catch (e) {
    fs.copyFileSync(vscdb + '.qam-bak', vscdb); // 失败回滚
    throw e;
  } finally {
    fs.rmSync(vscdb + '.qam-bak', { force: true });
  }
}
