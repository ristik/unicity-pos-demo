/**
 * Review P2-1 of native-bridge-plugins#94, through the page's own Redeem: a payout seen mined but not certified whose block is then
 * replaced (the receipt gone, the sender's nonce unused again) is offered again as the identical signed transaction once the head is
 * CERTIFICATION_DEPTH past it, and is paid when it lands. It never stays pending forever and nothing new is signed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CERTIFICATION_DEPTH, LocalKeySigner, decodeSignedTx, type JsonRpc } from '@unicitylabs/native-bridge-plugin/nb2';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { DEFAULTS } from '../src/config.js';
import { hex, unhex } from '../src/hex.js';
import { IdbKv } from '../src/idb.js';
import { burnerFrom } from '../src/keys.js';
import * as nb2 from '../src/nb2.js';
import { chooseReturnBackup } from '../src/return-backup.js';
import { WORLD_GAS, key, setup } from './world.js';

(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = IDBKeyRange;

test('Redeem of a payout whose block was replaced 20 blocks ago offers the identical bytes again, then is paid', async () => {
  const w = await setup();
  const secret = key('vanished secret');
  w.chain.fund(new LocalKeySigner(secret).address, 10n ** 24n);
  const state = { rollback: false, tx: '', from: '', nonce: 0n, data: '', sent: [] as string[] };
  const rpc: JsonRpc = {
    call: async <T>(method: string, params: unknown[]): Promise<T> => {
      if (method === 'eth_sendRawTransaction' && !state.tx) {
        const result = await w.chain.call<T>(method, params);
        await w.chain.mineUncertified(); // mined at once, certified only when the next block comes
        return result;
      }
      if (!state.rollback) return w.chain.call<T>(method, params);
      if (method === 'eth_getTransactionReceipt' && params[0] === state.tx) return null as T;
      if (method === 'eth_getLogs') return (await w.chain.call<{ transactionHash: string }[]>(method, params)).filter((l) => l.transactionHash !== state.tx) as T;
      if (method === 'eth_getTransactionCount' && params[1] === 'latest' && params[0] === state.from) return `0x${state.nonce.toString(16)}` as T;
      if (method === 'eth_call' && (params[0] as { data?: string }).data === state.data) return '0x' as T;
      if (method === 'eth_estimateGas' && (params[0] as { data?: string }).data === state.data) return '0x1d4c0' as T;
      if (method === 'eth_sendRawTransaction') { state.sent.push(params[0] as string); return state.tx as T; }
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
  const rp = await nb2.planReturn(s, minted.token, new Uint8Array(20).fill(0x33), undefined, kv);
  const save = await chooseReturnBackup({
    showSaveFilePicker: async () => ({ createWritable: async () => ({ write: async () => undefined, close: async () => undefined, abort: async () => undefined }) }),
  });
  await nb2.burn(s, rp.returnId, kv, save);
  w.chain.autoMine = false;
  const id = `0x${hex(rp.returnId)}`;
  assert.equal((await nb2.redeem(s, rp.returnId, () => undefined, 2, 0, kv)).state, 'pending');
  const rec = (await nb2.returnRecord(s, id))!;
  assert.ok(rec.paidProof?.block, 'the block the payout was seen in is remembered');
  const signed = decodeSignedTx(unhex(rec.sends[0].raw));
  Object.assign(state, { tx: rec.sends[0].hash, from: `0x${hex(signed.from)}`, nonce: signed.request.nonce, data: `0x${hex(signed.request.data)}`, rollback: true });
  for (let i = 0; i < 5; i++) await w.chain.mine([]);
  assert.equal((await nb2.redeem(s, rp.returnId, () => undefined, 2, 0, kv)).state, 'pending');
  assert.deepEqual(state.sent, [], 'near the head nothing is offered again');
  for (let i = 5; i < 20; i++) await w.chain.mine([]);
  assert.ok(BigInt(w.chain.blocks.length) > BigInt(rec.paidProof!.block!) + CERTIFICATION_DEPTH);
  assert.equal((await nb2.redeem(s, rp.returnId, () => undefined, 2, 0, kv)).state, 'pending');
  assert.ok(state.sent.length >= 1 && state.sent.every((raw) => raw === rec.sends[0].raw), 'only the identical signed transaction');
  assert.equal((await nb2.returnRecord(s, id))!.sends.length, 1, 'nothing new was signed');
  state.rollback = false; // it lands again
  assert.equal((await nb2.redeem(s, rp.returnId, () => undefined, 2, 0, kv)).state, 'paid');
});
