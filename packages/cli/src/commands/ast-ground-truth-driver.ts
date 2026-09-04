/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Spawned child of the `ast-ground-truth` subcommand. Launched by the parent with
 * `node <this> --services <module> <workspace> [--out-file <file>]`. It
 * dynamic-imports the head's services module, runs the framework's
 * `collectAstGroundTruth`, and writes the `{ documents, totalAstNodes, byType }`
 * JSON to stdout (or `--out-file`). Never imported — only spawned.
 */

import * as fs from 'node:fs';
import { loadHeadlessContext, OUT_FILE_FLAG } from './headless-harness.js';

interface DriverArgs {
   servicesModule?: string;
   workspace?: string;
   outFile?: string;
}

function parseArgs(argv: string[]): DriverArgs {
   const parsed: DriverArgs = {};
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
         case OUT_FILE_FLAG:
            parsed.outFile = next();
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
      console.error('ast-ground-truth-driver: --services <module> and a <workspace> are required.');
      process.exit(1);
   }
   const { createServices, coreNode } = await loadHeadlessContext(args.servicesModule);
   const result = await coreNode.collectAstGroundTruth({ createServices, workspace: args.workspace });
   const json = JSON.stringify(result, undefined, 2);
   if (args.outFile) {
      fs.writeFileSync(args.outFile, `${json}\n`);
      // Progress to stderr keeps stdout clean for callers that capture either form.
      console.error(`Ground truth: ${result.documents} docs, ${result.totalAstNodes} AST nodes -> ${args.outFile}`);
   } else {
      console.log(json);
   }
}

main(process.argv.slice(2))
   .then(() => process.exit(0))
   .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
   });
