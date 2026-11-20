/** Records an older build wrote that this build does not read: the page offers a reset. */
import type { IdbKv } from './idb.js';

/** Token records without a deployment scope (`tok/<id>`) and the pre-release funding record `fund/pending` (no deployment, no signer). */
export async function legacyKeysOf(kv: IdbKv): Promise<string[]> {
  const out = (await kv.list('tok/')).filter((k) => k.split('/').length === 2);
  if ((await kv.get('fund/pending')) !== null) out.push('fund/pending');
  return out;
}
