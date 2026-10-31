// SPDX-License-Identifier: MIT
// Builds the TeX Live tree for Peekbean's LaTeX viewer from the final TeX Live 2025 snapshot, which never changes:
//
//   texlive/bundles/<package>.gz      the run files of one TeX Live package, concatenated and gzipped; packages over
//                                     24 MiB compressed are split into <package>~1.gz, <package>~2.gz …
//   texlive/index.json                every file: its bundle and byte range in the unpacked bundle
//   texlive/licenses.json             each package's license as TeX Live's catalogue records it
//
// What tlmgr would generate on installation is generated here and goes into the bundle "~config": the font map of
// pdfTeX (from the packages' addMap/addMixedMap entries, as updmap does) and the hyphenation configuration
// (language.dat, language.def, language.dat.lua from the AddHyphen entries).
//
// node scripts/build.mjs [--cache <dir>] [--only pkg1,pkg2]
// Downloads (about 2.5 GB) are kept in the cache directory, by default ~/.cache/peekbean-texlive.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const SNAPSHOT = 'https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2025/tlnet-final';
/** Collections that are of no use in a browser: programs and editors, and ConTeXt, a TeX system of its own */
const LEFT_OUT = new Set(['collection-binextra', 'collection-context', 'collection-texworks']);
/** Cloudflare Pages serves files up to 25 MiB */
const MAX_BUNDLE = 24 * 1024 * 1024;

const root = path.join(import.meta.dirname, '..');
const out = path.join(root, 'texlive');
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const cache = arg('--cache') ?? path.join(os.homedir(), '.cache', 'peekbean-texlive');
const only = arg('--only')?.split(',');

mkdirSync(path.join(cache, 'archive'), { recursive: true });

async function download(url, file) {
  if (existsSync(file)) return;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} for ${url}`);
      writeFileSync(`${file}.part`, new Uint8Array(await res.arrayBuffer()));
      renameSync(`${file}.part`, file);
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// ---------- Package database ----------

const tlpdbFile = path.join(cache, 'texlive.tlpdb');
if (!existsSync(tlpdbFile)) {
  await download(`${SNAPSHOT}/tlpkg/texlive.tlpdb.xz`, `${tlpdbFile}.xz`);
  writeFileSync(tlpdbFile, execFileSync('xz', ['-dc', `${tlpdbFile}.xz`], { maxBuffer: 1 << 30 }));
}

/** name → { category, depends, runfiles, executes, license, revision } */
const db = new Map();
for (const block of readFileSync(tlpdbFile, 'utf8').split('\n\n')) {
  const lines = block.split('\n');
  const name = lines.find((l) => l.startsWith('name '))?.slice(5);
  if (!name) continue;
  const p = { category: '', depends: [], runfiles: [], executes: [], license: '', revision: '' };
  let section = '';
  for (const l of lines) {
    if (l.startsWith(' ')) {
      if (section === 'run') p.runfiles.push(l.trim().split(' ')[0]);
      continue;
    }
    section = l.startsWith('runfiles ') ? 'run' : '';
    if (l.startsWith('category ')) p.category = l.slice(9);
    else if (l.startsWith('depend ')) p.depends.push(l.slice(7));
    else if (l.startsWith('execute ')) p.executes.push(l.slice(8));
    else if (l.startsWith('catalogue-license ')) p.license = l.slice(18);
    else if (l.startsWith('revision ')) p.revision = l.slice(9);
  }
  db.set(name, p);
}

// Everything scheme-full pulls in, except the collections left out (and what only they pull in)
const selected = new Set();
const visit = (name) => {
  const p = db.get(name);
  if (!p || selected.has(name) || LEFT_OUT.has(name) || name.includes('.')) return;
  selected.add(name);
  p.depends.forEach(visit);
};
visit('scheme-full');
const packages = [...selected].filter((n) => !['Scheme', 'Collection'].includes(db.get(n).category) && db.get(n).runfiles.length)
  .filter((n) => !only || only.includes(n)).sort();
console.log(`${packages.length} packages with run files`);

// ---------- Bundles ----------

// --config-only: keep the package bundles (and formats) of the last build, write the generated configuration again
const configOnly = args.includes('--config-only');
const previous = configOnly ? JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8')) : null;
if (!configOnly) {
  rmSync(path.join(out, 'bundles'), { recursive: true, force: true });
  mkdirSync(path.join(out, 'bundles'), { recursive: true });
}
/** texmf-dist relative path → [bundle, start, end] */
const index = previous ? Object.fromEntries(Object.entries(previous.files).filter(([, [b]]) => !b.startsWith('~config'))) : {};
const bundles = previous ? Object.fromEntries(Object.entries(previous.bundles).filter(([b]) => !b.startsWith('~config'))) : {};
const licenses = previous ? JSON.parse(readFileSync(path.join(out, 'licenses.json'), 'utf8')) : {};
const tree = path.join(cache, 'tree');

function writeBundle(name, files) {
  // files: [relative path, Buffer]; split when the compressed bundle would be too large
  const parts = [];
  let current = [], size = 0;
  for (const f of files) {
    if (current.length && size + f[1].length > MAX_BUNDLE * 2.5) { parts.push(current); current = []; size = 0; }
    current.push(f);
    size += f[1].length;
  }
  if (current.length) parts.push(current);
  const written = [];
  const pack = (list) => {
    let offset = 0;
    const entries = list.map(([rel, data]) => { const e = [rel, offset, offset + data.length]; offset += data.length; return e; });
    const gz = gzipSync(Buffer.concat(list.map((f) => f[1])), { level: 9 });
    if (gz.length > MAX_BUNDLE && list.length > 1) {
      const half = Math.ceil(list.length / 2);
      return [...pack(list.slice(0, half)), ...pack(list.slice(half))];
    }
    return [{ entries, gz, raw: offset }];
  };
  for (const part of parts) written.push(...pack(part));
  written.forEach((w, i) => {
    const bundle = written.length === 1 ? name : `${name}~${i + 1}`;
    if (w.gz.length > 25 * 1024 * 1024) throw new Error(`${bundle}: a single file is larger than 25 MiB compressed`);
    writeFileSync(path.join(out, 'bundles', `${bundle}.gz`), w.gz);
    bundles[bundle] = { size: w.raw, gz: w.gz.length, files: w.entries.length };
    for (const [rel, start, end] of w.entries) index[rel] = [bundle, start, end];
  });
}

let done = 0;
for (const name of configOnly ? [] : packages) {
  const p = db.get(name);
  const archive = path.join(cache, 'archive', `${name}.tar.xz`);
  await download(`${SNAPSHOT}/archive/${name}.tar.xz`, archive);
  const dir = path.join(tree, name);
  if (!existsSync(path.join(dir, '.done'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['--force-local', '-xJf', archive], { cwd: dir });
    writeFileSync(path.join(dir, '.done'), '');
  }
  // Relocatable packages (RELOC/…) unpack without the texmf-dist prefix
  const files = p.runfiles.filter((f) => f.startsWith('RELOC/') || f.startsWith('texmf-dist/'))
    .map((f) => (f.startsWith('RELOC/') ? [f.slice(6), path.join(dir, f.slice(6))] : [f.slice(11), path.join(dir, f)]))
    .filter(([, file]) => existsSync(file) && statSync(file).isFile())
    .map(([rel, file]) => [rel, readFileSync(file)]);
  if (files.length) writeBundle(name, files);
  licenses[name] = { license: p.license || 'unknown', revision: p.revision };
  if (++done % 200 === 0) console.log(`${done} of ${packages.length}`);
}

// ---------- Generated configuration ----------

const read = (rel) => {
  const hit = index[rel];
  if (!hit) return null;
  const dir = path.join(tree, hit[0].split('~')[0]);
  const file = [path.join(dir, rel), path.join(dir, 'texmf-dist', rel)].find((f) => existsSync(f));
  return file ? readFileSync(file) : null;
};
const findMap = (map) => Object.keys(index).find((rel) => rel.startsWith('fonts/map/') && rel.endsWith(`/${map}`));

// pdfTeX's font map, as updmap writes it: all Map and MixedMap files of the installed packages
const maps = [];
const hyphens = [];
for (const name of packages) {
  for (const e of db.get(name).executes) {
    const m = e.match(/^add(Mixed)?Map (\S+)/);
    if (m) maps.push(m[2]);
    // Fields are separated by tabs; a field may be empty (file_exceptions=)
    if (e.startsWith('AddHyphen ')) hyphens.push(Object.fromEntries(e.slice(10).trim().split(/\s+/).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])));
  }
}
const mapText = [];
for (const map of [...new Set(maps)]) {
  const rel = findMap(map);
  const data = rel && read(rel);
  if (data) mapText.push(`% ${map}\n${data.toString('latin1')}`);
}

// Hyphenation: language.dat (pdfTeX, XeTeX), language.def (eTeX) and language.dat.lua (LuaTeX), as tlmgr writes them
const dat = ['% language.dat for Peekbean, generated from the AddHyphen entries of TeX Live', 'english hyphen.tex', '=usenglish', '=USenglish', '=american'];
const def = ['%% language.def for Peekbean', '\\addlanguage{USenglish}{hyphen}{}{2}{3}', '\\addlanguage{english}{hyphen}{}{2}{3}'];
const lua = ['return {', '  ["english"] = { loader = "hyphen.tex", patterns = "hyph-en-us.pat.txt", hyphenation = "hyph-en-us.hyp.txt", lefthyphenmin = 2, righthyphenmin = 3, synonyms = { "usenglish", "USenglish", "american" } },'];
for (const h of hyphens) {
  if (!h.name || h.name === 'english') continue;
  const synonyms = (h.synonyms ?? '').split(',').filter(Boolean);
  dat.push(`${h.name} ${h.file}`, ...synonyms.map((s) => `=${s}`));
  for (const n of [h.name, ...synonyms]) def.push(`\\addlanguage{${n}}{${h.file}}{${h.file_exceptions ?? ''}}{${h.lefthyphenmin ?? 2}}{${h.righthyphenmin ?? 3}}`);
  const lfile = (f) => (f ? `"${f}"` : 'nil');
  lua.push(`  ["${h.name}"] = { loader = "${h.file}", patterns = ${lfile(h.file_patterns)}, hyphenation = ${lfile(h.file_exceptions)}, lefthyphenmin = ${h.lefthyphenmin ?? 2}, righthyphenmin = ${h.righthyphenmin ?? 3}, synonyms = { ${synonyms.map((s) => `"${s}"`).join(', ')} } },`);
}
lua.push('}');

const config = [
  ['fonts/map/pdftex/updmap/pdftex.map', Buffer.from(mapText.join('\n'), 'latin1')],
  ['tex/generic/config/language.dat', Buffer.from(`${dat.join('\n')}\n`)],
  ['tex/generic/config/language.def', Buffer.from(`${def.join('\n')}\n\\uselanguage{USenglish}\n`)],
  ['tex/generic/config/language.dat.lua', Buffer.from(`${lua.join('\n')}\n`)],
];

// ls-R, kpathsea's file name database: without it every search walks the whole tree (a minute per run in tests)
const FORMATS = ['texmf-var/web2c/pdftex/pdflatex.fmt', 'texmf-var/web2c/xetex/xelatex.fmt'];
const listed = [...Object.keys(index), ...config.map(([rel]) => rel), ...FORMATS, 'ls-R'];
const dirs = new Map([['.', new Set()]]);
for (const rel of listed) {
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    const parent = i ? `./${parts.slice(0, i).join('/')}` : '.';
    if (!dirs.has(parent)) dirs.set(parent, new Set());
    dirs.get(parent).add(parts[i]);
  }
}
const lsR = ['% ls-R -- filename database for kpathsea; do not change this line.'];
for (const [dir, names] of [...dirs].sort(([a], [b]) => (a < b ? -1 : 1))) lsR.push('', `${dir}:`, ...[...names].sort());
config.push(['ls-R', Buffer.from(`${lsR.join('\n')}\n`)]);
writeBundle('~config', config);

// ---------- Index ----------

const sha = createHash('sha256').update(readFileSync(tlpdbFile)).digest('hex').slice(0, 16);
writeFileSync(path.join(out, 'index.json'), JSON.stringify({
  texlive: '2025 (tlnet-final)', source: SNAPSHOT, tlpdb: sha, packages: packages.length, bundles, files: index,
}));
writeFileSync(path.join(out, 'licenses.json'), JSON.stringify(licenses, null, 1));
const total = Object.values(bundles).reduce((s, b) => s + b.gz, 0);
console.log(`${Object.keys(bundles).length} bundles, ${Object.keys(index).length} files, ${(total / 1e9).toFixed(2)} GB compressed`);
