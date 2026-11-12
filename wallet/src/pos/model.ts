/**
 * What the visualizer reads, tier by tier, as plain typed views. Each read function takes the call log of the panel it feeds (its explain
 * drawer). Nothing here writes: every call is an eth_call against `latest`.
 */
import { keccakHex, signingBinding, type Value } from './abi.js';
import { arr, big, isZero, obj, str, type CallRecord, type Chain } from './chain.js';
import type { FnName } from './contracts.js';
import type { Member } from './rules.js';

type Log = CallRecord[];
const o = (v: Value): Record<string, Value> => obj(v);

// ---- tier 1: the clock and the pointers (every poll) -------------------------------------------------------------------------------------------
export interface Clock {
  block: bigint;
  progress: bigint;
  ucTime: bigint;
  recordCount: bigint;
  nextStakingID: bigint;
  lastAck: string;
  openResult: string;
  lastAttemptResult: string;
  attemptCursor: bigint;
  dueProgress: bigint;
  dueTime: bigint;
  liveCount: bigint;
  /** when it was read (local ms) */
  at: number;
}

export async function readClock(c: Chain, log: Log): Promise<Clock> {
  const block = BigInt(await c.raw<string>('eth_blockNumber'));
  log.push({ role: 'registry', address: '(rpc)', sig: 'eth_blockNumber', args: [], value: block, cached: false, ms: 0, at: Date.now() });
  const g = <T extends Value>(n: FnName, a: (bigint | number | string)[] = []): Promise<T> => c.call<T>(n, a, log);
  const progress = big(await g('progress'));
  const ucTime = big(await g('ucTime'));
  const recordCount = big(await g('recordCount'));
  const nextStakingID = big(await g('nextStakingID'));
  const lastAck = str(await g('lastAckedAssignment'));
  const openResult = str(await g('openResult'));
  const lastAttemptResult = str(await g('lastAttemptResult'));
  const attemptCursor = big(await g('attemptCursor'));
  const th = o(await g('thresholds'));
  const liveCount = big(await g('liveCount'));
  return { block, progress, ucTime, recordCount, nextStakingID, lastAck, openResult, lastAttemptResult, attemptCursor, dueProgress: big(th.progress), dueTime: big(th.ucTime), liveCount, at: Date.now() };
}

/** The pointers whose change makes the slow tier re-read at once. */
export const clockKey = (k: Clock): string => [k.recordCount, k.nextStakingID, k.lastAck, k.openResult, k.lastAttemptResult, k.attemptCursor, k.liveCount].join('|');

// ---- the committee (an assignment's exposures) --------------------------------------------------------------------------------------------------
export interface Exposure {
  exposureID: string;
  id: bigint;
  generation: bigint;
  weight: bigint;
  rawWeight: bigint;
  rootKeyHash: string;
  evmKeyHash: string;
  payee: string;
  referencesReleased: boolean;
  binding: string;
}

export interface Committee {
  assignmentID: string;
  state: bigint;
  rootEpoch: bigint;
  evmEpoch: bigint;
  firstRound: bigint;
  offset: bigint;
  closed: boolean;
  policyID: bigint;
  members: Exposure[];
}

export async function readCommittee(c: Chain, assignmentID: string, log: Log): Promise<Committee> {
  const a = o(await c.call('assignments', [assignmentID], log));
  const ids = arr(await c.call('assignmentExposures', [assignmentID], log)).map(str);
  const members: Exposure[] = [];
  for (const eid of ids) {
    const e = o(await c.call('exposures', [eid], log));
    members.push({
      exposureID: eid, id: big(e.id), generation: big(e.generation), weight: big(e.weight), rawWeight: big(e.rawWeight), rootKeyHash: str(e.rootKeyHash),
      evmKeyHash: str(e.evmKeyHash), payee: str(e.operatorPayee), referencesReleased: e.referencesReleased === true, binding: signingBinding(str(e.rootKeyHash), str(e.evmKeyHash)),
    });
  }
  members.sort((x, y) => (x.id < y.id ? -1 : 1));
  return {
    assignmentID, state: big(a.state), rootEpoch: big(a.rootEpoch), evmEpoch: big(a.evmEpoch), firstRound: big(a.firstRound), offset: big(a.offset),
    closed: a.closed === true, policyID: big(a.policyID), members,
  };
}

export const asMembers = (cm: Committee): Member[] => cm.members.map((m) => ({ id: m.id, binding: m.binding, weight: m.weight }));

// ---- identities --------------------------------------------------------------------------------------------------------------------------------
export interface Lot {
  lotID: bigint;
  initial: bigint;
  remaining: bigint;
  penalized: bigint;
  category: bigint;
  refCount: bigint;
  holdUntil: bigint;
  evidenceUntil: bigint;
  timeUntil: bigint;
}

export interface Identity {
  id: bigint;
  owner: string;
  withdrawal: string;
  rootKeyHash: string;
  stagedRootKeyHash: string;
  generation: bigint;
  roleNonce: bigint;
  openLots: bigint;
  lotCount: bigint;
  retirementRequested: boolean;
  lots: Lot[];
  principal: bigint;
  indexed: boolean;
  excluded: boolean;
  retirement: { imported: boolean; pRet: bigint; tRet: bigint } | null;
  delegation: { rootNodeID: string; rootKey: string; evmNodeID: string; evmKey: string; payee: string; bindingHash: string; rootKeyHash: string; evmKeyHash: string } | null;
  /** custody registered the delegated EVM key to this identity (keyOwner(evmKeyHash) = (id, EVM role 2)) */
  evmKeyRegistered: boolean;
}

/** keyOwner results that are final (a key, once registered, is tombstoned to its identity forever) */
const keyOwnerFinal = new Map<string, boolean>();
const excludedFinal = new Set<bigint>();

export async function readIdentity(c: Chain, id: bigint, log: Log): Promise<Identity> {
  const p = o(await c.call('positions', [id], log));
  const generation = big(p.generation);
  const lotIDs = arr(await c.call('generationLots', [id, generation], log)).map(big);
  const lots: Lot[] = [];
  for (const lotID of lotIDs) {
    const l = o(await c.call('lots', [lotID], log));
    lots.push({ lotID, initial: big(l.initial), remaining: big(l.remaining), penalized: big(l.penalized), category: big(l.category), refCount: big(l.refCount), holdUntil: big(l.holdUntil), evidenceUntil: big(l.evidenceUntil), timeUntil: big(l.timeUntil) });
  }
  const retirementRequested = p.retirementRequested === true;
  let retirement: Identity['retirement'] = null;
  if (retirementRequested) {
    const r = o(await c.call('retirements', [id, generation], log));
    retirement = { imported: r.imported === true, pRet: big(r.pRet), tRet: big(r.tRet) };
  }
  const indexed = (await c.call('isIndexed', [id], log)) === true;
  const excluded = excludedFinal.has(id) || (await c.call('excluded', [id], log)) === true;
  if (excluded) excludedFinal.add(id);
  const d = o(await c.call('delegation', [id, generation], log));
  const b = o(d.binding);
  let delegation: Identity['delegation'] = null;
  let evmKeyRegistered = false;
  if (!isZero(str(d.bindingHash))) {
    delegation = {
      rootNodeID: str(b.rootNodeID), rootKey: str(b.rootKey), evmNodeID: str(b.evmNodeID), evmKey: str(b.evmKey), payee: str(b.operatorPayee), bindingHash: str(d.bindingHash),
      rootKeyHash: keccakHex(str(b.rootKey)), evmKeyHash: keccakHex(str(b.evmKey)),
    };
    const k = `${id}:${delegation.evmKeyHash}`;
    if (keyOwnerFinal.has(k)) evmKeyRegistered = keyOwnerFinal.get(k)!;
    else {
      const ko = o(await c.call('keyOwner', [delegation.evmKeyHash], log));
      evmKeyRegistered = big(ko.id) === id && big(ko.role) === 2n;
      if (evmKeyRegistered) keyOwnerFinal.set(k, true);
    }
  }
  return {
    id, owner: str(p.owner), withdrawal: str(p.withdrawal), rootKeyHash: str(p.rootKeyHash), stagedRootKeyHash: str(p.stagedRootKeyHash), generation, roleNonce: big(p.roleNonce),
    openLots: big(p.openLots), lotCount: big(p.lotCount), retirementRequested, lots, principal: lots.filter((l) => l.category !== 4n).reduce((a, l) => a + l.remaining, 0n),
    indexed, excluded, retirement, delegation, evmKeyRegistered,
  };
}

/**
 * Primary eligibility as ElectionPolicy._eligible and EligibilityReader.positions/weights judge it at a snapshot: a live position (no
 * retirement request, not excluded), a delegation of the open generation whose root key is the current or staged one, an EVM key custody
 * registered to it, and a principal of at least B_min with weight floor(principal / U_bond) > 0. Returns the reasons it is not.
 */
export function ineligibility(i: Identity, bondUnit: bigint, minBond: bigint): string[] {
  const why: string[] = [];
  if (i.owner === `0x${'0'.repeat(40)}`) why.push('no position');
  if (i.retirementRequested) why.push('retirement requested');
  if (i.excluded) why.push('excluded (evidence)');
  if (!i.indexed) why.push('not in the live index (no bond?)');
  if (!i.delegation) why.push('no delegation (admitDelegation) for its generation');
  else {
    if (i.delegation.rootKeyHash !== i.rootKeyHash && (isZero(i.stagedRootKeyHash) || i.delegation.rootKeyHash !== i.stagedRootKeyHash)) why.push('delegated root key is not its root key');
    if (!i.evmKeyRegistered) why.push('EVM key not registered in custody');
  }
  if (i.principal < minBond) why.push(`principal below B_min`);
  else if (bondUnit > 0n && i.principal / bondUnit === 0n) why.push('weight 0');
  return why;
}

export const rawWeight = (i: Identity, bondUnit: bigint): bigint => (bondUnit > 0n ? i.principal / bondUnit : 0n);
export const eligibleMember = (i: Identity): Member => ({ id: i.id, binding: signingBinding(i.delegation!.rootKeyHash, i.delegation!.evmKeyHash), weight: 0n });

// ---- election results and the record log --------------------------------------------------------------------------------------------------------
export interface ResultView {
  id: string;
  state: bigint;
  reason: bigint;
  attempt: bigint;
  progress: bigint;
  ucTime: bigint;
  predecessor: string;
  assignmentID: string;
}

export async function readResult(c: Chain, id: string, log: Log): Promise<ResultView> {
  const r = o(await c.call('result', [id], log));
  return { id, state: big(r.state), reason: big(r.reason), attempt: big(r.attempt), progress: big(r.progress), ucTime: big(r.ucTime), predecessor: str(r.predecessor), assignmentID: str(r.assignmentID) };
}

export interface OpenResult extends ResultView {
  frozen: { id: bigint; weight: bigint; raw: bigint }[];
  published: boolean;
  popCount: bigint;
  lost: boolean;
  /** the reserved candidate as continuity members (EligibilityReader.committed over its exposures) */
  candidate: Member[];
}

export async function readOpenResult(c: Chain, id: string, log: Log): Promise<OpenResult> {
  const r = await readResult(c, id, log);
  const frozen = arr(await c.call('frozenMembers', [id], log)).map((f) => ({ id: big(o(f).id), weight: big(o(f).weight), raw: big(o(f).raw) }));
  const pub = o(await c.call('publication', [id], log));
  const candidate = arr(await c.call('committed', [r.assignmentID], log)).map((m) => ({ id: big(o(m).id), binding: str(o(m).binding), weight: big(o(m).weight) }));
  return { ...r, frozen, published: pub.published === true, popCount: big(pub.popCount), lost: pub.lost === true, candidate };
}

export interface RecordView {
  index: bigint;
  kind: bigint;
  progress: bigint;
  ucTime: bigint;
  /** the first data word: a resultID (SessionClosed, Ack, RecoveryAck), an assignmentID (Closure) or a StakingID (Retirement) */
  subject: string;
}

export async function readRecord(c: Chain, i: bigint, log: Log): Promise<RecordView> {
  const r = o(o(await c.call('recordAt', [i], log)).r);
  const data = str(r.data);
  return { index: big(r.index), kind: big(r.kind), progress: big(r.progress), ucTime: big(r.ucTime), subject: data.length >= 66 ? `0x${data.slice(2, 66)}` : data };
}

// ---- meta-parameters ---------------------------------------------------------------------------------------------------------------------------
export interface Params {
  bondUnit: bigint;
  minBond: bigint;
  limits: Record<string, Value>;
  election: Record<string, Value>;
  vMax: bigint;
  policy: Record<string, Value>;
  policyID: bigint;
  rewardRate: bigint;
  pending: Record<string, Value>;
  delayRounds: bigint;
  delaySeconds: bigint;
  rewardAvailable: bigint;
  rewardCredits: bigint;
  totals: { free: bigint; encumbered: bigint; draining: bigint };
}

export async function readParams(c: Chain, log: Log): Promise<Params> {
  const g = (n: FnName): Promise<Value> => c.call(n, [], log);
  return {
    bondUnit: big(await g('bondUnit')),
    minBond: big(await g('minBond')),
    limits: o(await g('limits')),
    election: o(await g('params')),
    vMax: big(await g('vMax')),
    policy: o(o(await g('policy')).p),
    policyID: big(await g('currentPolicyID')),
    rewardRate: big(await g('currentRewardRate')),
    pending: o(await g('pending')),
    delayRounds: big(await g('DELAY_ROUNDS')),
    delaySeconds: big(await g('DELAY_SECONDS')),
    rewardAvailable: big(await g('rpAvailable')),
    rewardCredits: big(await g('rpTotalCredits')),
    totals: { free: big(await g('totalFree')), encumbered: big(await g('totalEncumbered')), draining: big(await g('totalDraining')) },
  };
}

/** The modules the election names (immutable): fills the reader, evidence and policy-source addresses. */
export async function discover(c: Chain, log: Log): Promise<void> {
  c.addresses.reader = str(await c.call('reader', [], log));
  c.addresses.evidence = str(await c.call('evidence', [], log));
  c.addresses.governance = str(await c.call('policySource', [], log));
}
