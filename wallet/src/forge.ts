/**
 * The old-epoch check and two forgeries of a held token's certificates.
 *
 * - Each certificate's seal names its root epoch and round; the verifier picks that epoch's committee from the held history and checks the
 *   round lies in the epoch's interval [start, next start). So a token sealed in an old epoch still verifies after rotations.
 * - Unknown keys: the seal re-signed by fresh keys under the same signer ids (bridge-tester.ts unknownKeyCertificate) → ErrQuorumNotMet.
 * - Re-labelled epoch: the genuine seal and signatures, with its epoch/round moved outside the named epoch's interval (what a retired committee
 *   signing after its end looks like) → ErrSealEpoch, refused before any signature is checked.
 */
import type { NativeBridge, TrustInput } from '@unicitylabs/native-bridge-plugin';
import { NativeError } from '@unicitylabs/native-bridge-plugin';
import { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProof.js';
import { UnicityCertificate } from '@unicitylabs/state-transition-sdk/lib/api/bft/UnicityCertificate.js';
import { UnicitySeal } from '@unicitylabs/state-transition-sdk/lib/api/bft/UnicitySeal.js';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/crypto/secp256k1/SigningService.js';
import { CborDeserializer as D } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborDeserializer.js';
import { CborSerializer as C } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborSerializer.js';
import { Token } from '@unicitylabs/state-transition-sdk/lib/transaction/Token.js';

import { hex } from './hex.js';

export interface SealRow {
  step: string;
  epoch: bigint;
  round: bigint;
  /** the held entry of the seal's epoch: its interval, or null when the history has no such epoch */
  entry: { start: bigint; end: bigint | null } | null;
  inInterval: boolean;
}

const proofsOf = (t: Token): InclusionProof[] => [t.genesis, ...t.transactions].map((c) => c.inclusionProof);

/** Per certificate of the token: its seal's epoch and round against the held history's entries. */
export async function sealTable(bytes: Uint8Array, trust: TrustInput): Promise<SealRow[]> {
  const token = await Token.fromCBOR(bytes);
  const h = trust.history;
  return proofsOf(token).map((p, i) => {
    const { epoch, rootChainRoundNumber: round } = p.unicityCertificate.unicitySeal;
    const e = h.entryForEpoch(epoch);
    const entry = e ? { start: e.epochStartRound, end: h.epochEndRound(epoch) } : null;
    return { step: i === 0 ? 'mint' : `tx ${i}`, epoch, round, entry, inInterval: !!entry && round >= entry.start && (entry.end === null || round < entry.end) };
  });
}

/** The verdict of the plug-in on a token file: ok, or the refusal's reason (ErrQuorumNotMet, ErrSealEpoch, ...). */
export async function verdict(bridge: NativeBridge, bytes: Uint8Array): Promise<{ ok: true } | { ok: false; reason: string; detail: string }> {
  try {
    await bridge.verifyNativeTokenBytes(bytes, 'receipt');
    return { ok: true };
  } catch (e) {
    if (e instanceof NativeError) return { ok: false, reason: e.reason, detail: e.detail ?? e.message };
    return { ok: false, reason: (e as Error).name ?? 'Error', detail: String(e) };
  }
}

/** The token file with every proof's certificate replaced by `mutate(certificate)` (same transactions, same inclusion paths). */
async function withCertificates(bytes: Uint8Array, mutate: (uc: UnicityCertificate) => Promise<UnicityCertificate>): Promise<Uint8Array> {
  const tagged = D.decodeTag(bytes);
  const [version, genesis, txs] = D.decodeArray(tagged.data, 3);
  const token = await Token.fromCBOR(bytes);
  const cache = new Map<string, UnicityCertificate>();
  const swap = async (p: InclusionProof): Promise<Uint8Array> => {
    const k = hex(p.unicityCertificate.toCBOR());
    if (!cache.has(k)) cache.set(k, await mutate(p.unicityCertificate));
    return new InclusionProof(p.certificationData, p.referenceTime, p.inclusionCertificate, cache.get(k)!).toCBOR();
  };
  const [mintTx] = D.decodeArray(genesis, 2);
  const rest = D.decodeArray(txs);
  const certified = [arr2(mintTx, await swap(token.genesis.inclusionProof))];
  for (let i = 0; i < rest.length; i++) certified.push(arr2(D.decodeArray(rest[i], 2)[0], await swap(token.transactions[i].inclusionProof)));
  return C.encodeTag(tagged.tag, C.encodeArray(version, certified[0], C.encodeArray(...certified.slice(1))));
}
const arr2 = (a: Uint8Array, b: Uint8Array): Uint8Array => C.encodeArray(a, b);

/** The certificate with its seal re-signed by fresh keys under the same signer ids: keys no trust-base entry ever held. */
export async function unknownKeyCertificate(uc: UnicityCertificate): Promise<UnicityCertificate> {
  const s = uc.unicitySeal;
  const signers = new Map([...(s.signatures ?? new Map()).keys()].map((id) => [id, SigningService.generate()] as const));
  if (signers.size === 0) throw new Error('the genuine seal is unsigned');
  const seal = await UnicitySeal.create(s.networkId, s.rootChainRoundNumber, s.epoch, s.timestamp, s.previousHash, s.hash, signers);
  return new UnicityCertificate(uc.inputRecord, uc.technicalRecordHash, uc.shardConfigurationHash, uc.shardTreeCertificate, uc.unicityTreeCertificate, seal);
}

export const forgeUnknownKeys = (bytes: Uint8Array): Promise<Uint8Array> => withCertificates(bytes, unknownKeyCertificate);

/**
 * Where a re-labelled seal goes, given the held history: past the end of its epoch when a later epoch is held (a retired committee signing
 * after its end); else into the previous epoch at the same round; else (only the genesis epoch is held) to the epoch before the genesis.
 */
export function relabelTarget(trust: TrustInput, epoch: bigint, round: bigint): { epoch: bigint; round: bigint; why: string } {
  const h = trust.history;
  const end = h.epochEndRound(epoch);
  if (end !== null) return { epoch, round: end, why: `epoch ${epoch} ended at round ${end}: the seal now claims round ${end} of it` };
  if (h.entryForEpoch(epoch - 1n)) return { epoch: epoch - 1n, round, why: `round ${round} is after epoch ${epoch - 1n}'s end: the seal now claims epoch ${epoch - 1n}` };
  return { epoch: epoch - 1n, round, why: `only epoch ${epoch} is held: the seal now claims epoch ${epoch - 1n}, before the genesis` };
}

/** The seal's epoch and round rewritten in its CBOR (signatures kept as they are). */
export function relabelSeal(seal: UnicitySeal, epoch: bigint, round: bigint): UnicitySeal {
  const f = D.decodeArray(D.decodeTag(seal.toCBOR()).data);
  f[2] = C.encodeUnsignedInteger(round);
  f[3] = C.encodeUnsignedInteger(epoch);
  return UnicitySeal.fromCBOR(C.encodeTag(UnicitySeal.CBOR_TAG, C.encodeArray(...f)));
}

export async function forgeRelabelled(bytes: Uint8Array, trust: TrustInput): Promise<{ bytes: Uint8Array; why: string[] }> {
  const why = new Set<string>();
  const out = await withCertificates(bytes, async (uc) => {
    const s = uc.unicitySeal;
    const t = relabelTarget(trust, s.epoch, s.rootChainRoundNumber);
    why.add(t.why);
    return new UnicityCertificate(uc.inputRecord, uc.technicalRecordHash, uc.shardConfigurationHash, uc.shardTreeCertificate, uc.unicityTreeCertificate,
      relabelSeal(s, t.epoch, t.round));
  });
  return { bytes: out, why: [...why] };
}
