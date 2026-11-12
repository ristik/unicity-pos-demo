# Demo wallet

A minimal in-browser wallet for the Unicity PoS demo: Vite + TypeScript, no framework, plain DOM. It is built to a static bundle served at
`/demo/` on the network's own origin, so `/rpc`, `/aggregator`, `/api/...`, `/lockproof` and `/bridge` are same-origin and need no CORS.

## What it does

- **One burner key** (`src/keys.ts`): a secp256k1 key in localStorage. It is the EVM account and also the Unicity owner (a SignaturePredicate of the
  same key). It exports as 24 BIP-39 words or as 0x hex. The words are the key itself, taken as the mnemonic's entropy with no derivation path, so
  they are not a MetaMask seed.
- **Faucet** (`src/faucet.ts`): fetches the hCaptcha site key from `GET /api/network`, renders the widget explicitly, then sends
  `POST /api/claim` with the `h-captcha-response` header and polls the receipt.
- **Asset flow** (`src/bridge.ts`, ported from native-bridge-plugins `tester/bridge-tester.ts`): lock → lock proof → mint → transfer → burn →
  return proof → redeem → claim. Each step on the page has an *explain* drawer. It shows the requests the step made (method, path, status, sizes,
  timings, and the last few raw bodies) and the step's own facts: tx hashes, proof and token sizes, seal epoch and round.
- **Two-tab handoff** (`src/handoff.ts`): *open tab B* opens `?w=b`, a second wallet with its own key and storage. The two tabs find each other over a
  BroadcastChannel. The sender transfers the token to the other tab's key, stores the token as *sent*, and posts the token file; *Resend*
  posts it again if the other tab was closed or missed it. The receiver stores the file the moment it arrives (as *received, not verified*),
  then verifies it offline (`verifyNativeTokenBytes(…, 'receipt')`) and checks that it is the current owner as soon as the page is connected
  and free. *Verify received token* retries it. Messages that are not well formed are dropped. *send 0.001 UCT gas to tab B* funds the other tab's redeem and
  claim.
- **Trust base** (`src/trust.ts`): the UTB history, bootstrapped from `/api/v1/trustbases` under a pinned genesis EntryID and persisted. Each later
  entry is authenticated by its predecessor. *Refresh* fetches newer epochs, and the table lists epoch, EntryID, start/end round, members, weights
  and quorum.
- **Old-epoch check and forgeries** (`src/forge.ts`): verifies the selected token against the held history, and lists each certificate's seal epoch and
  round against that epoch's interval. Two forgeries:
  - *unknown keys*: every seal is re-signed by fresh keys under the real signer ids, and is rejected with `ErrQuorumNotMet`.
  - *re-labelled epoch*: the real seal and its signatures, with the epoch or round moved outside the epoch's rounds. It is rejected with `ErrSealEpoch` before
    any signature is checked. If a later epoch is held, the round moves to the end of the seal's epoch, which is what a retired committee signing after its
    end looks like. If only the genesis epoch is held, the seal claims the epoch before it.

## PoS visualizer (`pos.html`)

A second page of the same bundle, served at `/demo/pos.html` (source `src/pos/`). It only reads: `eth_call` against `latest` and
`GET /api/v1/trustbases`. Each panel has an *explain* drawer that lists the calls behind it: the contract, the address, the function and
arguments, the decoded result and the source line.

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
| `rpc` | `/rpc` | EVM JSON-RPC. Only the public gateway's methods are used: chainId, blockNumber, getBlockByNumber, getBalance, getTransactionCount, gasPrice, estimateGas, call, getCode, getTransactionReceipt, sendRawTransaction. There is no `eth_getLogs`: the Locked event is read from the lock's receipt. |
| `aggregator` | `/aggregator` | aggregator JSON-RPC. The SDK reads trust-base pages from `/api/v1/trustbases` on the same origin. |
| `lockproof` | `/lockproof` | lock-proof endpoint, as `GET <lockproof>/v1/lockproof?block=&nonce=` |
| `faucet` | `/api` | faucet API: `<faucet>/network`, `<faucet>/claim` |
| `testerConfig` | `/bridge/tester-config.json` | the operator-published bridge config. Its files (EVM PDR, deployment document, genesis EntryID) are read relative to it. |
| `trustPin` | `VITE_TRUST_PIN` at build time (`.env.production`) | the genesis EntryID that the trust history starts from. It is never taken from the server: without a pin, the page says so and does not connect. Setting it here is a developer override, and the page shows a banner while it is in use. |
| `network` | `VITE_NETWORK_ID` or 3 | the root network id, needed only when the first trust-base page is not a complete bundle |

The page checks that the RPC's block 0 is the `genesisHash` in tester-config.json, and that the vault has code, before anything is sent.

`.env.production` holds the build configuration for `https://pos.staging.unicity.network/demo/`. Everything in it is public: the trust pin
(the generation's `utb.genesis_id`) and contract addresses. `npm run build` reads it. A new network generation needs a new pin there.

## Retries and reloads

Each step can be run again, or the page reloaded part way through, without losing the lock or the token:

- **Lock:** the signed transaction is stored before `eth_sendRawTransaction`. While it is stored, *Run* polls its hash (rebroadcasting the
  same bytes when it is not mined) and does not send another lock. After any send error the chain decides, not the error: the receipt and
  the account nonce are read again. The lock is cleared only once its receipt is read, or when it provably cannot be mined (its account
  nonce went to another transaction, seen on two reads a few seconds apart, or the node refused it outright while the nonce had not moved).
  A gateway timeout, a wrapped 5xx, "nonce too low" or "nonce too high" keeps it pending ("still pending, Run again later"). The record is
  also written to IndexedDB (`durability: 'strict'`, awaited) before the broadcast, and put back into localStorage on the next load if only
  that copy survived.
- **Transfer and burn:** the transaction (with its random state mask) and its signed certification request are stored on the token record
  before they are submitted. A retry submits that same request, and never builds a new one. *Discard pending* is offered only after the
  aggregator explicitly refused the request (never after a timeout). It asks for confirmation, then checks the aggregator again and keeps
  the request if it is certified or the aggregator's status hint says it is pending. A discarded request stays on the record
  (`discarded`). If it is certified after all, the next transfer or burn meets the conflict, restores it as the pending transaction and
  completes it (or, for the other kind, asks to run that step).
- **Certification:** an existing proof is taken without submitting again. *Already submitted* counts as accepted. A refusal fails with its
  status. A proof that certifies another transaction for the state is an error, and is never stored as this transaction's proof.
- **Redeem:** when the vault answers `PartAlreadyRedeemed` (an earlier redeem was mined), the step reports *already redeemed*.

## Limitations

- **hCaptcha runs on the wallet's origin.** The faucet card loads hCaptcha's `api.js` at the top level of `/demo/`, on the same origin whose
  localStorage holds the burner keys (`unicity-demo.*.key`). A compromised or malicious hCaptcha script could read them. The keys are burner
  keys for test value only. A real wallet would isolate the captcha (a separate origin or iframe) or set a CSP.
- **A hard browser kill right after signing a lock.** localStorage is written lazily: a `kill -9` of the browser within about a second of
  signing can lose the pending-lock record there (a reload or closing the tab does not). The IndexedDB copy above is committed before the
  broadcast and covers this where the browser honours `durability: 'strict'`. Where IndexedDB is unavailable, such a kill can still lose
  the record, and the next *Run* would sign a second lock.
- **The handoff works only between tabs of one browser** (a `BroadcastChannel`), not between devices.

## Develop

```sh
npm ci
npm test              # tsc on src+test, then node --test (tsx): key/tx vectors, verify/forge on the plug-in's synthetic world
npm run build         # tsc --noEmit (strict) + vite build → dist/, served under /demo/
npm run dev           # http://localhost:5173/demo/ with the proxy below
```

The dev server (and `vite preview`) proxies the same-origin routes to upstreams. The defaults match these ssh tunnels to the server's loopback ports:

```sh
ssh -N -L 18545:127.0.0.1:8545 -L 18088:127.0.0.1:8088 -L 18090:127.0.0.1:8090 <server>
```

| route | upstream (env) | default |
|---|---|---|
| `/rpc` → `/`, `/aggregator`, `/api/v1/trustbases` | `UPSTREAM_GATEWAY` (bft-core deploy/testnet/gateway.py) | `http://127.0.0.1:18545` |
| `/api/*`, `/faucet/*` | `UPSTREAM_FAUCET` | `http://127.0.0.1:18088` |
| `/lockproof/*` → `/*` | `UPSTREAM_LOCKPROOF` (dnb-tool lockproof-serve) | `http://127.0.0.1:18090` |
| `/bridge/*` → `/*` | `UPSTREAM_BRIDGE`, or `BRIDGE_DIR=<local copy of GENERATION/bridge/public>` | `http://127.0.0.1:18081` |

The ports on the server depend on the generation, so check its compose file. `BRIDGE_DIR` is the easiest way to get the bridge files:
`scp -r <server>:/srv/testnet/<generation>/bridge/public ./bridge-public` and then `BRIDGE_DIR=./bridge-public npm run dev`.

hCaptcha accepts only hostnames registered for the site key, so the faucet widget does not work on localhost. For local runs, fund the burner
address another way, for example a transfer from an operator account done on the server.

## End-to-end run in headless Chromium

`e2e/drive.mjs` drives the page over the DevTools protocol. It has no dependencies and needs Node 22 or later. Each argument is `<tab>:<command>`, where the tab is a wallet profile (`a`, `b`). The file header lists the commands.

```sh
# 1. tunnels to the server's loopback ports (see above) and a local copy of the generation's bridge/public/
ssh -f -N -L 18545:127.0.0.1:8545 -L 18088:127.0.0.1:8088 -L 18090:127.0.0.1:8090 <server>
# 2. build (.env.production has the staging pin; for another generation, pass its manifest's utb.genesis_id), serve it with the dev routes
VITE_TRUST_PIN=<genesis entry id> npm run build
BRIDGE_DIR=./bridge-public npx vite preview --port 4173 &
# 3. print tab A's address, then fund it (below)
node e2e/drive.mjs http://localhost:4173/demo/ a:connect a:addr
# 4. the flow: A locks and mints, hands the token to B and funds B's gas; B burns, redeems and claims
node e2e/drive.mjs http://localhost:4173/demo/ a:connect a:step:lock a:step:lockproof a:step:mint \
  a:check:verify a:check:unknown a:check:relabel b:connect a:wait:2 a:step:transfer b:wait:3 b:received a:fund
node e2e/drive.mjs http://localhost:4173/demo/ b:connect b:step:burn b:step:returnproof b:step:redeem b:step:claim
```

The browser profile, and with it the tabs' keys and tokens, lives in `PROFILE_DIR` (default: `unicity-demo-e2e-profile` in the OS temp directory). Successive runs therefore continue the same wallets. Delete the directory to start with new keys. Set `CHROME` if Chromium is not at the macOS default path. The exit status is 1 if a step failed.

**Funding is manual.** The faucet's hCaptcha rejects localhost. Instead, send tab A some UCT (about 0.01 is enough for a 0.001 round trip) from a funded account on the server, signing on the server so the key never leaves it. One way is a value transfer signed with `signLegacyTx` from `src/evm.ts`, run with node on the host against `127.0.0.1:8545` with an `X-Forwarded-For` header. Tab B gets its gas from tab A through `a:fund`.
