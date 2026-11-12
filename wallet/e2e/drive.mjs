// Drives the demo wallet in headless Chromium over the DevTools protocol (no dependencies; Node 22+ for the global WebSocket).
//
//   node e2e/drive.mjs <wallet url> <tab:command[:arg]>...
//
// <tab> is the wallet profile (a, b, ...: each opens <url>?w=<tab>, with its own key and storage). Commands:
//   connect            wait for the page to connect          addr        print the tab's EVM address
//   step:<key>         run a flow step and print its result  (lock, lockproof, mint, transfer, burn, returnproof, redeem, claim)
//   check:<kind>       old-epoch check (verify | unknown | relabel)
//   fund               "send 0.001 UCT gas" to the other tab   received    print the last received-token status
//   trust              print the trust-base card             captcha     show the faucet widget
//   size | dark        laptop viewport | dark color scheme   shot:<file> PNG screenshot
//   wait:<seconds>     sleep                                 dump        print the page text
//
// Env: CHROME (browser binary), PROFILE_DIR (browser profile; keep it to resume a flow, since keys and tokens live in its localStorage),
// CDP_PORT (default 9333), CONSOLE=1 (echo the page's console).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [base, ...cmds] = process.argv.slice(2);
if (!base) {
  console.error('usage: node e2e/drive.mjs <wallet url> <tab:command[:arg]>...');
  process.exit(2);
}
const port = Number(process.env.CDP_PORT ?? 9333);
const chromeBin = process.env.CHROME ?? '/Applications/Chromium.app/Contents/MacOS/Chromium';
const profile = process.env.PROFILE_DIR ?? join(tmpdir(), 'unicity-demo-e2e-profile');
const chrome = spawn(chromeBin, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; ; i++) {
  try {
    await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    break;
  } catch {
    if (i > 50) throw new Error(`no DevTools endpoint on port ${port} (CHROME=${chromeBin})`);
    await sleep(200);
  }
}

async function openTab(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    } else if (d.method === 'Runtime.consoleAPICalled' && process.env.CONSOLE) {
      console.log('  console:', d.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  };
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Runtime.enable');
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  return { ev, send, close: () => ws.close() };
}

const tabs = {};
const tab = async (p) => (tabs[p] ??= await openTab(`${base}?w=${p}`));
/** the page sets body[data-busy] to the running step's key, '' when idle */
async function idle(t, ms = 600_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await t.ev(`document.body.dataset.busy === ''`)) return;
    await sleep(1000);
  }
  throw new Error('timed out waiting for the page to be idle');
}
const text = (sel) => `(${sel})?.innerText.replace(/\\s+/g, ' ').slice(0, 900)`;
const card = (title) => `[...document.querySelectorAll('section.card')].find((s) => s.querySelector('h2')?.textContent.startsWith(${JSON.stringify(title)}))`;
const clickText = (t, label, prefix = false) =>
  t.ev(`[...document.querySelectorAll('button')].find((b) => ${prefix ? `b.textContent.startsWith(${JSON.stringify(label)})` : `b.textContent === ${JSON.stringify(label)}`}).click()`);
const stepState = (t, k) => t.ev(`(() => { const li = document.querySelector('[data-step=${k}]');
  return li.className + ' | ' + (li.querySelector('.msg')?.textContent ?? '') + ' | ' +
    [...li.querySelectorAll('.explain dl dt')].map((d) => d.textContent + ': ' + d.nextSibling.textContent).join(' ; '); })()`);

let failed = false;
for (const c of cmds) {
  const [p, cmd, arg] = c.split(':');
  const t = await tab(p);
  await sleep(500);
  const t0 = Date.now();
  switch (cmd) {
    case 'connect':
      await sleep(1500);
      await idle(t);
      console.log(p, 'header:', await t.ev(text(`document.querySelector('header')`)));
      break;
    case 'addr':
      console.log(p, 'addr:', await t.ev(`document.querySelector('.facts dd code').title`));
      break;
    case 'step': {
      if (arg === 'transfer') await t.ev(`(() => { const s = document.querySelector('[data-step=transfer] select'); s.value = s.options[0].value; })()`);
      await t.ev(`document.querySelector('[data-step=${arg}] button:not(.link)').click()`);
      await sleep(500);
      await idle(t);
      const st = await stepState(t, arg);
      if (/^step err/.test(st)) failed = true;
      console.log(p, arg, `${Math.round((Date.now() - t0) / 1000)}s:`, st);
      break;
    }
    case 'check':
      await clickText(t, { verify: 'verify stored token', unknown: 'forge: unknown keys', relabel: 'forge: re-labelled epoch' }[arg]);
      await sleep(500);
      await idle(t);
      console.log(p, 'check', arg, ':', await t.ev(text(card('Old-epoch'))));
      break;
    case 'fund':
      await clickText(t, 'send 0.001', true);
      await sleep(500);
      await idle(t);
      console.log(p, 'fund:', await t.ev(text(card('Identity'))));
      break;
    case 'received':
      console.log(p, 'received:', await t.ev(text(`[...document.querySelectorAll('.row')].find((r) => r.querySelector('strong')?.textContent === 'Received')`)) ?? 'nothing');
      break;
    case 'trust':
      console.log(p, 'trust:', await t.ev(text(card('Trust'))));
      break;
    case 'captcha':
      await clickText(t, 'show captcha');
      await sleep(500);
      await idle(t);
      await sleep(3000);
      console.log(p, 'captcha:', await t.ev(`document.querySelector('.captcha iframe') ? 'widget rendered' : 'no widget'`));
      break;
    case 'size':
      await t.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 1500, deviceScaleFactor: 1, mobile: false });
      break;
    case 'dark':
      await t.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      break;
    case 'shot': {
      const r = await t.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
      console.log('screenshot', arg);
      break;
    }
    case 'wait':
      await sleep(Number(arg) * 1000);
      break;
    case 'dump':
      console.log(await t.ev(`document.body.innerText`));
      break;
    default:
      throw new Error(`unknown command ${c}`);
  }
}
for (const t of Object.values(tabs)) t.close();
chrome.kill();
process.exit(failed ? 1 : 0);
