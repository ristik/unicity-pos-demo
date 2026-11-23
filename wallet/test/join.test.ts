import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import { TrustBaseUpdater } from '@unicitylabs/state-transition-sdk/lib/api/bft/trustbase/TrustBaseUpdater.js';
import { RootTrustBaseV2 } from '@unicitylabs/state-transition-sdk/lib/api/bft/trustbase/RootTrustBaseV2.js';
import { DataHasher } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/HashAlgorithm.js';
import { CborMap } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborMap.js';
import { CborMapEntry } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborMapEntry.js';
import { CborSerializer as C } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborSerializer.js';
import { TrustInput } from '@unicitylabs/native-bridge-plugin';
import { hex, unhex } from '../src/hex.js';
import { OriginFeed } from '../src/origin.js';
import { load } from '../src/store.js';
import { bootstrapTrust, refreshTrust, refreshWalletAuthority, withOrigin } from '../src/trust.js';
import { Chain } from '../src/pos/chain.js';
import { posAddresses } from '../src/pos/config.js';
import { fifthValidator, JoinEvidence } from '../src/pos/join.js';
import { FakeChain, makeConfig, makeRoot, NETWORK, roundNow } from './world.js';

test('a pinned 4 → 5 handoff locates the first UC with a valid new-member signature', async (t) => {
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
  const agg = new AggregatorClient('https://test.example');
  const { trust: bootstrapped } = await bootstrapTrust(agg, hex(old.pin), NETWORK, 'join-background.', old.bundle);
  const backgroundHeld = withOrigin(bootstrapped, held.origin!);
  const before = backgroundHeld.origin!.rootRound;
  const covering = backgroundHeld.withAuthenticatedOrigin({ usableEpoch: 1n, rootRound: before + 1n });
  let releaseHistory!: () => void;
  const background = new Promise<void>((resolve) => { releaseHistory = resolve; }).then(() => backgroundHeld.history.append(next));
  const available = await refreshWalletAuthority(backgroundHeld, () => background, {
    current: covering,
    refresh: async () => { throw new Error('unexpected checkpoint fetch'); },
  }, before);
  assert.equal(available.trust, covering);
  assert.equal(available.trust.history.tip?.epoch, 1n);
  releaseHistory();
  await background;
  assert.equal(available.trust.history.tip?.epoch, 2n);
  assert.equal(available.trust.origin?.rootRound, before + 1n);

  await t.test('a newly required authenticated epoch must be saved before the authority retry returns', async (t) => {
    const namespace = 'join-before-save.';
    const { trust } = await bootstrapTrust(agg, hex(old.pin), NETWORK, namespace, old.bundle);
    const initial = { usableEpoch: 1n, rootRound: start - 1n, blockNumber: 4, blockHash: `0x${'04'.repeat(32)}` };
    const previous = withOrigin(trust, initial);
    const binding = { network: NETWORK, generation: 'fixture', genesisHash: `0x${'ab'.repeat(32)}`, releaseSha256: 'cd'.repeat(32) };
    const feed = new OriginFeed(previous, binding, initial, new URL('https://test.example/release/nb2-origin.json'), {
      get: async () => null, put: async () => {}, delete: async () => {},
    });
    t.mock.method(globalThis, 'fetch', async () => Response.json({
      schema: 'unicity-nb2-origin', version: 1, ...binding, blockNumber: 5, blockHash: `0x${'05'.repeat(32)}`,
      usableEpoch: '2', rootRound: String(start),
    }));
    let appended!: () => void;
    let resume!: () => void;
    const appendedInMemory = new Promise<void>((resolve) => { appended = resolve; });
    const pause = new Promise<void>((resolve) => { resume = resolve; });
    t.mock.method(TrustBaseUpdater, 'update', async () => {
      await previous.history.append(next);
      appended();
      await pause;
      return 1;
    });
    const pending = refreshTrust(previous, agg);
    const savedTip = async () => (await TrustInput.fromBundle(unhex(load(`${namespace}trust.bundle`)!), old.pin)).history.tip?.epoch;
    let retry;
    try {
      await appendedInMemory;
      assert.equal(previous.history.tip?.epoch, 2n);
      assert.equal(await savedTip(), 1n);
      await feed.refresh();
      assert.equal(feed.current.origin?.usableEpoch, 2n);
      let returned = false;
      retry = refreshWalletAuthority(previous, () => refreshTrust(previous, agg), feed, initial.rootRound).then((result) => {
        returned = true;
        return result;
      });
      await setImmediate();
      assert.equal(returned, false, 'the in-memory tip alone must not unblock the retry');
    } finally {
      resume();
      await pending;
    }
    assert.equal((await retry).trust.origin?.rootRound, start);
    assert.equal(await savedTip(), 2n);
  });

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
