/** Plain-DOM helpers: an element builder and the "explain" drawer of a step's trace. */
import { short } from './hex.js';
import type { Call, Trace } from './trace.js';

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const mono = (s: string, full = false): HTMLElement => h('code', { title: s }, full ? s : short(s, 10));

export function copyable(s: string): HTMLElement {
  return h('span', { class: 'copy' }, mono(s), h('button', { class: 'icon', title: 'copy', onclick: () => void navigator.clipboard?.writeText(s) }, '⧉'));
}

const kb = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);

/** Consecutive identical calls (polls) shown as one row with a count. */
function grouped(calls: Call[]): { c: Call; n: number; ms: number }[] {
  const out: { c: Call; n: number; ms: number }[] = [];
  for (const c of calls) {
    const last = out.at(-1);
    if (last && last.c.method === c.method && last.c.url === c.url && last.c.status === c.status && last.c.params === c.params) {
      last.n++;
      last.ms += c.ms;
      last.c = c;
    } else out.push({ c, n: 1, ms: c.ms });
  }
  return out;
}

export function explain(t: Trace | undefined): HTMLElement {
  if (!t) return h('p', { class: 'muted' }, 'Not run yet.');
  const facts = h('dl', { class: 'facts' }, ...t.facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, /^0x[0-9a-f]{40,}$/i.test(v) || /^[0-9a-f]{64,}$/i.test(v) ? copyable(v) : v)]));
  const rows = grouped(t.calls).map(({ c, n, ms }) =>
    h('tr', {},
      h('td', {}, h('code', {}, c.method), n > 1 ? h('span', { class: 'muted' }, ` ×${n}`) : ''),
      h('td', {}, h('code', {}, c.url.split('?')[0])),
      h('td', { class: c.status >= 400 || c.status === 0 ? 'bad' : '' }, String(c.status || '—')),
      h('td', { class: 'num' }, kb(c.reqBytes)),
      h('td', { class: 'num' }, kb(c.resBytes)),
      h('td', { class: 'num' }, `${Math.round(n > 1 ? ms / n : ms)} ms${n > 1 ? ' avg' : ''}`),
    ));
  const detail = t.calls.filter((c) => c.params || c.result).slice(-6).map((c) =>
    h('details', {}, h('summary', {}, h('code', {}, c.method), ` → ${c.status}`), c.params ? h('pre', {}, `params ${c.params}`) : '', c.result ? h('pre', {}, c.result) : ''));
  return h('div', { class: 'explain' },
    h('p', { class: 'muted' }, `${t.calls.length} requests, ${Math.round(t.ms ?? 0)} ms`),
    facts,
    rows.length ? h('table', { class: 'calls' }, h('thead', {}, h('tr', {}, ...['method', 'path', 'status', 'sent', 'received', 'time'].map((x) => h('th', {}, x)))), h('tbody', {}, ...rows)) : '',
    detail.length ? h('div', { class: 'raw' }, h('p', { class: 'muted' }, 'last requests, raw'), ...detail) : '',
  );
}
