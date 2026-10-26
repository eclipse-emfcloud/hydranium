// Bundles each diagram webview in `src/webview/` into `out/webview/`, its
// stylesheet beside it: once, or on every change with `--watch`. The extension
// itself is `tsc`'s, since the extension host loads it with its `node_modules`.
//
// At `platform: 'browser'` esbuild refuses a `node:*` import rather than
// shimming it, so a Node import reaching a webview fails here rather than in
// the webview's own console.

import { context } from 'esbuild';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

const build = await context({
   absWorkingDir: root,
   entryPoints: readdirSync(new URL('src/webview/', import.meta.url))
      .filter(file => file.endsWith('.ts'))
      .map(file => `src/webview/${file}`),
   outdir: 'out/webview',
   bundle: true,
   platform: 'browser',
   // The editor loads the bundle with a plain `<script>`.
   format: 'iife',
   target: 'es2022',
   sourcemap: true,
   // The icon font GLSP imports, inlined: a webview loads only the URIs the
   // extension mints at runtime, which a bundled `url()` cannot name.
   loader: { '.ttf': 'dataurl' },
   logLevel: 'info'
});

if (process.argv.includes('--watch')) {
   await build.watch();
} else {
   await build.rebuild();
   await build.dispose();
}
