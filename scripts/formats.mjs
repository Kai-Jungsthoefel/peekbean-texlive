// SPDX-License-Identifier: MIT
// The engine and the formats, after scripts/build.mjs:
//   texlive/engine/busytex.js, busytex.part1.wasm, busytex.part2.wasm   the TeX engines (Siglum's busytex build of
//                                     TeX Live 2025, MIT/TeX Live licenses), the WebAssembly split for 25 MiB hosts
//   texlive/bundles/fmt-pdflatex.gz, fmt-xelatex.gz                    formats built by that engine from the bundles
// The formats are built in a browser (scripts/engine.mjs), the way Peekbean runs the engine.
// node scripts/formats.mjs [--cache <dir>]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { openEngine } from './engine.mjs';

const root = path.join(import.meta.dirname, '..');
const out = path.join(root, 'texlive');
const args = process.argv.slice(2);
const cache = args.includes('--cache') ? args[args.indexOf('--cache') + 1] : path.join(os.homedir(), '.cache', 'peekbean-texlive');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const pinned = JSON.parse(readFileSync(path.join(import.meta.dirname, 'engine.json'), 'utf8'));

// ---------- Engine ----------

mkdirSync(path.join(out, 'engine'), { recursive: true });
for (const [name, hash] of Object.entries(pinned.files)) {
  const file = path.join(cache, name);
  if (!existsSync(file)) {
    const res = await fetch(`${pinned.url}/${name}`);
    if (!res.ok) throw new Error(`${res.status} for ${name}`);
    writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
  }
  const data = readFileSync(file);
  if (sha256(data) !== hash) throw new Error(`${name}: checksum does not match engine.json`);
  if (name.endsWith('.wasm')) {
    const half = Math.ceil(data.length / 2);
    writeFileSync(path.join(out, 'engine', 'busytex.part1.wasm'), data.subarray(0, half));
    writeFileSync(path.join(out, 'engine', 'busytex.part2.wasm'), data.subarray(half));
  } else writeFileSync(path.join(out, 'engine', name), data);
}

// ---------- Packages a format needs ----------

const tlpdb = readFileSync(path.join(cache, 'texlive.tlpdb'), 'utf8');
const depends = new Map();
for (const block of tlpdb.split('\n\n')) {
  const name = block.match(/^name (.+)$/m)?.[1];
  if (name) depends.set(name, [...block.matchAll(/^depend (.+)$/gm)].map((m) => m[1]));
}
const forFormats = new Set(['~config']);
const add = (name) => {
  if (forFormats.has(name) || name.includes('.')) return;
  forFormats.add(name);
  if (name.startsWith('collection-')) (depends.get(name) ?? []).forEach(add);
};
['collection-basic', 'collection-latex', 'collection-xetex'].forEach(add);
// Every package that brings hyphenation patterns: language.dat loads them all into the format
for (const block of tlpdb.split('\n\n')) {
  const name = block.match(/^name (.+)$/m)?.[1];
  if (name && /^execute AddHyphen /m.test(block)) add(name);
}
add('hyph-utf8');
const index = JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8'));
const bundles = Object.keys(index.bundles).filter((b) => forFormats.has(b.split('@')[0]));

// ---------- Formats ----------

const engine = await openEngine();
const run = (args, outputs) => engine.run(args, { bundles, outputs });

const FORMATS = [
  // As fmtutil.cnf has them: pdflatex pdftex language.dat -translate-file=cp227.tcx *pdflatex.ini
  { bundle: 'fmt-pdflatex', file: 'texmf-var/web2c/pdftex/pdflatex.fmt', args: ['pdflatex', '-ini', '-jobname=pdflatex', '-progname=pdflatex', '-translate-file=cp227.tcx', '-interaction=nonstopmode', '*pdflatex.ini'], output: 'pdflatex.fmt' },
  // xelatex xetex language.def -etex xelatex.ini
  { bundle: 'fmt-xelatex', file: 'texmf-var/web2c/xetex/xelatex.fmt', args: ['xelatex', '-ini', '-jobname=xelatex', '-progname=xelatex', '-etex', '-interaction=nonstopmode', 'xelatex.ini'], output: 'xelatex.fmt' },
];
for (const f of FORMATS) {
  const r = await run(f.args, [f.output]);
  const data = r.outputs[f.output] ?? null;
  if (r.exitCode !== 0 || !data) {
    console.error(r.stdout.slice(-3000), r.stderr.slice(-2000));
    throw new Error(`${f.output}: exit code ${r.exitCode}`);
  }
  const gz = gzipSync(data, { level: 9 });
  writeFileSync(path.join(out, 'bundles', `${f.bundle}.gz`), gz);
  index.bundles[f.bundle] = { size: data.length, gz: gz.length, files: 1 };
  index.files[f.file] = [f.bundle, 0, data.length];
  console.log(`${f.output}: ${(data.length / 1e6).toFixed(1)} MB`);
}
index.engine = pinned;
writeFileSync(path.join(out, 'index.json'), JSON.stringify(index));
await engine.close();
