// status.mjs — 汇总账号/环境状态，供 CLI 与本地控制台共用
// 唯一数据出口：CLI 打印它，HTTP 服务序列化它，避免两处逻辑漂移。
// 红线：本模块只产出脱敏字段（maskUid/maskEmail/maskPhone），token 绝不出现在返回值里；
//       sessionVisibility() 只读 main.sqlite 的计数与元信息，绝不读取对话正文。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  describeInstall, getDataDir, detectLayout, scanLogin, listSnapshots,
  readSnapMeta, findAccount, loadRegistry, loadCreds, readSigninLog,
  todayStr, maskUid, maskEmail, findQoderExe, loadConfig, snapshotWhitelist,
  snapshotRequired, SNAPSHOT_NEVER, MGR_DIR, snapSlotDir, hasSnapBak,
  readSwitchLock,
} from './qoder_lib.mjs';

/** 手机号脱敏：138****8000 */
export function maskPhone(phone) {
  const s = String(phone || '');
  if (!s) return '';
  if (s.length < 7) return '***';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/** 账号可读标识：昵称 + 脱敏邮箱/手机，全缺则回落脱敏 uid */
export function identityOf(a) {
  const bits = [];
  if (a.name) bits.push(a.name);
  const em = maskEmail(a.email);
  if (em) bits.push(em);
  const ph = maskPhone(a.phone);
  if (ph) bits.push(ph);
  return bits.length ? bits.join(' · ') : maskUid(a.uid);
}

function fmtMs(ms) {
  return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : null;
}

/**
 * 汇总当前状态。数据目录一律重新探测（describeInstall 内部完成），
 * 避免缓存到客户端升级前的旧目录。
 */
export function collectStatus() {
  const install = describeInstall();
  // describeInstall 内部已经 refresh 过一次并写入缓存，这里直接复用它的结果。
  // 旧写法又调了一次 getDataDir({refresh:true})，等于每 20s 的 UI 刷新多跑一趟
  // PowerShell 进程查询（实测 200~400ms），纯浪费。
  const dataDir = install.dataDir;
  const layout = detectLayout(dataDir);
  const reg = loadRegistry();
  const cfg = loadConfig();
  const today = todayStr();
  const log = readSigninLog(200);
  const switching = readSwitchLock();

  // 当前登录（可失败：未登录 / 数据目录异常都不应让整个状态查询崩掉）
  let live = null;
  let liveError = null;
  try {
    const v = scanLogin(dataDir);
    live = {
      uid: v.uid, uidMasked: maskUid(v.uid), name: v.name,
      emailMasked: maskEmail(v.email), phoneMasked: maskPhone(v.phone),
      label: identityOf(v),
      tokenExpiresAtMs: v.expiresAtMs, tokenExpiresAt: fmtMs(v.expiresAtMs),
      refreshExpiresAtMs: v.refreshExpiresAtMs, refreshExpiresAt: fmtMs(v.refreshExpiresAtMs),
      layout: v.layout,
    };
  } catch (e) {
    liveError = String(e?.message || e);
  }

  const accounts = listSnapshots().map((id) => {
    const a = findAccount(reg, id) || {};
    const meta = readSnapMeta(id);
    const creds = loadCreds(id);
    // 老版本插件写的 meta 没有 layout 字段，回落到按快照目录内容实测，
    // 否则升级遗留的 v1 槽位会被误判为"兼容"，切换时才炸
    const slotLayout = meta?.layout || detectLayout(snapSlotDir(id)) || null;
    const todayLog = log.filter((x) => x.date === today && x.account === id).pop() || null;

    // 槽位布局与当前数据目录不一致 → 客户端升级导致的历史遗留槽位，不可恢复
    const incompatible = Boolean(slotLayout && layout && slotLayout !== layout);

    // 身份直接从该槽位快照解出（权威来源，重新 save 后自动跟着变），
    // 解不开才回落到注册表里缓存的脱敏字段。
    let snap = null, snapError = null;
    try { snap = scanLogin(snapSlotDir(id)); } catch (e) { snapError = String(e?.message || e); }
    const nickname = snap?.name || a.nickname || '';
    const emailMasked = snap ? maskEmail(snap.email) : (a.emailMasked || '');
    const phoneMasked = snap ? maskPhone(snap.phone) : (a.phoneMasked || '');
    const identity = [nickname, emailMasked, phoneMasked].filter(Boolean).join(' · ')
      || maskUid(snap?.uid || a.uid || meta?.detectedUid);

    // 上一代备份（覆盖式保存留下的）。只在真存在时才读 meta / 解身份，
    // 免得每个槽位每次刷新都多跑一趟 DPAPI。
    const bak = hasSnapBak(id);
    let bakInfo = null;
    if (bak) {
      const bakMeta = (() => {
        try {
          const f = path.join(path.dirname(snapSlotDir(id)), `${id}.meta.json.bak`);
          return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
        } catch { return null; }
      })();
      let bakSnap = null;
      try { bakSnap = scanLogin(snapSlotDir(id) + '.bak'); } catch { /* 解不出就不显示身份 */ }
      const bits = [bakSnap?.name, maskEmail(bakSnap?.email), maskPhone(bakSnap?.phone)].filter(Boolean);
      bakInfo = {
        savedAtMs: bakMeta?.savedAtMs || null,
        savedAt: fmtMs(bakMeta?.savedAtMs || null),
        layout: bakMeta?.layout || null,
        identity: bits.join(' · ') || (bakSnap ? maskUid(bakSnap.uid) : ''),
        readable: Boolean(bakSnap),
      };
    }

    return {
      id,
      // 备注名保持"要么有要么空"，不要塞占位符——各处显示都以 a.name 是否有值来分支
      name: a.name || '',
      // 真实身份（脱敏）：优先取自快照本身
      identity,
      nickname,
      emailMasked,
      phoneMasked,
      snapshotReadable: Boolean(snap),
      snapshotError: snapError,
      uid: snap?.uid || a.uid || meta?.detectedUid || '',
      uidMasked: maskUid(snap?.uid || a.uid || meta?.detectedUid || ''),
      savedAtMs: meta?.savedAtMs || a.savedAt || null,
      savedAt: fmtMs(meta?.savedAtMs || a.savedAt || null),
      layout: slotLayout,
      incompatible,
      isLive: Boolean(live && ((snap?.uid && snap.uid === live.uid)
        || (a.uid && a.uid === live.uid) || meta?.detectedUid === live.uid)),
      copied: meta?.copied ?? null,
      // 保存时未拷全的条目（恢复时对这些目录降级为合并）
      incomplete: Array.isArray(meta?.incomplete) ? meta.incomplete
        : (meta?.warnings || []).map((w) => String(w.path).split('/')[0]),
      savedWhileRunning: meta?.savedWhileRunning ?? null,
      hasBak: bak,
      bak: bakInfo,
      creds: creds ? {
        hasRefresh: Boolean(creds.refresh_token),
        expiresAtMs: creds.expires_at_ms || null,
        expiresAt: fmtMs(creds.expires_at_ms || null),
        updatedAt: fmtMs(creds.updatedAt || null),
        newerThanSnapshot: Boolean(creds.updatedAt && meta?.savedAtMs && creds.updatedAt > meta.savedAtMs),
      } : null,
      todaySignin: todayLog ? { status: todayLog.status, message: todayLog.message, reward: todayLog.reward ?? null } : null,
      lastSigninAt: a.lastSigninAt ? fmtMs(a.lastSigninAt) : null,
      lastSigninResult: a.lastSigninResult || null,
    };
  });

  return {
    now: Date.now(),
    today,
    install: {
      ...install,
      exePath: findQoderExe(reg),
      mgrDir: MGR_DIR,
      registryExePath: reg.exePath || null,
    },
    live,
    liveError,
    accounts,
    // 切换进行中：控制台的写操作按钮全部置灰，服务端也会拒绝（409）。
    // 两个进程同时交换同一个数据目录 = 未定义行为。
    switching,
    config: { tiers: cfg.tiers, dataDirOverride: cfg.dataDir, exeOverride: cfg.exePath, launchArgs: cfg.launchArgs },
    whitelist: snapshotWhitelist(layout, cfg),
    required: snapshotRequired(layout),
    neverSwap: SNAPSHOT_NEVER.length,
    signinLog: log.slice(-30).reverse(),
  };
}

/** 人读文本渲染（CLI status 用） */
export function renderStatusText(s) {
  const out = [];
  out.push('════ 环境 ════');
  out.push(`数据目录: ${s.install.dataDir}`);
  out.push(`布局:     ${s.install.layoutLabel}`);
  out.push(`Qoder:    ${s.install.running ? '运行中' : '未运行'}    exe: ${s.install.exePath || '(未解析)'}`);
  out.push(`管理目录: ${s.install.mgrDir}`);
  if (s.switching) {
    out.push(`⚠ 切换进行中：目标槽位 ${s.switching.target}，已 ${Math.round(s.switching.ageMs / 1000)}s。`
      + '期间请勿再执行 save/signin/remove/rollback（服务端会以 409 拒绝）。');
  }
  if (s.config?.launchArgs?.length) {
    out.push(`启动参数: ${s.config.launchArgs.join(' ')}（来自 config.launchArgs）`);
  }
  if (!s.install.layout) {
    out.push('⚠ 布局未识别，无法读写登录态。候选目录:');
    for (const c of s.install.candidates) out.push(`    ${c.exists ? '✓' : '✗'} ${c.path}  布局=${c.layout || '-'}`);
  }

  out.push('\n════ 当前登录 ════');
  if (s.live) {
    out.push(`账号:       ${s.live.label}`);
    out.push(`uid:        ${s.live.uidMasked}`);
    out.push(`token 过期: ${s.live.tokenExpiresAt || '-'}`);
    out.push(`refresh 过期: ${s.live.refreshExpiresAt || '-'}`);
  } else {
    out.push(`无法读取（${s.liveError || '未登录'}）`);
  }

  out.push(`\n════ 账号槽位 (${s.accounts.length}) ════`);
  if (s.accounts.length === 0) {
    out.push('(空) —— 在 Qoder 里登录账号后执行 save <id>，或直接在控制台点「保存当前账号」');
  }
  for (const a of s.accounts) {
    out.push(`\n[${a.id}]${a.isLive ? '  ← 当前登录' : ''}  ${a.identity}`);
    if (a.name && a.name !== '(未命名)') out.push(`  备注:       ${a.name}`);
    out.push(`  uid:        ${a.uidMasked}`);
    if (!a.snapshotReadable) out.push(`  身份来源:   ⚠ 快照解不开（${a.snapshotError || '未知'}），以下为注册表缓存值`);
    out.push(`  布局:       ${a.layout || '-'}${a.incompatible ? '  ⚠ 与当前客户端不兼容（升级遗留，需重新保存）' : ''}`);
    out.push(`  快照保存于: ${a.savedAt || '-'}${a.savedWhileRunning ? '（保存时 Qoder 在运行）' : ''}`);
    if (a.incomplete?.length) {
      out.push(`  未拷全条目: ${a.incomplete.join(', ')}（恢复时对这些目录只做合并，不整目录替换）`);
    }
    if (a.hasBak) {
      out.push(`  上一代备份: 存在${a.bak?.identity ? ` → ${a.bak.identity}` : ''}`
        + `${a.bak?.savedAt ? `  保存于=${a.bak.savedAt}` : ''}`
        + `${a.bak && a.bak.readable ? '' : '  ⚠（解不开，可能不可回退）'}`
        + `；回退: accounts.mjs rollback ${a.id} --yes`);
    }
    out.push(`  凭证缓存:   ${a.creds
      ? `token过期=${a.creds.expiresAt || '-'}，刷新令牌=${a.creds.hasRefresh ? '有' : '无'}，更新于=${a.creds.updatedAt || '-'}`
      : '(无，首次签到时自动从快照解密)'}`);
    out.push(`  今日签到:   ${a.todaySignin ? `${a.todaySignin.status} — ${a.todaySignin.message}` : '(今日未签)'}`);
    if (a.lastSigninAt && !a.todaySignin) out.push(`  最近签到:   ${a.lastSigninAt} ${a.lastSigninResult || ''}`);
  }

  out.push('\n════ 快照策略 ════');
  out.push(`交换项 (${s.whitelist.length}): ${s.whitelist.join(', ')}`);
  out.push(`必需项: ${s.required.join(', ')}    禁交换项(对话历史/缓存): ${s.neverSwap} 条硬红线`);
  return out.join('\n');
}

// ── 会话可见性诊断 ────────────────────────────────────────────────────────
/**
 * 只读 main.sqlite，统计本地会话与工作区。用途：切换账号前后各跑一次，
 * 用数字判断"对话到底还在不在"——
 *   · 切换前后计数不变 → 数据层完好，若 UI 里看不到就是视图层过滤，可精准定位
 *   · 计数变了 → 交换范围误伤了会话数据，需检查档位配置
 *
 * 实测依据（Qoder CN 0.4.3）：chat_sessions 无任何账号列，会话列表 SQL 为
 * `SELECT session_id, updated_at FROM chat_sessions`（无 WHERE），其余查询只按
 * workspace_id / session_id / archived / deleted_at 过滤；workspaces 也无账号列，
 * workspace_id 是随机 UUIDv4（非账号派生），按 root_paths 匹配文件夹。
 * 因此本地库层面不存在按账号隔离会话的机制。
 *
 * 红线：只取计数、标题长度、时间戳与工作区名/路径，绝不读取 payload_json 等对话正文。
 */
export function sessionVisibility(dataDir = getDataDir()) {
  const dbPath = path.join(dataDir, 'main.sqlite');
  const out = { available: false, dbPath, reason: null, workspaces: [], totals: null, accountScoped: null, sessionColumns: 0 };
  if (!fs.existsSync(dbPath)) {
    out.reason = '未找到 main.sqlite（该布局下对话可能存在别处）';
    return out;
  }
  let db;
  try {
    // 只读打开：IDE 正在用这个库，绝不能加写锁
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
  } catch (e) {
    out.reason = `打开 main.sqlite 失败: ${e?.message || e}`;
    return out;
  }
  try {
    const has = (t) => {
      try {
        return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t) ? true : false;
      } catch { return false; }
    };
    if (!has('chat_sessions')) { out.reason = '库中无 chat_sessions 表（客户端版本差异）'; return out; }
    out.available = true;

    // 会话表是否存在任何账号语义列 —— 直接证明"是否按账号分域"
    try {
      const cols = db.prepare('PRAGMA table_info(chat_sessions)').all().map((c) => c.name);
      out.accountScoped = cols.filter((c) => /account|(^|_)uid|user_id|owner_id|tenant|principal/i.test(c));
      out.sessionColumns = cols.length;
    } catch { out.accountScoped = null; }

    const total = db.prepare(
      'SELECT COUNT(*) AS n FROM chat_sessions WHERE deleted_at IS NULL'
    ).get().n;
    const msgs = has('chat_session_messages')
      ? db.prepare('SELECT COUNT(*) AS n FROM chat_session_messages').get().n : null;
    const archived = db.prepare(
      'SELECT COUNT(*) AS n FROM chat_sessions WHERE deleted_at IS NULL AND archived = 1'
    ).get().n;
    const span = db.prepare(
      'SELECT MIN(created_at) AS a, MAX(created_at) AS b FROM chat_sessions WHERE deleted_at IS NULL'
    ).get();
    out.totals = {
      sessions: total, archived, messages: msgs,
      firstAt: span.a ? new Date(Number(span.a)).toLocaleString('zh-CN', { hour12: false }) : null,
      lastAt: span.b ? new Date(Number(span.b)).toLocaleString('zh-CN', { hour12: false }) : null,
    };

    // 按工作区聚合：切号后若 UI 空了，用这张表能看出是哪个工作区的会话没显示
    if (has('workspaces')) {
      const ws = db.prepare(`
        SELECT w.workspace_id, w.name, w.root_paths_json, w.product_mode, w.archived, w.deleted_at,
               (SELECT COUNT(*) FROM chat_sessions c
                 WHERE c.workspace_id = w.workspace_id AND c.deleted_at IS NULL) AS sessions,
               (SELECT MAX(c.updated_at) FROM chat_sessions c
                 WHERE c.workspace_id = w.workspace_id AND c.deleted_at IS NULL) AS last_activity
        FROM workspaces w ORDER BY sessions DESC, w.updated_at DESC
      `).all();
      out.workspaces = ws.map((w) => {
        let roots = [];
        try { roots = JSON.parse(w.root_paths_json || '[]'); } catch { roots = []; }
        return {
          workspaceId: w.workspace_id,
          name: w.name || '(未命名)',
          roots: Array.isArray(roots) ? roots.slice(0, 3) : [],
          productMode: w.product_mode,
          sessions: w.sessions,
          archived: !!w.archived,
          deleted: w.deleted_at !== null && w.deleted_at !== undefined,
          lastActivity: w.last_activity ? new Date(Number(w.last_activity)).toLocaleString('zh-CN', { hour12: false }) : null,
        };
      });
    }
    return out;
  } catch (e) {
    out.reason = `查询失败: ${e?.message || e}`;
    return out;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 会话可见性的文本渲染（CLI 用） */
export function renderSessionsText(v) {
  const out = [];
  out.push('════ 会话可见性诊断（只读 main.sqlite，不读对话正文）════');
  if (!v.available) {
    out.push(`不可用：${v.reason}`);
    return out.join('\n');
  }
  out.push(`库文件: ${v.dbPath}`);
  out.push(`会话总数(未删除): ${v.totals.sessions}  其中已归档 ${v.totals.archived}  消息条数 ${v.totals.messages ?? '-'}`);
  out.push(`时间跨度: ${v.totals.firstAt || '-'} ~ ${v.totals.lastAt || '-'}`);
  const scoped = v.accountScoped;
  out.push(`\nchat_sessions 共 ${v.sessionColumns} 列，其中账号语义列: `
    + (Array.isArray(scoped) ? (scoped.length ? scoped.join(', ') + ' ← 存在账号分域' : '无 ← 会话不按账号隔离') : '未知'));
  if (v.workspaces.length) {
    out.push(`\n按工作区 (${v.workspaces.length}):`);
    for (const w of v.workspaces) {
      out.push(`  ${w.sessions > 0 ? '·' : '○'} ${w.name}  会话=${w.sessions}`
        + `${w.archived ? ' [已归档]' : ''}${w.deleted ? ' [已删除]' : ''}`
        + `  最近=${w.lastActivity || '-'}`);
      if (w.roots.length) out.push(`      ${w.roots.join(' | ')}`);
    }
  }
  out.push('\n用法：切换账号前后各跑一次本诊断。计数不变 = 数据层完好；'
    + '若此时 UI 里看不到会话，说明过滤发生在视图层（渲染状态/作用域投影），而非数据被删。');
  return out.join('\n');
}
