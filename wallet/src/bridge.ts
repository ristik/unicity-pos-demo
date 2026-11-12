/**
 * The asset flow through the native bridge, step by step, as nbp tester/bridge-tester.ts does it, with only public endpoints:
 *   lock (EVM) → lock proof (lockproof endpoint) → mint (aggregator) → transfer → burn → return proof → redeem (EVM) → claim (EVM).
 * Every step is a plain function of the session and the burner key, so each can be shown (and re-run) on its own.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import {
  arr, buildReturnProof, configHashOfPdr, consolidatedProofs, decodeCfg, decodePolicy, deriveSalt, deriveTokenId, DeploymentRegistry, encodeJustification,
  keccak256, lockDigest, lockRecord, makeDeployment, NativeBridge, refreshToken, returnReason, TrustInput, u, valueEnvelope,
  type Cfg, type Deployment, type VerifiedToken,
} from '@unicitylabs/native-bridge-plugin';
import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import { CertificationData } from '@unicitylabs/state-transition-sdk/lib/api/CertificationData.js';
import type { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProof.js';
import type { TokenRecord } from './tokens.js';
import { NetworkId } from '@unicitylabs/state-transition-sdk/lib/api/NetworkId.js';
import { StateId } from '@unicitylabs/state-transition-sdk/lib/api/StateId.js';
import { ShardRouting } from '@unicitylabs/state-transition-sdk/lib/consolidation/ShardRouting.js';
import { TokenProofClient } from '@unicitylabs/state-transition-sdk/lib/consolidation/TokenProofClient.js';
import { BurnPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/builtin/BurnPredicate.js';
import { SignaturePredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/builtin/SignaturePredicate.js';
import { SignaturePredicateUnlockScript } from '@unicitylabs/state-transition-sdk/lib/predicate/builtin/SignaturePredicateUnlockScript.js';
import { CborDeserializer as D } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborDeserializer.js';
import { CborSerializer as C } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborSerializer.js';
import { MintTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/MintTransaction.js';
import { StateMask } from '@unicitylabs/state-transition-sdk/lib/transaction/StateMask.js';
import { Token } from '@unicitylabs/state-transition-sdk/lib/transaction/Token.js';
import { TokenSalt } from '@unicitylabs/state-transition-sdk/lib/transaction/TokenSalt.js';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/transaction/TokenType.js';
import { TransferTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction.js';

import { abs, fetchTesterConfig, type Settings, type TesterConfig } from './config.js';
import { alreadyKnown, calldata, decBytes, encAddress, encBytes, encUint, Evm, HttpError, LOCKED_TOPIC, revertName, RpcError, type Receipt } from './evm.js';
import { hex, sleep, unhex, waitFor } from './hex.js';
import type { Burner } from './keys.js';
import { fact } from './trace.js';
import { withTrustRefresh } from './trust.js';

const TOKEN_TAG = 39040n;

/** Everything a step needs: the configured network, checked to be the one tester-config.json names, and the bridge as the plug-in verifies it. */
export interface Session {
  cfg: TesterConfig;
  evm: Evm;
  agg: AggregatorClient;
  vaultCfg: Cfg;
  dep: Deployment;
  bridge: NativeBridge;
  trust: TrustInput;
  lockproofUrl: string;
}

export async function openSession(s: Settings, trust: TrustInput): Promise<Session> {
  const { cfg, fileUrl } = await fetchTesterConfig(s.testerConfig);
  const evm = new Evm(s.rpc, BigInt(cfg.chainId));
  // a reset network keeps its chain id: block 0 tells generations apart, and a vault without code is not this generation's
  const block0 = await evm.rpc<{ hash: string } | null>('eth_getBlockByNumber', ['0x0', false]);
  if (block0?.hash.toLowerCase() !== cfg.genesisHash.toLowerCase()) throw new Error(`the RPC's genesis is ${block0?.hash}; tester-config.json names ${cfg.genesisHash}`);
  const code = await evm.rpc<string>('eth_getCode', [cfg.vault, 'latest']);
  if (code.length <= 2) throw new Error(`no code at the vault ${cfg.vault}`);
  const vaultCfg = decodeCfg(decBytes(await evm.call(cfg.vault, calldata('cfgBytes()'))));
  const pdr = new Uint8Array(await (await fetch(fileUrl('evmPdr'))).arrayBuffer());
  const deployment = (await (await fetch(fileUrl('deployment'))).json()) as { policyBody: string };
  const dep = makeDeployment(vaultCfg, keccak256(unhex(code)), configHashOfPdr(pdr), { fields: 20 }, decodePolicy(unhex(deployment.policyBody)));
  return { cfg, evm, agg: new AggregatorClient(abs(s.aggregator)), vaultCfg, dep, bridge: new NativeBridge(new DeploymentRegistry([dep]), trust), trust, lockproofUrl: s.lockproof };
}

/** Run a verification; when a certificate is of an epoch newer than the held history, fetch the missing entries, persist, and run it again. */
export const withTrust = <T>(s: Session, verify: () => Promise<T>): Promise<T> =>
  withTrustRefresh(s.trust, s.agg, verify, (n, tip) => fact('trust refresh', `${n} entries appended, tip epoch ${tip}`));

/** The token's amount bytes: minimal big-endian (interop.md "Canonical primitives"). */
export const amountBytes = (wei: bigint): Uint8Array => {
  const h = wei.toString(16);
  return unhex(h.length % 2 ? `0${h}` : h);
};

/** The aggregator calls certify uses (a fake in the tests). */
export type Certifier = Pick<AggregatorClient, 'submitCertificationRequest' | 'getInclusionProof'>;

/** The state is certified, but for another transaction: this one can never be certified. Not retryable. */
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** True when the proof certifies exactly this request (same source state, same transaction hash). */
export const proofIsFor = (proof: InclusionProof, cd: CertificationData): boolean =>
  proof.certificationData.sourceStateHash.equals(cd.sourceStateHash) && proof.certificationData.transactionHash.equals(cd.transactionHash);

/**
 * Certify one request and return its inclusion proof. Safe to call again with the same request: a proof already present is taken
 * (a retry after the proof arrived), "already submitted" counts as accepted, and every proof is checked to certify this transaction.
 */
export async function certify(agg: Certifier, cd: CertificationData, what: string, opts: { timeoutMs?: number; everyMs?: number } = {}): Promise<InclusionProof> {
  const sid = await StateId.fromCertificationData(cd);
  const t0 = performance.now();
  const check = (proof: InclusionProof): InclusionProof => {
    if (!proofIsFor(proof, cd)) {
      throw new ConflictError(`${what}: the state is certified for another transaction (${hex(proof.certificationData.transactionHash.data).slice(0, 16)}…, `
        + `not ${hex(cd.transactionHash.data).slice(0, 16)}…); this one can never be certified`);
    }
    return proof;
  };
  fact(`${what}: state id`, hex(sid.data));
  fact(`${what}: transaction hash`, hex(cd.transactionHash.data));
  const held = (await agg.getInclusionProof(sid)).inclusionProof;
  if (held) {
    fact(`${what}: submit`, 'skipped: the state is already certified');
  } else {
    const r = await agg.submitCertificationRequest(cd);
    fact(`${what}: submit`, r.status);
    if (!r.isAccepted && !r.isStateIdQueued) {
      // a refusal; an unknown status means "not accepted", so look once for a proof before giving up
      const late = (await agg.getInclusionProof(sid)).inclusionProof;
      if (!late) throw new Error(`${what}: the aggregator refused the request: ${r.status}`);
    }
  }
  const proof = check(held ?? await waitFor(`${what} to be certified`, opts.timeoutMs ?? 180_000, async () => (await agg.getInclusionProof(sid)).inclusionProof ?? undefined, opts.everyMs ?? 1000));
  fact(`${what}: certified in`, `${Math.round(performance.now() - t0)} ms`);
  fact(`${what}: inclusion proof`, `${proof.toCBOR().length} bytes CBOR, seal epoch ${proof.unicityCertificate.unicitySeal.epoch}, round ${proof.unicityCertificate.unicitySeal.rootChainRoundNumber}`);
  return proof;
}

/** A token file with one more certified transaction [tx, proof] after its last one (nbp tester/core.ts appendTransaction). */
export function appendTransaction(tokenBytes: Uint8Array, tx: Uint8Array, proof: Uint8Array): Uint8Array {
  const tagged = D.decodeTag(tokenBytes);
  if (tagged.tag !== TOKEN_TAG) throw new Error(`not a token (CBOR tag ${tagged.tag})`);
  const [version, genesis, txs] = D.decodeArray(tagged.data, 3);
  return C.encodeTag(TOKEN_TAG, arr(version, genesis, arr(...D.decodeArray(txs), arr(tx, proof))));
}

// ---- 1. lock --------------------------------------------------------------------------------------------------------------------------------
export interface Lock { nonce: bigint; amountWei: bigint; lockTx: string; lockBlockHash: string; blockNumber: bigint }

/** A signed lock transaction not yet seen in a receipt: kept (localStorage) before it is broadcast, so it is polled, never sent twice. */
export interface PendingLock { hash: string; raw: string; txNonce: string; amountWei: string; at: number }
export interface PendingLockStore { get(): PendingLock | null; put(p: PendingLock): void; clear(): void }
/** What lock needs of the EVM (a fake in the tests). */
export type LockEvm = Pick<Evm, 'sign' | 'broadcast' | 'receipt' | 'waitReceipt' | 'rpc'>;

/**
 * A JSON-RPC error that is the node refusing the transaction itself (it can never be mined as signed). Everything else is ambiguous: an
 * upstream timeout or 5xx the gateway wraps in a JSON-RPC error, "nonce too low" (it may have just been mined), "already known".
 */
export const isRefusal = (e: unknown): boolean =>
  e instanceof RpcError && !alreadyKnown(e.message) && !/nonce too low|timeout|timed out|deadline|upstream|gateway|unavailable|temporar|busy|overload|\b5\d\d\b|connect|reset|eof/i.test(e.message)
  && /insufficient funds|underpriced|intrinsic gas|gas limit|exceeds block gas|invalid (sender|signature|chain|transaction)|chain ?id|nonce too high|fee cap|max fee|tip higher|oversized|rlp/i.test(e.message);

/** Thrown when a lock's fate is not known yet: it stays pending, and the next Run polls it again. */
export class StillPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StillPendingError';
  }
}

/**
 * BridgeVault.lock(bytes p0) payable: p0 is the owner predicate the token will be minted to. The nonce is in the receipt's Locked log.
 * The signed transaction is stored before it is broadcast. While one is stored, a call resumes it (rebroadcasts the same bytes and polls
 * its hash) and ignores `amountWei`: a second lock is never sent while one is pending. The store is cleared only when the outcome is known:
 * a receipt, or proof that it can never be mined (its account nonce went to another transaction, or the node refused it outright while the
 * nonce had not moved). When in doubt it stays pending.
 */
export async function lock(s: { evm: LockEvm; cfg: Pick<TesterConfig, 'vault'> }, me: Burner, amountWei: bigint, store: PendingLockStore, opts: { timeoutMs?: number } = {}): Promise<Lock & { resumed: boolean }> {
  let p = store.get();
  const resumed = !!p;
  /** What the chain says now: mined (receipt), replaced (nonce used, no receipt), or open (neither). */
  const settle = async (q: PendingLock): Promise<'mined' | 'replaced' | 'open'> => {
    if (await s.evm.receipt(q.hash)) return 'mined';
    const used = BigInt(await s.evm.rpc<string>('eth_getTransactionCount', [me.evmAddress, 'latest']));
    // the receipt again: the transaction may be mined between the two reads
    if (await s.evm.receipt(q.hash)) return 'mined';
    return used > BigInt(q.txNonce) ? 'replaced' : 'open';
  };
  const replaced = (q: PendingLock): never => {
    store.clear();
    throw new Error(`the pending lock ${q.hash} was not mined and its account nonce ${q.txNonce} is used by another transaction: nothing was locked by it, Run locks again`);
  };
  /** A broadcast failed: decide from the chain, not from the error. Clear only on a refusal of a transaction that is provably not mined. */
  const afterError = async (q: PendingLock, e: unknown): Promise<void> => {
    let state: Awaited<ReturnType<typeof settle>>;
    try {
      state = await settle(q);
    } catch {
      throw new StillPendingError(`the lock ${q.hash} may have been sent (${errText(e)}), and its state cannot be read now: it stays pending, Run again later`);
    }
    if (state === 'mined') return;
    if (state === 'replaced') replaced(q);
    if (isRefusal(e)) {
      store.clear();
      throw new Error(`the node refuses the lock ${q.hash} (${errText(e)}) and it is not mined: nothing was locked; Run locks again`);
    }
    throw new StillPendingError(`the lock ${q.hash} is not mined yet and the send was not conclusive (${errText(e)}): it stays pending, Run again later`);
  };
  if (p) {
    fact('resuming the pending lock', `${p.hash} (${p.amountWei} wei, signed ${new Date(p.at).toISOString()})`);
    const state = await settle(p);
    if (state === 'replaced') replaced(p);
    if (state === 'open') {
      try {
        await s.evm.broadcast(p.raw);
      } catch (e) {
        await afterError(p, e);
      }
    }
  } else {
    if (amountWei <= 0n || amountWei >= 1n << 64n) throw new Error('one lock carries 1 to 2^64-1 wei');
    const data = calldata('lock(bytes)', encBytes(me.predicate));
    const signed = await s.evm.sign(me.secret, { to: s.cfg.vault, data, value: amountWei });
    p = { hash: signed.hash, raw: signed.raw, txNonce: signed.nonce.toString(), amountWei: amountWei.toString(), at: Date.now() };
    store.put(p);
    fact('tx', signed.hash);
    fact('calldata', `${data.length} bytes (p0 = owner predicate, ${me.predicate.length} bytes)`);
    fact('signed tx', `${(signed.raw.length - 2) / 2} bytes, gas limit ${signed.gas}, gas price ${signed.gasPrice}, account nonce ${signed.nonce}`);
    try {
      await s.evm.broadcast(signed.raw);
    } catch (e) {
      await afterError(p, e);
    }
  }
  const rc = await s.evm.waitReceipt(p.hash, opts.timeoutMs);
  if (rc.status !== '0x1') {
    store.clear();
    throw new Error(`${rc.transactionHash} reverted: nothing was locked`);
  }
  const log = rc.logs.find((l) => l.address.toLowerCase() === s.cfg.vault.toLowerCase() && l.topics[0] === LOCKED_TOPIC);
  if (!log) throw new Error(`${rc.transactionHash} has no Locked event of the vault`);
  const nonce = BigInt(log.topics[1]);
  fact('Locked event', `nonce ${nonce}, block ${BigInt(rc.blockNumber)}, gas used ${BigInt(rc.gasUsed)}`);
  store.clear();
  return { nonce, amountWei: BigInt(p.amountWei), lockTx: rc.transactionHash, lockBlockHash: rc.blockHash, blockNumber: BigInt(rc.blockNumber), resumed };
}

// ---- 2. lock proof --------------------------------------------------------------------------------------------------------------------------
/** The lock's proof (EVM header + account/storage MPT proofs + the EVM shard's UC): 404 until the lock block is certified and archived. */
export async function fetchLockProof(s: Session, l: Pick<Lock, 'nonce' | 'lockBlockHash'>): Promise<Uint8Array> {
  const url = `${s.lockproofUrl.replace(/\/$/, '')}/v1/lockproof?block=${l.lockBlockHash}&nonce=${l.nonce}`;
  const proof = await waitFor('the lock proof (the lock block certified and archived)', 300_000, async () => {
    const res = await fetch(url);
    if (res.status === 200) return new Uint8Array(await res.arrayBuffer());
    if (res.status === 404 || res.status === 429 || res.status === 502) return undefined;
    throw new Error(`the lock-proof endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }, 3000);
  fact('lock proof', `${proof.length} bytes CBOR`);
  return proof;
}

// ---- 3. mint ---------------------------------------------------------------------------------------------------------------------------------
/** Check the vault's lockDigest(nonce) is ours, then certify a mint whose justification is the lock proof. Returns the token file. */
export async function mint(s: Session, me: Burner, l: Lock, lockProof: Uint8Array): Promise<{ bytes: Uint8Array; tokenId: string }> {
  const { vaultCfg, dep } = s;
  const amount = amountBytes(l.amountWei);
  const salt = deriveSalt(dep.cfgHash, l.nonce);
  const expected = lockDigest(dep.cfgHash, l.nonce, lockRecord(vaultCfg.zeroAddress, vaultCfg.ty, vaultCfg.aid, amount, deriveTokenId(salt, vaultCfg.network), sha256(me.predicate)));
  const onChain = (await s.evm.call(s.cfg.vault, calldata('lockDigest(uint256)', encUint(l.nonce)))).replace(/^0x/, '');
  if (onChain !== hex(expected)) throw new Error(`the vault's lock ${l.nonce} is not this wallet's (another key or amount)`);
  fact('lockDigest(nonce)', `0x${onChain} = derived`);
  const justification = encodeJustification(vaultCfg.chainId, vaultCfg.vault, vaultCfg.zeroAddress, l.nonce, lockProof);
  const tx = await MintTransaction.create(NetworkId.fromId(vaultCfg.network), SignaturePredicate.create(me.publicKey), {
    data: valueEnvelope(vaultCfg.aid, amount), expiresAt: null, justification, salt: TokenSalt.fromBytes(salt), tokenType: new TokenType(vaultCfg.ty),
  });
  fact('mint tx', `${tx.toCBOR().length} bytes CBOR (justification ${justification.length})`);
  const proof = await certify(s.agg, await CertificationData.fromMintTransaction(tx), 'mint');
  const bytes = C.encodeTag(TOKEN_TAG, arr(u(2), arr(tx.toCBOR(), proof.toCBOR()), arr()));
  const v = await withTrust(s, () => s.bridge.verifyNativeTokenBytes(bytes, 'receipt'));
  fact('token', `${bytes.length} bytes, id ${hex(v.outcome.tokenId)}`);
  return { bytes, tokenId: hex(v.outcome.tokenId) };
}

// ---- 4./5. transfer and burn: built once, persisted, then certified --------------------------------------------------------------------------
/**
 * A transfer or burn transaction as built (its random state mask is inside the transaction bytes), with its signed certification request.
 * It is stored on the token record before it is submitted; a retry or a reload certifies this same request and never builds another.
 */
export type PendingTx = NonNullable<TokenRecord['pending']>;

/**
 * Before a stored transfer or burn is discarded: is its state certified, and for which transaction? 'none' (no proof: safe to discard and
 * build another), 'ours' (certified: Run finishes it, never discard), 'other' (spent by another transaction).
 */
export async function probePending(agg: Certifier, p: PendingTx): Promise<'none' | 'ours' | 'other'> {
  const cd = CertificationData.fromCBOR(unhex(p.cd));
  const proof = (await agg.getInclusionProof(await StateId.fromCertificationData(cd))).inclusionProof;
  if (!proof) return 'none';
  return proofIsFor(proof, cd) ? 'ours' : 'other';
}

/** Certify the stored transaction, or build, store (`persist`) and certify a new one; the token file grows by [tx, proof]. */
async function spend(agg: Certifier, me: Burner, bytes: Uint8Array, pending: PendingTx | undefined, kind: PendingTx['kind'],
  build: () => Promise<{ tx: TransferTransaction; extra: Pick<PendingTx, 'toPublicKey' | 'recipient'> }>, persist: (p: PendingTx) => void,
  opts?: { timeoutMs?: number; everyMs?: number }): Promise<Uint8Array> {
  if (pending && pending.kind !== kind) throw new Error(`a ${pending.kind} of this token is pending: run it to finish (the token's state is already being spent)`);
  let p = pending;
  if (p) {
    fact('resuming', `the stored ${kind} (built ${new Date(p.at).toISOString()}), not a new one`);
  } else {
    const { tx, extra } = await build();
    const cd = await CertificationData.fromTransaction(tx, await SignaturePredicateUnlockScript.create(tx, me.signer));
    p = { kind, tx: hex(tx.toCBOR()), cd: hex(cd.toCBOR()), at: Date.now(), ...extra };
    persist(p);
  }
  const proof = await certify(agg, CertificationData.fromCBOR(unhex(p.cd)), kind, opts);
  const out = appendTransaction(bytes, unhex(p.tx), proof.toCBOR());
  fact('token', `${bytes.length} → ${out.length} bytes`);
  return out;
}

/** A certified transfer to another owner's public key. With `pending`, its stored recipient is used, whatever `toPublicKey` says. */
export async function transfer(s: Pick<Session, 'agg'>, me: Burner, bytes: Uint8Array, toPublicKey: Uint8Array, pending: PendingTx | undefined, persist: (p: PendingTx) => void,
  opts?: { timeoutMs?: number; everyMs?: number }): Promise<Uint8Array> {
  return spend(s.agg, me, bytes, pending, 'transfer', async () => {
    const token = await Token.fromCBOR(bytes);
    return { tx: await TransferTransaction.create(token, SignaturePredicate.create(toPublicKey), StateMask.generate()), extra: { toPublicKey: hex(toPublicKey) } };
  }, persist, opts);
}

/** A transfer to BurnPredicate(sha256(reason)), the reason naming the EVM recipient and amount the vault will credit. */
export async function burn(s: Pick<Session, 'agg' | 'vaultCfg' | 'bridge' | 'trust'>, me: Burner, bytes: Uint8Array, recipient: string, pending: PendingTx | undefined, persist: (p: PendingTx) => void,
  opts?: { timeoutMs?: number; everyMs?: number }): Promise<Uint8Array> {
  return spend(s.agg, me, bytes, pending, 'burn', async () => {
    const { vaultCfg } = s;
    const v = await withTrustRefresh(s.trust, s.agg, () => s.bridge.verifyNativeTokenBytes(bytes, 'receipt'));
    const reason = returnReason(vaultCfg.chainId, vaultCfg.vault, vaultCfg.zeroAddress, vaultCfg.ty, vaultCfg.aid, unhex(recipient), v.outcome.amount);
    const token = await Token.fromCBOR(bytes);
    fact('return reason', `${reason.length} bytes → ${recipient}`);
    return { tx: await TransferTransaction.create(token, BurnPredicate.create(sha256(reason)), StateMask.generate(), { data: reason }), extra: { recipient } };
  }, persist, opts);
}

// ---- 6. return proof -------------------------------------------------------------------------------------------------------------------------
/**
 * The return envelope (the redeem(bytes) argument): the burned token's history with its proofs consolidated by the aggregator under one seal
 * (one anchor), or the proofs as certified when consolidation is unavailable.
 */
export async function returnProof(s: Session, burned: Uint8Array): Promise<{ encoded: Uint8Array; verified: VerifiedToken; consolidated: boolean }> {
  const token = await Token.fromCBOR(burned);
  return withTrust(s, async () => {
    const pc = new TokenProofClient({ routing: ShardRouting.single(s.agg), verificationContext: await s.bridge.context() });
    for (let attempt = 1; attempt <= 4; attempt++) {
      const cons = await consolidatedProofs(token, { partitionShards: 1, consolidate: (tk) => pc.consolidate(tk, { timeoutMs: 60_000 }) });
      if (cons.proofs) {
        const r = await buildReturnProof(s.bridge, await refreshToken(token, cons.proofs));
        describe(r.encoded, r.envelope.anchors.length, true);
        return { ...r, consolidated: true };
      }
      if (!(cons.path.kind === 'per-sid' && cons.path.retryable)) break;
      await sleep(5000);
    }
    const r = await buildReturnProof(s.bridge, token);
    describe(r.encoded, r.envelope.anchors.length, false);
    return { ...r, consolidated: false };
  });
}
const describe = (encoded: Uint8Array, anchors: number, consolidated: boolean): void =>
  fact('envelope', `${encoded.length} bytes, ${anchors} anchor(s), ${consolidated ? 'consolidated' : 'per state id'}`);

// ---- 7. redeem -------------------------------------------------------------------------------------------------------------------------------
/**
 * redeem(bytes envelope): first eth_call it until the vault accepts (it refuses until the registry's usable origin covers the seal's round,
 * a few root rounds), then send it. Anyone may send it; the vault credits the recipient the burn names.
 */
export async function redeem(s: Session, me: Burner, envelope: Uint8Array, expect: { nonce: bigint; tokenId: string }, onSent?: (hash: string) => void):
  Promise<{ rc: Receipt; already: false } | { already: true }> {
  const data = calldata('redeem(bytes)', encBytes(envelope));
  fact('calldata', `${data.length} bytes`);
  let polls = 0;
  let lastRevert: string | undefined;
  const ok = await waitFor('the vault to accept the return proof', 240_000, async () => {
    polls++;
    try {
      const ret = (await s.evm.call(s.cfg.vault, data, me.evmAddress)).replace(/^0x/, '');
      return BigInt(`0x${ret.slice(0, 64)}`) === expect.nonce && ret.slice(64, 128) === expect.tokenId ? 'accepted' as const : undefined;
    } catch (e) {
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
      if (e instanceof RpcError) {
        lastRevert = revertName(e.data) ?? e.message;
        // a redeem sent earlier (its receipt timed out, or the page reloaded) was mined: nothing more to send
        if (lastRevert === 'PartAlreadyRedeemed') return 'already' as const;
      }
      return undefined;
    }
  }, 3000).catch((e: unknown) => {
    throw lastRevert ? new Error(`${e instanceof Error ? e.message : String(e)}; the vault's last answer: ${lastRevert}`) : e;
  });
  fact('eth_call polls', polls);
  if (ok === 'already') {
    fact('vault', 'PartAlreadyRedeemed: this burn is already redeemed');
    return { already: true };
  }
  const sent = await s.evm.send(me.secret, { to: s.cfg.vault, data });
  onSent?.(sent.hash);
  fact('tx', sent.hash);
  const rc = await s.evm.waitReceipt(sent.hash);
  if (rc.status !== '0x1') throw new Error(`${rc.transactionHash} reverted`);
  fact('gas used', BigInt(rc.gasUsed));
  return { rc, already: false };
}

// ---- 8. claim --------------------------------------------------------------------------------------------------------------------------------
export const claimable = async (s: Session, who: string): Promise<bigint> =>
  BigInt(await s.evm.call(s.cfg.vault, calldata('claimable(address)', encAddress(who))));

/** claim(amount, to): the credit leaves the vault to an address; the caller must be the credited recipient. */
export async function claim(s: Session, me: Burner, to = me.evmAddress): Promise<{ amount: bigint; rc: Receipt }> {
  const amount = await claimable(s, me.evmAddress);
  if (amount === 0n) throw new Error(`${me.evmAddress} has no credit in the vault: redeem a burned token first`);
  const sent = await s.evm.send(me.secret, { to: s.cfg.vault, data: calldata('claim(uint256,address)', encUint(amount), encAddress(to)) });
  fact('tx', sent.hash);
  const rc = await s.evm.waitReceipt(sent.hash);
  if (rc.status !== '0x1') throw new Error(`${rc.transactionHash} reverted`);
  fact('claimed', `${amount} wei to ${to}`);
  return { amount, rc };
}
