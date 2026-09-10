// The three browser bundles: the worker hosting the heads, the page driving
// them, and Monaco's own editor worker.
//
// **This build is the neutrality gate for everything it reaches.** At
// `platform: 'browser'` esbuild refuses to resolve a `node:*` builtin rather
// than shimming it, so a Node import anywhere in the head composition's graph
// fails here instead of throwing inside a worker with no console attached. That
// covers more than `scripts/check-neutral-bundles.mjs` does: the gate probes the
// framework's `.` entries, while this bundles the example's actual composition —
// grammars, serializers, scope providers and all — which nothing else does.
//
// `format: 'iife'` for both. The page loads its bundle as a classic `<script>`
// and the worker is constructed as a classic worker, so neither needs
// `type="module"`; an ESM worker would also change how the bundle's own imports
// resolve at runtime for no gain in a single-entry bundle.

import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// Both bundles' locations, declared once. Every other reference to them is
// DERIVED from these two — the page's `new Worker(...)` through a `define`
// below, the document's `<script src>` through the assertion below that.
//
// Restating either path elsewhere is what this arrangement exists to prevent:
// a page that names a worker bundle nothing emits gets an `ErrorEvent` with no
// message, no filename and no line number, which is indistinguishable from the
// worker crashing on its first statement.
const WORKER_OUTPUT = 'out/order-flow-worker.js';
const PAGE_OUTPUT = 'out/order-flow-page.js';

// Monaco's own worker, which is a THIRD worker and unrelated to the head one.
// Monaco uses it for the services it runs off the main thread (word-based
// completions, link detection, diff), and it must be handed over explicitly:
// left to itself, `MonacoEnvironment` resolves a `vs/base/worker/...` path that
// no bundle emits, and the failure is a console error on the first edit rather
// than at startup — which this package cannot absorb, since its e2e asserts the
// console is SILENT.
const MONACO_WORKER_OUTPUT = 'out/monaco-editor-worker.js';

// The brand mark, COPIED from the repository's asset instead of committed
// beside the page, so the two cannot drift: an icon nobody looks at while
// editing a logo is exactly the reference that goes stale unnoticed. Nothing
// bundles it, so it is a copy rather than an entry point.
//
// ONE file for two uses — the tab icon and the title bar. Named for the mark
// rather than for either surface, because `favicon.svg` in a title bar reads as
// a mistake and a second copy is the drift this arrangement exists to prevent.
const BRAND_MARK_SOURCE = resolve(packageRoot, '../../../docs/assets/hydranium-logo.svg');
const BRAND_MARK_OUTPUT = 'out/hydranium-mark.svg';

// The document is static, so its references cannot be derived — but they CAN be
// checked, which turns the same silent mismatch into a build failure.
const indexHtml = readFileSync(resolve(packageRoot, 'index.html'), 'utf8');
if (!indexHtml.includes(`./${PAGE_OUTPUT}`)) {
   throw new Error(`index.html does not load ./${PAGE_OUTPUT} — the page bundle was renamed without updating the document`);
}
if (!indexHtml.includes(`./${BRAND_MARK_OUTPUT}`)) {
   throw new Error(`index.html does not reference ./${BRAND_MARK_OUTPUT} — the brand mark was renamed without updating the document`);
}

// Before the bundles rather than after: `out/` is created by whichever runs
// first, and in `--watch` the builds never "finish" for a copy to follow them.
mkdirSync(resolve(packageRoot, 'out'), { recursive: true });
copyFileSync(BRAND_MARK_SOURCE, resolve(packageRoot, BRAND_MARK_OUTPUT));

const common = {
   bundle: true,
   platform: 'browser',
   define: {
      __WORKER_BUNDLE_URL__: JSON.stringify(`./${WORKER_OUTPUT}`),
      __MONACO_WORKER_BUNDLE_URL__: JSON.stringify(`./${MONACO_WORKER_OUTPUT}`)
   },
   // The framework's workspace initialization imports bare `'path'` rather than
   // `node:path` precisely so a browser bundle can point it somewhere. Only the
   // bare specifier is aliased: a `node:*` import anywhere in the graph still
   // fails the build, which is the property that makes this bundle a gate.
   alias: { path: resolve(packageRoot, 'src/workspace/posix-path-shim.ts') },
   format: 'iife',
   target: 'es2022',
   sourcemap: true,
   // Readable in devtools, the only place a worker-hosted language server can be
   // debugged at all.
   minify: false,
   logLevel: 'info'
};

const bundles = [
   {
      entryPoints: [resolve(packageRoot, 'src/worker/order-flow-worker.ts')],
      outfile: resolve(packageRoot, WORKER_OUTPUT),
      ...common
   },
   {
      entryPoints: [resolve(packageRoot, 'src/page/order-flow-page.ts')],
      outfile: resolve(packageRoot, PAGE_OUTPUT),
      ...common,
      // The page graph reaches stylesheets and a font through
      // `@eclipse-glsp/client`; the WORKER graph deliberately does not, which is
      // why the loader is here and not in `common`. Giving the worker bundle the
      // loaders would make it silently tolerate a client import, and a diagram
      // client reaching the server worker is a real mistake worth failing on.
      //
      // `.css` needs no loader entry: esbuild bundles a stylesheet imported from
      // JS natively and writes it beside the JS, which is the
      // `order-flow-page.css` the document links.
      //
      // `dataurl` for the font rather than `file`. A `file` loader emits the
      // `.ttf` and rewrites the CSS `url()` to a path relative to the OUTPUT
      // directory, which is `out/` — but the document lives one level up, so the
      // rewritten path resolves against the wrong base and 404s. Inlining
      // sidesteps the rewrite; the cost is ~80 kB of base64 in a bundle already
      // far larger.
      loader: { '.ttf': 'dataurl' }
   },
   {
      // Monaco's worker entry assigns `self.onmessage` itself, so it is a
      // complete classic worker and needs no wrapper of ours.
      entryPoints: [resolve(packageRoot, 'src/page/monaco-editor-worker.ts')],
      outfile: resolve(packageRoot, MONACO_WORKER_OUTPUT),
      ...common
   }
];

if (watch) {
   for (const options of bundles) {
      const ctx = await context(options);
      await ctx.watch();
   }
} else {
   await Promise.all(bundles.map(options => build(options)));
}
