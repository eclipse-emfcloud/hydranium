/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Headless model-store memory measurement for `order-flow`, the server-only
 * counterpart to the in-app "dump server state" command. Dogfoods the
 * framework's `measureModelMemory` harness directly (no CLI spawn layer): the
 * example supplies only its `createServices` thunk; everything else is generic.
 * The same thunk is what `hydranium-cli measure-memory --services` consumes, so
 * the two entry points share one definition of the wiring — here it is
 * `src/services.ts` itself, with no separate services module, because that file
 * is already the zero-arg NodeFileSystem factory the contract asks for.
 *
 *   node --expose-gc --max-old-space-size=8192 lib/measure-memory.js <workspace> [--edits=N] [--snapshot]
 *
 * Point it at a generated corpus rather than the committed sample to get a
 * number worth reading:
 *
 *   npm run generate:large-workspace
 *   npm run measure-memory -- ../workspace-large --edits=20
 */

import { measureModelMemory } from '@hydranium/core/node';
import { createServices } from './services.js';

const args = process.argv.slice(2);
const workspace = args.find(arg => !arg.startsWith('--'));
if (!workspace) {
   console.error('Usage: node --expose-gc lib/measure-memory.js <workspace> [--edits=N] [--snapshot]');
   process.exit(1);
}
const editsArg = args.find(arg => arg.startsWith('--edits='));

void measureModelMemory({
   createServices,
   workspace,
   editCycles: editsArg ? Number(editsArg.split('=')[1]) : 0,
   // The STRUCTURAL grammar, deliberately: `.process` and `.layout` both
   // reference `.domain`, so churning a domain file is the edit whose rebuild
   // fans out across all three languages. Churning `.process` would exercise
   // only its own document plus the layout overlay, and churning `.layout`
   // nothing but itself — each a weaker signal for the same cost.
   churnDocSuffix: '.domain',
   writeSnapshot: args.includes('--snapshot'),
   log: line => console.log(line)
})
   .then(result => {
      console.log(`SUMMARY: docs=${result.documentCount} build=${Math.round(result.buildMs)}ms`);
      process.exit(0);
   })
   .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
   });
