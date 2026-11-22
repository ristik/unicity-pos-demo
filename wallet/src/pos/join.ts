/** Read the first certified EVM block signed by a member added in an authenticated 4 → 5 handoff. */
import type { TrustInput } from '@unicitylabs/native-bridge-plugin';
import { EvmReader } from '@unicitylabs/native-bridge-plugin/nb2';
import { UnicityCertificate } from '@unicitylabs/state-transition-sdk/lib/api/bft/UnicityCertificate.js';
import { UnicityCertificateVerifier } from '@unicitylabs/state-transition-sdk/lib/api/bft/verification/UnicityCertificateVerifier.js';
import { UnicitySealQuorumSignaturesVerificationRule } from '@unicitylabs/state-transition-sdk/lib/api/bft/verification/rule/UnicitySealQuorumSignaturesVerificationRule.js';
import { Secp256k1SignatureVerifier } from '@unicitylabs/state-transition-sdk/lib/crypto/secp256k1/Secp256k1SignatureVerifier.js';
import { eqBytes, hex } from '../hex.js';
import type { Chain } from './chain.js';

const signatureVerifier = new Secp256k1SignatureVerifier();
const verifier = new UnicityCertificateVerifier(
  new UnicitySealQuorumSignaturesVerificationRule(signatureVerifier, undefined, { maxSignatures: 16 }),
);

export function fifthValidator(trust: TrustInput) {
  const entries = trust.history.entries;
  for (let i = entries.length - 1; i > 0; i--) {
    const next = entries[i];
    const previous = entries[i - 1];
    if (previous.members.length !== 4 || next.members.length !== 5) continue;
    if (!previous.members.every((old) => next.members.some((member) => member.nodeId === old.nodeId && eqBytes(member.sigKey, old.sigKey)))) continue;
    const member = next.members.find((member) => !previous.members.some((old) => old.nodeId === member.nodeId))!;
    return { previous, next, member };
  }
  return null;
}

interface FirstSignature { block: bigint; hash: string; round: bigint }

export class JoinEvidence {
  private readonly reader: EvmReader;
  private epoch?: bigint;
  private low?: bigint;
  private high?: bigint;
  private cursor?: bigint;
  first?: FirstSignature;

  constructor(chain: Chain) {
    this.reader = new EvmReader({ call: (method, params) => chain.raw(method, params) });
  }

  private async certificate(trust: TrustInput, block: bigint) {
    const at = await this.reader.headerByNumber(block);
    if (!at || at.header.number !== block) throw new Error(`EVM header ${block} is unavailable`);
    const bytes = await this.reader.certificateOf(at.header, at.hash, true);
    const uc = UnicityCertificate.fromCBOR(bytes);
    const { unicitySeal: seal } = uc;
    if (!seal.networkId.equals(trust.network) || uc.shardConfigurationHash.length !== 32
      || Number(uc.unicityTreeCertificate.partitionIdentifier) !== 8
      || hex(uc.shardTreeCertificate.shard.encode()) !== '80'
      || !uc.inputRecord.blockHash || !eqBytes(uc.inputRecord.blockHash, at.hash)) {
      throw new Error(`UC for block ${block} does not bind the expected EVM header, partition and shard`);
    }
    const result = await verifier.verifyCertificate(trust.history, uc, { partitionId: uc.unicityTreeCertificate.partitionIdentifier });
    if (String(result.status) !== 'OK') throw new Error(`UC for block ${block} failed pinned UTB verification`);
    return { seal, hash: `0x${hex(at.hash)}` };
  }

  /** Search a bounded number of headers per poll. A missing proof leaves the same position for the next poll. */
  async poll(trust: TrustInput, joined: NonNullable<ReturnType<typeof fifthValidator>>): Promise<void> {
    const epoch = joined.next.epoch;
    if (this.epoch !== epoch) {
      this.epoch = epoch;
      this.low = this.high = this.cursor = undefined;
      this.first = undefined;
    }
    if (this.first) return;
    const latest = await this.reader.blockNumber() - 1n;
    if (latest < 1n) return;
    if (this.high === undefined) {
      const tip = await this.certificate(trust, latest);
      if (tip.seal.epoch < epoch) return;
      this.low = 1n;
      this.high = latest;
    }
    for (let n = 0; n < 3; n++) {
      if (this.cursor === undefined) {
        const low = this.low!;
        const high: bigint = this.high!;
        if (low < high) {
          const mid: bigint = (low + high) / 2n;
          const { seal } = await this.certificate(trust, mid);
          if (seal.epoch < epoch) this.low = mid + 1n;
          else this.high = mid;
          continue;
        }
        this.cursor = low;
      }
      const block = this.cursor;
      if (block > latest) return;
      const { seal, hash } = await this.certificate(trust, block);
      if (seal.epoch !== epoch) {
        if (seal.epoch > epoch) throw new Error('No signed EVM UC was found in the join epoch');
        throw new Error(`Certified epoch at EVM block ${block} precedes the join epoch`);
      }
      const sig = seal.signatures?.get(joined.member.nodeId);
      if (sig && await signatureVerifier.verify(await seal.calculateHash(), sig, joined.member.sigKey)) {
        this.first = { block, hash, round: seal.rootChainRoundNumber };
        return;
      }
      this.cursor = block + 1n;
    }
  }
}
