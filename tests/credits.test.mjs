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

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 23, 4, 0, 0);

test('expiryTone 分档边界', () => {
  assert.equal(lib.expiryTone(null, NOW), 'none');
  assert.equal(lib.expiryTone(NOW - 1, NOW), 'expired');
  assert.equal(lib.expiryTone(NOW, NOW), 'expired');
  assert.equal(lib.expiryTone(NOW + 1, NOW), 'urgent');
  assert.equal(lib.expiryTone(NOW + 3 * DAY, NOW), 'urgent');
  assert.equal(lib.expiryTone(NOW + 3 * DAY + 1, NOW), 'soon');
  assert.equal(lib.expiryTone(NOW + 7 * DAY, NOW), 'soon');
  assert.equal(lib.expiryTone(NOW + 7 * DAY + 1, NOW), 'mid');
  assert.equal(lib.expiryTone(NOW + 21 * DAY, NOW), 'mid');
  assert.equal(lib.expiryTone(NOW + 21 * DAY + 1, NOW), 'far');
});

test('expiryBatches 同刻合并、过期与不可用单独计数', () => {
  const seg = (label, remaining, expiresAtMs, extra = {}) => ({
    label, remaining, total: remaining, used: 0, available: true, expiresAtMs, ...extra,
  });
  const r = lib.expiryBatches([
    seg('套餐额度', 100, NOW + 5 * DAY, { expirySource: 'period' }),
    seg('专属包 A', 50, NOW + 5 * DAY),
    seg('已过期', 30, NOW - 1),
    seg('停用', 20, NOW + 9 * DAY, { available: false }),
    seg('已用尽', 0, NOW + 2 * DAY),
  ], { now: NOW });

  assert.equal(r.batches.length, 1);
  assert.equal(r.batches[0].credits, 150);
  assert.deepEqual(r.batches[0].sources, ['套餐额度', '专属包 A']);
  assert.equal(r.batches[0].tone, 'soon');
  assert.equal(r.batches[0].daysLeft, 5);
  assert.equal(r.batches[0].share, 100);
  assert.equal(r.total, 150);
  assert.equal(r.expiredTotal, 30);
  assert.equal(r.blockedTotal, 20);
  assert.equal(r.unknownTotal, 0);
});

test('expiryBatches 滚动额度按账本 FIFO 拆，拆不完的进到期未知', () => {
  const seg = { label: '加购/赠送额度', remaining: 400, total: 400, used: 0, available: true, expirySource: 'rolling' };
  const ledger = [
    { date: '2026-10-01', amount: 100, claimedAtMs: NOW - 22 * DAY, expiresAtMs: NOW + 8 * DAY },
    { date: '2026-10-02', amount: 100, claimedAtMs: NOW - 21 * DAY, expiresAtMs: NOW + 9 * DAY },
    { date: '2026-10-03', amount: 100, claimedAtMs: NOW - 20 * DAY, expiresAtMs: NOW + 10 * DAY },
  ];
  const r = lib.expiryBatches([seg], { now: NOW, ledger });

  assert.equal(r.batches.length, 4);
  assert.deepEqual(r.batches.slice(0, 3).map((b) => b.credits), [100, 100, 100]);
  assert.deepEqual(r.batches.slice(0, 3).map((b) => b.daysLeft), [8, 9, 10]);
  assert.match(r.batches[0].note, /领取于 2026-10-01/);
  const unknown = r.batches[3];
  assert.equal(unknown.expiresAtMs, null);
  assert.equal(unknown.tone, 'unknown');
  assert.equal(unknown.credits, 100);
  assert.match(unknown.note, /到期未知/);
  assert.equal(r.unknownTotal, 100);
  assert.equal(r.total, 400);
});

test('expiryBatches 无账本时滚动额度整块标未知，不套用别的到期日', () => {
  const seg = { label: '加购/赠送额度', remaining: 250, available: true, expirySource: 'rolling' };
  const r = lib.expiryBatches([seg], { now: NOW, ledger: [] });
  assert.equal(r.batches.length, 1);
  assert.equal(r.batches[0].expiresAtMs, null);
  assert.equal(r.batches[0].tone, 'unknown');
  assert.equal(r.batches[0].credits, 250);
  assert.equal(r.unknownTotal, 250);
});

test('loadClaimLedger 只认当天有效领取、按日期去重并按到期排序', () => {
  const log = [
    { account: 'acct1', date: '2026-10-20', status: 'success', reward: 100, time: NOW - 3 * DAY },
    { account: 'acct1', date: '2026-10-20', status: 'already', reward: 100, time: NOW - 3 * DAY + 1000 },
    { account: 'acct1', name: 'acct1', date: '2026-10-19', status: 'success', reward: 50, time: NOW - 4 * DAY },
    { account: 'acct1', date: '2026-10-18', status: 'fail', reward: 100, time: NOW - 5 * DAY },
    { account: 'acct1', date: '2026-10-17', status: 'success', reward: 0, time: NOW - 6 * DAY },
    { account: 'acct2', date: '2026-10-20', status: 'success', reward: 100, time: NOW - 3 * DAY },
  ];
  fs.writeFileSync(path.join(HOME, 'signin-log.json'), JSON.stringify(log));

  const got = lib.loadClaimLedger('acct1', { validityDays: 30, now: NOW });
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((x) => x.amount), [50, 100]);
  assert.equal(got[0].date, '2026-10-19');
  assert.equal(got[0].expiresAtMs, NOW - 4 * DAY + 30 * DAY);
  assert.equal(got[1].expiresAtMs, NOW - 3 * DAY + 30 * DAY);

  const noRule = lib.loadClaimLedger('acct1', { now: NOW });
  assert.equal(noRule.length, 2);
  assert.equal(noRule[0].expiresAtMs, null);

  assert.deepEqual(lib.loadClaimLedger('../evil', { now: NOW }), []);
});

test('creditGrantRule 选当前窗口内那一条并带出官方文案', () => {
  const now = Date.now();
  const campaigns = [
    {
      campaignId: 'old', actionType: 'CLAIM_BENEFIT', benefit: { kind: 'CREDITS', amount: 50, validity: { mode: 'RELATIVE_DAYS', days: 7 } },
      claimStatus: 'CLAIMED', startAt: Math.floor((now - 20 * DAY) / 1000), endAt: Math.floor((now - 10 * DAY) / 1000),
    },
    {
      campaignId: 'daily', actionType: 'CLAIM_BENEFIT', benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
      claimStatus: 'CLAIMED', startAt: Math.floor((now - DAY) / 1000), endAt: Math.floor((now + DAY) / 1000),
      placements: [{ content: { zh: { title: '每日领 100', description: '每日 10:00（UTC+8）刷新，领取后 30 天有效', detailUrl: 'https://docs.qoder.cn/events/100credits' } } }],
    },
    { campaignId: 'other', actionType: 'SOMETHING', benefit: { kind: 'CREDITS', amount: 999 } },
  ];
  const rule = lib.creditGrantRule(campaigns);
  assert.equal(rule.campaignId, 'daily');
  assert.equal(rule.amount, 100);
  assert.equal(rule.validityDays, 30);
  assert.equal(rule.validityMode, 'RELATIVE_DAYS');
  assert.equal(rule.title, '每日领 100');
  assert.match(rule.description, /领取后 30 天有效/);
  assert.equal(lib.creditGrantRule([]), null);
  assert.equal(lib.creditGrantRule(null), null);
});

test('normalizeCredits 三类到期语义各算各的', () => {
  const usage = {
    displayMode: 'qoder',
    qoderUsage: {
      userQuota: { total: 1000, used: 400, remaining: 600, percentage: 0.4, unit: 'credits' },
      addOnQuota: { total: 300, used: 100, remaining: 200, percentage: 0.33, unit: 'credits' },
      dedicatedResourcePackages: [
        {
          id: 'p1', name: 'Qwen', total: 500, used: 500, remaining: 0, percentage: 1, available: true,
          expiresAt: NOW + 10 * DAY,
          displayLabels: [{ dimension: 'title', valueI18n: { 'zh-CN': 'Qwen 专属积分' } }],
        },
        { id: 'p2', name: '加量包', total: 100, used: 0, remaining: 100, available: true, expiresAt: NOW + 40 * DAY },
      ],
      orgResourcePackage: null,
      totalUsagePercentage: 0.5,
      expiresAt: NOW + 5 * DAY,
      isQuotaExceeded: false,
    },
  };
  const plan = { plan_tier_name: 'Pro', start_date: NOW - 25 * DAY, end_date: NOW + 5 * DAY };
  const rule = { validityDays: 30, amount: 100, claimStatus: 'CLAIMED', title: '每日赠送' };
  const ledger = [{ date: '2026-10-01', amount: 100, claimedAtMs: NOW - 22 * DAY, expiresAtMs: NOW + 8 * DAY }];

  const out = lib.normalizeCredits({ usage, plan, rule, ledger });
  assert.equal(out.ok, true);
  assert.equal(out.kind, 'qoder');
  assert.equal(out.planTier, 'Pro');
  assert.equal(out.periodEndMs, NOW + 5 * DAY);
  assert.equal(out.daily.claimedToday, true);

  const byKey = Object.fromEntries(out.segments.map((s) => [s.key, s]));
  assert.equal(byKey.userQuota.expirySource, 'period');
  assert.equal(byKey.userQuota.expiresAtMs, NOW + 5 * DAY);
  assert.equal(byKey.addOnQuota.expirySource, 'rolling');
  assert.equal(byKey.addOnQuota.expiresAtMs, null);
  assert.equal(byKey['pkg:p1'].label, 'Qwen 专属积分');
  assert.equal(byKey['pkg:p2'].expiresAtMs, NOW + 40 * DAY);

  // 套餐 600 + 滚动 100+100（100 来自账本、100 无记录） + p2 100；p1 已用尽不占格
  assert.equal(out.summary.byExpiry, 900);
  assert.equal(out.summary.unknownExpiryTotal, 100);
  assert.equal(out.summary.expiredTotal, 0);
  assert.equal(out.summary.nearestExpiryMs, NOW + 5 * DAY);
  assert.equal(out.summary.serverPercentage, 50);
  assert.equal(out.summary.percentage, 52.6);
  assert.equal(out.summary.segmentCount, 4);

  const ent = lib.normalizeCredits({
    usage: { displayMode: 'enterprise', enterpriseUsage: { openMode: 'org', detailUrl: 'https://qoder.cn/org' } },
    plan: null,
  });
  assert.equal(ent.ok, true);
  assert.equal(ent.kind, 'enterprise');
  assert.equal(ent.segments.length, 0);
  assert.equal(ent.detailUrl, 'https://qoder.cn/org');

  const bad = lib.normalizeCredits({ usage: {}, plan: null });
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, 'invalid');
});

test('脱敏只保留可展示的部分', () => {
  assert.equal(lib.maskUid('short'), 'short');
  assert.equal(lib.maskUid('01a0a40fe1b2c3d4a287'), '01a0a40f…a287');
  assert.equal(lib.maskUid(''), '(无)');
  assert.equal(lib.maskEmail('100000000@example.com'), '10***@example.com');
  assert.equal(lib.maskEmail('a@b.com'), 'a***@b.com');
  assert.equal(lib.maskEmail('not-an-email'), '***');
});
