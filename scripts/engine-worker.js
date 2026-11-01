// SPDX-License-Identifier: MIT
// Runs the TeX engine (busytex.js / busytex.wasm) in a worker. Every file of texlive/index.json appears in the engine's
// file system at once; its bundle is fetched and unpacked only when TeX first reads it (a synchronous request, which
// workers may make). Used by scripts/formats.mjs and scripts/test.mjs.
//
// Messages: { type: 'run', args, bundles, files, outputs } → { type: 'done', exitCode, stdout, stderr, outputs, loaded }
//   bundles: loaded before the run (all others on demand); files: { path: Uint8Array } in the working directory;
//   outputs: paths whose content is sent back; loaded: the bundles the run needed.
importScripts('../node_modules/fflate/umd/index.js');

let index = null;
const unpacked = new Map();
let wasm = null;
let scriptLoaded = false;

function bundleSync(name) {
  let data = unpacked.get(name);
  if (!data) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `../texlive/bundles/${encodeURIComponent(name)}.gz`, false);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    if (xhr.status !== 200) throw new Error(`bundle ${name}: ${xhr.status}`);
    data = self.fflate.gunzipSync(new Uint8Array(xhr.response));
    unpacked.set(name, data);
  }
  return data;
}

/** A fresh engine for every run: pdfTeX keeps state in C globals that do not reset between runs */
async function engine() {
  if (!wasm) {
    const parts = await Promise.all(['busytex.part1.wasm', 'busytex.part2.wasm'].map(async (p) => new Uint8Array(await (await fetch(`../texlive/engine/${p}`)).arrayBuffer())));
    const bytes = new Uint8Array(parts[0].length + parts[1].length);
    bytes.set(parts[0]);
    bytes.set(parts[1], parts[0].length);
    wasm = await WebAssembly.compile(bytes);
  }
  if (!scriptLoaded) {
    importScripts('../texlive/engine/busytex.js');
    scriptLoaded = true;
  }
  const out = { stdout: [], stderr: [] };
  const config = {
    thisProgram: '/bin/busytex',
    noInitialRun: true,
    noExitRuntime: true,
    instantiateWasm: (imports, ok) => {
      WebAssembly.instantiate(wasm, imports).then((instance) => ok(instance));
      return {};
    },
    print: (t) => out.stdout.push(t),
    printErr: (t) => out.stderr.push(t),
    locateFile: (p) => p,
    preRun: [() => {
      const ENV = (config.ENV ??= {});
      // The tree is searched through its ls-R only (!!): a tree searched on disk is walked on every file that is
      // not there, and packages probe for many optional files. The user's trees point to nothing.
      Object.assign(ENV, {
        TEXMFCNF: '/texlive/texmf-dist/web2c', TEXMFROOT: '/texlive', TEXMFDIST: '/texlive/texmf-dist',
        TEXMFSYSVAR: '/texlive/texmf-dist/texmf-var', TEXMFSYSCONFIG: '/texlive/texmf-dist', TEXMFLOCAL: '/texlive/texmf-dist',
        TEXMFVAR: '/user/texmf-var', TEXMFHOME: '/user/texmf', TEXMFCONFIG: '/user/texmf-config',
        TEXMF: '!!/texlive/texmf-dist', TEXMFDOTDIR: '.',
      });
    }],
  };
  const module = await self.busytex(config);
  return { module, out };
}

/** The tree: directories now, file contents when first read */
function mountTree(FS, loaded) {
  const dirs = new Set();
  for (const [rel, [name, start, end]] of Object.entries(index.files)) {
    const file = `/texlive/texmf-dist/${rel}`;
    const dir = file.slice(0, file.lastIndexOf('/'));
    if (!dirs.has(dir)) { FS.mkdirTree(dir); dirs.add(dir); }
    const node = FS.createFile(dir, file.slice(dir.length + 1), {}, true, false);
    let data = null;
    Object.defineProperties(node, {
      contents: {
        get: () => {
          if (!data) { data = bundleSync(name).subarray(start, end); loaded.add(name); }
          return data;
        },
        set: () => {},
        configurable: true,
      },
      usedBytes: { get: () => end - start, set: () => {}, configurable: true },
    });
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    index ??= await (await fetch('../texlive/index.json')).json();
    const t0 = performance.now();
    const { module, out } = await engine();
    const t1 = performance.now();
    const FS = module.FS;
    const loaded = new Set();
    if (msg.reset) unpacked.clear();
    // A package's name means all its parts (~config@1, ~config@2 …)
    for (const name of msg.bundles ?? []) {
      for (const part of index.bundles[name] ? [name] : Object.keys(index.bundles).filter((b) => b.startsWith(`${name}@`))) bundleSync(part);
    }
    mountTree(FS, loaded);
    const t2 = performance.now();
    FS.mkdirTree('/work');
    // Input files: given, or fetched from URLs (large projects)
    const inputs = { ...(msg.files ?? {}) };
    for (const [p, url] of Object.entries(msg.fileUrls ?? {})) inputs[p] = new Uint8Array(await (await fetch(url)).arrayBuffer());
    for (const [p, content] of Object.entries(inputs)) {
      const file = `/work/${p}`;
      FS.mkdirTree(file.slice(0, file.lastIndexOf('/')));
      FS.writeFile(file, content);
    }
    FS.chdir('/work');
    try { FS.mkdir('/bin'); FS.writeFile('/bin/busytex', ''); } catch {}
    module.thisProgram = `/bin/${msg.args[0]}`;
    const exitCode = module.callMain(msg.args);
    const t3 = performance.now();
    module._flush_streams?.();
    // outputs '*': every file the run wrote (aux, bbl …) for the next run of a document
    const outputs = {};
    const wanted = msg.outputs === '*' ? [] : msg.outputs ?? [];
    if (msg.outputs === '*') {
      const walk = (dir) => {
        for (const name of FS.readdir(dir)) {
          if (name === '.' || name === '..') continue;
          const p = `${dir}/${name}`;
          if (FS.isDir(FS.stat(p).mode)) walk(p);
          else if (!(p.slice(6) in (msg.fileUrls ?? {}))) wanted.push(p.slice(6));
        }
      };
      walk('/work');
    }
    for (const p of wanted) {
      try { outputs[p] = FS.readFile(`/work/${p}`); } catch {}
    }
    self.postMessage({ type: 'done', exitCode, stdout: out.stdout.join('\n'), stderr: out.stderr.join('\n'), outputs, loaded: [...loaded], ms: { engine: Math.round(t1 - t0), mount: Math.round(t2 - t1), run: Math.round(t3 - t2) } });
  } catch (error) {
    self.postMessage({ type: 'done', exitCode: -1, stdout: '', stderr: String(error?.stack ?? error), outputs: {}, loaded: [] });
  }
};
