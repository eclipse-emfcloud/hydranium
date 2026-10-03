/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   exitWithUsage,
   helpRequested,
   logHelpLines,
   parseFlagOptions,
   parseServerSpawnOptions,
   printHelp,
   SERVER_SPAWN_VALUE_FLAGS,
   type UsageError
} from './harness-args.js';
import { runProjects, type ProjectsCommandOptions } from './projects.js';

/**
 * Every flag `projects` accepts. All three are consumed by the shared spawn
 * parser; the command declares no options of its own beyond them.
 */
export const PROJECTS_FLAGS: readonly string[] = SERVER_SPAWN_VALUE_FLAGS;

/**
 * The subset that takes a value, so `--help` in a value position reads as data.
 * Every flag in this family takes one, so the two lists coincide.
 */
export const PROJECTS_VALUE_FLAGS: readonly string[] = PROJECTS_FLAGS;

/** The `--help` text, as data, held to {@link PROJECTS_FLAGS} by a test. */
export const PROJECTS_HELP: readonly string[] = [
   'Usage: hydranium-cli projects --server "<cmd> [args...]" [--cwd <dir>] [--log-level <lvl>] [--log-file <file>] [--log-file-level <lvl>]',
   '',
   'List projects exposed by the data-server subprocess. Output is newline-delimited',
   'JSON — one project envelope per line.',
   '',
   'Options:',
   '  --server "<cmd>"   Command-line for the data-server subprocess (required).',
   '  --cwd <dir>        Working directory for the spawned child. Default: cwd.',
   ...logHelpLines(19, 'the spawned server')
];

export function parseProjectsArgs(args: string[], onError: UsageError = exitWithUsage): ProjectsCommandOptions {
   const { serverCommand, serverArgs, cwd, logLevel, logFile, logFileLevel, extra } = parseServerSpawnOptions(args, 'projects', onError);
   // `projects` declares no options beyond the shared ones, so nothing may
   // survive the spawn parser. Draining `extra` against an empty set is what
   // makes a typo an error here rather than a flag that silently did nothing —
   // the siblings get this from the option list they pass.
   parseFlagOptions(extra, 'projects', [], onError);
   return { serverCommand, serverArgs, cwd, logLevel, logFile, logFileLevel };
}

export function runProjectsCommand(args: string[]): Promise<void> {
   if (helpRequested(args, PROJECTS_VALUE_FLAGS)) {
      printHelp(PROJECTS_HELP);
      return Promise.resolve();
   }
   return runProjects(parseProjectsArgs(args));
}
