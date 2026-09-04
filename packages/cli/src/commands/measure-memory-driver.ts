/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Spawned child of the `measure-memory` subcommand. Launched by the parent with
 * `node --expose-gc --max-old-space-size=8192 <this> --services <module> <workspace> ...`
 * so the underlying harness gets post-GC readings. It dynamic-imports the head's
 * services module and runs the framework's `measureModelMemory`, streaming the
 * baseline / after-build / churn lines to stdout. Never imported — only spawned.
 */

import { loadHeadlessContext } from './headless-harness.js';
import { parseProfileDimensions } from './measure-memory.js';

interface DriverArgs {
   servicesModule?: string;
   workspace?: string;
   editCycles?: number;
   editDocs?: number;
   churnDocSuffix?: string;
   settleMs?: number;
   writeSnapshot: boolean;
   snapshotPath?: string;
   profile?: string;
   sessionOut?: string;
   json: boolean;
}

function parseArgs(argv: string[]): DriverArgs {
   const parsed: DriverArgs = { writeSnapshot: false, json: false };
   for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index];
      const next = (): string => {
         const value = argv[index + 1];
         if (value === undefined) {
            console.error(`Missing value for ${flag}`);
            process.exit(1);
         }
         index += 1;
         return value;
      };
      switch (flag) {
         case '--services':
            parsed.servicesModule = next();
            break;
         case '--edits':
            parsed.editCycles = Number(next());
            break;
         case '--edit-docs':
            parsed.editDocs = Number(next());
            break;
         case '--churn-suffix':
            parsed.churnDocSuffix = next();
            break;
         case '--settle':
            parsed.settleMs = Number(next());
            break;
         case '--snapshot':
            parsed.writeSnapshot = true;
            break;
         case '--snapshot-path':
            parsed.snapshotPath = next();
            break;
         case '--profile':
            parsed.profile = next();
            break;
         case '--session-out':
            parsed.sessionOut = next();
            break;
         case '--json':
            parsed.json = true;
            break;
         default:
            if (flag.startsWith('--')) {
               console.error(`Unknown option: ${flag}`);
               process.exit(1);
            }
            parsed.workspace = flag;
      }
   }
   return parsed;
}

async function main(argv: string[]): Promise<void> {
   const args = parseArgs(argv);
   if (!args.servicesModule || !args.workspace) {
      console.error('measure-memory-driver: --services <module> and a <workspace> are required.');
      process.exit(1);
   }
   const { createServices, coreNode } = await loadHeadlessContext(args.servicesModule);
   const result = await coreNode.measureModelMemory({
      createServices,
      workspace: args.workspace,
      editCycles: args.editCycles,
      editDocs: args.editDocs,
      churnDocSuffix: args.churnDocSuffix,
      settleMs: args.settleMs,
      writeSnapshot: args.writeSnapshot,
      snapshotPath: args.snapshotPath,
      profile: args.profile ? parseProfileDimensions(args.profile) : undefined,
      sessionOut: args.sessionOut,
      // Omitted under `--json` rather than redirected: every progress line would
      // otherwise land on the same stream as the document, so the caller's
      // `JSON.parse` would see a preamble it has no way to bound.
      log: args.json ? undefined : line => console.log(line)
   });
   if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
   }
   console.log(`SUMMARY: docs=${result.documentCount} build=${Math.round(result.buildMs)}ms`);
   if (result.profilingSession) {
      console.log(`SESSION: ${result.profilingSession}`);
   }
}

main(process.argv.slice(2))
   .then(() => process.exit(0))
   .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
   });
