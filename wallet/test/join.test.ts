import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RootTrustBaseV2 } from '@unicitylabs/state-transition-sdk/lib/api/bft/trustbase/RootTrustBaseV2.js';
import { DataHasher } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/HashAlgorithm.js';
import { CborMap } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborMap.js';
import { CborMapEntry } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborMapEntry.js';
import { CborSerializer as C } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborSerializer.js';
import { refreshWalletAuthority } from '../src/trust.js';
import { Chain } from '../src/pos/chain.js';
import { posAddresses } from '../src/pos/config.js';
import { fifthValidator, JoinEvidence } from '../src/pos/join.js';
import { FakeChain, makeConfig, makeRoot, NETWORK, roundNow } from './world.js';

test('a pinned 4 → 5 handoff locates the first UC with a valid new-member signature', async () => {
  const old = await makeRoot(4);
  const joined = await makeRoot(5);
  const chain = await FakeChain.create(old, makeConfig(old));
  for (let n = 0; n < 6; n++) await chain.mine([]);
  const last = chain.blocks.at(-1)!.header.number;
  const start = roundNow() + 1n;
  const uint = C.encodeUnsignedInteger;
  const fields = [
    uint(2n), uint(BigInt(NETWORK)), uint(2n), uint(start),
    C.encodeArray(...joined.signers.map(([id, s]) => C.encodeArray(C.encodeTextString(id), C.encodeByteString(s.publicKey), uint(1n)))),
    uint(4n), C.encodeNull(), C.encodeNull(), C.encodeByteString(old.pin),
  ];
  const entry = (signatures: Uint8Array) => C.encodeTag(39000n, C.encodeArray(...fields, signatures));
  const hash = await new DataHasher(HashAlgorithm.SHA256).update(entry(C.encodeNull())).digest();
  const signatures = await Promise.all(old.signers.slice(0, 3).map(async ([id, key]) =>
    new CborMapEntry(C.encodeTextString(id), C.encodeByteString((await key.sign(hash)).encode()))));
  const held = old.trust;
  const next = RootTrustBaseV2.decode(entry(C.encodeMap(new CborMap(signatures))));
  const refreshed = await refreshWalletAuthority(held, async () => held.history.append(next), {
    current: held,
    refresh: async () => { throw new Error('B1 checkpoint HTTP 503'); },
  }, held.origin?.rootRound);
  assert.equal(refreshed.entriesAdded, 1);
  assert.equal(refreshed.historyFailed, false);
  assert.equal(refreshed.checkpointFailed, true);
  assert.equal(refreshed.trust.history.tip?.epoch, 2n);
  assert.deepEqual(refreshed.trust.origin, held.origin);

  // The first UC in epoch two can reach quorum with just the four incumbents.
  chain.certificateAuthority = { root: old, epoch: 2n };
  await chain.mine([]);
  chain.certificateAuthority = { root: joined, epoch: 2n };
  await chain.mine([]);
  await chain.mine([]);

  const handoff = fifthValidator(old.trust);
  assert.equal(handoff?.member.nodeId, joined.signers.at(-1)?.[0]);
  assert.equal(handoff?.next.signatures?.size, 3);
  const evidence = new JoinEvidence(new Chain('', posAddresses(), 0, { rpc: (method, args) => chain.call(method, args ?? []) }));
  for (let n = 0; n < 5 && !evidence.first; n++) await evidence.poll(old.trust, handoff!);
  assert.equal(evidence.first?.block, last + 1n);
  assert.equal(evidence.first?.round, start + 1n);
});
