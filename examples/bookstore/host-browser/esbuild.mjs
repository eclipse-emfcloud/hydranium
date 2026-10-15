// Bundles the page, the worker hosting the heads and Monaco's own worker into
// `out/`: once with `npm run build`, and on every change, served, with
// `npm start`.
//
// At `platform: 'browser'` esbuild refuses a `node:*` import rather than
// shimming it, so a Node import anywhere the worker reaches fails here rather
// than inside a worker with no console attached.

import { context } from 'esbuild';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const workspace = fileURLToPath(new URL('../workspace/', import.meta.url));

// The worker's filesystem seed: each file of `../workspace`, keyed by its path
// below the workspace root. A file saved in the page is kept in IndexedDB and
// laid over this seed on the next load.
const seed = Object.fromEntries(
   readdirSync(workspace, { recursive: true, encoding: 'utf8' })
      .filter(path => statSync(join(workspace, path)).isFile())
      .map(path => [path.split('\\').join('/'), readFileSync(join(workspace, path), 'utf8')])
);

// Names the worker's IndexedDB database after this directory. Every project
// served on one port shares an origin, and with it the databases, so a name
// from the project alone lays one project's saved files over another's seed.
// Moving the directory starts again from the seed.
const directoryKey = createHash('sha256').update(root).digest('hex').slice(0, 12);

const common = {
   absWorkingDir: root,
   outdir: 'out',
   bundle: true,
   platform: 'browser',
   // Classic scripts: the page loads its bundle with a plain `<script>`, and
   // both workers are classic workers.
   format: 'iife',
   target: 'es2022',
   sourcemap: true,
   // The framework imports bare `path` so that a browser bundle can point it
   // at a shim. Relative to `absWorkingDir`.
   alias: { path: './src/posix-path-shim.ts' },
   define: {
      __WORKSPACE_SEED__: JSON.stringify(seed),
      __DIRECTORY_KEY__: JSON.stringify(directoryKey),
      __WORKER_BUNDLE_URL__: JSON.stringify('./out/worker.js'),
      __MONACO_WORKER_BUNDLE_URL__: JSON.stringify('./out/monaco-editor-worker.js')
   },
   logLevel: 'info'
};

const builds = await Promise.all([
   context({
      ...common,
      entryPoints: { page: 'src/page.ts' },
      // The icon font Monaco and GLSP import, inlined: a `file` loader would
      // rewrite its URL relative to `out/`, which the page one directory up does
      // not resolve. The page's alone, so a diagram client import that reaches
      // the worker fails its bundle.
      loader: { '.ttf': 'dataurl' }
   }),
   context({ ...common, entryPoints: { worker: 'src/worker.ts', 'monaco-editor-worker': 'src/monaco-editor-worker.ts' } })
]);

if (process.argv.includes('--serve')) {
   await Promise.all(builds.map(build => build.watch()));
   // On this machine only: the directory served holds the sources and `node_modules`.
   const { port } = await builds[0].serve({ host: 'localhost', servedir: root, port: Number(process.env.PORT ?? 4937) });
   console.log(`Serving http://localhost:${port}`);
} else {
   await Promise.all(builds.map(build => build.rebuild()));
   await Promise.all(builds.map(build => build.dispose()));
}
