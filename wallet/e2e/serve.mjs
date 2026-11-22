// Serves a built wallet beside a native bridge v2 deployment, with no dependencies (Node 22+): the bundle at /demo/, the deployment's published
// files (GENERATION/bridge/nb2/public/) at /release/, and the gateway's routes the wallet calls on its own origin.
//
//   node e2e/serve.mjs --dist dist --nb2 <public dir> [--port 4173] [--gateway http://127.0.0.1:8545] [--faucet http://127.0.0.1:8088] [--bind 127.0.0.1]
//
//   /demo/*                       dist/ (the build, base /demo/)
//   /release/*                        the deployment's public files
//   /rpc                          the gateway's JSON-RPC (POST /)
//   /aggregator, /api/v1/trustbases   the gateway
//   /faucet/api/*                 the faucet
//
// The gateway keys its rate limits on X-Forwarded-For and refuses a request without one (a production proxy sets it), so this adds one.
import { createServer, request } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const dist = args.dist ?? 'dist';
const nb2 = args.nb2;
const gateway = new URL(args.gateway ?? 'http://127.0.0.1:8545');
const faucet = new URL(args.faucet ?? 'http://127.0.0.1:8088');
const port = Number(args.port ?? 4173);
const bind = args.bind ?? '127.0.0.1';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.cbor': 'application/cbor' };

function staticFile(root, rel, res) {
  const base = resolve(root);
  const file = resolve(base, decodeURIComponent(rel.split('?')[0]));
  const path = relative(base, file);
  if (path === '..' || path.startsWith('../') || isAbsolute(path)) return false;
  let f = file;
  if (existsSync(f) && statSync(f).isDirectory()) f = resolve(f, 'index.html');
  if (!existsSync(f) || !statSync(f).isFile()) return false;
  res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(f));
  return true;
}

function proxy(req, res, target, path) {
  const up = request({ host: target.hostname, port: target.port, path, method: req.method, headers: { ...req.headers, host: target.host, 'x-forwarded-for': '127.0.0.1' } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`upstream: ${e.message}`);
  });
  req.pipe(up);
}

createServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/' || url === '/demo') {
    res.writeHead(302, { location: '/demo/' });
    return res.end();
  }
  if (url.startsWith('/demo/')) {
    if (staticFile(dist, url.slice('/demo/'.length) || 'index.html', res)) return;
  } else if (url.startsWith('/release/') && nb2) {
    if (staticFile(nb2, url.slice('/release/'.length), res)) return;
  } else if (url === '/rpc' || url.startsWith('/rpc?')) return proxy(req, res, gateway, '/');
  else if (url.startsWith('/aggregator') || url.startsWith('/api/v1/trustbases')) return proxy(req, res, gateway, url);
  else if (url.startsWith('/faucet/')) return proxy(req, res, faucet, url.slice('/faucet'.length));
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}).listen(port, bind, () => console.log(`wallet at http://${bind}:${port}/demo/ (gateway ${gateway.origin}, faucet ${faucet.origin}, nb2 files ${nb2 ?? 'none'})`));
