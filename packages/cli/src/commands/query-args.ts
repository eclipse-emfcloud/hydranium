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
import { runQuery, type QueryCommandOptions } from './query.js';

const OWN_FLAGS = ['--uri'] as const;

/**
 * Every flag `query` accepts, derived from its own list plus the shared spawn
 * flags, so the list cannot claim a flag the parser would reject.
 */
export const QUERY_FLAGS: readonly string[] = [...SERVER_SPAWN_VALUE_FLAGS, ...OWN_FLAGS];

/**
 * The subset that takes a value, so `--help` in a value position reads as data.
 * Every flag in this family takes one, so the two lists coincide.
 */
export const QUERY_VALUE_FLAGS: readonly string[] = QUERY_FLAGS;

/** The `--help` text, as data, held to {@link QUERY_FLAGS} by a test. */
export const QUERY_HELP: readonly string[] = [
   'Usage: hydranium-cli query --server "<cmd> [args...]" --uri <uri> [--cwd <dir>] [--log-level <level>]',
   '',
   'Print the data-server document envelope for `<uri>` as a single JSON line.',
   '',
   'Options:',
   '  --server "<cmd>"   Command-line for the data-server subprocess (required).',
   '  --uri <uri>        Document URI (required).',
   '  --cwd <dir>        Working directory for the spawned child. Default: cwd.',
   '  --log-level <lvl>  Log threshold for the spawned server (off|error|warn|info|debug|trace).'
];

export function parseQueryArgs(args: string[], onError: UsageError = exitWithUsage): QueryCommandOptions {
   const { serverCommand, serverArgs, cwd, logLevel, extra } = parseServerSpawnOptions(args, 'query', onError);
   const { uri } = parseFlagOptions(extra, 'query', OWN_FLAGS, onError);
   return { serverCommand, serverArgs, cwd, logLevel, uri: assertRequired(uri, '--uri', 'query', onError) };
}

export function runQueryCommand(args: string[]): Promise<void> {
   if (helpRequested(args, QUERY_VALUE_FLAGS)) {
      printHelp(QUERY_HELP);
      return Promise.resolve();
   }
   return runQuery(parseQueryArgs(args));
}
