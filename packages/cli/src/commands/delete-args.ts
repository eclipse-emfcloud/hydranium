/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   assertRequired,
   exitWithUsage,
   helpRequested,
   logHelpLines,
   parseFlagOptions,
   parseServerSpawnOptions,
   printHelp,
   SERVER_SPAWN_VALUE_FLAGS,
   type UsageError
} from './harness-args.js';
import { type DeleteCommandOptions, runDelete } from './delete.js';

const OWN_FLAGS = ['--uri', '--client-id'] as const;

/** Every flag `delete` accepts, each of which takes a value. */
export const DELETE_FLAGS: readonly string[] = [...SERVER_SPAWN_VALUE_FLAGS, ...OWN_FLAGS];

/** The `--help` text, as data, held to {@link DELETE_FLAGS} by a test. */
export const DELETE_HELP: readonly string[] = [
   'Usage: hydranium-cli delete --server "<cmd>..." --uri <uri> [--client-id <id>] [--cwd <dir>] [--log-level <lvl>] [--log-file <file>] [--log-file-level <lvl>]',
   '',
   'Delete the document at `<uri>`, its file and then the document, via deleteModelDocument,',
   'whatever text it holds. Prints nothing.',
   '',
   'Options:',
   '  --server "<cmd>"      Command-line for the data-server subprocess (required).',
   '  --uri <uri>           Document URI (required).',
   '  --client-id <id>      clientId the deletion is attributed to. Default: hydranium-cli.',
   '  --cwd <dir>           Working directory for the spawned child. Default: cwd.',
   ...logHelpLines(22, 'the spawned server')
];

export function parseDeleteArgs(args: string[], onError: UsageError = exitWithUsage): DeleteCommandOptions {
   const { serverCommand, serverArgs, cwd, logLevel, logFile, logFileLevel, extra } = parseServerSpawnOptions(args, 'delete', onError);
   const { uri, clientId } = parseFlagOptions(extra, 'delete', OWN_FLAGS, onError);
   return {
      serverCommand,
      serverArgs,
      cwd,
      logLevel,
      logFile,
      logFileLevel,
      uri: assertRequired(uri, '--uri', 'delete', onError),
      clientId
   };
}

export function runDeleteCommand(args: string[]): Promise<void> {
   if (helpRequested(args, DELETE_FLAGS)) {
      printHelp(DELETE_HELP);
      return Promise.resolve();
   }
   return runDelete(parseDeleteArgs(args));
}
