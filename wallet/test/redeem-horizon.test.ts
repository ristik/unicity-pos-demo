/**
 * Owner decision on review P3-C of native-bridge-plugins#95, through the page's own Redeem: a reader that indexes an invented Paid of another
 * party holds the return (pending, then vanished) only until every reader's head is VANISHED_CLAIM_HORIZON past where it was first seen; then
 * Redeem pays from this wallet. A lying provider can delay a redemption, never stop it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalKeySigner, TOPIC, VANISHED_CLAIM_HORIZON, type JsonRpc } from '@unicitylabs/native-bridge-plugin/nb2';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { DEFAULTS } from '../src/config.js';
import { hex } from '../src/hex.js';
import { IdbKv } from '../src/idb.js';
import { burnerFrom } from '../src/keys.js';
import * as nb2 from '../src/nb2.js';
import { chooseReturnBackup } from '../src/return-backup.js';
import { VAULT, WORLD_GAS, key, setup } from './world.js';

(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = IDBKeyRange;

test('an invented peer Paid holds Redeem only until the horizon, then this wallet pays', async () => {
  const w = await setup();
  const secret = key('horizon secret');
  w.chain.fund(new LocalKeySigner(secret).address, 10n ** 24n);
  const recipient = new Uint8Array(20).fill(0x44);
  const state = { lying: false, eta: '', amount: 0n };
  const rpc: JsonRpc = {
    call: async <T>(method: string, params: unknown[]): Promise<T> => {
      if (state.lying && method === 'eth_getLogs' && (params[0] as { topics: string[] }).topics[0] === `0x${hex(TOPIC.Paid)}`) {
        return [{
          address: `0x${hex(VAULT)}`, topics: [`0x${hex(TOPIC.Paid)}`, state.eta, `0x${'00'.repeat(12)}${hex(recipient)}`],
          data: `0x${state.amount.toString(16).padStart(64, '0')}`, blockNumber: `0x${(w.chain.blocks.length - 1).toString(16)}`,
          blockHash: `0x${'cd'.repeat(32)}`, transactionHash: `0x${'ef'.repeat(32)}`, logIndex: '0x0',
        }] as T;
      }
      return w.chain.call<T>(method, params);
    },
  };
  const kv = new IdbKv('a', new IDBFactory());
  const s = await nb2.openSession({
    settings: DEFAULTS, me: burnerFrom(secret), trust: w.root.trust, journal: kv, rpc, aggregator: w.agg, gas: WORLD_GAS,
    published: { release: { pins: {} }, pins: w.pins, bundle: w.root.bundle, publishedPin: '', pluginCommit: null, url: '' },
    backup: async () => undefined, refreshTrust: async () => undefined,
  });
  const plan = await nb2.planDeposit(s, 50n);
  await nb2.sendDeposit(s, plan.intent);
  const minted = await nb2.mint(s, plan.intent);
  const rp = await nb2.planReturn(s, minted.token, recipient, undefined, kv);
  const save = await chooseReturnBackup({
    showSaveFilePicker: async () => ({ createWritable: async () => ({ write: async () => undefined, close: async () => undefined, abort: async () => undefined }) }),
  });
  await nb2.burn(s, rp.returnId, kv, save);
  const id = `0x${hex(rp.returnId)}`;
  const rec = (await nb2.returnRecord(s, id))!;
  Object.assign(state, { lying: true, eta: rec.eta, amount: BigInt(rec.amount) });
  assert.equal((await nb2.redeem(s, rp.returnId, () => undefined, 1, 0, kv)).state, 'pending', 'an unproven claim signs nothing');
  const since = BigInt((await nb2.returnRecord(s, id))!.peerClaimSince!);
  state.lying = false; // honest readers from now on
  for (let i = 0; i < 20; i++) await w.chain.mine([]);
  assert.equal((await nb2.redeem(s, rp.returnId, () => undefined, 1, 0, kv)).state, 'vanished');
  assert.deepEqual((await nb2.returnRecord(s, id))!.sends, []);
  while (BigInt(w.chain.blocks.length - 1) < since + VANISHED_CLAIM_HORIZON) await w.chain.mine([]);
  assert.equal((await nb2.redeem(s, rp.returnId, () => undefined, 2, 0, kv)).state, 'paid');
  assert.equal(w.chain.balanceOf(recipient), 50n);
});
