# PoC: reference-only preview builds for p5.js PRs (processing/p5.js#9303)

Branch: `poc/reference-only-build` (not committed, per scope). All numbers measured
2026-10-18 on this machine: 8 threads, 7.4 GB RAM, Node v24.18.0, Astro 6.3.8,
`concurrency: 2` (repo's `astro.config.mjs` default), compression skipped
(`SKIP_BUILD_COMPRESS=1`) in every run.

## Headline numbers

| Stage | Command | Time | Pages | dist size |
|---|---|---|---|---|
| Baseline `build:reference` (clone + install + docs) | `npm run build:reference` | **1m47s** | — (905 MDX) | — |
| `build:reference` from pre-built data.json | `P5_DATA_JSON_PATH=<path> npm run build:reference` | **0m18s** | — (905 MDX, byte-identical) | — |
| Baseline full site build | `NODE_OPTIONS=--max-old-space-size=4096 SKIP_BUILD_COMPRESS=1 npx astro build` | **17m09s** | 6,371 | 502 MB |
| Reference-only build | `NODE_OPTIONS=--max-old-space-size=4096 SKIP_BUILD_COMPRESS=1 npm run build:reference-only` | **9m06s** | 1,664 | 224 MB |
| Reference-only, no lowercase aliases | same + `REFERENCE_SKIP_LOWERCASE=1` | **8m20s** | 907 | 187 MB |

End-to-end for a PR preview: today's path costs ~19m (1m47s parser + 17m09s build)
on this machine; the PoC path (data.json handed over from the PR's existing p5
build + reference-only site build) costs ~9.5m (18s + 9m06s). **Roughly a 2x
wall-clock cut, and the p5.js clone + `npm install` + network dependency in the
website build disappears entirely.**

## What was measured and how

- Page breakdown of the full build: reference pages are **~5,360 of 6,371 pages**
  (1,664 English under `/reference/**`, plus ~924 per locale x 4 under
  `/{locale}/reference/`). The English reference-only build is 26% of the pages
  but still 53% of the build time — per-page render cost is not uniform, and
  ~2m22s of the run is fixed bundling overhead before any page renders.
- The lowercase alias duplication (`/reference/p5/loadImage/` +
  `/reference/p5/loadimage/`) nearly doubles reference page count (1,664 vs 907)
  but costs only ~45s of build time, because the expensive work (collection loads,
  `getStaticPaths`) is shared. It's worth skipping in previews for dist size and
  deploy-upload time more than for build time.

## Changes made (all opt-in via env vars; default behavior unchanged)

1. **`src/scripts/parsers/reference.ts`** — if `P5_DATA_JSON_PATH` is set, copy
   that file to `out/data-p5/data.json` (where `getYuidocOutput()` reads it) and
   skip cloning p5.js / `npm install` / `npm run docs`. p5.sound handling is
   untouched. Verified: MDX output from a hand-built
   `data.json` (p5.js v2.3.3, `npm install && npm run docs`) is **byte-identical**
   across all 905 files to the clone-path output (`md5sum` over
   `src/content/reference/en/**`).
2. **`src/scripts/referenceOnlyBuild.ts`** (new) + `npm run build:reference-only` —
   Astro 6.3.8 has no route-exclusion config (checked the config schema), so the
   wrapper temporarily moves everything in `src/pages` except `reference/`,
   `_utils.ts`, `_utils-node.ts` to a stash dir, runs `astro build` with
   `REFERENCE_ONLY=1`, and restores in a `finally`. This removes static and
   dynamic routes alike without touching 34 `getStaticPaths` implementations.
3. **`astro.config.mjs`** — `REFERENCE_ONLY=1` drops the `astrojs-service-worker`
   integration (it globs/precaches the whole dist; pointless for a preview).
4. **`src/pages/reference/[...id].astro`** — `REFERENCE_SKIP_LOWERCASE=1` skips
   emitting the lowercase alias of every reference route.
5. **`src/pages/_utils-node.ts`** — changed `from "fs"` / `"fs/promises"` to
   `node:`-prefixed imports. Without this, `astro build` **fails on current main**
   in this environment (`[commonjs--resolver] Failed to resolve entry for package
   "fs"` from Vite 7). Pre-existing bug, verified on a clean tree; worth
   upstreaming regardless of this PoC.

## What broke / surprises

- `astro build` on unmodified main failed twice before producing a baseline:
  the bare-`fs` import above, and **OOM at Node's default ~2 GB heap** after the
  bundling phase. CI for this site needs `NODE_OPTIONS=--max-old-space-size=4096`
  (or more) for the full build; the reference-only build completed under the same
  setting but was not tested at default heap.
- `build:reference` re-clones `p5.sound.js@main` (twice, in fact) on every run and
  re-runs yuidoc, so `public/reference/data.json` churns between *any* two runs —
  only the MDX output is stable. Preview fidelity should be judged on MDX/HTML,
  not that file.
- The p5.js side is cheap now: clone + install + docs for v2.3.3 took under 2
  minutes total. The dominant cost is Astro rendering, not docs generation —
  so `P5_DATA_JSON_PATH` saves less wall-clock than expected (it mostly buys
  hermeticity: no network, no second p5 build in the website job, and the PR's
  CI already has this artifact).

## Fidelity of reference-only output

Compared all 1,664 `/reference/**` HTML pages between the full-site baseline and
the reference-only build. After normalizing three expected cosmetic classes of
difference — (a) the removed service-worker registration snippet, (b)
content-hashed `/_astro/*` chunk URLs, preact island ids, and minifier local-name
churn, all of which change whenever the page graph changes — **every page is
identical except for one real difference**: the settings drawer `<aside>` carries
`noJumpTo` in the reference-only build and not in the baseline.

That difference is an **upstream hidden-coupling bug, not an artifact of this
PoC**: `src/components/Settings/index.astro` reads the *module-level mutable*
`jumpToState` from `src/globals/state.ts`, but reference pages only pass jump-to
state down via props (`BaseLayout` → `Nav`) and never call `setJumpToState`. In a
full build, Settings sees a stale global left behind by whichever unrelated page
rendered earlier (with `concurrency: 2`, that's render-order dependent — the
deployed site's output is nondeterministic here). In a reference-only build the
global is never set, so the class appears. The honest fix is passing
`jumpToState` into Settings as a prop; any route-filtering approach will hit this.

Spot-checks over `npx astro preview`: `/reference/`, `/reference/p5/loadImage/`
(+ lowercase alias), `/reference/p5.Vector/add/`,
`/reference/p5.sound/p5.Oscillator/`, `/reference/p5/setup/` all 200 with correct
content; every `/_astro/*` asset referenced by a sampled page resolves; `/about/`
and `/tutorials/` 404 as intended.

## Hidden couplings / caveats for maintainers

- Reference pages don't just need the `reference` collection: `BaseLayout` loads
  the `pages` collection, `Settings` loads `top-banner`, `Footer` loads `banner`,
  and the i18n layer reads `src/content/ui/*.yaml` from disk. All still present in
  this mode, but any future "build the reference in isolation" work inherits them.
- `src/globals/state.ts` module state (above) makes page output order-dependent;
  it's the one place where "which other pages built" leaks into reference HTML.
- The wrapper moves files in `src/pages`; don't run it concurrently with a dev
  server or another build. A crash mid-build is handled (`finally` restores), but
  `kill -9` would leave pages in `.reference-only-pages-stash/` to move back.
- All of `public/` (fonts, images, models, videos, ~45 MB) is copied into every
  dist regardless of routes; most of the remaining reference-only dist size is the
  HTML itself (~100 KB/page before compression — each page inlines full example
  code for its CodeEmbed islands).
- There is no sitemap integration in this repo, and search indices are a separate
  `build:search` step (not run here); neither blocks a reference-only preview.

## Honest assessment: the biggest lever

Dropping the 4 localized reference sets (~3,700 pages) is the single biggest win,
and English-only reference is what #9303 asks for anyway. The second lever is the
fixed per-page render cost: 1,664 pages still take ~6.5 min to render at
`concurrency: 2` on 8 threads — raising Astro's `build.concurrency` for the
preview build is untested here but is the obvious next experiment. The
`P5_DATA_JSON_PATH` handoff is worth doing regardless of speed: it makes the
preview hermetic and reuses an artifact the PR's CI already builds. The lowercase
toggle matters for deploy size, not build time. A realistic CI preview on better
hardware than this laptop should land well under the ~9 minutes measured here.

## Artifacts kept for inspection (not for commit)

- `.poc/baseline-build-reference.log`, `.poc/datajson-build-reference.log`,
  `.poc/refonly-build.log`, `.poc/refonly-nolower-build.log` — timed run logs
- `.poc/baseline-mdx.md5`, `.poc/datajson-mdx.md5` — identical checksum sets
- `.poc/dist-full-baseline/` (502 MB), `dist/` (reference-only, 224 MB),
  `.poc/dist-refonly-nolower/` (187 MB) — delete when done
- `.poc/baseline-pages.txt` — full-page inventory of the baseline build

## Follow-up

### Build concurrency sweep (laptop, 8 threads / 7.4 GB RAM)

`astro.config.mjs` now reads `ASTRO_BUILD_CONCURRENCY` (default stays 2).
Reference-only build, `REFERENCE_SKIP_LOWERCASE=1`, `SKIP_BUILD_COMPRESS=1`,
4 GB heap, measured with `/usr/bin/time -v`:

| concurrency | wall time | peak RSS |
| --- | --- | --- |
| 2 | 9m38s | 3.26 GB |
| 4 | 9m36s | 3.43 GB |
| 8 | 10m23s | 3.18 GB |

No benefit: 4 ≈ 2 and 8 is slower. The page-render phase itself barely moves
(9m27s vs 9m24s at 2 vs 4), consistent with the work being CPU-bound inside a
single V8 isolate. Output is unaffected: raw HTML md5s differ between any two
runs (~300/907 pages) because of the render-order-dependent
`data-preact-island-id` counter, but after normalizing island ids, hashed asset
names, and inline-script contents, the conc-2 and conc-8 dists are 907/907
identical. Caveat: measured on a noisy laptop (~2 GB free RAM); treat the
ordering, not the absolute times, as the result.

### Default heap: the build does not survive without NODE_OPTIONS

Reference-only build at concurrency 4 with no `NODE_OPTIONS`: crashes after
~3 min with `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation
failed - JavaScript heap out of memory` (RSS ~3.1 GB at death; default heap cap
is ~2 GB on this Node 24). The existing `deploy.yml` sets no heap flag either,
so any CI job running this build must export
`NODE_OPTIONS=--max-old-space-size=4096`. Log: `.poc/heap-default.log`.

### Upstream finding: `SKIP_BUILD_COMPRESS` is a dead flag on main

`astro.config.mjs` computes `shouldSkipCompress` and logs "WILL SKIP COMPRESS
BUILD STEP", but the value is never used: the `fast()` compression integration
(`src/scripts/fast-compress.ts`) runs unconditionally. All timings in this
document therefore include compression, consistently. Candidate third fix PR
(not branched here; the brief covered two).

### Fix branches (ready; no PRs opened)

**`fix/node-fs-import`** (one commit, `c7475f1f1`): `src/pages/_utils-node.ts`
imported `"fs"`/`"fs/promises"` bare, which Vite's `commonjs--resolver` fails to
resolve during `astro build` on a clean main (`Failed to resolve entry for
package "fs"`); the branch switches them to the `node:fs`/`node:fs/promises`
specifiers. Verified: full `astro build` on this branch exits 0 and builds all
6,371 pages (20m25s on the laptop; clean main does not build at all).

**`fix/settings-jump-to-prop`** (one commit, `bb2a1c645`): `Settings/index.astro`
read the mutable global `jumpToState` from `src/globals/state.ts`, which only
`AboutLayout` ever set, so whether a page's Settings aside got the `noJumpTo`
class depended on what happened to render earlier in the same build —
nondeterministic under `build.concurrency: 2` and divergent between full and
reference-only builds. The branch passes `jumpToState` down as a prop instead
(`AboutLayout` → `BaseLayout` → `Settings`), matching how Nav already receives
it, and leaves the now-unused global in place for a minimal diff. Verified with
the fix cherry-picked onto the PoC branch: reference pages with `noJumpTo` are
0/907 in a reference-only build and 0/1,664 in a full build (previously 907/907
vs a render-order-dependent subset), i.e. the two build modes now agree;
remaining `noJumpTo` pages in the full build (391/6,371) are the non-About,
non-reference pages that genuinely render without a jump-to menu. Note: the
verification full-builds also carried the `node:fs` fix, since main cannot
build without it.

### CI runner timing (pending)

A throwaway `workflow_dispatch` workflow
(`.github/workflows/poc-reference-preview.yml`, to be deleted from the branch
after the numbers are recorded) is committed on the PoC branch. Dispatching it
requires the file to exist on the fork's default branch, which needs a manual
step by the repo owner; results will be recorded here once the run completes.
