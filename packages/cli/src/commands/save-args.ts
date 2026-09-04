/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
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
   parseFlagOptions,
   parseServerSpawnOptions,
   printHelp,
   SERVER_SPAWN_VALUE_FLAGS,
   type UsageError
} from './harness-args.js';
import { runSave, type SaveCommandOptions } from './save.js';

const OWN_FLAGS = ['--uri', '--content', '--client-id'] as const;

/**
 * Every flag `save` accepts, derived from its own list plus the shared spawn
 * flags, so the list cannot claim a flag the parser would reject.
 */
export const SAVE_FLAGS: readonly string[] = [...SERVER_SPAWN_VALUE_FLAGS, ...OWN_FLAGS];

/**
 * The subset that takes a value, so `--help` in a value position reads as data.
 * Every flag in this family takes one, so the two lists coincide — and `--content`
 * is the one where a caller plausibly writes that literal text.
 */
export const SAVE_VALUE_FLAGS: readonly string[] = SAVE_FLAGS;

/** The `--help` text, as data, held to {@link SAVE_FLAGS} by a test. */
export const SAVE_HELP: readonly string[] = [
   'Usage: hydranium-cli save --server "<cmd>..." --uri <uri> --content <text|@file> [--client-id <id>] [--cwd <dir>] [--log-level <level>]',
   '',
   'Update the document at `<uri>` with `<content>` and persist via saveModelDocument.',
   'Output is the post-save envelope as a single JSON line.',
   '',
   'Options:',
   '  --server "<cmd>"      Command-line for the data-server subprocess (required).',
   '  --uri <uri>           Document URI (required).',
   '  --content <text>      Content to write (required). Prefix `@` to read from a file',
   '                        (escape with `\\@` for literal `@`-leading content).',
   '  --client-id <id>      clientId for authorship attribution. Default: hydranium-cli.',
   '  --cwd <dir>           Working directory for the spawned child. Default: cwd.',
   '  --log-level <lvl>     Log threshold for the spawned server (off|error|warn|info|debug|trace).'
];

export function parseSaveArgs(args: string[], onError: UsageError = exitWithUsage): SaveCommandOptions {
   const { serverCommand, serverArgs, cwd, logLevel, extra } = parseServerSpawnOptions(args, 'save', onError);
   const { uri, content, clientId } = parseFlagOptions(extra, 'save', OWN_FLAGS, onError);
   return {
      serverCommand,
      serverArgs,
      cwd,
      logLevel,
      uri: assertRequired(uri, '--uri', 'save', onError),
      content: assertRequired(content, '--content', 'save', onError),
      clientId
   };
}

export function runSaveCommand(args: string[]): Promise<void> {
   if (helpRequested(args, SAVE_VALUE_FLAGS)) {
      printHelp(SAVE_HELP);
      return Promise.resolve();
   }
   return runSave(parseSaveArgs(args));
}
