// signin.mjs — Qoder 每日签到 CLI（双活动：签到 + 登录奖励，列表全量自然覆盖）
// 用法:
//   node --no-warnings signin.mjs signin [id...] [--json]   不传 id = 全部已保存账号
//   node --no-warnings signin.mjs history [n] [--json]      查看最近签到记录
// 凭证来源: 当前 IDE 登录态优先；其余账号取「本地凭证缓存 / 槽位快照解密」中更新的
// 那份（缓存可能是已被服务端轮换掉的旧令牌，快照才是客户端的最新状态）。
//
// ══ 令牌轮换安全策略（实测后收紧）══════════════════════════════════════════
// refreshToken 是一次性轮换的。旧实现对「当前活跃账号」也会刷新，导致 IDE 自己
// auth.v1.dat 里存的 refreshToken 立刻作废 —— 等于把正在用的账号踢下线。因此：
//   · 活跃账号（uid == 当前 IDE 登录）：只用不刷。access token 过期就跳过并提示
//     用户打开一次 IDE 让客户端自行续期，绝不在它背后轮换令牌。
//   · 非活跃账号：可刷新；刷新成功后新令牌除写入 creds 缓存外，还回写该槽位快照
//     的 auth.v1.dat，否则日后切过去恢复出来的是已作废的 refreshToken（锁死账号）。
// 红线: token 全程不输出到日志/终端。
import {
  ensureDirs, loadRegistry, saveRegistry, findAccount, listSnapshots,
  snapSlotDir, scanLogin, saveCreds, refreshCreds, listCampaigns,
  claimCampaign, filterClaimable, dailyCreditsClaimed, learnDailyCampaignIds,
  KNOWN_DAILY_CAMPAIGNS, appendSigninLog, readSigninLog, maskUid, todayStr,
  detectLayout, getDataDir, writeAuthV2, obtainAccountCreds,
} from './qoder_lib.mjs';

function emitJson(obj) {
  if (process.argv.includes('--json')) console.log('QAM_JSON:' + JSON.stringify(obj));
}

function credsExpiredSoon(c) {
  return c.expires_at_ms && c.expires_at_ms < Date.now() + 10 * 60 * 1000;
}

// 凭证取用规则（live 优先、缓存与快照比谁新）已上收到 qoder_lib.obtainAccountCreds，
// 与 credits 查询共用一份——credits 也要读非活跃账号的凭证，两处各写一遍迟早漂移。
const obtainCreds = obtainAccountCreds;

/**
 * 把续期后的令牌回写槽位快照的 auth.v1.dat（仅 v2 布局支持）。
 * 失败不致命：creds 缓存已保存，签到本身不受影响；但切回该账号时可能需重新登录，
 * 因此如实告警而不是静默吞掉。
 */
function writebackToSnapshot(id, creds) {
  const slot = snapSlotDir(id);
  if (detectLayout(slot) !== 'v2') return { skipped: 'layout-not-v2' };
  try {
    writeAuthV2(slot, {
      token: creds.access_token,
      refreshToken: creds.refresh_token,
      expiresAtMs: creds.expires_at_ms,
      refreshExpiresAtMs: creds.refresh_expires_at_ms,
    });
    return { ok: true };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

/** 确保令牌可用。活跃账号绝不刷新（见文件头策略说明）。 */
async function ensureFresh(id, creds, isLive) {
  if (!credsExpiredSoon(creds)) return { creds };
  if (isLive) {
    return {
      error: 'access token 已过期，但该账号正被 IDE 使用——为避免轮换掉客户端持有的刷新令牌，'
        + '这里不代它续期。请打开一次 Qoder 让客户端自行刷新，再重新签到。',
      kind: 'live_expired',
    };
  }
  const r = await refreshCreds(creds);
  if (r.creds) {
    // 刷新令牌一次性轮换：新凭证必须立即持久化（缓存 + 快照双写）
    saveCreds(id, r.creds);
    const wb = writebackToSnapshot(id, r.creds);
    return { creds: r.creds, refreshed: true, writeback: wb };
  }
  return { error: r.error, kind: r.kind };
}

async function signinAccount(id, live) {
  const reg = loadRegistry();
  const acct = findAccount(reg, id) || { id, name: '' };
  const label = acct.name || id;
  const ev = {
    date: todayStr(), time: Date.now(), account: id, name: label,
    uid: maskUid(acct.uid || ''),
  };

  const got = obtainCreds(id, live);
  if (got.error) {
    ev.status = 'fail'; ev.message = `无可用凭证（${got.error}）`;
    ev.fail_kind = 'permanent_auth';
    return ev;
  }
  let creds = got.creds;
  ev.source = got.source;
  ev.isLive = got.isLive;

  const fresh = await ensureFresh(id, creds, got.isLive);
  if (fresh.error) {
    ev.status = 'fail';
    ev.message = fresh.kind === 'auth_dead'
      ? `凭证已失效需重新登录（${fresh.error}）——请在 Qoder 登录该账号后重新 save 槽位`
      : fresh.kind === 'live_expired'
        ? fresh.error
        : `凭证刷新失败（${fresh.error}）`;
    ev.fail_kind = fresh.kind === 'auth_dead' ? 'permanent_auth'
      : fresh.kind === 'live_expired' ? 'live_expired' : 'transient';
    return ev;
  }
  creds = fresh.creds;
  if (fresh.refreshed) {
    ev.refreshed = true;
    if (fresh.writeback?.error) ev.writebackWarn = `快照回写失败: ${fresh.writeback.error}`;
    else if (fresh.writeback?.ok) ev.writeback = 'snapshot-updated';
  }

  let r = await listCampaigns(creds);
  if (r.kind === 'auth' && !got.isLive) {
    // 401 自愈：强制刷新一次再重试（活跃账号不刷新，直接报失效）
    const rr = await refreshCreds(creds);
    if (rr.creds) {
      saveCreds(id, rr.creds);
      writebackToSnapshot(id, rr.creds);
      creds = rr.creds;
      r = await listCampaigns(creds);
    }
  }
  if (r.kind !== 'ok') {
    ev.status = 'fail'; ev.message = r.message;
    return ev;
  }

  const campaigns = r.campaigns;
  const learned = learnDailyCampaignIds(campaigns);
  const claimable = filterClaimable(campaigns);
  const details = [];

  if (claimable.length > 0) {
    let ok = 0, already = 0, fail = 0, reward = 0, authDead = false;
    for (const c of claimable) {
      const cid = String(c?.campaignId || c?.campaign_id || '?');
      const cname = String(c?.name || c?.title || cid.slice(0, 8));
      const res = await claimCampaign(creds, c);
      details.push({ id: cid, name: cname, result: res.kind, message: res.message, reward: res.reward ?? null });
      if (res.kind === 'success') { ok++; if (res.reward) reward += res.reward; }
      else if (res.kind === 'already') { already++; if (res.reward) reward += res.reward; }
      else if (res.kind === 'auth') { authDead = true; break; }
      else fail++;
    }
    if (authDead) {
      ev.status = 'fail'; ev.message = '登录态失效（401，刷新后仍失败），请重新登录该账号并 save 槽位';
      ev.fail_kind = 'permanent_auth'; ev.campaigns = details;
      return ev;
    }
    ev.campaigns = details;
    if (ok > 0 && fail === 0) { ev.status = 'success'; ev.message = `领取成功 ${ok} 项${already ? `（另 ${already} 项此前已领）` : ''}`; if (reward) ev.reward = reward; }
    else if (ok === 0 && fail === 0) { ev.status = 'already'; ev.message = '每日奖励已领取'; if (reward) ev.reward = reward; }
    else { ev.status = 'fail'; ev.message = `部分失败（成功 ${ok}/已领 ${already}/失败 ${fail}）`; }
    return ev;
  }

  // 零 CLAIMABLE：① 列表内当日已领 grant 定真话 → already
  if (dailyCreditsClaimed(campaigns)) {
    ev.status = 'already'; ev.message = '每日奖励已领取';
    return ev;
  }
  // ② 盲发兜底：反学 id 优先 + 硬编码表兜底（claim 幂等，无副作用）
  const candidates = [...learned];
  for (const [kid, kname] of KNOWN_DAILY_CAMPAIGNS) {
    if (!candidates.some((x) => x[0] === kid)) candidates.push([kid, kname]);
  }
  let ok = 0, already = 0, fail = 0, reward = 0, authDead = false;
  for (const [cid, cname] of candidates) {
    const res = await claimCampaign(creds, { campaignId: cid, name: cname });
    details.push({ id: cid, name: cname, result: res.kind, message: res.message, reward: res.reward ?? null });
    if (res.kind === 'success') { ok++; if (res.reward) reward += res.reward; }
    else if (res.kind === 'already') { already++; if (res.reward) reward += res.reward; }
    // 401 要单独定性：混进 fail 里会让人以为「活动没开始」，实际是凭证已死、需重新登录
    else if (res.kind === 'auth') { authDead = true; break; }
    else fail++;
  }
  ev.campaigns = details;
  if (authDead && ok === 0 && already === 0) {
    ev.status = 'fail'; ev.message = '登录态失效（401），请重新登录该账号并 save 槽位';
    ev.fail_kind = 'permanent_auth';
    return ev;
  }
  if (ok > 0) { ev.status = 'success'; ev.message = `盲发兜底领取成功 ${ok} 项`; if (reward) ev.reward = reward; }
  else if (already > 0) { ev.status = 'already'; ev.message = '每日奖励已领取（盲发回放确认）'; }
  else { ev.status = 'fail'; ev.message = '无可领取活动且盲发兜底失败（活动未开始或接口变更）'; }
  return ev;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  ensureDirs();

  if (cmd === 'history') {
    const n = parseInt(args[1] || '30', 10);
    const log = readSigninLog(n);
    if (log.length === 0) { console.log('(暂无签到记录)'); emitJson({ ok: true, cmd, log: [] }); return; }
    for (const x of log) {
      const t = new Date(x.time).toLocaleString('zh-CN', { hour12: false });
      console.log(`${t}  [${x.account}] ${x.status}  ${x.message}${x.reward ? `  +${x.reward} credits` : ''}`);
    }
    emitJson({ ok: true, cmd, log });
    return;
  }

  if (cmd !== 'signin') {
    console.error('用法: signin.mjs signin [id...] [--json] | history [n] [--json]');
    process.exit(1);
  }

  let ids = args.slice(1).filter((a) => !a.startsWith('--'));
  const slots = listSnapshots();
  if (ids.length === 0) ids = slots;
  if (ids.length === 0) {
    console.log('没有已保存的账号槽位。请先运行: accounts.mjs save <id>');
    emitJson({ ok: true, cmd, events: [], note: 'no-slots' });
    return;
  }
  const unknown = ids.filter((id) => !slots.includes(id));
  if (unknown.length) {
    console.error(`错误: 槽位不存在: ${unknown.join(', ')}（现有: ${slots.join(', ')}）`);
    emitJson({ ok: false, cmd, error: 'unknown-slots', unknown });
    process.exit(1);
  }

  // 当前 IDE 登录态（可失败：未登录/数据目录异常均不影响快照通道）
  let live = null;
  try { live = scanLogin(getDataDir({ refresh: true })); } catch { /* ignore */ }

  console.log(`开始签到 ${ids.length} 个账号（${todayStr()}）…`);
  if (live) console.log(`当前 IDE 登录 uid=${maskUid(live.uid)}（该账号只用不刷，避免轮换掉客户端持有的刷新令牌）`);
  console.log('');
  const events = [];
  for (const id of ids) {
    process.stdout.write(`[${id}] 签到中…`);
    const ev = await signinAccount(id, live);
    events.push(ev);
    process.stdout.write(`\r[${id}] ${ev.status.toUpperCase().padEnd(7)} ${ev.message}\n`);
    if (ev.campaigns) {
      for (const d of ev.campaigns) {
        console.log(`        · ${d.name}: ${d.result}${d.reward ? ` +${d.reward}` : ''}${d.result === 'fail' ? ` — ${d.message}` : ''}`);
      }
    }
    if (ev.writebackWarn) console.log(`        ⚠ ${ev.writebackWarn}`);
  }

  // 落库：签到日志 + 注册表 lastSignin
  appendSigninLog(events.map(({ campaigns, ...rest }) => rest));
  const reg2 = loadRegistry();
  for (const ev of events) {
    const a = findAccount(reg2, ev.account);
    if (a) { a.lastSigninAt = ev.time; a.lastSigninResult = ev.status; }
  }
  saveRegistry(reg2);

  const ok = events.filter((e) => e.status === 'success').length;
  const already = events.filter((e) => e.status === 'already').length;
  const fail = events.filter((e) => e.status === 'fail').length;
  const totalReward = events.reduce((s, e) => s + (e.reward || 0), 0);
  console.log(`\n完成: 成功 ${ok} / 已领 ${already} / 失败 ${fail}${totalReward ? ` / 本次共 +${totalReward} credits` : ''}`);
  console.log('EVENTS_JSON:' + JSON.stringify(events));
  emitJson({ ok: true, cmd, events, summary: { ok, already, fail, totalReward } });
}

main().catch((e) => {
  console.error(`错误: ${e?.message || e}`);
  emitJson({ ok: false, error: String(e?.message || e) });
  process.exit(1);
});
