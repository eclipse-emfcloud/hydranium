/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Spawned child of the `lint-grammar` subcommand. Launched by the parent with
 * `node <this> --services <module> [--name-property <p>]... [--json] [--strict]`.
 * It dynamic-imports the head's services module, runs the framework's
 * `lintGrammar`, prints the report (human or `--json`) and exits with the gate
 * code (non-zero on errors; `--strict` also fails on warnings). Never imported —
 * only spawned.
 */

import { loadHeadlessContext } from './headless-harness.js';
import { formatLintReport, lintExitCode } from './lint-grammar-report.js';

interface DriverArgs {
   servicesModule?: string;
   nameProperties: string[];
   json: boolean;
   strict: boolean;
}

function parseArgs(argv: string[]): DriverArgs {
   const parsed: DriverArgs = { nameProperties: [], json: false, strict: false };
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
         case '--name-property':
            parsed.nameProperties.push(next());
            break;
         case '--json':
            parsed.json = true;
            break;
         case '--strict':
            parsed.strict = true;
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
      console.error('lint-grammar-driver: --services <module> is required.');
      process.exit(1);
   }
   const { createServices, coreNode } = await loadHeadlessContext(args.servicesModule);
   const result = coreNode.lintGrammar({
      createServices,
      nameProperties: args.nameProperties.length ? args.nameProperties : undefined
   });
   console.log(formatLintReport(result, { json: args.json }));
   return lintExitCode(result, args.strict);
}

main(process.argv.slice(2))
   .then(code => process.exit(code))
   .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
   });
