import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qam-unit-'));
process.env.QODER_AM_HOME = HOME;
process.env.QODER_DATA_DIR = path.join(HOME, 'client');
fs.mkdirSync(process.env.QODER_DATA_DIR, { recursive: true });

const lib = await import('../scripts/qoder_lib.mjs');

// 行形状按 2026-11-01 实测还原：顶层没有 name，文案在 placements[].content.zh.title，
// 每日行的窗口是 10:00 → 次日 09:59（秒级；服务端毫秒级也见过，inWindow 两种都吃）。
const NOW_SEC = Math.floor(new Date('2026-11-01T10:02:00+08:00').getTime() / 1000);
const DAY_ID = '01a1950a-b4a6-719e-ac44-c8ecf5e349cf';
const VIEW_ID = '01a159a1-b0aa-79de-8c28-c61c1d3201c9';

const grant = (claimStatus, over = {}) => ({
  campaignId: DAY_ID,
  actionType: 'CLAIM_BENEFIT',
  benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
  claimStatus,
  startAt: NOW_SEC - 120,
  endAt: NOW_SEC + 86_400 - 60,
  placements: [{ content: { zh: { title: '每天领 100 Credits' } } }],
  ...over,
});
const viewRow = () => ({
  campaignId: VIEW_ID, actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED',
  startAt: NOW_SEC - 10 * 86_400, endAt: NOW_SEC + 30 * 86_400,
});

test('classifyNoClaim 把「还没发布」与「今日已领」「状态异常」分开', () => {
  // 只有长期 VIEW_DETAILS 行、当日每日行还没挂出来 —— 11-01 10:02 的真实状态
  assert.equal(lib.classifyNoClaim([viewRow()], NOW_SEC), 'not_published');
  assert.equal(lib.classifyNoClaim([], NOW_SEC), 'not_published');
  assert.equal(lib.classifyNoClaim([grant('CLAIMED'), viewRow()], NOW_SEC), 'claimed');
  assert.equal(lib.classifyNoClaim([grant('NOT_STARTED')], NOW_SEC), 'unclaimable_status');
  // 窗口还没开（次日才生效），有行也不算发布
  assert.equal(lib.classifyNoClaim([grant('CLAIMABLE', { startAt: NOW_SEC + 3600 })], NOW_SEC), 'not_published');
  // CLAIMED 但窗口已过 → 不能拿来当「今日已领」
  assert.equal(lib.classifyNoClaim([grant('CLAIMED', { endAt: NOW_SEC - 1 })], NOW_SEC), 'not_published');
  assert.equal(lib.dailyCampaignPublished([grant('CLAIMABLE')], NOW_SEC), true);
});

test('campaignLabel 优先服务端文案，其次语义拼装，最后 id 前缀', () => {
  assert.equal(lib.campaignLabel(grant('CLAIMABLE')), '每天领 100 Credits');
  assert.equal(lib.campaignLabel({ campaignId: DAY_ID, name: '登录奖励' }), '登录奖励');
  assert.equal(lib.campaignLabel({ ...grant('CLAIMABLE'), placements: undefined }), '每日 100 Credits');
  assert.equal(lib.campaignLabel(viewRow()), VIEW_ID.slice(0, 8));
});

test('learnDailyCampaignIds 去重、跳过非法 id、只认窗口内的每日行', () => {
  assert.deepEqual(lib.learnDailyCampaignIds([grant('CLAIMABLE'), grant('CLAIMABLE')], NOW_SEC),
    [[DAY_ID, '每天领 100 Credits']]);
  assert.deepEqual(lib.learnDailyCampaignIds([grant('CLAIMABLE', { campaignId: 'bad id!' })], NOW_SEC), []);
  assert.deepEqual(lib.learnDailyCampaignIds([viewRow()], NOW_SEC), []);
});

/** 假时钟 + 脚本化的 list 响应，让发布延迟这条路径不需要真网络也能跑 */
function stub({ budgetMs = 180_000, responses }) {
  const state = { t: 0, calls: 0, notes: [] };
  const nap = async (ms) => { state.t += ms; };
  const list = async () => {
    const r = responses[Math.min(state.calls, responses.length - 1)];
    state.calls++;
    return r;
  };
  return {
    state,
    run: () => lib.waitForDailyCampaign({}, {
      budgetMs, nap, list, now: () => state.t,
      onNote: (wait) => state.notes.push(wait),
    }),
  };
}

test('waitForDailyCampaign：复查见到当日行就带回新列表', async () => {
  // 循环里的首次复查就已经有行 —— responses[0] 对应的正是这一次
  const s = stub({ responses: [{ kind: 'ok', campaigns: [viewRow(), grant('CLAIMABLE')] }] });
  const r = await s.run();
  assert.equal(r.kind, 'published');
  assert.equal(lib.filterClaimable(r.campaigns).length, 1);
  assert.deepEqual(s.state.notes, [60_000]);
  assert.equal(s.state.calls, 1);
});

test('waitForDailyCampaign：预算用尽就放弃，不无限轮询', async () => {
  const s = stub({ responses: [{ kind: 'ok', campaigns: [viewRow()] }] });
  const r = await s.run();
  assert.equal(r.kind, 'not_published');
  assert.equal(r.campaigns, undefined);
  // 60s + 120s 两段复查，默认 180s 预算刚好用满，不会再多拉一次
  assert.equal(s.state.calls, 2);
  assert.deepEqual(s.state.notes, [60_000, 120_000]);
});

test('waitForDailyCampaign：预算为 0 时一次都不等（QAM_SIGNIN_WAIT_MS=0 的关闭开关）', async () => {
  const s = stub({ budgetMs: 0, responses: [{ kind: 'ok', campaigns: [viewRow()] }] });
  assert.equal((await s.run()).kind, 'not_published');
  assert.equal(s.state.calls, 0);
});

test('waitForDailyCampaign：复查时列表拉不到要如实上抛，不能装成「还没发布」', async () => {
  const s = stub({ responses: [
    { kind: 'ok', campaigns: [viewRow()] },
    { kind: 'auth', code: 'auth', status: 401, message: '登录态失效（401）' },
  ] });
  const r = await s.run();
  assert.equal(r.kind, 'list_fail');
  assert.equal(r.r.code, 'auth');
});
