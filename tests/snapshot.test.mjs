import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qam-snap-'));
process.env.QODER_AM_HOME = HOME;
process.env.QODER_DATA_DIR = path.join(HOME, 'client');
fs.mkdirSync(process.env.QODER_DATA_DIR, { recursive: true });

const lib = await import('../scripts/qoder_lib.mjs');

test('禁交换清单保持 29 条（README/CHANGELOG 引用的数字）', () => {
  assert.equal(lib.SNAPSHOT_NEVER.length, 29);
  assert.equal(new Set(lib.SNAPSHOT_NEVER).size, 29);
});

test('三个档位彼此不重叠，core 覆盖必需项', () => {
  const { core, browser, appdata } = lib.SNAPSHOT_V2;
  const all = [...core, ...browser, ...appdata];
  assert.equal(new Set(all).size, all.length);
  for (const rel of lib.snapshotRequired('v2')) assert.ok(core.includes(rel), `${rel} 必须在 core`);
});

test('任何档位组合都不会混入禁交换项', () => {
  const never = lib.SNAPSHOT_NEVER;
  for (const browser of [false, true]) {
    for (const appdata of [false, true]) {
      const list = lib.snapshotWhitelist('v2', { tiers: { core: true, browser, appdata } });
      for (const rel of list) {
        assert.ok(!never.some((n) => rel === n || rel.startsWith(`${n}/`)), `混入禁交换项: ${rel}`);
      }
    }
  }
  const v1 = lib.snapshotWhitelist('v1', { tiers: {} });
  assert.ok(v1.includes('User/globalStorage/state.vscdb'));
  assert.ok(!v1.includes('main.sqlite'));
});

test('槽位 id 拒绝路径穿越与超长输入', () => {
  for (const bad of ['../x', 'a/b', 'a\\b', '', 'x'.repeat(65), '中文', 'a b']) {
    assert.equal(lib.isValidSlotId(bad), false, `应拒绝: ${JSON.stringify(bad)}`);
  }
  for (const ok of ['acct1', 'a-b_c', 'A1', 'x'.repeat(64)]) {
    assert.equal(lib.isValidSlotId(ok), true, `应接受: ${ok}`);
  }
  assert.throws(() => lib.assertSlotId('../x'));
});
