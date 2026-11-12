/**
 * The demo wallet page: identity, faucet, the asset-flow timeline, the trust history and the old-epoch / forgery check. State lives in
 * localStorage (store.ts); each step runs through `step()`, which records what it sent and received for its "explain" drawer.
 */
import './style.css';

import type { TrustInput } from '@unicitylabs/native-bridge-plugin';
import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';

import * as bridge from './bridge.js';
import { abs, DEFAULTS, fetchTesterConfig, loadSettings, saveSettings, type Settings } from './config.js';
import { isAddress } from './evm.js';
import * as faucet from './faucet.js';
import { forgeRelabelled, forgeUnknownKeys, sealTable, verdict } from './forge.js';
import { acceptToken, Handoff, type Peer } from './handoff.js';
import { fmtUnits, hex, parseUnits, unhex } from './hex.js';
import { loadOrCreate, parseBackup, replaceKey, toMnemonic } from './keys.js';
import { load, PROFILE, save } from './store.js';
import { getToken, listTokens, putToken, type Phase, type TokenRecord } from './tokens.js';
import { begin, end, fact, installFetchTrace, type Trace } from './trace.js';
import { bootstrapTrust, entries, refreshTrust } from './trust.js';
import { copyable, explain, h, mono } from './ui.js';

installFetchTrace();

// ---- state ------------------------------------------------------------------------------------------------------------------------------------
const settings: Settings = loadSettings();
let me = loadOrCreate().burner;
let trust: TrustInput | null = null;
let session: bridge.Session | null = null;
let currentId: string | null = load('current');
let busy: string | null = null;
let balance: bigint | null = null;
let credit: bigint | null = null;
const traces = new Map<string, Trace>();
const status = new Map<string, { ok: boolean; text: string }>();
const peers = new Map<string, Peer>();
const dark = matchMedia('(prefers-color-scheme: dark)').matches;

const current = (): TokenRecord | undefined => getToken(currentId);
const select = (id: string): void => {
  currentId = id;
  save('current', id);
};
const update = (patch: Partial<TokenRecord>): TokenRecord => {
  const t = { ...current()!, ...patch };
  putToken(t);
  return t;
};
const need = <T>(v: T | null | undefined, what: string): T => {
  if (v === null || v === undefined) throw new Error(what);
  return v;
};
const sess = (): bridge.Session => need(session, 'the bridge is not loaded (see Network)');

/** Run one step: its trace is kept for the drawer, its outcome shown on its row. */
async function step(key: string, fn: () => Promise<string | void>): Promise<void> {
  if (busy) return;
  busy = key;
  status.delete(key);
  render();
  const t = begin();
  try {
    const msg = await fn();
    status.set(key, { ok: true, text: msg ?? 'done' });
  } catch (e) {
    const text = e instanceof Error ? `${e.name === 'Error' ? '' : `${e.name}: `}${e.message}` : String(e);
    fact('error', text);
    status.set(key, { ok: false, text });
    console.error(e);
  } finally {
    end(t);
    traces.set(key, t);
    busy = null;
    render();
  }
}

// ---- network ----------------------------------------------------------------------------------------------------------------------------------
async function connect(): Promise<string> {
  const agg = new AggregatorClient(abs(settings.aggregator));
  let pin = settings.trustPin;
  let pinSource = 'the wallet configuration';
  let cfgError = '';
  try {
    session = null;
    const { cfg, fileUrl } = await fetchTesterConfig(settings.testerConfig);
    if (!pin) {
      pin = (await (await fetch(fileUrl('trustEntryId'))).text()).trim();
      pinSource = 'the operator\'s trust-base.genesis.entryid';
    }
    fact('tester-config', `vault ${cfg.vault}, chain ${cfg.chainId}`);
  } catch (e) {
    cfgError = String(e);
  }
  if (!pin) throw new Error(`no trust pin: none configured, and ${cfgError}`);
  const r = await bootstrapTrust(agg, pin, settings.network);
  trust = r.trust;
  if (r.source === 'stored') {
    // a stored history may be epochs behind (staging hands off every few minutes): catch up before anything verifies against it
    try {
      const n = await refreshTrust(trust, agg);
      if (n > 0) fact('trust refresh', `${n} entries appended to the stored history`);
    } catch (e) {
      fact('trust refresh', `failed, keeping the stored history: ${String(e)}`);
    }
  }
  fact('trust pin', `${pin} (from ${pinSource})`);
  fact('trust history', `${r.source}, epochs ${trust.history.entries[0].epoch}..${trust.history.tip?.epoch}`);
  if (cfgError) {
    fact('bridge', cfgError);
    return `trust loaded (epoch ${trust.history.tip?.epoch}); no bridge: ${cfgError}`;
  }
  session = await bridge.openSession(settings, trust);
  await refreshBalances();
  return `connected: chain ${session.cfg.chainId}, vault ${session.cfg.vault.slice(0, 10)}…, trust tip epoch ${trust.history.tip?.epoch}`;
}

async function refreshBalances(): Promise<void> {
  if (!session) return;
  balance = await session.evm.balance(me.evmAddress);
  credit = await bridge.claimable(session, me.evmAddress);
}

// ---- the asset-flow steps -----------------------------------------------------------------------------------------------------------------------
interface StepDef {
  key: string;
  title: string;
  what: string;
  /** the phase the current token must be in (undefined: no token needed) */
  phase?: Phase;
  input?: () => HTMLElement;
  run: () => Promise<string>;
}

const amountInput = h('input', { value: load('amount') ?? '0.001', size: '8', inputmode: 'decimal', 'aria-label': 'amount in UCT' });
const recipientInput = h('input', { placeholder: 'EVM address (default: this wallet)', size: '44', 'aria-label': 'return recipient' });
const peerSelect = h('select', { 'aria-label': 'receiving tab' });

const STEPS: StepDef[] = [
  {
    key: 'lock', title: 'Lock', what: 'BridgeVault.lock(p0) with value: p0 is this key\'s owner predicate. The nonce comes from the receipt\'s Locked log.',
    input: () => h('label', {}, amountInput, ' UCT'),
    run: async () => {
      save('amount', amountInput.value);
      const l = await bridge.lock(sess(), me, parseUnits(amountInput.value));
      const id = l.nonce.toString();
      putToken({ id, nonce: id, amountWei: l.amountWei.toString(), phase: 'locked', lockTx: l.lockTx, lockBlockHash: l.lockBlockHash });
      select(id);
      await refreshBalances();
      return `locked ${amountInput.value} UCT as nonce ${id}`;
    },
  },
  {
    key: 'lockproof', title: 'Lock proof', phase: 'locked', what: 'GET /lockproof/v1/lockproof?block=&nonce=: header, account and storage proofs of the lock, and the EVM shard\'s certificate. 404 until the block is certified.',
    run: async () => {
      const t = current()!;
      const p = await bridge.fetchLockProof(sess(), { nonce: BigInt(t.nonce), lockBlockHash: t.lockBlockHash! });
      update({ phase: 'proved', lockProof: hex(p) });
      return `${p.length} bytes`;
    },
  },
  {
    key: 'mint', title: 'Mint', phase: 'proved', what: 'A mint transaction justified by the lock proof, certified by the aggregator; then verified offline by the plug-in.',
    run: async () => {
      const t = current()!;
      const l = { nonce: BigInt(t.nonce), amountWei: BigInt(t.amountWei), lockTx: t.lockTx!, lockBlockHash: t.lockBlockHash!, blockNumber: 0n };
      const bytes = await bridge.mint(sess(), me, l, unhex(t.lockProof!));
      const v = await bridge.withTrust(sess(), () => sess().bridge.verifyNativeTokenBytes(bytes, 'receipt'));
      update({ phase: 'minted', bytes: hex(bytes), tokenId: hex(v.outcome.tokenId) });
      return `token ${hex(v.outcome.tokenId).slice(0, 12)}…, ${bytes.length} bytes`;
    },
  },
  {
    key: 'transfer', title: 'Transfer to another tab', phase: 'minted', what: 'A certified transfer to the other tab\'s public key, then the token file goes over a BroadcastChannel. The receiver verifies it offline.',
    input: () => h('span', {}, peerSelect, ' ', h('button', { class: 'link', onclick: () => window.open(`?w=${PROFILE === 'b' ? 'a' : 'b'}`, '_blank') }, `open tab ${PROFILE === 'b' ? 'A' : 'B'}`)),
    run: async () => {
      const peer = need(peers.get(peerSelect.value), 'no receiving tab: open one with the link');
      const t = current()!;
      const out = await bridge.transfer(sess(), me, unhex(t.bytes!), unhex(peer.publicKey));
      handoff.sendToken(peer.profile, out, BigInt(t.amountWei));
      fact('handed to', `tab ${peer.profile.toUpperCase()} (${peer.publicKey.slice(0, 16)}…)`);
      update({ phase: 'sent', bytes: hex(out), to: peer.profile });
      return `sent to tab ${peer.profile.toUpperCase()}`;
    },
  },
  {
    key: 'burn', title: 'Burn for return', phase: 'minted', what: 'A transfer to BurnPredicate(sha256(reason)); the reason names the EVM recipient and the amount the vault will credit.',
    input: () => recipientInput,
    run: async () => {
      const to = recipientInput.value.trim() || me.evmAddress;
      if (!isAddress(to)) throw new Error(`not an address: ${to}`);
      const t = current()!;
      const out = await bridge.burn(sess(), me, unhex(t.bytes!), to);
      update({ phase: 'burned', bytes: hex(out), recipient: to });
      return `burned for ${to.slice(0, 10)}…`;
    },
  },
  {
    key: 'returnproof', title: 'Return proof', phase: 'burned', what: 'The aggregator consolidates the token\'s proofs under one seal; the plug-in verifies them and assembles the redeem envelope.',
    run: async () => {
      const r = await bridge.returnProof(sess(), unhex(current()!.bytes!));
      update({ phase: 'enveloped', envelope: hex(r.encoded) });
      return `${r.encoded.length} bytes, ${r.consolidated ? 'consolidated' : 'per state id'}`;
    },
  },
  {
    key: 'redeem', title: 'Redeem', phase: 'enveloped', what: 'eth_call redeem(envelope) until the vault accepts (the registry must reach the seal\'s round), then send it. Anyone may send it.',
    run: async () => {
      const t = current()!;
      const rc = await bridge.redeem(sess(), me, unhex(t.envelope!), { nonce: BigInt(t.nonce), tokenId: t.tokenId! });
      update({ phase: 'redeemed', redeemTx: rc.transactionHash });
      await refreshBalances();
      return `credited ${fmtUnits(BigInt(t.amountWei))} UCT to ${t.recipient?.slice(0, 10)}…`;
    },
  },
  {
    key: 'claim', title: 'Claim', what: 'claimable(me), then claim(amount, me): the vault pays the credit out.',
    run: async () => {
      const r = await bridge.claim(sess(), me);
      await refreshBalances();
      return `claimed ${fmtUnits(r.amount)} UCT`;
    },
  },
];

// ---- two-tab handoff ------------------------------------------------------------------------------------------------------------------------------
const handoff = new Handoff(PROFILE, me, {
  peer: (p) => {
    peers.set(p.profile, p);
    render();
  },
  token: (m) => void step('receive', async () => {
    fact('from', `tab ${m.from.toUpperCase()}, ${m.bytes.length / 2} bytes`);
    const { verified } = await bridge.withTrust(sess(), () => acceptToken(sess().bridge, m.bytes, me.publicKey));
    const tokenId = hex(verified.outcome.tokenId);
    fact('verified', `token ${tokenId}, lock nonce ${verified.outcome.nonce}, owner = this key`);
    const id = `rx-${tokenId.slice(0, 12)}`;
    putToken({ id, nonce: verified.outcome.nonce.toString(), amountWei: BigInt(`0x${hex(verified.outcome.amount)}`).toString(), phase: 'minted', tokenId, bytes: m.bytes, from: m.from });
    select(id);
    return `received a verified token from tab ${m.from.toUpperCase()}`;
  }),
});

// ---- old-epoch / forgery check ---------------------------------------------------------------------------------------------------------------------
let checkView: HTMLElement = h('div');
async function check(kind: 'verify' | 'unknown' | 'relabel'): Promise<string> {
  const t = need(current()?.bytes, 'select a token that has a token file');
  const s = sess();
  if (kind === 'verify') await refreshTrust(s.trust, s.agg).catch((e: unknown) => fact('trust refresh', String(e)));
  let bytes = unhex(t);
  let note = 'the stored token, as held';
  if (kind === 'unknown') {
    bytes = await forgeUnknownKeys(bytes);
    note = 'every seal re-signed by fresh keys under the genuine signer ids';
  } else if (kind === 'relabel') {
    const f = await forgeRelabelled(bytes, s.trust);
    bytes = f.bytes;
    note = f.why.join('; ');
  }
  const rows = await sealTable(bytes, s.trust);
  const v = await verdict(s.bridge, bytes);
  fact('variant', note);
  for (const r of rows) fact(`${r.step}: seal`, `epoch ${r.epoch}, round ${r.round}`);
  fact('verdict', v.ok ? 'accepted' : `${v.reason}: ${v.detail}`);
  checkView = h('div', {},
    h('p', {}, note),
    h('table', { class: 'calls' },
      h('thead', {}, h('tr', {}, ...['certificate', 'seal epoch', 'seal round', 'held interval', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, ...rows.map((r) => h('tr', {},
        h('td', {}, r.step), h('td', { class: 'num' }, String(r.epoch)), h('td', { class: 'num' }, String(r.round)),
        h('td', {}, r.entry ? `[${r.entry.start}, ${r.entry.end ?? '…'})` : 'no entry'),
        h('td', { class: r.inInterval ? 'good' : 'bad' }, r.inInterval ? 'inside' : 'outside'))))),
    h('p', { class: v.ok ? 'verdict good' : 'verdict bad' }, v.ok ? 'Accepted: every certificate verifies under its own epoch\'s committee.' : `Rejected: ${v.reason}`));
  return v.ok ? 'accepted' : `rejected: ${v.reason}`;
}

// ---- rendering ----------------------------------------------------------------------------------------------------------------------------------
const root = document.getElementById('app')!;
const captchaBox = h('div', { class: 'captcha' });
let captcha: { token: () => string; reset: () => void } | null = null;
let faucetNet: faucet.Network | null = null;

function stepRow(d: StepDef, t: TokenRecord | undefined): HTMLElement {
  const enabled = !busy && !!session && (d.phase === undefined || t?.phase === d.phase);
  const st = status.get(d.key);
  const done = !!t && !!DONE[d.key]?.(t);
  return h('li', { 'data-step': d.key, class: `step ${busy === d.key ? 'running' : st ? (st.ok ? 'ok' : 'err') : done ? 'ok' : ''}` },
    h('div', { class: 'row' },
      h('span', { class: 'dot' }),
      h('strong', {}, d.title),
      d.input?.() ?? '',
      h('button', { disabled: !enabled, onclick: () => void step(d.key, d.run) }, busy === d.key ? 'running…' : 'Run'),
      st ? h('span', { class: st.ok ? 'msg' : 'msg bad' }, st.text) : ''),
    h('p', { class: 'what' }, d.what),
    drawer(d.key));
}
/** What a finished step left on the token record. */
const DONE: Record<string, (t: TokenRecord) => boolean> = {
  lock: (t) => !!t.lockTx, lockproof: (t) => !!t.lockProof, mint: (t) => !!t.tokenId && !t.from, transfer: (t) => !!t.to,
  burn: (t) => !!t.recipient, returnproof: (t) => !!t.envelope, redeem: (t) => !!t.redeemTx,
};
const drawer = (key: string): HTMLElement => h('details', { class: 'drawer' }, h('summary', {}, 'explain'), explain(traces.get(key)));

function card(title: string, ...body: (Node | string)[]): HTMLElement {
  return h('section', { class: 'card' }, h('h2', {}, title), ...body);
}

function identityCard(): HTMLElement {
  const backup = h('div', { class: 'backup' });
  const showBackup = () => backup.replaceChildren(
    h('p', { class: 'warn' }, 'Burner key. Anyone with these words holds this wallet; test value only.'),
    h('p', {}, h('code', { class: 'words' }, toMnemonic(me.secret))),
    h('p', {}, copyable(`0x${hex(me.secret)}`)));
  const importBox = h('textarea', { rows: '2', placeholder: '24 words, or 0x + 64 hex digits' });
  return card(`Identity · tab ${PROFILE.toUpperCase()}`,
    h('dl', { class: 'facts' },
      h('dt', {}, 'EVM address'), h('dd', {}, copyable(me.evmAddress)),
      h('dt', {}, 'Unicity public key'), h('dd', {}, copyable(hex(me.publicKey))),
      h('dt', {}, 'owner predicate'), h('dd', {}, copyable(hex(me.predicate)), h('span', { class: 'muted' }, ` ${me.predicate.length} bytes CBOR`)),
      h('dt', {}, 'balance'), h('dd', {}, balance === null ? '—' : `${fmtUnits(balance)} UCT`, credit ? ` · vault credit ${fmtUnits(credit)} UCT` : ''),
    ),
    h('div', { class: 'row' },
      h('button', { class: 'link', onclick: showBackup }, 'export key'),
      h('details', { class: 'inline' }, h('summary', {}, 'import key'), importBox, h('button', {
        onclick: () => {
          try {
            me = replaceKey(parseBackup(importBox.value));
            location.reload();
          } catch (e) {
            alert(String(e));
          }
        },
      }, 'replace this tab\'s key')),
      h('button', { class: 'link', disabled: !session || !!busy, onclick: () => void step('balance', async () => { await refreshBalances(); return 'refreshed'; }) }, 'refresh balance'),
      fundPeer(),
      ...['fund', 'balance'].map((k) => status.get(k)).map((st) => (st ? h('span', { class: st.ok ? 'msg' : 'msg bad' }, st.text) : ''))),
    traces.has('fund') ? drawer('fund') : '',
    backup);
}

/** A plain value transfer, so the other tab can pay gas for its own redeem and claim. */
function fundPeer(): HTMLElement | string {
  const p = [...peers.values()][0];
  if (!p || !session) return '';
  return h('button', {
    class: 'link', disabled: !!busy, onclick: () => void step('fund', async () => {
      const s = sess();
      const sent = await s.evm.send(me.secret, { to: p.evmAddress, value: 10n ** 15n, gas: 21_000n });
      fact('tx', sent.hash);
      await s.evm.waitReceipt(sent.hash);
      await refreshBalances();
      return `sent 0.001 UCT to tab ${p.profile.toUpperCase()}`;
    }),
  }, `send 0.001 UCT gas to tab ${p.profile.toUpperCase()}`);
}

/** Built once: re-attaching the hCaptcha iframe would reload it. Only its controls are re-rendered. */
const faucetControls = h('div');
const faucetCard = card('Faucet',
  h('p', { class: 'what' }, 'GET /api/network gives the hCaptcha site key; POST /api/claim with the h-captcha-response header; the faucet answers with its transaction hash, and we poll the receipt.'),
  captchaBox, faucetControls);
function renderFaucet(): void {
  const st = status.get('faucet');
  const load = status.get('faucet-load');
  faucetControls.replaceChildren(
    h('div', { class: 'row' },
      h('button', { disabled: !!busy, onclick: () => void step('faucet-load', loadCaptcha) }, captcha ? 'reload captcha' : 'show captcha'),
      h('button', { disabled: !!busy || !captcha, onclick: () => void step('faucet', claimFaucet) }, 'Claim UCT'),
      st ? h('span', { class: st.ok ? 'msg' : 'msg bad' }, st.text) : '',
      load && !load.ok ? h('span', { class: 'msg bad' }, load.text) : ''),
    drawer('faucet'));
}
async function loadCaptcha(): Promise<string> {
  faucetNet = await faucet.network(settings.faucet);
  fact('network', JSON.stringify(faucetNet));
  captchaBox.replaceChildren();
  captcha = await faucet.renderCaptcha(captchaBox, faucetNet.captcha_sitekey, dark);
  return 'captcha ready';
}
async function claimFaucet(): Promise<string> {
  const net = need(faucetNet, 'load the captcha first');
  const r = await faucet.claim(settings.faucet, net, me.evmAddress, captcha?.token() ?? '');
  captcha?.reset();
  fact('faucet', r.message);
  fact('tx', r.txHash);
  if (session) {
    const rc = await session.evm.waitReceipt(r.txHash);
    fact('receipt', `block ${BigInt(rc.blockNumber)}, status ${rc.status}`);
    await refreshBalances();
  }
  return `funded: ${r.txHash.slice(0, 12)}…`;
}

function flowCard(): HTMLElement {
  const t = current();
  const toks = listTokens();
  const picker = toks.length
    ? h('select', { onchange: (e: Event) => { select((e.target as HTMLSelectElement).value); render(); } },
      ...toks.map((x) => h('option', { value: x.id, selected: x.id === currentId }, `${x.id.startsWith('rx-') ? 'received' : `lock ${x.id}`} · ${fmtUnits(BigInt(x.amountWei))} UCT · ${x.phase}`)))
    : h('span', { class: 'muted' }, 'none yet: lock some UCT');
  peerSelect.replaceChildren(...[...peers.values()].map((p) => h('option', { value: p.profile }, `tab ${p.profile.toUpperCase()}`)));
  if (!peers.size) peerSelect.append(h('option', { value: '' }, 'no other tab'));
  return card('Asset flow',
    h('div', { class: 'row' }, h('span', {}, 'token: '), picker, t?.tokenId ? mono(t.tokenId) : ''),
    h('ol', { class: 'timeline' }, ...STEPS.map((d) => stepRow(d, t))),
    status.has('receive') ? h('div', { class: 'row' }, h('strong', {}, 'Received'), h('span', { class: status.get('receive')!.ok ? 'msg' : 'msg bad' }, status.get('receive')!.text), drawer('receive')) : '');
}

let trustView: HTMLElement = h('p', { class: 'muted' }, 'Not loaded.');
async function showTrust(fetchNew: boolean): Promise<string> {
  const tr = need(trust, 'connect first');
  let n = 0;
  if (fetchNew) n = await refreshTrust(tr, new AggregatorClient(abs(settings.aggregator)));
  const list = await entries(tr);
  trustView = h('table', { class: 'calls' },
    h('thead', {}, h('tr', {}, ...['epoch', 'entry id', 'start round', 'end', 'members', 'quorum / total weight'].map((x) => h('th', {}, x)))),
    h('tbody', {}, ...list.map((e) => h('tr', {},
      h('td', { class: 'num' }, String(e.epoch)), h('td', {}, mono(e.entryId)), h('td', { class: 'num' }, String(e.startRound)),
      h('td', { class: 'num' }, e.endRound === null ? 'open' : String(e.endRound)),
      h('td', {}, h('details', {}, h('summary', {}, `${e.members.length}`), h('ul', {}, ...e.members.map((m) => h('li', {}, `${m.nodeId} · weight ${m.weight} · `, mono(m.key)))))),
      h('td', { class: 'num' }, `${e.quorum} / ${e.totalWeight}`)))));
  return fetchNew ? `${n} new entr${n === 1 ? 'y' : 'ies'}; tip epoch ${tr.history.tip?.epoch}` : `tip epoch ${tr.history.tip?.epoch}`;
}

function trustCard(): HTMLElement {
  return card('Trust base history',
    h('p', { class: 'what' }, 'GET /api/v1/trustbases: each entry is a committee (members, weights, quorum) signed by the previous one; the genesis entry is pinned by its EntryID.'),
    h('div', { class: 'row' },
      h('button', { disabled: !trust || !!busy, onclick: () => void step('trust', () => showTrust(true)) }, 'refresh from aggregator'),
      status.get('trust') ? h('span', { class: status.get('trust')!.ok ? 'msg' : 'msg bad' }, status.get('trust')!.text) : ''),
    trustView, drawer('trust'));
}

function checkCard(): HTMLElement {
  const can = !busy && !!session && !!current()?.bytes;
  const st = status.get('check');
  return card('Old-epoch check and forgeries',
    h('p', { class: 'what' }, 'Each certificate is verified under the committee of its own seal epoch. A forged seal must not verify: fresh keys under the real signer ids fail the weighted quorum; a seal moved outside its epoch\'s rounds fails before any signature is checked.'),
    h('div', { class: 'row' },
      h('button', { disabled: !can, onclick: () => void step('check', () => check('verify')) }, 'verify stored token'),
      h('button', { disabled: !can, onclick: () => void step('check', () => check('unknown')) }, 'forge: unknown keys'),
      h('button', { disabled: !can, onclick: () => void step('check', () => check('relabel')) }, 'forge: re-labelled epoch'),
      st ? h('span', { class: st.ok ? 'msg' : 'msg bad' }, st.text) : ''),
    checkView, drawer('check'));
}

function settingsCard(): HTMLElement {
  const fields = Object.keys(DEFAULTS) as (keyof Settings)[];
  const inputs = fields.map((k) => [k, h('input', { value: String(settings[k]), size: '40', 'aria-label': k })] as const);
  return h('details', { class: 'card settings' }, h('summary', {}, 'Network settings'),
    h('div', { class: 'grid' }, ...inputs.flatMap(([k, el]) => [h('label', {}, k), el])),
    h('div', { class: 'row' },
      h('button', {
        onclick: () => {
          const s: Partial<Settings> = {};
          for (const [k, el] of inputs) if (el.value !== String(DEFAULTS[k])) (s as Record<string, unknown>)[k] = k === 'network' ? Number(el.value) : el.value;
          saveSettings(s);
          location.reload();
        },
      }, 'save and reload'),
      h('button', { class: 'link', onclick: () => { saveSettings({}); location.reload(); } }, 'defaults')));
}

function header(): HTMLElement {
  const st = status.get('connect');
  return h('header', {},
    h('h1', {}, 'Unicity demo wallet'),
    h('span', { class: 'muted' }, session ? `chain ${session.cfg.chainId} · trust epoch ${trust?.history.tip?.epoch}` : trust ? `trust epoch ${trust.history.tip?.epoch} · no bridge` : 'not connected'),
    h('button', { class: 'link', disabled: !!busy, onclick: () => void step('connect', connect) }, 'reconnect'),
    st && !st.ok ? h('span', { class: 'msg bad' }, st.text) : '',
    h('details', { class: 'inline' }, h('summary', {}, 'explain'), explain(traces.get('connect'))),
    h('a', { href: './pos.html' }, 'PoS visualizer'));
}

const slots = { header: h('div'), identity: h('div'), trust: h('div'), flow: h('div'), check: h('div', { id: 'check' }) };
root.replaceChildren(slots.header, h('main', {},
  h('div', { class: 'col' }, slots.identity, faucetCard, slots.trust),
  h('div', { class: 'col wide' }, slots.flow, slots.check, settingsCard())));

function render(): void {
  document.body.dataset.busy = busy ?? '';
  slots.header.replaceChildren(header());
  slots.identity.replaceChildren(identityCard());
  renderFaucet();
  slots.trust.replaceChildren(trustCard());
  slots.flow.replaceChildren(flowCard());
  slots.check.replaceChildren(checkCard());
}

render();
void step('connect', async () => {
  const msg = await connect();
  if (trust) await showTrust(false);
  return msg;
});
