# unicity-pos-demo

Browser demos for the Unicity public testnet generation `tn-public-20261122`. It runs in the browser, with nothing to install.

- `wallet/`: a minimal in-browser wallet (Vite + TypeScript, no framework). One burner key serves both as the EVM account and as the Unicity identity.
  - Asset flow on NB2 v1.1: faucet UCT → deposit → mint → split → transfer to another tab → burn → redeem. The wallet can resume an oversized return from certified continuation checkpoints.
  - Registry view (`pos.html`): the validator registry (VR) with its active election module (PoA, the intermediate mode before PoS, or PoS), identities, governance queue and live config; under PoS also the committee, stakes and weighted quorum, meta-parameters, ordered seats and historical bond lots, and the trust-base (UTB) history. See [the fifth-validator demo](demo/add-validator.md).
- `slides/`: the accompanying talk, written in Marp markdown.

The target is `https://pos.staging.unicity.network/demo/`, beside `/rpc`, `/aggregator`, `/api/v1/trustbases`, `/faucet/` and `/release/`. The production build pins the staged VR/P85 and NB2 v1.1 release for this generation.

## Vendored packages

`vendor/` pins the SDK and the native bridge plug-in that the wallet bundles:

- `@unicitylabs/state-transition-sdk` 4.0.0-utb.c5840ef: the same tarball as `ristik/native-bridge-plugins/vendor/`. The provenance files are next to it.
- `@unicitylabs/bridge-core` 0.1.0-bridge.2: built from `unicitynetwork/unicity-bridge` `deb2b86c`, the same tarball as in native-bridge-plugins.
- `@unicitylabs/native-bridge-plugin` 0.1.0 was built at `06e224c744dc` (native-bridge-plugins #95: a seen payout that left the chain is offered again or reported as vanished; on top of #94: a payout not certified yet stays pending; needs-archive only on a node's pruned answer, naming what is missing; on top of #93: typed retryable RPC errors, bounded jittered backoff, `PolicyRequired`) on top of authenticated UTB tip verification and durable proof retention. Its release requires the paired revision-2 verifier. The provenance file records the build and hashes.

## Build

```sh
npm --prefix wallet ci
npm --prefix wallet run build            # wallet/dist, served under /demo/
npx @marp-team/marp-cli slides/deck.md -o slides/deck.html
```
