/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Spawned child of the `reflect` subcommand. Launched by the parent with
 * `node <this> --services <module> [--json] [--out-file <file>]`. It
 * dynamic-imports the head's services module, runs the framework's
 * `reflectGrammar`, and delivers the report (markdown or `--json`) to stdout or
 * the named file. Read-only — exits 0 unless booting the head throws. Never
 * imported — only spawned.
 */

import { emitReport, loadHeadlessContext, OUT_FILE_FLAG } from './headless-harness.js';
import { formatReflectionReport } from './reflect-report.js';

interface DriverArgs {
   servicesModule?: string;
   json: boolean;
   outFile?: string;
}

function parseArgs(argv: string[]): DriverArgs {
   const parsed: DriverArgs = { json: false };
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
         case '--json':
            parsed.json = true;
            break;
         case OUT_FILE_FLAG:
            parsed.outFile = next();
            break;
         default:
            console.error(`Unknown option: ${flag}`);
            process.exit(1);
      }
   }
   return parsed;
}

async function main(argv: string[]): Promise<number> {
   const args = parseArgs(argv);
   if (!args.servicesModule) {
      console.error('reflect-driver: --services <module> is required.');
      process.exit(1);
   }
   const { createServices, coreNode } = await loadHeadlessContext(args.servicesModule);
   const result = coreNode.reflectGrammar({ createServices });
   emitReport(formatReflectionReport(result, { json: args.json }), args.outFile);
   return 0;
}

main(process.argv.slice(2))
   .then(code => process.exit(code))
   .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
   });
