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
import { type CreateCommandOptions, runCreate } from './create.js';

const OWN_FLAGS = ['--uri', '--content', '--client-id'] as const;

/** Every flag `create` accepts, each of which takes a value. */
export const CREATE_FLAGS: readonly string[] = [...SERVER_SPAWN_VALUE_FLAGS, ...OWN_FLAGS];

/** The `--help` text, as data, held to {@link CREATE_FLAGS} by a test. */
export const CREATE_HELP: readonly string[] = [
   'Usage: hydranium-cli create --server "<cmd>..." --uri <uri> --content <text|@file> [--client-id <id>] [--cwd <dir>] [--log-level <lvl>] [--log-file <file>] [--log-file-level <lvl>]',
   '',
   'Create the document at `<uri>` with `<content>` via createModelDocument, and persist it',
   'as given. Fails when the file exists or a client has it open.',
   'Output is the post-save envelope as a single JSON line.',
   '',
   'Options:',
   '  --server "<cmd>"      Command-line for the data-server subprocess (required).',
   '  --uri <uri>           Document URI (required).',
   '  --content <text>      Content to write (required). Prefix `@` to read from a file',
   '                        (escape with `\\@` for literal `@`-leading content).',
   '  --client-id <id>      clientId for authorship attribution. Default: hydranium-cli.',
   '  --cwd <dir>           Working directory for the spawned child. Default: cwd.',
   ...logHelpLines(22, 'the spawned server')
];

export function parseCreateArgs(args: string[], onError: UsageError = exitWithUsage): CreateCommandOptions {
   const { serverCommand, serverArgs, cwd, logLevel, logFile, logFileLevel, extra } = parseServerSpawnOptions(args, 'create', onError);
   const { uri, content, clientId } = parseFlagOptions(extra, 'create', OWN_FLAGS, onError);
   return {
      serverCommand,
      serverArgs,
      cwd,
      logLevel,
      logFile,
      logFileLevel,
      uri: assertRequired(uri, '--uri', 'create', onError),
      content: assertRequired(content, '--content', 'create', onError),
      clientId
   };
}

export function runCreateCommand(args: string[]): Promise<void> {
   if (helpRequested(args, CREATE_FLAGS)) {
      printHelp(CREATE_HELP);
      return Promise.resolve();
   }
   return runCreate(parseCreateArgs(args));
}
