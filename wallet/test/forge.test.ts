/**
 * The verify and forgery paths on the plug-in's synthetic world (test/world.ts): a genuine token verifies; its certificates re-signed by
 * unknown keys fail the quorum; its seals re-labelled outside their epoch fail the epoch rule; the handoff check wants the right owner.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NativeBridge } from '@unicitylabs/native-bridge-plugin';
import { Token } from '@unicitylabs/state-transition-sdk/lib/transaction/Token.js';

import { appendTransaction } from '../src/bridge.js';
import { forgeRelabelled, forgeUnknownKeys, relabelTarget, sealTable, verdict } from '../src/forge.js';
import { acceptToken } from '../src/handoff.js';
import { hex } from '../src/hex.js';
import { buildToken, makeWorld, nextEpoch, signer, spec, txStep } from './world.js';

const T0 = 1_700_000_040n;
const UC_TS = 1_700_000_900n;

async function held() {
  const w = await makeWorld();
  // minted to signer(1), transferred to signer(2); every certificate: epoch 2 (the genesis), round 900
  const out = await buildToken(w, spec(1), [txStep(2, 7, T0 + 10n)], T0, UC_TS);
  return { w, out };
}

test('the genuine token verifies, and its seals lie in the held epoch', async () => {
  const { w, out } = await held();
  assert.deepEqual(await verdict(w.bridge, out.bytes), { ok: true });
  const rows = await sealTable(out.bytes, w.agg.trust);
  assert.deepEqual(rows.map((r) => [r.step, r.epoch, r.round, r.inInterval]), [['mint', 2n, 900n, true], ['tx 1', 2n, 900n, true]]);
});

test('unknown keys under the genuine signer ids: ErrQuorumNotMet', async () => {
  const { w, out } = await held();
  const forged = await forgeUnknownKeys(out.bytes);
  assert.notEqual(hex(forged), hex(out.bytes));
  const v = await verdict(w.bridge, forged);
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.reason, 'ErrQuorumNotMet');
});

test('re-labelled before the genesis epoch (only the genesis held): ErrSealEpoch', async () => {
  const { w, out } = await held();
  const f = await forgeRelabelled(out.bytes, w.agg.trust);
  assert.match(f.why[0], /before the genesis/);
  const v = await verdict(w.bridge, f.bytes);
  assert.equal(!v.ok && v.reason, 'ErrSealEpoch');
});

test('after a rotation: the old-epoch token still verifies, and a seal moved past its epoch\'s end is ErrSealEpoch', async () => {
  const { w, out } = await held();
  const r3 = await nextEpoch(w.agg, 1000n, 4, 30);
  const bridge = new NativeBridge(w.bridge.registry, r3.trust);
  assert.deepEqual(await verdict(bridge, out.bytes), { ok: true });
  const rows = await sealTable(out.bytes, r3.trust);
  assert.deepEqual(rows[0].entry, { start: 1n, end: 1000n });
  assert.deepEqual(relabelTarget(r3.trust, 2n, 900n).round, 1000n);
  const f = await forgeRelabelled(out.bytes, r3.trust);
  assert.match(f.why[0], /ended at round 1000/);
  const v = await verdict(bridge, f.bytes);
  assert.equal(!v.ok && v.reason, 'ErrSealEpoch');
  assert.equal((await sealTable(f.bytes, r3.trust)).every((r) => !r.inInterval), true);
});

test('handoff: the owner accepts, another key is refused', async () => {
  const { w, out } = await held();
  const r = await acceptToken(w.bridge, hex(out.bytes), signer(2).publicKey);
  assert.equal(r.verified.outcome.nonce, 1n);
  await assert.rejects(acceptToken(w.bridge, hex(out.bytes), signer(1).publicKey), /another key/);
});

test('appendTransaction keeps the token decodable and one longer', async () => {
  const { out } = await held();
  const t = await Token.fromCBOR(out.bytes);
  const last = t.transactions[0];
  const longer = appendTransaction(out.bytes, Uint8Array.of(0xf6), last.inclusionProof.toCBOR());
  assert.ok(longer.length > out.bytes.length);
  assert.throws(() => appendTransaction(Uint8Array.of(0xc0, 0x00), new Uint8Array(), new Uint8Array()), /not a token/);
});
