# Add the fifth validator

Run from an amd64 Linux Docker host with a reachable IPv4 address. Open or
forward TCP 27652 and 29252 to the host. The container's execution and operator
RPCs stay on loopback. Use the current generation's authenticated image
announcement and [validator container quick start](https://github.com/ristik/bft-core/blob/integration/enshrined-evm/docs/operations/validator-handbook.md#quick-start-with-the-validator-container)
to download, verify and load the image. Set `IMAGE` to the verified image ID
and `PUBLIC_IP` to this operator's routed IPv4 address.

```bash
docker volume create unicity-validator
docker run --rm --network host -v unicity-validator:/data "$IMAGE" \
  init --announce-addresses "/ip4/$PUBLIC_IP"
docker run -d --name unicity-authority --restart=no --network host \
  -v unicity-validator:/data "$IMAGE" authority
docker run -d --name unicity-node --network host \
  -v unicity-validator:/data "$IMAGE" run
```

Fund the printed payee on the faucet page. A 200 UCT claim covers the
100 UCT bond and fees. Start the demo timer when confirming the join.

```bash
date -u +%FT%TZ
docker exec unicity-node ubft-validator join --yes
docker exec unicity-node ubft-validator status
```

Show the new StakingID and bond in **Identities**, the reservation under
**Election**, and the five ordered seats in **Committee now**. Validators
submit their own frozen-member proofs. Any validator can publish when all
are recorded. After the node verifies the activation from its own root,
show its seat, root epoch and certification activity. Equal-weight root
quorum rises from three to four. Both committees tolerate one fault.

For an interrupted join, keep the authority running. Start or replace
only the node container with the same volume and repeat `join --yes`.
