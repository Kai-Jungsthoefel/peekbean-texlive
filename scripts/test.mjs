// SPDX-License-Identifier: MIT
// Compiles test documents with the engine, the formats and the bundles of this repository, as Peekbean would.
// node scripts/test.mjs <dir>   Each subdirectory of <dir> is one project: its main .tex file (the one with
// \documentclass) and everything it includes. Writes <dir>/<project>.pdf and prints one line per project.
// Test documents are not part of the repository.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openEngine } from './engine.mjs';

const dir = process.argv[2];
const only = process.argv[3]?.split(',');

function project(p) {
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const f = path.join(d, name);
      if (statSync(f).isDirectory()) walk(f);
      else if (!/\.(aux|log|out|toc|lof|lot|bbl|blg|bcf|run\.xml|synctex(\.gz)?|fls|fdb_latexmk)$/i.test(name)) files[path.relative(p, f).split(path.sep).join('/')] = readFileSync(f);
    }
  };
  walk(p);
  // A PDF next to a .tex of the same name is that document's output, not an input
  for (const f of Object.keys(files)) if (f.endsWith('.pdf') && files[`${f.slice(0, -4)}.tex`]) delete files[f];
  // The main file: named in a manifest.json of the test set, or the top-level .tex with \documentclass
  const named = manifestMain(path.basename(p));
  const main = named && files[named] ? named : Object.keys(files).find((f) => !f.includes('/') && f.endsWith('.tex') && /^[^%\n]*\\documentclass/m.test(files[f].toString('latin1')));
  return { files, main };
}

const engine = await openEngine();
for (const name of readdirSync(dir)) {
  const p = path.join(dir, name);
  if (!statSync(p).isDirectory() || (only && !only.includes(name))) continue;
  const { files, main } = project(p);
  if (!main) continue;
  const src = files[main].toString('latin1');
  const engineName = /\\usepackage(\[[^\]]*\])?\{[^}]*fontspec/.test(src) ? 'xelatex' : 'pdflatex';
  const biblatex = src.match(/\\usepackage(\[[^\]]*\])?\{[^}]*biblatex/);
  const bib = biblatex ? (/backend\s*=\s*bibtex/.test(biblatex[0]) ? 'bibtex8' : 'biber') : /\\bibliography\{/.test(src) ? 'bibtex8' : null;
  const stem = main.slice(0, -4);
  const started = Date.now();
  let work = { ...files };
  const loaded = new Set(['~config', engineName === 'xelatex' ? 'fmt-xelatex' : 'fmt-pdflatex']);
  let last = null;
  const steps = [engineName, ...(bib === 'bibtex8' ? ['bibtex8', engineName] : []), engineName];
  for (const step of steps) {
    // The multi-call engine takes its format name from its own name (busytex), so it is given explicitly
    const fmt = step === 'xelatex' ? 'xetex/xelatex.fmt' : 'pdftex/pdflatex.fmt';
    const args = step === 'bibtex8' ? ['bibtex8', stem]
      : [step, `-progname=${step}`, `-fmt=/texlive/texmf-dist/texmf-var/web2c/${fmt}`, '-interaction=nonstopmode', main];
    const r = await engine.run(args, { bundles: [step === 'xelatex' ? 'fmt-xelatex' : 'fmt-pdflatex', '~config'], files: work, outputs: '*' });
    r.loaded.forEach((b) => loaded.add(b));
    if (process.env.DEBUG) console.error(step, JSON.stringify(r.ms));
    work = { ...work, ...r.outputs };
    if (step !== 'bibtex8') last = r;
  }
  const log = (work[`${stem}.log`] ?? Buffer.alloc(0)).toString('latin1');
  const pages = Number(log.match(/Output written on .*?\((\d+) pages?/)?.[1] ?? 0);
  const errors = [...log.matchAll(/^! .*$/gm)].map((m) => m[0]);
  const pdf = work[`${stem}.pdf`];
  if (pdf) writeFileSync(path.join(dir, `${name}.pdf`), pdf);
  writeFileSync(path.join(dir, `${name}.log`), log);
  if (!pages && process.env.DEBUG) console.error(`${last.stdout.slice(-2500)}\n---\n${last.stderr.slice(-1500)}`);
  const kb = [...loaded].reduce((s, b) => s + (index().bundles[b]?.gz ?? 0), 0) / 1024;
  console.log(JSON.stringify({ project: name, engine: engineName, bib, pages, errors: errors.length, first: (errors[0] ?? '').slice(0, 120), bundles: loaded.size, downloadMB: +(kb / 1024).toFixed(1), seconds: Math.round((Date.now() - started) / 1000), exit: last.exitCode }));
}
await engine.close();

function manifestMain(name) {
  const file = path.join(dir, 'manifest.json');
  manifestMain.cache ??= existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  return manifestMain.cache.find((p) => p.id === name)?.main;
}

function index() {
  return (index.cache ??= JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'texlive', 'index.json'), 'utf8')));
}
