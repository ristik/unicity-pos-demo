/**
 * Retried and interrupted steps, against fakes of the aggregator and the EVM RPC: a transfer or burn is built once and its stored request is
 * resubmitted (never a new one); certify takes "already submitted" as accepted and refuses a proof of another transaction; a lock is stored
 * before it is broadcast and a retry polls it instead of locking twice. Handoff messages are shape-checked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sha256 } from '@noble/hashes/sha2.js';
import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import { CertificationData } from '@unicitylabs/state-transition-sdk/lib/api/CertificationData.js';
import { CertificationResponse } from '@unicitylabs/state-transition-sdk/lib/api/CertificationResponse.js';
import type { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProof.js';
import { StateId } from '@unicitylabs/state-transition-sdk/lib/api/StateId.js';
import { Token } from '@unicitylabs/state-transition-sdk/lib/transaction/Token.js';

import { burn, certify, ConflictError, lock, probePending, StillPendingError, transfer, type LockEvm, type PendingLock, type PendingTx } from '../src/bridge.js';
import { calldata, encBytes, HttpError, LOCKED_TOPIC, RpcError, type Receipt } from '../src/evm.js';
import { parseMessage } from '../src/handoff.js';
import { hex, unhex } from '../src/hex.js';
import { burnerFrom } from '../src/keys.js';
import { buildToken, certifyRequest, makeWorld, sha, signer, spec, txStep, type World } from './world.js';

const T0 = 1_700_000_040n;
const UC_TS = 1_700_000_900n;
const FAST = { timeoutMs: 300, everyMs: 10 };

/** The key of world signer(n), as a wallet burner. */
const burnerOf = (n: number) => burnerFrom(sha(Uint8Array.of(0x73, n)));

/**
 * A fake aggregator: it records every submitted request, answers `status`, and certifies the first request it accepts for a state id once
 * `certifyAfter` polls have passed (never, with Infinity). `preset` puts a proof of some other request in place up front.
 */
function fakeAgg(w: World, o: { status?: string; certifyAfter?: number; preset?: CertificationData } = {}) {
  const submitted: Uint8Array[] = [];
  const queued = new Map<string, CertificationData>();
  const proofs = new Map<string, InclusionProof>();
  let polls = 0;
  const key = async (cd: CertificationData) => hex((await StateId.fromCertificationData(cd)).data);
  const ready = (async () => {
    if (o.preset) proofs.set(await key(o.preset), await certifyRequest(w, o.preset, T0 + 20n, UC_TS));
  })();
  const agg = {
    async submitCertificationRequest(cd: CertificationData) {
      await ready;
      submitted.push(cd.toCBOR());
      const k = await key(cd);
      if (!queued.has(k)) queued.set(k, cd);
      return CertificationResponse.create(o.status ?? 'SUCCESS');
    },
    async getInclusionProof(sid: StateId) {
      await ready;
      const k = hex(sid.data);
      if (!proofs.has(k) && queued.has(k) && ++polls > (o.certifyAfter ?? 0)) proofs.set(k, await certifyRequest(w, queued.get(k)!, T0 + 20n, UC_TS));
      return { inclusionProof: proofs.get(k) ?? null };
    },
  };
  return { agg: agg as unknown as AggregatorClient, submitted };
}

/** A held token: minted to signer(1), transferred to signer(2), who is the wallet. */
async function held() {
  const w = await makeWorld();
  const out = await buildToken(w, spec(1), [txStep(2, 7, T0 + 10n)], T0, UC_TS);
  return { w, bytes: out.bytes, me: burnerOf(2) };
}

test('transfer: a retry after a timeout resubmits the stored request, and the token then verifies for the receiver', async () => {
  const { w, bytes, me } = await held();
  const to = signer(3).publicKey;
  let stored: PendingTx | undefined;
  const first = fakeAgg(w, { certifyAfter: Infinity });
  await assert.rejects(transfer({ agg: first.agg }, me, bytes, to, undefined, (p) => (stored = p), FAST), /timed out/);
  assert.ok(stored, 'the transaction is stored before it is submitted');
  assert.equal(stored.kind, 'transfer');
  assert.equal(stored.toPublicKey, hex(to));
  // the page reloads; the aggregator says it already holds the request
  const again = fakeAgg(w, { status: 'ALREADY_SUBMITTED' });
  let rebuilt = false;
  const out = await transfer({ agg: again.agg }, me, bytes, signer(4).publicKey, stored, () => (rebuilt = true), FAST);
  assert.equal(rebuilt, false, 'no new transaction is built');
  assert.deepEqual(again.submitted.map(hex), first.submitted.map(hex), 'the same signed request');
  assert.equal(hex(again.submitted[0]), stored.cd);
  assert.equal((await Token.fromCBOR(out)).transactions.length, 2);
  const v = await w.bridge.verifyNativeTokenBytes(out, 'receipt');
  assert.equal(v.outcome.nonce, 1n);
});

test('transfer: a retry after the proof arrived takes the proof without submitting again', async () => {
  const { w, bytes, me } = await held();
  let stored: PendingTx | undefined;
  const a = fakeAgg(w);
  const out1 = await transfer({ agg: a.agg }, me, bytes, signer(3).publicKey, undefined, (p) => (stored = p), FAST);
  // the record was not updated (a reload right after the proof): the next run has only the stored transaction
  const before = a.submitted.length;
  const out2 = await transfer({ agg: a.agg }, me, bytes, signer(3).publicKey, stored, () => assert.fail('rebuilt'), FAST);
  assert.equal(a.submitted.length, before, 'nothing submitted');
  assert.equal(hex(out2), hex(out1));
});

test('certify: a proof of another transaction for the same state is a ConflictError, not success', async () => {
  const { w, bytes, me } = await held();
  // another transfer of the same state got certified first (an earlier run with a fresh mask)
  let other: PendingTx | undefined;
  await assert.rejects(transfer({ agg: fakeAgg(w, { certifyAfter: Infinity }).agg }, me, bytes, signer(5).publicKey, undefined, (p) => (other = p), FAST));
  const preset = CertificationData.fromCBOR(unhex(other!.cd));
  const agg = fakeAgg(w, { preset, status: 'STATE_ID_QUEUED' });
  await assert.rejects(transfer({ agg: agg.agg }, me, bytes, signer(3).publicKey, undefined, () => undefined, FAST), (e: unknown) => e instanceof ConflictError && /another transaction/.test(e.message));
});

test('certify: a refused request with no proof fails with the status', async () => {
  const { w, bytes, me } = await held();
  let stored: PendingTx | undefined;
  await assert.rejects(transfer({ agg: fakeAgg(w, { certifyAfter: Infinity }).agg }, me, bytes, signer(3).publicKey, undefined, (p) => (stored = p), FAST));
  const cd = CertificationData.fromCBOR(unhex(stored!.cd));
  const refusing = fakeAgg(w, { status: 'SIGNATURE_VERIFICATION_FAILED', certifyAfter: Infinity });
  await assert.rejects(certify(refusing.agg, cd, 'transfer', FAST), /refused the request: SIGNATURE_VERIFICATION_FAILED/);
  // queued (possibly another request): wait for the proof, then compare
  const queued = fakeAgg(w, { status: 'STATE_ID_QUEUED' });
  const proof = await certify(queued.agg, cd, 'transfer', FAST);
  assert.ok(proof.certificationData.transactionHash.equals(cd.transactionHash));
});

test('burn: the stored burn is resumed; a pending transfer blocks a burn', async () => {
  const { w, bytes, me } = await held();
  const s = (agg: AggregatorClient) => ({ agg, vaultCfg: w.dep.cfg, bridge: w.bridge, trust: w.agg.trust });
  const recipient = `0x${'d0'.repeat(20)}`;
  let stored: PendingTx | undefined;
  const first = fakeAgg(w, { certifyAfter: Infinity });
  await assert.rejects(burn(s(first.agg), me, bytes, recipient, undefined, (p) => (stored = p), FAST), /timed out/);
  assert.equal(stored?.kind, 'burn');
  assert.equal(stored?.recipient, recipient);
  const again = fakeAgg(w);
  const out = await burn(s(again.agg), me, bytes, `0x${'11'.repeat(20)}`, stored, () => assert.fail('rebuilt'), FAST);
  assert.deepEqual(again.submitted.map(hex), first.submitted.map(hex));
  await w.bridge.verifyNativeTokenBytes(out, 'return');
  const pendingTransfer: PendingTx = { ...stored!, kind: 'transfer' };
  await assert.rejects(burn(s(again.agg), me, bytes, recipient, pendingTransfer, () => undefined, FAST), /a transfer of this token is pending/);
});

// ---- lock ------------------------------------------------------------------------------------------------------------------------------------
const VAULT = `0x${'aa'.repeat(20)}`;

/** A fake EVM: it signs deterministic fake transactions, counts broadcasts, and mines on demand. */
function fakeEvm(me: ReturnType<typeof burnerOf>, o: { refuse?: string; mineOnBroadcast?: number; lockNonce?: bigint; fail?: (n: number) => Error | undefined } = {}) {
  let signed = 0;
  let accountNonce = 0n;
  const broadcasts: string[] = [];
  const mined = new Map<string, Receipt>();
  const evm: LockEvm & { mineNow(hash: string): void; takeNonce(): void } = {
    async sign(_secret, t) {
      assert.equal(t.to, VAULT);
      assert.equal(hex(t.data!), hex(calldata('lock(bytes)', encBytes(me.predicate))));
      const n = accountNonce;
      signed++;
      return { hash: `0x${hex(sha256(Uint8Array.of(signed)))}`, raw: `0x${hex(Uint8Array.of(0xf8, signed))}`, gas: 100_000n, gasPrice: 1n, nonce: n };
    },
    async broadcast(raw) {
      broadcasts.push(raw);
      if (broadcasts.length === o.mineOnBroadcast) evm.mineNow(`0x${hex(sha256(Uint8Array.of(Number(BigInt(`0x${raw.slice(4)}`)))))}`);
      if (o.refuse) throw new RpcError(`eth_sendRawTransaction: ${o.refuse}`);
      const e = o.fail?.(broadcasts.length);
      if (e) throw e;
    },
    async receipt(hash) {
      return mined.get(hash) ?? null;
    },
    async waitReceipt(hash, timeoutMs = 100) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const r = await evm.receipt(hash);
        if (r) return r;
        if (Date.now() > end) throw new Error(`timed out waiting for the receipt of ${hash}`);
        await new Promise((res) => setTimeout(res, 5));
      }
    },
    async rpc<T>(method: string): Promise<T> {
      assert.equal(method, 'eth_getTransactionCount');
      return `0x${accountNonce.toString(16)}` as T;
    },
    mineNow(hash) {
      accountNonce++;
      const nonceTopic = `0x${(o.lockNonce ?? 7n).toString(16).padStart(64, '0')}`;
      mined.set(hash, { status: '0x1', transactionHash: hash, blockHash: `0x${'bb'.repeat(32)}`, blockNumber: '0x10', gasUsed: '0x5208', logs: [{ address: VAULT, topics: [LOCKED_TOPIC, nonceTopic], data: '0x' }] });
    },
    takeNonce() {
      accountNonce++;
    },
  };
  return { evm, broadcasts, signedCount: () => signed };
}

function memStore() {
  let v: PendingLock | null = null;
  return { get: () => v, put: (p: PendingLock) => void (v = structuredClone(p)), clear: () => void (v = null) };
}

test('lock: stored before the broadcast; a retry after a receipt timeout polls the same hash and sends no second lock', async () => {
  const me = burnerOf(2);
  const f = fakeEvm(me);
  const store = memStore();
  await assert.rejects(lock({ evm: f.evm, cfg: { vault: VAULT } }, me, 1000n, store, { timeoutMs: 30 }), /timed out/);
  const p = store.get();
  assert.ok(p, 'the pending lock is kept');
  assert.equal(p.amountWei, '1000');
  assert.deepEqual(f.broadcasts, [p.raw]);
  // it gets mined; the retry (another amount typed) resumes it
  f.evm.mineNow(p.hash);
  const l = await lock({ evm: f.evm, cfg: { vault: VAULT } }, me, 5n, store);
  assert.equal(f.signedCount(), 1, 'signed once');
  assert.equal(f.broadcasts.length, 1, 'a mined lock is not rebroadcast');
  assert.equal(l.resumed, true);
  assert.equal(l.nonce, 7n);
  assert.equal(l.amountWei, 1000n);
  assert.equal(l.lockTx, p.hash);
  assert.equal(store.get(), null, 'cleared once the receipt is read');
});

test('lock: an unmined pending lock is rebroadcast as the same bytes, then polled', async () => {
  const me = burnerOf(2);
  const f = fakeEvm(me, { mineOnBroadcast: 2 });
  const store = memStore();
  await assert.rejects(lock({ evm: f.evm, cfg: { vault: VAULT } }, me, 1000n, store, { timeoutMs: 20 }));
  const p = store.get()!;
  const l = await lock({ evm: f.evm, cfg: { vault: VAULT } }, me, 1000n, store);
  assert.deepEqual(f.broadcasts, [p.raw, p.raw]);
  assert.equal(f.signedCount(), 1);
  assert.equal(l.lockTx, p.hash);
});

test('lock: the pending lock is dropped when its account nonce is taken by another transaction, or the node refuses it', async () => {
  const me = burnerOf(2);
  const f = fakeEvm(me);
  const store = memStore();
  await assert.rejects(lock({ evm: f.evm, cfg: { vault: VAULT } }, me, 1000n, store, { timeoutMs: 10 }));
  f.evm.takeNonce();
  await assert.rejects(lock({ evm: f.evm, cfg: { vault: VAULT } }, me, 1000n, store), /used by another transaction/);
  assert.equal(store.get(), null);
  // a fresh lock that the node refuses outright leaves nothing pending
  const r = fakeEvm(me, { refuse: 'insufficient funds for gas * price + value' });
  await assert.rejects(lock({ evm: r.evm, cfg: { vault: VAULT } }, me, 1000n, store), /insufficient funds/);
  assert.equal(store.get(), null);
  // "already known" on a first broadcast is not a refusal: the lock stays pending
  const k = fakeEvm(me, { refuse: 'already known' });
  await assert.rejects(lock({ evm: k.evm, cfg: { vault: VAULT } }, me, 1000n, store, { timeoutMs: 10 }));
  assert.ok(store.get());
});

test('lock: mined just before the rebroadcast ("nonce too low"): the lock is kept and finished, never forgotten', async () => {
  const me = burnerOf(2);
  // broadcast 1: accepted, not mined in time; broadcast 2 (the resume): the transaction is mined first, the node answers nonce too low
  const f = fakeEvm(me, { mineOnBroadcast: 2, fail: (n) => (n === 2 ? new RpcError('eth_sendRawTransaction: nonce too low') : undefined) });
  const store = memStore();
  await assert.rejects(lock({ evm: f.evm, cfg: { vault: VAULT } }, me, 1000n, store, { timeoutMs: 10 }), /timed out/);
  const p = store.get()!;
  const l = await lock({ evm: f.evm, cfg: { vault: VAULT } }, me, 1000n, store);
  assert.equal(f.broadcasts.length, 2);
  assert.equal(l.lockTx, p.hash);
  assert.equal(l.nonce, 7n);
  assert.equal(f.signedCount(), 1);
});

test('lock: an ambiguous send (gateway timeout, a wrapped 5xx, "nonce too low" not yet visible) keeps the lock pending', async () => {
  const me = burnerOf(2);
  for (const err of [new RpcError('eth_sendRawTransaction: upstream request timeout'), new RpcError('eth_sendRawTransaction: 502 bad gateway'),
    new HttpError('eth_sendRawTransaction: HTTP 504: gateway timeout', 504), new RpcError('eth_sendRawTransaction: nonce too low'), new Error('fetch failed')]) {
    const f = fakeEvm(me, { fail: () => err });
    const store = memStore();
    await assert.rejects(lock({ evm: f.evm, cfg: { vault: VAULT } }, me, 1000n, store), (e: unknown) => e instanceof StillPendingError && /stays pending/.test(e.message), err.message);
    assert.ok(store.get(), `kept after: ${err.message}`);
    // the retry resumes it, and a node refusal while the nonce has not moved drops it
    const g = { ...f.evm, broadcast: async () => { throw new RpcError('eth_sendRawTransaction: transaction underpriced'); } };
    await assert.rejects(lock({ evm: g, cfg: { vault: VAULT } }, me, 1000n, store), /refuses the lock/);
    assert.equal(store.get(), null);
  }
});

test('discard: a pending transfer is discardable only when the aggregator has no proof for its state', async () => {
  const { w, bytes, me } = await held();
  let p: PendingTx | undefined;
  const refusing = fakeAgg(w, { status: 'REQUEST_EXPIRED', certifyAfter: Infinity });
  await assert.rejects(transfer({ agg: refusing.agg }, me, bytes, signer(3).publicKey, undefined, (x) => (p = x), FAST), /refused the request: REQUEST_EXPIRED/);
  assert.equal(await probePending(refusing.agg, p!), 'none');
  const certified = fakeAgg(w, { preset: CertificationData.fromCBOR(unhex(p!.cd)) });
  assert.equal(await probePending(certified.agg, p!), 'ours');
  let other: PendingTx | undefined;
  await assert.rejects(transfer({ agg: fakeAgg(w, { certifyAfter: Infinity }).agg }, me, bytes, signer(5).publicKey, undefined, (x) => (other = x), FAST));
  assert.equal(await probePending(fakeAgg(w, { preset: CertificationData.fromCBOR(unhex(other!.cd)) }).agg, p!), 'other');
});

// ---- handoff messages ----------------------------------------------------------------------------------------------------------------------
test('handoff: only well-formed messages are accepted', () => {
  const key = `02${'ab'.repeat(32)}`;
  assert.deepEqual(parseMessage({ type: 'who', from: 'a' }), { type: 'who', from: 'a' });
  assert.deepEqual(parseMessage({ type: 'hello', from: 'b', publicKey: key, evmAddress: VAULT, extra: 1 }), { type: 'hello', from: 'b', publicKey: key, evmAddress: VAULT });
  assert.ok(parseMessage({ type: 'token', from: 'a', to: 'b', bytes: 'd99880', amountWei: '1000' }));
  for (const bad of [
    null, 'x', 42, {}, { type: 'who' }, { type: 'who', from: '<script>' }, { type: 'nope', from: 'a' },
    { type: 'hello', from: 'b', publicKey: 'zz', evmAddress: VAULT }, { type: 'hello', from: 'b', publicKey: key, evmAddress: '0x12' },
    { type: 'token', from: 'a', to: 'b', bytes: 'xyz', amountWei: '1' }, { type: 'token', from: 'a', to: 'b', bytes: '', amountWei: '1' },
    { type: 'token', from: 'a', to: 'b', bytes: 'd998', amountWei: '-1' }, { type: 'token', from: 'a', to: 'b', bytes: 'd998', amountWei: 1 },
    { type: 'token', from: 'a', to: 7, bytes: 'd998', amountWei: '1' }, { type: 'token', from: 'a', to: 'b', bytes: 'a'.repeat(2_000_002), amountWei: '1' },
  ]) assert.equal(parseMessage(bad), null, JSON.stringify(bad)?.slice(0, 80));
});
