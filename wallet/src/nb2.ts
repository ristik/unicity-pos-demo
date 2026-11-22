/**
 * The asset flow on native bridge v2.1 (NB2 v1.1), step by step, ported from native-bridge-plugins `wallet/core.ts` (the reference wallet):
 *
 *   deposit (EVM) → mint (aggregator) → split → transfer to tab B → plan return (preflight) → burn → redeem (EVM)
 *
 * There is no lock proof endpoint and no claim: the vault pays the redeem's recipient directly. Every step is a plain function of the session,
 * so each can be shown (and re-run) on its own. The plug-in journals its own steps (deposit, split, return) through the journal store the
 * session was opened with; the one step it does not journal, a transfer, is split here into `prepareTransfer` (build the exact request) and
 * `finishTransfer` (certify it), so the caller can persist the request in between.
 *
 * Rules the guide asks of a wallet (docs/nb2-wallet-guide.md): the installation check at `open`; a journal whose `putIf` is atomic and durable
 * (idb.ts); the intent high-water mark backed up before any deposit is sent (`backup`); the preflight before every burn (`planReturn`, and
 * `burn` runs it again); a transfer's request persisted before it is certified.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  AmbiguousBroadcast, HttpJsonRpc, LocalKeySigner, NativeBridgeV2, Nb2Error, WalletError, appendTransfer, certifyChecked, deriveBridgeKey, evidenceOf,
  freshMask, localOwner, transferRequest,
  type Aggregator, type DepositPlan, type DeploymentPins, type GasModel, type IntentsRecord, type JournalStore, type JsonRpc, type OwnerSigner, type ReconcileResult,
  type ReturnPlan, type ReturnRecord,
} from '@unicitylabs/native-bridge-plugin/nb2';
import type { TrustInput } from '@unicitylabs/native-bridge-plugin';
import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import { CertificationData } from '@unicitylabs/state-transition-sdk/lib/api/CertificationData.js';
import { StateId } from '@unicitylabs/state-transition-sdk/lib/api/StateId.js';

import { abs, type Settings } from './config.js';
import { eqBytes, hex, sleep, unhex } from './hex.js';
import type { Burner } from './keys.js';
import type { Published } from './release.js';
import { type PayerPolicy, type RecoveryResult, pollOrdinaryPayout, redeemOrdinary, recoverStep, retainTerminal, walletAdmission } from './recovery.js';
import type { IdbKv } from './idb.js';
import { fact } from './trace.js';

// ---- the aggregator ------------------------------------------------------------------------------------------------------------------------

/** The SDK aggregator client through the gateway's /aggregator route: submit, then poll for the proof of exactly this request; a busy route is retried. */
export class GatewayAggregator implements Aggregator {
  readonly client: AggregatorClient;
  constructor(url: string) {
    this.client = new AggregatorClient(url);
  }
  async submit(request: Uint8Array): Promise<void> {
    const cd = CertificationData.fromCBOR(request);
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.client.submitCertificationRequest(cd);
        if (!r.isAccepted && !r.isAlreadySubmitted && !r.isStateIdQueued) throw new WalletError('Reverted', `aggregator: ${r.status}`);
        return;
      } catch (e) {
        if (e instanceof WalletError || attempt >= 20) throw e;
        await sleep(1000 * (attempt + 1));
      }
    }
  }
  async proof(request: Uint8Array, timeoutMs = 300_000): Promise<Uint8Array> {
    const cd = CertificationData.fromCBOR(request);
    const sid = await StateId.fromCertificationData(cd);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const p = (await this.client.getInclusionProof(sid, { waitMs: 2_000 })).inclusionProof;
        if (p !== null) {
          if (!eqBytes(p.certificationData.toCBOR(), request)) throw new WalletError('ProviderFault', 'the aggregator certified another request for this state');
          return p.toCBOR();
        }
      } catch (e) {
        if (e instanceof WalletError) throw e;
      }
      if (Date.now() > deadline) throw new WalletError('Unconfirmed', 'no inclusion proof in time');
      await sleep(1_000);
    }
  }
  async certify(request: Uint8Array): Promise<Uint8Array> {
    await this.submit(request);
    return this.proof(request);
  }
}

// ---- the session ---------------------------------------------------------------------------------------------------------------------------

export interface Session {
  bridge: NativeBridgeV2;
  trust: TrustInput;
  published: Published;
  pins: DeploymentPins;
  /** the burner's EVM account and Unicity owner key (one key, as before) */
  signer: LocalKeySigner;
  owner: OwnerSigner;
  pub: Uint8Array;
  aggregator: Aggregator;
  /** the backup callback the session was opened with (a recovered, unbacked-up intent finishes it) */
  backup: (intents: IntentsRecord) => Promise<void>;
  refreshTrust: OpenArgs['refreshTrust'];
}

export interface OpenArgs {
  settings: Settings;
  me: Burner;
  trust: TrustInput;
  published: Published;
  journal: JournalStore;
  /** store the intent high-water mark with the key backup (the page shows it next to the exported key) */
  backup: (intents: IntentsRecord) => Promise<void>;
  /** append newer trust-base entries to the held history */
  refreshTrust: () => Promise<TrustInput | void>;
  /** test seams: another transport, aggregator and gas model than the gateway's, the aggregator's and the plug-in's default */
  rpc?: JsonRpc;
  aggregator?: Aggregator;
  gas?: GasModel;
}

const tagged = (s: string, secret: Uint8Array): Uint8Array => sha256(new Uint8Array([...new TextEncoder().encode(s), ...secret]));

/**
 * Open the plug-in. `NativeBridgeV2.open` runs the installation check (the chain ID, `config()` = the pinned Γ, the vault's runtime code hash): a
 * refusal (`BadDeployment`) means the manifest and the node are not the same deployment, and nothing is sent.
 */
export async function openSession(a: OpenArgs): Promise<Session> {
  const http = a.rpc ?? new HttpJsonRpc(abs(a.settings.rpc), { retries: 20, timeoutMs: 120_000, fetch: (i, init) => globalThis.fetch(i, init) });
  const aggregator = a.aggregator ?? new GatewayAggregator(abs(a.settings.aggregator));
  const bridge = await NativeBridgeV2.open({
    pins: a.published.pins, trust: a.trust, rpc: http, aggregator, journal: a.journal,
    bridgeKey: deriveBridgeKey(tagged('unicity-demo/nb2/seed/', a.me.secret)),
    backup: a.backup, refreshTrust: a.refreshTrust, receiptTimeoutMs: a.rpc ? 0 : 180_000, pollMs: a.rpc ? 0 : 1_000, ...(a.gas ? { gas: a.gas } : {}),
  });
  return { bridge, trust: a.trust, published: a.published, pins: a.published.pins, signer: new LocalKeySigner(a.me.secret), owner: localOwner(a.me.secret), pub: a.me.publicKey, aggregator, backup: a.backup, refreshTrust: a.refreshTrust };
}

/**
 * The installation check again, against the session's pinned deployment: the RPC's chain ID, the vault's `config()` equal to the pinned Γ, and
 * its runtime code hash. The reference wallet runs it before every value-moving command; a network that was reset behind an open page (same
 * chain ID and vault address, another vault) must not receive a deposit made under the old domain. Throws `BadDeployment`; nothing is sent.
 */
export async function checkInstallation(s: Session): Promise<void> {
  const evm = s.bridge.evm;
  const bad = (what: string): never => { throw new WalletError('BadDeployment', `${what}: the manifest and the node are not the same deployment (reload the page after a reset)`); };
  if ((await evm.chainId()) !== s.bridge.cfg.chainId) bad('the RPC serves another chain');
  if (!eqBytes(await evm.vaultConfig(s.bridge.cfg.vault), s.pins.gamma)) bad('the vault\'s config() is not the pinned Γ');
  if (!eqBytes(keccak_256(await evm.code(s.bridge.cfg.vault)), s.pins.vaultRuntimeCodeHash)) bad('the vault\'s runtime code is not the pinned one');
}

/**
 * A planned deposit whose backup was interrupted (the plug-in writes the plan, calls the backup, then commits `backedUp`): finish it before
 * the send, which refuses an unbacked-up intent.
 */
export async function finishBackup(s: Session, intent: bigint): Promise<boolean> {
  const rec = await s.bridge.journal.deposit(intent);
  if (!rec || rec.backedUp) return false;
  const intents = await s.bridge.journal.intents();
  if (!intents) throw new WalletError('JournalNotPersisted', 'no intent counter in the journal');
  await s.backup(intents);
  await s.bridge.markBackedUp(intent);
  fact('backup', `finished the interrupted backup of intent ${intent} (high-water mark ${intents.next})`);
  return true;
}

// ---- refusals and retries -----------------------------------------------------------------------------------------------------------------

/** The rule or reason of a plug-in refusal ('' for anything else). */
export const reasonOf = (e: unknown): string => (e instanceof WalletError ? e.reason : e instanceof Nb2Error ? e.rule : '');

/** Refusals that mean "not yet": call again after a block or a moment. */
export const RETRYABLE = ['CompanionUnknown', 'Unconfirmed', 'NotPending', 'NoEntryForEpoch'];
/** The ones a step that reads chain evidence waits out (a certificate not served yet, a trust history to extend). */
export const NOT_YET = ['CompanionUnknown', 'Unconfirmed', 'NoEntryForEpoch'];

/** F again while it refuses with a reason in WHICH, up to TRIES times; NOTE is told the first time and every tenth. */
export async function retry<T>(f: () => Promise<T>, note: (reason: string) => void = () => undefined, tries = 120, ms = 2_000, which = RETRYABLE): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      const reason = reasonOf(e);
      if (i >= tries || !which.includes(reason)) throw e;
      if (i % 10 === 0) note(reason);
      await sleep(ms);
    }
  }
}

/**
 * The deployed verifier's QuorumNotMet inside VerifierRefused, as the plug-in reports it: right after a burn's certification the EVM chain's seal
 * registry may not have imported the root round the burn names yet, and on chain that reads as a bad quorum (bft-core#1125). Nothing was signed
 * or sent: the burn is intact, and the redeem is built again a moment later.
 */
export function isRegistryLag(e: unknown): boolean {
  return e instanceof Nb2Error && e.rule === 'VerifierRefused' && e.inner?.rule === 'QuorumNotMet';
}
export const REGISTRY_LAG_MS = 120_000;

// ---- the steps -----------------------------------------------------------------------------------------------------------------------------

/** Deposit, step 1: plan an intent (the secret is derived, the high-water mark backed up) and journal it. Nothing is sent. */
export async function planDeposit(s: Session, amount: bigint): Promise<DepositPlan> {
  const plan = await s.bridge.planDeposit(amount, s.pub);
  fact('intent', plan.intent.toString());
  fact('rho', `0x${hex(plan.rho)}`);
  fact('first owner', `0x${hex(plan.firstOwner)}`);
  return plan;
}

/** Deposit, step 2: send the planned deposit, or reconcile an earlier send (a retry never deposits twice). */
export async function sendDeposit(s: Session, intent: bigint): Promise<{ txHash: Uint8Array; depositNumber: bigint; blockNumber: bigint }> {
  const r = await s.bridge.submitDeposit(intent, s.signer);
  fact('tx', `0x${hex(r.txHash)}`);
  fact('deposit number', r.depositNumber.toString());
  fact('block', r.blockNumber.toString());
  return r;
}

/**
 * Mint: the deposit's receipt proof J once its block is certified (waited out while the certificate is not served yet), then the ordinary mint
 * with J as its reason, verified offline.
 */
export async function mint(s: Session, intent: bigint, note?: (reason: string) => void): Promise<{ token: Uint8Array; tokenId: Uint8Array; amount: bigint; depositNumber: bigint; jBytes: number }> {
  const p = await retry(() => s.bridge.collectDepositProof(intent), note, 120, 2_000, NOT_YET);
  fact('deposit number', p.depositNumber.toString());
  fact('receipt proof J', `${p.reason.length} bytes`);
  const token = await s.bridge.mint(intent);
  const v = await s.bridge.verifyToken(token);
  fact('token id', `0x${hex(v.tokenId)}`);
  fact('token file', `${token.length} bytes`);
  return { token, tokenId: v.tokenId, amount: v.amount, depositNumber: p.depositNumber, jBytes: p.reason.length };
}

/** The two whole parts of a split that returns BACK of a token of TOTAL: [the rest, the part to return]. Zero and the whole token are refused before anything is persisted. */
export function splitAmounts(total: bigint, back: bigint): bigint[] {
  if (back <= 0n) throw new Error('the part to return must be more than zero');
  if (back >= total) throw new Error(`the part to return (${back}) must be smaller than the token (${total})`);
  return [total - back, back];
}

/** Split a held token into whole parts, all to this wallet's key (the plug-in journals the split: a rerun with the same parts resumes). */
export async function split(s: Session, token: Uint8Array, amounts: bigint[]): Promise<Uint8Array[]> {
  const parts = await s.bridge.split(token, s.owner, amounts.map((amount) => ({ ownerKey: s.pub, amount })));
  parts.forEach((t, i) => fact(`part ${i + 1}`, `${amounts[i]} wei, ${t.length} bytes`));
  return parts;
}

export interface PreparedTransfer { tx: string; cd: string }

/** Transfer, step 1: the transaction (with its random state mask) and its signed certification request. Nothing is submitted: persist this first. */
export async function prepareTransfer(s: Session, token: Uint8Array, toKey: Uint8Array): Promise<PreparedTransfer> {
  await s.bridge.verifyToken(token);
  const req = await transferRequest(token, s.owner, { recipient: { type: 1n, params: toKey }, mask: freshMask(), data: null, deadline: null });
  return { tx: hex(req.tx), cd: hex(req.cd) };
}

/** Transfer, step 2: certify exactly that request (the aggregator answers a resubmission with the same proof), append it and verify the result. */
export async function finishTransfer(s: Session, token: Uint8Array, p: PreparedTransfer): Promise<Uint8Array> {
  const proof = await certifyChecked(s.aggregator, unhex(p.cd));
  const out = appendTransfer(token, unhex(p.tx), proof);
  await s.bridge.verifyToken(out);
  fact('transfer', `certified; token file ${out.length} bytes`);
  return out;
}

/** The facts of a return plan, as the preflight judged it. */
export function describePlan(s: Session, plan: ReturnPlan): void {
  fact('burn index a', plan.a.toString());
  fact('vault segment (observed)', plan.cObs.toString());
  fact('gap proofs already owed', plan.pNow.toString());
  fact('proofs that fit', plan.pMax.toString());
  fact('margin beyond the reserve', `${plan.marginSegments} segments (reserve ${s.pins.returnReserveSegments})`);
  fact('preflight gas limit', `${plan.gasLimit} of userGasLimit ${s.pins.userGasLimit}`);
  for (const w of plan.warnings) fact('warning', w);
}

/**
 * Return, step 1: plan the part's return to RECIPIENT and run the capacity preflight. Nothing is burned; a refusal (CapacityPreflight,
 * InsufficientFunds, RecipientRefused) leaves the token as it was.
 */
export function recoveryWallet(s: Session, store: IdbKv) {
  return {
    bridge: s.bridge, pins: s.pins, signer: s.signer, release: s.published.release, store,
    get trust() { return s.trust; },
    async persistAuthority(next: TrustInput) {
      await store.put(`return/authority/${hex(next.id)}`, hex(await next.history.toBundle()));
    },
    async refreshAuthority() { return await s.refreshTrust() ?? s.trust; },
  };
}

export async function planReturn(s: Session, token: Uint8Array, recipient: Uint8Array, note?: (reason: string) => void, store?: IdbKv, policy?: PayerPolicy): Promise<ReturnPlan> {
  const admission = store && walletAdmission(recoveryWallet(s, store), policy);
  const plan = await retry(() => s.bridge.planReturn(token, recipient, s.signer.address, { admission }), note, 30, 2_000, NOT_YET);
  describePlan(s, plan);
  fact('return id', `0x${hex(plan.returnId)}`);
  return plan;
}

/** Repeat admission, and store the private signed request before certification. */
export async function burn(s: Session, returnId: Uint8Array, note?: (reason: string) => void, store?: IdbKv, policy?: PayerPolicy): Promise<{ burned: Uint8Array; eta: Uint8Array; evidenceBytes: number }> {
  const recovery = store && recoveryWallet(s, store);
  const rec = await returnRecord(s, `0x${hex(returnId)}`);
  const b = await retry(() => s.bridge.burn(returnId, s.owner, recovery && walletAdmission(recovery, policy, true), rec ? unhex(rec.recipient) : undefined), note);
  if (recovery) {
    const committed = await returnRecord(s, `0x${hex(returnId)}`);
    if (committed) await retainTerminal(recovery, committed);
  }
  const evidenceBytes = evidenceOf(b.burned).length;
  fact('redemption ID eta', `0x${hex(b.eta)}`);
  fact('lineage evidence', `${evidenceBytes} bytes`);
  return { burned: b.burned, eta: b.eta, evidenceBytes };
}

/** Ordinary payment retries registry lag within the deadline. Cold recovery advances one certified packet at a time. */
export async function redeem(s: Session, returnId: Uint8Array, note: (m: string) => void = () => undefined, polls = 60, pollMs = 3_000, store?: IdbKv, policy?: PayerPolicy, cold = false): Promise<RecoveryResult | ReconcileResult> {
  const rec = await returnRecord(s, `0x${hex(returnId)}`);
  const wallet = store && recoveryWallet(s, store);
  if (rec) {
    const { segment } = await s.bridge.evm.vaultState(s.bridge.cfg.vault);
    const owed = segment - BigInt(rec.a);
    fact('gap proofs in the witness', String(owed > 0n ? owed : 0n));
  }
  if (rec && wallet && (rec.recovery || cold)) {
    if (!policy) throw new Error('Enter the return payer policy before continuing');
    return recoverStep(wallet, rec, policy);
  }
  const deadline = performance.now() + REGISTRY_LAG_MS;
  let r: ReconcileResult;
  let refusal: unknown;
  for (;;) {
    if (refusal) {
      const left = deadline - performance.now();
      if (left > 0) await sleep(Math.min(left, pollMs));
      if (performance.now() >= deadline) throw refusal;
    }
    try {
      r = rec && wallet ? await redeemOrdinary(wallet, rec, policy) : await s.bridge.submitRedeem(returnId, s.signer);
      break;
    } catch (e) {
      if (!isRegistryLag(e)) throw e;
      if (!refusal) note('QuorumNotMet: waiting for possible seal registry lag');
      refusal = e;
    }
  }
  for (let i = 0; r.state === 'pending' && i < polls; i++) {
    await sleep(pollMs);
    r = rec && wallet ? await pollOrdinaryPayout(wallet, rec, r.txHash, policy) : await s.bridge.reconcile(returnId);
  }
  if (r.state === 'paid') {
    fact('paid in block', r.blockNumber.toString());
    fact('redeem tx', `0x${hex(r.txHash)}`);
  }
  return r;
}

/** The journal record of a return, or null. */
export const returnRecord = (s: Session, returnId: string): Promise<ReturnRecord | null> => s.bridge.journal.ret(returnId);

/**
 * Broadcast the stored, exact funding transaction, once: a mined one (its receipt is present) is never rebroadcast, "nonce too low" with its
 * receipt present is the same thing, an ambiguous 503 or an "already known" leaves the receipt to decide.
 */
export async function sendFunding(evm: { receipt(h: Uint8Array): Promise<unknown | null>; sendRaw(raw: Uint8Array): Promise<unknown> }, rec: { hash: string; raw: string }): Promise<'already mined' | 'sent' | 'pending: the receipt decides'> {
  const hash = unhex(rec.hash);
  if ((await evm.receipt(hash)) !== null) return 'already mined';
  try {
    await evm.sendRaw(unhex(rec.raw));
    return 'sent';
  } catch (e) {
    if (/nonce too low/i.test(String(e)) && (await evm.receipt(hash)) !== null) return 'already mined';
    if (e instanceof AmbiguousBroadcast || /already known|known transaction|already imported|already exists/i.test(String(e))) return 'pending: the receipt decides';
    throw e;
  }
}

/**
 * Send the stored funding transaction and wait for its receipt. The stored record is cleared (CLEAR) only once the receipt is found; any error,
 * ambiguous send or timeout leaves it, for a retry or an explicit discard.
 */
export async function driveFunding(
  evm: { receipt(h: Uint8Array): Promise<{ status?: string } | null>; sendRaw(raw: Uint8Array): Promise<unknown> }, rec: { hash: string; raw: string },
  clear: () => Promise<void>, note: (m: string) => void = () => undefined, timeoutMs = 180_000,
): Promise<{ status?: string }> {
  note(await sendFunding(evm, rec));
  const hash = unhex(rec.hash);
  const end = Date.now() + timeoutMs;
  for (;;) {
    const rc = await evm.receipt(hash);
    if (rc !== null) {
      await clear();
      return rc;
    }
    if (Date.now() > end) throw new Error('no receipt yet: the stored transaction is kept (pending; retry or discard)');
    await sleep(Math.min(1500, timeoutMs));
  }
}

// ---- the wallet's EVM account --------------------------------------------------------------------------------------------------------------

export const balanceOf = (s: Session, address: string): Promise<bigint> => s.bridge.evm.balance(unhex(address));
