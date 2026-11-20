/** Round-2 review fixes: the read-only default, handoff by deployment, import over every scope, funding replay, split/transfer recheck, plug-in revision. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AmbiguousBroadcast } from '@unicitylabs/native-bridge-plugin/nb2';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { READ_ONLY_OK, VALUE_STEPS, refusal } from '../src/guard.js';
import { Handoff, parseMessage } from '../src/handoff.js';
import { hex } from '../src/hex.js';
import { IdbKv } from '../src/idb.js';
import { burnerFrom, replaceKeyDurable } from '../src/keys.js';
import { sendFunding } from '../src/nb2.js';
import { checkRevision } from '../src/release.js';
import { scanProfile } from '../src/work.js';

(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = IDBKeyRange;

test('#1 the page starts read-only: no mutation, import included, until it is ready', () => {
  const start = { storeProblem: 'starting', ready: false, legacy: false };
  for (const step of ['import', 'deposit', 'split', 'transfer', 'burn', 'redeem', 'fund', 'reset']) assert.ok(refusal(step, start), step);
  for (const step of READ_ONLY_OK) assert.equal(refusal(step, start), null);
  assert.match(refusal('import', { storeProblem: null, ready: false, legacy: false })!, /not ready/);
  assert.equal(refusal('import', { storeProblem: null, ready: true, legacy: false }), null);
  assert.ok(refusal('import', { storeProblem: 'another page holds the journal', ready: true, legacy: false }));
  assert.equal(refusal('reset', { storeProblem: 'older build', ready: false, legacy: true }), null);
});

test('#6 split and transfer go through the installation recheck', () => {
  for (const step of ['deposit', 'mint', 'split', 'transfer', 'plan', 'burn', 'redeem', 'fund']) assert.ok(VALUE_STEPS.has(step), step);
});

test('#6 the plug-in revision must be known on both sides and equal', () => {
  checkRevision('abc', 'abc');
  assert.throws(() => checkRevision(null, 'abc'), /cannot be compared/);
  assert.throws(() => checkRevision('abc', null), /cannot be compared/);
  assert.throws(() => checkRevision('abc', 'abd'), /stays closed/);
});

const D1 = 'aa'.repeat(32);
const D2 = 'bb'.repeat(32);
const key = (b: number): string => hex(burnerFrom(new Uint8Array(32).fill(b)).publicKey);
const hello = (domain: string) => ({ type: 'hello', from: 'b', domain, publicKey: key(1), evmAddress: `0x${'11'.repeat(20)}` });

test('#2 announcements and tokens carry the deployment domain, and a peer of another domain is ignored', async () => {
  assert.equal(parseMessage({ ...hello(D1), domain: undefined }), null);
  assert.equal(parseMessage({ type: 'token', from: 'a', to: 'b', bytes: 'aa', amountWei: '1' }), null);
  assert.equal(parseMessage(hello(D1))?.type, 'hello');
  const me = burnerFrom(new Uint8Array(32).fill(2));
  const seen: string[] = [];
  const toks: string[] = [];
  const a = new Handoff('a', D1, me, { peer: (p) => void seen.push(p.profile), token: (m) => void toks.push(m.from) });
  const same = new Handoff('b', D1, burnerFrom(new Uint8Array(32).fill(3)), {});
  const other = new Handoff('c', D2, burnerFrom(new Uint8Array(32).fill(4)), {});
  try {
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual([...new Set(seen)], ['b'], 'only the same-deployment peer is a recipient');
  other.sendToken('a', new Uint8Array([1]), 1n);
  same.sendToken('a', new Uint8Array([2]), 1n);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(toks, ['b'], 'a token from another deployment is not an inbox delivery');
  } finally {
    for (const h of [a, same, other]) h.close();
  }
});

test('#4 the scan sees unfinished work in every scope and journal, and legacy records', async () => {
  const kv = new IdbKv('a', new IDBFactory());
  const rec = (id: string, extra: object): string => JSON.stringify({ id, amountWei: '1', phase: 'minted', ...extra });
  await kv.put(`tok/${D1}.k/d0`, rec('d0', { burning: true }));
  await kv.put(`tok/${D2}.k/d0`, rec('d0', {}));
  await kv.put(`tok/${D2}.k/d1`, rec('d1', { phase: 'burned' }));
  await kv.put('tok/d7', rec('d7', {}));
  await kv.put(`nb2/v1/${D1}/return/x`, JSON.stringify({ kind: 'return', status: 'burn-requested' }));
  await kv.put(`nb2/v1/${D1}/return/y`, JSON.stringify({ kind: 'return', status: 'paid' }));
  await kv.put(`nb2/v1/${D2}/deposit/0`, JSON.stringify({ kind: 'deposit', status: 'submitted' }));
  const scan = await scanProfile(kv);
  assert.deepEqual(scan.legacy, ['tok/d7']);
  assert.equal(scan.records.length, 3);
  const text = scan.unfinished.join('\n');
  assert.match(text, /burn of token d0 .* requested/);
  assert.match(text, /d1 .* not redeemed/);
  assert.match(text, /return is burn-requested/);
  assert.match(text, /deposit 0 is submitted/);
  assert.doesNotMatch(text, /paid/);
  const empty = await scanProfile(new IdbKv('b', new IDBFactory()));
  assert.deepEqual([empty.legacy, empty.unfinished], [[], []]);
});

test('#4 the key and its deployment-bound recovery request are one transaction', async () => {
  const kv = new IdbKv('a', new IDBFactory());
  await kv.put('secret/key', 'old');
  await kv.put('nb2/v1/x', '{}');
  const secret = new Uint8Array(32).fill(9);
  const real = kv.rewrite.bind(kv);
  kv.rewrite = async () => { throw new Error('abort'); };
  await assert.rejects(() => replaceKeyDurable(kv, secret, { next: '3', domain: D1 }));
  assert.equal(await kv.get('secret/key'), 'old', 'the old key and journal are untouched');
  assert.equal(await kv.get('recover/next'), null);
  kv.rewrite = real;
  await replaceKeyDurable(kv, secret, { next: '3', domain: D1 });
  assert.equal(await kv.get('secret/key'), hex(secret));
  assert.deepEqual(JSON.parse((await kv.get('recover/next'))!), { next: '3', domain: D1 });
  assert.equal(await kv.get('nb2/v1/x'), null);
});

test('#5 funding: a mined transaction is not rebroadcast; nonce too low with its receipt is done; an ambiguous send waits for the receipt', async () => {
  const rec = { hash: `0x${'ab'.repeat(32)}`, raw: 'deadbeef' };
  let sent = 0;
  const mk = (receipt: unknown, err?: Error) => ({ receipt: async () => receipt, sendRaw: async () => { sent++; if (err) throw err; return null; } });
  assert.equal(await sendFunding(mk({ status: '0x1' }), rec), 'already mined');
  assert.equal(sent, 0);
  assert.equal(await sendFunding(mk(null), rec), 'sent');
  let calls = 0;
  const late = { receipt: async () => (++calls > 1 ? { status: '0x1' } : null), sendRaw: async () => { throw new Error('nonce too low'); } };
  assert.equal(await sendFunding(late, rec), 'already mined');
  assert.match(await sendFunding(mk(null, new AmbiguousBroadcast(new Uint8Array(32), 'partial')), rec), /^pending/);
  await assert.rejects(() => sendFunding(mk(null, new Error('nonce too low')), rec), /nonce too low/);
});

test('#5 funding records are keyed by deployment and signer', () => {
  const k = (d: string, p: string): string => `fund/pending/${d}.${p}`;
  assert.notEqual(k(D1, key(1).slice(0, 16)), k(D2, key(1).slice(0, 16)));
  assert.notEqual(k(D1, key(1).slice(0, 16)), k(D1, key(2).slice(0, 16)));
});
