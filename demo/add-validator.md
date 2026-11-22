# Add the fifth validator

Use the operator release and seed for `tn-public-20261122`. The public network starts with four validators. Run this from a dedicated operator account on the dev host. Run the release, seed, follower and authority setup from the validator handbook. Before the demonstration, confirm both artifact hashes, the operator’s P2P ports, the admission cutoff and the target epoch. Fund the operator with at least 100 UCT plus gas. [Validator handbook](https://github.com/ristik/bft-core/blob/e54b522b08d7418408f3f947ba4217f7e4097c76/docs/operations/validator-handbook.md)

The commands below are from the operator’s rehearsal draft. The packaged VR/P85 generation and rehearsal timings are pending. [Packaging issue](https://github.com/ristik/bft-core/issues/1277)

## Register and bond

```bash
umask 077
export UBFT_HOME="$HOME/tn-public-20261122-validator-5"
cd "$UBFT_HOME"
CUSTODY=$(jq -er '.custody' release/deployment.json)
ubft validator status --custody "$CUSTODY" --json
ubft validator apply --dry-run
date -u +%FT%TZ | tee logs/stake-start.utc
ubft validator apply
```

Confirm registration, delegation and the bonded stake. The audience sees the new StakingID and principal in **Identities** and the eligibility panel. **Committee now** still has four seats. Show the round and UC time gates under **Election**. The countdown estimates the time until both gates have passed.

## Election and handoff

Pin the authority policy to the new StakingID. At the next election, submit the operator’s own assignment proof and complete the handbook’s activation and authority enrollment steps for the target epoch.

```bash
ubft validator pos-publish --own-proof
ubft validator status --custody "$CUSTODY" --json --exit-code
```

Show the fifth candidate in the election result. After acknowledgment, **Committee now** shows five ordered seats and their historical bond lots. In **Trust base (UTB) history**, show the new entry and its predecessor’s signers, then the joining root’s first verified EVM UC, including block and root round. With equal unit weights the root quorum rises from three to four. Four and five validators both have `f = floor((n − 1) / 3) = 1`. Tolerating two Byzantine faults requires seven.

Record stake submission, election, acknowledged activation, and the first UC signed by the joining root in UTC. Use the verified boundary countdown on the day. The current end-to-end target is ten minutes from stake submission, pending rehearsal measurement.
