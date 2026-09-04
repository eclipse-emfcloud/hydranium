/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Each subcommand's own argv surface: the help it prints, the flags it accepts,
 * and what a parsed argv means to the runner behind it.
 *
 * Reachable at all only because each command's parsing lives beside the command
 * rather than in the entry point, which runs `main()` on import. `init` keeps its
 * own suite; the shared machinery every parser here delegates to has another.
 */

import type { LogThreshold } from '@hydranium/protocol';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
   ANALYZE_HEAP_FLAGS,
   ANALYZE_HEAP_HELP,
   ANALYZE_HEAP_VALUE_FLAGS,
   parseAnalyzeHeapArgs
} from '../src/commands/analyze-heap-args.js';
import { AST_GROUND_TRUTH_FLAGS, AST_GROUND_TRUTH_HELP, parseAstGroundTruthArgs } from '../src/commands/ast-ground-truth-args.js';
import {
   GENERATE_TRANSFER_MODEL_FLAGS,
   GENERATE_TRANSFER_MODEL_HELP,
   GENERATE_TRANSFER_MODEL_VALUE_FLAGS,
   parseGenerateOptions
} from '../src/commands/generate-transfer-model-args.js';
import { INIT_FLAGS, INIT_VALUE_FLAGS, parseInitArgs } from '../src/commands/init-args.js';
import { LINT_GRAMMAR_FLAGS, LINT_GRAMMAR_HELP, parseLintGrammarArgs } from '../src/commands/lint-grammar-args.js';
import { MEASURE_MEMORY_FLAGS, MEASURE_MEMORY_HELP, parseMeasureMemoryArgs } from '../src/commands/measure-memory-args.js';
import { MODEL_DOCS_FLAGS, MODEL_DOCS_HELP, parseModelDocsArgs } from '../src/commands/model-docs-args.js';
import { PROJECTS_FLAGS, PROJECTS_HELP, parseProjectsArgs } from '../src/commands/projects-args.js';
import { QUERY_FLAGS, QUERY_HELP, parseQueryArgs } from '../src/commands/query-args.js';
import { REFLECT_FLAGS, REFLECT_HELP, parseReflectArgs } from '../src/commands/reflect-args.js';
import { helpRequested, type UsageError } from '../src/commands/harness-args.js';
import { SAVE_FLAGS, SAVE_HELP, SAVE_VALUE_FLAGS, parseSaveArgs } from '../src/commands/save-args.js';
import { VALIDATE_FLAGS, VALIDATE_HELP, parseValidateArgs } from '../src/commands/validate-args.js';
import { WATCH_FLAGS, WATCH_HELP, parseWatchArgs } from '../src/commands/watch-args.js';

/** Report usage problems as throws, so a failure is visible instead of ending the worker. */
function onError(message: string): never {
   throw new Error(message);
}

/**
 * A directory that exists, for the `<workspace>` positional the harness parsers
 * check. This file's own directory rather than a created fixture, so it cannot go
 * missing underneath the assertions that need it.
 */
const EXISTING_DIR = path.dirname(fileURLToPath(import.meta.url));

/** A path under {@link EXISTING_DIR} that nothing in the tree creates. */
const MISSING_DIR = path.join(EXISTING_DIR, 'no-such-workspace-dir');

/**
 * Every subcommand whose flags and help are data, `init` excepted.
 *
 * `demandsResolvedLate` marks the one command whose `(required)` markers describe
 * the inputs it must END with rather than the argv it was handed: its three
 * mandatory paths may instead arrive from `--config`, so the argv parser demands
 * none of them and a marker there is correct without a parse-time counterpart.
 */
const COMMANDS: ReadonlyArray<{
   name: string;
   flags: readonly string[];
   help: readonly string[];
   parse: (args: string[]) => unknown;
   demandsResolvedLate?: true;
}> = [
   { name: 'analyze-heap', flags: ANALYZE_HEAP_FLAGS, help: ANALYZE_HEAP_HELP, parse: args => parseAnalyzeHeapArgs(args, onError) },
   {
      name: 'ast-ground-truth',
      flags: AST_GROUND_TRUTH_FLAGS,
      help: AST_GROUND_TRUTH_HELP,
      parse: args => parseAstGroundTruthArgs(args, onError)
   },
   {
      name: 'generate-transfer-model',
      flags: GENERATE_TRANSFER_MODEL_FLAGS,
      help: GENERATE_TRANSFER_MODEL_HELP,
      parse: args => parseGenerateOptions(args, onError),
      demandsResolvedLate: true
   },
   { name: 'lint-grammar', flags: LINT_GRAMMAR_FLAGS, help: LINT_GRAMMAR_HELP, parse: args => parseLintGrammarArgs(args, onError) },
   {
      name: 'measure-memory',
      flags: MEASURE_MEMORY_FLAGS,
      help: MEASURE_MEMORY_HELP,
      parse: args => parseMeasureMemoryArgs(args, onError)
   },
   { name: 'model-docs', flags: MODEL_DOCS_FLAGS, help: MODEL_DOCS_HELP, parse: args => parseModelDocsArgs(args, onError) },
   { name: 'projects', flags: PROJECTS_FLAGS, help: PROJECTS_HELP, parse: args => parseProjectsArgs(args, onError) },
   { name: 'query', flags: QUERY_FLAGS, help: QUERY_HELP, parse: args => parseQueryArgs(args, onError) },
   { name: 'reflect', flags: REFLECT_FLAGS, help: REFLECT_HELP, parse: args => parseReflectArgs(args, onError) },
   { name: 'save', flags: SAVE_FLAGS, help: SAVE_HELP, parse: args => parseSaveArgs(args, onError) },
   { name: 'validate', flags: VALIDATE_FLAGS, help: VALIDATE_HELP, parse: args => parseValidateArgs(args, onError) },
   { name: 'watch', flags: WATCH_FLAGS, help: WATCH_HELP, parse: args => parseWatchArgs(args, onError) }
];

/**
 * The flags a help block DESCRIBES — an option line under `Options:`, not a
 * mention anywhere in the text.
 *
 * The distinction is the whole test. Matching a flag anywhere in the help cannot
 * fail: the usage synopsis at the top already names almost every one, so
 * deleting a flag's actual explanation would leave the assertion satisfied.
 */
function describedFlags(help: readonly string[]): string[] {
   return help.map(line => line.match(/^ {2}(--[a-z-]+)/)?.[1]).filter((flag): flag is string => flag !== undefined);
}

describe('every subcommand documents its own flags', () => {
   /**
    * Equality, not containment, so both drifts are caught: a flag the parser
    * accepts and the help omits is a capability nobody finds, and one the help
    * describes and the parser rejects is an invocation that fails for no visible
    * reason.
    */
   it.each(COMMANDS)('$name: describes exactly the flags it accepts', ({ flags, help }) => {
      expect(describedFlags(help).sort()).toEqual([...flags].sort());
   });

   it.each(COMMANDS)('$name: opens with its own usage line', ({ name, help }) => {
      // Cheap, and it catches the failure mode these blocks invite: a help text
      // copied from a sibling and edited everywhere except its first line.
      expect(help[0]).toMatch(new RegExp(`^Usage: hydranium-cli ${name}(\\s|$)`));
   });
});

/**
 * The `Options:` block folded into one entry per option — the option line plus
 * whatever continuation lines follow it.
 *
 * Folded rather than read line by line because a description that wrapped puts
 * its tail on the next line, and a marker sitting there is still a marker. The
 * positional inputs (`<workspace>`, `<snapshot>`) are entries too: they are
 * required more often than the flags are, so leaving them out would exempt the
 * strictest half of each command's surface.
 */
function optionEntries(help: readonly string[]): Map<string, string> {
   const entries = new Map<string, string>();
   let current: string | undefined;
   for (const line of help) {
      const opened = line.match(/^ {2}(--[a-z-]+|<[a-z-]+>)/)?.[1];
      if (opened !== undefined) {
         current = opened;
         entries.set(current, line);
      } else if (current !== undefined && /^ {4,}\S/.test(line)) {
         entries.set(current, `${entries.get(current)} ${line.trim()}`);
      } else if (line.trim() === '') {
         current = undefined;
      }
   }
   return entries;
}

/**
 * What a parser refuses to run without, discovered by ASKING it: supply whatever
 * it names as missing and ask again until it stops complaining.
 *
 * Derived rather than listed, because a list beside the parser is a second copy
 * of the fact and drifts from it in exactly the way this file exists to catch —
 * and it is the parser, not the help, that decides whether an invocation runs.
 */
function demandedInputs(parse: (args: string[]) => unknown): string[] {
   const demanded: string[] = [];
   const args: string[] = [];
   // One round per demanded input plus the terminating parse; the bound only
   // stops a runaway. A parser that repeats itself or reports something else
   // stalls the probe, which is a failure to surface rather than a set to
   // silently truncate.
   for (let round = 0; round < 8; round += 1) {
      try {
         parse(args);
         return demanded;
      } catch (err: unknown) {
         const message = err instanceof Error ? err.message : String(err);
         const input = /^Missing required option: (\S+)/.exec(message)?.[1];
         if (input === undefined || demanded.includes(input)) {
            throw new Error(`probe stalled after [${args.join(' ')}] on: ${message}`);
         }
         demanded.push(input);
         // `<thing>` is a positional; anything else is a flag taking a value. The
         // positional stand-in must be an existing directory, because the harness
         // parsers check the `<workspace>` one — a placeholder that reaches
         // nothing stalls the probe instead of advancing it.
         args.push(...(input.startsWith('--') ? [input, 'probe'] : [EXISTING_DIR]));
      }
   }
   throw new Error(`probe did not terminate: [${args.join(' ')}]`);
}

/**
 * `(required)` is the only signal a reader has for which inputs are mandatory,
 * and nothing above can see it: the flag-set test compares NAMES, so a help block
 * that describes every flag and marks none of them passes it clean.
 *
 * Equality, so both drifts fail. An unmarked demand is the defect that shipped —
 * `save --content` was mandatory and read as optional — and a marker on an input
 * the parser accepts without is the mirror: a caller supplies a value they did
 * not need and a script carries a flag it could drop.
 */
describe('every subcommand marks the inputs it cannot run without', () => {
   it.each(COMMANDS)('$name: marks exactly what its parser demands', ({ help, parse, demandsResolvedLate }) => {
      const entries = optionEntries(help);
      const marked = [...entries]
         .filter(([, text]) => text.includes('(required)'))
         .map(([input]) => input)
         .sort();
      const demanded = demandedInputs(parse).sort();

      for (const input of demanded) {
         expect(entries.get(input), `${input} is demanded by the parser but the help describes no such input`).toBeDefined();
         expect(marked, `${input} is demanded by the parser but is not marked (required)`).toContain(input);
      }
      if (!demandsResolvedLate) {
         expect(marked, 'an input is marked (required) that the parser runs without').toEqual(demanded);
      }
   });

   it('the probe finds demands to check, rather than passing on an empty set', () => {
      // Without this the suite above is satisfied by a probe that has stopped
      // discriminating — every command would report no demands and every
      // assertion would hold vacuously.
      const probed = COMMANDS.filter(command => demandedInputs(command.parse).length > 0).map(command => command.name);
      expect(probed).toEqual(COMMANDS.filter(command => !command.demandsResolvedLate).map(command => command.name));
   });
});

describe('the headless-harness subcommands', () => {
   it('validate: takes the services module and the workspace, with both gates off by default', () => {
      expect(parseValidateArgs(['--services', './services.js', EXISTING_DIR], onError)).toEqual({
         servicesModule: './services.js',
         workspace: EXISTING_DIR,
         strict: false,
         json: false
      });
      expect(parseValidateArgs(['--services', 'M', EXISTING_DIR, '--strict', '--json'], onError)).toMatchObject({
         strict: true,
         json: true
      });
   });

   it('validate: demands --services and the workspace, naming its own help', () => {
      expect(() => parseValidateArgs(['/ws'], onError)).toThrow('Missing required option: --services (hydranium-cli validate --help)');
      expect(() => parseValidateArgs(['--services', 'M'], onError)).toThrow(
         'Missing required option: <workspace> (hydranium-cli validate --help)'
      );
   });

   it('reflect and model-docs: take no workspace, and say so when given one', () => {
      expect(parseReflectArgs(['--services', 'M', '--json'], onError)).toEqual({ servicesModule: 'M', json: true });
      expect(parseModelDocsArgs(['--services', 'M'], onError)).toEqual({ servicesModule: 'M' });

      expect(() => parseReflectArgs(['--services', 'M', '/ws'], onError)).toThrow(
         'Unexpected argument: /ws (hydranium-cli reflect --help)'
      );
      expect(() => parseModelDocsArgs(['--services', 'M', '/ws'], onError)).toThrow(
         'Unexpected argument: /ws (hydranium-cli model-docs --help)'
      );
   });

   it('lint-grammar: accumulates --name-property, and leaves it absent when unused', () => {
      expect(
         parseLintGrammarArgs(['--services', 'M', '--name-property', 'id', '--name-property', 'label'], onError).nameProperties
      ).toEqual(['id', 'label']);
      // Absent rather than empty: the runner reads absence as "use the framework
      // default", and `[]` would mean no property can ever satisfy the rule.
      expect(parseLintGrammarArgs(['--services', 'M'], onError).nameProperties).toBeUndefined();
   });

   it('measure-memory: converts its numeric flags and refuses a non-numeric one', () => {
      expect(
         parseMeasureMemoryArgs(['--services', 'M', EXISTING_DIR, '--edits', '3', '--edit-docs', '10', '--settle', '750'], onError)
      ).toMatchObject({
         editCycles: 3,
         editDocs: 10,
         settleMs: 750
      });
      expect(() => parseMeasureMemoryArgs(['--services', 'M', EXISTING_DIR, '--edits', 'lots'], onError)).toThrow(
         'Option --edits expects a number, got: lots'
      );
   });

   it('measure-memory: records --snapshot as presence and its siblings as values', () => {
      expect(
         parseMeasureMemoryArgs(['--services', 'M', EXISTING_DIR, '--snapshot', '--snapshot-path', '/tmp/a.heapsnapshot'], onError)
      ).toMatchObject({
         writeSnapshot: true,
         snapshotPath: '/tmp/a.heapsnapshot'
      });
      expect(parseMeasureMemoryArgs(['--services', 'M', EXISTING_DIR], onError).writeSnapshot).toBe(false);
   });

   it('measure-memory: refuses a --profile typo in the PARENT, before anything is spawned', () => {
      // The dimensions are only USED in the child, so the typo used to surface
      // after a process had been spawned and a whole head imported. Validating
      // here puts it with the numeric flags beside it, as a usage error.
      expect(() => parseMeasureMemoryArgs(['--services', 'M', EXISTING_DIR, '--profile', 'cpu,bogus'], onError)).toThrow(
         'Option --profile: Unknown profile dimension: bogus (expected cpu, alloc, gc, eld, heap)'
      );
      // The raw string still crosses to the child unchanged: this validates, it
      // does not take over the parsing.
      expect(parseMeasureMemoryArgs(['--services', 'M', EXISTING_DIR, '--profile', 'cpu, heap'], onError).profile).toBe('cpu, heap');
      expect(parseMeasureMemoryArgs(['--services', 'M', EXISTING_DIR], onError).profile).toBeUndefined();
   });

   it('measure-memory: takes --json as presence, off by default', () => {
      expect(parseMeasureMemoryArgs(['--services', 'M', EXISTING_DIR, '--json'], onError).json).toBe(true);
      // `false` rather than absent, so the parent's argv builder reads a decision
      // rather than having to re-derive the default.
      expect(parseMeasureMemoryArgs(['--services', 'M', EXISTING_DIR], onError).json).toBe(false);
   });

   /**
    * The verbosity control, asserted over the SET of `--services` subcommands
    * rather than one test each.
    *
    * The defect is a command drifting out of the set — a per-command test nobody
    * thought to add cannot see that, and a caller who has to remember which
    * subcommand takes the flag has no verbosity control at all. The set is
    * discovered by asking the flag lists, so a command that stops declaring it
    * fails the discovery rather than being quietly skipped.
    */
   describe('the log threshold spans every --services subcommand', () => {
      const SERVICES_COMMANDS: ReadonlyArray<{
         name: string;
         flags: readonly string[];
         parse: (args: string[], onError: UsageError) => { logLevel?: LogThreshold };
         /** The positionals this command needs after `--services`, so the parse reaches its flags. */
         tail: readonly string[];
      }> = [
         { name: 'ast-ground-truth', flags: AST_GROUND_TRUTH_FLAGS, parse: parseAstGroundTruthArgs, tail: [EXISTING_DIR] },
         { name: 'lint-grammar', flags: LINT_GRAMMAR_FLAGS, parse: parseLintGrammarArgs, tail: [] },
         { name: 'measure-memory', flags: MEASURE_MEMORY_FLAGS, parse: parseMeasureMemoryArgs, tail: [EXISTING_DIR] },
         { name: 'model-docs', flags: MODEL_DOCS_FLAGS, parse: parseModelDocsArgs, tail: [] },
         { name: 'reflect', flags: REFLECT_FLAGS, parse: parseReflectArgs, tail: [] },
         { name: 'validate', flags: VALIDATE_FLAGS, parse: parseValidateArgs, tail: [EXISTING_DIR] }
      ];

      it('covers the six of them, so no assertion below runs on a short list', () => {
         expect(SERVICES_COMMANDS.map(command => command.name)).toEqual([
            'ast-ground-truth',
            'lint-grammar',
            'measure-memory',
            'model-docs',
            'reflect',
            'validate'
         ]);
      });

      it.each(SERVICES_COMMANDS)('$name: declares --log-level and narrows its value', ({ flags, parse, tail }) => {
         expect(flags).toContain('--log-level');
         expect(parse(['--services', 'M', ...tail, '--log-level', 'debug'], onError)).toMatchObject({ logLevel: 'debug' });
         // Absent rather than defaulted, so the parent leaves the child's
         // inherited environment alone and an ambient level still wins.
         expect(parse(['--services', 'M', ...tail], onError).logLevel).toBeUndefined();
      });

      it.each(SERVICES_COMMANDS)('$name: refuses a level the protocol does not define', ({ parse, tail }) => {
         // Thrown by the protocol package rather than reported through `onError`:
         // it owns the vocabulary, and the entry point's catch turns the throw
         // into the same message-and-exit.
         expect(() => parse(['--services', 'M', ...tail, '--log-level', 'chatty'], onError)).toThrow(
            /^Invalid --log-level: chatty \(expected one of: /
         );
      });
   });

   it('ast-ground-truth: routes --out-file to the output file, defaulting to stdout', () => {
      expect(parseAstGroundTruthArgs(['--services', 'M', EXISTING_DIR, '--out-file', 'gt.json'], onError)).toEqual({
         servicesModule: 'M',
         workspace: EXISTING_DIR,
         outFile: 'gt.json'
      });
      expect(parseAstGroundTruthArgs(['--services', 'M', EXISTING_DIR], onError).outFile).toBeUndefined();
      // The retired spelling must be REJECTED, not quietly ignored: an unknown
      // flag that parses is a run on the default the caller believed they had
      // overridden, and here that means the JSON going to stdout unnoticed.
      expect(() => parseAstGroundTruthArgs(['--services', 'M', EXISTING_DIR, '--out', 'gt.json'], onError)).toThrow(
         'Unknown option: --out (hydranium-cli ast-ground-truth --help)'
      );
   });

   /**
    * A `<workspace>` that reaches no directory is a usage error, and the property
    * asserted is that EVERY workspace-taking subcommand has it.
    *
    * The set is discovered by asking the parsers, not listed: the check lives in
    * the shared harness parser, so a command that stops going through it loses the
    * check with nothing to report — and a per-command test nobody thought to add
    * cannot see that. Without it the run reports whatever documents the head
    * contributes independently of the workspace and exits 0, and that count is a
    * property of the head, so no caller can read the number as the tell.
    */
   it('every subcommand that takes a workspace refuses one that reaches no directory', () => {
      const workspaceCommands = COMMANDS.filter(command => demandedInputs(command.parse).includes('<workspace>'));
      // An empty set would make the loop vacuous rather than failing.
      expect(workspaceCommands.length, 'no workspace-taking subcommand to check').toBeGreaterThan(0);

      for (const command of workspaceCommands) {
         expect(
            () => command.parse(['--services', 'M', MISSING_DIR]),
            `${command.name} accepts a workspace that reaches no directory`
         ).toThrow(`<workspace> does not exist: '${MISSING_DIR}'`);
      }
   });

   /**
    * One output-file flag across the report-producing commands, so a caller does
    * not have to remember which spelling each took.
    *
    * Asserted as a SET over the commands rather than one test each, because the
    * defect is a command drifting out of the set — which a per-command test that
    * nobody thought to add cannot see.
    */
   it('the report commands all spell their output file the same way', () => {
      expect(parseReflectArgs(['--services', 'M', '--out-file', 'r.md'], onError).outFile).toBe('r.md');
      expect(parseValidateArgs(['--services', 'M', EXISTING_DIR, '--out-file', 'v.txt'], onError).outFile).toBe('v.txt');
      expect(parseModelDocsArgs(['--services', 'M', '--out-file', 'm.md'], onError).outFile).toBe('m.md');
      expect(parseAstGroundTruthArgs(['--services', 'M', EXISTING_DIR, '--out-file', 'g.json'], onError).outFile).toBe('g.json');

      // Absent rather than empty, so the driver reads "write to stdout".
      expect(parseReflectArgs(['--services', 'M'], onError).outFile).toBeUndefined();
      expect(parseValidateArgs(['--services', 'M', EXISTING_DIR], onError).outFile).toBeUndefined();
      expect(parseModelDocsArgs(['--services', 'M'], onError).outFile).toBeUndefined();
   });
});

describe('the data-server subcommands', () => {
   it('projects: splits --server and takes the shared spawn flags', () => {
      // The entry is ABSOLUTE here because `--cwd` is given: a relative one is a
      // usage error, since the child would resolve it against the new root.
      expect(parseProjectsArgs(['--server', 'node /srv/server.js --stdio', '--cwd', '/tmp/here', '--log-level', 'trace'], onError)).toEqual(
         {
            serverCommand: 'node',
            serverArgs: ['/srv/server.js', '--stdio'],
            cwd: '/tmp/here',
            logLevel: 'trace'
         }
      );
   });

   it('projects: demands --server, naming its own help', () => {
      expect(() => parseProjectsArgs([], onError)).toThrow('Missing required option: --server (hydranium-cli projects --help)');
   });

   it('projects: refuses a token it has no option for, rather than ignoring it', () => {
      // The command declares nothing of its own, so there is no option list to
      // reject against — every stray token would otherwise be dropped in
      // silence, and a misspelt --cwd would read as a run that used the default.
      expect(() => parseProjectsArgs(['--server', 'node s.js', '--cdw', '/tmp/here'], onError)).toThrow(
         'Unknown option: --cdw (hydranium-cli projects --help)'
      );
      expect(() => parseProjectsArgs(['--server', 'node s.js', '--uri', 'file:///a.x'], onError)).toThrow(
         'Unknown option: --uri (hydranium-cli projects --help)'
      );
   });

   it('save: keeps a literal --help as content instead of reading it as a help request', () => {
      // The one flag where a caller plausibly writes that text. Scanning the
      // whole argv made this print help and exit 0 — nothing saved, success
      // reported — so the parse must see the token in its value position.
      expect(helpRequested(['--server', 'node s.js', '--uri', 'file:///a.x', '--content', '--help'], SAVE_VALUE_FLAGS)).toBe(false);
      expect(parseSaveArgs(['--server', 'node s.js', '--uri', 'file:///a.x', '--content', '--help'], onError).content).toBe('--help');

      // The flag position still works, which is the half a value-blind fix loses.
      expect(helpRequested(['--server', 'node s.js', '--help'], SAVE_VALUE_FLAGS)).toBe(true);
   });

   it('query: demands --uri and refuses an option it does not know', () => {
      expect(parseQueryArgs(['--server', 'node s.js', '--uri', 'file:///a.x'], onError).uri).toBe('file:///a.x');
      expect(() => parseQueryArgs(['--server', 'node s.js'], onError)).toThrow(
         'Missing required option: --uri (hydranium-cli query --help)'
      );
      expect(() => parseQueryArgs(['--server', 'node s.js', '--uri', 'file:///a.x', '--nope', 'x'], onError)).toThrow(
         'Unknown option: --nope (hydranium-cli query --help)'
      );
   });

   it('save: demands --uri and --content, and leaves --client-id to the runner', () => {
      expect(
         parseSaveArgs(['--server', 'node s.js', '--uri', 'file:///a.x', '--content', 'text', '--client-id', 'tester'], onError)
      ).toMatchObject({
         uri: 'file:///a.x',
         content: 'text',
         clientId: 'tester'
      });
      expect(() => parseSaveArgs(['--server', 'node s.js', '--uri', 'file:///a.x'], onError)).toThrow(
         'Missing required option: --content (hydranium-cli save --help)'
      );
      expect(parseSaveArgs(['--server', 'node s.js', '--uri', 'file:///a.x', '--content', 'text'], onError).clientId).toBeUndefined();
   });

   it('watch: demands --uri and carries no signal — that is the entry point to supply', () => {
      const parsed = parseWatchArgs(['--server', 'node s.js', '--uri', 'file:///a.x', '--client-id', 'tester'], onError);

      expect(parsed).toMatchObject({ uri: 'file:///a.x', clientId: 'tester' });
      expect(parsed.signal).toBeUndefined();
      expect(() => parseWatchArgs(['--server', 'node s.js'], onError)).toThrow(
         'Missing required option: --uri (hydranium-cli watch --help)'
      );
   });
});

describe('analyze-heap', () => {
   it('refuses a token it has no option for, rather than leaving it inert', () => {
      // The defect this closes: every read in the analyzer is an `indexOf`, so a
      // typo'd flag used to be invisible and the run proceeded on the default the
      // caller believed they had overridden.
      expect(() => parseAnalyzeHeapArgs(['heap.heapsnapshot', '--treshold', '0'], onError)).toThrow(
         'Unknown option: --treshold (hydranium-cli analyze-heap --help)'
      );
      expect(() => parseAnalyzeHeapArgs(['a.heapsnapshot', 'b.heapsnapshot'], onError)).toThrow(
         'Unexpected argument: b.heapsnapshot (hydranium-cli analyze-heap --help)'
      );
   });

   it('lets a top-N flag stand bare, and claims a following value only when it is not a flag', () => {
      expect(parseAnalyzeHeapArgs(['heap.heapsnapshot', '--strings'], onError).snapshot).toBe('heap.heapsnapshot');
      expect(parseAnalyzeHeapArgs(['--strings', '5', 'heap.heapsnapshot'], onError).snapshot).toBe('heap.heapsnapshot');
      // Without the second rule the bare form swallows the next flag, and the run
      // silently drops the mode it was asked for.
      expect(parseAnalyzeHeapArgs(['--strings', '--renderer', 'heap.heapsnapshot'], onError).snapshot).toBe('heap.heapsnapshot');
   });

   it('reads --diff as two values and as the one path that needs no snapshot', () => {
      expect(parseAnalyzeHeapArgs(['--diff', 'base.json', 'cur.json'], onError)).toEqual({ diff: true, snapshot: undefined });
      expect(() => parseAnalyzeHeapArgs(['--diff', 'base.json'], onError)).toThrow('Missing value for --diff');
      expect(() => parseAnalyzeHeapArgs(['--renderer'], onError)).toThrow(
         'Missing required option: <snapshot> (hydranium-cli analyze-heap --help)'
      );
   });

   it('keeps --help in a value position as data', () => {
      expect(helpRequested(['heap.heapsnapshot', '--help'], ANALYZE_HEAP_VALUE_FLAGS)).toBe(true);
      expect(helpRequested(['--classifier', '--help', 'heap.heapsnapshot'], ANALYZE_HEAP_VALUE_FLAGS)).toBe(false);
   });
});

describe('generate-transfer-model', () => {
   it('accepts every flag it documents', () => {
      // Worth asserting here and nowhere else: this parser is a hand-written
      // switch, so its flag list is written out rather than derived from the sets
      // a shared parser is handed. Elsewhere the list IS the parser's input and
      // the same assertion would be tautological.
      //
      // The flag stands alone, without a value. Supplying one cannot work for
      // every flag at once — `--watch` takes none, so the value becomes a stray
      // token and the parser rejects THAT as unknown, which reads as the flag
      // being unrecognised. A value flag alone reports its missing value, which
      // is a different message, so only a genuinely absent case can match here.
      // An empty list would make the loop below vacuous rather than failing.
      expect(GENERATE_TRANSFER_MODEL_FLAGS.length, 'no documented flags to check').toBeGreaterThan(0);
      for (const flag of GENERATE_TRANSFER_MODEL_FLAGS) {
         expect(() => parseGenerateOptions([flag], onError), `${flag} is documented but has no case`).not.toThrow(
            `Unknown option: ${flag}`
         );
      }
   });

   it('maps its path flags onto the generator options', () => {
      const parsed = parseGenerateOptions(
         ['--ast-file', 'a.ts', '--augmentation-file', 'b.ts', '--out-file', 'c.ts', '--element-type-name', 'Elem'],
         onError
      );

      expect(parsed.flags).toEqual({ astFile: 'a.ts', augmentationFile: 'b.ts', outFile: 'c.ts', elementTypeName: 'Elem' });
      expect(parsed.watch).toBe(false);
   });

   it('accumulates the repeatable skips, and omits them entirely when unused', () => {
      expect(parseGenerateOptions(['--skip-terminal', 'WS', '--skip-terminal', 'ML_COMMENT'], onError).flags.skipTerminals).toEqual([
         'WS',
         'ML_COMMENT'
      ]);
      // Omitted, not empty. The merge is first-defined-wins, so an empty array
      // here would shadow whatever the --config file supplied.
      expect(parseGenerateOptions([], onError).flags).not.toHaveProperty('skipTerminals');
      expect(parseGenerateOptions([], onError).flags).not.toHaveProperty('skipTypeAliases');
   });

   it('reports an unknown option without a help pointer, unlike its siblings', () => {
      // This command names no subcommand in the message. The difference is the
      // surface scripts already read, so it is pinned rather than harmonised.
      expect(() => parseGenerateOptions(['--nope'], onError)).toThrow('Unknown option: --nope');
      expect(() => parseGenerateOptions(['--nope'], onError)).not.toThrow(/hydranium-cli/);
   });

   it('reports a flag left without its value', () => {
      expect(() => parseGenerateOptions(['--out-file'], onError)).toThrow('Missing value for --out-file');
   });
});

/**
 * The two commands whose value-flag list is not derived from the sets a shared
 * parser is handed, and so is the only place that list can drift from the parser.
 *
 * Drift here is SILENT and re-opens a fixed defect: a value flag missing from the
 * list makes `--flag --help` print help and exit 0 again, and a presence-only flag
 * wrongly IN it swallows whatever token follows. Nothing else would fail — the
 * help/flags test checks a different list, and the parser tests never pass `--help`.
 *
 * Asserted in both directions off ONE parser behaviour, so neither half can be
 * satisfied by accident: a flag that takes a value reports a missing one when left
 * bare, and a presence-only flag does not.
 */
describe('the hand-maintained value-flag lists match their parser', () => {
   const CASES: ReadonlyArray<{
      name: string;
      flags: readonly string[];
      valueFlags: readonly string[];
      parse: (args: string[]) => unknown;
      /** Prefix that makes a bare grammar-scoped `init` flag legal at all. */
      lead: readonly string[];
   }> = [
      {
         name: 'generate-transfer-model',
         flags: GENERATE_TRANSFER_MODEL_FLAGS,
         valueFlags: GENERATE_TRANSFER_MODEL_VALUE_FLAGS,
         parse: args => parseGenerateOptions(args, onError),
         lead: []
      },
      {
         name: 'init',
         flags: INIT_FLAGS,
         valueFlags: INIT_VALUE_FLAGS,
         parse: args => parseInitArgs(args, onError),
         // `--extensions` / `--language-id` / `--diagram` apply to the PRECEDING
         // `--grammar`, so a bare one is refused before its value is ever missed.
         lead: ['./x', '--grammar', 'G']
      }
   ];

   it.each(CASES)('$name: every flag it calls value-taking demands a value', ({ flags, valueFlags, parse, lead }) => {
      for (const flag of valueFlags) {
         expect(flags, `${flag} is listed as value-taking but missing from the command's flag list`).toContain(flag);
         expect(() => parse([...lead, flag]), `${flag} is listed as value-taking but accepts none`).toThrow(`Missing value for ${flag}`);
      }
   });

   it.each(CASES)('$name: every flag it omits is genuinely presence-only', ({ flags, valueFlags, parse, lead }) => {
      const presenceOnly = flags.filter(flag => !valueFlags.includes(flag));
      // An empty set would make this vacuous — both commands have at least one.
      expect(presenceOnly.length).toBeGreaterThan(0);
      for (const flag of presenceOnly) {
         expect(() => parse([...lead, flag]), `${flag} is omitted from the value list but consumes a value`).not.toThrow(
            `Missing value for ${flag}`
         );
      }
   });
});
