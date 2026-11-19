/**
 * Built to a static bundle served at /demo/ on the network's own origin. `npm run dev` proxies the same-origin routes to upstreams
 * (defaults: ssh -L tunnels to the server's loopback ports, wallet/README.md); NB2_DIR serves a local copy of the generation's
 * bridge/nb2/public/ (nb2-release.json, the trust bundle and its pin) at /nb2/ instead.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';

const env = process.env;
/** the plug-in commit the bundled tarball was built from (vendor/native-bridge-plugin.provenance.json): the page compares it with the manifest's */
const nbpCommit = (JSON.parse(readFileSync(new URL('../vendor/native-bridge-plugin.provenance.json', import.meta.url), 'utf8')) as { commit: string }).commit;
const gateway = env.UPSTREAM_GATEWAY ?? 'http://127.0.0.1:18545'; // EVM RPC at /, /aggregator, /api/v1/trustbases (bft-core deploy/testnet/gateway.py)
const faucet = env.UPSTREAM_FAUCET ?? 'http://127.0.0.1:18088'; // /api/network, /api/claim
const nb2Files = env.UPSTREAM_NB2 ?? 'http://127.0.0.1:18081'; // GENERATION/bridge/nb2/public/ over HTTP

// the gateways key their rate limits on X-Forwarded-For and refuse a request without it (nginx sets it in production)
const to = (target: string, strip?: string): ProxyOptions => ({
  target, changeOrigin: true, headers: { 'x-forwarded-for': '127.0.0.1' }, ...(strip ? { rewrite: (p: string) => p.slice(strip.length) || '/' } : {}),
});

/** /nb2/* from a local directory (a copy of GENERATION/bridge/nb2/public/), when NB2_DIR is set. */
function nb2Dir(dir: string): Plugin {
  // a hook that returns a function gets it called as a post-middleware hook: return nothing
  const serve = (server: { middlewares: { use: (path: string, fn: (req: { url?: string }, res: { setHeader(k: string, v: string): void; end(b: Uint8Array): void }, next: () => void) => void) => unknown } }): void => {
    server.middlewares.use('/nb2', (req, res, next) => {
      const file = normalize(join(dir, decodeURIComponent((req.url ?? '/').split('?')[0])));
      if (!file.startsWith(normalize(dir)) || !existsSync(file) || !statSync(file).isFile()) return next();
      res.setHeader('content-type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
      res.end(readFileSync(file));
    });
  };
  return { name: 'nb2-dir', configureServer: serve, configurePreviewServer: serve };
}

const proxy: Record<string, ProxyOptions> = {
  // first match wins: the trust-base pages before the faucet's /api
  '/api/v1/trustbases': to(gateway),
  '/api': to(faucet),
  '/rpc': to(gateway, '/rpc'),
  '/aggregator': to(gateway),
  '/faucet': to(faucet, '/faucet'),
  ...(env.NB2_DIR ? {} : { '/nb2': to(nb2Files, '/nb2') }),
};

export default defineConfig({
  base: '/demo/',
  // two pages: the wallet (index.html) and the PoS visualizer (pos.html)
  build: { target: 'es2022', sourcemap: true, rollupOptions: { input: { wallet: 'index.html', pos: 'pos.html' } } },
  define: { __NBP_COMMIT__: JSON.stringify(nbpCommit) },
  plugins: env.NB2_DIR ? [nb2Dir(env.NB2_DIR)] : [],
  server: { port: Number(env.PORT ?? 5173), proxy },
  // `vite preview` serves the built bundle with the same routes
  preview: { port: Number(env.PORT ?? 4173), proxy },
});
