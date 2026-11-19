/**
 * The old-epoch check and two forgeries of a held token's certificates (native bridge v2 tokens: the plug-in's own token codec, `decodeToken`).
 *
 * - Each certificate's seal names its root epoch and round; the verifier picks that epoch's committee from the held history and checks the
 *   round lies in the epoch's interval [start, next start). So a token sealed in an old epoch still verifies after rotations.
 * - Unknown keys: the seal re-signed by fresh keys under the same signer ids → QuorumNotMet.
 * - Re-labelled epoch: the genuine seal and signatures, with its epoch/round moved outside the named epoch's interval (what a retired committee
 *   signing after its end looks like) → SealEpoch, refused before any signature is checked.
 */
import type { TrustInput } from '@unicitylabs/native-bridge-plugin';
import { Nb2Error, decodeToken, encodeToken, lineageOf, type NativeBridgeV2, type Token } from '@unicitylabs/native-bridge-plugin/nb2';
import { UnicityCertificate } from '@unicitylabs/state-transition-sdk/lib/api/bft/UnicityCertificate.js';
import { UnicitySeal } from '@unicitylabs/state-transition-sdk/lib/api/bft/UnicitySeal.js';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/crypto/secp256k1/SigningService.js';
import { CborDeserializer as D } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborDeserializer.js';
import { CborSerializer as C } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborSerializer.js';

export interface SealRow {
  step: string;
  epoch: bigint;
  round: bigint;
  /** the held entry of the seal's epoch: its interval, or null when the history has no such epoch */
  entry: { start: bigint; end: bigint | null } | null;
  inInterval: boolean;
}

/** Every inclusion proof's raw certificate of a token and its lineage (a split part carries its parents'), root first, with a label. */
function certificatesOf(token: Token): { step: string; uc: Uint8Array }[] {
  const chain = lineageOf(token);
  const out: { step: string; uc: Uint8Array }[] = [];
  chain.forEach((t, level) => {
    const where = chain.length === 1 ? '' : level === chain.length - 1 ? 'part ' : level === 0 ? 'root ' : `split ${level} `;
    out.push({ step: `${where}mint`, uc: t.mintProof.uc });
    t.proofs.forEach((p, i) => out.push({ step: `${where}tx ${i + 1}`, uc: p.uc }));
  });
  return out;
}

/** Per certificate of the token and its lineage: its seal's epoch and round against the held history's entries. */
export async function sealTable(bytes: Uint8Array, trust: TrustInput): Promise<SealRow[]> {
  const h = trust.history;
  return certificatesOf(decodeToken(bytes)).map(({ step, uc }) => {
    const { epoch, rootChainRoundNumber: round } = UnicityCertificate.fromCBOR(uc).unicitySeal;
    const e = h.entryForEpoch(epoch);
    const entry = e ? { start: e.epochStartRound, end: h.epochEndRound(epoch) } : null;
    return { step, epoch, round, entry, inInterval: !!entry && round >= entry.start && (entry.end === null || round < entry.end) };
  });
}

/** The plug-in's verdict on a token file (offline, whole lineage): ok, or the refusal's rule (QuorumNotMet, SealEpoch, ...). */
export async function verdict(bridge: NativeBridgeV2, bytes: Uint8Array): Promise<{ ok: true } | { ok: false; reason: string; detail: string }> {
  try {
    await bridge.verifyToken(bytes);
    return { ok: true };
  } catch (e) {
    if (e instanceof Nb2Error) return { ok: false, reason: e.rule, detail: e.message };
    return { ok: false, reason: (e as Error).name ?? 'Error', detail: String(e) };
  }
}

/** The token file with every proof's certificate of the part itself (not its lineage) replaced by `mutate(certificate)`. */
async function withCertificates(bytes: Uint8Array, mutate: (uc: UnicityCertificate) => Promise<UnicityCertificate>): Promise<Uint8Array> {
  const t = decodeToken(bytes);
  const cache = new Map<string, Uint8Array>();
  const swap = async (raw: Uint8Array): Promise<Uint8Array> => {
    const k = Array.from(raw, (x) => x.toString(16).padStart(2, '0')).join('');
    if (!cache.has(k)) cache.set(k, (await mutate(UnicityCertificate.fromCBOR(raw))).toCBOR());
    return cache.get(k)!;
  };
  const mintProof = { ...t.mintProof, uc: await swap(t.mintProof.uc) };
  const proofs = [];
  for (const p of t.proofs) proofs.push({ ...p, uc: await swap(p.uc) });
  return encodeToken({ ...t, mintProof, proofs });
}

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
