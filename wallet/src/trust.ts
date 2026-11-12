/**
 * The trust base (UTB) history: bootstrapped from the aggregator's `/api/v1/trustbases` pages under a genesis EntryID pinned out of band, every
 * later entry authenticated by its predecessor's committee (the SDK's TrustBaseHistory), persisted, and extended on demand.
 */
import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import { NetworkId } from '@unicitylabs/state-transition-sdk/lib/api/NetworkId.js';
import { TRUST_BASE_PAGE_LIMITS } from '@unicitylabs/state-transition-sdk/lib/api/bft/trustbase/TrustBaseRange.js';
import { TrustBaseHistory } from '@unicitylabs/state-transition-sdk/lib/api/bft/trustbase/TrustBaseHistory.js';
import { TrustBaseUpdater } from '@unicitylabs/state-transition-sdk/lib/api/bft/trustbase/TrustBaseUpdater.js';
import { findNoTrustBaseEntry } from '@unicitylabs/state-transition-sdk/lib/api/bft/verification/TrustBaseEntryResult.js';
import { ConsolidationError } from '@unicitylabs/state-transition-sdk/lib/consolidation/ConsolidationError.js';
import { VerificationResult } from '@unicitylabs/state-transition-sdk/lib/verification/VerificationResult.js';
import { NativeError, TrustInput } from '@unicitylabs/native-bridge-plugin';

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
const namespaces = new WeakMap<TrustInput, string>();

const persist = async (trust: TrustInput): Promise<void> => {
  const ns = namespaces.get(trust) ?? '';
  save(`${ns}trust.bundle`, hex(await trust.history.toBundle()));
  save(`${ns}trust.pin`, hex(trust.id));
};

/**
 * The held history: the stored bundle when it is under the same pin, else fetched from the aggregator from epoch 1. A complete first page
 * decodes as a bundle; otherwise the SDK's updater pages through from the genesis.
 */
export async function bootstrapTrust(agg: AggregatorClient, pinHex: string, network: number, ns = ''): Promise<{ trust: TrustInput; source: 'stored' | 'fetched' }> {
  const pin = unhex(pinHex);
  if (pin.length !== 32) throw new Error('the trust pin must be a 32-byte genesis EntryID');
  const stored = load(`${ns}trust.bundle`);
  if (stored && load(`${ns}trust.pin`) === hex(pin)) {
    try {
      const trust = await TrustInput.fromBundle(unhex(stored), pin);
      namespaces.set(trust, ns);
      return { trust, source: 'stored' };
    } catch {
      /* a stale or damaged copy: fetch again */
    }
  }
  const net = NetworkId.fromId(network);
  let trust: TrustInput;
  try {
    trust = await TrustInput.fromBundle(await agg.getTrustBasePage({ fromEpoch: 1n, maxEntries: 64, network: net, snapshot: null }), pin);
  } catch {
    const history = TrustBaseHistory.create(pin);
    await TrustBaseUpdater.update(history, [agg], { network: net, limits: { ...TRUST_BASE_PAGE_LIMITS, maxEntries: 64 } });
    trust = await TrustInput.fromBundle(await history.toBundle(), pin);
  }
  namespaces.set(trust, ns);
  await persist(trust);
  return { trust, source: 'fetched' };
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

/**
 * True when a verification failed only for want of a newer trust-base entry: the plug-in's ErrNoEntryForEpoch, or an SDK consolidation
 * integrity error whose trace names a missing epoch (nbp src/trustrefresh.ts needsNewerEntry; that module is not in the package's exports).
 */
export function needsNewerEntry(e: unknown): boolean {
  if (e instanceof NativeError) return e.reason === 'ErrNoEntryForEpoch';
  return e instanceof ConsolidationError && e.kind === 'integrity' && e.cause instanceof VerificationResult && findNoTrustBaseEntry(e.cause) !== null;
}

/**
 * Run `verify`; while it fails for want of a newer entry, fetch the entries after the held tip, persist them and run it again (at most
 * `attempts` runs). `verify` must only verify: a retry never resubmits anything. A port of nbp src/trustrefresh.ts withTrustRefresh.
 */
export async function withTrustRefresh<T>(trust: TrustInput, agg: AggregatorClient, verify: () => Promise<T>, onFetch?: (appended: number, tip: bigint) => void, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await verify();
    } catch (e) {
      if (!needsNewerEntry(e) || attempt >= attempts) throw e;
    }
    const n = await refreshTrust(trust, agg);
    onFetch?.(n, trust.history.tip?.epoch ?? 0n);
    if (n === 0) await new Promise((r) => setTimeout(r, 2000));
  }
}
