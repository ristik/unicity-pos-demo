/**
 * The validator registry (VR) read model. VR is the system contract at 0xff..03 that holds the identities, the committee in force, the open
 * output and the governance queue. The election logic is a pluggable module whose address VR names (`activeModule()`): PoA (`PoaElection`,
 * the Foundation multisig admits and removes validators) is the intermediate mode before PoS (`PosElectionAdapter` over the P85 stack).
 * Everything here is eth_call against `latest`, through the same polite queue as the rest of the page, and every call is recorded for the
 * explain drawers.
 */
import { decode } from './abi.js';
import { big, isZero, num, obj, arr, str, type CallRecord, type Chain } from './chain.js';
import { CHANGE_KIND, CHANGE_PAYLOAD, CHANGE_STATE, MIN_EPOCH_GAP, POA_ACTION, POA_TAG, type FnName } from './contracts.js';
import type { Value } from './abi.js';

type Log = CallRecord[];
export const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const isZeroAddress = (a: string): boolean => a.toLowerCase() === ZERO_ADDRESS;

/**
 * - `poa`: the active module is PoaElection (its moduleTag is keccak256("unicity.vr.poa.v1")): the intermediate mode before PoS
 * - `pos`: the module is not PoA and names a liability holder (custody): the PosElectionAdapter over P85
 * - `other`: some other module; `none`: no VR at the address (a network that predates it)
 */
export type Mode = 'poa' | 'pos' | 'other' | 'none';

export interface Member {
  id: bigint;
  generation: bigint;
  weight: bigint;
  rawWeight: bigint;
  rootNodeWord: string;
  rootKeyHash: string;
  evmNodeWord: string;
  evmKeyHash: string;
  payee: string;
  exposureDigest: string;
}

export interface ModuleInfo {
  address: string;
  codeHash: string;
  tag: string;
  capabilities: bigint;
  maxElectionInterval: bigint;
  gasBounds: bigint[];
  liabilityHolder: string;
  health: bigint;
  workPending: boolean;
  workSince: bigint;
  stallDeadline: bigint;
}

export interface VrConfig {
  network: string;
  governor: string;
  nMin: bigint; nTarget: bigint; nMax: bigint; vMax: bigint; lMax: bigint; rMax: bigint; maxBatch: bigint;
  feesPrevious: { baseFeeFloor: bigint; changeDenominator: bigint; feeCollector: string };
  feesCurrent: { baseFeeFloor: bigint; changeDenominator: bigint; feeCollector: string };
  feesEffectiveBlock: bigint;
  delayRounds: bigint; delaySeconds: bigint; knownRootEpoch: bigint; epochStartProgress: bigint;
  maxGas: bigint; systemGas: bigint; continuityMaxM: bigint; continuityDistNum: bigint; continuityDistDen: bigint;
}

export interface OutputView {
  id: string;
  state: bigint;
  attempt: bigint;
  reservedProgress: bigint;
  expiresAtProgress: bigint;
  native: boolean;
  moduleTag: string;
  invalidReason: bigint;
  members: Member[];
  changes: bigint[];
  sourceModule: string;
}

export interface BindingView { rootNodeID: string; rootKey: string; evmNodeID: string; evmKey: string; payee: string; rootKeyHash: string; evmKeyHash: string }

export interface VrIdentity {
  id: bigint;
  owner: string;
  generation: bigint;
  current: BindingView;
  staged: BindingView | null;
  endpoints: string;
  /** PoaElection.status(id), under PoA */
  poaState?: bigint;
  poaSince?: bigint;
  inCommittee: boolean;
}

export interface ChangeRow {
  id: bigint;
  kind: number;
  state: number;
  rejectReason: number;
  notBeforeProgress: bigint;
  notBeforeTime: bigint;
  activeRootEpoch: bigint;
  scheduledAt: bigint;
  boundTo: string;
  payload: string;
  /** a bound change's output expiry (progress) */
  expiresAtProgress?: bigint;
}

export interface Multisig {
  address: string;
  signers: string[];
  nextSigners: string[];
  pending: boolean;
  nextNotBeforeProgress: bigint;
  nextNotBeforeTime: bigint;
  nonce: bigint;
}

/** The custody side of the PoS generation, reached through VR's liability holder, and whether VR ids equal custody StakingIDs. */
export interface CustodyLink {
  custody: string;
  election: string;
  heldBy: string;
  rows: { id: bigint; custodyRootKeyHash: string; vrRootKeyHash: string; equal: boolean; ownerOk: boolean }[];
  allEqual: boolean;
}

export interface VrModel {
  /** the pointers this read was made at (vrKey) */
  key: string;
  mode: Mode;
  block: bigint;
  progress: bigint;
  ucTime: bigint;
  recordCount: bigint;
  recordCursor: bigint;
  health: bigint;
  module: ModuleInfo;
  cfg: VrConfig;
  openOutput: string;
  lastAcked: string;
  /** the open output, or else the last acknowledged one */
  output: OutputView | null;
  committee: Member[];
  identities: VrIdentity[];
  pending: ChangeRow[];
  /** every change VR knows by id (1..), for the partition and history rows */
  history: ChangeRow[];
  activations: { ruleId: string; rootEpoch: bigint; notBeforeUcTime: bigint; state: bigint; changeId: bigint }[];
  poa?: { members: bigint[]; queue: bigint[]; parkPeriod: bigint };
  multisig?: Multisig;
  custody?: CustodyLink;
  at: number;
}

const o = (v: Value | undefined): Record<string, Value> => obj(v);
const memberOf = (v: Value): Member => {
  const m = o(v);
  return {
    id: big(m.id), generation: big(m.generation), weight: big(m.weight), rawWeight: big(m.rawWeight), rootNodeWord: str(m.rootNodeWord), rootKeyHash: str(m.rootKeyHash),
    evmNodeWord: str(m.evmNodeWord), evmKeyHash: str(m.evmKeyHash), payee: str(m.payee), exposureDigest: str(m.exposureDigest),
  };
};
const fees = (v: Value | undefined): VrConfig['feesCurrent'] => ({ baseFeeFloor: big(o(v).baseFeeFloor), changeDenominator: big(o(v).changeDenominator), feeCollector: str(o(v).feeCollector) });

/** The module's identity from activeModule(). */
export function moduleOf(v: Value): ModuleInfo {
  const m = o(v);
  const meta = o(m.meta);
  return {
    address: str(m.module), codeHash: str(m.codeHash), tag: str(meta.moduleTag), capabilities: big(meta.capabilities), maxElectionInterval: big(meta.maxElectionInterval),
    gasBounds: arr(meta.gasBounds).map((x) => big(x)), liabilityHolder: str(meta.liabilityHolder), health: big(m.health), workPending: m.workPending === true,
    workSince: big(m.workSince), stallDeadline: big(m.stallDeadline),
  };
}

/** Which module is active: PoA by its tag, PoS when another module names a liability holder (custody), else other. */
export function modeOf(m: ModuleInfo): Mode {
  if (m.tag.toLowerCase() === POA_TAG) return 'poa';
  if (!isZeroAddress(m.liabilityHolder)) return 'pos';
  return 'other';
}

export function configOf(v: Value): VrConfig {
  const c = o(v);
  return {
    network: str(c.network), governor: str(c.governor), nMin: big(c.nMin), nTarget: big(c.nTarget), nMax: big(c.nMax), vMax: big(c.vMax), lMax: big(c.lMax), rMax: big(c.rMax),
    maxBatch: big(c.maxBatch), feesPrevious: fees(c.feesPrevious), feesCurrent: fees(c.feesCurrent), feesEffectiveBlock: big(c.feesEffectiveBlock), delayRounds: big(c.delayRounds),
    delaySeconds: big(c.delaySeconds), knownRootEpoch: big(c.knownRootEpoch), epochStartProgress: big(c.epochStartProgress), maxGas: big(c.maxGas), systemGas: big(c.systemGas),
    continuityMaxM: big(c.continuityMaxM), continuityDistNum: big(c.continuityDistNum), continuityDistDen: big(c.continuityDistDen),
  };
}

const bindingOf = (v: Value | undefined): BindingView => {
  const b = o(v);
  return { rootNodeID: str(b.rootNodeID), rootKey: str(b.rootKey), evmNodeID: str(b.evmNodeID), evmKey: str(b.evmKey), payee: str(b.payee), rootKeyHash: str(b.rootKeyHash), evmKeyHash: str(b.evmKeyHash) };
};

export function outputOf(id: string, v: Value): OutputView {
  const x = o(v);
  return {
    id, state: big(x.state), attempt: big(x.attempt), reservedProgress: big(x.reservedProgress), expiresAtProgress: big(x.expiresAtProgress), native: x.native === true,
    moduleTag: str(x.moduleTag), invalidReason: big(x.invalidReason), members: arr(x.members).map(memberOf), changes: arr(x.changes).map((c) => big(c)), sourceModule: str(x.sourceModule),
  };
}

export function changeOf(id: bigint, v: Value): ChangeRow {
  const c = o(v);
  return {
    id, kind: num(c.kind), state: num(c.state), rejectReason: num(c.rejectReason), notBeforeProgress: big(c.notBeforeProgress), notBeforeTime: big(c.notBeforeTime),
    activeRootEpoch: big(c.activeRootEpoch), scheduledAt: big(c.scheduledAt), boundTo: str(c.boundTo), payload: str(c.payload),
  };
}

// ---- change payloads ----------------------------------------------------------------------------------------------------------------------------
const short = (s: string, n = 6): string => (s.length > 2 * n + 4 ? `${s.slice(0, n + 2)}…${s.slice(-n)}` : s);

/** A ModuleAction's PoA action: abi.encode(uint64 action, uint64 id) (PoaElection), or null when it is something else. */
export function poaAction(payload: string): { module: string; action: number; id: bigint } | null {
  try {
    const d = o(decode(CHANGE_PAYLOAD[2], payload));
    const a = str(d.action).replace(/^0x/, '');
    if (a.length !== 128) return null;
    return { module: str(d.module), action: Number(BigInt(`0x${a.slice(0, 64)}`)), id: BigInt(`0x${a.slice(64)}`) };
  } catch {
    return null;
  }
}

/** One line for a change, the way `ubft governance list` describes it. */
export function describeChange(kind: number, payload: string): string {
  const name = CHANGE_KIND[kind] || `kind ${kind}`;
  const fields = CHANGE_PAYLOAD[kind];
  if (!fields) return `${name}: unknown kind`;
  let d: Record<string, Value>;
  try {
    d = o(decode(fields, payload));
  } catch (e) {
    return `${name}: payload not readable (${e instanceof Error ? e.message : String(e)})`;
  }
  if (kind === 2) {
    const a = poaAction(payload);
    if (a) return `ModuleAction ${POA_ACTION[a.action] ?? `action ${a.action}`} identity ${a.id} on module ${a.module}`;
    return `ModuleAction on module ${str(d.module)}, not a PoA action`;
  }
  const parts = Object.entries(d).map(([k, v]) => {
    const s = typeof v === 'string' ? v : String(v);
    return `${k}=${typeof v === 'string' && v.startsWith('0x') && v.length > 66 ? `${(v.length - 2) / 2} bytes` : typeof v === 'string' && !v.startsWith('0x') ? JSON.stringify(v) : /^0x[0-9a-fA-F]{40}$/.test(s) ? s : short(s, 8)}`;
  });
  return `${name}(${parts.join(', ')})`;
}

/** The partition a change names (kinds 6 and 8 carry it first; AddPartition carries a PDR, whose id this page does not decode). */
export function partitionOf(c: ChangeRow): bigint | null {
  if (c.kind !== 6 && c.kind !== 8) return null;
  try {
    return big(o(decode(CHANGE_PAYLOAD[c.kind], c.payload)).partition);
  } catch {
    return null;
  }
}

// ---- the next boundary --------------------------------------------------------------------------------------------------------------------------
export interface Boundary {
  /** the progress at which VR's gate allows the next election: MIN_EPOCH_GAP after the epoch's first ordinary round */
  dueProgress: bigint;
  roundsToGo: bigint;
  /** true when an election is not blocked by an open output and has work pending */
  workPending: boolean;
  open: boolean;
  /** an open output's expiry (progress) */
  expires: bigint | null;
  text: string;
}

export function boundaryOf(m: Pick<VrModel, 'progress' | 'cfg' | 'module' | 'openOutput' | 'output'>): Boundary {
  const dueProgress = m.cfg.epochStartProgress + MIN_EPOCH_GAP;
  const roundsToGo = dueProgress > m.progress ? dueProgress - m.progress : 0n;
  const open = !isZero(m.openOutput);
  const expires = open && m.output && m.output.id === m.openOutput ? m.output.expiresAtProgress : null;
  let text: string;
  if (open) {
    text = expires !== null
      ? `an output is open (state ${m.output ? m.output.state : '?'}); it takes effect when the roots acknowledge it, or expires at progress ${expires} (${expires > m.progress ? `in ${expires - m.progress}` : 'passed'})`
      : 'an output is open; it takes effect when the roots acknowledge it';
  } else if (!m.module.workPending) {
    text = `no output is open and the module has no work pending, so no election is due; the gate opens at progress ${dueProgress}${roundsToGo > 0n ? ` (in ${roundsToGo} rounds)` : ' (passed)'} once there is work`;
  } else {
    text = roundsToGo > 0n ? `work is pending; the next election is due at progress ${dueProgress}, in ${roundsToGo} rounds` : `work is pending and the gate is open (progress ${dueProgress} passed): the next election is due now`;
  }
  return { dueProgress, roundsToGo, workPending: m.module.workPending, open, expires, text };
}

// ---- reading ------------------------------------------------------------------------------------------------------------------------------------
const MAX_IDENTITIES = 64;
const MAX_CHANGES = 64;

/**
 * Read VR: the module pointer first. A network without VR answers the eth_call with empty data (no code): mode `none`, and the caller falls
 * back to the P85-only page. PoA mode reads the module's state and the multisig; PoS mode reads custody through VR's liability holder.
 */
export async function readVr(c: Chain, logs: { vr: Log; module: Log; identities: Log; governance: Log }): Promise<VrModel | null> {
  const g = <T extends Value>(n: FnName, a: (bigint | number | string)[] = [], log: Log = logs.vr): Promise<T> => c.call<T>(n, a, log);
  const block = BigInt(await c.raw<string>('eth_blockNumber'));
  let moduleV: Value;
  try {
    moduleV = await g('vrActiveModule', [], logs.module);
  } catch {
    return null; // no code at the VR address (or an old network): the page falls back to the P85 view
  }
  const module = moduleOf(moduleV);
  const mode = modeOf(module);
  c.addresses.poa = mode === 'poa' ? module.address : '';
  const progress = big(await g('progress'));
  const ucTime = big(await g('ucTime'));
  const recordCount = big(await g('recordCount'));
  const recordCursor = big(await g('vrRecordCursor'));
  const health = big(await g('vrHealth'));
  const cfg = configOf(await g('vrConfig'));
  const openOutput = str(await g('vrOpenOutput'));
  const lastAcked = str(await g('vrLastAcked'));
  const committee = arr(await g('vrCommittee')).map(memberOf);
  const outId = !isZero(openOutput) ? openOutput : lastAcked;
  const output = !isZero(outId) ? outputOf(outId, await g('vrOutput', [outId])) : null;

  // identities: ids 1.. until the first unknown one (an unknown id reads as a zero owner)
  const inCommittee = new Set(committee.map((m) => m.id));
  const identities: VrIdentity[] = [];
  for (let id = 1n; id <= BigInt(MAX_IDENTITIES); id++) {
    const v = o(await g('vrIdentity', [id], logs.identities));
    if (isZeroAddress(str(v.owner))) break;
    const staged = !isZero(str(v.stagedRef)) ? bindingOf(v.staged) : null;
    const row: VrIdentity = { id, owner: str(v.owner), generation: big(v.generation), current: bindingOf(v.current), staged, endpoints: str(v.endpoints), inCommittee: inCommittee.has(id) };
    if (mode === 'poa') {
      const s = o(await g('poaStatus', [id], logs.identities));
      row.poaState = big(s.state);
      row.poaSince = big(s.sinceProgress);
    }
    identities.push(row);
  }

  // the governance queue and the change history
  const pendingIds = arr(await g('vrPendingChanges', [], logs.governance)).map((x) => big(x));
  const pending: ChangeRow[] = [];
  for (const id of pendingIds) pending.push(changeOf(id, await g('vrChange', [id], logs.governance)));
  const history: ChangeRow[] = [];
  for (let id = 1n; id <= BigInt(MAX_CHANGES); id++) {
    const row = changeOf(id, await g('vrChange', [id], logs.governance));
    if (row.state === 0) break;
    history.push(row);
  }
  for (const p of pending) {
    if (p.state === 3 && !isZero(p.boundTo)) p.expiresAtProgress = (output && output.id === p.boundTo ? output : outputOf(p.boundTo, await g('vrOutput', [p.boundTo], logs.governance))).expiresAtProgress;
  }
  const activations: VrModel['activations'] = [];
  const nAct = Number(big(await g('vrActivationCount', [], logs.governance)));
  for (let i = 0; i < Math.min(nAct, 16); i++) {
    const a = o(await g('vrActivationAt', [i], logs.governance));
    activations.push({ ruleId: str(a.ruleId), rootEpoch: big(a.rootEpoch), notBeforeUcTime: big(a.notBeforeUcTime), state: big(a.state), changeId: big(a.changeId) });
  }

  const key = vrKey({ recordCount, openOutput, lastAcked, pending: pendingIds, module: module.address });
  const model: VrModel = { key, mode, block, progress, ucTime, recordCount, recordCursor, health, module, cfg, openOutput, lastAcked, output, committee, identities, pending, history, activations, at: Date.now() };

  if (mode === 'poa') {
    model.poa = { members: arr(await g('poaMembers', [], logs.module)).map((x) => big(x)), queue: arr(await g('poaQueue', [], logs.module)).map((x) => big(x)), parkPeriod: big(await g('poaParkPeriod', [], logs.module)) };
  }
  if (!isZeroAddress(cfg.governor)) {
    c.addresses.multisig = cfg.governor;
    try {
      const signers = arr(await g('msSigners', [], logs.governance)).map(str);
      model.multisig = {
        address: cfg.governor, signers, nextSigners: arr(await g('msNextSigners', [], logs.governance)).map(str), pending: (await g('msSignersPending', [], logs.governance)) === true,
        nextNotBeforeProgress: big(await g('msNotBeforeProgress', [], logs.governance)), nextNotBeforeTime: big(await g('msNotBeforeTime', [], logs.governance)), nonce: big(await g('msNonce', [], logs.governance)),
      };
    } catch {
      /* the governor is not a FoundationMultisig (a different SetGovernor): not shown */
    }
  }
  if (mode === 'pos') model.custody = await readCustodyLink(c, model, logs.module);
  return model;
}

/**
 * PoS: custody is VR's liability holder (holder 0 of the generation, design 3.9) and names the election itself. VR ids equal custody
 * StakingIDs, so each committee member's root key hash must be custody's position of the same id.
 */
export async function readCustodyLink(c: Chain, m: Pick<VrModel, 'module' | 'committee' | 'identities'>, log: Log): Promise<CustodyLink> {
  const custody = m.module.liabilityHolder;
  const holder = o(await c.call('vrHolderAt', [0], log));
  c.addresses.custody = custody;
  c.addresses.election = str(await c.call('custodyElection', [], log));
  const rows: CustodyLink['rows'] = [];
  for (const mem of m.committee) {
    const p = o(await c.call('positions', [mem.id], log));
    const idn = m.identities.find((i) => i.id === mem.id);
    rows.push({
      id: mem.id, custodyRootKeyHash: str(p.rootKeyHash), vrRootKeyHash: mem.rootKeyHash, equal: str(p.rootKeyHash).toLowerCase() === mem.rootKeyHash.toLowerCase(),
      ownerOk: !idn || str(p.owner).toLowerCase() === idn.owner.toLowerCase(),
    });
  }
  return { custody, election: c.addresses.election, heldBy: str(holder.holder), rows, allEqual: rows.length > 0 && rows.every((r) => r.equal && r.ownerOk) && str(holder.holder).toLowerCase() === custody.toLowerCase() };
}

/** The pointers whose change makes the full read run again at once (the rest is re-read every SLOW_MS). */
export const vrKey = (p: { recordCount: bigint; openOutput: string; lastAcked: string; pending: bigint[]; module: string }): string =>
  [p.recordCount, p.openOutput, p.lastAcked, p.pending.join(','), p.module.toLowerCase()].join('|');

/** The cheap read of a poll: the clock and the pointers. Seven calls. */
export async function readVrPointers(c: Chain, log: Log): Promise<{ key: string; block: bigint; progress: bigint; ucTime: bigint }> {
  const g = <T extends Value>(n: FnName, a: (bigint | number | string)[] = []): Promise<T> => c.call<T>(n, a, log);
  const block = BigInt(await c.raw<string>('eth_blockNumber'));
  const progress = big(await g('progress'));
  const ucTime = big(await g('ucTime'));
  const recordCount = big(await g('recordCount'));
  const openOutput = str(await g('vrOpenOutput'));
  const lastAcked = str(await g('vrLastAcked'));
  const pending = arr(await g('vrPendingChanges')).map((x) => big(x));
  const module = str(o(await g('vrActiveModule')).module);
  return { key: vrKey({ recordCount, openOutput, lastAcked, pending, module }), block, progress, ucTime };
}
