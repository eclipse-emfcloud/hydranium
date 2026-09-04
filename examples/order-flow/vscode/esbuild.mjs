/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The webview bundles: the properties panel's, and the diagram's.
//
// esbuild, not webpack: nothing in this workspace supplies webpack or its
// css-loader / style-loader / babel-loader transitively, while esbuild is a
// declared root devDependency the neutrality gate already uses.
//
// **This build is its own neutrality gate.** With `platform: 'browser'` esbuild
// refuses to resolve a `node:*` builtin instead of shimming it, so a Node import
// reaching the webview graph — directly or transitively — fails the build here
// rather than throwing inside the sandbox on the first message. That is the same
// property `scripts/check-neutral-bundles.mjs` provides for the head packages,
// obtained for free because this entry is genuinely bundled rather than merely
// probed. The webview's own risk on top of that is the vscode-jsonrpc
// entrypoint: `/browser` installs a runtime abstraction layer, the package root
// installs none and throws on first use, and only bundling proves which one
// resolved.
//
// `format: 'iife'` because the panel loads it as a classic `<script nonce=...>`;
// an ESM bundle would need `type="module"`, which changes the CSP shape for no
// gain in a single-entry bundle.

import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/** Settings both webview bundles share. */
const common = {
   bundle: true,
   platform: 'browser',
   format: 'iife',
   target: 'es2022',
   sourcemap: true,
   // Readable in the webview devtools, which is the only place this code can be
   // debugged at all. Neither bundle is big enough for the size to argue back.
   minify: false,
   logLevel: 'info'
};

const bundles = [
   {
      entryPoints: [resolve(packageRoot, 'src/webview/properties.ts')],
      outfile: resolve(packageRoot, 'out/webview/properties.js'),
      ...common
   },
   {
      entryPoints: [resolve(packageRoot, 'src/webview/diagram.ts')],
      outfile: resolve(packageRoot, 'out/webview/diagram.js'),
      ...common,
      // The diagram graph reaches stylesheets and a font; the properties graph
      // deliberately does not, which is why the loaders are HERE and not in
      // `common`. Giving both bundles the loaders would make the properties
      // bundle silently tolerate a `@eclipse-glsp/client` import — and that
      // import reaching the extension host is the failure `check:host-load`
      // exists for. Keeping the loaders scoped means the properties bundle still
      // fails loudly on a stray one.
      //
      // `.css` needs no loader entry: esbuild bundles a stylesheet imported from
      // JS natively and writes it beside the JS, which is the `diagram.css` the
      // webview document links.
      //
      // `dataurl` for the font, not `file`. A `file` loader emits the `.ttf` and
      // rewrites the CSS `url()` to a RELATIVE path, but a webview can only load
      // a `vscode-webview://` URI minted at runtime by `asWebviewUri` — which the
      // bundler cannot know. Inlining sidesteps the rewrite entirely; the cost is
      // ~80 kB of base64 in a bundle that is already far larger.
      loader: { '.ttf': 'dataurl' }
   }
];

if (watch) {
   const { context } = await import('esbuild');
   for (const options of bundles) {
      const ctx = await context(options);
      await ctx.watch();
   }
} else {
   await Promise.all(bundles.map(options => build(options)));
}
