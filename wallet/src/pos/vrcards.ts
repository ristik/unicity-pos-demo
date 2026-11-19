/**
 * The validator-registry panels of the PoS visualizer: which election module is active, VR's output and boundary state, the committee and the
 * identities, the governance queue (PoA: the Foundation multisig's changes with their delays and expiry, as `ubft governance list` shows them),
 * and the live config. Pure rendering of a {@link VrModel}; the page passes in its own card and drawer helpers.
 */
import { copyable, h, mono } from '../ui.js';
import type { CallRecord } from './chain.js';
import { ACTIVATION_STATE, CHANGE_KIND, CHANGE_STATE, MIN_EPOCH_GAP, POA_STATE, VR_HEALTH, VR_OUTPUT_STATE } from './contracts.js';
import { boundaryOf, describeChange, partitionOf, type ChangeRow, type VrModel } from './vr.js';

export interface Deps {
  card: (title: string, sub: string, cls: string, ...body: (Node | string)[]) => HTMLElement;
  drawer: (key: string, derive: (Node | string)[], log: CallRecord[]) => HTMLElement;
  badge: (text: string, kind?: string, title?: string) => HTMLElement;
  stat: (label: string, value: Node | string, sub?: Node | string) => HTMLElement;
  hm: (seconds: number) => string;
  utc: (t: bigint) => string;
}

export interface VrLogs { vr: CallRecord[]; module: CallRecord[]; identities: CallRecord[]; governance: CallRecord[] }

const table = (head: string[], rows: (Node | string)[][], cls = 'calls'): HTMLElement =>
  h('div', { class: 'scroll' }, h('table', { class: cls }, h('thead', {}, h('tr', {}, ...head.map((x) => h('th', {}, x)))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, c)))))));

const MODE_TEXT = {
  poa: 'PoA (PoaElection)',
  pos: 'PoS (PosElectionAdapter over the P85 stack)',
  other: 'an election module this page does not know',
} as const;

/** What the active module is, said plainly: PoA is the intermediate mode before PoS. */
export function modeBanner(m: VrModel, d: Deps): HTMLElement {
  if (m.mode === 'poa') {
    return h('div', { class: 'banner warn', 'data-mode': 'poa' },
      h('strong', {}, `Active election module: ${MODE_TEXT.poa}. `),
      'PoA is the intermediate mode before PoS: validators apply, the Foundation multisig admits or removes them, and membership changes at a boundary. ',
      'PoS is the same registry with the P85 stake stack as its election module.');
  }
  if (m.mode === 'pos') {
    return h('div', { class: 'banner', 'data-mode': 'pos' },
      h('strong', {}, `Active election module: ${MODE_TEXT.pos}. `),
      'The same validator registry as PoA, with the P85 stake stack as its election module: the committee is elected from stake, and custody is the registry\'s liability holder. ',
      d.badge('PoA was the intermediate mode before this', 'muted'));
  }
  return h('div', { class: 'banner bad', 'data-mode': 'other' }, h('strong', {}, `Active election module: ${MODE_TEXT.other}`), ` (tag ${m.module.tag}).`);
}

export function moduleCard(m: VrModel, logs: VrLogs, d: Deps): HTMLElement {
  const mod = m.module;
  const stall = mod.stallDeadline;
  return d.card('Election module', `validator registry ${m.mode === 'poa' ? '· PoA' : m.mode === 'pos' ? '· PoS' : ''}`, 'vr-module',
    modeBanner(m, d),
    h('div', { class: 'stats' },
      d.stat('module', mono(mod.address), m.mode === 'poa' ? 'PoaElection' : m.mode === 'pos' ? 'PosElectionAdapter' : ''),
      d.stat('health', d.badge(VR_HEALTH[Number(mod.health)] ?? String(mod.health), mod.health === 0n ? 'good' : 'bad'), `registry: ${VR_HEALTH[Number(m.health)] ?? m.health}`),
      d.stat('work pending', mod.workPending ? `yes, since progress ${mod.workSince}` : 'no', stall > 0n ? `stall deadline: progress ${stall}` : ''),
      d.stat('committee', `${m.committee.length} members`, `limits ${m.cfg.nMin}..${m.cfg.nMax}, target ${m.cfg.nTarget}`)),
    h('dl', { class: 'facts' },
      h('dt', {}, 'registry (VR)'), h('dd', {}, copyable('0xff00000000000000000000000000000000000003')),
      h('dt', {}, 'module tag'), h('dd', {}, mono(mod.tag, true)),
      h('dt', {}, 'module code hash'), h('dd', {}, mono(mod.codeHash)),
      h('dt', {}, 'max election interval'), h('dd', {}, `${mod.maxElectionInterval} progress rounds`),
      h('dt', {}, 'liability holder'), h('dd', {}, /^0x0+$/.test(mod.liabilityHolder) ? 'none (this module holds no stake)' : copyable(mod.liabilityHolder)),
      h('dt', {}, 'governor'), h('dd', {}, copyable(m.cfg.governor), m.multisig ? h('span', { class: 'muted' }, ` FoundationMultisig, 3 of ${m.multisig.signers.length}`) : ''),
      ...(m.poa ? [h('dt', {}, 'PoA members / queue'), h('dd', {}, `${m.poa.members.map((i) => `#${i}`).join(' ') || '—'} / ${m.poa.queue.map((i) => `#${i}`).join(' ') || 'empty'}`)] : [])),
    d.drawer('vr-module', ['activeModule() names the election module; its moduleTag tells PoA (keccak256("unicity.vr.poa.v1")) from a module that names a liability holder (PoS).'], logs.module));
}

export function outputCard(m: VrModel, logs: VrLogs, d: Deps): HTMLElement {
  const b = boundaryOf(m);
  const out = m.output;
  const open = b.open;
  return d.card('Output and boundary', 'what the roots acknowledge', 'vr-output',
    h('div', { class: 'stats' },
      d.stat(open ? 'open output' : 'last acknowledged output', out && out.state !== 0n ? d.badge(VR_OUTPUT_STATE[Number(out.state)] ?? String(out.state), open ? 'warn' : 'good') : 'none yet', out && out.state !== 0n ? `attempt ${out.attempt} · ${out.native ? 'registry-native' : 'from the module'}` : 'the genesis committee is in force'),
      d.stat('records', `${m.recordCursor} / ${m.recordCount}`, 'applied / imported root records'),
      d.stat('next boundary', b.open ? 'output open' : b.workPending ? (b.roundsToGo > 0n ? `in ${b.roundsToGo} rounds` : 'due now') : 'no work', `gate at progress ${b.dueProgress} (epoch start ${m.cfg.epochStartProgress} + ${MIN_EPOCH_GAP})`)),
    h('p', { class: 'what' }, b.text),
    out && out.members.length ? h('p', {}, `The output carries ${out.members.length} members and ${out.changes.length} bound change${out.changes.length === 1 ? '' : 's'}${out.changes.length ? ` (${out.changes.map((c) => `#${c}`).join(', ')})` : ''}.`) : '',
    h('h3', {}, 'Committee in force'),
    table(['id', 'generation', 'weight', 'root key hash', 'EVM key hash', 'payee'],
      m.committee.map((c) => [h('strong', {}, `#${c.id}`), String(c.generation), String(c.weight), mono(c.rootKeyHash), mono(c.evmKeyHash), mono(c.payee)])),
    d.drawer('vr-output', ['committee() is the committee in force. openOutput() is the output reserved but not yet acknowledged by the roots; lastAcked() the last one they did; output(id) shows its state, members and bound changes.'], logs.vr));
}

const stateBadge = (s: bigint, d: Deps): HTMLElement => d.badge(POA_STATE[Number(s)] ?? String(s), s === 4n ? 'good' : s === 0n || s === 8n ? 'muted' : 'warn');

export function identitiesCard(m: VrModel, logs: VrLogs, d: Deps): HTMLElement {
  const pos = m.mode === 'pos';
  const poa = m.mode === 'poa';
  const head = ['id', 'owner', 'generation', 'root node', 'EVM node', 'payee', ...(poa ? ['PoA state'] : []), ...(pos && m.custody ? ['custody StakingID'] : []), 'committee'];
  const rows = m.identities.map((i) => {
    const link = m.custody?.rows.find((r) => r.id === i.id);
    return [
      h('strong', {}, `#${i.id}`), mono(i.owner), String(i.generation), mono(i.current.rootNodeID || '—'), mono(i.current.evmNodeID || '—'), mono(i.current.payee),
      ...(poa ? [h('span', {}, stateBadge(i.poaState ?? 0n, d), ' ', i.poaSince ? h('span', { class: 'muted' }, `since progress ${i.poaSince}`) : '')] : []),
      ...(pos && m.custody ? [link ? d.badge(link.equal && link.ownerOk ? `#${i.id} = VR id ✓` : `#${i.id} differs ✗`, link.equal && link.ownerOk ? 'good' : 'bad') : h('span', { class: 'muted' }, 'not in the committee')] : []),
      i.inCommittee ? d.badge('member', 'good') : d.badge('not a member', 'muted'),
      i.staged ? d.badge('binding staged', 'warn', `staged root key hash ${i.staged.rootKeyHash}`) : '',
    ];
  });
  return d.card('Identities', `${m.identities.length} registered in VR`, 'vr-identities',
    poa ? h('p', { class: 'what' }, 'Each identity\'s PoA state: Applied (the owner applied) → Admitted (the multisig admitted it) → Joining (in an open output) → Active (in the committee) → ExitRequested → Removing → Leaving → Exited. Parked: the output expired with its joiner unready; it returns to Admitted.') : '',
    table(head, rows),
    d.drawer('vr-identities', ['identity(id) for id = 1.. until the first unknown id (an unknown id reads as a zero owner)' + (poa ? '; the module\'s status(id) gives the PoA state' : '') + '.'], logs.identities));
}

function delayText(c: ChangeRow, m: VrModel, d: Deps): string {
  const parts: string[] = [];
  if (m.progress < c.notBeforeProgress) parts.push(`progress ${c.notBeforeProgress} (in ${c.notBeforeProgress - m.progress} rounds)`);
  if (m.ucTime < c.notBeforeTime) parts.push(`UC time ${d.utc(c.notBeforeTime)} (in ${d.hm(Number(c.notBeforeTime - m.ucTime))})`);
  return parts.length ? `waiting for ${parts.join(' and ')}` : `both passed (progress ${c.notBeforeProgress}, UC time ${d.utc(c.notBeforeTime)}): executable now`;
}

function expiryText(c: ChangeRow, m: VrModel): string {
  if (c.state === 1) return 'none while Queued; after execute it is Scheduled';
  if (c.state === 2) return `scheduled at progress ${c.scheduledAt}; it is bound into the next election's output; none while Scheduled`;
  if (c.state === 3) {
    const e = c.expiresAtProgress;
    return e === undefined ? 'bound to an output' : `the output expires at progress ${e} (${e > m.progress ? `in ${e - m.progress} rounds` : 'passed'}); if it expires the change returns to Scheduled`;
  }
  if (c.state === 4) return `in force since root epoch ${c.activeRootEpoch}`;
  return '';
}

export function governanceCard(m: VrModel, logs: VrLogs, d: Deps): HTMLElement {
  const ms = m.multisig;
  const rows = m.pending.map((c) => [
    h('strong', {}, `#${c.id}`), describeChange(c.kind, c.payload), d.badge(CHANGE_STATE[c.state] ?? String(c.state), c.state === 3 ? 'warn' : 'muted'),
    c.state === 1 ? delayText(c, m, d) : '—', expiryText(c, m),
  ]);
  return d.card('Governance queue', m.mode === 'poa' ? 'Foundation multisig · the same data as ubft governance list' : 'changes VR still holds', 'vr-governance',
    ms ? h('dl', { class: 'facts' },
      h('dt', {}, 'governor'), h('dd', {}, copyable(ms.address), h('span', { class: 'muted' }, ` FoundationMultisig, 3 of ${ms.signers.length}, nonce ${ms.nonce}`)),
      h('dt', {}, 'signers'), h('dd', {}, ...ms.signers.flatMap((s) => [mono(s), ' '])),
      ...(ms.pending ? [h('dt', {}, 'signer change'), h('dd', {}, `staged: applicable after progress ${ms.nextNotBeforeProgress} and UC time ${d.utc(ms.nextNotBeforeTime)}`)] : [])) : h('p', { class: 'muted' }, `The governor ${m.cfg.governor} is not a FoundationMultisig.`),
    h('p', {}, `clock: progress ${m.progress}, UC time ${d.utc(m.ucTime)}; delays ${m.cfg.delayRounds} rounds and ${m.cfg.delaySeconds} s; pending changes: ${m.pending.length}`),
    m.pending.length ? table(['change', 'what', 'state', 'delays', 'expiry'], rows) : h('p', { class: 'muted' }, 'No change is pending. A change that is Active, Rejected or Cancelled is no longer listed (see the history under Live config).'),
    h('p', { class: 'what' }, `Next boundary: ${boundaryOf(m).text}`),
    d.drawer('vr-governance', ['pendingChanges() lists the changes VR still holds (Queued, Scheduled, Bound); change(id) their state, delays and payload; output(id) a bound change\'s expiry. The governor\'s signers() and nonce() come from the multisig itself.'], logs.governance));
}

export function configCard(m: VrModel, logs: VrLogs, d: Deps): HTMLElement {
  const c = m.cfg;
  const fee = (f: typeof c.feesCurrent): string => `base fee floor ${f.baseFeeFloor} wei · change denominator ${f.changeDenominator} · collector ${f.feeCollector}`;
  const parts = m.history.filter((x) => x.kind === 6 || x.kind === 7 || x.kind === 8);
  const rows: [string, string, string][] = [
    ['committee limits', `nMin ${c.nMin} · nTarget ${c.nTarget} · nMax ${c.nMax}`, 'changed by CommitteeLimits'],
    ['registry limits', `vMax ${c.vMax} · lMax ${c.lMax} · rMax ${c.rMax} · maxBatch ${c.maxBatch}`, 'fixed per generation'],
    ['fees, in force', `${fee(c.feesCurrent)}`, `since block ${c.feesEffectiveBlock}; changed by FeeParams`],
    ['fees, before', fee(c.feesPrevious), 'the previous set'],
    ['block gas', `max ${c.maxGas} · system ${c.systemGas}`, 'the generation\'s fixed fee-profile fields'],
    ['governance delay', `${c.delayRounds} rounds AND ${c.delaySeconds} s`, 'a queued change executes after both'],
    ['continuity', `M ≤ ${c.continuityMaxM} · distance ${c.continuityDistNum}/${c.continuityDistDen}`, 'how much a successor committee may differ'],
    ['roots', `known root epoch ${c.knownRootEpoch} · epoch start progress ${c.epochStartProgress}`, 'the election gate opens MIN_EPOCH_GAP later'],
    ['governor', c.governor, 'SetGovernor changes it'],
  ];
  return d.card('Live config', 'read from VR · changed only by governance', 'vr-config',
    table(['parameter', 'value', 'meaning'], rows.map(([a, b, x]) => [a, h('strong', {}, b), h('span', { class: 'muted' }, x)])),
    h('h3', {}, 'Partitions'),
    h('p', { class: 'what' }, 'The installed partition list is root-side state, not VR storage. What VR shows are the partition changes it handled: ReplaceAggregatorValidators, AddPartition and UpdatePartition.'),
    parts.length ? table(['change', 'kind', 'partition', 'state', 'in force since'], parts.map((p) => {
      const pid = partitionOf(p);
      return [h('strong', {}, `#${p.id}`), CHANGE_KIND[p.kind] ?? String(p.kind), pid === null ? '(in the PDR)' : String(pid), CHANGE_STATE[p.state] ?? String(p.state), p.state === 4 ? `root epoch ${p.activeRootEpoch}` : '—'];
    })) : h('p', { class: 'muted' }, 'No partition change so far: the generation\'s genesis partitions are in force.'),
    h('h3', {}, 'Change history'),
    m.history.length ? table(['change', 'what', 'state'], m.history.map((p) => [h('strong', {}, `#${p.id}`), describeChange(p.kind, p.payload), CHANGE_STATE[p.state] ?? String(p.state)])) : h('p', { class: 'muted' }, 'No change was ever queued.'),
    m.activations.length ? [h('h3', {}, 'Scheduled activations'), table(['rule', 'root epoch', 'not before (UC time)', 'state', 'change'], m.activations.map((a) => [mono(a.ruleId), String(a.rootEpoch), d.utc(a.notBeforeUcTime), ACTIVATION_STATE[Number(a.state)] ?? String(a.state), `#${a.changeId}`]))] as unknown as Node : '',
    d.drawer('vr-config', ['config() holds the limits, fees, delays and the fixed profile fields; change(1..) walks the change history until the first unknown id.'], logs.governance));
}

export function custodyCard(m: VrModel, logs: VrLogs, d: Deps): HTMLElement | null {
  const k = m.custody;
  if (!k) return null;
  return d.card('Custody link', 'VR ids = custody StakingIDs', 'vr-custody',
    h('p', { class: 'what' }, 'In the PoS generation the genesis identities are registered in VR in manifest order, so each VR id is the StakingID of the same validator in custody. The page reaches custody and the election through VR\'s liability holder, not through fixed addresses.'),
    h('dl', { class: 'facts' },
      h('dt', {}, 'liability holder 0 (VR)'), h('dd', {}, copyable(k.heldBy)),
      h('dt', {}, 'custody (the module\'s holder)'), h('dd', {}, copyable(k.custody), ' ', d.badge(k.heldBy.toLowerCase() === k.custody.toLowerCase() ? 'same address' : 'differs', k.heldBy.toLowerCase() === k.custody.toLowerCase() ? 'good' : 'bad')),
      h('dt', {}, 'election (custody.election())'), h('dd', {}, copyable(k.election))),
    table(['VR id', 'VR root key hash', 'custody positions(id).rootKeyHash', 'equal'], k.rows.map((r) => [h('strong', {}, `#${r.id}`), mono(r.vrRootKeyHash), mono(r.custodyRootKeyHash), d.badge(r.equal && r.ownerOk ? 'equal' : 'differs', r.equal && r.ownerOk ? 'good' : 'bad')])),
    h('p', { class: k.allEqual ? 'verdict good' : 'verdict bad' }, k.allEqual ? '✓ every committee member has the same id and root key in VR and custody' : '✗ VR and custody disagree'),
    d.drawer('vr-custody', ['holderAt(0) is the liability holder; custody.election() the election; positions(id) the custody record whose rootKeyHash must equal the committee member\'s.'], logs.module));
}
