/** Run the wallet's simulated chain as an HTTP gateway for the Chromium demo. */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CborDeserializer as C } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborDeserializer.js';
import { hex, unhex } from '../src/hex.js';
import { setup } from './world.js';

const directory = process.argv[2];
if (!directory) throw new Error('pass a directory for the simulated release');
mkdirSync(directory, { recursive: true });
const { chain, root, agg, pins } = await setup();
const genesisEntryId = hex(root.pin);
const provenance = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../vendor/native-bridge-plugin.provenance.json', import.meta.url), 'utf8'));
const manifest = JSON.stringify({
  pins,
  package: { generation: 'browser fixture', validators: root.signers.length },
  bridge: { sources: { 'native-bridge-plugins': provenance.commit } },
  trust: { origin: { usableEpoch: '1', rootRound: '1000000' }, genesisEntryId },
}, (_key, value) => typeof value === 'bigint' ? String(value) : value instanceof Uint8Array ? hex(value) : value);
writeFileSync(join(directory, 'nb2-release.json'), manifest);
writeFileSync(join(directory, 'trust-base.bundle.cbor'), root.bundle);
writeFileSync(join(directory, 'trust-base.genesis.entryid'), genesisEntryId);
const digest = createHash('sha256').update(manifest).digest('hex');
writeFileSync(join(directory, 'pins.env'), `VITE_TRUST_PIN=${genesisEntryId}\nVITE_NB2_RELEASE_SHA256=${digest}\n`);

const funded = new Set<string>();
createServer(async (req, res) => {
  if (req.url?.startsWith('/api/v1/trustbases')) {
    // Initial trust comes from the fixture's pinned release bundle.
    res.writeHead(404).end();
    return;
  }
  let id: unknown;
  try {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const request = JSON.parse(Buffer.concat(parts).toString());
    id = request.id;
    const { method, params } = request;
    let result: unknown;
    if (method === 'certification_request') {
      const encoded = Array.isArray(params) ? params[0] : params;
      const [, , certification] = C.decodeArray(C.decodeTag(unhex(encoded)).data, 4);
      await agg.certify(certification);
      result = { status: 'SUCCESS' };
    } else if (method === 'get_inclusion_proof.v2') {
      const key = (Array.isArray(params) ? params[0] : params).stateId.replace(/^0x/, '');
      const proof = agg.certified.get(key);
      result = proof ? hex(proof) : '';
    } else {
      if (method === 'eth_getBalance' && !funded.has(params[0])) {
        funded.add(params[0]);
        chain.fund(unhex(params[0]), 10n ** 18n);
      }
      result = await chain.call(method, params);
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  } catch (err) {
    const e = err as { code?: number; message: string; data?: unknown };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      jsonrpc: '2.0', id, error: { code: e.code ?? -32603, message: e.message, data: e.data },
    }));
  }
}).listen(Number(process.env.FIXTURE_PORT ?? 18551), '127.0.0.1');
