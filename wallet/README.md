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
  BroadcastChannel. The sender transfers the token to the other tab's key and posts the token file. The receiver verifies it offline
  (`verifyNativeTokenBytes(…, 'receipt')`) and checks that it is the current owner. *send 0.001 UCT gas to tab B* funds the other tab's redeem and
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

## Configuration

Endpoints default to same-origin paths. The *Network settings* panel overrides them per tab profile (kept in localStorage):

| setting | default | what |
|---|---|---|
| `rpc` | `/rpc` | EVM JSON-RPC. Only the public gateway's methods are used: chainId, blockNumber, getBlockByNumber, getBalance, getTransactionCount, gasPrice, estimateGas, call, getCode, getTransactionReceipt, sendRawTransaction. There is no `eth_getLogs`: the Locked event is read from the lock's receipt. |
| `aggregator` | `/aggregator` | aggregator JSON-RPC. The SDK reads trust-base pages from `/api/v1/trustbases` on the same origin. |
| `lockproof` | `/lockproof` | lock-proof endpoint, as `GET <lockproof>/v1/lockproof?block=&nonce=` |
| `faucet` | `/api` | faucet API: `<faucet>/network`, `<faucet>/claim` |
| `testerConfig` | `/bridge/tester-config.json` | the operator-published bridge config. Its files (EVM PDR, deployment document, genesis EntryID) are read relative to it. |
| `trustPin` | `VITE_TRUST_PIN` at build time | the genesis EntryID. When it is empty, the operator's `trust-base.genesis.entryid` is used, which is weaker because it comes from the same server. |
| `network` | `VITE_NETWORK_ID` or 3 | the root network id, needed only when the first trust-base page is not a complete bundle |

The page checks that the RPC's block 0 is the `genesisHash` in tester-config.json, and that the vault has code, before anything is sent.

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
