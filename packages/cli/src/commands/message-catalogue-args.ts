/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { assertRequired, exitWithUsage, helpRequested, printHelp, type UsageError } from './harness-args.js';
import { runMessageCatalogue, type MessageCatalogueCommandOptions } from './message-catalogue.js';

export const MESSAGE_CATALOGUE_FLAGS: readonly string[] = ['--barrel', '--out-file'];
export const MESSAGE_CATALOGUE_VALUE_FLAGS = MESSAGE_CATALOGUE_FLAGS;
export const MESSAGE_CATALOGUE_HELP: readonly string[] = [
   'Usage: hydranium-cli message-catalogue --barrel <module>... [--out-file <file>]',
   '',
   'Emit a flat JSON starter catalogue mapping message codes to English defaults.',
   'Modules are resolved from the current project and must be built first.',
   'Repeat --barrel for each framework head and your own messages. No server starts.',
   '',
   'Options:',
   '  --barrel <module>    Messages package specifier or ESM file (required). Repeatable.',
   '  --out-file <file>   Write JSON here instead of stdout, after all imports succeed.'
];

export function parseMessageCatalogueArgs(args: string[], onError: UsageError = exitWithUsage): MessageCatalogueCommandOptions {
   const barrels: string[] = [];
   let outFile: string | undefined;
   for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (!MESSAGE_CATALOGUE_FLAGS.includes(flag)) {
         return onError(`Unexpected argument: ${flag} (hydranium-cli message-catalogue --help)`);
      }
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) {
         return onError(`Missing value for ${flag}`);
      }
      if (flag === '--barrel') {
         barrels.push(value);
      } else {
         outFile = value;
      }
   }
   assertRequired(barrels[0], '--barrel', 'message-catalogue', onError);
   return { barrels, outFile };
}

export async function runMessageCatalogueCommand(args: string[]): Promise<void> {
   if (helpRequested(args, MESSAGE_CATALOGUE_VALUE_FLAGS)) {
      printHelp(MESSAGE_CATALOGUE_HELP);
      return;
   }
   await runMessageCatalogue(parseMessageCatalogueArgs(args));
}
