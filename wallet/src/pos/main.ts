/**
 * The PoS visualizer page (pos.html): the committee and its weighted quorum, the election clock and the churn rules, every registered
 * identity, the UTB history and the meta-parameters, all read live with eth_call (and GET /api/v1/trustbases) and polled politely. Every
 * panel's "explain" drawer lists the contract calls behind it. The what-if controls are client-side arithmetic only: nothing is ever sent.
 */
import '../style.css';
import './pos.css';

import type { TrustInput } from '@unicitylabs/native-bridge-plugin';
import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';

import { abs, loadSettings, pinOverridden } from '../config.js';
import { fmtUnits, hex, short, sleep } from '../hex.js';
import { load, save } from '../store.js';
import { begin, end, installFetchTrace, type Trace } from '../trace.js';
import { bootstrapTrust, refreshTrust } from '../trust.js';
import { copyable, explain as explainTrace, h, mono } from '../ui.js';
import { keccakHex } from './abi.js';
import { Chain, isZero, show, type CallRecord } from './chain.js';
import { PARAMS_MS, POLL_MS, posAddresses, SLOW_MS, SPACING_MS, TRUST_MS } from './config.js';
import { ASSIGNMENT_STATE, FN, LOT_CATEGORY, REASON, RECORD_KIND, REJECT_AFTER_ROUNDS, RESULT_STATE, type FnName } from './contracts.js';
import {
  asMembers, clockKey, discover, eligibleMember, ineligibility, rawWeight, readClock, readCommittee, readIdentity, readOpenResult, readParams, readRecord, readResult,
  type Clock, type Committee, type Identity, type OpenResult, type Params, type RecordView, type ResultView,
} from './model.js';
import { check, fraction, predicates, quorumView, SEL_REASON, select, type Member } from './rules.js';

installFetchTrace();

// ---- state ------------------------------------------------------------------------------------------------------------------------------------
const settings = loadSettings();
const chain = new Chain(abs(settings.rpc), posAddresses(), SPACING_MS);
const ROLE_NAME: Record<string, string> = { registry: 'SealRegistry', custody: 'StakeCustody', election: 'ElectionPolicy', reader: 'EligibilityReader', evidence: 'Evidence', governance: 'GovernanceParams', rewardPool: 'RewardPool' };

let clock: Clock | null = null;
let params: Params | null = null;
let committee: Committee | null = null;
let identities: Identity[] = [];
let open: OpenResult | null = null;
let lastAttempt: ResultView | null = null;
const records = new Map<bigint, RecordView>();
let trust: TrustInput | null = null;
let trustPinSource = '';
let trustTrace: Trace | undefined;
let freshEpoch: bigint | null = null;
const logs: Record<'clock' | 'committee' | 'election' | 'identities' | 'params' | 'discover', CallRecord[]> = { clock: [], committee: [], election: [], identities: [], params: [], discover: [] };
const errors = new Map<string, string>();
const samples: { at: number; progress: bigint }[] = [];
let lastSlow = 0;
let lastTrust = 0;
let lastParams = 0;
let lastKey = '';

/** what-if overrides of the committee, keyed by StakingID, for the assignment they were made on */
let whatIf = new Map<string, { online: boolean; weight: bigint }>();
let whatIfFor = '';
/** the hypothetical successor (include + weight per identity); null: follow the candidate */
let hypo: Map<string, { include: boolean; weight: bigint }> | null = null;
let hypoFor = '';
const openDetails = new Set<string>();

// ---- formatting -------------------------------------------------------------------------------------------------------------------------------
const uct = (wei: bigint): string => `${fmtUnits(wei)} UCT`;
const hm = (s: number): string => {
  if (!Number.isFinite(s)) return '—';
  s = Math.max(0, Math.round(s));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};
const utc = (t: bigint): string => new Date(Number(t) * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
const sid = (id: bigint): string => `#${id}`;
const badge = (text: string, kind = 'muted', title?: string): HTMLElement => h('span', { class: `badge ${kind}`, title }, text);
const stat = (label: string, value: Node | string, sub?: Node | string): HTMLElement => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'big' }, value), sub ? h('div', { class: 'muted' }, sub) : '');
const meter = (frac: number, kind = ''): HTMLElement => h('div', { class: `meter ${kind}` }, h('div', { style: `width:${Math.max(0, Math.min(1, frac)) * 100}%` }));
const ok = (b: boolean): HTMLElement => h('span', { class: `verdict ${b ? 'good' : 'bad'}` }, b ? '✓ holds' : '✗ fails');

/** progress rounds per second, from the samples of the last few minutes */
function rate(): number | null {
  if (samples.length < 2) return null;
  const a = samples[0];
  const b = samples[samples.length - 1];
  const dt = (b.at - a.at) / 1000;
  return dt > 5 ? Number(b.progress - a.progress) / dt : null;
}

function idOfRootKeyHash(hash: string): bigint | null {
  return identities.find((i) => i.rootKeyHash === hash || i.stagedRootKeyHash === hash)?.id ?? null;
}
const identity = (id: bigint): Identity | undefined => identities.find((i) => i.id === id);

// ---- the explain drawer -----------------------------------------------------------------------------------------------------------------------
function drawer(key: string, derive: (Node | string)[], log: CallRecord[], extra?: Node, extraCalls = 0): HTMLElement {
  const rows = log.map((r) => h('tr', {},
    h('td', {}, h('strong', {}, ROLE_NAME[r.role] ?? r.role), h('br'), r.address.startsWith('0x') ? copyable(r.address) : h('span', { class: 'muted' }, r.address)),
    h('td', {}, h('code', {}, `${r.sig.replace(/\(.*\)$/, '')}(${r.args.map((a) => (typeof a === 'string' && a.length > 20 ? short(a, 6) : String(a))).join(', ')})`),
      FN[r.sig.replace(/\(.*$/, '') as FnName]?.src ? h('div', { class: 'muted' }, FN[r.sig.replace(/\(.*$/, '') as FnName].src!) : ''),
    h('td', {}, r.error ? h('span', { class: 'bad' }, r.error) : h('pre', {}, show(r.value))),
    h('td', { class: 'num' }, r.cached ? 'cached' : `${Math.round(r.ms)} ms`)));
  const d = h('details', { class: 'drawer', 'data-k': key, open: openDetails.has(key) },
    h('summary', {}, `explain · ${log.length + extraCalls} call${log.length + extraCalls === 1 ? '' : 's'}`),
    h('div', { class: 'explain' },
      h('div', { class: 'derive' }, ...derive),
      extra ?? '',
      log.length || extraCalls ? (log.length ? h('div', { class: 'scroll' }, h('table', { class: 'calls' },
        h('thead', {}, h('tr', {}, ...['contract', 'function (args)', 'decoded result', ''].map((x) => h('th', {}, x)))), h('tbody', {}, ...rows))) : '') : h('p', { class: 'muted' }, 'No calls yet.')));
  d.addEventListener('toggle', () => (d.open ? openDetails.add(key) : openDetails.delete(key)));
  return d;
}

function card(title: string, sub: string, cls: string, ...body: (Node | string)[]): HTMLElement {
  const err = errors.get(title);
  return h('section', { class: `card ${cls}` }, h('h2', {}, title, h('span', { class: 'sub' }, sub)), err ? h('p', { class: 'err' }, err) : '', ...body);
}

// ---- 1. committee now -------------------------------------------------------------------------------------------------------------------------
function tipEntryForEpoch(epoch: bigint) {
  return trust?.history.entries.find((e) => e.epoch === epoch) ?? null;
}

function committeeCard(): HTMLElement {
  if (!committee) return card('Committee now', 'loading…', '');
  const cm = committee;
  if (whatIfFor !== cm.assignmentID) {
    whatIf = new Map();
    whatIfFor = cm.assignmentID;
  }
  const entry = tipEntryForEpoch(cm.rootEpoch);
  const nodeOf = new Map<string, string>();
  for (const m of entry?.members ?? []) nodeOf.set(keccakHex(`0x${hex(m.sigKey)}`), m.nodeId);
  const W = cm.members.reduce((a, m) => a + m.weight, 0n);
  const rows = cm.members.map((m) => {
    const i = identity(m.id);
    const lots = i?.lots ?? [];
    const ret = i?.retirementRequested ? (i.retirement?.imported ? badge('retirement imported', 'warn') : badge('retirement requested', 'warn')) : badge('active', 'good');
    return h('tr', {},
      h('td', { class: 'num' }, h('strong', {}, sid(m.id))),
      h('td', {}, i ? mono(i.owner) : '—'),
      h('td', {}, mono(m.rootKeyHash), nodeOf.get(m.rootKeyHash) ? h('div', { class: 'muted', title: nodeOf.get(m.rootKeyHash) }, `node …${nodeOf.get(m.rootKeyHash)!.slice(-8)}`) : ''),
      h('td', {}, i?.delegation ? mono(i.delegation.evmKey) : mono(m.evmKeyHash)),
      h('td', { class: 'num' }, h('strong', {}, String(m.weight)), m.rawWeight !== m.weight ? h('span', { class: 'muted' }, ` (x ${m.rawWeight})`) : ''),
      h('td', {}, lots.length ? lots.map((l) => `lot ${l.lotID}: ${fmtUnits(l.remaining)}`).join(', ') : '—', i ? h('div', { class: 'muted' }, `principal ${uct(i.principal)}`) : ''),
      h('td', { class: 'num' }, String(m.generation)),
      h('td', {}, ret));
  });

  // what-if: offline toggles and hypothetical weights
  const wi = cm.members.map((m) => ({ id: m.id, ...(whatIf.get(String(m.id)) ?? { online: true, weight: m.weight }) }));
  const edited = whatIf.size > 0;
  const qv = quorumView(wi);
  const bar = weightBar(wi, cm.members, qv.total, qv.rootQuorum, qv.evmThreshold);
  const controls = cm.members.map((m, k) => h('label', { class: 'row', style: 'margin:2px 0' },
    h('input', { type: 'checkbox', checked: wi[k].online, 'data-k': `wi-on-${m.id}`, onchange: (e: Event) => setWhatIf(m.id, { online: (e.target as HTMLInputElement).checked }) }),
    h('span', { style: 'min-width:3em' }, sid(m.id)), 'online · weight',
    h('input', { type: 'number', min: '0', max: '1000000', value: String(wi[k].weight), 'data-k': `wi-w-${m.id}`, onchange: (e: Event) => setWhatIf(m.id, { weight: BigInt(Math.max(0, Math.floor(Number((e.target as HTMLInputElement).value) || 0))) }) })));
  const total = qv.total;
  const verdict = h('div', {},
    h('div', {}, `Online weight ${qv.online} of W = ${total}: root quorum ⌊2W/3⌋+1 = ${qv.rootQuorum} `, ok(qv.rootHolds), ` · EVM threshold ⌊W/2⌋+1 = ${qv.evmThreshold} `, ok(qv.evmHolds)),
    h('div', { class: 'muted' }, `With W = ${total} the root tolerates ${qv.rootSlack} weight offline, the EVM ${qv.evmSlack}.`));

  return card('Committee now', `assignment ${short(cm.assignmentID, 6)} · root epoch ${cm.rootEpoch} · EVM epoch ${cm.evmEpoch} · ${ASSIGNMENT_STATE[Number(cm.state)] ?? cm.state}`, 'wide',
    h('div', { class: 'stats' },
      stat('members', String(cm.members.length)),
      stat('total weight W', String(W)),
      stat('root quorum ⌊2W/3⌋+1', String(W ? (2n * W) / 3n + 1n : 0n)),
      stat('EVM threshold ⌊W/2⌋+1', String(W ? W / 2n + 1n : 0n)),
      stat('first round', String(cm.firstRound), `policy ${cm.policyID}`)),
    h('div', { class: 'scroll' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ...['StakingID', 'owner', 'root key hash', 'EVM key', 'weight q', 'bond lots', 'gen', 'retirement'].map((x) => h('th', {}, x)))),
      h('tbody', {}, ...rows))),
    bar,
    h('div', { class: 'hypobox' },
      h('div', { class: 'tag' }, `What if · hypothetical${edited ? ' (edited)' : ''} · client-side arithmetic, nothing is sent`),
      h('p', { class: 'muted' }, 'Live signer liveness is not public (the roots\' q3/signers endpoint is loopback only), so every member starts online. Untick a member to take it offline, or change its weight.'),
      ...controls,
      verdict,
      h('button', { class: 'link', disabled: !edited, onclick: () => { whatIf = new Map(); render(); } }, 'reset to live')),
    drawer('committee', [
      'custody.lastAckedAssignment() names the active assignment; its exposures carry each member\'s committed weight q, root and EVM key hashes. ',
      'W = Σq; root quorum and EVM threshold are computed here (bft-go-base root_trust_base_v2.go; ARCH §3). Root node ids come from the UTB entry of the same epoch, matched by keccak256(sigKey) = rootKeyHash.',
    ], logs.committee));
}

function setWhatIf(id: bigint, patch: Partial<{ online: boolean; weight: bigint }>): void {
  const m = committee?.members.find((x) => x.id === id);
  if (!m) return;
  const cur = whatIf.get(String(id)) ?? { online: true, weight: m.weight };
  const next = { ...cur, ...patch };
  if (next.online && next.weight === m.weight) whatIf.delete(String(id));
  else whatIf.set(String(id), next);
  render();
}

function weightBar(wi: { id: bigint; online: boolean; weight: bigint }[], live: { id: bigint; weight: bigint }[], W: bigint, rq: bigint, et: bigint): HTMLElement {
  if (W === 0n) return h('p', { class: 'bad' }, 'Total weight 0: no committee.');
  const pct = (x: bigint): number => (Number(x) / Number(W)) * 100;
  // online members first, so the quorum line reads against the weight that would sign
  const order = [...wi].sort((a, b) => Number(b.online) - Number(a.online));
  const segs = order.filter((m) => m.weight > 0n).map((m) => {
    const edited = live.find((l) => l.id === m.id)?.weight !== m.weight;
    return h('div', { class: `seg${m.online ? '' : ' off'}${edited ? ' edited' : ''}`, style: `flex:${Number(m.weight)} 1 0`, title: `${sid(m.id)}: weight ${m.weight}${m.online ? '' : ' (offline)'}` }, `${sid(m.id)} · ${m.weight}`);
  });
  return h('div', { class: 'wbar', role: 'img', 'aria-label': `weights ${order.map((m) => `${sid(m.id)} ${m.weight}${m.online ? '' : ' offline'}`).join(', ')}; root quorum ${rq} of ${W}; EVM threshold ${et}` },
    h('div', { class: 'segs' }, ...segs),
    // a line at the signed weight that must be reached: the online segments (left) have to extend to it
    h('div', { class: 'line root', style: `left:${Math.min(100, pct(rq))}%` }, h('span', { style: pct(rq) > 70 ? 'left:auto;right:6px' : '' }, `root quorum ${rq}/${W}`)),
    h('div', { class: 'line evm', style: `left:${Math.min(100, pct(et))}%` }, h('span', { style: pct(et) > 70 ? 'left:auto;right:6px' : '' }, `EVM threshold ${et}/${W}`)));
}

// ---- 2. election -------------------------------------------------------------------------------------------------------------------------------
function candidate(): { label: string; members: Member[]; reason?: string } | null {
  if (!committee || !params) return null;
  if (open) return { label: `open result ${short(open.id, 6)} (reserved on chain)`, members: open.candidate };
  const p = params.election;
  const cfg = { nMin: Number(p.nMin), nTarget: Number(p.nTarget), nMax: Number(p.nMax), maxM: p.maxM as bigint, distNum: p.distNum as bigint, distDen: p.distDen as bigint };
  const e = identities.filter((i) => ineligibility(i, params!.bondUnit, params!.minBond).length === 0).map((i) => ({ ...eligibleMember(i), weight: rawWeight(i, params!.bondUnit) }));
  const r = select(asMembers(committee), e, cfg);
  return { label: 'predicted next election (client-side port of Selection.sol over the live eligible set)', members: r.chosen, reason: SEL_REASON[r.reason] };
}

function electionCard(): HTMLElement {
  if (!clock || !params) return card('Election', 'loading…', '');
  const k = clock;
  const p = params.election;
  const cadR = p.cadenceRounds as bigint;
  const cadS = p.cadenceSeconds as bigint;
  const leftR = k.dueProgress > k.progress ? k.dueProgress - k.progress : 0n;
  const leftS = k.dueTime > k.ucTime ? k.dueTime - k.ucTime : 0n;
  const rr = rate();
  const eta = Math.max(Number(leftS), rr ? Number(leftR) / rr : 0);
  const paused = !isZero(k.openResult);
  const fracR = 1 - Number(leftR) / Number(cadR || 1n);
  const fracS = 1 - Number(leftS) / Number(cadS || 1n);

  const parts: (Node | string)[] = [
    h('div', { class: 'stats' },
      stat('progress now', String(k.progress), rr ? `${rr.toFixed(2)} rounds/s observed` : 'measuring rate…'),
      stat('UC time now', utc(k.ucTime).slice(11), `${Math.round(Date.now() / 1000 - Number(k.ucTime))} s behind your clock`),
      stat('next due at', `${k.dueProgress} · ${utc(k.dueTime).slice(11)}`, `cadence ${cadR} rounds AND ${cadS} s past max(last ack, last attempt)`),
      stat(paused ? 'next election' : 'due in', paused ? 'paused' : leftR === 0n && leftS === 0n ? 'due now' : `${leftR} rounds · ${leftS} s`,
        paused ? 'elect() is Disabled while a result is open' : h('span', { 'data-countdown': String(k.at + eta * 1000) }, `≈ ${hm(eta)}`))),
    h('div', {}, `rounds ${cadR - leftR}/${cadR}`, meter(fracR)),
    h('div', {}, `seconds ${cadS - leftS}/${cadS}`, meter(fracS)),
  ];

  if (open) {
    const age = k.progress - open.progress;
    const frac = Number(age) / Number(REJECT_AFTER_ROUNDS);
    const etaReject = rr ? Number(REJECT_AFTER_ROUNDS - age) / rr : NaN;
    parts.push(h('h3', {}, 'Open result'),
      h('dl', { class: 'facts' },
        h('dt', {}, 'result'), h('dd', {}, copyable(open.id)),
        h('dt', {}, 'attempt · state'), h('dd', {}, `${open.attempt} · ${RESULT_STATE[Number(open.state)]}`, open.lost ? badge('coverage lost', 'bad') : ''),
        h('dt', {}, 'members'), h('dd', {}, open.frozen.map((f) => `${sid(f.id)}·${f.weight}`).join('  ')),
        h('dt', {}, 'publication'), h('dd', {}, open.published ? badge('published (finalizeCandidate)', 'good') : badge(`not published · ${open.popCount} PoPs`, 'warn')),
        h('dt', {}, 'age'), h('dd', {}, `${age} of ${REJECT_AFTER_ROUNDS} rounds since reservation (progress ${open.progress})`, meter(frac, frac > 0.8 ? 'bad' : frac > 0.5 ? 'warn' : ''),
          h('span', { class: 'muted' }, rr ? `the roots order a RejectResult in ≈ ${hm(etaReject)} unless the handoff prepares it` : ''))));
  }
  if (lastAttempt && (!open || lastAttempt.id !== open.id)) {
    parts.push(h('h3', {}, 'Last attempt'), h('dl', { class: 'facts' },
      h('dt', {}, 'result'), h('dd', {}, copyable(lastAttempt.id)),
      h('dt', {}, 'attempt · state'), h('dd', {}, `${lastAttempt.attempt} · ${RESULT_STATE[Number(lastAttempt.state)]}${lastAttempt.reason ? ` · ${REASON[Number(lastAttempt.reason)]}` : ''}`),
      h('dt', {}, 'at progress'), h('dd', {}, `${lastAttempt.progress} (${utc(lastAttempt.ucTime)})`)));
  }

  // records (the authenticated control-record log)
  const recs = [...records.values()].sort((a, b) => Number(b.index - a.index)).slice(0, 6);
  if (recs.length) {
    parts.push(h('h3', {}, `Registry records (${k.recordCount})`), h('div', { class: 'scroll' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ...['#', 'kind', 'progress', 'UC time', 'subject'].map((x) => h('th', {}, x)))),
      h('tbody', {}, ...recs.map((r) => h('tr', {}, h('td', { class: 'num' }, String(r.index)), h('td', {}, RECORD_KIND[Number(r.kind)] ?? String(r.kind)), h('td', { class: 'num' }, String(r.progress)),
        h('td', {}, utc(r.ucTime).slice(11)), h('td', {}, mono(r.subject))))))));
  }

  parts.push(churnBlock());
  return card('Election', `attempt cursor ${k.attemptCursor} · live index ${k.liveCount}`, '', ...parts,
    drawer('election', [
      'Cadence and the due point: election.params() and thresholds() = max(anchor, attempt) + (cadenceRounds, cadenceSeconds); both must be reached. ',
      'The clock is the registry\'s progress() and ucTime(). An open result (openResult ≠ 0) disables elect(); the roots reject it after ',
      `${REJECT_AFTER_ROUNDS} progress rounds (a root-side constant). The candidate is reader.committed(result.assignmentID); with none open, the page runs its port of Selection.sol over the eligible identities. `,
      'Seconds are estimated from the observed progress rate.',
    ], logs.election));
}

function churnBlock(): HTMLElement {
  if (!committee || !params) return h('div');
  const O = asMembers(committee);
  const cand = candidate();
  const p = params.election;
  const churn = { maxM: p.maxM as bigint, distNum: p.distNum as bigint, distDen: p.distDen as bigint };
  // the hypothetical successor: follows the candidate until edited
  const base = new Map((cand?.members ?? []).map((m) => [String(m.id), m.weight]));
  const rowsFor = identities.filter((i) => i.delegation || base.has(String(i.id)) || O.some((m) => m.id === i.id));
  const cur = (id: bigint) => hypo?.get(String(id)) ?? { include: base.has(String(id)), weight: base.get(String(id)) ?? (params ? rawWeight(identity(id)!, params.bondUnit) || 1n : 1n) };
  const hypoMembers: Member[] = rowsFor.filter((i) => cur(i.id).include && cur(i.id).weight > 0n).map((i) => {
    const inO = O.find((m) => m.id === i.id);
    const binding = i.delegation ? eligibleMember(i).binding : inO?.binding ?? `none-${i.id}`;
    return { id: i.id, binding, weight: cur(i.id).weight };
  });
  const evalOf = (s: Member[]) => {
    try {
      if (!s.length) return null;
      const { measured } = check(O, s, churn);
      return predicates(measured, O.length, s.length, churn);
    } catch (e) {
      return String(e);
    }
  };
  const a = cand && cand.members.length ? evalOf(cand.members) : null;
  const b = evalOf(hypoMembers);
  const names = ['membership budget M = removed + added', 'turnover max(removed, added) / min(|O|, |S|)', 'weight distance D = Σ|w/W − v/V|', 'unchanged-binding overlap (old, new)'];
  const cell = (x: ReturnType<typeof evalOf>, k: number) => (Array.isArray(x) ? h('td', {}, x[k].value, ' ', h('span', { class: `verdict ${x[k].ok ? 'good' : 'bad'}` }, x[k].ok ? '✓' : '✗')) : h('td', { class: 'muted' }, typeof x === 'string' ? x : '—'));
  const bounds = Array.isArray(a) ? a.map((r) => r.bound) : Array.isArray(b) ? b.map((r) => r.bound) : names.map(() => '');
  const pass = (x: ReturnType<typeof evalOf>) => (Array.isArray(x) ? x.every((r) => r.ok) : false);
  const editor = rowsFor.map((i) => h('label', { class: 'row', style: 'margin:2px 0' },
    h('input', { type: 'checkbox', checked: cur(i.id).include, 'data-k': `hy-in-${i.id}`, onchange: (e: Event) => setHypo(i.id, { include: (e.target as HTMLInputElement).checked }) }),
    h('span', { style: 'min-width:3em' }, sid(i.id)), 'weight',
    h('input', { type: 'number', min: '0', value: String(cur(i.id).weight), 'data-k': `hy-w-${i.id}`, onchange: (e: Event) => setHypo(i.id, { weight: BigInt(Math.max(0, Math.floor(Number((e.target as HTMLInputElement).value) || 0))) }) }),
    O.some((m) => m.id === i.id) ? badge('incumbent', 'muted') : badge('outsider', 'warn')));

  return h('div', {},
    h('h3', {}, 'Churn limits: incumbent O → successor S'),
    h('p', { class: 'muted' }, `O = ${O.map((m) => `${sid(m.id)}·${m.weight}`).join(' ')}. Candidate: ${cand?.label ?? '—'}${cand?.reason && cand.reason !== 'None' ? ` → refused: ${cand.reason}` : ''}${cand && cand.members.length ? ` = ${cand.members.map((m) => `${sid(m.id)}·${m.weight}`).join(' ')}` : ''}.`),
    h('div', { class: 'scroll' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'predicate'), h('th', {}, 'bound'), h('th', {}, 'candidate'), h('th', {}, h('span', { style: 'color:var(--hypo)' }, 'hypothetical')))),
      h('tbody', {}, ...names.map((n, k) => h('tr', {}, h('td', {}, n), h('td', {}, bounds[k]), cell(a, k), cell(b, k)))),
      h('tfoot', {}, h('tr', {}, h('td', {}, h('strong', {}, 'transition allowed')), h('td', {}), h('td', {}, a ? ok(pass(a)) : '—'), h('td', {}, b ? ok(pass(b)) : '—'))))),
    h('div', { class: 'hypobox' },
      h('div', { class: 'tag' }, `Hypothetical successor${hypo ? ' (edited)' : ' (= candidate)'} · client-side, nothing is sent`),
      ...editor,
      h('button', { class: 'link', disabled: !hypo, onclick: () => { hypo = null; render(); } }, 'reset to candidate')));
}

function setHypo(id: bigint, patch: Partial<{ include: boolean; weight: bigint }>): void {
  if (!hypo) {
    // freeze the current candidate as the starting point
    hypo = new Map();
    const cand = candidate();
    for (const i of identities) {
      const m = cand?.members.find((x) => x.id === i.id);
      hypo.set(String(i.id), { include: !!m, weight: m?.weight ?? (params ? rawWeight(i, params.bondUnit) || 1n : 1n) });
    }
  }
  hypo.set(String(id), { ...(hypo.get(String(id)) ?? { include: false, weight: 1n }), ...patch });
  render();
}

// ---- 3. identities -----------------------------------------------------------------------------------------------------------------------------
function identitiesCard(): HTMLElement {
  if (!params) return card('Identities', 'loading…', '');
  const inCommittee = new Set(committee?.members.map((m) => m.id) ?? []);
  const inOpen = new Set(open?.frozen.map((f) => f.id) ?? []);
  const rows = identities.map((i) => {
    const why = ineligibility(i, params!.bondUnit, params!.minBond);
    const tags = [
      inCommittee.has(i.id) ? badge('committee', 'good') : '',
      inOpen.has(i.id) ? badge('in open result', 'good') : '',
      why.length === 0 ? badge('eligible', 'good') : badge('not eligible', 'warn', why.join('; ')),
      i.retirementRequested ? badge(i.retirement?.imported ? `retirement imported @${i.retirement.pRet}` : 'retirement requested', 'warn') : '',
      i.excluded ? badge('excluded', 'bad') : '',
      !inCommittee.has(i.id) && !inOpen.has(i.id) ? badge('pending', 'warn', 'registered, not in the active committee') : '',
    ];
    return h('tr', { class: inCommittee.has(i.id) ? '' : 'new' },
      h('td', { class: 'num' }, h('strong', {}, sid(i.id))),
      h('td', {}, ...tags, why.length ? h('div', { class: 'muted' }, why.join('; ')) : ''),
      h('td', {}, mono(i.owner), h('div', { class: 'muted' }, 'withdrawal ', mono(i.withdrawal))),
      h('td', {}, mono(i.rootKeyHash), isZero(i.stagedRootKeyHash) ? '' : h('div', { class: 'muted' }, 'staged ', mono(i.stagedRootKeyHash))),
      h('td', { class: 'num' }, `${i.generation}`, h('div', { class: 'muted' }, `nonce ${i.roleNonce}`)),
      h('td', {}, ...(i.lots.length ? i.lots.map((l) => h('div', {}, `lot ${l.lotID}: ${fmtUnits(l.remaining)}/${fmtUnits(l.initial)} · ${LOT_CATEGORY[Number(l.category)] ?? l.category} · refs ${l.refCount}`, l.penalized ? h('span', { class: 'bad' }, ` −${fmtUnits(l.penalized)}`) : '')) : [h('span', { class: 'muted' }, 'no lots')])),
      h('td', { class: 'num' }, uct(i.principal), h('div', { class: 'muted' }, `x = ${rawWeight(i, params!.bondUnit)}`)),
      h('td', {}, i.delegation ? h('div', {}, 'EVM ', mono(i.delegation.evmKey), h('div', { class: 'muted' }, 'payee ', mono(i.delegation.payee))) : h('span', { class: 'muted' }, '—'), i.indexed ? '' : h('div', { class: 'muted' }, 'not indexed')));
  });
  const pending = identities.filter((i) => !(committee?.members.some((m) => m.id === i.id))).length;
  return card('Identities', `${identities.length} registered (1..nextStakingID = ${clock?.nextStakingID ?? '?'}) · ${pending} outside the committee`, 'wide',
    h('div', { class: 'scroll' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ...['ID', 'status', 'owner', 'root key hash', 'gen', 'lots (remaining/initial UCT)', 'principal', 'delegation'].map((x) => h('th', {}, x)))),
      h('tbody', {}, ...rows))),
    drawer('identities', [
      'For each id in 1..custody.nextStakingID(): positions(id), generationLots(id, gen) and lots(lot), election.isIndexed(id), evidence.excluded(id), election.delegation(id, gen), ',
      'custody.keyOwner(keccak256(evmKey)), and retirements(id, gen) when a retirement was requested. Eligibility is ElectionPolicy._eligible + EligibilityReader.positions/weights: ',
      'live position, delegation of the open generation with the current (or staged) root key, EVM key registered, principal ≥ B_min; x = ⌊principal / U_bond⌋.',
    ], logs.identities));
}

// ---- 4. UTB timeline ---------------------------------------------------------------------------------------------------------------------------
function utbCard(): HTMLElement {
  if (!trust) return card('Trust base (UTB) history', PIN && !errors.has('utb') ? 'loading…' : '', 'wide', !PIN ? h('p', { class: 'err' }, NO_PIN) : errors.has('utb') ? h('p', { class: 'err' }, errors.get('utb')!) : '');
  const es = trust.history.entries;
  const nameOf = (sigKey: Uint8Array): string => {
    const id = idOfRootKeyHash(keccakHex(`0x${hex(sigKey)}`));
    return id === null ? 'unknown' : sid(id);
  };
  const cards = es.map((e, k) => {
    const prev = k > 0 ? es[k - 1] : null;
    let signed: Node;
    if (!prev || !e.signatures) signed = h('div', { class: 'muted' }, `genesis: pinned by EntryID (${trustPinSource})`);
    else {
      const sigs = e.signatures;
      const signers = prev.members.filter((m) => sigs.has(m.nodeId));
      const w = signers.reduce((a, m) => a + m.weight, 0n);
      signed = h('div', {}, `signed by epoch ${prev.epoch}: ${signers.map((m) => nameOf(m.sigKey)).join(' ')}`,
        h('div', { class: w >= prev.quorumThreshold ? 'good' : 'bad' }, `weight ${w} ≥ quorum ${prev.quorumThreshold}/${prev.totalWeight} ${w >= prev.quorumThreshold ? '✓' : '✗'}`));
    }
    const isActive = committee && e.epoch === committee.rootEpoch;
    return h('div', { class: `epoch${k === es.length - 1 ? ' tip' : ''}${freshEpoch === e.epoch ? ' fresh' : ''}` },
      k > 0 ? h('span', { class: 'arrow' }, '→') : '',
      h('div', { class: 'e' }, `epoch ${e.epoch}`, isActive ? ' ' : '', isActive ? badge('custody active', 'good') : ''),
      h('div', { class: 'muted' }, 'entry ', h('code', {}, short(entryIds.get(e.epoch) ?? '', 4))),
      h('div', {}, `rounds ${e.epochStartRound} – ${trust!.history.epochEndRound(e.epoch) ?? 'open'}`),
      h('ul', {}, ...e.members.map((m) => h('li', { title: m.nodeId }, `${nameOf(m.sigKey)} · w ${m.weight} · …${m.nodeId.slice(-6)}`))),
      h('div', {}, `quorum ${e.quorumThreshold} of ${e.totalWeight}`),
      signed);
  });
  return card('Trust base (UTB) history', `${es.length} entries · tip epoch ${trust.history.tip?.epoch} · every entry after genesis authenticated by its predecessor's committee`, 'wide',
    h('div', { class: 'timeline-utb' }, ...cards),
    h('p', {}, 'A token certified in an old epoch still verifies under that epoch\'s entry: ', h('a', { href: './#check' }, 'wallet → old-epoch check and forgeries'), '.'),
    drawer('utb', [
      'GET /api/v1/trustbases?from=… (CBOR RootTrustBaseV2 pages) via the SDK\'s TrustBaseUpdater; the page holds the history under the pinned genesis EntryID and appends only entries ',
      'whose signatures by the predecessor\'s members reach its quorum (the SDK verifies them; the server adds no authority). StakingIDs are matched by keccak256(sigKey) = positions(id).rootKeyHash.',
    ], [], trustTrace ? explainTrace(trustTrace) : undefined, trustTrace?.calls.length ?? 0));
}
const entryIds = new Map<bigint, string>();

// ---- 5. meta-parameters ------------------------------------------------------------------------------------------------------------------------
function paramsCard(): HTMLElement {
  if (!params) return card('Meta-parameters', 'loading…', '');
  const P = params;
  const pol = P.policy;
  const lim = P.limits;
  const el = P.election;
  const n = (v: unknown): string => String(v);
  const rows: [string, string, string, string][] = [
    ['bond unit U_bond', uct(P.bondUnit), 'custody.bondUnit()', 'weight x = ⌊principal / U_bond⌋'],
    ['minimum bond B_min', uct(P.minBond), 'custody.minBond()', 'principal below it is never elected'],
    ['committee size', `nMin ${n(el.nMin)} · nTarget ${n(el.nTarget)} · nMax ${n(el.nMax)}`, 'election.params()', 'fewer eligible than nMin: NoCandidate (Cardinality)'],
    ['membership budget M', n(el.maxM), 'election.params().maxM', 'removed + added per election'],
    ['weight distance D', `≤ ${n(el.distNum)}/${n(el.distDen)}`, 'election.params().distNum/distDen', 'Σ|w/W − v/V| between consecutive committees'],
    ['cadence', `${n(el.cadenceRounds)} rounds AND ${n(el.cadenceSeconds)} s`, 'election.params()', 'both must pass since the last ack or attempt'],
    ['caps', `vMax ${n(lim.vMax)} · lMax ${n(lim.lMax)} · rMax ${n(lim.rMax)} · maxBatch ${n(lim.maxBatch)}`, 'custody.limits()', 'live index / lots per generation / live references per lot / batch size'],
    ['weight cap B', '65,536', 'Quantize.WEIGHT_CAP_B (constant)', 'committed Σq never exceeds B; above it weights are scaled'],
    ['offence penalty', `${Number(pol.penaltyBps) / 100}% of exposed principal`, 'policy().penaltyBps', 'objective root double vote only'],
    ['lifetime cap per lot', `${Number(pol.lifetimeCapBps) / 100}%`, 'policy().lifetimeCapBps', 'total penalties a lot can ever take'],
    ['reporter bounty', `${Number(pol.bountyBps) / 100}% up to ${uct(pol.bountyCap as bigint)}`, 'policy().bountyBps/bountyCap', 'rest of the penalty goes to treasury'],
    ['evidence window', `${n(pol.evidenceWindow)} / suffix ${n(pol.suffixEvidenceWindow)} rounds`, 'policy().evidenceWindow', 'evidence must execute on chain within it'],
    ['holds', `normal ${n(pol.holdNormal)} · suffix ${n(pol.holdSuffix)} · retirement ${n(pol.holdRetirement)} rounds`, 'policy().hold*', 'round holds before a lot can mature'],
    ['UC-time floor', `${n(pol.timeFloor)} s`, 'policy().timeFloor', 'minimum UC seconds after closure or retirement'],
    ['governance delay', `${P.delayRounds} rounds AND ${P.delaySeconds} s`, 'GovernanceParams.DELAY_*', 'a queued change activates at a later election boundary'],
    ['policy in force', `#${P.policyID}${Number(P.pending.state) ? ` · pending nonce ${n(P.pending.nonce)} (state ${n(P.pending.state)})` : ' · nothing pending'}`, 'currentPolicyID(), pending()', 'prospective only: never rewrites captured terms'],
    ['reward rate', `${uct(P.rewardRate)} per 1,000 progress rounds`, 'currentRewardRate()', 'split by committed weight to operator payees'],
    ['reward pool', `${uct(P.rewardAvailable)} available · ${uct(P.rewardCredits)} credited`, 'rewardPool.available(), totalCredits()', 'funded separately, no minting'],
    ['stake book', `free ${uct(P.totals.free)} · encumbered ${uct(P.totals.encumbered)} · draining ${uct(P.totals.draining)}`, 'custody.total*()', 'encumbered: referenced by a committee'],
    ['RejectResult after', `${REJECT_AFTER_ROUNDS} progress rounds`, 'root-side constant (not on chain)', 'an unprepared reserved result is rejected'],
  ];
  return card('Meta-parameters', 'read on chain · DEV-DEFAULT values', '',
    h('div', { class: 'scroll' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ...['parameter', 'value', 'call', 'meaning'].map((x) => h('th', {}, x)))),
      h('tbody', {}, ...rows.map(([a, b, c, d]) => h('tr', {}, h('td', {}, a), h('td', {}, h('strong', {}, b)), h('td', {}, h('code', {}, c)), h('td', { class: 'muted' }, d)))))),
    drawer('params', ['Immutable values are read once and cached; the policy, rate, pool and totals are re-read every few minutes.'], [...logs.discover, ...logs.params]));
}

// ---- header and layout -------------------------------------------------------------------------------------------------------------------------
function theme(next?: string): void {
  const t = next ?? load('pos.theme') ?? '';
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  if (next !== undefined) save('pos.theme', next);
}
theme();

function header(): HTMLElement {
  const k = clock;
  const errs = [...errors.entries()];
  return h('header', {},
    h('h1', {}, 'Unicity PoS visualizer'),
    h('span', { class: 'live muted' }, k ? `block ${k.block} · progress ${k.progress} · UC ${utc(k.ucTime)}` : 'connecting…'),
    k ? h('span', { class: 'muted', 'data-ago': String(k.at) }, '') : '',
    errs.length ? h('span', { class: 'err', title: errs.map(([a, b]) => `${a}: ${b}`).join('\n') }, `⚠ ${errs.length} read error${errs.length > 1 ? 's' : ''} (backing off)`) : '',
    h('nav', {},
      h('span', { class: 'muted' }, `${chain.sent} requests · poll ${POLL_MS / 1000} s`),
      h('button', { class: 'link', onclick: () => theme(document.documentElement.dataset.theme === 'dark' ? 'light' : document.documentElement.dataset.theme === 'light' ? '' : 'dark') },
        `theme: ${document.documentElement.dataset.theme ?? 'auto'}`),
      h('a', { href: './' }, 'wallet')));
}

const root = document.getElementById('app')!;
const slots = { header: h('div'), committee: h('div', { class: 'wide' }), election: h('div'), params: h('div'), identities: h('div', { class: 'wide' }), utb: h('div', { class: 'wide' }) };
root.replaceChildren(slots.header, h('main', { class: 'pos' }, slots.committee, slots.election, slots.params, slots.identities, slots.utb),
  h('p', { class: 'footer' }, 'Read-only: eth_call against latest and GET /api/v1/trustbases, one request at a time. What-if panels are local arithmetic.'));

function render(): void {
  // keep the focused control across a re-render (polls re-render while someone types)
  const active = document.activeElement as HTMLElement | null;
  const k = active?.dataset?.k;
  slots.header.replaceChildren(header());
  slots.committee.replaceChildren(committeeCard());
  slots.election.replaceChildren(electionCard());
  slots.params.replaceChildren(paramsCard());
  slots.identities.replaceChildren(identitiesCard());
  slots.utb.replaceChildren(utbCard());
  if (k) (root.querySelector(`[data-k="${k}"]`) as HTMLElement | null)?.focus();
  tick();
}

function tick(): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-countdown]'))) {
    const s = (Number(el.dataset.countdown) - Date.now()) / 1000;
    el.textContent = s > 0 ? `≈ ${hm(s)}` : 'due about now';
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-ago]'))) el.textContent = `· updated ${hm((Date.now() - Number(el.dataset.ago)) / 1000)} ago`;
}
setInterval(tick, 1000);

// ---- polling -----------------------------------------------------------------------------------------------------------------------------------
async function tier(name: string, f: () => Promise<void>): Promise<boolean> {
  try {
    await f();
    errors.delete(name);
    return true;
  } catch (e) {
    errors.set(name, e instanceof Error ? e.message : String(e));
    console.error(name, e);
    return false;
  }
}

async function readClockTier(): Promise<void> {
  const log: CallRecord[] = [];
  clock = await readClock(chain, log);
  logs.clock = log;
  samples.push({ at: clock.at, progress: clock.progress });
  while (samples.length > 2 && clock.at - samples[0].at > 180_000) samples.shift();
}

async function readSlowTier(): Promise<void> {
  const k = clock!;
  // the committee
  let log: CallRecord[] = [];
  committee = await readCommittee(chain, k.lastAck, log);
  logs.committee = log;
  // identities
  log = [];
  const ids: Identity[] = [];
  for (let id = 1n; id <= k.nextStakingID; id++) ids.push(await readIdentity(chain, id, log));
  identities = ids;
  logs.identities = log;
  // election: open and last results, new records
  log = [...logs.clock];
  open = isZero(k.openResult) ? null : await readOpenResult(chain, k.openResult, log);
  lastAttempt = isZero(k.lastAttemptResult) ? null : open && open.id === k.lastAttemptResult ? open : await readResult(chain, k.lastAttemptResult, log);
  for (let i = k.recordCount - 1n; i >= 0n && i >= k.recordCount - 6n; i--) if (!records.has(i)) records.set(i, await readRecord(chain, i, log));
  logs.election = log;
  // a new candidate or committee: the hypothetical successor follows it again
  const ck = `${k.lastAck}|${k.openResult}|${k.nextStakingID}`;
  if (ck !== hypoFor) hypo = null;
  hypoFor = ck;
}

async function readParamsTier(): Promise<void> {
  const log: CallRecord[] = [];
  if (!chain.addresses.reader) {
    const d: CallRecord[] = [];
    await discover(chain, d);
    logs.discover = d;
  }
  params = await readParams(chain, log);
  logs.params = log;
}

const NO_PIN = 'This build has no trust pin (VITE_TRUST_PIN, wallet/.env.production), so the UTB history is not loaded: the page does not take '
  + 'its trust root from the server it shows. Rebuild with the pin, or set one in the wallet\'s Network settings (developer option).';
/**
 * The trust pin, as the wallet takes it: the build's VITE_TRUST_PIN, or the Network-settings developer override. Never the server's published
 * entry id, never the first page's genesis (trust on first use), never the URL. Without one the UTB card says so and nothing is fetched.
 */
const PIN = settings.trustPin.trim();

function trustPin(): string {
  if (!PIN) throw new Error(NO_PIN);
  trustPinSource = pinOverridden(settings) ? 'DEVELOPER OVERRIDE from the wallet\'s Network settings' : 'the build';
  return PIN;
}

async function readTrustTier(): Promise<void> {
  const t = begin();
  try {
    const agg = new AggregatorClient(abs(settings.aggregator));
    const before = trust?.history.tip?.epoch ?? 0n;
    if (!trust) {
      // its own storage keys (pos.trust.*): this page never writes the wallet's held history
      trust = (await bootstrapTrust(agg, trustPin(), settings.network, 'pos.')).trust;
    }
    await refreshTrust(trust, agg);
    for (const e of trust.history.entries) if (!entryIds.has(e.epoch)) entryIds.set(e.epoch, hex(await e.entryId()));
    const tip = trust.history.tip?.epoch ?? 0n;
    if (before && tip > before) freshEpoch = tip;
  } finally {
    end(t);
    trustTrace = t;
  }
}

async function loop(): Promise<void> {
  let backoff = 0;
  for (;;) {
    if (document.hidden) {
      await sleep(1000);
      continue;
    }
    const now = Date.now();
    if (!params || now - lastParams > PARAMS_MS) if (await tier('Meta-parameters', readParamsTier)) lastParams = now;
    const okClock = await tier('Election', readClockTier);
    if (okClock && clock) {
      const key = clockKey(clock);
      if (key !== lastKey || now - lastSlow > SLOW_MS) {
        if (await tier('Committee now', readSlowTier)) {
          lastSlow = Date.now();
          lastKey = key;
        }
      }
    }
    if (PIN && (!trust || now - lastTrust > TRUST_MS)) {
      if (await tier('utb', readTrustTier)) lastTrust = now;
    }
    render();
    freshEpoch = null;
    backoff = errors.size ? Math.min(60_000, Math.max(POLL_MS * 2, backoff * 2)) : 0;
    await sleep(backoff || POLL_MS);
  }
}

render();
void loop();
