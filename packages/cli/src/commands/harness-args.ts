/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The argv machinery the subcommands share, and the error vocabulary they all
 * speak.
 *
 * Its own module rather than functions in the CLI entry point, because the entry
 * point runs `main()` on import: a test that wants to read an argv the way a
 * command does would otherwise have to spawn the whole binary, so flag handling
 * and exit codes could only be covered through a subprocess.
 *
 * The messages here are a contract — scripts and CI steps match on them — so
 * changing one is a breaking change for a caller nobody in this repo can see.
 *
 * Every parser takes an `onError` defaulting to report-and-exit, which is what a
 * command line wants; a caller that would rather handle the problem passes its
 * own and the parser hands control to it instead of ending the process.
 *
 * Each subcommand lives in a sibling `<name>-args` module exporting three things
 * a test can hold against each other: its flag list, its `--help` text as data,
 * and the parser that turns an argv into the runner's options. Help that drifts
 * from the parser is worse than none — it reads as authoritative, so a flag
 * missing from it is a capability nobody finds, and one it describes but the
 * parser rejects is an invocation that fails for no visible reason.
 */

import type { LogThreshold } from '@hydranium/protocol';
import { statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLogLevelOption } from '../log-level.js';

/**
 * How a parser reports a usage problem. It never returns, so a parser can treat
 * the call as a dead end and keep narrowing the value it was about to reject.
 */
export type UsageError = (message: string) => never;

/**
 * The command-line failure mode: report the usage problem and stop.
 *
 * Exit 2, not 1: a CI step that treats "non-zero" as failure is unaffected, but
 * one that reads 1 as "the workspace has errors" can tell that apart from "I
 * passed a bad flag" only while the two codes differ. 2 is also what the
 * bundled heap analyzer exits with for a usage error.
 */
export function exitWithUsage(message: string): never {
   console.error(message);
   process.exit(2);
}

/** The value flag {@link parseHarnessArgs} consumes itself, before any the subcommand declares. */
export const SERVICES_FLAG = '--services';

/**
 * The one spelling of the log threshold, shared by both subcommand families.
 *
 * Named rather than repeated because the two families reach the same variable by
 * different routes — a spawned data-server for one, a spawned driver child for
 * the other — and a second spelling would make the CLI's verbosity control depend
 * on which command a caller happened to reach for.
 */
export const LOG_LEVEL_FLAG = '--log-level';

/** The value flags {@link parseServerSpawnOptions} consumes itself. */
export const SERVER_SPAWN_VALUE_FLAGS: readonly string[] = ['--server', '--cwd', LOG_LEVEL_FLAG];

/**
 * The `--help` line every subcommand describes {@link LOG_LEVEL_FLAG} with.
 *
 * Shared text, per-command padding: `command-args.test.ts` compares the flags a
 * help block DESCRIBES against the flags the parser accepts, and it recognises a
 * description by the two-space indent — so the line has to be a real option entry
 * in each block, and the column each block aligns its descriptions at is the
 * block's own.
 */
export function logLevelHelpLine(padTo: number): string {
   return `  ${`${LOG_LEVEL_FLAG} <lvl>`.padEnd(padTo)}Log threshold for the head this boots (off|error|warn|info|debug|trace).`;
}

/**
 * Narrow a raw {@link LOG_LEVEL_FLAG} value that {@link parseHarnessArgs}
 * collected, leaving an absent flag absent.
 *
 * Throws rather than reaching `onError`, matching {@link parseServerSpawnOptions}:
 * the level vocabulary belongs to the protocol package, which reports it, and the
 * entry point's catch turns that into the same message-and-exit.
 */
export function logLevelOption(value: string | undefined): LogThreshold | undefined {
   return value === undefined ? undefined : parseLogLevelOption(value);
}

/**
 * Whether the argv asks for the command's help rather than describing a run.
 *
 * `valueFlags` are the flags that take a value, and passing them is what makes
 * the answer correct rather than approximately correct: a token sitting in a
 * VALUE position is data, not a request. Scanning the whole argv for `--help`
 * instead means `--content --help` prints help and exits 0 — so a caller writing
 * that literal text saves nothing and reads success. Omit them only for a
 * command whose flags take no values at all.
 */
export function helpRequested(args: readonly string[], valueFlags: readonly string[] = []): boolean {
   const valueSet = new Set(valueFlags);
   for (let index = 0; index < args.length; index += 1) {
      const token = args[index];
      if (token === '--help' || token === '-h') {
         return true;
      }
      if (valueSet.has(token)) {
         index += 1;
      }
   }
   return false;
}

/**
 * Print a help block on stdout, not stderr: `<cmd> --help` succeeded, and a
 * caller piping it into a pager reads the stream a successful command writes to.
 */
export function printHelp(lines: readonly string[]): void {
   for (const line of lines) {
      console.log(line);
   }
}

/** What {@link parseHarnessArgs} recovered from an argv. */
export interface ParsedHarnessArgs {
   servicesModule: string;
   /**
    * An absolute directory path, resolved by {@link resolveWorkspaceArgument} and
    * checked to exist. `''` when the subcommand declared `requireWorkspace: false`.
    */
   workspace: string;
   /** Value flags by flag name; a bool flag that appeared reads `'true'`. */
   options: Record<string, string | undefined>;
   /** Repeatable value flags by flag name, in the order they appeared. */
   values: Record<string, string[]>;
}

/** Per-subcommand deviations from {@link parseHarnessArgs}'s defaults. */
export interface HarnessArgsConfig {
   /**
    * `false` for subcommands that take no workspace: a positional is then
    * rejected as unexpected, and the returned `workspace` is `''`.
    */
   requireWorkspace?: boolean;
   /**
    * Value flags that may appear more than once. Each occurrence's value is
    * collected into `values[flag]` rather than overwriting the single-valued
    * `options[flag]`.
    */
   repeatableValueFlags?: readonly string[];
   onError?: UsageError;
}

/**
 * Shared parser for the headless-harness subcommands. Consumes the required
 * `--services <module>` value flag and a single positional `<workspace>`, plus
 * the `valueFlags` (each takes a value) and `boolFlags` (presence-only, recorded
 * as `'true'`) the subcommand recognises. Unknown flags or a missing
 * `--services`/`<workspace>` are usage errors, and so is a `<workspace>` that
 * reaches no directory — see {@link resolveWorkspaceArgument} for why that cannot
 * be left to the run.
 */
export function parseHarnessArgs(
   args: string[],
   commandName: string,
   valueFlags: readonly string[],
   boolFlags: readonly string[],
   config: HarnessArgsConfig = {}
): ParsedHarnessArgs {
   const requireWorkspace = config.requireWorkspace ?? true;
   const onError = config.onError ?? exitWithUsage;
   const valueSet = new Set(valueFlags);
   const boolSet = new Set(boolFlags);
   const repeatableSet = new Set(config.repeatableValueFlags ?? []);
   const options: Record<string, string | undefined> = {};
   const values: Record<string, string[]> = {};
   let servicesModule: string | undefined;
   let workspace: string | undefined;
   for (let index = 0; index < args.length; index += 1) {
      const flag = args[index];
      const next = (): string => {
         const value = args[index + 1];
         if (value === undefined) {
            onError(`Missing value for ${flag}`);
         }
         index += 1;
         return value;
      };
      if (flag === '--services') {
         servicesModule = next();
      } else if (boolSet.has(flag)) {
         options[flag] = 'true';
      } else if (repeatableSet.has(flag)) {
         (values[flag] ??= []).push(next());
      } else if (valueSet.has(flag)) {
         options[flag] = next();
      } else if (flag.startsWith('--')) {
         onError(`Unknown option: ${flag} (hydranium-cli ${commandName} --help)`);
      } else if (requireWorkspace && workspace === undefined) {
         workspace = flag;
      } else {
         onError(`Unexpected argument: ${flag} (hydranium-cli ${commandName} --help)`);
      }
   }
   return {
      servicesModule: assertRequired(servicesModule, '--services', commandName, onError),
      workspace: requireWorkspace
         ? resolveWorkspaceArgument(assertRequired(workspace, '<workspace>', commandName, onError), commandName, onError)
         : (workspace ?? ''),
      options,
      values
   };
}

/**
 * Resolve the `<workspace>` positional to an absolute directory path, reporting
 * a usage error when it reaches anything else.
 *
 * The check is here rather than left to the traversal because reaching no
 * workspace fails NOWHERE downstream: the directory read's `ENOENT` is swallowed
 * inside a `Promise.all`, the run then reports whatever documents the head
 * contributes independently of the workspace, and the gate exits 0 — so a CI step
 * whose path has rotted reads as a clean workspace rather than a broken
 * invocation. The surviving document count is a property of the head and can be
 * non-zero, so no caller can use the number as the tell.
 *
 * A `file:` URI is converted to a path rather than passed on, because the
 * headless seams resolve a string workspace as a filesystem path — an
 * unconverted URI becomes `<cwd>/file:/…` and reaches nothing, by the same silent
 * route.
 *
 * A directory is required: a path naming a file traverses to nothing just as
 * quietly. An EMPTY directory is accepted — a workspace with no documents
 * validating clean is an answer, not a bad argument, and the binary is
 * language-agnostic so it cannot judge whether the files present are the
 * language's.
 */
export function resolveWorkspaceArgument(workspace: string, commandName: string, onError: UsageError = exitWithUsage): string {
   const resolved = toWorkspacePath(workspace, commandName, onError);
   const help = `(hydranium-cli ${commandName} --help)`;
   // `throwIfNoEntry: false` suppresses ENOENT and nothing else, so a path the
   // OS cannot even interrogate still throws raw. A `file://host/share` URI
   // reaches this on Windows, where it converts to a UNC path rather than
   // being rejected as unusable, and an unreachable host then surfaces as
   // `UNKNOWN: unknown error` instead of a usage message naming the argument.
   let stats;
   try {
      stats = statSync(resolved, { throwIfNoEntry: false });
   } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      onError(`<workspace> is not reachable: '${workspace}' resolved to ${resolved} (${detail}) ${help}`);
   }
   if (stats === undefined) {
      onError(`<workspace> does not exist: '${workspace}' resolved to ${resolved}, which is not a path on this machine ${help}`);
   }
   if (!stats.isDirectory()) {
      onError(`<workspace> is not a directory: '${workspace}' resolved to ${resolved}. Pass the directory holding the models ${help}`);
   }
   return resolved;
}

function toWorkspacePath(workspace: string, commandName: string, onError: UsageError): string {
   if (!/^file:/i.test(workspace)) {
      return path.resolve(workspace);
   }
   try {
      return fileURLToPath(workspace);
   } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      onError(`<workspace> is not a usable file URI: '${workspace}' (${detail}) (hydranium-cli ${commandName} --help)`);
   }
}

/** Demand a value the subcommand cannot run without, naming the help that lists it. */
export function assertRequired<T>(value: T | undefined, flag: string, command: string, onError: UsageError = exitWithUsage): T {
   if (value === undefined) {
      onError(`Missing required option: ${flag} (hydranium-cli ${command} --help)`);
   }
   return value;
}

/** Parse a numeric CLI option; a usage error on a non-numeric value, `undefined` when absent. */
export function numericOption(value: string | undefined, flag: string, onError: UsageError = exitWithUsage): number | undefined {
   if (value === undefined) {
      return undefined;
   }
   const parsed = Number(value);
   if (!Number.isFinite(parsed)) {
      onError(`Option ${flag} expects a number, got: ${value}`);
   }
   return parsed;
}

/**
 * Parse the remaining `extra` tokens after {@link parseServerSpawnOptions}
 * consumed the shared flags. Maps `--<flag>` (kebab) to a `flag` property
 * (camelCase, leading `--` stripped). Every token must be a recognised flag
 * followed by its value — unrecognised ones are a usage error, which saves a
 * silent typo from reading as an omitted option.
 */
export function parseFlagOptions(
   extra: string[],
   commandName: string,
   recognised: readonly string[],
   onError: UsageError = exitWithUsage
): Record<string, string | undefined> {
   const recognisedSet = new Set(recognised);
   const out: Record<string, string | undefined> = {};
   for (let index = 0; index < extra.length; index += 1) {
      const flag = extra[index];
      if (!recognisedSet.has(flag)) {
         onError(`Unknown option: ${flag} (hydranium-cli ${commandName} --help)`);
      }
      const value = extra[index + 1];
      if (value === undefined) {
         onError(`Missing value for ${flag}`);
      }
      out[kebabToCamel(flag.slice(2))] = value;
      index += 1;
   }
   return out;
}

function kebabToCamel(name: string): string {
   return name.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

/** What {@link parseServerSpawnOptions} recovered from an argv. */
export interface SpawnOptions {
   serverCommand: string;
   serverArgs: string[];
   cwd?: string;
   logLevel?: LogThreshold;
   /** The tokens this parser did not claim, for the subcommand's own options. */
   extra: string[];
}

/**
 * Whether a `--server` token names a path the shell would resolve against the
 * working directory.
 *
 * Deliberately narrow: only an explicit `./` or `../` prefix, plus a COMMAND
 * that carries a separator without being absolute. A bare `models` or a
 * `--stdio` must not match — the point is to recognise the spellings that are
 * unambiguously filesystem-relative, not to guess which arguments are paths.
 */
function isRelativePathToken(token: string, isCommand: boolean): boolean {
   if (token.startsWith('./') || token.startsWith('../') || token.startsWith('.\\') || token.startsWith('..\\')) {
      return true;
   }
   return isCommand && !path.isAbsolute(token) && /[/\\]/.test(token);
}

/**
 * Shared option parser for subcommands that spawn a data-server child. Consumes
 * `--server` / `--cwd` / `--log-level` and returns the surviving tokens as
 * `extra` for {@link parseFlagOptions} to finish.
 *
 * An unrecognised `--log-level` value throws rather than reaching `onError`: the
 * level vocabulary belongs to the protocol package, which reports it, and the
 * entry point's catch turns that into the same message-and-exit.
 *
 * **`--cwd` together with a relative `--server` path is refused, not repaired.**
 * `--cwd` re-roots the CHILD, so the shell's own reading of `./lib/entry.js` —
 * relative to where the user stands — is not what the child gets, and the failure
 * arrives as a bare interpreter module-not-found that names neither flag. Refusing
 * is the honest half of the choice: re-rooting the token against the parent would
 * be friendlier for the entry path and would silently change what an argument
 * meant to be read by the child resolves to, which is the same class of quiet
 * misdirection one layer along. An absolute path, or dropping `--cwd` and passing
 * the workspace to the entry, both say what they mean.
 */
export function parseServerSpawnOptions(args: string[], commandName: string, onError: UsageError = exitWithUsage): SpawnOptions {
   let serverSpec: string | undefined;
   let cwd: string | undefined;
   let logLevel: LogThreshold | undefined;
   const extra: string[] = [];
   for (let index = 0; index < args.length; index += 1) {
      const flag = args[index];
      const claim = (): string => {
         const value = args[index + 1];
         if (value === undefined) {
            onError(`Missing value for ${flag}`);
         }
         index += 1;
         return value;
      };
      if (flag === '--server') {
         serverSpec = claim();
      } else if (flag === '--cwd') {
         cwd = claim();
      } else if (flag === LOG_LEVEL_FLAG) {
         logLevel = parseLogLevelOption(claim());
      } else {
         extra.push(flag);
      }
   }
   if (!serverSpec) {
      onError(`Missing required option: --server (hydranium-cli ${commandName} --help)`);
   }
   // Split the spec on whitespace — quoting is the caller's shell's job;
   // by the time we see the value here it's already a single token.
   const tokens = serverSpec.split(/\s+/).filter(token => token.length > 0);
   if (tokens.length === 0) {
      onError('Empty --server value');
   }
   const [serverCommand, ...serverArgs] = tokens;
   if (cwd !== undefined) {
      const relative = tokens.find((token, position) => isRelativePathToken(token, position === 0));
      if (relative !== undefined) {
         onError(
            `--cwd re-roots the spawned child, so the relative path '${relative}' in --server would be resolved ` +
               `against '${cwd}' rather than against the current directory. Pass an absolute path, or drop --cwd and ` +
               `give the workspace to the entry as its own argument (hydranium-cli ${commandName} --help)`
         );
      }
   }
   return { serverCommand, serverArgs, cwd, logLevel, extra };
}
