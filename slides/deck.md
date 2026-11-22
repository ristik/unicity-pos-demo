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

Demo for public testnet `tn-public-20261122`

<!-- Speaker: 45 min. About 15 min of slides, about 20 min demo, 10 min Q&A.
Status words: "done" = merged and run live on the dev server; "planned" = the target for the end of this iteration.
Check the release and rehearsal status before presenting the live flow. -->

---

## What we'll show

1. **The setup**: what runs on the testnet, its endpoints and repos.
2. **Assets demo** (NB2 v1.1): UCT from the faucet → **deposit** → mint a Unicity token → split → send to a second wallet (another tab) → **burn** → **redeem** on the EVM.
3. **PoS demo**: the committee, stakes and quorum, live. A new validator **registers and bonds**, the next election **selects it by stake**, the operator **publishes its proof** and enrolls its authority after the handoff. An old-epoch token **still verifies**; a forged one is rejected.
4. **How it works underneath**: elections, slashing, governance, the bridge. Then PoA, the intermediate mode, and what's still left to do.

Everything in the assets demo runs in a browser: no install, a burner key, public endpoints only.

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
| Generation | `tn-public-20261122` · PoS on ValidatorRegistry |
| Validators | **4 at genesis**, then a live fifth join. Ordered-seat PoS profile supports up to **16**. |
| Weight | `⌊bonded principal / 100 UCT⌋` |
| Elections | the boundary requires both round and UC time thresholds |
| Governance | FoundationMultisig 3-of-5, delay 2,000 rounds **and** 3,600 s |
| EVM block interval | target ≈ 10 s (configurable, delay-only) |
| Reference hardware | 6c/12t, 64 GB, 2 × 1 TB NVMe |

</div>
<div>

| Endpoint | |
|---|---|
| `POST /rpc` | EVM JSON-RPC (allow-listed) |
| `POST /aggregator` | aggregator JSON-RPC |
| `GET /api/v1/trustbases` | UTB history (CBOR) |
| `/faucet/` | hCaptcha faucet |
| `/demo/`, `/demo/pos.html` | wallet, PoS visualizer |
| `/release/` | NB2 v1.1 manifest, trust-base bundle and genesis EntryID |

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
- **Churn bounds**, judged against the incumbents:
  - turnover < 1/3;
  - weight distance within the bound;
  - more than 2/3 overlap of both committees.

  If no candidate passes, the incumbents continue.
- **Recovery slate K:** the exact incumbents always ship with candidate J. If J can't acknowledge, K is installed, so an election can never strand the network.
- **Weighted quorum end to end:** root votes `⌊2W/3⌋+1`, EVM certificates `⌊W/2⌋+1`, and the same arithmetic in the B1 precompiles and the SDKs.
- **Rewards:** RewardPool credits members per committed interval, in proportion to weight, from a funded pool. Nothing is minted.

---

<!-- _class: small -->

## PoS: validator lifecycle (Ethereum-familiar)

| Step | Ethereum analogue | Call | What happens |
|---|---|---|---|
| 1. keys | — | `ubft validator init` | one key per service: root, EVM, ureth devp2p, operator account |
| 2. register | — | `StakeCustody.register(rootKey, pop, withdrawal)` | never-reused `StakingID` = registry id; separate owner/withdrawal and root/EVM roles |
| 3. bond | deposit | `StakeCustody.bond(id)` ≥ 100 UCT | an immutable lot; weight counts from the next election |
| 4. bind | — | `ElectionPolicy.admitDelegation(...)` | binds the EVM key and operator payee (not stake delegation) |
| 5. activation | activation | `ubft validator pos-publish --own-proof` | publish the possession proof → handoff and **new UTB entry** → verify the activated root and shard epochs, then enroll the authority |
| 6. rotate | — | `ubft validator rotate` | new node keys or payee, effective at the next boundary |
| 7. exit | voluntary exit | `requestRetirement(id)` | excluded at the next election; leaves at that boundary |
| 8. withdraw | withdraw | `mature` → `claim` | after holds and the evidence window, the principal goes to the withdrawal address |

The node does steps 5 and 8's waiting on its own: no operator action between bonding and joining. <span class="plan">`ubft validator` verbs for steps 2–4 and 7–8 are planned alongside the PoS module (VT-04); today they are contract calls.</span>

---

## PoS: slashing, and what's not implemented

**Only one slashing case:** a root key signs two **distinct** votes for the same `(epoch, round)`.
- The penalty is 1% of exposed principal (lifetime cap 5% per lot), with a 10% reporter bounty. It goes to treasury: slashing transfers, never burns.
- The offender is always **excluded** from future elections.
- A slash never edits the active trust base, and progress never depends on removing an offender.

No slashing for duplicate or re-encoded statements, different rounds, or absence from signer sets.

**Not implemented (prototype economics):**
- delegated stake;
- downtime or absence slashing;
- jailing;
- a forced-inclusion inbox for evidence;
- EVM-domain evidence (it always reverts).

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
| Join | register + bond + bind | `ubft validator apply` → `Admit` + delay (2,000 rounds and 3,600 s) |
| Exit / withdraw | `requestRetirement` → `mature` → `claim` | `ubft validator exit` → `ConfirmExit`; nothing to withdraw |
| Weights | `⌊principal/100 UCT⌋` | 1 each |

- **States:** None → Applied → Admitted → Joining → Active → ExitRequested → Removing → Leaving → Exited. **Parked** is a non-punitive retry for a joiner that wasn't ready: it returns after `PARK_PERIOD` or on `rejoin`.
- **When an election is due:** the records are caught up, no output is open, the minimum epoch gap has passed, and there is work: a joiner, a removal, a staged key binding or a force-remove.
- **Composition:** a bounded deterministic search over at most 6 changes (64 trials) under the same churn rules as PoS: turnover < 1/3, distance bound, > 2/3 overlap. An overdue, feasible force-remove is mandatory. With equal weights a pure removal needs N ≥ 5, so the operational default is N ≥ 5.
- **Tooling:** `ubft validator init / doctor / apply / status / rotate / exit / rejoin`; `ubft governance propose / sign / aggregate / execute / list` for the multisig signers (offline signing).
- **Measured (2026-11-19):** a joiner applied → admitted after both delays → its shard node restored from an incumbent's archive in 74 s → every root derived the same intent → handoff → epoch 2 with committee `[1, 2, 3, 4, 5]`. 29/29 checks; no operator action after `apply`.
- **Why it exists:** it gives a governed launch and testnet while PoS economics mature. Moving a live PoA network to PoS is one pointer switch, <span class="plan">planned as VT-17</span>.

---

<!-- _class: small -->

## Sysadmin manual (summary): running a validator

**You need:** a reference-class server (6c/12t, 64 GB, 2 × 1 TB NVMe), ports 8000 (root p2p), 9000 (shard p2p) and 30303 (ureth devp2p) open, an EVM account with UCT for gas, and at least 100 UCT to bond.

```sh
ubft validator init   --rpc https://<gateway>/rpc --payee 0xYourPayee   # one key per service, writes validator.json
ubft validator doctor                     # hardware, ports, clock, disk, keys, RPC reachability
# start root node, shard node, signing authority, ureth (the testnet package's compose files)
# use the handbook to import the seed, start followers and prepare the authority
ubft validator apply --dry-run
ubft validator apply                      # register, bond and bind
# install the PoS authority policy for the assigned ID; wait for election to reserve the result
ubft validator pos-publish --own-proof
ubft validator status
```

- **At the boundary:** watch the verified handoff and read the activated root and shard epochs. Enroll the authority for those epochs using the handbook. Public join timing awaits the rehearsal measurement.
- **Keys** stay on your machine, one per service. The signing authority holds the EVM key and signs only typed operations its policy allows. Its keys are in memory, so **a restart means a key rotation** (`ubft validator rotate`).
- **Leaving:** `requestRetirement` → excluded at the next election → after holds and the evidence window, `mature` → `claim` to the withdrawal address.
- **Upgrades** are scheduled on chain (`ScheduleActivation`): <span class="plan">`status` and the `unicity_upgrade_required` metric will say when to install a release (VT-07, VT-12, planned).</span>
- <span class="plan">Planned:</span> a public sync seed (VT-11), monitoring and alerts (VT-12), and the full handbook with a dress rehearsal (VT-13).

---

## NB2 v1.1 · UCT ⇄ Unicity token

1. **Deposit** UCT in the immutable vault. The token identity is bound to a wallet secret.
2. **Mint** an ordinary Unicity token whose mint reason embeds the **receipt proof** of the deposit (EVM UC + header + receipt-trie path).
3. **Transfer** as an ordinary token, or **split**. Nothing touches the EVM.
4. **Burn** a whole part, naming the EVM recipient and a segment index.
5. **Redeem** the ordinary route if it fits. An oversized return continues in bounded transactions against the same lineage commitment, advances certified gap proofs and settles with **`redeemRecovered`**. The vault pays directly.

- The receiver verifies **locally**: the token plus its UTB history. The only fetch is newer trust-base entries, each checked against its predecessor. **Validator rotations under PoS don't break old tokens.**
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

- **Plain endpoints:** the public JSON-RPC and the aggregator. Nothing a provider returns is trusted; it can only delay you.
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
| **128 roots** | "can pass, not reliably": 4/7 fresh runs. The stall at quorum−1 always holds; **resume** is what fails (#982 open). 81–94 % of CPU is secp256k1 verification; timeout traffic is O(n²) |
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

| Area | Done (merged, run live) | End of this iteration (planned) | Later |
|---|---|---|---|
| **PoS** | P85 lifecycle and #1215 ordered-seat custody up to 16 | package VR/P85 and rehearse the fifth join | production economics: delegation, downtime slashing, jailing; audit |
| **Registry & handoff** | VR, governance CLI, registry admission, handoff (roots + nodes), operator enrollment | — | live PoA → PoS switch on one network (VT-17) |
| **PoA (intermediate)** | PoaElection, multisig, `validator apply/exit/rejoin/rotate` | — | retired once PoS is live |
| **Live config & upgrades** | aggregator set, committee limits, add/update partition, execution revision in the identity | fee parameters (VT-06c); activation schedule in roots + ureth (VT-07a/b) | partition retirement (VT-18) |
| **Operator tooling** | `init/doctor/status`, authority-held keys, ureth key persistence | sync seed (VT-11), monitoring + alerts (VT-12), handbook + dress rehearsal (VT-13) | recoverable key custody (an authority restart is a rotation today) |
| **NB2 v1.1** | lineage commitments, certified continuation, and `redeemRecovered` (#1108) | publish the qualified v1.1 deployment | mint format follow-up (#1257) |
| **Consensus** | weighted quorum, any-age trust, silent-leader fix (#1210) | — | durable per-round proposal record, needed before real stake (#1212); 128-root resume (#982) |

**Not yet:** independent audit · evidence from more than one server and operator · a decentralized aggregator (central at launch) · migrations (a testnet reset is a new network).

---

<!-- _class: lead -->

# Demo 1: assets

faucet → deposit → mint → split → verify transfer offline in tab B → burn → redeem

Continuation UI shows certified progress, gap advances and final payment when the claim needs them.

---

<!-- _class: lead -->

# Demo 2: PoS

100 UCT bond → next boundary → 4 → 5 validators

The old committee signs the new UTB entry. Find the first verified EVM UC signed by the fifth root. Public join timing awaits rehearsal.

Equal weights give **f = 1** in either committee: **n ≥ 3f + 1**. The root quorum rises **3 → 4**. Two Byzantine faults require seven validators.

---

<!-- _paginate: false -->

# Questions

`github.com/ristik/unicity-pos-demo` · bridge guide: `github.com/ristik/native-bridge-plugins/blob/main/docs/nb2-wallet-guide.md`
