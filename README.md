# peekbean-texlive

TeX Live for the LaTeX viewer of [Peekbean](https://github.com/Kai-Jungsthoefel/PEEKBEAN): every package of TeX Live 2025, ready to be loaded into a browser one package at a time, plus the TeX engine and the formats built from exactly these files. Peekbean fetches it at build time and serves it from its own site, so documents are typeset in the browser without anything leaving the device.

## What is in it

| Path | What |
|---|---|
| `texlive/bundles/<package>.gz` | The run files of one TeX Live package, concatenated and gzipped. Packages larger than 2 MiB are split into `<package>~1.gz`, `<package>~2.gz` …: a bundle is fetched whole when TeX first reads one of its files, so a document that uses a few fonts of a large font package loads only their parts. No file is larger than 25 MiB, the limit of static hosts such as Cloudflare Pages. |
| `texlive/bundles/~config~1.gz` … | What `tlmgr` generates on installation: pdfTeX's font map (`pdftex.map`, from all packages' map files, as `updmap` writes it) and the hyphenation configuration (`language.dat`, `language.def`, `language.dat.lua`). |
| `texlive/bundles/fmt-pdflatex.gz`, `fmt-xelatex.gz` | The formats, built by the engine below from these bundles. |
| `texlive/engine/` | The TeX engines compiled to WebAssembly: [Siglum](https://github.com/SiglumProject/siglum-engine)'s build of [busytex](https://github.com/busytex/busytex) (pdfTeX, XeTeX, BibTeX, dvipdfmx …, TeX Live 2025). The WebAssembly is split in two for the same 25 MiB limit. |
| `texlive/index.json` | Every file (path relative to `texmf-dist`) with its bundle and byte range in the unpacked bundle, the bundles' sizes, and where everything came from. |
| `texlive/licenses.json` | Each package's license as the TeX Catalogue records it, with its revision. |

All of TeX Live is included except three collections that are of no use in a browser: `collection-binextra` (programs), `collection-texworks` (an editor) and `collection-context` (ConTeXt, a TeX system of its own). Documentation and sources are left out; only the run files are packed.

## Source

Everything is built from the final TeX Live 2025 snapshot (`tlnet-final`), which never changes, so a build can be repeated exactly:
`https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2025/tlnet-final`. The engine is pinned by checksum in `scripts/engine.json`. The formats must come from the same tree as the packages: a format from another TeX Live state breaks packages with errors deep inside the kernel.

## Building

Requires Node.js 22, `tar` and `xz`, and Microsoft Edge or Google Chrome (`BROWSER=chrome`): the formats are built in a browser, as Peekbean runs the engine.

```sh
npm install
npm run build        # scripts/build.mjs (bundles, index) then scripts/formats.mjs (engine, formats)
```

Downloads (about 2.5 GB of package archives) are kept in `~/.cache/peekbean-texlive`; `--cache <dir>` puts them elsewhere. A first build takes about half an hour, most of it downloading. `node scripts/build.mjs --config-only` writes only the generated configuration again (font map, hyphenation, `ls-R`).

## Testing

```sh
node scripts/test.mjs <dir>
```

compiles every project in the subdirectories of `<dir>` the way Peekbean does: the engine runs in a browser worker (`scripts/engine-worker.js`), every file of the tree is visible at once and its bundle is fetched when TeX first reads it. It writes each PDF and log next to the project and prints pages, errors, the bundles a document needed and their download size. Test documents are not part of this repository.

Two things make the engine fast in a browser and are easy to get wrong: kpathsea must find files through `ls-R` alone (`TEXMF=!!/texlive/texmf-dist`, user trees pointing elsewhere), or every file that does not exist makes it walk the whole tree; and the formats must be passed with `-fmt`, because the multi-call binary would look for `busytex.fmt`.

## Licenses

The scripts in this repository are MIT licensed (`LICENSE`). The files in `texlive/` are TeX Live, redistributed unchanged: see `LICENSE.TL` and `LICENSE.CTAN`, and `texlive/licenses.json` for each package's own license. The engine's licenses are those of TeX Live and the libraries busytex links (see the Siglum and busytex repositories).
