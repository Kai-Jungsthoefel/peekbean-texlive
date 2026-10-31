// SPDX-License-Identifier: MIT
// The engine in a browser without a window (Edge, or Chrome with BROWSER=chrome): a local server for the repository,
// and run() for one engine call in a fresh worker (scripts/engine-worker.js) with the given bundles mounted.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.join(import.meta.dirname, '..');
const TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html' };

export async function openEngine() {
  const server = createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge' });
  const page = await browser.newPage();
  page.setDefaultTimeout(30 * 60 * 1000);
  await page.goto(`http://127.0.0.1:${server.address().port}/scripts/runner.html`);

  /**
   * One engine call. files: { path: Uint8Array } in the working directory; outputs: paths sent back.
   * Returns { exitCode, stdout, stderr, outputs: { path: Buffer } }.
   */
  async function run(args, { bundles, files = {}, outputs = [] }) {
    const plain = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
    const r = await page.evaluate(({ args, bundles, plain, outputs }) => new Promise((resolve) => {
      const decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      // One worker for all runs: it keeps the compiled engine and the unpacked bundles, as Peekbean's would
      const worker = (window.engineWorker ??= new Worker('engine-worker.js'));
      worker.onmessage = (e) => {
        const out = e.data;
        const encoded = {};
        for (const [k, v] of Object.entries(out.outputs)) {
          let s = '';
          for (let i = 0; i < v.length; i += 0x8000) s += String.fromCharCode(...v.subarray(i, i + 0x8000));
          encoded[k] = btoa(s);
        }
        resolve({ ...out, outputs: encoded });
      };
      const files = Object.fromEntries(Object.entries(plain).map(([k, v]) => [k, decode(v)]));
      worker.postMessage({ type: 'run', args, bundles, outputs, files });
    }), { args, bundles, plain, outputs });
    return { ...r, outputs: Object.fromEntries(Object.entries(r.outputs).map(([k, v]) => [k, Buffer.from(v, 'base64')])) };
  }

  return { run, close: async () => { await browser.close(); server.close(); } };
}
