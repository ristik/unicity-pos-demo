/**
 * The page's own Redeem through an RPC whose eth_blockNumber lies (0xffffffff): every height-driven loop runs to the highest block the
 * reader serves (the plug-in's EvmReader.saneHead), so the lie costs O(1) extra eth_getLogs windows instead of about 429,000.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalKeySigner, type JsonRpc } from '@unicitylabs/native-bridge-plugin/nb2';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { DEFAULTS } from '../src/config.js';
import { IdbKv } from '../src/idb.js';
import { burnerFrom } from '../src/keys.js';
import * as nb2 from '../src/nb2.js';
import { chooseReturnBackup } from '../src/return-backup.js';
import { WORLD_GAS, key, setup } from './world.js';

(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = IDBKeyRange;

test('Redeem through an RPC whose head lies (0xffffffff) is paid with O(1) extra log windows', async () => {
  const w = await setup();
  const secret = key('sane head secret');
  w.chain.fund(new LocalKeySigner(secret).address, 10n ** 24n);
  const state = { lying: false, logs: 0 };
  const rpc: JsonRpc = {
    call: <T>(method: string, params: unknown[]): Promise<T> => {
      if (method === 'eth_getLogs') state.logs++;
      if (state.lying && method === 'eth_blockNumber') return Promise.resolve('0xffffffff' as T);
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
  const recipient = new Uint8Array(20).fill(0x55);
  const rp = await nb2.planReturn(s, minted.token, recipient, undefined, kv);
  const save = await chooseReturnBackup({
    showSaveFilePicker: async () => ({ createWritable: async () => ({ write: async () => undefined, close: async () => undefined, abort: async () => undefined }) }),
  });
  await nb2.burn(s, rp.returnId, kv, save);
  state.lying = true;
  state.logs = 0;
  const started = Date.now();
  assert.equal((await nb2.redeem(s, rp.returnId, () => undefined, 5, 0, kv)).state, 'paid');
  assert.ok(Date.now() - started < 10_000, 'no scan of the claimed range');
  assert.ok(state.logs < 50, `${state.logs} eth_getLogs windows`);
  assert.equal(w.chain.balanceOf(recipient), 50n);
});
