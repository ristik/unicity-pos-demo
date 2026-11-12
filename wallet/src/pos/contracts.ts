/**
 * The PoS read surface: every view the visualizer calls, with its Solidity signature and named outputs, as deployed at contracts
 * 7b510f6b (src/p85/IP85.sol, CustodyStorage.sol, StakeCustody.sol, ElectionPolicy.sol, EligibilityReader.sol, GovernanceParams.sol,
 * RewardPool.sol, Evidence.sol; src/SealRegistry.sol). Public struct getters return their static members flat; a function returning a
 * struct with a dynamic member returns one tuple.
 */
export interface Fn {
  /** the contract role, for the explain drawer */
  contract: Role;
  sig: string;
  out: string;
  /** immutable once read (cached for the page's lifetime); per-argument for keyed views */
  immutable?: boolean;
  /** the source line, for the explain drawer */
  src?: string;
}

export type Role = 'registry' | 'custody' | 'election' | 'reader' | 'evidence' | 'governance' | 'rewardPool';

const POLICY = 'uint16 penaltyBps,uint16 lifetimeCapBps,uint16 bountyBps,uint128 bountyCap,uint64 evidenceWindow,uint64 suffixEvidenceWindow,uint64 holdNormal,uint64 holdSuffix,uint64 holdRetirement,uint64 timeFloor';

const f = (contract: Role, sig: string, out: string, extra: Partial<Fn> = {}): Fn => ({ contract, sig, out, ...extra });

export const FN = {
  // SealRegistry (fixed address): the authenticated root clock and record log
  progress: f('registry', 'progress()', 'uint64', { src: 'SealRegistry.sol:531' }),
  ucTime: f('registry', 'ucTime()', 'uint64', { src: 'SealRegistry.sol:537' }),
  recordCount: f('registry', 'recordCount()', 'uint64', { src: 'SealRegistry.sol:497' }),
  recordAt: f('registry', 'recordAt(uint64)', '(uint64 index,bytes32 recordID,bytes32 predecessor,uint8 kind,uint64 progress,uint64 ucTime,bytes data) r', { immutable: true, src: 'SealRegistry.sol:509' }),

  // StakeCustody
  nextStakingID: f('custody', 'nextStakingID()', 'uint64', { src: 'CustodyStorage.sol:228 (the last id issued)' }),
  lastAckedAssignment: f('custody', 'lastAckedAssignment()', 'bytes32', { src: 'CustodyStorage.sol:230' }),
  recordCursor: f('custody', 'recordCursor()', 'uint64', { src: 'CustodyStorage.sol:232' }),
  bondUnit: f('custody', 'bondUnit()', 'uint128', { immutable: true }),
  minBond: f('custody', 'minBond()', 'uint128', { immutable: true }),
  limits: f('custody', 'limits()', 'uint32 vMax,uint32 lMax,uint32 rMax,uint32 maxBatch', { immutable: true, src: 'P85Types.sol:21' }),
  totalFree: f('custody', 'totalFree()', 'uint256'),
  totalEncumbered: f('custody', 'totalEncumbered()', 'uint256'),
  totalDraining: f('custody', 'totalDraining()', 'uint256'),
  positions: f('custody', 'positions(uint64)', 'address owner,address withdrawal,bytes32 rootKeyHash,bytes32 stagedRootKeyHash,uint64 generation,uint64 roleNonce,uint32 openLots,uint32 lotCount,bool retirementRequested', { src: 'IP85.sol:41' }),
  generationLots: f('custody', 'generationLots(uint64,uint64)', 'uint256[]', { src: 'StakeCustody.sol:765' }),
  lots: f('custody', 'lots(uint256)', 'uint64 id,uint64 generation,uint128 initial,uint128 remaining,uint128 penalized,uint8 category,uint16 capBps,uint32 refCount,uint64 holdRetirement,uint64 timeFloor,uint64 holdUntil,uint64 evidenceUntil,uint64 timeUntil', { src: 'CustodyStorage.sol:177' }),
  retirements: f('custody', 'retirements(uint64,uint64)', 'bool imported,uint64 pRet,uint64 tRet', { src: 'CustodyStorage.sol:207' }),
  assignments: f('custody', 'assignments(bytes32)', 'uint8 state,bytes32 lineage,uint64 rootEpoch,uint64 evmEpoch,uint64 offset,uint64 firstRound,bool offsetSet,bool hKnown,uint64 hRound,bool closed,uint64 pClose,uint64 tClose,bytes32 closureKey,bytes32 exposureDigest,bytes32 keyDigest,uint32 policyID', { src: 'IP85.sol:70' }),
  assignmentExposures: f('custody', 'assignmentExposures(bytes32)', 'bytes32[]', { immutable: true, src: 'StakeCustody.sol:778' }),
  exposures: f('custody', 'exposures(bytes32)', 'bytes32 assignmentID,uint64 id,uint64 generation,uint64 weight,uint64 rawWeight,bytes32 rootKeyHash,bytes32 evmKeyHash,address operatorPayee,bool referencesReleased,uint32 sessionLocks', { src: 'IP85.sol:55' }),
  keyOwner: f('custody', 'keyOwner(bytes32)', 'uint64 id,uint8 role', { src: 'StakeCustody.sol:769' }),

  // ElectionPolicy
  params: f('election', 'params()', 'uint32 nMin,uint32 nTarget,uint32 nMax,uint64 maxM,uint64 distNum,uint64 distDen,uint64 cadenceRounds,uint64 cadenceSeconds', { immutable: true, src: 'P85Types.sol:30' }),
  thresholds: f('election', 'thresholds()', 'uint256 progress,uint256 ucTime', { src: 'ElectionPolicy.sol:450' }),
  anchorProgress: f('election', 'anchorProgress()', 'uint64'),
  anchorTime: f('election', 'anchorTime()', 'uint64'),
  attemptCursor: f('election', 'attemptCursor()', 'uint64'),
  openResult: f('election', 'openResult()', 'bytes32', { src: 'ElectionPolicy.sol:224' }),
  lastAttemptResult: f('election', 'lastAttemptResult()', 'bytes32', { src: 'ElectionPolicy.sol:238' }),
  liveCount: f('election', 'liveCount()', 'uint32'),
  isIndexed: f('election', 'isIndexed(uint64)', 'bool'),
  delegation: f('election', 'delegation(uint64,uint64)', '(bytes32 rootNodeID,bytes rootKey,bytes32 evmNodeID,bytes evmKey,address operatorPayee) binding,bytes32 bindingHash,uint64 nextNonce', { src: 'ElectionPolicy.sol:965' }),
  result: f('election', 'result(bytes32)', 'uint8 state,uint8 reason,uint64 attempt,uint64 progress,uint64 ucTime,uint32 policyID,bytes32 origin,bytes32 predecessor,bytes32 assignmentID,bytes32 snapshotDigest', { src: 'ElectionPolicy.sol:957' }),
  frozenMembers: f('election', 'frozenMembers(bytes32)', '(uint64 id,uint64 generation,uint64 weight,uint64 raw,bytes32 bindingHash)[]', { immutable: true, src: 'ElectionPolicy.sol:961' }),
  publication: f('election', 'publication(bytes32)', 'bytes32 primaryHash,bytes32 kCommit,bytes32 incumbent,bytes32 incumbentExposureDigest,bytes32 incumbentKeyDigest,bytes32 policyDigest,bytes32 contractsDigest,bytes32 snapshotDigest,bytes32 assignmentID,bytes32 popSetDigest,bool published,uint32 popCount,uint64 attempt,bool lost', { src: 'ElectionPolicy.sol:930' }),
  policySource: f('election', 'policySource()', 'address', { immutable: true }),
  reader: f('election', 'reader()', 'address', { immutable: true }),
  evidence: f('election', 'evidence()', 'address', { immutable: true }),
  vMax: f('election', 'vMax()', 'uint32', { immutable: true }),

  // EligibilityReader (stateless)
  committed: f('reader', 'committed(bytes32)', '(uint64 id,bytes32 binding,uint64 weight)[]', { src: 'EligibilityReader.sol:126' }),

  // Evidence
  excluded: f('evidence', 'excluded(uint64)', 'bool', { src: 'Evidence.sol:485' }),

  // GovernanceParams (the policy source)
  policy: f('governance', 'policy()', `(${POLICY}) p`, { src: 'GovernanceParams.sol:114' }),
  currentPolicyID: f('governance', 'currentPolicyID()', 'uint32'),
  currentRewardRate: f('governance', 'currentRewardRate()', 'uint128', { src: 'GovernanceParams.sol:132' }),
  pending: f('governance', 'pending()', `uint8 state,uint64 nonce,bytes32 predecessor,(${POLICY}) policy,uint128 rewardRate,uint64 notBeforeProgress,uint64 notBeforeTime`, { src: 'GovernanceParams.sol:140' }),
  DELAY_ROUNDS: f('governance', 'DELAY_ROUNDS()', 'uint64', { immutable: true }),
  DELAY_SECONDS: f('governance', 'DELAY_SECONDS()', 'uint64', { immutable: true }),

  // RewardPool
  rpAvailable: f('rewardPool', 'available()', 'uint256'),
  rpTotalCredits: f('rewardPool', 'totalCredits()', 'uint256'),
  rpNextStart: f('rewardPool', 'nextStart()', 'uint64'),
} satisfies Record<string, Fn>;

export type FnName = keyof typeof FN;

/** ElectionPolicy.ResultState / Reason, RootRecord kinds, lot categories (P85Types.sol, ElectionPolicy.sol:106-124). */
export const RESULT_STATE = ['None', 'Reserved', 'NoCandidate', 'Acknowledged', 'Recovered', 'Closed'];
export const REASON = ['None', 'InvalidProfile', 'Cardinality', 'MembershipChurn', 'WeightChurn', 'ReferenceCapacity', 'ReservationRefused', 'InternalFailure'];
export const RECORD_KIND = ['None', 'SessionClosed', 'Ack', 'RecoveryAck', 'Closure', 'Retirement'];
export const LOT_CATEGORY = ['None', 'Free', 'Encumbered', 'Draining', 'Released'];
export const ASSIGNMENT_STATE = ['none', 'Reserved', 'Active', 'Aborted'];

/**
 * The roots order a RejectResult for a reserved result that is not prepared within this many ordinary progress rounds (bft-core
 * rootchain storage.ResultReservationLifetimeProgress; deploy/testnet/pos_reject.py LIFETIME). A root-side constant, not readable on chain.
 */
export const REJECT_AFTER_ROUNDS = 16384n;
