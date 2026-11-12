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
import { calldata, decBytes, encAddress, encBytes, encUint, Evm, HttpError, LOCKED_TOPIC, type Receipt } from './evm.js';
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

/** Submit one certification request and wait for its inclusion proof. */
async function certify(agg: AggregatorClient, cd: CertificationData, what: string): Promise<InclusionProof> {
  const sid = await StateId.fromCertificationData(cd);
  const t0 = performance.now();
  await agg.submitCertificationRequest(cd);
  const proof = await waitFor(`${what} to be certified`, 180_000, async () => (await agg.getInclusionProof(sid)).inclusionProof ?? undefined, 1000);
  fact(`${what}: state id`, hex(sid.data));
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

/** BridgeVault.lock(bytes p0) payable: p0 is the owner predicate the token will be minted to. The nonce is in the receipt's Locked log. */
export async function lock(s: Session, me: Burner, amountWei: bigint): Promise<Lock> {
  if (amountWei <= 0n || amountWei >= 1n << 64n) throw new Error('one lock carries 1 to 2^64-1 wei');
  const data = calldata('lock(bytes)', encBytes(me.predicate));
  const sent = await s.evm.send(me.secret, { to: s.cfg.vault, data, value: amountWei });
  fact('tx', sent.hash);
  fact('calldata', `${data.length} bytes (p0 = owner predicate, ${me.predicate.length} bytes)`);
  fact('signed tx', `${(sent.raw.length - 2) / 2} bytes, gas limit ${sent.gas}, gas price ${sent.gasPrice}`);
  const rc = await s.evm.waitReceipt(sent.hash);
  if (rc.status !== '0x1') throw new Error(`${rc.transactionHash} reverted`);
  const log = rc.logs.find((l) => l.address.toLowerCase() === s.cfg.vault.toLowerCase() && l.topics[0] === LOCKED_TOPIC);
  if (!log) throw new Error(`${rc.transactionHash} has no Locked event of the vault`);
  const nonce = BigInt(log.topics[1]);
  fact('Locked event', `nonce ${nonce}, block ${BigInt(rc.blockNumber)}, gas used ${BigInt(rc.gasUsed)}`);
  return { nonce, amountWei, lockTx: rc.transactionHash, lockBlockHash: rc.blockHash, blockNumber: BigInt(rc.blockNumber) };
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
export async function mint(s: Session, me: Burner, l: Lock, lockProof: Uint8Array): Promise<Uint8Array> {
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
  return bytes;
}

// ---- 4. transfer -----------------------------------------------------------------------------------------------------------------------------
/** A certified transfer to another owner's public key; the file grows by [tx, proof]. */
export async function transfer(s: Session, me: Burner, bytes: Uint8Array, toPublicKey: Uint8Array): Promise<Uint8Array> {
  const token = await Token.fromCBOR(bytes);
  const tx = await TransferTransaction.create(token, SignaturePredicate.create(toPublicKey), StateMask.generate());
  const proof = await certify(s.agg, await CertificationData.fromTransaction(tx, await SignaturePredicateUnlockScript.create(tx, me.signer)), 'transfer');
  const out = appendTransaction(bytes, tx.toCBOR(), proof.toCBOR());
  fact('token', `${bytes.length} → ${out.length} bytes`);
  return out;
}

// ---- 5. burn ---------------------------------------------------------------------------------------------------------------------------------
/** A transfer to BurnPredicate(sha256(reason)), the reason naming the EVM recipient and amount the vault will credit. */
export async function burn(s: Session, me: Burner, bytes: Uint8Array, recipient: string): Promise<Uint8Array> {
  const { vaultCfg } = s;
  const v = await withTrust(s, () => s.bridge.verifyNativeTokenBytes(bytes, 'receipt'));
  const reason = returnReason(vaultCfg.chainId, vaultCfg.vault, vaultCfg.zeroAddress, vaultCfg.ty, vaultCfg.aid, unhex(recipient), v.outcome.amount);
  const token = await Token.fromCBOR(bytes);
  const tx = await TransferTransaction.create(token, BurnPredicate.create(sha256(reason)), StateMask.generate(), { data: reason });
  fact('return reason', `${reason.length} bytes → ${recipient}`);
  const proof = await certify(s.agg, await CertificationData.fromTransaction(tx, await SignaturePredicateUnlockScript.create(tx, me.signer)), 'burn');
  return appendTransaction(bytes, tx.toCBOR(), proof.toCBOR());
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
export async function redeem(s: Session, me: Burner, envelope: Uint8Array, expect: { nonce: bigint; tokenId: string }): Promise<Receipt> {
  const data = calldata('redeem(bytes)', encBytes(envelope));
  fact('calldata', `${data.length} bytes`);
  let polls = 0;
  await waitFor('the vault to accept the return proof', 240_000, async () => {
    polls++;
    try {
      const ret = (await s.evm.call(s.cfg.vault, data, me.evmAddress)).replace(/^0x/, '');
      return BigInt(`0x${ret.slice(0, 64)}`) === expect.nonce && ret.slice(64, 128) === expect.tokenId ? true : undefined;
    } catch (e) {
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
      return undefined;
    }
  }, 3000);
  fact('eth_call polls until accepted', polls);
  const sent = await s.evm.send(me.secret, { to: s.cfg.vault, data });
  fact('tx', sent.hash);
  const rc = await s.evm.waitReceipt(sent.hash);
  if (rc.status !== '0x1') throw new Error(`${rc.transactionHash} reverted`);
  fact('gas used', BigInt(rc.gasUsed));
  return rc;
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
