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
import { runWatch, wireSigintAbort, type WatchCommandOptions } from './watch.js';

const OWN_FLAGS = ['--uri', '--client-id'] as const;

/**
 * Every flag `watch` accepts, derived from its own list plus the shared spawn
 * flags, so the list cannot claim a flag the parser would reject.
 */
export const WATCH_FLAGS: readonly string[] = [...SERVER_SPAWN_VALUE_FLAGS, ...OWN_FLAGS];

/**
 * The subset that takes a value, so `--help` in a value position reads as data.
 * Every flag in this family takes one, so the two lists coincide.
 */
export const WATCH_VALUE_FLAGS: readonly string[] = WATCH_FLAGS;

/** The `--help` text, as data, held to {@link WATCH_FLAGS} by a test. */
export const WATCH_HELP: readonly string[] = [
   'Usage: hydranium-cli watch --server "<cmd>..." --uri <uri> [--client-id <id>] [--cwd <dir>] [--log-level <level>]',
   '',
   'Subscribe to document updates at `<uri>` and print events as newline-delimited',
   'JSON. Long-running — exits cleanly on SIGINT (Ctrl-C).',
   '',
   'Options:',
   '  --server "<cmd>"      Command-line for the data-server subprocess (required).',
   '  --uri <uri>           Document URI (required).',
   '  --client-id <id>      Subscriber identity. Default: hydranium-cli.',
   '  --cwd <dir>           Working directory for the spawned child. Default: cwd.',
   '  --log-level <lvl>     Log threshold for the spawned server (off|error|warn|info|debug|trace).'
];

/** Parse the argv; the abort signal is the entry point's to supply, not the command line's. */
export function parseWatchArgs(args: string[], onError: UsageError = exitWithUsage): WatchCommandOptions {
   const { serverCommand, serverArgs, cwd, logLevel, extra } = parseServerSpawnOptions(args, 'watch', onError);
   const { uri, clientId } = parseFlagOptions(extra, 'watch', OWN_FLAGS, onError);
   return {
      serverCommand,
      serverArgs,
      cwd,
      logLevel,
      uri: assertRequired(uri, '--uri', 'watch', onError),
      clientId
   };
}

export function runWatchCommand(args: string[]): Promise<void> {
   if (helpRequested(args, WATCH_VALUE_FLAGS)) {
      printHelp(WATCH_HELP);
      return Promise.resolve();
   }
   const options = parseWatchArgs(args);
   const controller = new AbortController();
   const unwire = wireSigintAbort(controller);
   return runWatch({ ...options, signal: controller.signal }).finally(() => unwire());
}
