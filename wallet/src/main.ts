// Bundling spike: import everything the asset flow needs and touch it at runtime.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/crypto/secp256k1/SigningService.js';
import { Token } from '@unicitylabs/state-transition-sdk/lib/transaction/Token.js';
import { TokenProofClient } from '@unicitylabs/state-transition-sdk/lib/consolidation/TokenProofClient.js';
import * as plugin from '@unicitylabs/native-bridge-plugin';

const out = document.getElementById('out')!;
const sk = secp256k1.utils.randomSecretKey();
const signer = new SigningService(sk);
out.textContent = [
  'pubkey ' + Array.from(signer.publicKey, b => b.toString(16).padStart(2, '0')).join(''),
  'plugin exports: ' + Object.keys(plugin).join(', '),
  typeof AggregatorClient, typeof Token, typeof TokenProofClient,
].join('\n');
