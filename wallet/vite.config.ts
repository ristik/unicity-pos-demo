/**
 * Built to a static bundle served at /demo/ on the network's own origin. `npm run dev` proxies the same-origin routes to upstreams
 * (defaults: ssh -L tunnels to the server's loopback ports, wallet/README.md); BRIDGE_DIR serves a local copy of bridge/public/ instead.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';

const env = process.env;
const gateway = env.UPSTREAM_GATEWAY ?? 'http://127.0.0.1:18545'; // EVM RPC at /, /aggregator, /api/v1/trustbases (bft-core deploy/testnet/gateway.py)
const faucet = env.UPSTREAM_FAUCET ?? 'http://127.0.0.1:18088'; // /api/network, /api/claim
const lockproof = env.UPSTREAM_LOCKPROOF ?? 'http://127.0.0.1:18090'; // dnb-tool lockproof-serve: /v1/lockproof
const bridgeFiles = env.UPSTREAM_BRIDGE ?? 'http://127.0.0.1:18081'; // GENERATION/bridge/public/ over HTTP

// the gateways key their rate limits on X-Forwarded-For and refuse a request without it (nginx sets it in production)
const to = (target: string, strip?: string): ProxyOptions => ({
  target, changeOrigin: true, headers: { 'x-forwarded-for': '127.0.0.1' }, ...(strip ? { rewrite: (p: string) => p.slice(strip.length) || '/' } : {}),
});

/** /bridge/* from a local directory (a copy of GENERATION/bridge/public/), when BRIDGE_DIR is set. */
function bridgeDir(dir: string): Plugin {
  // a hook that returns a function gets it called as a post-middleware hook: return nothing
  const serve = (server: { middlewares: { use: (path: string, fn: (req: { url?: string }, res: { setHeader(k: string, v: string): void; end(b: Uint8Array): void }, next: () => void) => void) => unknown } }): void => {
    server.middlewares.use('/bridge', (req, res, next) => {
      const file = normalize(join(dir, decodeURIComponent((req.url ?? '/').split('?')[0])));
      if (!file.startsWith(normalize(dir)) || !existsSync(file) || !statSync(file).isFile()) return next();
      res.setHeader('content-type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
      res.end(readFileSync(file));
    });
  };
  return { name: 'bridge-dir', configureServer: serve, configurePreviewServer: serve };
}

const proxy: Record<string, ProxyOptions> = {
  // first match wins: the trust-base pages before the faucet's /api
  '/api/v1/trustbases': to(gateway),
  '/api': to(faucet),
  '/rpc': to(gateway, '/rpc'),
  '/aggregator': to(gateway),
  '/lockproof': to(lockproof, '/lockproof'),
  '/faucet': to(faucet, '/faucet'),
  ...(env.BRIDGE_DIR ? {} : { '/bridge': to(bridgeFiles, '/bridge') }),
};

export default defineConfig({
  base: '/demo/',
  // two pages: the wallet (index.html) and the PoS visualizer (pos.html)
  build: { target: 'es2022', sourcemap: true, rollupOptions: { input: { wallet: 'index.html', pos: 'pos.html' } } },
  plugins: env.BRIDGE_DIR ? [bridgeDir(env.BRIDGE_DIR)] : [],
  server: { port: Number(env.PORT ?? 5173), proxy },
  // `vite preview` serves the built bundle with the same routes
  preview: { port: Number(env.PORT ?? 4173), proxy },
});
