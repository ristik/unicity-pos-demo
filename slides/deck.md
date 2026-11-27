---
marp: true
theme: default
paginate: true
title: Unicity PoS: enshrined EVM, validator registry, NB2 v1.1 and a live demo
style: |
  section { font-size: 24px; }
  section.small { font-size: 19px; }
  section.tiny { font-size: 16px; }
  table { font-size: 0.8em; }
  code { font-size: 0.9em; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2em; }
  .plan { color: #8a5a00; }
---

<!-- _paginate: false -->

# Unicity proof of stake

### Enshrined EVM · stake-elected validators · NB2 v1.1 · trust-base history

Demonstrated on public testnet `tn-public-20261127b` (chain ID `496562270`).

<!-- Speaker: 45 min. About 15 min of slides, about 20 min demo, 10 min Q&A.
Check the live network and release manifest before presenting. -->

---

## What we'll show

1. **The setup**: what runs on the testnet, its endpoints and repos.
2. **Assets demo** (NB2 v1.1): UCT from the faucet → **deposit** → mint a Unicity token → split → send to a second wallet (another tab) → **burn** → **redeem** on the EVM.
3. **PoS demo**: the committee, stakes and quorum, live. A new validator joins from a container. The election **selects it by stake**, and the validator **publishes its own proof** and verifies activation with its local root. An old-epoch token **still verifies**. A forged one is rejected.
4. **How it works underneath**: elections, slashing, governance, the bridge. Then PoA, the intermediate mode, and what's still left to do.

The assets demo runs in a browser with zero configuration, using a burner key and public endpoints.

---

<!-- _class: lead -->

# Background

the stack · proof of stake · governance · bridge · tested limits · maturity

---

## The stack in one picture

```
            ┌──────────── one validator organization ────────────┐
            │  root node ── BFT consensus, epochs, handoffs      │
            │  shard node ─ certifies EVM blocks (partition 8)   │
  ×N        │  authority ── signing keys (root vote, EVM, PoPs)  │
            │  ureth ────── EVM execution (reth fork)            │
            └────────────────────────────────────────────────────┘
                         │ unicity certificates (UC)
   ValidatorRegistry + PoS module (EVM system contracts) ── stake, elections, live config
   aggregator-go (partition 7, SMT) ── token state certification
   SDKs (JS / Rust / Java 4.0) ── self-contained tokens + UTB history
```

- **The committee is elected on chain, from stake.** Roots read the result from certified EVM state. There is no coordinator service.
- One security principal per validator: root key and EVM key are different keys bound to one identity. Keys are not shared between services.
- We already assume a 2/3 honest majority of bft-core, so it is fine to trust that 1/2 of the co-hosted EVM execution clients are honest.

---

## Key terms

- **Unicity certificate (UC)**: the root's proof that a shard state was certified. Valid when the signers reach `⌊2W/3⌋+1` of **the seal's own epoch's** committee weight W.
- **Epoch**: a period with one fixed committee (members, keys, weights). It changes only through the **handoff**: election → Intent → Prepare → Freeze → Commit (H) → switch to J → Boundary acknowledged.
- **ValidatorRegistry (VR)** `0xff…03`: holds identities, the **election module pointer** and live config. Its output for an epoch boundary is what the roots install.
- **Election module**: the policy that picks the committee. **PoS** elects by bonded stake. PoA, where the Foundation admits members, is the intermediate mode; both sit behind one interface.
- **UTB (trust-base history)**: an append-only chain of signed root trust-base entries, one per epoch, each signed by its predecessor's quorum. The genesis entry ID is the network's trust pin.
  → *Tokens stay verifiable across validator rotations.*

---

## Testnet

<div class="cols">
<div>

| | |
|---|---|
| Release | [Network API](https://pos.staging.unicity.network/api/network) · [Release manifest](https://pos.staging.unicity.network/release/manifest.json) |
| Validators | **4 at genesis** · **16**-seat PoS limit |
| Weight | `⌊bonded principal / 100 UCT⌋` |
| Elections | round **and** UC time thresholds |
| Governance | 3-of-5 · 2,000 rounds **and** 3,600 s |
| Block target | ≈ 10 s (delay-only) |
| Hardware | 6c/12t, 64 GB, 2 × 1 TB NVMe |

</div>
<div>

| Endpoint | |
|---|---|
| `POST /rpc` | EVM JSON-RPC (allow-listed) |
| `POST /aggregator` | aggregator JSON-RPC |
| `GET /api/v1/trustbases` | UTB history (CBOR) |
| `/faucet/` | hCaptcha faucet |
| `/demo/`, `/demo/pos.html` | wallet, PoS visualizer |
| `/release/` | NB2 manifest, pinned UTB, B1 checkpoint |

</div>
</div>

Public host **pos.staging.unicity.network**. Root and shard administration, authority sockets, Engine API and metrics stay on the private network.

---

<!-- _class: small -->

## Repos

| Repo | Role | Branch |
|---|---|---|
| `ristik/bft-core` | root chain, shard nodes, Engine API adapter, epochs, UTB, VR handoff, `ubft validator` / `ubft governance`, testnet package | `integration/enshrined-evm` |
| `ristik/ureth` | EVM execution: reth fork + system prefix, SealRegistry kernel, record import, precompiles | `unicity/main` |
| `ristik/unicity-pos-contracts` | PoS (StakeCustody, ElectionPolicy, Evidence, RewardPool, GovernanceParams), the VR adapter, ValidatorRegistry, PoaElection, FoundationMultisig, NB2 vault + verifier | `main` |
| `ristik/native-bridge-plugins` | NB2 v1.1 with continuation: TS wallet plug-in, Rust port, reference CLI wallet, vectors | `main` |
| `ristik/aggregator-go` | aggregator + UTB history + uc-consolidation; follows its shard config from the roots | `integration/enshrined-evm` |
| `ristik/state-transition-sdk-{js,rust,java}` | SDK 4.0: `RootTrustBaseV2`, `TrustBaseHistory` | `integration/enshrined-evm` |
| `ristik/bft-go-base` | shared Go types, trust-base codecs | `integration/enshrined-evm` |
| `ristik/unicity-pos-demo` | this wallet, PoS visualizer and slides | `main` |

Forks keep `main` as the upstream-sync branch. UTB v2 is merged upstream (bft-go-base#20; aggregator-go#273, sdk-js#206, sdk-rust#73, sdk-java#101; unicity-ids#11).

---

## ureth block: protocol-specific prefix

1. registry `open` → 2. registry `finalize` → 3. EIP-4788 hook → 4. control-record import → 5. **VR and PoS hooks** (reconcile records, governance, **election**) → 6. user transactions

- Prefix failure ⇒ invalid block. System gas is reserved, not charged.
- **SealRegistry** `0xff…02`: contract-visible root authority, **any-age** (every epoch's committee kept forever).
- **ValidatorRegistry** `0xff…03`: the election module runs **contained**, with gas caps at both layers and no reentrancy, so a failing module can't stall the chain. Native repair takes over if it stops producing.
- Precompiles (reusable Unicity validation only):
  - `0x0100` UC batch check (1..16 claims)
  - `0x0102` aggregator SMT membership
  - `0x0104` token-history kernel
  - `0x0105` (composed bridge redemption) **removed**: bridge v2 verifies in EVM bytecode on top of these.
- The block execution revision is committed into the B1 profile and network identity, so a node with different rules is refused rather than forking silently.

---

## One registry, pluggable election modules

```
          FoundationMultisig (3-of-5) ──queue → delay → execute──┐  (bounded parameters, live config, upgrades)
                                                                 ▼
  validator ─ register / bond / retire ─▶ ValidatorRegistry ── module pointer ──▶ PoS module  (StakeCustody, ElectionPolicy, …)
                                          │  identities, bindings          ╲ ─ ─▶ PoaElection (intermediate mode)
                                          │  live config, schedule
                                          ▼ output at the epoch boundary
                                 roots: admit → handoff → new UTB entry
```

- **The target is PoS**: stake elects the committee, and the nodes do the handoff themselves from chain state.
- **PoA is a special case** of the same machinery: the Foundation admits members instead of stake electing them (see the PoA slide).
- **Switching modes** is one governed pointer change, with no root or node change. Later modes, such as a hybrid, are new modules behind the same interface.
- **Single-boundary rule**: every change takes effect at exactly one epoch boundary, read from certified EVM state. Safety holds unconditionally under > 2/3 honest weight; liveness under a hostile network is best effort.

---

## PoS contracts

| Contract | Role |
|---|---|
| **StakeCustody** | identities, roles, bond **lots**, key history, exposures, maturity, claims; the registry's liability holder |
| **ElectionPolicy** | live index, EVM-key binding, election, candidate J + recovery K, PoPs |
| **Evidence** | objective double-sign evidence, holds, capped penalties |
| **GovernanceParams** | bounded, prospective parameter changes with a timelock (authority: the multisig) |
| **RewardPool** | separately funded operator rewards (no minting) |
| **PosElectionAdapter** | maps the PoS election onto the registry's module interface; a lost result invalidates the registry output atomically |

- Registry ids equal custody StakingIDs; exposure and key-history digests are bound to the registry's address.
- No proxy, no `delegatecall` upgrade, no admin withdrawal. Only claims move funds out.

---

## PoS: how the committee is elected

- **Weight** = `⌊principal / 100 UCT⌋` per bonded lot. A lot is immutable once bonded.
- **When:** at the cadence, every N rounds **and** T seconds, both must pass.
- **Who:** deterministic greedy selection by weight among eligible identities: registered, bonded ≥ the minimum, EVM key bound, not excluded, not retiring.
- **Churn bounds:** turnover < 1/3, weight distance within the bound and > 2/3 overlap of both committees. If no candidate passes, the incumbents continue.
- **Recovery slate K:** the backed slate contains the exact incumbents. If candidate J fails to acknowledge, the roots can install K.
- **Weighted quorum end to end:** root votes `⌊2W/3⌋+1`, EVM certificates `⌊W/2⌋+1`, and the same arithmetic in the B1 precompiles and the SDKs.
- **Rewards:** RewardPool credits members per committed interval, in proportion to weight, from a funded pool. Nothing is minted.

---

<!-- _class: small -->

## PoS: validator lifecycle (Ethereum-familiar)

| Step | Ethereum analogue | Call | What happens |
|---|---|---|---|
| 1. keys | — | `ubft validator init` | one key per service: root, EVM, ureth devp2p, operator account |
| 2. register | — | `StakeCustody.register(rootKey, pop, withdrawal)` | never-reused `StakingID` = registry id; separate owner/withdrawal and root/EVM roles |
| 3. bind | — | `ElectionPolicy.admitDelegation(...)` | binds the EVM key and operator payee |
| 4. bond | deposit | `StakeCustody.bond(id)` ≥ 100 UCT | an immutable lot that counts from the next election |
| 5. activation | activation | `ubft validator pos-publish --own-proof` | publish the possession proof → handoff and **new UTB entry** → verify the activated root and shard epochs, then enroll the authority |
| 6. rotate | — | `ubft validator rotate` | new node keys or payee, effective at the next boundary |
| 7. exit | voluntary exit | `requestRetirement(id)` | excluded at the next election; leaves at that boundary |
| 8. withdraw | withdraw | `mature` → `claim` | after holds and the evidence window, the principal goes to the withdrawal address |

One `ubft validator apply` run registers the identity and admits the delegation before the first bond (#1323). Members finalize in rank order. The five-member test went from five finalization submissions with four reverts to one submission with zero reverts.

---

## PoS: slashing and parking

**Only one slashing case:** a root key signs two **distinct** votes for the same `(epoch, round)`.
- The penalty is 1% of exposed principal (lifetime cap 5% per lot), with a 10% reporter bounty. It goes to treasury: slashing transfers, never burns.
- The offender is always **excluded** from future elections.
- A slash never edits the active trust base, and progress never depends on removing an offender.

**Parking** lasts `2 × LIFETIME` and leaves the member's stake and rights intact, with no slash.
- An elected non-incumbent that misses its handoff proof is parked after expiry (#1303).
- An incumbent is parked when a quorum of the old committee's root weight certifies its miss (#1319).

**Outside the prototype:** delegated stake, downtime slashing, jailing and a forced-inclusion inbox for evidence. EVM-domain evidence always reverts.

---

## Meta-parameters (dev defaults)

| | testnet | production example |
|---|---|---|
| committee | 4 → 5 (prototype N_max 5; registry ceiling 16) | — |
| bond unit / min bond | 100 UCT | — |
| election cadence | 3,600 rounds **and** 1,800 s | 100,000 rounds and 1 week |
| activation lead | 10 root rounds | 2–1,000 |
| evidence window / holds | 1,000 / 2,000 rounds | |
| UC-time floor before exit | 3,600 s | up to 1 week |
| governance delay | 2,000 rounds and 3,600 s | |
| rewards | 1 UCT / 1,000 rounds | pool 10,000 UCT |

Every parameter change goes through `GovernanceParams`: bounded, prospective, timelocked.

---

## What the Foundation manages

Every action is a **multisig proposal → queued change → public delay → execute**, cancellable while queued, and takes effect at an epoch boundary.

| Area | Change | Under PoS | Under PoA |
|---|---|---|---|
| **Membership** | admit · confirm exit · force-remove | no: stake elects | **yes** |
| **Economics** | bounded PoS parameters, reward pool funding | yes | — |
| **Committee size** | min / target / max members | yes | yes |
| **Fees** | base-fee floor, change rate, fee collector | yes | yes |
| **Partitions** | add a partition · update its parameters | yes | yes |
| **Aggregators** | replace a shard's aggregator set | yes | yes |
| **Upgrades** | schedule a rule activation at a root epoch and time | yes | yes |
| **Mode** | switch the election module · replace the governor | yes | yes |

**Cannot:** move stake, rewards or bridge funds; slash; edit a trust base; skip the delay; or change the chain ID, B1 profile or continuity parameters (those need a new generation). There is no emergency guardian.

Also run by the Foundation at launch: the public gateway, the faucet, the aggregator and the release bundles.

---

<!-- _class: small -->

## PoA: the intermediate mode (a special case of PoS)

Same registry, same handoff, same nodes. Only the **election module** differs: **`PoaElection`** has unit weights, and the Foundation's admission replaces stake.

| | PoS | PoA |
|---|---|---|
| Who decides membership | stake (election) | Foundation multisig: `Admit`, `ConfirmExit`, `ForceRemove` |
| Join | register, delegate, bond in one `apply` | `ubft validator apply` → `Admit` + delay (2,000 rounds and 3,600 s) |
| Exit / withdraw | `requestRetirement` → `mature` → `claim` | `ubft validator exit` → `ConfirmExit`; nothing to withdraw |
| Weights | `⌊principal/100 UCT⌋` | 1 each |

- **States:** None → Applied → Admitted → Joining → Active → ExitRequested → Removing → Leaving → Exited. A parked joiner can retry after `PARK_PERIOD` or with `rejoin`.
- **Election:** records are current, no output is open, the epoch gap has passed and a join, removal, key binding or force-remove is pending.
- **Composition:** PoS churn rules apply. The search tests up to 6 changes (64 trials). A feasible overdue force-remove is mandatory. An equal-weight removal needs at least 5 members.
- **Tooling:** `ubft validator` for operators and `ubft governance` for the offline multisig signers.
- **Measured (2026-11-19):** after admission, the joiner restored from an incumbent archive in 74 s. Handoff installed five members at epoch 2. All 29 checks passed with no operator action after `apply`.
- **Transition to PoS:** one election module switch, <span class="plan">planned as VT-17</span>.

---

<!-- _class: small -->

## Running a validator with Docker

Use a Linux amd64 Docker host with a reachable IPv4 address. Open or forward **TCP 27652** for root P2P and **TCP 29252** for shard P2P. Execution and operator RPCs stay on loopback.

Verify and load the image. Run `ubft-validator init` with your public announce address. Start its `authority` and `run` roles in separate containers sharing one volume. Fund the printed payee with **100 UCT plus gas**.

```sh
docker exec unicity-node ubft-validator join --yes
docker exec unicity-node ubft-validator status
```

- **Public P2P and permissionless handoff.** Each validator submits its own proof. Members finalize and publish in rank order, with later ranks stepping in if needed. Each node verifies activation from its own synced root.
- **Authority loss.** For a bonded PoS identity with a surviving root key, use `ubft-validator recover` (#1286). Confirm the registry binding first. The fresh authority verifies its staking pin against its own execution client before signing the delegation (#1328). [Recovery procedure](https://github.com/ristik/bft-core/blob/integration/enshrined-evm/docs/operations/validator-handbook.md#authority-loss)
- **Operator resources.** The public release provides the image, verified seed and public peer lists. The handbook covers upgrades and retirement. [Demo commands](https://github.com/ristik/unicity-pos-demo/blob/main/demo/add-validator.md)

---

## NB2 v1.1 · UCT ⇄ Unicity token

1. **Deposit** UCT in the immutable vault. The token identity is bound to a wallet secret.
2. **Mint** an ordinary Unicity token whose mint reason embeds the **receipt proof** of the deposit (EVM UC + header + receipt-trie path).
3. **Transfer** as an ordinary token, or **split**. Nothing touches the EVM.
4. **Burn** a whole part, naming the EVM recipient and a segment index.
5. **Redeem** the ordinary route if it fits. An oversized return continues in bounded transactions against the same lineage commitment, advances certified gap proofs and settles with **`redeemRecovered`**. The vault pays directly.

- The receiver verifies **locally** with its held UTB history and B1 checkpoint. When either is too old for a certificate, the wallet refreshes it. Each UTB successor is checked against its predecessor. **Old tokens still verify after validator rotation.**
- No bridge database, indexer or relayer: payments are sealed into segments of K = 64, and the wallet builds its proofs from public logs.
- Before burning, **preflight** prices the ordinary and continuation routes against the release limits and the payer budget. Progress receipts let an interrupted payer resume.

---

<!-- _class: small -->

## Wallet developer manual (summary)

```ts
import { NativeBridgeV2, deriveBridgeKey, HttpJsonRpc, SdkAggregator } from '@unicitylabs/native-bridge-plugin/nb2';

const bridge = await NativeBridgeV2.open({
  pins, trust,                                   // authenticated release and B1 origin, pinned UTB history
  rpc: new HttpJsonRpc(gatewayUrl), aggregator: new SdkAggregator(`${gatewayUrl}/aggregator`),
  journal: store, bridgeKey: deriveBridgeKey(seed), backup, refreshTrust,
});                                              // checks chain ID, the vault's config and code hash

const plan  = await bridge.planDeposit(100n, ownerKey);   await bridge.submitDeposit(plan.intent, evmSigner);
await bridge.collectDepositProof(plan.intent);            const token = await bridge.mint(plan.intent);
const parts = await bridge.split(token, owner, [{ ownerKey, amount: 60n }, { ownerKey, amount: 40n }]);
const r     = await bridge.planReturn(parts[1], evmRecipient, payer, { admission });   // preflight: refuses before burning
await bridge.burn(r.returnId, owner, admission, evmRecipient);  // durable private backup before certification
```

- **Deployment trust:** the operator’s HTTPS download channel supplies the digest-pinned release and moving B1 checkpoint (`/release/nb2-origin.json`, #1283). The wallet verifies chain evidence from JSON-RPC and the aggregator.
- **Crash-safe by design:** every step is journaled (`putIf` compare-and-swap) and resumes after a crash, never repeating an irreversible action. You persist the seed backup, the journal and the tokens. Everything else is rebuilt.
- **Limits:** use the release’s calibrated gas, encoded bytes, fee and history bounds. Use the reference wallet’s packet runner for continuation.
- **Trust across epochs:** SDK 4.0 `TrustBaseHistory`, pinned by the genesis entry ID, verifies any epoch's certificates offline, whoever the stake elected then.
- **Docs:** `docs/nb2-wallet-guide.md` and a reference CLI wallet (`wallet/nb2-wallet.ts`) that CI runs on every lane.

---

<!-- _class: small -->

## Native vs bridging to an external EVM chain

| | Native (enshrined EVM) | External chain (unicity-bridge) |
|---|---|---|
| Who secures the EVM side | the **same stake-elected validators** | a foreign consensus |
| Into Unicity | UC + receipt proof, **instant BFT finality** | wait for source finality (Tron ≈ 1 min, Ethereum ≈ 13 min) |
| Out of Unicity | the EVM **verifies UCs natively** (precompiles + verifier contract) | ZK validity proof, or committee + challenge window |
| Validator rotation | the registry follows every epoch automatically | allow-list update |
| Light client | none needed | RPC re-check / zk instead |
| Relayers | none: the wallet submits | post the proof, fee-gated |

The burn side is final at once on both. The hard part is a weak verifier, and here the verifier is not weak.

---

<!-- _class: small -->

## Tested limits (one server, one operator)

| What | Result |
|---|---|
| **16 / 32 / 64 roots** | all controls pass: progress, rejoin, quorum-minus-one stall, resume (34–38 rounds/min) |
| **128 roots** | Before the resume fix, 4/7 fresh runs passed. Stalling at quorum−1 held in every run. secp256k1 verification used 81–94% of CPU and timeout traffic was O(n²). [#982 closed](https://github.com/ristik/bft-core/issues/982). |
| committee ceiling **16** | the #1215 PoS profile uses ordered seats and retains the exact historical bond lot for each seat |
| PoS election hook (P85) | 5.4 M gas at 16 candidates → 64.6 M at 128 candidates / 32 elected |
| registry election hook | ≈ 10.0 M gas per election inside a 97.9 M system envelope (measured, pinned at generation) |
| UC verification | ≈ 124 k gas/UC after repricing; 16-member, 16-sig UC ≈ 217 k |
| NB2 v1.1 return | ordinary redemption within the calibrated envelope; continuation processes larger lineage and gap proofs in bounded calls |
| round-time tail | 0.28 % of rounds > 1 s (max 1.86 s); leader rescue < 75 s in 12/12 windows |
| long runs | `go test -race` over root consensus: clean. Two flakes found by 100–200× loops; one was a real liveness bug (next slide) |

---

<!-- _class: small -->

## Fixes and improvements on top of upstream

**Correctness and liveness**
- **Root consensus permanent stall:** `ProcessTc` deleted a block that a late QC still certified. Fixed and **merged upstream** (bft-core#27).
- **Silent leader (fixed in the pinned build):** a leader that entered its round through a timeout certificate carried by another root's vote never proposed. At exact quorum on lossy links there was no QC for 120 s (#1194, fix #1210).
- Recovery bound to the committed root, configuration and last responses. Merged upstream: bft-core#48/#50/#51/#46, bft-go-base#19.
- Fork-only, upstream has the same code path: bare-QC recovery (#660), no second timeout vote after recovery (#583), restart after a TC (#578), monotonic UC seal time (#447/#479), re-send lost certification requests (#666, #1193).
- EVM shard: 3-of-4 livelock (#728); crash recovery from the archive (#843); paged rejoin (#769); a production race (#1191).

**Performance and robustness**
- Verified QC/TC cache: 78–99 % hit rate at 128 roots (#992). Timeout replay cache, 10–40× (#984).
- UC consolidation made asymptotically cheaper in Go, the aggregator and the SDKs. Merged upstream.
- Aggregator intake: admitted root peers only, authenticate before liveness, bounded catch-up; 503 + Retry-After. Merged upstream.

**Protocol and format:** Trust Base v2 (merged upstream 2026-11-09 to 11-11), UC consolidation, non-inclusion proofs, strict recoverable secp256k1.

| Upstream PRs | bft-core 22 · bft-go-base 11 · aggregator-go 78 · sdk-js 52 · sdk-rust 51 · sdk-java 15 |
|---|---|

---

<!-- _class: small -->

## Maturity: where we are, and what's left

| Area | Merged or demonstrated | Next | Later |
|---|---|---|---|
| **PoS** | public VR/P85 (#1215). Fifth validator joined, exited and reclaimed its bond | — | production economics and audit |
| **Registry & handoff** | backed recovery slate K (#1221). PoS and PoA recovery proven (#1226) | — | live PoA → PoS switch on one network (VT-17) |
| **PoA (intermediate)** | PoaElection, multisig, `validator apply/exit/rejoin/rotate` | — | — |
| **Live config & upgrades** | VR schedules forks (ureth #114, #115). Prague gate closed before activation (#1325) | — | partition retirement (VT-18) |
| **Operator tooling** | verified seed. Signing authority checks its staking pin against its own execution client (#1222) | — | recoverable key custody |
| **NB2 v1.1** | the HTTPS release selects the public UCT deployment and serves its moving B1 checkpoint (#1283) | real-value qualification in progress. T7 (#1269) and ERC20 (#1038) drafts in review | UTB-verifiable release binding (#1282), mint format (#1257) |
| **Consensus** | weighted quorum, historical trust, silent-leader and slot fixes (#1210, #1212). #982 closed | — | — |

**Not yet:** independent audit · evidence from more than one server and operator · a decentralized aggregator (central at launch) · migrations (a testnet reset is a new network).

---

<!-- _class: lead -->

# Demo 1: assets

faucet → deposit → mint → split → verify transfer offline in tab B → burn → redeem

The wallet prefills the payer policy and offers a backup download in Firefox. Redeem uses public RPC with raised rate limits and requires no archive.

Continuation UI shows certified progress, gap advances and final payment when the claim needs them.

---

<!-- _class: lead -->

# Demo 2: PoS

One `ubft validator apply` run admits the delegation before the 100 UCT bond.

On the public testnet, the fifth validator synced from the epoch-1 seed across two root handoffs and entered the committee at the next stake election. It later exited and reclaimed its bond.

The old committee signs the new UTB entry. Show a verified EVM UC carrying the fifth root’s signature.

Equal weights give **f = 1** in either committee: **n ≥ 3f + 1**. The root quorum rises **3 → 4**. Two Byzantine faults require seven validators.

---

<!-- _paginate: false -->

# Questions

`github.com/ristik/unicity-pos-demo` · bridge guide: `github.com/ristik/native-bridge-plugins/blob/main/docs/nb2-wallet-guide.md`
