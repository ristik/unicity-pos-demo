/**
 * The trust base (UTB) history: bootstrapped from the aggregator's `/api/v1/trustbases` pages under a genesis EntryID pinned out of band, every
 * later entry authenticated by its predecessor's committee (the SDK's TrustBaseHistory), persisted, and extended on demand.
 */
import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import { NetworkId } from '@unicitylabs/state-transition-sdk/lib/api/NetworkId.js';
import { TRUST_BASE_PAGE_LIMITS } from '@unicitylabs/state-transition-sdk/lib/api/bft/trustbase/TrustBaseRange.js';
import { TrustBaseHistory } from '@unicitylabs/state-transition-sdk/lib/api/bft/trustbase/TrustBaseHistory.js';
import { TrustBaseUpdater } from '@unicitylabs/state-transition-sdk/lib/api/bft/trustbase/TrustBaseUpdater.js';
import { TrustInput } from '@unicitylabs/native-bridge-plugin';

import { hex, unhex } from './hex.js';
import { load, save } from './store.js';

export interface EntryView {
  epoch: bigint;
  entryId: string;
  startRound: bigint;
  /** the round the next held entry starts at (this epoch's end), if any */
  endRound: bigint | null;
  quorum: bigint;
  totalWeight: bigint;
  members: { nodeId: string; weight: bigint; key: string }[];
}

/** The storage prefix each held history persists under ('' for the wallet; another page passes its own, so it never writes the wallet's keys). */
const namespaces = new WeakMap<TrustBaseHistory, string>();
const refreshing = new WeakMap<TrustBaseHistory, Promise<number>>();
const savedEpochs = new WeakMap<TrustBaseHistory, bigint>();
const savedEpoch = (history: TrustBaseHistory): bigint => savedEpochs.get(history) ?? 0n;

const persist = async (trust: TrustInput): Promise<void> => {
  const ns = namespaces.get(trust.history) ?? '';
  // toBundle snapshots the entries synchronously. Record the tip of that
  // snapshot, since further appends may occur while encoding it.
  const epoch = trust.history.tip?.epoch ?? 0n;
  save(`${ns}trust.bundle`, hex(await trust.history.toBundle()));
  save(`${ns}trust.pin`, hex(trust.id));
  savedEpochs.set(trust.history, epoch);
};

/**
 * The held history: the stored bundle when it is under the same pin, else the operator's shipped bundle (nb2-release.json's, when given),
 * else fetched from the aggregator from epoch 1. A complete first page decodes as a bundle; otherwise the SDK's updater pages through from
 * the genesis. Every source is verified under the pin: the shipped bundle is only a convenience, never the trust root. When both a stored
 * history and a shipped bundle exist, the shipped entries are appended to the stored history (a held epoch with the same EntryID is a replay,
 * a conflicting one is refused: the history is never replaced).
 */
export async function bootstrapTrust(agg: AggregatorClient, pinHex: string, network: number, ns = '', shipped?: Uint8Array): Promise<{ trust: TrustInput; source: 'stored' | 'shipped' | 'fetched' }> {
  const pin = unhex(pinHex);
  if (pin.length !== 32) throw new Error('the trust pin must be a 32-byte genesis EntryID');
  const stored = load(`${ns}trust.bundle`);
  if (stored && load(`${ns}trust.pin`) === hex(pin)) {
    try {
      const trust = await TrustInput.fromBundle(unhex(stored), pin);
      namespaces.set(trust.history, ns);
      savedEpochs.set(trust.history, trust.history.tip?.epoch ?? 0n);
      if (shipped) {
        const s = await TrustInput.fromBundle(shipped, pin);
        for (const e of s.history.entries) await trust.history.append(e);
        await persist(trust);
      }
      return { trust, source: 'stored' };
    } catch {
      /* a stale or damaged copy: start over */
    }
  }
  const net = NetworkId.fromId(network);
  let trust: TrustInput;
  let source: 'shipped' | 'fetched' = 'shipped';
  if (shipped) {
    trust = await TrustInput.fromBundle(shipped, pin);
  } else {
    source = 'fetched';
    try {
      trust = await TrustInput.fromBundle(await agg.getTrustBasePage({ fromEpoch: 1n, maxEntries: 64, network: net, snapshot: null }), pin);
    } catch {
      const history = TrustBaseHistory.create(pin);
      await TrustBaseUpdater.update(history, [agg], { network: net, limits: { ...TRUST_BASE_PAGE_LIMITS, maxEntries: 64 } });
      trust = await TrustInput.fromBundle(await history.toBundle(), pin);
    }
  }
  namespaces.set(trust.history, ns);
  await persist(trust);
  return { trust, source };
}

/** Fetch the entries after the held tip (each authenticated from its predecessor) and persist; returns how many were appended. */
export function refreshTrust(trust: TrustInput, agg: AggregatorClient, signal?: AbortSignal): Promise<number> {
  const pending = refreshing.get(trust.history);
  if (pending) return pending;
  const update = updateHistory(trust, agg, signal ?? AbortSignal.timeout(15_000)).finally(() => refreshing.delete(trust.history));
  refreshing.set(trust.history, update);
  return update;
}

async function updateHistory(trust: TrustInput, agg: AggregatorClient, signal: AbortSignal): Promise<number> {
  try {
    return await TrustBaseUpdater.update(trust.history, [agg], { signal, limits: { ...TRUST_BASE_PAGE_LIMITS, maxEntries: 64 } });
  } finally {
    // Save any authenticated prefix, even when a later page fails.
    if ((trust.history.tip?.epoch ?? 0n) > savedEpoch(trust.history)) await persist(trust);
  }
}

export async function entries(trust: TrustInput): Promise<EntryView[]> {
  const h = trust.history;
  return Promise.all(h.entries.map(async (e) => ({
    epoch: e.epoch,
    entryId: hex(await e.entryId()),
    startRound: e.epochStartRound,
    endRound: h.epochEndRound(e.epoch),
    quorum: e.quorumThreshold,
    totalWeight: e.totalWeight,
    members: e.members.map((m) => ({ nodeId: m.nodeId, weight: m.weight, key: hex(m.sigKey) })),
  })));
}
