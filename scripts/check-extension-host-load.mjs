/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Activation gate: every VS Code extension's built `main` must actually LOAD in
// Node, with `vscode` stubbed the way the host provides it.
//
// The third axis of the neutrality story. `check:neutral` gates the BROWSER
// direction (a head's `.` entry must bundle with no `node:*` imports) and
// `lib: ["ES2022"]` compile-bans the DOM on the Node side wherever a package
// inherits it — not everywhere, which is why `check:neutral` derives that set
// rather than asserting it. Neither axis can see the
// failure this catches: an extension-host module whose require graph reaches
// something Node cannot parse. It is not a type error, not a lint error, and not
// a browser-bundling error, so `check` stays green while the extension cannot
// start at all.
//
// The shape of it: an entry imports a client BARREL, which re-exports a diagram
// definition, whose `@eclipse-glsp/client` graph reaches `.css` files. Node
// cannot require a stylesheet, so activation dies with
//
//     Activating extension '…' failed: Unexpected token '.'
//
// — the first character of a CSS selector, with nothing in the message naming a
// stylesheet, an import, or a package. It is reachable only by launching the
// extension: nothing else in the repo requires the extension host's entry.
//
// The `vscode` stub is deliberately permissive (any capitalised member is a
// class, anything else is callable) because the subject is MODULE LOADING, not
// behaviour. Activation itself is not called — `activate()` forks a language
// server and opens sockets, which is an integration test's job, not a gate's.

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** Every package whose `main` the VS Code extension host loads. */
const EXTENSIONS = ['examples/order-flow/vscode'];

/** What `activate` is expected to export, so a truncated module is not "loaded". */
const REQUIRED_EXPORTS = ['activate'];

/**
 * Install a `vscode` stub, since the module exists only inside the host.
 *
 * Capitalised members resolve to a class because `vscode-languageclient`
 * genuinely does `class ProtocolCompletionItem extends vscode.CompletionItem`,
 * and a stub that returned a plain function would fail there for a reason that
 * has nothing to do with the code under test.
 */
function stubVsCode() {
   const stub = () =>
      new Proxy(function () {}, {
         get(_target, key) {
            if (key === 'default') {
               return stub();
            }
            if (typeof key === 'string' && /^[A-Z]/.test(key)) {
               return class VsCodeStub {};
            }
            return stub();
         },
         apply: () => undefined,
         construct: () => ({})
      });

   const Module = require('node:module');
   const load = Module._load;
   Module._load = function (request, parent, isMain) {
      return request === 'vscode' ? stub() : load.call(this, request, parent, isMain);
   };
}

stubVsCode();

let failed = false;
for (const packageDir of EXTENSIONS) {
   const packageJsonPath = join(repoRoot, packageDir, 'package.json');
   if (!existsSync(packageJsonPath)) {
      console.error(`✗ ${packageDir} has no package.json`);
      failed = true;
      continue;
   }
   const { main } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
   if (!main) {
      console.error(`✗ ${packageDir} declares no "main" — the host would have nothing to load`);
      failed = true;
      continue;
   }
   const entry = join(repoRoot, packageDir, main);
   if (!existsSync(entry)) {
      console.error(`✗ ${packageDir}: ${main} does not exist — build first`);
      failed = true;
      continue;
   }

   try {
      const loaded = require(entry);
      const missing = REQUIRED_EXPORTS.filter(name => typeof loaded[name] !== 'function');
      if (missing.length > 0) {
         console.error(`✗ ${packageDir} loaded but does not export ${missing.join(', ')}`);
         failed = true;
         continue;
      }
      console.log(`✓ ${packageDir} loads in the extension host (exports ${Object.keys(loaded).join(', ')})`);
   } catch (error) {
      failed = true;
      console.error(`✗ ${packageDir} fails to load — the extension host would report this as an activation failure:`);
      console.error(`    ${error instanceof Error ? error.message : String(error)}`);
      const frame = error instanceof Error && error.stack ? error.stack.split('\n')[1] : undefined;
      if (frame) {
         console.error(`   ${frame.trim()}`);
      }
      console.error('    A bare `Unexpected token` here usually means a require graph reached a non-JS file');
      console.error('    (a `.css` from @eclipse-glsp/client, for instance) — import the MODULE, not a barrel.');
   }
}

if (failed) {
   console.error('\nActivation gate failed: an extension the host loads cannot be required in Node.');
   process.exit(1);
}
console.log('\nEvery VS Code extension entry loads in Node with `vscode` stubbed.');
