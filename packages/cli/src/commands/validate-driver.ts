/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Spawned child of the `validate` subcommand. Launched by the parent with
 * `node <this> --services <module> <workspace> [--json] [--strict]
 * [--out-file <file>]`. It dynamic-imports the head's services module, runs the
 * framework's `validateWorkspace`, delivers the report (human or `--json`) to
 * stdout or the named file, and exits with the gate code (non-zero on errors;
 * `--strict` also fails on warnings). Never imported — only spawned.
 */

import { emitReport, loadHeadlessContext, OUT_FILE_FLAG } from './headless-harness.js';
import { formatValidationReport, validationExitCode } from './validate-report.js';

interface DriverArgs {
   servicesModule?: string;
   workspace?: string;
   json: boolean;
   strict: boolean;
   outFile?: string;
}

function parseArgs(argv: string[]): DriverArgs {
   const parsed: DriverArgs = { json: false, strict: false };
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
         case '--strict':
            parsed.strict = true;
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

async function main(argv: string[]): Promise<number> {
   const args = parseArgs(argv);
   if (!args.servicesModule || !args.workspace) {
      console.error('validate-driver: --services <module> and a <workspace> are required.');
      process.exit(1);
   }
   const { createServices, coreNode } = await loadHeadlessContext(args.servicesModule);
   const result = await coreNode.validateWorkspace({ createServices, workspace: args.workspace });
   emitReport(formatValidationReport(result, { json: args.json }), args.outFile);
   return validationExitCode(result, args.strict);
}

main(process.argv.slice(2))
   .then(code => process.exit(code))
   .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
   });
