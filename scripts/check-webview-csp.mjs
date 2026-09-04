/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// CSP gate: a built webview bundle must not need a privilege its document's
// Content-Security-Policy does not grant.
//
// **Why this is a gate and not a comment.** The diagram webview's CSP omits
// `'unsafe-eval'` on purpose, unlike GLSP's own example, because nothing in the
// bundle needs it. But that is a property of a 2.5 MB dependency closure, not of
// any code in this repo: a `@eclipse-glsp/client` or sprotty bump can introduce
// a `new Function` without anything here changing. The failure would then be a
// CSP violation visible only in the webview's own devtools console, in a host
// nothing in `check` launches — the same class of invisible-until-launched
// defect that `check:host-load` exists for.
//
// Deliberately narrow. This proves ONE thing: no `eval` / `new Function` in a
// bundle whose document does not grant `'unsafe-eval'`. It does not parse the
// CSP, does not model `'unsafe-inline'` (sprotty genuinely needs it, and it is
// granted), and does not check `img-src` / `font-src` — a data URL is inert and
// the font is inlined by the bundler, so neither can regress silently.
//
// The `grantsUnsafeEval` flag is per bundle rather than global: adding a webview
// that legitimately needs `'unsafe-eval'` should be a one-line, reviewable
// admission here, not a reason to delete the gate.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every built webview bundle, with what its document's CSP allows. */
const BUNDLES = [
   { file: 'examples/order-flow/vscode/out/webview/properties.js', grantsUnsafeEval: false },
   { file: 'examples/order-flow/vscode/out/webview/diagram.js', grantsUnsafeEval: false }
];

/**
 * Direct `eval(` and `new Function(`.
 *
 * `eval` is matched only when NOT preceded by a `.` or an identifier character,
 * so the many innocent `.eval(` members and `…_eval(` names in a bundle this
 * size do not read as the global. Indirect forms (`window['ev'+'al']`) are out
 * of scope: the point is to catch a dependency that started using eval, not to
 * defeat one hiding it.
 */
const FORBIDDEN = [
   { name: 'eval(', pattern: /(^|[^.\w$])eval\s*\(/ },
   { name: 'new Function(', pattern: /new\s+Function\s*\(/ }
];

let failed = false;
for (const { file, grantsUnsafeEval } of BUNDLES) {
   const path = join(repoRoot, file);
   if (!existsSync(path)) {
      console.error(`✗ ${file} does not exist — build first`);
      failed = true;
      continue;
   }
   if (grantsUnsafeEval) {
      console.log(`- ${file} skipped: its document grants 'unsafe-eval'`);
      continue;
   }
   const source = readFileSync(path, 'utf8');
   const found = FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(({ name }) => name);
   if (found.length > 0) {
      failed = true;
      console.error(`✗ ${file} uses ${found.join(' and ')}, but its CSP does not grant 'unsafe-eval'`);
      console.error('    The webview would load and then fail at runtime with a CSP violation in its own');
      console.error('    devtools console, which nothing in `check` opens. Either drop the dependency that');
      console.error("    introduced it, or grant 'unsafe-eval' in that webview's document AND flip");
      console.error('    `grantsUnsafeEval` for it in this script, so the widening is visible in review.');
      continue;
   }
   console.log(`✓ ${file} is free of eval / new Function`);
}

if (failed) {
   console.error('\nCSP gate failed: a webview bundle needs a privilege its document does not grant.');
   process.exit(1);
}
console.log('\nEvery webview bundle stays within its document CSP.');
