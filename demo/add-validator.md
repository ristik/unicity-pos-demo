# Add the fifth validator

The public generation `tn-public-20261122` starts with four validators. Run the release, seed, follower and authority setup from the validator handbook in its `$HOME/validator` home. Use the same `UBFT_HOME` throughout. Before the timed step, confirm the authenticated release and seed checksums, gateway adapter, operator ports, election window, and target shard epoch. The operator needs at least 100 UCT plus gas. [Validator handbook](https://github.com/ristik/bft-core/blob/e54b522b08d7418408f3f947ba4217f7e4097c76/docs/operations/validator-handbook.md)

Use the loopback gateway adapter from the reviewed package checkout.

```bash
python3 deploy/testnet/validator_rpc.py --gateway-port 8545 --listen-port 18485
```

## Register and bond

Run these commands in the operator's initialized home with the follower services and authority running. Start the timer at the first application.

```bash
export UBFT_HOME="$HOME/validator"
cd "$UBFT_HOME"
UBFT=$UBFT_HOME/release/ubft
RPC_URL=http://127.0.0.1:18485
ROOT_RPC=http://127.0.0.1:25852
CHAIN_ID=$(jq -er .config.chainId release/genesis.json)
CUSTODY=$(jq -er .custody release/deployment.json)
ELECTION=$(jq -er .election release/deployment.json)
REGISTRY=$(jq -er .registry release/deployment.json)
NETWORK_WORD=$(jq -er .networkWord release/vr-deployment.json)
AUTH=(--operator-socket "$UBFT_HOME/authority/operator.sock" --operator-credential "$UBFT_HOME/authority/operator.cred")
"$UBFT" validator apply --dry-run
date -u +%FT%TZ | tee logs/stake-start.utc
"$UBFT" validator apply
```

Show the new StakingID and principal in **Identities**. **Committee now** still shows four seats. If application stops at `signing-pos-policy-refused` after registration and bond, confirm the ID and receipts, then install the policy and resume with the same operator and amounts.

```bash
ID=$(jq -er '.id | select(. > 0)' validator.json)
jq -n --arg network "$NETWORK_WORD" --argjson chainId "$CHAIN_ID" --arg election "$ELECTION" --argjson id "$ID" \
  '{network:$network,chainId:$chainId,election:$election,ids:[$id]}' > authority/pos-policy.json
"$UBFT" signing-authority pos-policy "${AUTH[@]}" --policy authority/pos-policy.json
"$UBFT" validator apply
```

## Election and handoff

Show both round and UC time gates under **Election**. At the boundary, wait for a nonzero result and check it names five members including `$ID` before publishing the proof.

```bash
RESULT=$(cast call --rpc-url "$RPC_URL" "$ELECTION" 'openResult()(bytes32)')
cast call --rpc-url "$RPC_URL" "$ELECTION" 'frozenMembers(bytes32)((uint64,uint64,uint64,uint64,bytes32)[])' "$RESULT"
"$UBFT" validator pos-publish --own-proof
```

The relay operator gathers the frozen members’ proofs, publishes the result in VR, and the incumbents run the packaged activation. After the joining root confirms the activated epochs, enroll and advance the authority using the verified handoff bundle, then restart the joining shard with its existing home and fresh session credential. [Validator handbook](https://github.com/ristik/bft-core/blob/e54b522b08d7418408f3f947ba4217f7e4097c76/docs/operations/validator-handbook.md#4-apply-stake-and-join)

```bash
"$UBFT" q3 shard-conf --root-rpc "$ROOT_RPC" --epoch "$ACTIVATED_SHARD_EPOCH" --out authority/activated-shard.json
"$UBFT" signing-authority complete-enrollment "${AUTH[@]}" --shard-conf authority/activated-shard.json
"$UBFT" signing-authority advance-with-proof "${AUTH[@]}" --client-socket authority/client.sock \
  --out authority/client.cred --proof "authority/activation-$ACTIVATED_ROOT_EPOCH.cbor"
kill -TERM "$SHARD_PID"
wait "$SHARD_PID" || true
"$UBFT" shard-node run "${SHARD_ARGS[@]}" >>logs/shard.log 2>&1 &
SHARD_PID=$!
"$UBFT" validator status --custody "$CUSTODY" --json
cast call --rpc-url "$RPC_URL" "$REGISTRY" 'committeeIds()(uint64[])'
```

Show five ordered seats and their historical bond lots in **Committee now**. In **Trust base (UTB) history**, show the new entry and the predecessor’s signers, then the first verified EVM UC carrying the joining root’s signature. With equal weights, the root quorum rises from three to four. Both committee sizes have `f = floor((n − 1) / 3) = 1`.

In private rehearsal `tn-public-20261122-rehearsal-c`, five members were confirmed **3m 24s** after apply started. The election reserved five after 1m 49s, root epoch 2 activated after 3m 08s, and the verified UC for block 28 included the fifth root’s signature. On demo day, use the current boundary countdown and record the same milestones.
