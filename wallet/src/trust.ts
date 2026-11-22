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
import type { OriginFeed } from './origin.js';
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
const namespaces = new WeakMap<TrustInput, string>();

const persist = async (trust: TrustInput): Promise<void> => {
  const ns = namespaces.get(trust) ?? '';
  save(`${ns}trust.bundle`, hex(await trust.history.toBundle()));
  save(`${ns}trust.pin`, hex(trust.id));
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
      namespaces.set(trust, ns);
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
  namespaces.set(trust, ns);
  await persist(trust);
  return { trust, source };
}

/** Fetch the entries after the held tip (each authenticated from its predecessor) and persist; returns how many were appended. */
export async function refreshTrust(trust: TrustInput, agg: AggregatorClient): Promise<number> {
  const before = trust.history.tip?.epoch ?? 0n;
  try {
    const n = await TrustBaseUpdater.update(trust.history, [agg], { limits: { ...TRUST_BASE_PAGE_LIMITS, maxEntries: 64 } });
    if (n > 0) await persist(trust);
    return n;
  } catch (e) {
    // an authenticated prefix stays held: keep it
    if ((trust.history.tip?.epoch ?? 0n) > before) await persist(trust);
    throw e;
  }
}

/** Attempt both authorities independently and return whatever authenticated progress was made. */
export async function refreshWalletAuthority(
  trust: TrustInput,
  refreshHistory: () => Promise<unknown>,
  checkpoint?: Pick<OriginFeed, 'current' | 'refresh'>,
  waitFromRound?: bigint,
): Promise<{ trust: TrustInput; entriesAdded: number; historyFailed: boolean; checkpointFailed: boolean }> {
  const previousLength = trust.history.entries.length;
  const [historyResult, firstCheckpoint] = await Promise.allSettled([
    (async () => refreshHistory())(),
    (async () => checkpoint?.refresh())(),
  ]);
  const entriesAdded = trust.history.entries.length - previousLength;
  let checkpointFailed = firstCheckpoint.status === 'rejected';
  if (checkpoint && !checkpointFailed && entriesAdded === 0 && waitFromRound !== undefined &&
      (checkpoint.current.origin?.rootRound ?? 0n) <= waitFromRound) {
    try { await checkpoint.refresh(true); } catch { checkpointFailed = true; }
  }
  return {
    trust: checkpoint?.current ?? trust,
    entriesAdded,
    historyFailed: historyResult.status === 'rejected',
    checkpointFailed,
  };
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

/** Attach independently authenticated B1 authority while preserving the history's storage scope. */
export function withOrigin(trust: TrustInput, origin: NonNullable<TrustInput['origin']>): TrustInput {
  const next = trust.withAuthenticatedOrigin(origin);
  namespaces.set(next, namespaces.get(trust) ?? '');
  return next;
}
