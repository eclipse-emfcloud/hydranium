/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Spawned child of the `model-docs` subcommand. Launched by the parent with
 * `node <this> --services <module> [--out-file <file>]`. It dynamic-imports the
 * head's services module, runs the framework's `reflectGrammar` (the same
 * reflection the `reflect` subcommand uses), and delivers a navigable Markdown
 * reference to stdout or the named file. Read-only — exits 0 unless booting the
 * head throws. Never imported — only spawned.
 */

import { emitReport, loadHeadlessContext, OUT_FILE_FLAG } from './headless-harness.js';
import { formatModelDocs } from './model-docs-report.js';

interface DriverArgs {
   servicesModule?: string;
   outFile?: string;
}

function parseArgs(argv: string[]): DriverArgs {
   const parsed: DriverArgs = {};
   for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index];
      if (flag === '--services' || flag === OUT_FILE_FLAG) {
         const value = argv[index + 1];
         if (value === undefined) {
            console.error(`Missing value for ${flag}`);
            process.exit(1);
         }
         if (flag === '--services') {
            parsed.servicesModule = value;
         } else {
            parsed.outFile = value;
         }
         index += 1;
      } else {
         console.error(`Unknown option: ${flag}`);
         process.exit(1);
      }
   }
   return parsed;
}

async function main(argv: string[]): Promise<number> {
   const args = parseArgs(argv);
   if (!args.servicesModule) {
      console.error('model-docs-driver: --services <module> is required.');
      process.exit(1);
   }
   const { createServices, coreNode } = await loadHeadlessContext(args.servicesModule);
   const reflection = coreNode.reflectGrammar({ createServices });
   emitReport(formatModelDocs(reflection), args.outFile);
   return 0;
}

main(process.argv.slice(2))
   .then(code => process.exit(code))
   .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
   });
