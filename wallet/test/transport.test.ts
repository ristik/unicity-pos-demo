import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Nb2Error, RpcError, WalletError } from '@unicitylabs/native-bridge-plugin/nb2';
import { stepError, transportRetry } from '../src/nb2.js';

const noSleep = async (): Promise<void> => undefined;

test('a missing payer policy maps to the pointer, by reason and by the old message', () => {
  for (const e of [new WalletError('PolicyRequired', 'explicit payer limits are required'), new Nb2Error('CapacityPreflight', 'explicit payer limits are required')]) {
    const out = stepError(e) as Error;
    assert.match(out.message, /reset to testnet defaults/);
  }
});

test('a retryable RPC error shows the rate-limit message, others stay as they are', () => {
  for (const status of [0, 429, 502, 503, 504]) {
    assert.equal((stepError(new RpcError(status, 0, 'x')) as Error).message, 'the public RPC is rate-limiting; wait a few seconds and run again');
  }
  const verdict = new RpcError(200, -32000, 'execution reverted');
  assert.equal(stepError(verdict), verdict);
  const other = new Error('boom');
  assert.equal(stepError(other), other);
});

test('transportRetry waits out retryable errors, and only those', async () => {
  let n = 0;
  const r = await transportRetry(async () => { if (++n < 3) throw new RpcError(429, 0, 'slow down'); return 'ok'; }, undefined, { sleep: noSleep });
  assert.equal(r, 'ok');
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(transportRetry(async () => { n++; throw new RpcError(200, -32000, 'revert'); }, undefined, { sleep: noSleep }), /revert/);
  assert.equal(n, 1);
});

test('transportRetry gives up after its budget and surfaces the error', async () => {
  let n = 0;
  await assert.rejects(transportRetry(async () => { n++; throw new RpcError(503, 0, 'busy'); }, undefined, { sleep: noSleep, budgetMs: 10_000, random: () => 0 }),
    (e: unknown) => e instanceof RpcError && e.retryable);
  assert.ok(n > 1 && n < 10);
});
