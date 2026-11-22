/**
 * The wallet's flow (src/nb2.ts, the same functions the page runs) on the plug-in's offline simulator (test/world.ts: a fake gateway that executes
 * deposits and redemptions against the vault model, and a fake aggregator), with the journal in IndexedDB (fake-indexeddb): deposit → mint →
 * split → transfer (its request stored before it is certified, finished by a fresh page after a "crash") → plan return → burn → redeem. Also the
 * receiver's offline check and the old-epoch forgeries.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalKeySigner, Nb2Error, decodeToken } from '@unicitylabs/native-bridge-plugin/nb2';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { DEFAULTS } from '../src/config.js';
import { forgeRelabelled, forgeUnknownKeys, sealTable, verdict } from '../src/forge.js';
import { acceptToken } from '../src/handoff.js';
import { hex, unhex } from '../src/hex.js';
import { IdbKv } from '../src/idb.js';
import { burnerFrom } from '../src/keys.js';
import * as nb2 from '../src/nb2.js';
import { authenticatedOrigin } from '../src/release.js';
import { begin, end } from '../src/trace.js';
import { getToken, initTokens, patchToken, putToken } from '../src/tokens.js';
import { WORLD_GAS, key, setup, VAULT } from './world.js';

(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = IDBKeyRange;

async function world() {
  const w = await setup();
  const factory = new IDBFactory();
  const secret = key('wallet secret');
  const me = burnerFrom(secret);
  w.chain.fund(new LocalKeySigner(secret).address, 10n ** 24n);
  const intents: string[] = [];
  const open = async (kv = new IdbKv('a', factory), backup: (i: { next: string }) => Promise<void> = async (i) => void intents.push(i.next)) => {
    const s = await nb2.openSession({
      settings: DEFAULTS, me, trust: w.root.trust, journal: kv, rpc: w.chain, aggregator: w.agg, gas: WORLD_GAS,
      published: { release: { pins: {} }, pins: w.pins, bundle: w.root.bundle, publishedPin: '', pluginCommit: null, url: '' },
      backup, refreshTrust: async () => undefined,
    });
    return { s, kv };
  };
  return { ...w, factory, me, intents, open };
}
async function openWith(w: Awaited<ReturnType<typeof world>>, backup: (i: { next: string }) => Promise<void>) {
  return (await w.open(new IdbKv('a', w.factory), backup)).s;
}

test('deposit, mint, split, a transfer finished after a crash, return and redeem', async () => {
  const w = await world();
  const { s, kv } = await w.open();
  await initTokens(kv, 'D.k');

  // deposit: the intent mark is backed up before the value is sent
  const plan = await nb2.planDeposit(s, 100n);
  assert.deepEqual(w.intents, ['1']);
  await putToken({ id: `d${plan.intent}`, amountWei: '100', phase: 'planned', intent: plan.intent.toString() });
  const dep = await nb2.sendDeposit(s, plan.intent);
  assert.equal(dep.depositNumber, 1n);
  const minted = await nb2.mint(s, plan.intent);
  assert.equal(minted.amount, 100n);
  assert.ok(minted.jBytes > 0);

  // split 60 + 40
  const [keep, back] = await nb2.split(s, minted.token, [60n, 40n]);
  assert.equal((await s.bridge.verifyToken(keep)).amount, 60n);
  assert.equal((await s.bridge.verifyToken(back)).amount, 40n);

  // transfer `keep` to another wallet's key: the request is stored before it is certified; the page then "crashes"
  const bob = burnerFrom(key('tab b'));
  const prepared = await nb2.prepareTransfer(s, keep, bob.publicKey);
  await putToken({ id: 'k', amountWei: '60', phase: 'minted', bytes: hex(keep) });
  await patchToken('k', { pending: { ...prepared, at: 0, toPublicKey: hex(bob.publicKey), toProfile: 'b', signer: hex(w.me.publicKey) } });
  const reopened = await w.open(new IdbKv('a', w.factory)); // a fresh page over the same durable store
  await initTokens(reopened.kv, 'D.k');
  const stored = getToken('k')!;
  assert.ok(stored.pending, 'the exact request survived');
  const sent = await nb2.finishTransfer(reopened.s, unhex(stored.bytes!), stored.pending!);
  // finishing again certifies the same request and yields the same token file
  assert.deepEqual(await nb2.finishTransfer(reopened.s, unhex(stored.bytes!), stored.pending!), sent);

  // tab B verifies it offline and finds itself the owner; another key does not
  const accepted = await acceptToken(s.bridge, hex(sent), bob.publicKey);
  assert.equal(accepted.verified.amount, 60n);
  await assert.rejects(() => acceptToken(s.bridge, hex(sent), w.me.publicKey), /owner is another key/);

  // return `back`: the preflight facts, the burn, the redeem
  const trace = begin();
  const recipient = new Uint8Array(20).fill(0x11);
  const rp = await nb2.planReturn(s, back, recipient, undefined, kv);
  assert.ok(rp.gasLimit < w.pins.userGasLimit);
  assert.equal(rp.a, 0n);
  const b = await nb2.burn(s, rp.returnId, undefined, kv);
  const backup = JSON.parse((await kv.get(`return/backup/0x${hex(s.bridge.domain)}/0x${hex(rp.returnId)}`))!);
  const signed = await nb2.returnRecord(s, `0x${hex(rp.returnId)}`);
  assert.equal(backup.pending.burnRequest, signed?.burnRequest);
  assert.equal(backup.pending.recipient, `0x${hex(recipient)}`);
  assert.ok(b.evidenceBytes > 0);
  const paid = await nb2.redeem(s, rp.returnId, () => undefined, 5, 0, kv);
  end(trace);
  assert.equal(paid.state, 'paid');
  const facts = new Map(trace.facts);
  for (const k of ['burn index a', 'preflight gas limit', 'redemption ID eta', 'gap proofs in the witness', 'paid in block']) assert.ok(facts.has(k), `a fact for ${k}`);
  assert.match(facts.get('preflight gas limit')!, /of userGasLimit 60000000/);
  assert.equal(w.chain.balanceOf(recipient), 40n);
  assert.equal(w.chain.vault.state().outstanding, 60n); // `keep` is still on Unicity

  // a cold start finds the return paid in the journal
  const cold = await w.open(new IdbKv('a', w.factory));
  const rec = await nb2.returnRecord(cold.s, `0x${hex(rp.returnId)}`);
  assert.equal(rec?.status, 'paid');
});

test('the installation check refuses another deployment, and nothing is sent', async () => {
  const w = await world();
  const bad = { ...w.pins, vaultRuntimeCodeHash: Uint8Array.from(w.pins.vaultRuntimeCodeHash, (x, i) => (i === 3 ? x ^ 1 : x)) };
  await assert.rejects(() => nb2.openSession({
    settings: DEFAULTS, me: w.me, trust: w.root.trust, journal: new IdbKv('a', w.factory), rpc: w.chain, aggregator: w.agg, gas: WORLD_GAS,
    published: { release: { pins: {} }, pins: bad, bundle: w.root.bundle, publishedPin: '', pluginCommit: null, url: '' }, backup: async () => undefined, refreshTrust: async () => undefined,
  }), (e: unknown) => e instanceof Error && /BadDeployment/.test(e.message));
});

test('the installation is checked again before value moves: a reset network or another vault is refused', async () => {
  const w = await world();
  const { s } = await w.open();
  await nb2.checkInstallation(s);
  const badCode = { ...s, pins: { ...s.pins, vaultRuntimeCodeHash: Uint8Array.from(s.pins.vaultRuntimeCodeHash, (x, i) => (i === 0 ? x ^ 1 : x)) } };
  await assert.rejects(() => nb2.checkInstallation(badCode), /BadDeployment/);
  const badGamma = { ...s, pins: { ...s.pins, gamma: Uint8Array.from(s.pins.gamma, (x, i) => (i === s.pins.gamma.length - 1 ? x ^ 1 : x)) } };
  await assert.rejects(() => nb2.checkInstallation(badGamma), /BadDeployment/);
});

test('an interrupted intent backup is finished before the send, which refuses an unbacked-up intent', async () => {
  const w = await world();
  const { s } = await w.open();
  let fail = true;
  const flaky = { ...s, backup: async (i: { next: string }) => { if (fail) throw new Error('the backup was interrupted'); w.intents.push(i.next); } };
  const plan = await nb2.planDeposit(await openWith(w, flaky.backup), 100n).catch(() => null);
  assert.equal(plan, null, 'the plan call failed at the backup');
  const rec = await s.bridge.journal.deposit(0n);
  assert.equal(rec?.backedUp, false, 'the plug-in left a planned, unbacked-up deposit');
  await assert.rejects(() => nb2.sendDeposit(s, 0n), /JournalNotPersisted|backed up|backup/i);
  fail = false;
  assert.equal(await nb2.finishBackup(flaky, 0n), true);
  assert.equal((await s.bridge.journal.deposit(0n))?.backedUp, true);
  assert.equal((await nb2.sendDeposit(s, 0n)).depositNumber, 1n);
  assert.equal(await nb2.finishBackup(flaky, 0n), false, 'nothing left to finish');
});

test('split amounts: zero and the whole token are refused before anything is persisted', () => {
  assert.deepEqual(nb2.splitAmounts(100n, 40n), [60n, 40n]);
  assert.throws(() => nb2.splitAmounts(100n, 0n), /more than zero/);
  assert.throws(() => nb2.splitAmounts(100n, 100n), /smaller/);
});

test('the old-epoch check and the forgeries', async () => {
  const w = await world();
  const { s } = await w.open();
  const p = await nb2.planDeposit(s, 100n);
  await nb2.sendDeposit(s, p.intent);
  const { token } = await nb2.mint(s, p.intent);
  const [part] = await nb2.split(s, token, [60n, 40n]);

  assert.deepEqual(await verdict(s.bridge, part), { ok: true });
  const rows = await sealTable(part, s.trust);
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => r.inInterval && r.entry !== null));
  assert.ok(rows.some((r) => r.step.startsWith('root')), 'the split part carries its parent\'s certificates');

  const forged = await forgeUnknownKeys(part);
  assert.notEqual(hex(forged), hex(part));
  const v = await verdict(s.bridge, forged);
  assert.equal(!v.ok && v.reason, 'QuorumNotMet');

  const f = await forgeRelabelled(part, s.trust);
  assert.match(f.why[0], /before the genesis/);
  const r = await verdict(s.bridge, f.bytes);
  assert.equal(!r.ok && r.reason, 'SealEpoch');
  assert.ok(decodeToken(f.bytes).proofs.length === decodeToken(part).proofs.length);
  assert.ok(Nb2Error);
  assert.ok(VAULT.length === 20);
});

test('the B1 origin requires a pinned release digest', async () => {
  const { s } = await (await world()).open();
  const digest = 'ab'.repeat(32);
  const release = { ...s.published, sha256: digest, release: {
    pins: {}, trust: { origin: { usableEpoch: '2', rootRound: '400' } },
  } };
  assert.deepEqual(authenticatedOrigin(release, digest), { usableEpoch: 2n, rootRound: 400n });
  assert.throws(() => authenticatedOrigin(release, 'cd'.repeat(32)), /does not match/);
  assert.throws(() => authenticatedOrigin({ ...release, release: { pins: {} } }, digest), /needs a B1 origin/);
});
