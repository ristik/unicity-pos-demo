---
marp: true
theme: default
paginate: true
title: Unicity PoS staging: the stack and a live demo
style: |
  section { font-size: 24px; }
  section.small { font-size: 19px; }
  table { font-size: 0.85em; }
  code { font-size: 0.9em; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2em; }
---

<!-- _paginate: false -->

# Unicity PoS staging

### Enshrined EVM · proof of stake · native bridge · trust-base history

Live demo on `pos.staging.unicity.network`

<!-- Speaker: 45 min. About 15 min of slides, about 20 min demo, 10 min Q&A. -->

---

## What we'll show

1. **The setup**: what runs on the staging network, its endpoints and repos.
2. **Assets demo**: UCT from the faucet → bridged to a Unicity token → sent to a second wallet (another tab) → bridged back.
3. **PoS demo**: committee, stakes and quorum, live. This laptop **is validator 5** (joined this morning); an old-epoch token **still verifies**, a forged one is rejected.
4. **How it works underneath**: contracts, logical validator, bridge vs bridging to an external chain.

Everything in the demo runs in a browser: no install, a burner key, public endpoints only.

---

<!-- _class: lead -->

# Background

the stack · contracts · bridge · tested limits · what we fixed upstream

---

## The stack in one picture

```
            ┌──────────── one validator organization ────────────┐
            │  root node ── BFT consensus, epochs, handoffs      │
            │  shard node ─ certifies EVM blocks (partition 8)   │
  ×4        │  authority ── signing keys                         │
            │  ureth ────── EVM execution (reth v2.5 fork)       │
            └────────────────────────────────────────────────────┘
                         │ unicity certificates (UC)
   aggregator-go (partition 7, SMT) ── token state certification
   SDKs (JS / Rust / Java 4.0) ── self-contained tokens + UTB history
```

- One security principal per validator: root key and EVM key are different keys bound to one identity.
- No separate settlement chain. Certification means "the honest majority executed this" (no ZK).

---

## Key terms

- **Unicity certificate (UC)**: the root's proof that a shard state was certified. Input record → shard tree → unicity tree → **seal** signed by the root committee. Valid when the signers reach `⌊2W/3⌋+1` of **the seal's own epoch's** committee, with at most 16 signatures.
- **Epoch**: a period with one fixed committee (members, keys, weights). It changes only through the ordered **handoff**: Intent → Prepare → Endorse → Commit → Activate → Acknowledge.
- **UTB (trust-base history)**: an append-only chain of signed root trust-base entries, one per epoch. Each entry is signed by its **predecessor's** quorum. The genesis entry ID is the network's trust pin.
  → *Tokens stay verifiable across validator rotations.*

---

## Staging network

<div class="cols">
<div>

| | |
|---|---|
| Host | 1 bare-metal server, 12 cores |
| Validators | 5, weight 1 each (4 on the host + this laptop) |
| Chain ID | `5587796` = `0x554354` = "UCT" |
| Elections | every 3,600 rounds **and** 1,800 s (≈30 min) |
| Bond unit / min bond | 100 UCT |
| Containers | 31 |

</div>
<div>

| Endpoint | |
|---|---|
| `POST /rpc` | EVM JSON-RPC (allow-listed) |
| `POST /aggregator` | aggregator JSON-RPC |
| `GET /api/v1/trustbases` | UTB history (CBOR) |
| `/faucet/` | hCaptcha faucet |
| `/demo/` | this demo |

</div>
</div>

Not public: root/shard admin, authority, Engine API, Prometheus.

---

<!-- _class: small -->

## Repos

| Repo | Role | Branch |
|---|---|---|
| `ristik/bft-core` | root chain, shard nodes, Engine API adapter, epochs, UTB, testnet package | `integration/enshrined-evm` |
| `ristik/ureth` | EVM execution: reth fork + system prefix, SealRegistry kernel, precompiles | `unicity/main` |
| `ristik/unicity-pos-contracts` | SealRegistry, P85 PoS modules, BridgeVault, WUCT, FeeCollector, vesting | `main` |
| `ristik/native-bridge-plugins` | bridge protocol v7, corpus, TS + Rust plug-ins on public SDK APIs | `main` |
| `ristik/aggregator-go` | aggregator + UTB history + uc-consolidation | `integration/enshrined-evm` |
| `ristik/state-transition-sdk-{js,rust,java}` | SDK 4.0: `RootTrustBaseV2`, `TrustBaseHistory` | `integration/enshrined-evm` |
| `ristik/bft-go-base` | shared Go types, trust-base codecs | `integration/enshrined-evm` |
| `ristik/unicity-pos-demo` | this wallet, visualizer and slides | `main` |

Forks keep `main` as the upstream-sync branch. UTB v2 is merged upstream: bft-go-base#20 (2026-11-09); aggregator-go#273, sdk-js#206, sdk-rust#73, sdk-java#101 (2026-11-11); unicity-ids#11 (2026-11-09).

---

## API surface the demo uses

| Step | Call |
|---|---|
| fund | faucet `POST /api/claim` {address, hCaptcha token}; `GET /api/network` |
| EVM reads/writes | `/rpc`: `eth_call`, `eth_estimateGas`, `eth_sendRawTransaction`, `eth_getTransactionReceipt`, `eth_getTransactionCount`, `eth_gasPrice`, `eth_getBalance`, `eth_getBlockByNumber`, `eth_getCode` |
| lock | `BridgeVault.lock(bytes)` |
| lock proof | `GET /lockproof/v1/lockproof?block=&nonce=` (EVM UC + header + MPT proof; built server-side) |
| mint / transfer / burn | aggregator `submitCertificationRequest`, `getInclusionProof` |
| trust | `getTrustBasePage` → local `TrustBaseHistory`, refreshed on `ErrNoEntryForEpoch` |
| return proof | aggregator consolidation: the burned token's proofs under **one** seal |
| redeem / claim | `BridgeVault.redeem(bytes)` → precompile `0x0105`; then `claim(uint256,address)` |
| PoS view | `eth_call` views only: `StakeCustody`, `ElectionPolicy`, `SealRegistry` record log |

The public `/rpc` is allow-listed: no `eth_getLogs`, no `eth_getProof`, no batches. The visualizer rebuilds history from the registry record log.

---

## Inside ureth: every block starts with a protocol prefix

1. registry `open` → 2. registry `finalize` → 3. EIP-4788 hook → 4. control-record import → 5. PoS hooks (reconcile, governance, **election**) → 6. user transactions

- Prefix failure ⇒ invalid block. System gas is reserved, not charged.
- **SealRegistry** `0xff00…02`: contract-visible root authority, **any-age** (every epoch's committee kept forever).
- Precompiles:
  - `0x0100` UC batch check (1..16 claims)
  - `0x0102` aggregator SMT membership
  - `0x0104` bridge token-history kernel
  - `0x0105` composed bridge redemption

---

## PoS contracts (P85)

| Contract | Role |
|---|---|
| **StakeCustody** | identities, roles, bond **lots**, key history, exposures, maturity, claims |
| **ElectionPolicy** | live index, EVM-key binding, election, candidate J + recovery K, PoPs |
| **Evidence** | objective double-sign evidence, holds, capped penalties |
| **GovernanceParams** | bounded, prospective parameter changes with a timelock |
| **RewardPool** | separately funded operator rewards (no minting) |
| **PosFactory** | atomic, manifest-pinned deployment, then sealed |

No proxy, no `delegatecall` upgrade, no admin withdrawal, no `setModule`. Only claims move funds out.

---

## PoS: implemented

- **Register** with root-key possession → never-reused `StakingID`; separate owner/withdrawal and root/EVM roles.
- **Bond** native UCT → immutable lot; weight = `⌊principal / 100 UCT⌋`.
- **Elections** at the cadence: deterministic greedy selection by weight, bounded by churn rules (turnover < 1/3, weight distance, > 2/3 overlap). If no candidate passes, the incumbents continue.
- **Recovery slate K**: the exact incumbents always ship with candidate J; if J can't acknowledge, K is installed.
- **Weighted quorum** end to end (root, shards, B1 precompiles).
- **Retirement** by generation → holds and evidence window → `mature` → `claim`.
- Rewards, vesting vault, fee collector, governance.

---

## PoS: not implemented, and slashing

**Not implemented:**
- delegated stake;
- downtime or absence slashing;
- jailing;
- a forced-inclusion inbox for evidence;
- EVM-domain evidence (it always reverts).

**The one slashable offence:** a root key signs two **distinct** votes for the same `(epoch, round)`.
- Penalty 1% of exposed principal (lifetime cap 5% per lot); 10% reporter bounty.
- The penalty goes to treasury. Slashing transfers, never burns.
- Always: permanent **exclusion** from future elections.
- A slash never edits the active trust base. Progress never depends on removing an offender.

Not offences: duplicate or re-encoded statements, different rounds, absence from signer sets.

---

## Meta-parameters (dev defaults)

| | staging | production example |
|---|---|---|
| committee | 5 (N_max 6, ceiling 16) | — |
| election cadence | 3,600 rounds **and** 1,800 s | 100,000 rounds and 1 week |
| activation lead | 10 root rounds | 2–1,000 |
| evidence window / holds | 1,000 / 2,000 rounds | |
| UC-time floor before exit | 3,600 s | up to 1 week |
| governance delay | 2,000 rounds and 3,600 s | |
| rewards | 1 UCT / 1,000 rounds | pool 10,000 UCT |

---

## A logical validator, and how it joins

```
laptop (colima, pod5)                       staging host
 root5 · shard5 · authority5 · ureth5
   peer stubs root1-4 / shard1-4 / ureth1-4 ─ssh -L─▶ root1-4:8000, shard1-4:9000, ureth1-4:8545
   root5:8000, shard5:9000, agent :28700   ◀─ssh -R─  laptop-relay container (validators net)
```
One `ssh -N`, no listener on the host (`GatewayPorts no` stays). Peer ports are libp2p, authenticated by peer id.

1. Generate keys: root key, signing keys, EVM key.
2. `StakeCustody.register(rootKey, pop, withdrawal)`
3. `StakeCustody.bond(id)` with ≥ 100 UCT
4. `ElectionPolicy.admitDelegation(...)` binds the EVM key and operator payee (not stake delegation)
5. Next election → `submitAssignmentPoPs` → handoff → **new UTB entry**
6. Leave: `requestRetirement(id)` → excluded at the next election → `mature` → `claim`

Keys stay in the laptop's memory: sleep the laptop or restart colima and that validator is gone.

Measured (2026-11-13): register + bond + prepare **24 s** → wait for the election (≤ 30 min) → root signs **~2 min** later → shard signs after a full restore (**~14 min** at 2.6k blocks: archive fetch plus replay, grows with chain length). Retirement (rehearsed on the previous generation): request → excluded at the next election → the handoff back to 4 itself takes **~3 min**; the wait for the election is up to one cadence (30 min here). A remote member over the tunnel costs ~5–10 % throughput.

---

## Native bridge: UCT ⇄ Unicity token

1. **Lock** UCT in the immutable BridgeVault.
2. **Mint** a token whose mint reason **embeds the full lock proof**: EVM UC + header + MPT proof of the vault slot.
3. **Transfer** as an ordinary token, or split.
4. **Burn** naming the EVM recipient.
5. **Redeem**: anyone submits the history + UCs. `0x0105` verifies it natively and the vault credits the recipient.
6. **Claim**: pull payment. Invariant `paid ≤ credited ≤ locked`.

The receiver verifies **locally**: the token + its UTB history. No EVM RPC; the only fetch is newer trust-base entries, each checked against its predecessor.

---

<!-- _class: small -->

## Native vs bridging to an external EVM chain

| | Native (enshrined EVM) | External chain (unicity-bridge) |
|---|---|---|
| Who secures the EVM side | the **same validators** | a foreign consensus |
| Into Unicity | UC + MPT proof, **instant BFT finality** | wait for source finality (Tron ≈ 1 min, Ethereum ≈ 13 min) |
| Out of Unicity | EVM **verifies UCs natively** (precompiles) | ZK validity proof, or committee + challenge window |
| Validator rotation | registry follows every epoch automatically | allow-list update |
| Light client | none needed | RPC re-check / zk instead |
| Relayers | optional, permissionless, no authority | post the proof, fee-gated |

The burn side is final at once on both. The hard part is a weak verifier, and here the verifier is not weak.

---

<!-- _class: small -->

## Tested limits (one server, one operator)

| What | Result |
|---|---|
| **16 / 32 / 64 roots** | all controls pass: progress, rejoin, quorum-minus-one stall, resume (34–38 rounds/min) |
| **128 roots** | "can pass, not reliably": all controls passed in 4/7 fresh runs. The stall at quorum−1 always holds; **resume** after quorum returns is what fails (#982 open). Load average up to 159 on 12 cores |
| where the CPU goes at 128 | 81–94 % secp256k1 verification. Timeout messages are 83–85 % of loop time and O(n²): 16,256 sends per round. Caches #984/#992 cut per-message cost 10–40×, but storms remain |
| committee ceiling **16** | a gas/pricing ceiling (precompiles, registry), not consensus: native bounds are 256. The PoS package caps elected members at 6 |
| election hook gas | 5.4 M at 16 candidates → 64.6 M at 128 candidates / 32 elected (52 % of system gas) |
| UC verification | ≈1.275 M gas/UC before repricing → **≈124 k** after; 16-member, 16-sig UC ≈217 k |
| bridge redemption | 1,000 leaves: 1.45 MB, 48 M gas, 389 ms native → 60 M block capacity, 2 MiB envelope |
| round-time tail | 0.28 % of rounds > 1 s (max 1.86 s), planning envelope ρ = 2.3 s; leader rescue < 75 s in 12/12 windows |
| archive growth | ≈6.4 KiB per EVM block |

Not covered yet: WAN, a second operator, live unequal weights, sustained load, multi-host.

---

## A limit we found this week: staging stall

- `tn-pos-staging-20261111` ran **≈20 h**, then stopped at EVM block 42,832.
- **Memory:** each 512 MiB shard container filled with ≈490 MiB of kernel inode/dentry cache from the archive's **one-directory-per-block** layout (471 k files per validator). The shards swapped, block rate fell from 2,800/h to 340/h, and one validator dropped out.
- **Wedge:** with 3 of 4 left, every failed round journaled another candidate at the same height. At the cap of 32, every proposal was refused, permanently.
- **Fixes:**
  - sizing 2 GiB / 1.5 CPU / 256 (#1020);
  - evict superseded same-height candidates (#1019);
  - pack the archive layout.

Lesson: the roots and aggregator stayed healthy the whole time. The weak spot was resource sizing at the EVM shard.

---

## And one more, last night: roots throttled as epochs grew

- The previous generation `tn-pos-staging-20261113`, with a handoff every ~8 min, slowed **0.62 → 0.15 blocks/s** in 5.5 h (epochs 1 → 34).
- **Roots were capped at 0.5 CPU** and throttled 34 % of the time. Root work per certification request grows with the epoch count. Leading suspect from code reading (not yet measured): the request history is rebuilt from genesis on each request (#1032).
- Slow roots dropped shard requests that arrived one round "early" (`expected round N, got N+1`), and 26 % of shard rounds timed out.
- **Live fix:** `docker update --cpus 2` with no restart → 0.46 blocks/s. **Package fix:** `--root-cpus` (#1031). **Mitigation:** 30-min elections. **Code fix:** cache the history (#1032, open).

Lesson: per-epoch costs only show up after many epochs; soak with a fast cadence.

---

<!-- _class: small -->

## Fixes and improvements on top of upstream (not PoS)

**Correctness and liveness**
- **Root consensus permanent stall:** `ProcessTc` deleted a block that a late QC still certified. Fixed and **merged upstream** (bft-core#27, issue #25).
- Recovery bound to the committed root, configuration and last responses; null-safe `StateMsg`. Merged upstream: bft-core#48/#50/#51/#46, bft-go-base#19.
- Fork-only, upstream has the same code path:
  - bare-QC recovery targets the certified block (#660, upstream issue #52);
  - no second timeout vote after recovery (#583);
  - restart after a TC or an abandoned fork (#578);
  - monotonic UC seal time (#447/#479);
  - re-send lost certification requests (#666).
- EVM shard: 3-of-4 livelock (#728); crash recovery from the archive (#843); paged rejoin (#769).

**Performance**
- Verified QC/TC cache: 78–99 % hit rate at 128 roots (#992). Timeout replay cache, 10–40× (#984).
- UC-consolidation work made asymptotically cheaper in Go, the aggregator and the SDKs. Merged upstream: bft-go-base#9, bft-core#33, aggregator-go#208, sdk-js/rust.
- Journal load memo: whole-journal re-verification no longer repeats about 5 times a second (#749).

---

<!-- _class: small -->

## Fixes and improvements on top of upstream (cont.)

**Robustness and operability**
- Aggregator certification intake: admitted root peers only, authenticate before liveness, bounded catch-up. Merged upstream (aggregator-go#246/#249).
- Aggregator/SDK: 503 + Retry-After, long-poll proof reads, request timeouts, high-S rejected. Merged upstream.
- Bounded resources: frame limits, archive fsync and stream caps (#953/#993/#957). Peer admission (upstream bft-core#42, open).
- Diagnostics: consensus-loop profile, resource collector, pending-work view.

**Protocol and format, of general use**
- **Trust Base v2**: signed trust-base history with weighted quorum; `/api/v1/trustbases`; SDK 4.0 in JS/Rust/Java. **Merged upstream 2026-11-09 to 11-11** (bft-go-base#20; aggregator-go#273, sdk-js#206, sdk-rust#73, sdk-java#101).
- **UC consolidation** and **non-inclusion proofs**, across all repos. Merged upstream.
- Strict recoverable secp256k1 verification (recovery ID bound to the key) in Go and all SDKs.
- Native bounds raised to 256 members / 256 signatures. Roots re-verify RSMT consistency before voting (#547).

**Upstream PRs by this effort:**

| bft-core | bft-go-base | aggregator-go | sdk-js | sdk-rust | sdk-java |
|---|---|---|---|---|---|
| 22 | 11 | 78 | 52 | 51 | 15 |

---

<!-- _class: lead -->

# Demo 1: assets

faucet → lock → mint → send to tab B → burn → redeem → claim

---

<!-- _class: lead -->

# Demo 2: PoS

committee & quorum · laptop is validator 5 · old token still verifies · forged certificate rejected

---

## Status and caveats

- Pre-production. The P85 design is still "proposed for owner acceptance"; no independent reviewer has been named yet.
- All host evidence comes from one server and one operator.
- Bridge profile: `development-provisional-unactivated`.
- The aggregator is centrally operated at launch (no consistency proofs).
- Testnet resets mean new networks: one wire format, no migrations.

---

<!-- _paginate: false -->

# Questions

`github.com/ristik/unicity-pos-demo` · `https://pos.staging.unicity.network/demo/`
