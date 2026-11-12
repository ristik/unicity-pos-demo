# unicity-pos-demo

A demo of the Unicity PoS staging stack. It runs in the browser, with nothing to install.

- `wallet/`: a minimal in-browser wallet (Vite + TypeScript, no framework). One burner key serves both as the EVM account and as the Unicity identity.
  - Asset flow: faucet UCT → bridge to a Unicity token → transfer → bridge back.
  - PoS view: committee, stakes and weighted quorum, meta-parameters, trust-base (UTB) history.
- `slides/`: the accompanying talk, written in Marp markdown.

It is served at `https://pos.staging.unicity.network/demo/`, on the same origin as `/rpc`, `/aggregator` and `/api/v1/trustbases`.

## Vendored packages

`vendor/` pins the SDK and the native bridge plug-in that the wallet bundles:

- `@unicitylabs/state-transition-sdk` 4.0.0-utb.c5840ef: the same tarball as `ristik/native-bridge-plugins/vendor/`. The provenance files are next to it.
- `@unicitylabs/bridge-core` 0.1.0-bridge.2: built from `unicitynetwork/unicity-bridge` `deb2b86c`, the same tarball as in native-bridge-plugins.
- `@unicitylabs/native-bridge-plugin` 0.1.0: `npm pack` of `ristik/native-bridge-plugins` `packages/native-bridge-plugin`. Its two relative `file:` dependencies are turned into peer dependencies.

## Build

```sh
cd wallet && npm ci && npm run build      # → wallet/dist, served under /demo/
npx @marp-team/marp-cli slides/deck.md -o slides/deck.html
```
