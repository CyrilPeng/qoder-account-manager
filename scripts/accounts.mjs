// accounts.mjs — 账号槽位管理 CLI
// 用法:
//   node --no-warnings accounts.mjs list   [--json]
//   node --no-warnings accounts.mjs save <id> [--name <名称>] [--kill] [--json]
//   node --no-warnings accounts.mjs status [--json]
//   node --no-warnings accounts.mjs remove <id> --yes [--json]
//   node --no-warnings accounts.mjs rename <id> --name <n> [--json]   只改注册表备注名
//   node --no-warnings accounts.mjs rollback <id> --yes [--json]  把上一代 .bak 换回主槽位
//   node --no-warnings accounts.mjs doctor [--json]    环境自检（数据目录/布局/exe）
//   node --no-warnings accounts.mjs sessions [--json]  会话可见性诊断（切号前后对比用）
//
// --json 会额外输出一行 QAM_JSON:<json>，供本地控制台服务可靠解析（不靠猜 stdout）。
// 红线: token 全程不输出；sessions 只读计数与元信息，不读对话正文。
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDirs, loadRegistry, saveRegistry, findAccount, listSnapshots, isValidSlotId,
  snapSlotDir, snapMetaFile, snapMetaBakFile, backupSnapshot, rollbackSnapshot,
  scanLogin, qoderRunning, killQoder, findQoderExe, maskUid, todayStr, detectLayout,
  getDataDir, maskEmail, MGR_DIR,
} from './qoder_lib.mjs';
import { collectStatus, renderStatusText, identityOf, maskPhone, sessionVisibility, renderSessionsText } from './status.mjs';

function usage() {
  console.log(`用法:
  accounts.mjs list   [--json]            列出账号槽位与当前登录态
  accounts.mjs save <id> [--name <n>] [--kill] [--json]
                                          把当前登录态保存到槽位 <id>（--kill 先关闭 Qoder）
  accounts.mjs status [--json]            账号/凭证/签到/快照策略详细状态
  accounts.mjs remove <id> --yes [--json] 删除槽位（含快照、上一代备份与凭证缓存）
  accounts.mjs rename <id> --name <n> [--json]
                                          只改注册表里的备注名（不碰快照与凭证）
  accounts.mjs rollback <id> --yes [--json]
                                          用上一代 .bak 回退槽位（覆盖保存后想找回旧快照时用）
  accounts.mjs doctor [--json]            环境自检
  accounts.mjs sessions [--json]          会话可见性诊断（切换账号前后各跑一次对比）`);
}

/** 槽位 id 是唯一会拼进删除/覆盖路径的用户输入，入口处一律校验 */
function requireId(id, cmd) {
  if (!isValidSlotId(id)) {
    console.error(`错误: 槽位 id 非法（字母/数字/_/-，1~64 字符）: ${JSON.stringify(String(id ?? '').slice(0, 64))}`);
    if (cmd) emitJson({ ok: false, cmd, error: 'invalid-slot-id' });
    process.exit(1);
  }
  return id;
}

function emitJson(obj) {
  if (process.argv.includes('--json')) console.log('QAM_JSON:' + JSON.stringify(obj));
}

function fmtTime(ms) {
  if (!ms) return '-';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  ensureDirs();

  // ── list / status：统一走 collectStatus，CLI 与本地控制台共用同一数据出口 ──
  if (cmd === 'list' || cmd === 'status') {
    const s = collectStatus();
    if (cmd === 'list') {
      console.log(`数据目录: ${s.install.dataDir}`);
      console.log(`布局:     ${s.install.layoutLabel}`);
      console.log(`Qoder:    ${s.install.running ? '运行中' : '未运行'}`);
      console.log(`当前登录: ${s.live ? `${s.live.label}  uid=${s.live.uidMasked}` : `无法读取（${s.liveError}）`}`);
      if (s.live?.tokenExpiresAt) console.log(`token 过期: ${s.live.tokenExpiresAt}`);
      if (s.accounts.length === 0) {
        console.log('\n账号槽位: (空) —— 先用 save <id> 保存当前登录态');
      } else {
        console.log(`\n账号槽位 (${s.accounts.length}):`);
        for (const a of s.accounts) {
          console.log(`  - ${a.id}${a.isLive ? '  ← 当前登录' : ''}`
            + `  ${a.identity || a.uidMasked}`
            + `${a.name ? `  备注「${a.name}」` : ''}`
            + `  保存于=${a.savedAt || '-'}`
            + `${a.hasBak ? '  （有上一代备份，可 rollback）' : ''}`
            + (a.incompatible ? '  ⚠布局不兼容' : ''));
        }
      }
    } else {
      console.log(renderStatusText(s));
    }
    emitJson({ ok: true, cmd, status: s });
    return;
  }

  // ── doctor：环境自检，专治"读到的账号不是我正在用的"这类问题 ──
  if (cmd === 'doctor') {
    const s = collectStatus();
    console.log('════ Qoder 多账号管理 · 环境自检 ════\n');
    console.log(`生效数据目录: ${s.install.dataDir}`);
    console.log(`识别布局:     ${s.install.layout || '未识别'}  (${s.install.layoutLabel})`);
    console.log(`Qoder 进程:   ${s.install.running ? '运行中' : '未运行'}`);
    console.log(`解析 exe:     ${s.install.exePath || '(未解析)'}`);
    console.log(`registry.exePath（可能已过期，仅作兜底）: ${s.install.registryExePath || '(空)'}`);
    console.log('\n候选数据目录:');
    for (const c of s.install.candidates) {
      console.log(`  ${c.active ? '▶' : ' '} ${c.exists ? '✓存在' : '✗缺失'}  布局=${c.layout || '-'}  ${c.path}`);
    }
    console.log('\n当前登录态:');
    if (s.live) {
      console.log(`  ✓ ${s.live.label}  uid=${s.live.uidMasked}`);
      console.log(`    token 过期 ${s.live.tokenExpiresAt || '-'}，refresh 过期 ${s.live.refreshExpiresAt || '-'}`);
    } else {
      console.log(`  ✗ 读取失败：${s.liveError}`);
    }
    const bad = s.accounts.filter((a) => a.incompatible);
    console.log(`\n槽位: ${s.accounts.length} 个，其中布局不兼容 ${bad.length} 个`);
    for (const a of bad) {
      console.log(`  ⚠ [${a.id}] 是 ${a.layout} 快照，当前客户端是 ${s.install.layout} —— 无法恢复，需重新登录该账号后 save`);
    }
    console.log(`\n快照交换项 (${s.whitelist.length}): ${s.whitelist.join(', ')}`);
    console.log(`禁交换硬红线: ${s.neverSwap} 条（含 main.sqlite 对话历史）`);
    emitJson({ ok: true, cmd, status: s });
    return;
  }

  // ── sessions：会话可见性诊断（回答"切号后对话还在不在"）──
  if (cmd === 'sessions') {
    const v = sessionVisibility();
    console.log(renderSessionsText(v));
    emitJson({ ok: true, cmd, sessions: v });
    return;
  }

  // ── save ──
  if (cmd === 'save') {
    const id = requireId(args[1], cmd);
    const nameIdx = args.indexOf('--name');
    const name = nameIdx >= 0 ? args[nameIdx + 1] : null;
    // --name 的值若以 '-' 开头会被后面的 args.includes('--kill') 之类当成开关
    // （例：--name --kill 会意外关掉 Qoder），所以直接挡在入口。
    if (name !== null && name.startsWith('-')) {
      console.error('错误: --name 的值不能以 - 开头（会被当成命令行开关）');
      emitJson({ ok: false, cmd, error: 'name-starts-with-dash' });
      process.exit(1);
    }
    if (nameIdx >= 0 && name === undefined) {
      console.error('错误: --name 后面缺少值'); process.exit(1);
    }
    const wantKill = args.includes('--kill');
    if (qoderRunning()) {
      if (wantKill) {
        console.log('Qoder 运行中，按 --kill 先关闭…');
        if (!killQoder()) { console.error('错误: 关闭 Qoder 失败'); process.exit(1); }
      } else {
        console.log('提示: Qoder 正在运行，将直接保存（关闭后保存最稳妥；如需自动关闭加 --kill）');
      }
    }
    const dataDir = getDataDir({ refresh: true });
    const layout = detectLayout(dataDir);
    if (!layout) {
      console.error(`错误: 数据目录布局无法识别: ${dataDir}`);
      console.error('请确认 Qoder 已安装并至少登录过一次。');
      process.exit(1);
    }
    // 探测当前登录 uid（写注册表 + 槽位 sidecar，防 A 登录态存进 B 槽）
    let login = null;
    try {
      login = scanLogin(dataDir);
    } catch (e) {
      console.error(`错误: 读取当前登录态失败——${e.message || e}`);
      console.error('请先在 Qoder 里登录账号再保存。');
      emitJson({ ok: false, cmd, error: String(e.message || e) });
      process.exit(1);
    }
    // backupSnapshot 内部已完成：core 缺失致命中止、半成品槽位清理、上一代 .bak（含
    // meta）还原、「快照能否解密」校验、凭证缓存刷新。这里不再重复解一次密——
    // 每次多余的解密都要多跑一趟 DPAPI，实测约 200ms。
    const r = backupSnapshot(id, login.uid, dataDir);
    const { copied, layout: usedLayout } = r;
    const reg = loadRegistry();
    // 记录 exe 路径（仅作兜底；findQoderExe 优先用运行中进程/版本扫描）
    const exe = findQoderExe(reg);
    if (exe) reg.exePath = exe;
    const existing = findAccount(reg, id);
    // 注册表只存【脱敏】身份作降级缓存——权威来源是快照本身（status 会直接解快照），
    // 存明文邮箱/手机既没必要又扩大泄露面（accounts.json 是普通 JSON，无加密）。
    const idCache = {
      nickname: login.name || '',
      emailMasked: maskEmail(login.email),
      phoneMasked: maskPhone(login.phone),
    };
    if (existing) {
      existing.uid = login.uid;
      Object.assign(existing, idCache);
      existing.savedAt = Date.now();
      existing.layout = usedLayout;
      if (name) existing.name = name;
      // 清掉旧版写进来的明文字段
      delete existing.name2; delete existing.email; delete existing.phone;
      if (!existing.name) existing.name = '';
    } else {
      reg.accounts.push({
        id, name: name || '', uid: login.uid,
        ...idCache, layout: usedLayout, savedAt: Date.now(),
      });
    }
    saveRegistry(reg);
    console.log(`已保存当前登录态到槽位 "${id}"（${copied} 项，布局 ${usedLayout}）`);
    console.log(`  账号: ${identityOf(login)}  uid=${maskUid(login.uid)}`);
    if (!findAccount(reg, id)?.name) console.log('  提示: 未设备注名。控制台会直接显示上面的真实身份，备注名是可选项。');
    console.log(`  token 过期: ${fmtTime(login.expiresAtMs)}`);
    console.log(`  凭证缓存: ${r.credsSaved
      ? '已同步为快照里的最新令牌（该账号变为非活跃后签到不会误用已轮换掉的旧令牌）'
      : '⚠ 未能写入缓存（签到时会回落到直接解快照）'}`);
    // 如实报告降级：哪些文件因被占用没进快照，以及这是否影响可用性
    if (r.warnings?.length) {
      console.log(`  ⚠ ${r.warnings.length} 项未进快照（Qoder 运行中被独占）:`);
      for (const w of r.warnings) console.log(`      · ${w.path}`);
      const coreHit = r.failedCore?.length;
      console.log(coreHit
        ? '    ✗ 涉及身份核心文件，该槽位可能不可用——请关闭 Qoder 后重新 save'
        : '    身份核心文件完整，切号后仍可正常登录；仅浏览器 cookie 未纳入（恢复时对该目录降级为合并，不会删除实时 cookie）。如需完整快照请关闭 Qoder 后重新 save。');
    }
    if (r.incomplete?.length) console.log(`  降级条目（恢复时只合并不整目录替换）: ${r.incomplete.join(', ')}`);
    emitJson({
      ok: true, cmd, id, copied, layout: usedLayout,
      uid: maskUid(login.uid), label: identityOf(login),
      warnings: r.warnings || [], failedCore: r.failedCore || [],
      incomplete: r.incomplete || [], credsSaved: r.credsSaved,
      savedWhileRunning: r.savedWhileRunning,
    });
    return;
  }

  // ── rollback：用上一代 .bak 换回主槽位（覆盖保存后找回旧快照）──
  if (cmd === 'rollback') {
    const id = requireId(args[1], cmd);
    if (!args.includes('--yes')) {
      console.error(`用法: accounts.mjs rollback ${id} --yes（会把当前主快照与上一代互换，可再次执行还原）`);
      process.exit(1);
    }
    const bakDir = snapSlotDir(id) + '.bak';
    if (!fs.existsSync(bakDir)) {
      console.error(`错误: 槽位 ${id} 没有上一代备份`);
      emitJson({ ok: false, cmd, id, error: 'no-backup' });
      process.exit(1);
    }
    // 回退前先把当前主快照身份取成【脱敏字符串】，避免后面还持有明文对象
    let beforeLabel = null;
    try { beforeLabel = identityOf(scanLogin(snapSlotDir(id))); } catch { /* 主快照本来就可能解不开 */ }
    const after = rollbackSnapshot(id);
    // 回退后重新解一次（同样只输出脱敏身份）
    let afterLabel = null;
    try { afterLabel = identityOf(scanLogin(snapSlotDir(id))); } catch { afterLabel = maskUid(after.uid); }
    console.log(`已回退槽位 "${id}" 到上一代快照`);
    console.log(`  现在槽位内: ${afterLabel}  uid=${maskUid(after.uid)}  布局=${after.layout || '-'}  保存于=${after.savedAtMs ? fmtTime(after.savedAtMs) : '-'}`);
    if (beforeLabel) console.log(`  原主快照（${beforeLabel}）已挪到 ${id}.bak，再执行一次本命令即可换回去`);
    emitJson({ ok: true, cmd, id, uid: maskUid(after.uid), label: afterLabel, layout: after.layout });
    return;
  }

  // ── remove ──
  if (cmd === 'remove') {
    const id = args[1];
    if (!args.includes('--yes')) {
      console.error('用法: accounts.mjs remove <id> --yes'); process.exit(1);
    }
    requireId(id, cmd);
    const slot = snapSlotDir(id);
    const hadSlot = fs.existsSync(slot);
    const removed = [];
    if (hadSlot) { fs.rmSync(slot, { recursive: true, force: true }); removed.push('snapshot'); }
    if (fs.existsSync(slot + '.bak')) { fs.rmSync(slot + '.bak', { recursive: true, force: true }); removed.push('snapshot.bak'); }
    if (fs.existsSync(snapMetaFile(id))) { fs.rmSync(snapMetaFile(id), { force: true }); removed.push('meta'); }
    if (fs.existsSync(snapMetaBakFile(id))) { fs.rmSync(snapMetaBakFile(id), { force: true }); removed.push('meta.bak'); }
    const cf = path.join(MGR_DIR, 'creds', `${id}.json`);
    if (fs.existsSync(cf)) { fs.rmSync(cf, { force: true }); removed.push('creds'); }
    // 旧版轮换逻辑留下的凭证备份，一并清掉，别在磁盘上留第二份令牌副本
    if (fs.existsSync(cf + '.bak')) { fs.rmSync(cf + '.bak', { force: true }); removed.push('creds.bak'); }
    const reg = loadRegistry();
    const before = reg.accounts.length;
    reg.accounts = reg.accounts.filter((x) => x.id !== id);
    if (reg.accounts.length !== before) removed.push('registry');
    saveRegistry(reg);
    if (!hadSlot && removed.length === 0) {
      console.error(`槽位 ${id} 不存在`);
      emitJson({ ok: false, cmd, id, error: '槽位不存在' });
      process.exit(1);
    }
    console.log(`已删除槽位 ${id}（${removed.join('、') || '无残留'}）`);
    emitJson({ ok: true, cmd, id, removed });
    return;
  }

  // ── rename：只改注册表里的备注名，不碰快照与凭证 ──
  // 与控制台 /api/rename 等价（同样 80 字上限），此前只有 UI 能改名，CLI 侧缺一个入口
  // 就只能手改 accounts.json，而手改会和"读-改-写"的其它动作撞车。
  if (cmd === 'rename') {
    const id = requireId(args[1], cmd);
    const nameIdx = args.indexOf('--name');
    const name = nameIdx >= 0 ? String(args[nameIdx + 1] ?? '').trim() : '';
    if (nameIdx < 0) {
      console.error(`用法: accounts.mjs rename ${id} --name <新名称>`);
      emitJson({ ok: false, cmd, id, error: 'missing-name' });
      process.exit(1);
    }
    if (name.startsWith('-')) {
      console.error('错误: --name 的值不能以 - 开头（会被当成命令行开关）');
      emitJson({ ok: false, cmd, error: 'name-starts-with-dash' });
      process.exit(1);
    }
    if (!name) {
      console.error('错误: --name 不能为空'); process.exit(1);
    }
    const reg = loadRegistry();
    const a = findAccount(reg, id);
    if (!a) {
      console.error(`错误: 槽位不存在: ${id}`);
      emitJson({ ok: false, cmd, id, error: 'no-such-slot' });
      process.exit(1);
    }
    const prev = a.name || '';
    const final = name.slice(0, 80);
    if (final !== name) console.log(`提示: 备注名截断到 80 字符`);
    a.name = final;
    saveRegistry(reg);
    console.log(`已重命名槽位 ${id}: 「${prev || '(无备注)'}」→「${final}」`);
    emitJson({ ok: true, cmd, id, name: final, prev });
    return;
  }

  usage();
  process.exit(1);
}

main().catch((e) => {
  console.error(`错误: ${e?.message || e}`);
  emitJson({ ok: false, error: String(e?.message || e) });
  process.exit(1);
});
