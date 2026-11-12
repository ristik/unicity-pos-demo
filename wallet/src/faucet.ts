/**
 * The faucet, as its own page does it (bft-core deploy/testnet/faucet): GET /api/network gives the chain pin and the hCaptcha site key;
 * the widget is rendered explicitly; POST /api/claim carries the captcha token in the h-captcha-response header. A 200 is a broadcast, not
 * finality: the receipt is polled.
 */
export interface Network { chain_id: number; genesis_hash: string; captcha_sitekey: string }

interface HCaptcha {
  render(el: HTMLElement, opts: { sitekey: string; theme?: string; callback?: (token: string) => void }): string;
  getResponse(id?: string): string;
  reset(id?: string): void;
}
declare global {
  interface Window { hcaptcha?: HCaptcha }
}

export async function network(api: string): Promise<Network> {
  const res = await fetch(`${api}/network`);
  if (!res.ok) throw new Error(`${api}/network: HTTP ${res.status}`);
  return (await res.json()) as Network;
}

let loading: Promise<HCaptcha> | null = null;
function loadHcaptcha(): Promise<HCaptcha> {
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.hcaptcha.com/1/api.js?render=explicit';
    s.async = true;
    s.onload = () => (window.hcaptcha ? resolve(window.hcaptcha) : reject(new Error('hCaptcha did not load')));
    s.onerror = () => reject(new Error('hCaptcha did not load (blocked, or offline)'));
    document.head.append(s);
  });
  return loading;
}

export async function renderCaptcha(el: HTMLElement, sitekey: string, dark: boolean): Promise<{ token: () => string; reset: () => void }> {
  const h = await loadHcaptcha();
  const id = h.render(el, { sitekey, theme: dark ? 'dark' : 'light' });
  return { token: () => h.getResponse(id), reset: () => h.reset(id) };
}

/** POST /api/claim; returns the faucet's transaction hash. Errors carry the faucet's message (400 captcha, 409 wrong chain, 429 limits). */
export async function claim(api: string, net: Network, address: string, captcha: string): Promise<{ txHash: string; message: string }> {
  if (!captcha) throw new Error('complete the hCaptcha first');
  const res = await fetch(`${api}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'h-captcha-response': captcha },
    body: JSON.stringify({ address, chain_id: net.chain_id, genesis_hash: net.genesis_hash.toLowerCase() }),
  });
  const body = (await res.json().catch(() => ({}))) as { msg?: string; message?: string };
  if (!res.ok) throw new Error(`faucet: HTTP ${res.status}: ${body.message ?? body.msg ?? ''}`);
  const msg = body.msg ?? '';
  const m = /0x[0-9a-fA-F]{64}/.exec(msg);
  if (!m) throw new Error(`faucet answered without a transaction hash: ${msg}`);
  return { txHash: m[0], message: msg };
}
