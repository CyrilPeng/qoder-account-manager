// switch.mjs — 账号切换 CLI
// 用法:
//   node --no-warnings switch.mjs switch <目标id> [--save-as <id>] [--no-save-current]
//                                        [--no-restart] [--no-kill] [--json]
// 流程: 预检（目标槽位存在 + 布局兼容）→ 探测当前登录 → 关闭 Qoder →
//       备份当前登录态到自己的槽位 → 恢复目标槽位快照 → 重启 Qoder。
//
// 对话历史存于 main.sqlite / chat-session-*.sqlite，属禁交换硬红线，
// 切换账号后原样保留（v1 布局则存于 workspaceStorage，同样不在白名单内）。
//
// ⚠ 本命令会关闭并重启 Qoder IDE。若 agent 自身正运行在该 IDE 内，执行即中断会话，
//   因此只应由用户在本地控制台点击、或在知晓后果的前提下手动触发。
import fs from 'node:fs';
import {
  loadRegistry, saveRegistry, findAccount, listSnapshots, isValidSlotId, snapSlotDir,
  snapMetaFile, readSnapMeta, backupSnapshot, restoreSnapshot, scanLogin,
  qoderRunning, killQoder, startQoder, findQoderExe, readRecentPaths,
  mergeRecentPaths, maskUid, maskEmail, detectLayout, getDataDir, snapshotRequired,
  writeSwitchLock, readSwitchLock, clearSwitchLock, credsFromLogin, saveCreds, loadConfig,
} from './qoder_lib.mjs';
import { identityOf, maskPhone } from './status.mjs';

function emitJson(obj) {
  if (process.argv.includes('--json')) console.log('QAM_JSON:' + JSON.stringify(obj));
}

function fail(stage, msg, extra = {}) {
  console.error('错误: ' + msg);
  emitJson({ ok: false, stage, error: msg, ...extra });
  process.exit(1);
}

/**
 * 切换互斥锁。同一时刻只允许一个切换在跑：两个进程同时交换同一个数据目录是未定义行为
 * （A 刚把 auth.v1.dat 换成账号 X，B 又换成 Y，结果不可预期）。
 *
 * 控制台点「切换到此账号」时，服务端先写一把 source:'server' 的占位锁再拉起本子进程，
 * 这里直接接管；用户手敲 CLI 时自己写锁。若锁被另一个活着的 cli 进程持有则拒绝启动，
 * --force 可强行覆盖（明知上一个已经卡死）。
 */
function acquireSwitch(target, force) {
  const cur = readSwitchLock();
  if (cur && cur.source !== 'server' && cur.pid !== process.pid) {
    if (!force) {
      fail('lock', `已有切换在进行中（目标 ${cur.target || '?'}，已 ${Math.round(cur.ageMs / 1000)}s，`
        + `pid=${cur.pid ?? '?'}）。确认它已经卡死可加 --force 覆盖。`, { lockedBy: cur });
    }
    // --force：覆盖别人留下的锁。只有明确知道上一个切换进程已经卡死时才该用；
    // 覆盖后如实打印，方便出问题时回溯是谁把锁顶掉的。
    console.log(`提示: --force 顶掉了原有切换锁（目标 ${cur.target || '?'}，pid=${cur.pid ?? '?'}，`
      + `已 ${Math.round(cur.ageMs / 1000)}s）`);
  }
  writeSwitchLock({ pid: process.pid, target, source: 'cli', startedAt: Date.now() });
  // 退出时清锁。进程若被 Qoder 的 Job Object 连带回收，这里不会执行，所以
  // readSwitchLock 另有 pid 存活检查 + 15 分钟超时两道陈旧判定兜底。
  process.on('exit', () => { try { clearSwitchLock(); } catch { /* ignore */ } });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'switch' || !args[1]) {
    console.error('用法: switch.mjs switch <目标id> [--save-as <id>] [--no-save-current] '
      + '[--no-restart] [--no-kill] [--force] [--json]');
    process.exit(1);
  }
  const target = args[1];
  const saveAsIdx = args.indexOf('--save-as');
  const saveAs = saveAsIdx >= 0 ? args[saveAsIdx + 1] : null;
  const noSaveCurrent = args.includes('--no-save-current');
  const noRestart = args.includes('--no-restart');
  const noKill = args.includes('--no-kill');
  const force = args.includes('--force');

  // id 会被拼成快照目录路径参与文件覆盖，绝不能带 / .. 之类
  if (!isValidSlotId(target)) {
    fail('preflight', `目标槽位 id 非法（字母/数字/_/-，1~64 字符）: ${JSON.stringify(String(target).slice(0, 64))}`);
  }
  if (saveAs != null && !isValidSlotId(saveAs)) {
    fail('preflight', `--save-as 的槽位 id 非法: ${JSON.stringify(String(saveAs).slice(0, 64))}`);
  }

  const dataDir = getDataDir({ refresh: true });
  const curLayout = detectLayout(dataDir);

  // ── 0) 预检：全部在关闭 Qoder 之前完成，避免"关了 IDE 才发现切不了" ──
  if (!fs.existsSync(snapSlotDir(target))) {
    const msg = `目标槽位 "${target}" 不存在。现有槽位: ${listSnapshots().join(', ') || '(空)'}`;
    console.error('错误: ' + msg);
    emitJson({ ok: false, stage: 'preflight', error: msg });
    process.exit(1);
  }
  const meta = readSnapMeta(target);
  const slotLayout = meta?.layout || detectLayout(snapSlotDir(target));
  if (slotLayout && curLayout && slotLayout !== curLayout) {
    const msg = `布局不兼容：槽位 "${target}" 是 ${slotLayout} 快照，当前客户端数据目录是 ${curLayout}。`
      + '客户端已升级，该槽位无法恢复——请在新客户端登录该账号后重新 save。';
    console.error('错误: ' + msg);
    emitJson({ ok: false, stage: 'preflight', error: msg, slotLayout, curLayout });
    process.exit(1);
  }
  for (const must of snapshotRequired(slotLayout || curLayout)) {
    if (!fs.existsSync(`${snapSlotDir(target)}/${must}`)) {
      const msg = `快照 "${target}" 不完整（缺 ${must}），拒绝切换`;
      console.error('错误: ' + msg);
      emitJson({ ok: false, stage: 'preflight', error: msg });
      process.exit(1);
    }
  }

  // 预检阶段就把目标槽位身份解出来：既用于展示，也用于「已经就是这个账号」的判定。
  // 解不开的快照一律拒绝 —— 恢复过去只会得到一个未登录的 IDE，还白关一次。
  let targetSnap = null;
  try {
    targetSnap = scanLogin(snapSlotDir(target));
  } catch (e) {
    fail('preflight', `目标槽位 "${target}" 的快照解不开（${e?.message || e}）——拒绝切换。`
      + '请重新登录该账号后 save 更新快照。');
  }
  const targetUid = targetSnap.uid;
  const targetLabel = identityOf(targetSnap);

  acquireSwitch(target, force);

  const reg = loadRegistry();
  const targetAcct = findAccount(reg, target);

  // ── 1) 探测当前登录 ──
  let live = null, liveErr = null;
  try { live = scanLogin(dataDir); } catch (e) { liveErr = String(e.message || e); }
  // 判据用快照解出的 uid，不信 registry：注册表缺项或 uid 过期时，旧实现会明明已经
  // 登录了目标账号还去关一次 IDE 再"切"回来。
  if (live && live.uid === targetUid) {
    clearSwitchLock();
    console.log(`当前已登录目标账号（${identityOf(live)}  uid=${maskUid(live.uid)}），无需切换。`);
    emitJson({ ok: true, noop: true, target, uid: maskUid(live.uid), label: identityOf(live) });
    return;
  }
  console.log(`当前登录: ${live ? `${identityOf(live)}  uid=${maskUid(live.uid)}` : `无法识别（${liveErr}）`}`);
  console.log(`切换目标: [${target}] ${targetLabel}`
    + `${targetAcct?.name ? `  备注「${targetAcct.name}」` : ''}`
    + `  uid=${maskUid(targetUid)}`);

  // ── 2) 关闭 Qoder（运行中才有数据竞争；温和→强杀两级）──
  const wasRunning = qoderRunning();
  if (wasRunning) {
    if (noKill) {
      const msg = 'Qoder 正在运行且指定了 --no-kill，为避免数据损坏已中止。请关闭 Qoder 后重试。';
      console.error('错误: ' + msg);
      emitJson({ ok: false, stage: 'kill', error: msg });
      process.exit(1);
    }
    console.log('正在关闭 Qoder…');
    if (!killQoder()) {
      console.error('错误: 关闭 Qoder 失败，已中止');
      emitJson({ ok: false, stage: 'kill', error: '关闭 Qoder 失败' });
      process.exit(1);
    }
  }

  // ── 3) 备份当前登录态（防丢号：任何情况下先备份再覆盖）──
  let savedTo = null;
  if (!noSaveCurrent) {
    let slot = saveAs;
    if (!slot && live) {
      const match = reg.accounts.find((a) => a.uid === live.uid);
      slot = match ? match.id : `auto-${live.uid.slice(0, 8)}`;
    }
    if (!slot && !live) {
      console.log(`提示: 无法识别当前登录账号（${liveErr || '未登录'}），跳过备份当前登录态`);
    }
    if (slot) {
      if (slot === target) {
        console.log(`提示: 当前登录态槽位与目标相同（${target}），跳过备份以免覆盖目标快照`);
      } else {
        try {
          const r = backupSnapshot(slot, live?.uid || null, dataDir);
          savedTo = slot;
          console.log(`已备份当前登录态 → 槽位 "${slot}"（${r.copied} 项）`);
          // 注册表只存脱敏身份作降级缓存（权威来源是快照，status 直接解快照）
          const idCache = live ? {
            nickname: live.name || '',
            emailMasked: maskEmail(live.email),
            phoneMasked: maskPhone(live.phone),
          } : { nickname: '', emailMasked: '', phoneMasked: '' };
          if (!findAccount(reg, slot)) {
            reg.accounts.push({
              id: slot, name: '', uid: live?.uid || '', ...idCache,
              layout: r.layout, savedAt: Date.now(),
            });
          } else {
            const a = findAccount(reg, slot);
            a.savedAt = Date.now();
            a.layout = r.layout;
            if (live?.uid) a.uid = live.uid;
            Object.assign(a, idCache);
            delete a.name2; delete a.email; delete a.phone;
          }
        } catch (e) {
          console.error(`错误: 备份当前登录态失败——${e.message || e}；已中止（未动目标快照）`);
          emitJson({ ok: false, stage: 'backup', error: String(e.message || e) });
          process.exit(1);
        }
      }
    }
  }

  // ── 4) 抽出切换前的「最近打开」全局键（仅 v1 需要合并；v2 天然保留）──
  const recentJson = readRecentPaths(dataDir);

  // ── 5) 恢复目标快照 ──
  let restored;
  try {
    restored = restoreSnapshot(target, dataDir);
  } catch (e) {
    console.error(`错误: 恢复快照失败——${e.message || e}`);
    if (savedTo) console.error(`提示: 切换前登录态已保存在槽位 "${savedTo}"，可用它回退`);
    emitJson({ ok: false, stage: 'restore', error: String(e.message || e), savedTo });
    process.exit(1);
  }
  console.log(`已恢复槽位 "${target}"（${restored.restored} 项，布局 ${restored.layout}）`
    + (restored.skipped?.length ? `，字节相同跳过 ${restored.skipped.length} 项` : '')
    + (restored.merged?.length ? `，降级合并（不整目录替换）: ${restored.merged.join(' / ')}` : ''));

  // ── 6) 合并最近打开列表（仅 v1；失败不阻断）──
  try {
    const summary = mergeRecentPaths(recentJson, dataDir);
    if (summary) console.log(`已保留${summary}`);
  } catch (e) {
    console.log(`警告: 最近打开列表合并失败（不影响切换）: ${e.message || e}`);
  }

  // ── 7) 回读验证：切换到底有没有真的落地 ──
  // 只统计"文件拷过去了几个"不足以说明切换成功，必须把写回去的登录态再解一遍，
  // 确认解出来的 uid 就是目标账号。不一致时如实报错并停止重启，别让用户打开一个
  // "以为切过去了、其实没切"的 IDE。
  let verified = null, verifyError = null;
  try {
    const now = scanLogin(dataDir);
    verified = { uid: now.uid, label: identityOf(now), matches: now.uid === targetUid };
    if (!verified.matches) {
      console.error(`错误: 切换后回读到的登录身份是 ${verified.label}（uid=${maskUid(now.uid)}），`
        + `与目标 ${targetLabel}（uid=${maskUid(targetUid)}）不一致。已中止，不重启 Qoder。`);
      emitJson({ ok: false, stage: 'verify', error: 'identity-mismatch', target, uid: maskUid(now.uid) });
      process.exit(1);
    }
    console.log(`回读验证: ✓ 实时目录登录态 = ${verified.label}（uid=${maskUid(verified.uid)}），与目标一致`);
    // 该账号现在是在用账号：把令牌同步进缓存，将来它变为非活跃时签到才拿得到最新令牌
    try { saveCreds(target, credsFromLogin(now)); } catch { /* 缓存非关键 */ }
  } catch (e) {
    verifyError = String(e?.message || e);
    console.error(`警告: 切换后无法回读登录态（${verifyError}）——不阻断重启，`
      + '但请在 IDE 里自行核对账号身份。');
  }

  // ── 8) 更新目标账号元数据时间戳 ──
  const metaF = snapMetaFile(target);
  try {
    const m = JSON.parse(fs.readFileSync(metaF, 'utf8'));
    m.restoredAtMs = Date.now();
    fs.writeFileSync(metaF, JSON.stringify(m, null, 2));
  } catch { /* meta 缺失不阻断 */ }
  saveRegistry(reg);

  // ── 9) 重启 Qoder ──
  let started = null, launchArgs = [];
  if (!noRestart) {
    const exe = findQoderExe(reg);
    if (exe) {
      if (reg.exePath !== exe) { reg.exePath = exe; saveRegistry(reg); }
      launchArgs = startQoder(exe, loadConfig());
      started = exe;
      console.log(`已启动 Qoder: ${exe}${launchArgs.length ? ` ${launchArgs.join(' ')}` : ''}`);
    } else {
      console.log('警告: 未找到 Qoder 可执行文件，请手动启动（设置 config.exePath 或 QODER_EXE 环境变量可修复）');
    }
  }

  clearSwitchLock();
  console.log(`\n切换完成 → "${target}"  ${targetLabel}`
    + `${targetAcct?.name ? `（备注「${targetAcct.name}」）` : ''}`);
  console.log('对话历史不受影响（存于 main.sqlite，属禁交换项，不在切换范围内）。'
    + '要确认的话：切换前后各跑一次 accounts.mjs sessions，会话总数应保持不变。');
  emitJson({
    ok: true, target, savedTo,
    restored: restored.restored, layout: restored.layout,
    wasRunning, started, launchArgs,
    label: targetLabel, uid: maskUid(targetUid),
    verified: verified ? { label: verified.label, uid: maskUid(verified.uid), matches: verified.matches } : null,
    verifyError,
  });
}

main().catch((e) => {
  console.error(`错误: ${e?.message || e}`);
  try { clearSwitchLock(); } catch { /* ignore */ }
  emitJson({ ok: false, error: String(e?.message || e) });
  process.exit(1);
});
