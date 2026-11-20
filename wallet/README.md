# Demo wallet

A minimal in-browser wallet for the Unicity demo: Vite + TypeScript, no framework, plain DOM. It is built to a static bundle served at
`/demo/` on the network's own origin, so `/rpc`, `/aggregator`, `/api/...` and `/nb2/` are same-origin and need no CORS.

## What it does

- **One burner key** (`src/keys.ts`): a secp256k1 key in localStorage. It is the EVM account and also the Unicity owner (a SignaturePredicate of the
  same key). It exports as 24 BIP-39 words or as 0x hex. The words are the key itself, taken as the mnemonic's entropy with no derivation path, so
  they are not a MetaMask seed. The bridge key k_w and each deposit's secret derive from it, so the export also shows the **deposit intent
  high-water mark**: keep that number with the key (a restored wallet finds its deposits with it; a lost secret is a lost deposit).
- **Faucet** (`src/faucet.ts`): fetches the hCaptcha site key from `GET /api/network`, renders the widget explicitly, then sends
  `POST /api/claim` with the `h-captcha-response` header and polls the receipt.
- **Asset flow on native bridge v2** (`src/nb2.ts`, ported from native-bridge-plugins `wallet/core.ts`, following its `docs/nb2-wallet-guide.md`):
  deposit → mint → split → transfer to tab B → burn → redeem. There is no lock proof and no claim: the vault pays the redeem's recipient directly.
  Each step on the page has an *explain* drawer. It shows the requests the step made (method, path, status, sizes, timings, and the last few raw
  bodies) and the bridge's own facts: the deposit number, the receipt proof J's size, the burn index `a`, the number of gap proofs in the witness, the
  preflight gas against `userGasLimit`, and the redemption ID.
  - **Deposit:** plan an intent (the secret is derived), journal it, hand the intent high-water mark to the backup, and only then send
    `deposit(firstOwner, rho)` with the value. A rerun reconciles the earlier send; it never deposits twice.
  - **Mint:** the deposit block's certificate is served once the block has a child (`CompanionUnknown` until then; the step waits). The wallet builds
    the receipt proof J from the block's receipts, checks it offline, and mints an ordinary token with J as its reason.
  - **Split:** a bridge token returns whole, so to return part of it split it into two parts first (the part to return, and the rest).
  - **Plan return (preflight):** verifies the part's whole provenance, takes `a` from the newest verified `SegmentSealed` receipt, and checks that the
    complete future redemption fits the transaction-size limit and `userGasLimit` with the reserve and that this key can pay the worst-case gas.
    Nothing is burned. *Burn* runs the preflight again on fresh state first.
  - **Redeem:** reads one `SegmentSealed` log per segment since `a`, builds the gap proofs, simulates, signs and sends, and waits for the payment's
    block to be certified. Right after a burn the verifier can answer `QuorumNotMet` until the EVM chain's seal registry has imported the burn's root
    round (bft-core#1125); the step waits up to 2 minutes and builds again (nothing is sent meanwhile).
- **Two-tab handoff** (`src/handoff.ts`): *open tab B* opens `?w=b`, a second wallet with its own key and storage. The two tabs find each other over a
  BroadcastChannel. The sender transfers the token to the other tab's key, stores the token as *sent*, and posts the token file; *Resend*
  posts it again if the other tab was closed or missed it. The receiver stores the file the moment it arrives (as *received, not verified*),
  then verifies it offline (`bridge.verifyToken`: the receipt-backed origin, the lineage and every certificate under the held trust history) and checks
  that it is the current owner as soon as the page is connected and free. *Verify received token* retries it. Messages that are not well formed are
  dropped. *send 0.001 UCT gas to tab B* funds the other tab's redeem.
- **Bridge deployment card:** the deployment's `nb2-release.json` pins: chain, vault (build, K, B), Γ and the domain D, deployment block, the limits, and
  the plug-in commit the manifest names against the one this build bundles.
- **Trust base** (`src/trust.ts`): the UTB history, started from the deployment's published bundle (or `/api/v1/trustbases`) under a pinned genesis
  EntryID and persisted. Each later entry is authenticated by its predecessor. *Refresh* fetches newer epochs, and the table lists epoch, EntryID,
  start/end round, members, weights and quorum.
- **Old-epoch check and forgeries** (`src/forge.ts`): verifies the selected token against the held history, and lists each certificate's seal epoch and
  round against that epoch's interval (a split part's table includes its parents' certificates). Two forgeries of the token's own certificates:
  - *unknown keys*: every seal is re-signed by fresh keys under the real signer ids, and is rejected with `QuorumNotMet`.
  - *re-labelled epoch*: the real seal and its signatures, with the epoch or round moved outside the epoch's rounds. It is rejected with `SealEpoch` before
    any signature is checked. If a later epoch is held, the round moves to the end of the seal's epoch, which is what a retired committee signing after its
    end looks like. If only the genesis epoch is held, the seal claims the epoch before it.

## Registry view (`pos.html`)

A second page of the same bundle, served at `/demo/pos.html` (sources `src/pos/`). It only reads: `eth_call` against `latest` and
`GET /api/v1/trustbases`. Each panel has an *explain* drawer that lists the calls behind it: the contract, the address, the function and
arguments, the decoded result and the source line.

It starts from the **validator registry (VR, `0xff…03`)** and its **election module pointer** (`activeModule()`), and says which module is active:

- **PoA** (`PoaElection`; recognised by its `moduleTag`, `keccak256("unicity.vr.poa.v1")`). The page labels it as **the intermediate mode before PoS**.
  - *Identities:* each identity's owner, binding and **PoA state** (Applied, Admitted, Joining, Active, ExitRequested, Removing, Leaving, Exited, Parked).
  - *Governance queue:* the Foundation multisig's queued changes with their state, both delays against the clock, and the expiry of a bound change (the
    same data `ubft governance list` shows), the multisig's signers and nonce, and the next boundary.
- **PoS** (`PosElectionAdapter` over P85; a module that names a liability holder). The existing custody, election and stake panels (below) are shown, reached
  through VR: custody is VR's liability holder (`activeModule().meta.liabilityHolder`, checked against `holderAt(0)`) and names the election
  (`custody.election()`). A *custody link* panel shows that VR ids equal custody StakingIDs: each committee member's root key hash in VR against
  `positions(id)` in custody.
- **Both modes:** the module (address, code hash, tag, health, work pending, stall deadline), VR's **output and boundary** state (the open output or the last
  acknowledged one, with its members and bound changes), the committee in force, and the **live config**: committee limits (`nMin/nTarget/nMax`, `vMax/lMax/rMax`),
  fee parameters (current and previous, effective block), the governance delays, the continuity rule, the change history (the partition changes among them) and the
  scheduled activations.
- **No VR** at the address (a network from before the registry): the page says so and shows the P85 view alone.

The installed partition list is root-side state, not VR storage, so the page shows the partition *changes* VR handled (ReplaceAggregatorValidators, AddPartition,
UpdatePartition), not the partition table. VR polls cheaply (seven calls) and reads everything when a pointer moves or every 30 s.

The registry reads are tested against a fixture chain for both modes (`test/vr.test.ts`). The PoS panels have been tested with that fixture only, not against a live PoS generation.

### The P85 panels (PoS, and networks without VR)

- **Committee now:** `custody.lastAckedAssignment()`, then its `assignments`, `assignmentExposures` and `exposures`. The panel shows each
  member's StakingID, owner, root key hash (with the UTB node id matched by `keccak256(sigKey)`), EVM key, committed weight q, bond lots,
  generation and retirement state. It draws W as a weight bar with the root quorum ⌊2W/3⌋+1 and the EVM threshold ⌊W/2⌋+1. The *what if* box
  takes members offline or changes their weights. That is local arithmetic only: live signer data is not public.
- **Election:** `params()`, `thresholds()`, and the registry's `progress()` and `ucTime()`. It shows rounds and seconds to the next due point,
  plus an ETA from the observed progress rate. The open result shows `result`, `frozenMembers` and `publication`, with its age against the
  roots' 16,384-round rejection window. It also shows `lastAttemptResult` and the last registry records. The churn table evaluates M, turnover
  < 1/3, D and overlap > 2/3 for the open result's candidate (`reader.committed(assignmentID)`). With no result open, it uses the
  page's port of `Selection.sol` over the eligible identities. A hypothetical successor can be edited and evaluated next to it.
- **Identities:** every ID in 1..`nextStakingID()`: position, lots, live index, exclusion, delegation, EVM key registration, retirement and
  eligibility. A newly registered validator appears here before it is elected.
- **UTB history:** the pinned, authenticated history (`src/trust.ts`, shared with the wallet). For each epoch it shows the EntryID, rounds,
  members mapped to StakingIDs, quorum, and which predecessor members signed it with what weight. There is a link to the wallet's old-epoch check.
- **Meta-parameters:** `custody.bondUnit/minBond/limits`, `election.params`, `policy()`, the governance delay, the reward rate, the pool and
  the stake book, each with one line of meaning.

The committee arithmetic (`src/pos/rules.ts`: quorum, Quantize, Continuity, Selection) is tested against the contracts' own vector files
(`test/fixtures/p85/`, contracts 7b510f6b). Polling is sequential, with requests at least 250 ms apart and backoff on refusals. The page reads
the clock and pointers every 8 s (`?poll=ms`). It reads everything else when a pointer changes or every 30 s, the trust bases every 20 s,
and the parameters every 5 min. Immutable views are cached. Contract addresses default to the generation's `pos-deployment.json`. They can be
overridden by `VITE_POS_CUSTODY/ELECTION/REWARD_POOL` or `?custody=&election=&rewardPool=`. The trust pin is the wallet's:
`VITE_TRUST_PIN` from the build, or the wallet's Network-settings developer override, which the page labels as such. It is never taken from
the server or the URL. Without a pin, the UTB card says so and loads nothing. The page keeps its history under its own storage keys
(`unicity-demo.<profile>.pos.trust.*`), so it never writes the wallet's.

## Configuration

Endpoints default to same-origin paths. The *Network settings* panel overrides them per tab profile (kept in localStorage):

| setting | default | what |
|---|---|---|
| `rpc` | `/rpc` | EVM JSON-RPC, the public gateway's methods. The wallet's bridge reads need `eth_getLogs` (exactly one address and an explicit numeric window of at most 10,000 blocks), `eth_getBlockReceipts` and `unicity_getSealCompanionV1` besides `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`/`ByHash`, `eth_call`, `eth_estimateGas`, `eth_getTransactionReceipt`, `eth_getTransactionCount`, `eth_gasPrice`/fee reads, `eth_getBalance`, `eth_getCode` and `eth_sendRawTransaction`. |
| `aggregator` | `/aggregator` | aggregator JSON-RPC. The SDK reads trust-base pages from `/api/v1/trustbases` on the same origin. |
| `faucet` | `/api` | faucet API: `<faucet>/network`, `<faucet>/claim` |
| `release` | `/nb2/nb2-release.json` (or `VITE_NB2_RELEASE`) | the deployment's native bridge v2 release manifest. Its trust bundle and `trust-base.genesis.entryid` are read beside it (the manifest's `trust.bundle` names the bundle). Replaces protocol 7's `tester-config.json`. |
| `trustPin` | `VITE_TRUST_PIN` at build time (`.env.production`) | the genesis EntryID that the trust history starts from. It is never taken from the server: without a pin, the page says so and does not connect. The manifest's published pin is only compared with it (a mismatch is shown as a warning). Setting it here is a developer override, and the page shows a banner while it is in use. |
| `network` | `VITE_NETWORK_ID` or 3 | the root network id, needed only when the first trust-base page is not a complete bundle |

The bridge is opened with the plug-in's installation check: the RPC's chain ID, the vault's `config()` equal to the manifest's pinned Γ, and the vault's runtime code hash
equal to the pinned one. A refusal (`BadDeployment`) means the manifest and the node are not the same deployment (a reset network, a wrong URL or a stale manifest), and nothing is sent.

`.env.production` holds the build configuration for `https://pos.staging.unicity.network/demo/`. Everything in it is public: the trust pin and contract addresses. It
is the pin of an earlier generation: **a new network generation needs a new pin there** (or `VITE_TRUST_PIN=<genesis EntryID> npm run build`, which wins over the file).

### Public RPC (what the gateway must serve)

Native bridge v2 needs no bridge-specific service: every piece of evidence is read from the ordinary node RPC behind the public gateway and verified offline (the guide's
*RPC requirements*). bft-core's `deploy/testnet/gateway.py` serves all of it (`WALLET_EVIDENCE`): checked live on a package generation (see the evidence), so no
gateway change is needed.

| need | method | gateway rule |
|---|---|---|
| the certificate of block N | `eth_getBlockByNumber(N+1)`, then `unicity_getSealCompanionV1(hash)` | one `[blockHash]` parameter |
| a block's header, receipts | `eth_getBlockByHash`, `eth_getBlockReceipts` | `[blockHash]` or `[hex number]` |
| segment logs, the newest seal, `Paid(eta)` | `eth_getLogs` | one contract address; a block hash or numeric `fromBlock..toBlock` of at most 10,000 blocks, not past the head (`"latest"` is refused) |
| vault views, simulation, submission | `eth_call`, `eth_estimateGas`, `eth_sendRawTransaction` | bodies up to 4.5 MiB; two large bodies at once |
| trust-base history | `GET /api/v1/trustbases` | same host |

The gateway keys its rate limits on `X-Forwarded-For` (10 requests a second per address) and refuses a request without it: a production proxy sets it, and `e2e/serve.mjs` and the dev proxy add one.
The plug-in backs off on 429 and busy 503, and halves a log window on a 413.

## Retries and reloads

The bridge's own state is the plug-in's **journal** (deposits, splits, returns, the signed redeem transactions), and the wallet's token records, a transfer's exact request and the intent mark
go through the same store: one IndexedDB object store (`src/idb.ts`, namespaced by the tab's profile).

- **Durability.** `putIf`, the journal's compare-and-swap, is one readwrite IndexedDB transaction (read, compare, write) opened with `durability: 'strict'`, and it resolves
  only on the transaction's `complete` event. The wallet's own records are written the same way and awaited before a step goes on. The store passes the plug-in's `checkJournalStore`
  contract check (`test/idb.test.ts`, on fake-indexeddb). Without IndexedDB the wallet refuses to move value and says why.
- **One writer per profile.** A page takes a Web Lock for its profile for as long as it lives, **before** it loads or creates the key. A second page of the same profile (`?w=`) is told, shows a banner, and runs no step that writes or moves value (funding and key import included); use another profile for another wallet. Without Web Locks (an insecure origin, an old browser) the wallet fails closed. The burner key is committed to the durable store (and read back) before it is used.
- **Scoped records.** The token records and a pending funding transaction are keyed by the deployment domain D and the owner key as well as the profile, so another deployment (Network settings) or another key never meets, overwrites or resumes them. A record write is read back, and memory changes only after the commit: a failed write leaves nothing a retry could act on. A split publishes its parts and the parent's change together in one transaction.
- **Read-only until ready.** Every mutation, key import included, is refused until the writer lock, the durable key, the deployment's records, any recovery and the reconciliation are done. A tab announces itself on the BroadcastChannel only then, and only to tabs of the same deployment domain.
- **Older profiles.** Records written by a build before the records were scoped (`tok/<id>`) are not read: the page says the profile is from an older build and offers a reset (the key is kept). Nothing is migrated.
- **Key import** only into an **empty** profile (no record of any kind besides the key, and no durable "has announced" marker: a handoff opt-in commits one before its first broadcast, and it survives reloads); otherwise the page says to use a new profile (`?w=...`). The deployment-bound recovery request for an exported intent mark commits with the key in one transaction. A tab takes part in the handoff only when its *take part in handoff* button is pressed, so an import can never race a sender that holds an announcement. *Reconnect* reloads the page, so no old channel, peer or session survives a change of deployment.
- **Funding for tab B:** the stored signed transaction is kept through every error or ambiguous outcome and cleared only when its receipt is found; the page shows it as pending with *retry* and a confirmed *discard* that warns about paying twice. The faucet and the displayed address are available only once the key is durable and this page is the writer. The pre-release `fund/pending` key counts as an older build's record.
- **Installation check before value moves.** The chain, the vault's `config()` and its runtime code hash are checked again right before deposit, mint, split, transfer, plan, burn, redeem and funding. A manifest whose plug-in revision differs from this build's, or is missing, keeps the bridge closed.
- **Intent backup.** The intent high-water mark is stored (durably, and in localStorage for display) before any deposit is sent; `submitDeposit` refuses until it is. The page shows it next to the exported key.
- **Deposit:** a rerun of *Deposit* first finishes an interrupted intent backup, then finds the planned intent and sends it or reconciles the earlier send; it never deposits twice. After a crash between the plug-in's journal write
  and the wallet's record, *connect* brings the records up to the journal (a deposit with no record gets one; a record behind its deposit or return moves forward).
- **Mint, split, burn, redeem:** each is journaled by the plug-in before the step it enables and resumes from the journal: a burn keeps its index and recipient, and only the witness is rebuilt;
  every signed redeem transaction is stored before it is broadcast, and an ambiguous broadcast is resolved by its receipt (`Paid(eta)`).
- **Transfer:** the plug-in does not journal transfers, so the wallet does. The exact request (the transaction with its random state mask, and its signed certification request) is stored
  on the token record before it is certified; a retry certifies that same request and never builds another. A transfer the aggregator refuses outright stays pending: a refused request cannot be discarded in this version.
- **Key import:** refused while anything signed by the current key is unfinished (a deposit not minted, a split or transfer in flight, a burn not redeemed). When the current key still holds value
  (an EVM balance, or a held or received token; an unreadable balance counts as held), the page shows the key and its intent mark and the import needs the word `replace` typed in. The import form also takes the exported **deposit intent mark**: after the reload the plug-in's `recoverDeposits` finds that key's deposits on the chain. Import runs as a guarded step like every other. A replaced key
  starts a new journal and new token records for the tab: they belong to the old key's secret.
- **Gas to the other tab:** the sent transaction is stored until its receipt is read; while it is, the button checks it instead of sending another.

## Limitations

- **Mint admission is open (bft-core#1039).** Anyone who sees a mint request on its way to the aggregator can register a competing first state for the same token ID, and the deposit is then stranded
  (the vault has no refund). Every deployment of this release is a test deployment with fake value.
- **An over-limit history can not be returned yet.** A claim that outgrows the transaction-size and gas limits after its burn has no recovery (`CapacityExceeded`; continuation, bft-core#1108, is
  deferred). The preflight exists to stop such a burn before it happens: the token then stays spendable on Unicity.
- **hCaptcha runs on the wallet's origin.** The faucet card loads hCaptcha's `api.js` at the top level of `/demo/`, on the same origin whose
  localStorage holds the burner keys (`unicity-demo.*.key`). A compromised or malicious hCaptcha script could read them. The keys are burner
  keys for test value only. A real wallet would isolate the captcha (a separate origin or iframe) or set a CSP.
- **A hard browser kill right after generating a key.** localStorage is written lazily: a `kill -9` of the browser within about a second of the key's creation can lose it. The bridge's
  journal and the wallet's records are in IndexedDB with strict durability and do not have this gap.
- **The handoff works only between tabs of one browser** (a `BroadcastChannel`), not between devices.
- **Records of the earlier (protocol 7) wallet are not read.** Tokens and locks it kept in localStorage belong to a network generation that no longer exists.

## Develop

```sh
npm ci
npm test              # tsc on src+test, then node --test (tsx): keys, the durable store, the flow and forgeries on the plug-in's offline simulator, the VR read model, the P85 rules
npm run build         # tsc --noEmit (strict) + vite build → dist/, served under /demo/
npm run dev           # http://localhost:5173/demo/ with the proxy below
```

The dev server (and `vite preview`) proxies the same-origin routes to upstreams. The defaults match these ssh tunnels to the server's loopback ports:

```sh
ssh -N -L 18545:127.0.0.1:8545 -L 18088:127.0.0.1:8088 <server>
```

| route | upstream (env) | default |
|---|---|---|
| `/rpc` → `/`, `/aggregator`, `/api/v1/trustbases` | `UPSTREAM_GATEWAY` (bft-core deploy/testnet/gateway.py) | `http://127.0.0.1:18545` |
| `/api/*`, `/faucet/*` | `UPSTREAM_FAUCET` | `http://127.0.0.1:18088` |
| `/nb2/*` | `UPSTREAM_NB2`, or `NB2_DIR=<local copy of GENERATION/bridge/nb2/public>` | `http://127.0.0.1:18081` |

`NB2_DIR` is the easiest way to get the deployment's files: `sudo cp -r <GENERATION>/bridge/nb2/public ./nb2-public` on the server, `scp -r` it, and `NB2_DIR=./nb2-public npm run dev`.
The test `world.ts` is the plug-in's own offline simulator (native-bridge-plugins `test/nb2/world.ts` at the vendored commit), with its imports pointed at the bundled `lib/`.

hCaptcha accepts only hostnames registered for the site key, so the faucet widget does not work on localhost. For local runs, fund the burner
address another way, for example a transfer from an operator account done on the server.

## End-to-end run in headless Chromium

`e2e/drive.mjs` drives the page over the DevTools protocol. It has no dependencies and needs Node 22 or later. Each argument is `<tab>:<command>`, where the tab is a wallet profile (`a`, `b`) or `pos`
for the registry page. The file header lists the commands. `e2e/serve.mjs` (no dependencies either) serves the built bundle at `/demo/` with the deployment's published files at `/nb2/` and the gateway's routes, so
a host with the package needs no `node_modules` for the wallet.

```sh
# on the host that runs the package (the package's gateway is on 127.0.0.1:8545):
VITE_TRUST_PIN=<genesis EntryID: GENERATION/bridge/nb2/public/trust-base.genesis.entryid> npm run build      # on a machine with node_modules; copy dist/ and e2e/
node e2e/serve.mjs --dist dist --nb2 <copy of GENERATION/bridge/nb2/public> --port 4173 &
CHROME=<chromium or headless_shell> node e2e/drive.mjs http://127.0.0.1:4173/demo/ a:connect a:addr      # print tab A's address, then fund it (below)
# the flow: A deposits, mints, splits, hands `keep` to B (B verifies it offline) and funds B's gas; A returns `back`; B returns `keep`
node e2e/drive.mjs http://127.0.0.1:4173/demo/ a:connect a:step:deposit a:step:mint a:step:split b:connect a:wait:2 a:pick:keep a:step:transfer b:wait:3 b:received a:fund
node e2e/drive.mjs http://127.0.0.1:4173/demo/ a:pick:back a:step:plan a:step:burn a:step:redeem b:connect b:step:plan b:step:burn b:step:redeem
node e2e/drive.mjs http://127.0.0.1:4173/demo/ a:pick:keep a:check:verify a:check:unknown a:check:relabel
```

The browser profile, and with it the tabs' keys and IndexedDB, lives in `PROFILE_DIR` (default: `unicity-demo-e2e-profile` in the OS temp directory). Successive runs therefore continue the same wallets. Delete the directory
to start with new keys. Set `CHROME` if Chromium is not at the macOS default path, and `CHROME_ARGS` for flags such as `--no-sandbox`. The exit status is 1 if a step failed.

**Funding is manual.** The faucet's hCaptcha rejects localhost. Instead, send tab A some UCT (about 0.2 is plenty for a 0.1 deposit and the gas) from a funded account on the server, signing on the server so the key never leaves it (the package's faucet account, with `cast send` from the tools image).
Tab B gets its gas from tab A through `a:fund`.
