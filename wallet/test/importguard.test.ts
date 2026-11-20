/** Import key: what the old key would lose, and the typed confirmation it then needs. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { confirmed, valueAtRisk } from '../src/importguard.js';
import type { TokenRecord } from '../src/tokens.js';

const ADDR = `0x${'ab'.repeat(20)}`;
const tok = (phase: TokenRecord['phase'], extra: Partial<TokenRecord> = {}): TokenRecord => ({ id: `t-${phase}`, amountWei: '1000000000000000', phase, ...extra });

test('nothing held: no confirmation needed', () => {
  assert.deepEqual(valueAtRisk({ address: ADDR, balance: 0n, tokens: [tok('sent'), tok('split'), tok('redeemed'), tok('burned', { recipient: `0x${'cd'.repeat(20)}` })] }), []);
});

test('balance, deposits not minted, held, received and burned-to-this-address tokens are each named', () => {
  const r = valueAtRisk({
    address: ADDR, balance: 5n,
    tokens: [tok('deposited'), tok('minted'), tok('received'), tok('burned', { recipient: ADDR.toUpperCase().replace('0X', '0x') }), tok('minted', { pending: { tx: '', cd: '', at: 0, toPublicKey: '', toProfile: 'b', signer: '' } })],
  });
  assert.equal(r.length, 7);
  assert.match(r[0], /EVM balance/);
  assert.match(r[1], /not minted yet/);
  assert.match(r[2], /held by this key/);
  assert.match(r[3], /received token/);
  assert.match(r[4], /not redeemed yet/);
  assert.match(r[6], /transfer of token/);
});

test('an unreadable balance counts as value held', () => {
  const r = valueAtRisk({ address: ADDR, balance: null, tokens: [] });
  assert.equal(r.length, 1);
  assert.match(r[0], /could not be read/);
});

test('only the typed word confirms', () => {
  assert.equal(confirmed('replace'), true);
  assert.equal(confirmed('  Replace '), true);
  for (const x of [null, '', 'yes', 'ok', 'replac']) assert.equal(confirmed(x), false);
});
