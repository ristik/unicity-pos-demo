/**
 * The owner's 2026-11-26 report: Redeem said "Need an archive proof" for a payout mined 14 blocks earlier. The block's certificate is in the
 * companion of its child, which a 10 s testnet produces seconds after the payout; the page polls every 3 s, and the plug-in used to turn the
 * third not-yet-certified read into needs-archive. A fresh payout must stay pending until its child is out and then be paid, with no archive
 * configured; a tab left at the old read cap must recover on the next Redeem.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalKeySigner } from '@unicitylabs/native-bridge-plugin/nb2';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { DEFAULTS } from '../src/config.js';
import { IdbKv } from '../src/idb.js';
import { burnerFrom } from '../src/keys.js';
import * as nb2 from '../src/nb2.js';
import { chooseReturnBackup } from '../src/return-backup.js';
import { WORLD_GAS, key, setup } from './world.js';

(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = IDBKeyRange;

async function burned(seed: string) {
  const w = await setup();
  const factory = new IDBFactory();
  const secret = key(`${seed} secret`);
  w.chain.fund(new LocalKeySigner(secret).address, 10n ** 24n);
  const kv = new IdbKv('a', factory);
  const s = await nb2.openSession({
    settings: DEFAULTS, me: burnerFrom(secret), trust: w.root.trust, journal: kv, rpc: w.chain, aggregator: w.agg, gas: WORLD_GAS,
    published: { release: { pins: {} }, pins: w.pins, bundle: w.root.bundle, publishedPin: '', pluginCommit: null, url: '' },
    backup: async () => undefined, refreshTrust: async () => undefined,
  });
  const plan = await nb2.planDeposit(s, 50n);
  await nb2.sendDeposit(s, plan.intent);
  const minted = await nb2.mint(s, plan.intent);
  const rp = await nb2.planReturn(s, minted.token, new Uint8Array(20).fill(0x22), undefined, kv);
  const save = await chooseReturnBackup({
    showSaveFilePicker: async () => ({ createWritable: async () => ({ write: async () => undefined, close: async () => undefined, abort: async () => undefined }) }),
  });
  await nb2.burn(s, rp.returnId, kv, save);
  return { w, s, kv, returnId: rp.returnId };
}

/** The payout is mined at once and its certifying child only after CHILD_AFTER receipt reads (several 3 s polls, as on a 10 s chain). */
function slowChild(w: Awaited<ReturnType<typeof setup>>, childAfter: number) {
  const call = w.chain.call.bind(w.chain);
  let reads = 0;
  let mined = false;
  w.chain.autoMine = false;
  w.chain.call = async <T>(method: string, params: unknown[]): Promise<T> => {
    const result = await call<T>(method, params);
    if (method === 'eth_sendRawTransaction') {
      await w.chain.mineUncertified();
      mined = true;
    }
    if (method === 'eth_getTransactionReceipt' && mined && ++reads === childAfter) await w.chain.mine([]);
    return result;
  };
  return { reads: () => reads };
}

test('Redeem of a payout whose block is certified only after several polls is paid, with no archive', async () => {
  const { w, s, kv, returnId } = await burned('wait');
  const seen = slowChild(w, 12);
  const states: string[] = [];
  const r = await nb2.redeem(s, returnId, (m) => states.push(m), 20, 0, kv);
  assert.equal(r.state, 'paid', `after ${seen.reads()} receipt reads`);
  assert.ok(seen.reads() >= 12);
});

test('a tab left at the old read cap (paidProof.reads 3) is paid on the next Redeem', async () => {
  const { w, s, kv, returnId } = await burned('stuck');
  slowChild(w, Number.MAX_SAFE_INTEGER);
  const first = await nb2.redeem(s, returnId, () => undefined, 4, 0, kv);
  assert.equal(first.state, 'pending', 'not certified yet: pending, never needs-archive');
  const rec = (await nb2.returnRecord(s, `0x${Buffer.from(returnId).toString('hex')}`))!;
  assert.ok(rec.paidProof);
  await s.bridge.journal.putReturn({ ...rec, paidProof: { ...rec.paidProof, reads: 3 } }); // what plug-in 14974d0c left behind
  await w.chain.mine([]);
  assert.equal((await nb2.redeem(s, returnId, () => undefined, 4, 0, kv)).state, 'paid');
});
