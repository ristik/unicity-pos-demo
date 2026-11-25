/**
 * The demo wallet page: identity, faucet, the asset-flow timeline (native bridge v2), the trust history and the old-epoch / forgery check.
 * Token records and the bridge's journal live in IndexedDB (idb.ts, tokens.ts); each step runs through `step()`, which records what it sent and
 * received for its "explain" drawer.
 */
import './style.css';

import { TrustInput } from '@unicitylabs/native-bridge-plugin';
import { AmbiguousBroadcast, RpcError, signTx, type IntentsRecord } from '@unicitylabs/native-bridge-plugin/nb2';
import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { abs, COMPATIBLE_RELEASE_PLUGIN, DEFAULTS, loadSettings, pinOverridden, RELEASE_DIGEST, saveSettings, type Settings } from './config.js';
import { isAddress } from './evm.js';
import * as faucet from './faucet.js';
import { forgeRelabelled, forgeUnknownKeys, sealTable, verdict } from './forge.js';
import { acceptToken, announceHandoff, Handoff, type Peer } from './handoff.js';
import { fmtUnits, hex, parseUnits, sleep, unhex, waitFor } from './hex.js';
import { acquireWriter, IdbKv } from './idb.js';
import { CONFIRM_WORD, confirmed, valueAtRisk } from './importguard.js';
import { legacyKeysOf } from './work.js';
import { READ_ONLY_OK, VALUE_STEPS, importBlock, OperationGuard, refusal } from './guard.js';
import { burnerFrom, loadExisting, loadOrCreateDurable, parseBackup, replaceKeyDurable, toMnemonic, type Burner } from './keys.js';
import * as nb2 from './nb2.js';
import { checkReleaseDigest, checkRevision, fetchRelease, type Published } from './release.js';
import { encodeReturnBackup, readPayerPolicy } from './recovery.js';
import { chooseReturnBackup, type SaveReturnBackup } from './return-backup.js';
import { load, loadJson, PROFILE, remove, save, saveJson } from './store.js';
import { getToken, initTokens, listTokens, patchToken, putToken, putTokens, tokensOpen, type Phase, type TokenRecord } from './tokens.js';
import { begin, end, fact, installFetchTrace, reportStepFailure, type Trace } from './trace.js';
import { bootstrapTrust, entries, refreshTrust } from './trust.js';
import { copyable, explain, h, mono } from './ui.js';

installFetchTrace();

/** The plug-in commit this build bundles (vendor/native-bridge-plugin.provenance.json, set by vite.config.ts). */
declare const __NBP_COMMIT__: string | undefined;
const BUILD_NBP = typeof __NBP_COMMIT__ === 'string' ? __NBP_COMMIT__ : null;

// ---- state ------------------------------------------------------------------------------------------------------------------------------------
const settings: Settings = loadSettings();
/** The key. A page that is not the profile's one writer never creates one: it shows the stored key, or a throwaway that is never used (start() resolves it). */
let me: Burner = loadExisting() ?? burnerFrom(secp256k1.utils.randomSecretKey());
let trust: TrustInput | null = null;
let published: Published | null = null;
let session: nb2.Session | null = null;
let currentId: string | null = load('current');
let busy: string | null = null;
const opGuard = new OperationGuard();
let balance: bigint | null = null;
let intentMark: string | null = null;
/** null: the durable store is ready and this page is the profile's one writer; else why the wallet will not move value */
let storeProblem: string | null = 'starting: the wallet is read-only until the writer lock and its durable key are ready';
/** false until the lock, the key, the deployment's records, any recovery and the reconciliation are done: no value moves before */
let ready = false;
/** the key is committed to the durable store and this page is the profile's writer: only then is its address shown or funded */
let keyDurable = false;
const kv = new IdbKv(PROFILE);
const traces = new Map<string, Trace>();
const status = new Map<string, { ok: boolean; text: string }>();
const peers = new Map<string, Peer>();
const dark = matchMedia('(prefers-color-scheme: dark)').matches;

const current = (): TokenRecord | undefined => getToken(currentId);
const select = (id: string): void => {
  currentId = id;
  save('current', id);
};
/** The selected record when a step starts: the step works on it by id, even if the selection changes while a step runs. */
const currentOr = (what: string): TokenRecord => need(current(), what);
const need = <T>(v: T | null | undefined, what: string): T => {
  if (v === null || v === undefined) throw new Error(what);
  return v;
};
const sess = (): nb2.Session => need(session, 'the bridge is not loaded (see Network)');
const bytesOf = (t: TokenRecord): Uint8Array => unhex(need(t.bytes, `token ${t.id} has no token file`));

/** records an older build wrote without a deployment scope (`tok/<id>`, or a localStorage funding record): not read; the page offers a reset */
let legacyKeys: string[] = [];
/** the funding transaction signed and stored for tab B, until its receipt is read (durable, in the store) */
let fundPending: { hash: string; raw: string; to: string } | null = null;
let fundKey = '';

/** Store the intent high-water mark with the key backup (guide: before any deposit is sent): durably, and shown beside the exported key. */
async function backupIntents(i: IntentsRecord): Promise<void> {
  await kv.put('backup/intents', JSON.stringify(i));
  intentMark = i.next;
  save('intents.backup', i.next);
  render();
}

/** Run one step: its trace is kept for the drawer, its outcome shown on its row. */
async function step(key: string, fn: () => Promise<string | void>, prepare?: () => Promise<void>): Promise<void> {
  if (!opGuard.tryEnter(key)) return;
  busy = key;
  status.delete(key);
  render();
  const t = begin();
  try {
    const why = refusal(key, { storeProblem, ready, legacy: legacyKeys.length > 0, keyDurable });
    if (why) throw new Error(why);
    await prepare?.();
    if (VALUE_STEPS.has(key)) await nb2.checkInstallation(sess());
    const msg = await fn();
    status.set(key, { ok: true, text: msg ?? 'done' });
  } catch (e) {
    status.set(key, reportStepFailure(e));
  } finally {
    end(t);
    traces.set(key, t);
    busy = null;
    opGuard.leave();
    render();
    setTimeout(verifyReceived, 0);
  }
}

// ---- network ----------------------------------------------------------------------------------------------------------------------------------
/** Shown on the page and thrown by connect when the build has no trust pin. */
const NO_PIN = 'This build has no trust pin (VITE_TRUST_PIN, wallet/.env.production), so the wallet does not connect: it does not take '
  + 'the trust root from the server it is meant to check. Rebuild with the pin, or set one under Network settings (developer option).';

async function connect(): Promise<string> {
  const agg = new AggregatorClient(abs(settings.aggregator));
  const pin = settings.trustPin.trim();
  if (!pin) throw new Error(NO_PIN);
  let cfgError = '';
  session = null;
  published = null;
  ready = false;
  try {
    published = await fetchRelease(settings.release);
    const r = published.release;
    fact('release', `${published.url}: chain ${r.package?.chainId ?? '?'}, ${published.pins.build} vault build, deployment block ${published.pins.deploymentBlock}`);
    // informational only: what the operator publishes is never used as the pin
    if (published.publishedPin && published.publishedPin !== pin.toLowerCase().replace(/^0x/, '')) {
      fact('warning', `the operator publishes genesis ${published.publishedPin}, not the pinned ${pin}: this build is for another network generation`);
    }
    checkReleaseDigest(published, RELEASE_DIGEST);
    checkRevision(published.pluginCommit, BUILD_NBP, COMPATIBLE_RELEASE_PLUGIN);
  } catch (e) {
    cfgError = String(e);
  }
  const r = await bootstrapTrust(agg, pin, settings.network, '', published?.bundle);
  trust = r.trust;
  if (!storeProblem) {
    const saved = await kv.get(`return/authority/${hex(trust.id)}`);
    if (saved) {
      const held = await TrustInput.fromBundle(unhex(saved), trust.id);
      for (const entry of held.history.entries) await trust.history.append(entry);
    }
  }
  fact('trust pin', `${pin} (from ${pinOverridden(settings) ? 'the Network settings: a developer override' : 'the build'})`);
  if (cfgError) {
    fact('bridge', cfgError);
    return `trust loaded (epoch ${trust.history.tip?.epoch}); no bridge: ${cfgError}`;
  }
  fact('trust history', `${r.source}, epochs ${trust.history.entries[0].epoch}..${trust.history.tip?.epoch}`);
  session = await nb2.openSession({
    settings, me, trust, published: published!, journal: kv, backup: backupIntents,
    refreshTrust: async () => {
      if (navigator.onLine === false) throw new Error('Trust history is unavailable offline');
      await refreshWalletTrust(agg);
      return trust!;
    },
  });
  fact('installation check', `chain ${session.bridge.cfg.chainId}, config() = the pinned Γ, the vault's runtime code hash: passed`);
  intentMark = (await session.bridge.journal.intents())?.next ?? intentMark;
  // the records of this deployment and key only (the domain D and the owner key scope them): another deployment never meets these
  await initTokens(kv, `${hex(session.bridge.domain)}.${hex(me.publicKey).slice(0, 16)}`);
  fundKey = `fund/pending/${hex(session.bridge.domain)}.${hex(me.publicKey).slice(0, 16)}`;
  const fp = await kv.get(fundKey);
  fundPending = fp ? (JSON.parse(fp) as { hash: string; raw: string; to: string }) : null;
  if (!storeProblem) {
    // an import with the exported intent mark: find the deposits of this seed on the chain before anything else
    const rr = await kv.get('recover/next');
    const req = rr ? (JSON.parse(rr) as { next: string; domain: string }) : null;
    // bound to the deployment it was asked on: another deployment leaves it for its own connect
    if (req && req.domain === hex(session.bridge.domain)) {
      const found = await session.bridge.recoverDeposits(BigInt(req.next));
      await kv.delete('recover/next');
      fact('recovered deposits', `intents below ${req.next}: ${found.length} deposit number(s) found`);
      intentMark = (await session.bridge.journal.intents())?.next ?? intentMark;
    }
    await reconcileRecords();
  }
  if (!currentId || !getToken(currentId)) {
    const last = listTokens().at(-1);
    if (last) select(last.id);
  }
  // writer, durable key, records and reconciliation are settled: only now does this tab take part in a handoff, and only for this deployment
  if (!storeProblem && !legacyKeys.length) {
    ready = true;
  }
  for (const t of listTokens()) if (t.phase === 'received') toVerify.add(t.id);
  await refreshBalances();
  return `connected: chain ${session.bridge.cfg.chainId}, vault 0x${hex(session.bridge.cfg.vault).slice(0, 8)}…, trust tip epoch ${trust.history.tip?.epoch}`;
}

async function refreshBalances(): Promise<void> {
  if (!session) return;
  balance = await nb2.balanceOf(session, me.evmAddress);
}

/**
 * After a crash the journal can be ahead of the wallet's records (the plug-in journals each step before the wallet saves its own record of it).
 * Bring the records up to the journal: a deposit with no record gets one, a record behind its deposit or return moves forward.
 */
async function reconcileRecords(): Promise<void> {
  const s = sess();
  for (const d of await s.bridge.journal.deposits()) {
    const id = `d${d.intent}`;
    const phase: Phase = d.status === 'minted' ? 'minted' : d.status === 'proven' ? 'proven' : d.status === 'deposited' ? 'deposited' : 'planned';
    const rec = getToken(id);
    if (!rec) {
      await putToken({ id, amountWei: d.amount, phase, intent: d.intent, ...(d.depositNumber ? { depositNumber: d.depositNumber, depositBlock: d.blockNumber, depositTx: d.depositTx } : {}), ...(d.token ? { bytes: d.token.replace(/^0x/, '') } : {}) });
      fact('recovered', `deposit ${d.intent} (${d.status}) from the journal`);
    } else if (rec.phase === 'planned' || rec.phase === 'deposited' || rec.phase === 'proven') {
      const rank = { planned: 0, deposited: 1, proven: 2, minted: 3 } as const;
      if (rank[phase as keyof typeof rank] > rank[rec.phase]) {
        await patchToken(id, { phase, ...(d.depositNumber ? { depositNumber: d.depositNumber, depositBlock: d.blockNumber, depositTx: d.depositTx } : {}), ...(d.token && phase === 'minted' ? { bytes: d.token.replace(/^0x/, '') } : {}) });
        fact('recovered', `deposit ${d.intent}: the journal is at ${d.status}`);
      }
    }
  }
  for (const r of await s.bridge.journal.returns()) {
    const rec = listTokens().find((t) => t.returnId?.toLowerCase() === r.returnId.toLowerCase());
    if (!rec) continue;
    if (r.status === 'paid' && rec.phase !== 'redeemed') await patchToken(rec.id, { phase: 'redeemed', ...(r.paid ? { redeemTx: r.paid.txHash } : {}), eta: r.eta });
    else if ((r.status === 'burned' || r.status === 'submitted') && rec.phase === 'minted') await patchToken(rec.id, { phase: 'burned', eta: r.eta, burning: undefined, ...(r.burned ? { bytes: r.burned.replace(/^0x/, '') } : {}) });
    else if (r.status === 'planned' && rec.burning) await patchToken(rec.id, { burning: undefined });
  }
}

// ---- the asset-flow steps -----------------------------------------------------------------------------------------------------------------------
interface StepDef {
  key: string;
  title: string;
  what: string;
  /** the phases the current token may be in (undefined: no token needed) */
  phase?: Phase[];
  /** extra condition on the record */
  when?: (t: TokenRecord) => boolean;
  input?: () => HTMLElement;
  /** a line under the step about what a Run will do (a pending transaction it resumes) */
  note?: (t: TokenRecord | undefined) => string | undefined;
  run: (saveBackup?: SaveReturnBackup) => Promise<string>;
}

const amountInput = h('input', { value: load('amount') ?? '0.1', size: '8', inputmode: 'decimal', 'aria-label': 'deposit amount in UCT' });
const splitInput = h('input', { value: load('split') ?? '0.04', size: '8', inputmode: 'decimal', 'aria-label': 'part to return in UCT' });
const recipientField = () => h('input', { placeholder: 'EVM address (default: this wallet)', size: '44', 'aria-label': 'return recipient',
  oninput: (e: Event) => {
    const value = (e.target as HTMLInputElement).value;
    planRecipient.value = burnRecipient.value = value;
  },
});
const planRecipient = recipientField();
const burnRecipient = recipientField();
const policyInput = h('textarea', { id: 'return-policy', rows: '5', 'aria-label': 'return payer policy',
  placeholder: 'Paste the day-of-demo payer policy JSON',
});
// Clear policies retained by the earlier build. The current input stays in this page only.
remove('return.policy');
const coldRoute = h('input', { type: 'checkbox', 'aria-label': 'use continuation if ordinary no longer fits' });
const policy = () => policyInput.value.trim() ? readPayerPolicy(policyInput.value) : undefined;

const peerSelect = h('select', { 'aria-label': 'receiving tab' });

const spendable = (t: TokenRecord): boolean => !t.burning && !t.pending;
const pad = (n: bigint): string => fmtUnits(n);
const recipientOf = (t: TokenRecord): string => {
  const to = (t.recipient ?? planRecipient.value.trim()) || me.evmAddress;
  if (!isAddress(to)) throw new Error(`not an address: ${to}`);
  return to;
};

const STEPS: StepDef[] = [
  {
    key: 'deposit', title: 'Deposit', what: 'The wallet derives a deposit secret from its key and a fresh intent number, journals it, backs up the intent high-water mark, and only then sends deposit(firstOwner, rho) with the value to the vault. The vault numbers the deposit (Deposited event).',
    input: () => h('label', {}, amountInput, ' UCT'),
    note: (t) => (t?.phase === 'planned' ? `Deposit intent ${t.intent} is planned and journaled: Run sends it, or finds the earlier send. It never deposits twice.` : undefined),
    run: async () => {
      save('amount', amountInput.value);
      const planned = current()?.phase === 'planned' ? current() : listTokens().find((t) => t.phase === 'planned');
      let rec = planned;
      if (!rec) {
        const plan = await nb2.planDeposit(sess(), parseUnits(amountInput.value));
        rec = { id: `d${plan.intent}`, amountWei: plan.amount.toString(), phase: 'planned', intent: plan.intent.toString() };
        await putToken(rec);
      }
      select(rec.id);
      await nb2.finishBackup(sess(), BigInt(rec.intent!));
      const r = await nb2.sendDeposit(sess(), BigInt(rec.intent!));
      await patchToken(rec.id, { phase: 'deposited', depositNumber: r.depositNumber.toString(), depositBlock: r.blockNumber.toString(), depositTx: `0x${hex(r.txHash)}` });
      await refreshBalances();
      return `deposit ${r.depositNumber} of ${fmtUnits(BigInt(rec.amountWei))} UCT in block ${r.blockNumber}`;
    },
  },
  {
    key: 'mint', title: 'Mint', phase: ['deposited', 'proven'], what: 'Once the deposit block has a child block, its certificate is served (CompanionUnknown until then). The wallet builds the receipt proof J from the block\'s receipts, checks it offline, journals it, and mints an ordinary Unicity token with J as its reason. No claim step.',
    run: async () => {
      const t = currentOr('select a deposit');
      const r = await nb2.mint(sess(), BigInt(t.intent!), (why) => fact('waiting', why));
      await patchToken(t.id, { phase: 'minted', bytes: hex(r.token), tokenId: hex(r.tokenId), amountWei: r.amount.toString(), jBytes: r.jBytes, depositNumber: r.depositNumber.toString() });
      return `token ${hex(r.tokenId).slice(0, 12)}…, ${r.token.length} bytes, J ${r.jBytes} bytes`;
    },
  },
  {
    key: 'split', title: 'Split', phase: ['minted', 'splitting'], when: spendable, what: 'A bridge token returns whole, so to return only part of it, split it first: two whole parts (the part to return, and the rest), both to this key. An ordinary Unicity split; the vault is not involved. The plug-in journals the split, so a rerun resumes.',
    input: () => h('label', {}, 'return part ', splitInput, ' UCT'),
    note: (t) => (t?.phase === 'splitting' ? `The split of ${t.id} into ${(t.splitAmounts ?? []).map((a) => fmtUnits(BigInt(a))).join(' + ')} UCT is not finished: Run resumes it.` : undefined),
    run: async () => {
      save('split', splitInput.value);
      const t = currentOr('select a token');
      let amounts: bigint[];
      if (t.phase === 'splitting') {
        amounts = t.splitAmounts!.map((a) => BigInt(a));
      } else {
        amounts = nb2.splitAmounts(BigInt(t.amountWei), parseUnits(splitInput.value));
        // the plan is saved before the split starts: a crash leaves a record that says how to resume
        await patchToken(t.id, { phase: 'splitting', splitInto: [`${t.id}.keep`, `${t.id}.back`], splitAmounts: amounts.map(String) });
      }
      const parts = await nb2.split(sess(), bytesOf(t), amounts);
      const ids = getToken(t.id)!.splitInto!;
      // the parts and the parent's change to `split` are published in ONE transaction: the parts are not spendable before the parent is
      // committed, and a resume never rewrites a part that has moved on (it only runs while the parent is still `splitting`)
      const recs: TokenRecord[] = [];
      for (let i = 0; i < parts.length; i++) {
        const v = await sess().bridge.verifyToken(parts[i]);
        recs.push({ id: ids[i], amountWei: amounts[i].toString(), phase: 'minted', bytes: hex(parts[i]), tokenId: hex(v.tokenId), parent: t.id });
      }
      if (getToken(t.id)!.phase !== 'splitting' || ids.some((id) => getToken(id))) throw new Error('the split was already published');
      await putTokens([...recs, { ...getToken(t.id)!, phase: 'split' }]);
      select(ids[1]);
      return `split into ${pad(amounts[0])} (keep) + ${pad(amounts[1])} (back) UCT`;
    },
  },
  {
    key: 'transfer', title: 'Transfer to another tab', phase: ['minted'], when: (t) => !t.burning, what: 'A certified transfer to the other tab\'s public key, then the token file goes over a BroadcastChannel. The wallet stores the exact request (with its random state mask) before it certifies it, so a retry certifies the same request. The receiver stores the file, then verifies it offline.',
    input: () => h('span', {}, h('button', { class: 'link', disabled: !ready || !!handoff || !!busy, onclick: () => void step('handoff', enableHandoff) }, handoff ? 'handoff on' : 'take part in handoff'), ' ', peerSelect, ' ', h('button', { class: 'link', onclick: () => window.open(`?w=${PROFILE === 'b' ? 'a' : 'b'}`, '_blank') }, `open tab ${PROFILE === 'b' ? 'A' : 'B'}`)),
    note: (t) => (t?.pending ? `A transfer built ${new Date(t.pending.at).toLocaleTimeString()} for tab ${t.pending.toProfile.toUpperCase()} is stored: Run certifies that same request, it never builds another.` : undefined),
    run: async () => {
      const t = currentOr('select a token');
      let pending = t.pending;
      if (pending && pending.signer !== hex(me.publicKey)) throw new Error('the pending transfer was signed by another key: import that key again to finish it');
      if (!pending) {
        const peer = need(peers.get(peerSelect.value), 'no receiving tab: open one with the link');
        const p = await nb2.prepareTransfer(sess(), bytesOf(t), unhex(peer.publicKey));
        pending = { ...p, at: Date.now(), toPublicKey: peer.publicKey, toProfile: peer.profile, signer: hex(me.publicKey) };
        await patchToken(t.id, { pending }); // durable before certification
        fact('request stored', `${p.tx.length / 2} + ${p.cd.length / 2} bytes`);
      }
      const out = await nb2.finishTransfer(sess(), bytesOf(t), pending);
      // stored as sent before it is posted: if the other tab misses it, "Resend" posts it again
      await patchToken(t.id, { phase: 'sent', bytes: hex(out), to: pending.toProfile, toPublicKey: pending.toPublicKey, pending: undefined });
      need(handoff, 'this tab is not taking part in a handoff yet').sendToken(pending.toProfile, out, BigInt(t.amountWei));
      fact('handed to', `tab ${pending.toProfile.toUpperCase()} (${pending.toPublicKey.slice(0, 16)}…)`);
      return `sent to tab ${pending.toProfile.toUpperCase()}`;
    },
  },
  {
    key: 'resend', title: 'Resend to the receiving tab', phase: ['sent'], what: 'Posts the stored token file (already certified to the other tab\'s key) again, for when that tab was closed or missed it. Nothing is certified again.',
    run: async () => {
      const t = currentOr('select a token');
      const to = need(t.to, 'this token has no receiving tab');
      const p = peers.get(to);
      if (!p) throw new Error(`tab ${to.toUpperCase()} is not open: open it (link under Transfer), then resend`);
      if (t.toPublicKey && p.publicKey !== t.toPublicKey) throw new Error(`tab ${to.toUpperCase()} now has another key (${p.publicKey.slice(0, 16)}…): the token is owned by ${t.toPublicKey.slice(0, 16)}…`);
      need(handoff, 'this tab is not taking part in a handoff yet').sendToken(to, bytesOf(t), BigInt(t.amountWei));
      fact('posted again to', `tab ${to.toUpperCase()}, ${t.bytes!.length / 2} bytes`);
      return `resent to tab ${to.toUpperCase()}`;
    },
  },
  {
    key: 'receive', title: 'Verify received token', phase: ['received'], what: 'The token file was stored when it arrived. The plug-in verifies it offline (its receipt-backed origin, lineage and every certificate under the held trust history) and checks this key is its owner. Retried when the page is free.',
    note: (t) => (t?.phase === 'received' && t.verifyError ? `Last attempt failed: ${t.verifyError}` : undefined),
    run: () => verifyOne(currentOr('select a token').id),
  },
  {
    key: 'plan', title: 'Plan return (preflight)', phase: ['minted'], when: spendable, what: 'Nothing is burned. The plug-in verifies the part\'s lineage and the signed starting segment. The preflight prices the ordinary route first, then checks whether the calibrated continuation route fits the payer limits.',
    input: () => planRecipient,
    run: async () => {
      const t = currentOr('select a token');
      const to = recipientOf(t);
      const plan = await nb2.planReturn(sess(), bytesOf(t), unhex(to), (why) => fact('waiting', why), kv, policy());
      await patchToken(t.id, { returnId: `0x${hex(plan.returnId)}`, recipient: to, burnIndex: plan.a.toString() });
      return plan.record.recovery
        ? `Continuation admitted from segment ${plan.a} for ${plan.record.recovery.calls} calls`
        : `Ordinary return admitted from segment ${plan.a} with room for ${plan.pMax} historical proofs`;
    },
  },
  {
    key: 'burn', title: 'Burn for return', phase: ['minted'], when: (t) => !t.pending, what: 'The preflight runs again on fresh chain state, then the burn is certified: it signs the recipient, the amount and the index a, and its redemption ID eta is fixed from here on. The wallet submits the exact request once the private backup file is saved. The certified burn is irreversible.',
    input: () => burnRecipient,
    note: (t) => (t?.phase !== 'minted' ? undefined : t.burning ? 'A signed burn is held. Choose a private backup file and Run to resume the same request.' : t.returnId ? `Planned return ${t.returnId.slice(0, 14)}… to ${t.recipient}.` : undefined),
    run: async (saveBackup) => {
      const t = currentOr('select a token');
      const s = sess();
      const jr = t.returnId ? await nb2.returnRecord(s, t.returnId) : null;
      let id = t.returnId;
      if (jr === null || jr.status === 'planned') {
        const plan = await nb2.planReturn(s, bytesOf(t), unhex(jr ? jr.recipient : recipientOf(t)), (why) => fact('waiting', why), kv, policy());
        id = `0x${hex(plan.returnId)}`;
        await patchToken(t.id, { returnId: id, recipient: `0x${hex(plan.recipient)}`, burnIndex: plan.a.toString() });
      }
      // the token is marked before its burn request is journaled, so nothing else can spend the state the burn spends; a burn that never got
      // that far (a refused last preflight) takes the mark back
      await patchToken(t.id, { burning: true });
      let b: Awaited<ReturnType<typeof nb2.burn>>;
      try {
        b = await nb2.burn(s, unhex(id!), kv, need(saveBackup, 'Choose a private backup file'), (why) => fact('waiting', why), policy());
      } catch (e) {
        const r = await nb2.returnRecord(s, id!);
        if (r === null || r.status === 'planned') await patchToken(t.id, { burning: undefined });
        throw e;
      }
      await patchToken(t.id, { phase: 'burned', burning: undefined, eta: `0x${hex(b.eta)}`, bytes: hex(b.burned) });
      return `burned for ${getToken(t.id)!.recipient!.slice(0, 10)}…, redemption ID ${hex(b.eta).slice(0, 12)}…, ${b.evidenceBytes} evidence bytes`;
    },
  },
  {
    key: 'redeem', title: 'Redeem', phase: ['burned'],
    what: 'Ordinary redemption verifies segment proofs in one call. Continuation certifies bounded Progress packets, then certified gap advances if needed, and settles through redeemRecovered. Run resumes from the last certified checkpoint. Only a certified Paid receipt completes the return.',
    input: () => h('label', {}, coldRoute, ' Use continuation if the ordinary return no longer fits'),
    note: (t) => t?.returnProgress,
    run: async () => {
      const t = currentOr('select a token');
      const returnId = unhex(need(t.returnId, 'the token has no planned return'));
      const r = await nb2.redeem(sess(), returnId, (m) => fact('waiting', m), 60, 3_000, kv, policy(), coldRoute.checked);
      if (r.state === 'checkpoint' || r.state === 'retry') {
        const text = r.state === 'checkpoint'
          ? `${r.stage} certified at checkpoint ${r.sequence}. Run to advance.`
          : 'A certified refusal cleared the last attempt. Run to retry the packet.';
        fact('continuation transaction', `0x${hex(r.txHash)}`);
        await patchToken(t.id, { returnProgress: text });
        return text;
      }
      if (r.state === 'needs-archive') throw new Error(`Need an archive proof for 0x${hex(r.txHash)}. Add an archive RPC to the payer policy and retry.`);
      if (r.state === 'route-blocked') throw new Error(`The ${r.route} route still has a transaction to reconcile: 0x${hex(r.txHash)}`);
      if (r.state === 'not-paid' && r.lastFailure) {
        const rule = r.lastFailure.error;
        throw new Error(`Mined refusal: ${rule?.rule ?? 'unknown'}${rule?.inner ? ` (${rule.inner.rule})` : ''}`);
      }
      if (r.state !== 'paid') throw new Error(r.state === 'pending' ? 'Payment is pending. Run again to reconcile it.' : 'The burn is intact. Check the payer policy and retry.');
      await patchToken(t.id, { phase: 'redeemed', returnProgress: undefined, redeemTx: `0x${hex(r.txHash)}` });
      await refreshBalances();
      return `paid ${fmtUnits(BigInt(t.amountWei))} UCT to ${t.recipient?.slice(0, 10)}… in block ${r.blockNumber}`;
    },
  },
];

// ---- two-tab handoff ------------------------------------------------------------------------------------------------------------------------------
/** Received records to verify when the page is free (step() calls verifyReceived after every step). */
const toVerify = new Set<string>();

const handoffHandlers: ConstructorParameters<typeof Handoff>[3] = {
  peer: (p) => {
    peers.set(p.profile, p);
    render();
  },
  // stored first, whatever the page is doing; verified afterwards (verifyReceived), with a retry on the step row
  token: (m) => void (async () => {
    const id = `rx-${hex(sha256(unhex(m.bytes))).slice(0, 12)}`;
    const held = getToken(id);
    if (storeProblem || !tokensOpen()) {
      status.set('arrival', { ok: false, text: `tab ${m.from.toUpperCase()} sent a token, not stored: ${storeProblem ?? 'the wallet is not connected yet: Resend from the other tab'}` });
    } else if (held && held.phase !== 'received') {
      status.set('arrival', { ok: true, text: `tab ${m.from.toUpperCase()} sent a token this wallet already holds (${held.phase})` });
    } else {
      status.delete('receive');
      if (!held) await putToken({ id, amountWei: m.amountWei, phase: 'received', bytes: m.bytes, from: m.from, receivedAt: Date.now() });
      status.set('arrival', { ok: true, text: `stored a token from tab ${m.from.toUpperCase()} (${m.bytes.length / 2} bytes); not verified yet` });
      if (!busy) select(id);
      toVerify.add(id);
    }
    render();
    setTimeout(verifyReceived, 0);
  })(),
};
/** Announced under the profile's key only once the writer lock and the key are settled (start). */
let handoff: Handoff | undefined;
/** true once this page has announced itself: key import is then refused until the page is reloaded */
let handoffEver = false;
/** Opt in: a tab announces its receiving key only when asked (and ready, and for this deployment), so an import can never race a sender that holds an announcement. */
async function enableHandoff(): Promise<string> {
  if (!session || handoff) return 'handoff is on';
  const domain = hex(session.bridge.domain);
  handoff = await announceHandoff(kv, () => new Handoff(PROFILE, domain, me, handoffHandlers));
  handoffEver = true;
  return 'handoff on: this tab now announces its key to tabs of this deployment';
}

/** Verify one received record: the plug-in and the owner check; then it is a held token ('minted'). A failure is kept on the record. */
async function verifyOne(id: string): Promise<string> {
  const t = need(getToken(id), `no token record ${id}`);
  if (t.phase !== 'received') return `already verified (${t.phase})`;
  fact('from', `tab ${t.from?.toUpperCase()}, ${t.bytes!.length / 2} bytes, stored ${t.receivedAt ? new Date(t.receivedAt).toISOString() : '?'}`);
  try {
    const { verified } = await acceptToken(sess().bridge, t.bytes!, me.publicKey);
    const tokenId = hex(verified.tokenId);
    fact('verified', `token ${tokenId}, ${fmtUnits(verified.amount)} UCT, owner = this key, offline`);
    await patchToken(id, { phase: 'minted', tokenId, amountWei: verified.amount.toString(), verifyError: undefined });
    select(id);
    return `received a verified token from tab ${t.from?.toUpperCase()}`;
  } catch (e) {
    await patchToken(id, { verifyError: e instanceof Error ? e.message : String(e) });
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
  let bytes = unhex(t);
  let note = 'the stored token, as held';
  if (kind === 'unknown') {
    bytes = await forgeUnknownKeys(bytes);
    note = 'every seal of the token re-signed by fresh keys under the genuine signer ids';
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
  const enabled = !busy && !!session && (d.phase === undefined || (!!t && d.phase.includes(t.phase) && (d.when?.(t) ?? true)));
  const st = status.get(d.key);
  const done = !!t && !!DONE[d.key]?.(t);
  return h('li', { 'data-step': d.key, class: `step ${busy === d.key ? 'running' : st ? (st.ok ? 'ok' : 'err') : done ? 'ok' : ''}` },
    h('div', { class: 'row' },
      h('span', { class: 'dot' }),
      h('strong', {}, d.title),
      d.input?.() ?? '',
      h('button', { disabled: !enabled, onclick: () => {
        let saveBackup: SaveReturnBackup | undefined;
        const prepare = d.key === 'burn' ? async () => { saveBackup = await chooseReturnBackup(window as Parameters<typeof chooseReturnBackup>[0]); } : undefined;
        void step(d.key, () => d.run(saveBackup), prepare);
      } }, busy === d.key ? 'running…' : 'Run'),
      st ? h('span', { class: st.ok ? 'msg' : 'msg bad' }, st.text) : ''),
    h('p', { class: 'what' }, d.what),
    d.note?.(t) ? h('p', { class: 'warn' }, d.note(t)!) : '',
    drawer(d.key));
}
/** What a finished step left on the token record. */
const DONE: Record<string, (t: TokenRecord) => boolean> = {
  deposit: (t) => !!t.depositTx, mint: (t) => !!t.tokenId && !t.from && !t.parent, split: (t) => t.phase === 'split' || !!t.parent,
  transfer: (t) => t.phase === 'sent' || (!!t.to && !t.pending), receive: (t) => !!t.from && t.phase !== 'received',
  plan: (t) => !!t.returnId, burn: (t) => !!t.eta, redeem: (t) => t.phase === 'redeemed',
};
const drawer = (key: string): HTMLElement => h('details', { class: 'drawer' }, h('summary', {}, 'explain'), explain(traces.get(key)));

function card(title: string, ...body: (Node | string)[]): HTMLElement {
  return h('section', { class: 'card' }, h('h2', {}, title), ...body);
}

function identityCard(): HTMLElement {
  const backup = h('div', { class: 'backup' });
  const showBackup = () => !keyDurable ? undefined : backup.replaceChildren(
    h('p', { class: 'warn' }, 'Burner key. Anyone with these words holds this wallet; test value only.'),
    h('p', {}, h('code', { class: 'words' }, toMnemonic(me.secret))),
    h('p', {}, copyable(`0x${hex(me.secret)}`)),
    h('p', { class: 'warn' }, `Deposit intent high-water mark: ${intentMark ?? '0 (no deposit planned yet)'}. A deposit's secret derives from this key and its intent number, so keep this number with the key: a restored wallet finds its deposits with it, and a lost secret is a lost deposit.`));
  const importBox = h('textarea', { rows: '2', placeholder: '24 words, or 0x + 64 hex digits' });
  const markBox = h('input', { size: '6', inputmode: 'numeric', placeholder: '0', 'aria-label': 'deposit intent mark' });
  return card(`Identity · tab ${PROFILE.toUpperCase()}`,
    h('dl', { class: 'facts' },
      ...(keyDurable ? [
        h('dt', {}, 'EVM address'), h('dd', {}, copyable(me.evmAddress)),
        h('dt', {}, 'Unicity public key'), h('dd', {}, copyable(hex(me.publicKey))),
        h('dt', {}, 'owner predicate'), h('dd', {}, copyable(hex(me.predicate)), h('span', { class: 'muted' }, ` ${me.predicate.length} bytes CBOR`)),
      ] : [h('dt', {}, 'key'), h('dd', { class: 'muted' }, 'no durable key yet: this page is not the profile\'s writer, so no address is shown')]),
      h('dt', {}, 'balance'), h('dd', {}, balance === null ? '—' : `${fmtUnits(balance)} UCT`),
      h('dt', {}, 'deposit intents'), h('dd', {}, intentMark ?? '0', h('span', { class: 'muted' }, ' next to use (backed up before any deposit is sent)')),
    ),
    h('div', { class: 'row' },
      h('button', { class: 'link', onclick: showBackup }, 'export key'),
      legacyKeys.length ? h('button', { onclick: () => void step('reset', async () => {
        const typed = prompt(`This profile holds records from an older build (${legacyKeys.length}). Resetting deletes them and the journals of this profile, and keeps the key (export it first).\n\nType "reset" to continue.`);
        if ((typed ?? '').trim().toLowerCase() !== 'reset') throw new Error('not reset');
        await kv.rewrite(['tok/', 'nb2/', 'fund/', 'recover/', 'backup/'], []); // also the pre-release `fund/pending`
        remove('fund.pending');
        remove('intents.backup');
        location.reload();
        return 'reset';
      }) }, 'reset this profile (older build)') : '',
      h('details', { class: 'inline' }, h('summary', {}, 'import key'), importBox, h('label', {}, 'deposit intent mark ', markBox, h('span', { class: 'muted' }, ' (from the export: finds the deposits of this key)')), h('button', {
        onclick: () => void step('import', async () => {
          // one guarded step, like every other: the writer lock and the busy flag are held while the pending work and the balance are read and the key is replaced
          const secret = parseBackup(importBox.value);
          const mark = markBox.value.trim();
          if (mark && !/^\d{1,9}$/.test(mark)) throw new Error('the intent mark is the number shown next to the exported key');
          // Import only into an EMPTY profile that has announced nothing: nothing of value can be stranded, and no sender can hold an announcement of the key being retired.
          // Otherwise open a new profile (?w=...).
          const block = importBlock(await kv.list(''), legacyKeys.length > 0, !!handoff || handoffEver);
          if (block) {
            showBackup();
            throw new Error(block);
          }
          let held: bigint | null = null;
          try {
            held = session ? await nb2.balanceOf(session, me.evmAddress) : null;
          } catch {
            held = null;
          }
          const atRisk = valueAtRisk({ address: me.evmAddress, balance: held, tokens: [] });
          if (atRisk.length) {
            showBackup();
            const typed = prompt(`The current key still has:\n\n- ${atRisk.join('\n- ')}\n\nReplacing it deletes the only stored copy of its secret. `
              + `Save the current key and the intent mark first (shown on the page under Identity).\n\nType "${CONFIRM_WORD}" to replace it anyway.`);
            if (!confirmed(typed)) throw new Error('not replaced: the current key is kept');
          }
          // the key and its recovery request (bound to this deployment) are one transaction; value moves stay off until the reload has recovered and reconciled
          me = await replaceKeyDurable(kv, secret, mark ? { next: mark, domain: hex(sess().bridge.domain) } : undefined);
          remove('intents.backup');
          location.reload();
          return 'key replaced';
        }),
      }, 'replace this tab\'s key')),
      h('button', { class: 'link', disabled: !session || !!busy, onclick: () => void step('balance', async () => { await refreshBalances(); return 'refreshed'; }) }, 'refresh balance'),
      fundPeer(),
      ...['fund', 'fund-discard', 'balance', 'import', 'reset'].map((k) => status.get(k)).map((st) => (st ? h('span', { class: st.ok ? 'msg' : 'msg bad' }, st.text) : ''))),
    traces.has('fund') ? drawer('fund') : '',
    backup);
}

/**
 * A plain value transfer, so the other tab can pay gas for its own redeem. The sent tx is stored until its receipt is read: while
 * it is, the button polls that transaction instead of sending another.
 */
function fundPeer(): HTMLElement | string {
  const p = [...peers.values()][0];
  const pending = fundPending;
  if ((!p && !pending) || !session) return '';
  return h('span', {}, h('button', {
    class: 'link', disabled: !!busy, onclick: () => void step('fund', async () => {
      const s = sess();
      let rec = fundPending;
      let to = rec?.to ?? p!.profile;
      if (rec) {
        fact('resuming', `the gas transfer ${rec.hash} to tab ${to.toUpperCase()}: not sending another`);
      } else {
        const evm = s.bridge.evm;
        const fees = await evm.fees();
        const signed = await signTx(s.signer, {
          chainId: s.bridge.cfg.chainId, nonce: await evm.nonce(s.signer.address, 'pending'), maxPriorityFeePerGas: fees.priority,
          maxFeePerGas: fees.baseFee * 2n + fees.priority, gas: 21_000n, to: unhex(p!.evmAddress), value: 10n ** 15n, data: new Uint8Array(),
        });
        rec = { hash: `0x${hex(signed.hash)}`, raw: hex(signed.raw), to: (to = p!.profile) };
        // the exact signed transaction is committed to the durable store before it is broadcast: a reload then finds it and never signs a second one
        await kv.put(fundKey, JSON.stringify(rec));
        fundPending = rec;
        fact('tx', rec.hash);
      }
      // the stored transaction is kept through any error or ambiguous outcome; it is cleared only when its receipt is found
      const rc = await nb2.driveFunding(s.bridge.evm, rec, async () => {
        await kv.delete(fundKey);
        fundPending = null;
      }, (m) => fact('broadcast', m));
      await refreshBalances();
      return `${rc.status === '0x1' ? 'sent' : 'reverted:'} 0.001 UCT to tab ${to.toUpperCase()}`;
    }),
  }, pending ? `pending gas transfer to tab ${pending.to.toUpperCase()}: retry` : `send 0.001 UCT gas to tab ${p!.profile.toUpperCase()}`),
  pending ? h('button', { class: 'link', disabled: !!busy, onclick: () => void step('fund-discard', async () => {
    if (!confirm('Discard the stored gas transfer? If it was sent and is still in flight or was mined, sending a new one pays tab B TWICE. Discard only when you are sure the transaction is gone (not in the chain, nonce reused).')) throw new Error('not discarded');
    await kv.delete(fundKey);
    fundPending = null;
    return 'discarded the stored gas transfer';
  }) }, 'discard') : '');
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
      h('button', { disabled: !!busy || !keyDurable, onclick: () => void step('faucet-load', loadCaptcha) }, captcha ? 'reload captcha' : 'show captcha'),
      h('button', { disabled: !!busy || !captcha || !keyDurable, onclick: () => void step('faucet', claimFaucet) }, 'Claim UCT'),
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
    const s = session;
    const rc = await waitFor(`the receipt of ${r.txHash}`, 180_000, async () => (await s.bridge.evm.receipt(unhex(r.txHash))) ?? undefined, 1500);
    fact('receipt', `block ${BigInt(rc.blockNumber)}, status ${rc.status}`);
    await refreshBalances();
  }
  return `funded: ${r.txHash.slice(0, 12)}…`;
}

function flowCard(): HTMLElement {
  const t = current();
  const toks = listTokens();
  const picker = toks.length
    ? h('select', { disabled: !!busy, onchange: (e: Event) => { select((e.target as HTMLSelectElement).value); render(); } },
      ...toks.map((x) => h('option', { value: x.id, selected: x.id === currentId }, `${x.id.startsWith('rx-') ? 'received' : x.parent ? `part ${x.id.endsWith('.back') ? 'back' : 'keep'} of ${x.parent}` : `deposit ${x.id.slice(1)}`} · ${fmtUnits(BigInt(x.amountWei))} UCT · ${x.phase === 'received' ? 'received, not verified' : x.phase}${x.pending ? ' · transfer pending' : ''}${x.burning ? ' · burn in progress' : ''}`)))
    : h('span', { class: 'muted' }, 'none yet: deposit some UCT');
  peerSelect.replaceChildren(...[...peers.values()].map((p) => h('option', { value: p.profile }, `tab ${p.profile.toUpperCase()}`)));
  if (!peers.size) peerSelect.append(h('option', { value: '' }, 'no other tab'));
  return card('Asset flow',
    h('div', { class: 'row' }, h('span', {}, 'token: '), picker, t?.tokenId ? mono(t.tokenId) : ''),
    h('details', {}, h('summary', {}, 'Return payer policy'), h('p', { class: 'what' }, 'Set explicit gas, byte, nonce and fee ceilings, plus optional public archive origins or /archive-rpc. The policy stays in this tab until reload. Use one payer for the full return.'), policyInput),
    t?.returnId && (t.eta || t.burning) ? h('button', { disabled: !!busy || !ready, onclick: () => void step('return-backup', async () => {
      const s = sess();
      const rec = need(await nb2.returnRecord(s, t.returnId!), 'No signed return to back up');
      const content = await encodeReturnBackup(nb2.recoveryWallet(s, kv), rec);
      const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
      h('a', { href: url, download: `nb2-return-${rec.returnId.slice(2, 14)}.private.json` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return 'Private return backup download started. Share it only with the chosen payer.';
    }) }, 'Download private return backup') : '',
    status.get('return-backup')?.text ?? '',
    h('ol', { class: 'timeline' }, ...STEPS.map((d) => stepRow(d, t))),
    status.has('arrival') || status.has('receive') ? h('div', { class: 'row' }, h('strong', {}, 'Received'),
      ...(['arrival', 'receive'] as const).map((k) => status.get(k)).map((st) => (st ? h('span', { class: st.ok ? 'msg' : 'msg bad' }, st.text) : '')), drawer('receive')) : '');
}

let trustView: HTMLElement = h('p', { class: 'muted' }, 'Not loaded.');
async function refreshWalletTrust(agg: AggregatorClient): Promise<number> {
  return refreshTrust(need(trust, 'connect first'), agg);
}

async function showTrust(fetchNew: boolean): Promise<string> {
  const tr = need(trust, 'connect first');
  const refreshed = fetchNew ? await refreshWalletTrust(new AggregatorClient(abs(settings.aggregator))) : null;
  const list = await entries(trust ?? tr);
  trustView = h('table', { class: 'calls' },
    h('thead', {}, h('tr', {}, ...['epoch', 'entry id', 'start round', 'end', 'members', 'quorum / total weight'].map((x) => h('th', {}, x)))),
    h('tbody', {}, ...list.map((e) => h('tr', {},
      h('td', { class: 'num' }, String(e.epoch)), h('td', {}, mono(e.entryId)), h('td', { class: 'num' }, String(e.startRound)),
      h('td', { class: 'num' }, e.endRound === null ? 'open' : String(e.endRound)),
      h('td', {}, h('details', {}, h('summary', {}, `${e.members.length}`), h('ul', {}, ...e.members.map((m) => h('li', {}, `${m.nodeId} · weight ${m.weight} · `, mono(m.key)))))),
      h('td', { class: 'num' }, `${e.quorum} / ${e.totalWeight}`)))));
  const held = trust ?? tr;
  if (refreshed === null) return `tip epoch ${held.history.tip?.epoch}`;
  return `${refreshed} new entr${refreshed === 1 ? 'y' : 'ies'} · tip epoch ${held.history.tip?.epoch}`;
}

function trustCard(): HTMLElement {
  return card('Trust base history',
    h('p', { class: 'what' }, 'GET /api/v1/trustbases: each entry is a committee (members, weights, quorum) signed by the previous one; the genesis entry is pinned by its EntryID.'),
    h('div', { class: 'row' },
      h('button', { disabled: !trust || !!busy, onclick: () => void step('trust', () => showTrust(true)) }, 'refresh trust'),
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

function deploymentCard(): HTMLElement {
  const r = published?.release;
  const p = published?.pins;
  const build = BUILD_NBP;
  return card('Bridge deployment (NB2 v1.1)',
    h('p', { class: 'what' }, 'The deployment\'s own nb2-release.json: the pins the plug-in checks the vault against (the installation check at connect), the limits the preflight plans against, and the plug-in commit it was released with.'),
    !published || !session ? h('p', { class: 'muted' }, 'Not loaded.') : h('dl', { class: 'facts' },
      h('dt', {}, 'chain'), h('dd', {}, `${session.bridge.cfg.chainId} (block zero ${r?.package?.genesisHash ? String(r.package.genesisHash).slice(0, 14) + '…' : '?'})`),
      h('dt', {}, 'vault'), h('dd', {}, copyable(`0x${hex(session.bridge.cfg.vault)}`), h('span', { class: 'muted' }, ` ${p!.build} build, K = ${session.bridge.cfg.K}, B = ${session.bridge.cfg.B}`)),
      h('dt', {}, 'Γ, domain D'), h('dd', {}, mono(hex(p!.gamma)), ' · ', mono(hex(session.bridge.domain))),
      h('dt', {}, 'deployment block'), h('dd', {}, p!.deploymentBlock.toString()),
      h('dt', {}, 'limits'), h('dd', {}, `tx ≤ ${p!.maxEncodedTxBytes} bytes · userGasLimit ${p!.userGasLimit} · gasReserve ${p!.gasReserve} · reserve ${p!.returnReserveSegments} segments`),
      h('dt', {}, 'plug-in commit'), h('dd', {}, published.pluginCommit ? mono(published.pluginCommit) : '—',
        published.pluginCommit && build ? h('span', { class: published.pluginCommit === build || published.pluginCommit === COMPATIBLE_RELEASE_PLUGIN ? 'good' : 'bad' }, published.pluginCommit === build ? ' = this build' : ` · bundled build ${build.slice(0, 12)}`) : ''),
      h('dt', {}, 'files'), h('dd', {}, mono(published.url, true))),
    drawer('connect'));
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
    h('span', { class: 'muted' }, session ? `chain ${session.bridge.cfg.chainId} · trust epoch ${trust?.history.tip?.epoch}` : trust ? `trust epoch ${trust.history.tip?.epoch} · no bridge` : 'not connected'),
    h('button', { class: 'link', disabled: !!busy, onclick: () => location.reload() }, 'reconnect (reloads the page)'),
    st && !st.ok ? h('span', { class: 'msg bad' }, st.text) : '',
    h('details', { class: 'inline' }, h('summary', {}, 'explain'), explain(traces.get('connect'))),
    h('a', { href: './pos.html' }, 'PoS visualizer'),
    !settings.trustPin.trim() ? h('p', { class: 'banner bad' }, NO_PIN) : '',
    storeProblem ? h('p', { class: 'banner bad' }, storeProblem) : '',
    settings.trustPin.trim() && pinOverridden(settings)
      ? h('p', { class: 'banner warn' }, 'Developer override: the trust pin comes from Network settings, not from this build: ', mono(settings.trustPin)) : '');
}

const slots = { header: h('div'), identity: h('div'), trust: h('div'), flow: h('div'), check: h('div', { id: 'check' }), deploy: h('div') };
root.replaceChildren(slots.header, h('main', {},
  h('div', { class: 'col' }, slots.identity, faucetCard, slots.deploy, slots.trust),
  h('div', { class: 'col wide' }, slots.flow, slots.check, settingsCard())));

function render(): void {
  document.body.dataset.busy = busy ?? '';
  slots.header.replaceChildren(header());
  slots.identity.replaceChildren(identityCard());
  renderFaucet();
  slots.deploy.replaceChildren(deploymentCard());
  slots.trust.replaceChildren(trustCard());
  slots.flow.replaceChildren(flowCard());
  slots.check.replaceChildren(checkCard());
}

/**
 * The profile's one-writer lock comes first, then the key (created and committed durably only by the writer), then the durable records: the
 * wallet moves no value without them, and a page that is not the writer or has no Web Locks fails closed.
 */
async function start(): Promise<void> {
  try {
    const w = await acquireWriter(PROFILE);
    if (!w.ok) storeProblem = w.problem;
    else {
      me = (await loadOrCreateDurable(kv)).burner;
      keyDurable = true;
      legacyKeys = [...(await legacyKeysOf(kv)), ...(load('fund.pending') ? ['localStorage fund.pending'] : [])];
      // the wallet is read-only until connect has also opened the deployment's records and finished any recovery
      storeProblem = legacyKeys.length ? 'This profile was written by an older build of the wallet (its records have no deployment scope, which this build needs). It is not read. Export your key, then reset the profile below to continue.' : null;
    }
    intentMark = load('intents.backup');
  } catch (e) {
    storeProblem = String(e instanceof Error ? e.message : e);
  }
  render();
  await step('connect', async () => {
    const msg = await connect();
    if (trust) await showTrust(false);
    return msg;
  });
}
render();
void start();
