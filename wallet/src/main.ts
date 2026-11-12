/**
 * The demo wallet page: identity, faucet, the asset-flow timeline, the trust history and the old-epoch / forgery check. State lives in
 * localStorage (store.ts); each step runs through `step()`, which records what it sent and received for its "explain" drawer.
 */
import './style.css';

import type { TrustInput } from '@unicitylabs/native-bridge-plugin';
import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';

import * as bridge from './bridge.js';
import { abs, DEFAULTS, fetchTesterConfig, loadSettings, pinOverridden, saveSettings, type Settings } from './config.js';
import { isAddress } from './evm.js';
import * as faucet from './faucet.js';
import { forgeRelabelled, forgeUnknownKeys, sealTable, verdict } from './forge.js';
import { acceptToken, Handoff, type Peer } from './handoff.js';
import { fmtUnits, hex, parseUnits, unhex } from './hex.js';
import { loadOrCreate, parseBackup, replaceKey, toMnemonic } from './keys.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { load, loadJson, PROFILE, remove, save, saveJson } from './store.js';
import { CONFIRM_WORD, confirmed, valueAtRisk } from './importguard.js';
import { getToken, listTokens, patchToken, putToken, type Phase, type TokenRecord } from './tokens.js';
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
/** The selected record when a step starts: the step works on it by id, even if the selection changes while it runs. */
const currentOr = (what: string): TokenRecord => need(current(), what);
/** The lock signed but not yet seen in a receipt (bridge.lock): polled on a retry, never sent twice. */
const pendingLock: bridge.PendingLockStore = {
  get: () => loadJson<bridge.PendingLock | null>('lock.pending', null),
  // localStorage is the store; the IndexedDB copy is committed with durability 'strict' before the lock is broadcast, so a hard kill of the
  // browser right after signing (localStorage not flushed yet) still leaves the record (restored by restorePendingLock on the next load)
  put: async (p) => {
    saveJson('lock.pending', p);
    await idbPendingLock('put', p);
  },
  clear: async () => {
    remove('lock.pending');
    await idbPendingLock('delete');
  },
};

/** IndexedDB operations run one after another, in call order (a clear followed by a new lock must not delete the new copy). */
let idbQueue: Promise<unknown> = Promise.resolve();
function idbPendingLock(op: 'put' | 'delete' | 'get', p?: bridge.PendingLock): Promise<bridge.PendingLock | null> {
  const next = idbQueue.then(() => idbOp(op, p));
  idbQueue = next;
  return next;
}

/** One operation on the IndexedDB copy of the pending lock (per profile), awaited until committed. Failures only lose the extra copy. */
async function idbOp(op: 'put' | 'delete' | 'get', p?: bridge.PendingLock): Promise<bridge.PendingLock | null> {
  try {
    if (typeof indexedDB === 'undefined') return null;
    const db = await new Promise<IDBDatabase>((ok, fail) => {
      const r = indexedDB.open('unicity-demo', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('pending-lock');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    });
    try {
      const tx = db.transaction('pending-lock', op === 'get' ? 'readonly' : 'readwrite', { durability: 'strict' });
      const st = tx.objectStore('pending-lock');
      const req = op === 'put' ? st.put(p, PROFILE) : op === 'delete' ? st.delete(PROFILE) : st.get(PROFILE);
      await new Promise<void>((ok, fail) => {
        tx.oncomplete = () => ok();
        tx.onerror = () => fail(tx.error);
        tx.onabort = () => fail(tx.error);
      });
      return op === 'get' ? ((req.result as bridge.PendingLock | undefined) ?? null) : null;
    } finally {
      db.close();
    }
  } catch (e) {
    console.warn('pending lock: IndexedDB copy unavailable', e);
    return null;
  }
}

/** The current key's balance and vault credit, read fresh; null for what cannot be read (no connection, an RPC error). */
async function readHoldings(): Promise<{ balance: bigint | null; credit: bigint | null }> {
  if (!session) return { balance: null, credit: null };
  const s = session;
  const [b, c] = await Promise.all([s.evm.balance(me.evmAddress).catch(() => null), bridge.claimable(s, me.evmAddress).catch(() => null)]);
  return { balance: b, credit: c };
}

/** What is bound to the current key and not finished: a pending lock (either copy), locks not minted yet, pending transfers and burns. */
async function pendingWork(): Promise<string[]> {
  const out: string[] = [];
  const lockRec = pendingLock.get() ?? (await idbPendingLock('get'));
  if (lockRec) out.push(`lock ${lockRec.hash} (${fmtUnits(BigInt(lockRec.amountWei))} UCT) is waiting for its receipt`);
  for (const t of listTokens()) {
    if (t.phase === 'locked' || t.phase === 'proved') out.push(`lock ${t.id} (${fmtUnits(BigInt(t.amountWei))} UCT) is not minted yet: only this key can mint it`);
    if (t.pending) out.push(`a ${t.pending.kind} of token ${t.id} (${fmtUnits(BigInt(t.amountWei))} UCT) is stored and not certified yet`);
  }
  return out;
}

/** On load: a pending lock that only the IndexedDB copy holds (localStorage lost it in a hard kill) is put back. */
async function restorePendingLock(): Promise<void> {
  if (pendingLock.get()) return;
  const p = await idbPendingLock('get');
  // a stale copy (the lock finished, its delete did not land): its receipt is already on a token record
  if (p && listTokens().some((t) => t.lockTx?.toLowerCase() === p.hash.toLowerCase())) {
    await idbPendingLock('delete');
    fact('pending lock', `dropped a stale IndexedDB copy of ${p.hash}: the lock is already recorded`);
    return;
  }
  if (p) {
    saveJson('lock.pending', p);
    fact('pending lock', `restored ${p.hash} from the IndexedDB copy`);
  }
}
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
    setTimeout(verifyReceived, 0);
  }
}

// ---- network ----------------------------------------------------------------------------------------------------------------------------------
/** Shown on the page and thrown by connect when the build has no trust pin. */
const NO_PIN = 'This build has no trust pin (VITE_TRUST_PIN, wallet/.env.production), so the wallet does not connect: it does not take '
  + 'the trust root from the server it is meant to check. Rebuild with the pin, or set one under Network settings (developer option).';

async function connect(): Promise<string> {
  await restorePendingLock();
  const agg = new AggregatorClient(abs(settings.aggregator));
  const pin = settings.trustPin.trim();
  if (!pin) throw new Error(NO_PIN);
  let cfgError = '';
  session = null;
  try {
    const { cfg, fileUrl } = await fetchTesterConfig(settings.testerConfig);
    fact('tester-config', `vault ${cfg.vault}, chain ${cfg.chainId}`);
    // informational only: what the operator publishes is never used as the pin
    const published = await fetch(fileUrl('trustEntryId')).then(async (r) => (r.ok ? (await r.text()).trim() : '')).catch(() => '');
    if (published && published.toLowerCase() !== pin.toLowerCase()) fact('warning', `the operator publishes genesis ${published}, not the pinned ${pin}: this build is for another network generation`);
  } catch (e) {
    cfgError = String(e);
  }
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
  fact('trust pin', `${pin} (from ${pinOverridden(settings) ? 'the Network settings: a developer override' : 'the build'})`);
  fact('trust history', `${r.source}, epochs ${trust.history.entries[0].epoch}..${trust.history.tip?.epoch}`);
  if (cfgError) {
    fact('bridge', cfgError);
    return `trust loaded (epoch ${trust.history.tip?.epoch}); no bridge: ${cfgError}`;
  }
  session = await bridge.openSession(settings, trust);
  for (const t of listTokens()) if (t.phase === 'received') toVerify.add(t.id);
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
  /** a line under the step about what a Run will do (a pending transaction it resumes) */
  note?: (t: TokenRecord | undefined) => string | undefined;
  /** the pending transaction kind this step resumes: its row offers "discard pending" */
  resumes?: 'transfer' | 'burn';
  run: () => Promise<string>;
}

const amountInput = h('input', { value: load('amount') ?? '0.001', size: '8', inputmode: 'decimal', 'aria-label': 'amount in UCT' });
const recipientInput = h('input', { placeholder: 'EVM address (default: this wallet)', size: '44', 'aria-label': 'return recipient' });
const peerSelect = h('select', { 'aria-label': 'receiving tab' });

/** The token record's side of a transfer or burn: its pending and discarded transactions. */
const spendCtx = (t: TokenRecord): bridge.SpendCtx => ({
  pending: t.pending,
  discarded: t.discarded,
  persist: (p) => patchToken(t.id, { pending: p }),
  restore: (p) => patchToken(t.id, { pending: p, discarded: (getToken(t.id)?.discarded ?? []).filter((x) => x.cd !== p.cd) }),
});

const resumes = (t: TokenRecord | undefined, kind: 'transfer' | 'burn'): string | undefined =>
  t?.pending?.kind === kind ? `A ${kind} built ${new Date(t.pending.at).toLocaleTimeString()} is stored: Run certifies that same transaction, it never builds another.`
    + (t.pending.refused ? ` The aggregator refused it (${t.pending.refused}): it can be discarded.` : '') : undefined;

const STEPS: StepDef[] = [
  {
    key: 'lock', title: 'Lock', what: 'BridgeVault.lock(p0) with value: p0 is this key\'s owner predicate. The nonce comes from the receipt\'s Locked log.',
    input: () => h('label', {}, amountInput, ' UCT'),
    note: () => {
      const p = pendingLock.get();
      if (p?.from && p.from.toLowerCase() !== me.evmAddress.toLowerCase()) return `Lock ${p.hash.slice(0, 18)}… is pending, signed by ${p.from}, not this key: import that key again to finish it. It is kept.`;
      return p ? `Lock ${p.hash.slice(0, 18)}… (${fmtUnits(BigInt(p.amountWei))} UCT) is pending: Run polls it; no second lock is sent.` : undefined;
    },
    run: async () => {
      save('amount', amountInput.value);
      const l = await bridge.lock(sess(), me, pendingLock.get() ? 0n : parseUnits(amountInput.value), pendingLock);
      const id = l.nonce.toString();
      if (!getToken(id)) putToken({ id, nonce: id, amountWei: l.amountWei.toString(), phase: 'locked', lockTx: l.lockTx, lockBlockHash: l.lockBlockHash });
      select(id);
      await refreshBalances();
      return `${l.resumed ? 'the pending lock is mined: ' : ''}locked ${fmtUnits(l.amountWei)} UCT as nonce ${id}`;
    },
  },
  {
    key: 'lockproof', title: 'Lock proof', phase: 'locked', what: 'GET /lockproof/v1/lockproof?block=&nonce=: header, account and storage proofs of the lock, and the EVM shard\'s certificate. 404 until the block is certified.',
    run: async () => {
      const t = currentOr('select a token');
      const p = await bridge.fetchLockProof(sess(), { nonce: BigInt(t.nonce), lockBlockHash: t.lockBlockHash! });
      patchToken(t.id, { phase: 'proved', lockProof: hex(p) });
      return `${p.length} bytes`;
    },
  },
  {
    key: 'mint', title: 'Mint', phase: 'proved', what: 'A mint transaction justified by the lock proof, certified by the aggregator; then verified offline by the plug-in.',
    run: async () => {
      const t = currentOr('select a token');
      const l = { nonce: BigInt(t.nonce), amountWei: BigInt(t.amountWei), lockTx: t.lockTx!, lockBlockHash: t.lockBlockHash!, blockNumber: 0n };
      const { bytes, tokenId } = await bridge.mint(sess(), me, l, unhex(t.lockProof!));
      patchToken(t.id, { phase: 'minted', bytes: hex(bytes), tokenId });
      return `token ${tokenId.slice(0, 12)}…, ${bytes.length} bytes`;
    },
  },
  {
    key: 'transfer', title: 'Transfer to another tab', phase: 'minted', what: 'A certified transfer to the other tab\'s public key, then the token file goes over a BroadcastChannel. The receiver stores it, then verifies it offline.',
    input: () => h('span', {}, peerSelect, ' ', h('button', { class: 'link', onclick: () => window.open(`?w=${PROFILE === 'b' ? 'a' : 'b'}`, '_blank') }, `open tab ${PROFILE === 'b' ? 'A' : 'B'}`)),
    note: (t) => resumes(t, 'transfer') && `${resumes(t, 'transfer')} Its recipient is tab ${(t?.pending?.toProfile ?? t?.to)?.toUpperCase()}.`,
    resumes: 'transfer',
    run: async () => {
      const t = currentOr('select a token');
      const resume = t.pending?.kind === 'transfer' ? t.pending : undefined;
      const peer = resume ? undefined : need(peers.get(peerSelect.value), 'no receiving tab: open one with the link');
      const toProfile = resume ? need(resume.toProfile ?? t.to, 'the pending transfer has no recipient tab') : peer!.profile;
      const toKey = resume ? need(resume.toPublicKey, 'the pending transfer has no recipient key') : peer!.publicKey;
      const r = await bridge.transfer(sess(), me, unhex(t.bytes!), { publicKey: unhex(toKey), profile: toProfile }, spendCtx(t));
      // a restored (discarded, then certified) transfer has its own recipient
      const to = need(r.used.toProfile ?? toProfile, 'the certified transfer has no recipient tab');
      const out = r.bytes;
      // stored as sent before it is posted: if the other tab misses it, "Resend" posts it again
      patchToken(t.id, { phase: 'sent', bytes: hex(out), to, toPublicKey: r.used.toPublicKey ?? toKey, pending: undefined });
      handoff.sendToken(to, out, BigInt(t.amountWei));
      fact('handed to', `tab ${to.toUpperCase()} (${(r.used.toPublicKey ?? toKey).slice(0, 16)}…)`);
      return `sent to tab ${to.toUpperCase()}`;
    },
  },
  {
    key: 'resend', title: 'Resend to the receiving tab', phase: 'sent', what: 'Posts the stored token file (already certified to the other tab\'s key) again, for when that tab was closed or missed it. Nothing is certified again.',
    run: async () => {
      const t = currentOr('select a token');
      const to = need(t.to, 'this token has no receiving tab');
      const p = peers.get(to);
      if (!p) throw new Error(`tab ${to.toUpperCase()} is not open: open it (link under Transfer), then resend`);
      if (t.toPublicKey && p.publicKey !== t.toPublicKey) throw new Error(`tab ${to.toUpperCase()} now has another key (${p.publicKey.slice(0, 16)}…): the token is owned by ${t.toPublicKey.slice(0, 16)}…`);
      handoff.sendToken(to, unhex(t.bytes!), BigInt(t.amountWei));
      fact('posted again to', `tab ${to.toUpperCase()}, ${t.bytes!.length / 2} bytes`);
      return `resent to tab ${to.toUpperCase()}`;
    },
  },
  {
    key: 'receive', title: 'Verify received token', phase: 'received', what: 'The token file was stored when it arrived. The plug-in verifies it offline (held, not burned) and checks this key is its owner. Retried when the page is free.',
    note: (t) => (t?.phase === 'received' && t.verifyError ? `Last attempt failed: ${t.verifyError}` : undefined),
    run: () => verifyOne(currentOr('select a token').id),
  },
  {
    key: 'burn', title: 'Burn for return', phase: 'minted', what: 'A transfer to BurnPredicate(sha256(reason)); the reason names the EVM recipient and the amount the vault will credit.',
    input: () => recipientInput,
    note: (t) => resumes(t, 'burn') && `${resumes(t, 'burn')} Its recipient is ${t?.pending?.recipient}.`,
    resumes: 'burn',
    run: async () => {
      const t = currentOr('select a token');
      const to = t.pending?.kind === 'burn' ? need(t.pending.recipient, 'the pending burn has no recipient') : recipientInput.value.trim() || me.evmAddress;
      if (!isAddress(to)) throw new Error(`not an address: ${to}`);
      const r = await bridge.burn(sess(), me, unhex(t.bytes!), to, spendCtx(t));
      const recipient = r.used.recipient ?? to;
      patchToken(t.id, { phase: 'burned', bytes: hex(r.bytes), recipient, pending: undefined });
      return `burned for ${recipient.slice(0, 10)}…`;
    },
  },
  {
    key: 'returnproof', title: 'Return proof', phase: 'burned', what: 'The aggregator consolidates the token\'s proofs under one seal; the plug-in verifies them and assembles the redeem envelope.',
    run: async () => {
      const t = currentOr('select a token');
      const r = await bridge.returnProof(sess(), unhex(t.bytes!));
      patchToken(t.id, { phase: 'enveloped', envelope: hex(r.encoded) });
      return `${r.encoded.length} bytes, ${r.consolidated ? 'consolidated' : 'per state id'}`;
    },
  },
  {
    key: 'redeem', title: 'Redeem', phase: 'enveloped', what: 'eth_call redeem(envelope) until the vault accepts (the registry must reach the seal\'s round), then send it. Anyone may send it.',
    run: async () => {
      const t = currentOr('select a token');
      const r = await bridge.redeem(sess(), me, unhex(t.envelope!), { nonce: BigInt(t.nonce), tokenId: t.tokenId! }, (hash) => patchToken(t.id, { redeemTx: hash }));
      if (r.already) {
        patchToken(t.id, { phase: 'redeemed' });
        await refreshBalances();
        return 'already redeemed: the vault answers PartAlreadyRedeemed (an earlier redeem was mined)';
      }
      patchToken(t.id, { phase: 'redeemed', redeemTx: r.rc.transactionHash });
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
/** Received records to verify when the page is free (step() calls verifyReceived after every step). */
const toVerify = new Set<string>();

const handoff = new Handoff(PROFILE, me, {
  peer: (p) => {
    peers.set(p.profile, p);
    render();
  },
  // stored first, whatever the page is doing; verified afterwards (verifyReceived), with a retry on the step row
  token: (m) => {
    const id = `rx-${hex(sha256(unhex(m.bytes))).slice(0, 12)}`;
    const held = getToken(id);
    if (held && held.phase !== 'received') {
      status.set('arrival', { ok: true, text: `tab ${m.from.toUpperCase()} sent a token this wallet already holds (${held.phase})` });
    } else {
      status.delete('receive');
      if (!held) putToken({ id, nonce: '', amountWei: m.amountWei, phase: 'received', bytes: m.bytes, from: m.from, receivedAt: Date.now() });
      status.set('arrival', { ok: true, text: `stored a token from tab ${m.from.toUpperCase()} (${m.bytes.length / 2} bytes); not verified yet` });
      if (!busy) select(id);
      toVerify.add(id);
    }
    render();
    setTimeout(verifyReceived, 0);
  },
});

/** Verify one received record: the plug-in and the owner check; then it is a held token ('minted'). A failure is kept on the record. */
async function verifyOne(id: string): Promise<string> {
  const t = need(getToken(id), `no token record ${id}`);
  if (t.phase !== 'received') return `already verified (${t.phase})`;
  fact('from', `tab ${t.from?.toUpperCase()}, ${t.bytes!.length / 2} bytes, stored ${t.receivedAt ? new Date(t.receivedAt).toISOString() : '?'}`);
  try {
    const s = sess();
    const { verified } = await bridge.withTrust(s, () => acceptToken(s.bridge, t.bytes!, me.publicKey));
    const tokenId = hex(verified.outcome.tokenId);
    fact('verified', `token ${tokenId}, lock nonce ${verified.outcome.nonce}, owner = this key`);
    patchToken(id, { phase: 'minted', tokenId, nonce: verified.outcome.nonce.toString(), amountWei: BigInt(`0x${hex(verified.outcome.amount) || '0'}`).toString(), verifyError: undefined });
    select(id);
    return `received a verified token from tab ${t.from?.toUpperCase()}`;
  } catch (e) {
    patchToken(id, { verifyError: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/** When the page is free and connected, verify the next stored, unverified token (one at a time, each attempt once per page load). */
function verifyReceived(): void {
  if (busy || !session) return;
  const id = [...toVerify][0];
  if (id === undefined) return;
  toVerify.delete(id);
  if (getToken(id)?.phase !== 'received') return verifyReceived();
  void step('receive', () => verifyOne(id));
}

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
    d.note?.(t) ? h('p', { class: 'warn' }, d.note(t)!,
      // only after an explicit refusal: a timeout means the request may still be certified
      d.resumes && t?.pending?.kind === d.resumes && t.pending.refused ? h('button', { class: 'link', disabled: !!busy || !session, onclick: () => discardPending(t.id, d.key) }, 'discard pending') : '') : '',
    drawer(d.key));
}
/**
 * Drop a stored transfer or burn the aggregator will not certify (a refusal), so the token can be spent again. Asks first, then probes the
 * aggregator: a request that is certified (for this transaction or another) is never discarded. The dropped request stays on the record.
 */
function discardPending(id: string, key: string): void {
  const t = getToken(id);
  const p = t?.pending;
  if (!p?.refused) return;
  if (!confirm(`Discard the pending ${p.kind}? The aggregator refused it (${p.refused}). It is checked again first: if the ${p.kind} is `
    + 'certified or still being included, it is kept. After a discard, Run builds a new transaction; if the discarded one is certified after all, it is restored.')) return;
  const why = status.get(key)?.text ?? 'discarded by the user';
  void step(key, async () => {
    const r = await bridge.probePending(sess().agg, p);
    fact('probe', { none: 'no proof for this state id, no pending hint', pending: 'the aggregator hints it is being included', ours: 'certified for this transaction', other: 'certified for another transaction' }[r]);
    if (r === 'pending') throw new Error(`the aggregator says the ${p.kind} is still being included: not discarded; Run waits for it`);
    if (r === 'ours') throw new Error(`the ${p.kind} is certified: not discarded; Run finishes it`);
    if (r === 'other') throw new Error(`the token's state is certified for another transaction: this token is spent elsewhere; the pending ${p.kind} is kept for the record`);
    patchToken(id, { pending: undefined, discarded: [...(getToken(id)?.discarded ?? []), { ...p, discardedAt: Date.now(), why }] });
    return `discarded the pending ${p.kind}: Run builds a new one`;
  });
}

/** What a finished step left on the token record. */
const DONE: Record<string, (t: TokenRecord) => boolean> = {
  lock: (t) => !!t.lockTx, lockproof: (t) => !!t.lockProof, mint: (t) => !!t.tokenId && !t.from, transfer: (t) => t.phase === 'sent' || (!!t.to && !t.pending),
  receive: (t) => !!t.from && t.phase !== 'received',
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
        onclick: async () => {
          try {
            const secret = parseBackup(importBox.value);
            // a lock or transaction in flight is bound to this key: replacing it would strand it
            const blocking = await pendingWork();
            if (blocking.length) {
              showBackup();
              alert(`This tab's key cannot be replaced while work signed by it is pending:\n\n- ${blocking.join('\n- ')}\n\n`
                + 'Finish it first (or discard a refused transfer or burn). Export the current key (shown below) before you replace it.');
              return;
            }
            // value only the old key can use: show the key and ask for a typed confirmation
            const atRisk = valueAtRisk({ address: me.evmAddress, ...(await readHoldings()), tokens: listTokens() });
            if (atRisk.length) {
              showBackup();
              const typed = prompt(`The current key still has:\n\n- ${atRisk.join('\n- ')}\n\nReplacing it deletes the only stored copy of its secret. `
                + `Save the current key first (shown on the page under Identity).\n\nType "${CONFIRM_WORD}" to replace it anyway.`);
              if (!confirmed(typed)) {
                alert('Not replaced: the current key is kept.');
                return;
              }
            }
            me = replaceKey(secret);
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

/**
 * A plain value transfer, so the other tab can pay gas for its own redeem and claim. The sent tx is stored until its receipt is read: while
 * it is, the button polls that transaction instead of sending another.
 */
function fundPeer(): HTMLElement | string {
  const p = [...peers.values()][0];
  const pending = loadJson<{ hash: string; to: string } | null>('fund.pending', null);
  if ((!p && !pending) || !session) return '';
  return h('button', {
    class: 'link', disabled: !!busy, onclick: () => void step('fund', async () => {
      const s = sess();
      let hash = pending?.hash;
      let to = pending?.to ?? p!.profile;
      if (hash) {
        fact('resuming', `the gas transfer ${hash} to tab ${to.toUpperCase()}: not sending another`);
      } else {
        const signed = await s.evm.sign(me.secret, { to: p!.evmAddress, value: 10n ** 15n, gas: 21_000n });
        saveJson('fund.pending', { hash: signed.hash, to: (to = p!.profile) });
        hash = signed.hash;
        fact('tx', hash);
        try {
          await s.evm.broadcast(signed.raw);
        } catch (e) {
          // a refusal of a tx the chain has not seen: nothing was sent
          if (bridge.isRefusal(e) && !(await s.evm.receipt(hash))) remove('fund.pending');
          throw e;
        }
      }
      const rc = await s.evm.waitReceipt(hash);
      remove('fund.pending');
      await refreshBalances();
      return `${rc.status === '0x1' ? 'sent' : 'reverted:'} 0.001 UCT to tab ${to.toUpperCase()}`;
    }),
  }, pending ? `check the pending gas transfer to tab ${pending.to.toUpperCase()}` : `send 0.001 UCT gas to tab ${p!.profile.toUpperCase()}`);
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
      ...toks.map((x) => h('option', { value: x.id, selected: x.id === currentId }, `${x.id.startsWith('rx-') ? 'received' : `lock ${x.id}`} · ${fmtUnits(BigInt(x.amountWei))} UCT · ${x.phase === 'received' ? 'received, not verified' : x.phase}${x.pending ? ` · ${x.pending.kind} pending` : ''}`)))
    : h('span', { class: 'muted' }, 'none yet: lock some UCT');
  peerSelect.replaceChildren(...[...peers.values()].map((p) => h('option', { value: p.profile }, `tab ${p.profile.toUpperCase()}`)));
  if (!peers.size) peerSelect.append(h('option', { value: '' }, 'no other tab'));
  return card('Asset flow',
    h('div', { class: 'row' }, h('span', {}, 'token: '), picker, t?.tokenId ? mono(t.tokenId) : ''),
    h('ol', { class: 'timeline' }, ...STEPS.map((d) => stepRow(d, t))),
    status.has('arrival') || status.has('receive') ? h('div', { class: 'row' }, h('strong', {}, 'Received'),
      ...(['arrival', 'receive'] as const).map((k) => status.get(k)).map((st) => (st ? h('span', { class: st.ok ? 'msg' : 'msg bad' }, st.text) : '')), drawer('receive')) : '');
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
    h('p', { class: 'warn' }, 'trustPin is a developer override: it replaces the trust root built into this page (', DEFAULTS.trustPin ? mono(DEFAULTS.trustPin) : 'none in this build',
      '). Every certificate the wallet accepts is checked against the history this pin starts. Set it only for a network you trust.'),
    h('div', { class: 'grid' }, ...inputs.flatMap(([k, el]) => [h('label', {}, k === 'trustPin' ? 'trustPin (developer override)' : k), el])),
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
    !settings.trustPin.trim() ? h('p', { class: 'banner bad' }, NO_PIN) : '',
    settings.trustPin.trim() && pinOverridden(settings)
      ? h('p', { class: 'banner warn' }, 'Developer override: the trust pin comes from Network settings, not from this build: ', mono(settings.trustPin)) : '');
}

const slots = { header: h('div'), identity: h('div'), trust: h('div'), flow: h('div'), check: h('div') };
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
