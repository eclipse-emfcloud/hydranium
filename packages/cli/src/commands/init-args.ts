/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `init`'s argv parser.
 *
 * Its own module rather than a function in the CLI entry point, because the
 * entry point runs `main()` on import: a test that wants to read an argv the
 * way the command does would otherwise have to execute the whole binary. That
 * matters more here than for the other subcommands, since the wizard's entire
 * contract is that its composed argv means exactly what a typed one would — a
 * claim only a test that round-trips through THIS function can check.
 *
 * The parsing is hand-written rather than declared to `commander` because the
 * grammar-scoped flags are ORDER-dependent across different option names:
 * `--extensions` applies to the `--grammar` it follows, so
 * `--grammar A --extensions x --grammar B` and
 * `--grammar A --grammar B --extensions x` mean different things. A declarative
 * option model collects `{grammar: [A, B], extensions: [x]}` for both and the
 * association is gone.
 */

import { assertRequired, exitWithUsage, helpRequested, printHelp, type UsageError } from './harness-args.js';
import { isNonEmptyDir, runInit, type InitHead } from './init.js';
import { createClackPrompt } from './init-prompt.js';
import { runInitWizard } from './init-wizard.js';
import { createNodeWorkspaceProbe, detectWorkspace } from './init-workspace.js';

/** One grammar as the command line collected it, before any derivation. */
export interface ParsedInitGrammar {
   name: string;
   extensions?: string[];
   languageId?: string;
   diagram?: boolean;
}

/** `init`'s argv, parsed but not validated — a missing `--name` is the wizard's cue, not an error. */
export interface ParsedInitArgs {
   targetDir?: string;
   name?: string;
   force: boolean;
   heads?: InitHead[];
   monorepo: boolean;
   scope?: string;
   public: boolean;
   grammars: ParsedInitGrammar[];
}

/**
 * Every flag `init` accepts, as data.
 *
 * The single source the parser's own switch and the `--help` text both read,
 * with a test asserting they agree. A flag added to one and not the other is
 * the silent drift this list exists to make impossible.
 */
export const INIT_FLAGS: readonly string[] = [
   '--name',
   '--heads',
   '--force',
   '--monorepo',
   '--scope',
   '--public',
   '--grammar',
   '--extensions',
   '--language-id',
   '--diagram'
];

/**
 * The subset that takes a value, so `--help` in a value position reads as data.
 * The rest are presence-only.
 */
export const INIT_VALUE_FLAGS: readonly string[] = ['--name', '--heads', '--scope', '--grammar', '--extensions', '--language-id'];

/**
 * Parse `init`'s flags without deciding whether the result is complete.
 *
 * Shared by the wizard and the flag path so both read an argv with ONE parser:
 * the wizard's contract is that its composed argv means exactly what a typed
 * one would, which only holds if the same code reads both.
 *
 * `onError` receives a usage message. It defaults to reporting and exiting,
 * which is what a command line wants; a caller that would rather handle the
 * problem passes its own and the function throws instead of ending the process.
 */
export function parseInitArgs(args: string[], onError: UsageError = exitWithUsage): ParsedInitArgs {
   let targetDir: string | undefined;
   let name: string | undefined;
   let force = false;
   let heads: InitHead[] | undefined;
   let monorepo = false;
   let scope: string | undefined;
   let isPublic = false;
   const grammars: ParsedInitGrammar[] = [];
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
      // A grammar-scoped flag modifies the grammar it follows, so with no
      // `--grammar` yet there is nothing for it to mean. Refusing loudly beats
      // silently attaching it to a grammar the user never named.
      const scoped = (): ParsedInitGrammar => {
         const current = grammars[grammars.length - 1];
         if (current === undefined) {
            onError(`${flag} must follow a --grammar (hydranium-cli init --help)`);
         }
         return current;
      };
      switch (flag) {
         case '--name':
            name = next();
            break;
         case '--grammar':
            grammars.push({ name: next() });
            break;
         case '--extensions': {
            const grammar = scoped();
            grammar.extensions = [...(grammar.extensions ?? []), ...next().split(',')];
            break;
         }
         case '--language-id':
            scoped().languageId = next();
            break;
         case '--diagram':
            scoped().diagram = true;
            break;
         case '--heads': {
            // Validated in `resolveInitComposition`, which owns the rule that
            // `lsp` is mandatory; the cast only gets the strings that far.
            heads = next().split(',') as InitHead[];
            break;
         }
         case '--force':
            force = true;
            break;
         case '--monorepo':
            monorepo = true;
            break;
         case '--scope':
            scope = next();
            break;
         case '--public':
            isPublic = true;
            break;
         default:
            // A grammar takes N extensions, so the flag is plural. Naming the
            // singular spelling beats a bare "unknown option" for what is
            // otherwise a silent typo.
            if (flag === '--extension') {
               onError('Unknown option: --extension — did you mean --extensions? (hydranium-cli init --help)');
            } else if (flag.startsWith('--')) {
               onError(`Unknown option: ${flag} (hydranium-cli init --help)`);
            } else if (targetDir === undefined) {
               targetDir = flag;
            } else {
               onError(`Unexpected argument: ${flag} (hydranium-cli init --help)`);
            }
      }
   }
   return { targetDir, name, force, heads, monorepo, scope, public: isPublic, grammars };
}

/**
 * The `init --help` text, as data.
 *
 * Exported so a test can assert it documents every flag {@link INIT_FLAGS}
 * names. Help that drifts from the parser is worse than none: it is read as
 * authoritative, and a flag missing from it is a capability nobody finds.
 */
export const INIT_HELP: readonly string[] = [
   'Usage: hydranium-cli init <target-dir> --name <Name> [--heads <list>] [--force]',
   '                            [--monorepo] [--scope <@scope>] [--public]',
   '                            ( --grammar <Name> [--extensions <list>]',
   '                                              [--language-id <id>] [--diagram] )...',
   '',
   'Scaffold a new Hydranium language project end-to-end: a starter grammar per',
   '--grammar, the `create<Name>Services` DI wiring, an LSP + data-server launch,',
   'langium-config, package.json, and build scripts. Does NOT run `npm install` or',
   '`langium generate` — those are printed as next steps. Refuses a non-empty',
   'directory without --force.',
   '',
   'Run it with no --name on a terminal to be prompted instead. The wizard echoes',
   'the command it composed before running it, so every answer is reproducible as',
   'flags. Without a terminal a missing --name stays an error, so CI never hangs.',
   '',
   'Project options (position-free):',
   '  <target-dir>          Directory to scaffold into (required).',
   '  --name <Name>         PascalCase PROJECT name; drives the services and the',
   '                        Langium projectName, i.e. the shared generated symbols',
   '                        (<Name>AstReflection, <Name>GeneratedSharedModule) (required).',
   '  --heads <list>        Comma-separated protocol heads: lsp, data, glsp.',
   '                        `lsp` is mandatory — it owns the workspace, the build',
   '                        pipeline and the shared tier the others read through.',
   '                        The emitted dependencies, main.ts and module bindings',
   '                        all follow this set. Default: lsp,data.',
   '  --force               Scaffold into a non-empty directory anyway.',
   '  --monorepo            Scaffold a member of the surrounding npm workspace:',
   '                        tsconfig extends the root config that actually carries',
   '                        compilerOptions, .gitignore is left to the root, and the',
   '                        scripts address the package by --prefix. Errors when no',
   '                        ancestor declares `workspaces`. Never writes outside the',
   '                        target — the root `workspaces` entry is printed, not added.',
   '  --scope <@scope>      npm scope for the package name, e.g. @acme. Not inferred:',
   '                        a root manifest is usually named for the repo, not the',
   '                        scope. The wizard offers the siblings’ scope as a default.',
   '  --public              Omit "private": true, so the package can be published.',
   '                        The scaffold emits it by default, because the manifest',
   '                        it also emits declares license "UNLICENSED": a package',
   '                        granting no rights on a public registry contradicts',
   '                        itself. Pass this once the project has picked a licence.',
   '',
   'Grammar options — each applies to the PRECEDING --grammar:',
   '  --grammar <Name>      PascalCase GRAMMAR name; drives the `grammar X` declaration',
   '                        and the per-language generated symbols',
   '                        (<Grammar>GeneratedModule, <Grammar>LanguageMetaData).',
   '                        Repeatable — pass it once per grammar. Default: --name.',
   '  --extensions <list>   Comma-separated file extensions for that grammar, leading',
   '                        dot optional. Repeatable; accumulates. Default: the kebab',
   '                        grammar name.',
   '  --language-id <id>    Override that grammar’s derived routing key',
   '                        (default: <project-id>-<grammar-id>).',
   '  --diagram             Scaffold a GLSP diagram for that grammar. Requires',
   '                        `glsp` in --heads. Derived when there is exactly one',
   '                        grammar; required when there are several, because a',
   '                        diagram type binds exactly one grammar.',
   '',
   'Example — three grammars, one with a differing extension, three heads:',
   '  hydranium-cli init ./order-flow --name OrderFlow --heads lsp,data,glsp \\',
   '    --grammar Domain --grammar Process --diagram \\',
   '    --grammar Layout --extensions diagram'
];

export async function runInitCommand(args: string[]): Promise<void> {
   if (helpRequested(args, INIT_VALUE_FLAGS)) {
      printHelp(INIT_HELP);
      return;
   }
   const parsed = parseInitArgs(args);
   // The wizard's entry point: no `--name` on an interactive terminal. Safe
   // because that combination has no non-wizard meaning, and gated on a TTY
   // because a non-interactive caller must keep failing fast — a prompt in CI
   // hangs the job instead of reporting the missing flag.
   if (parsed.name === undefined && process.stdin.isTTY && process.stdout.isTTY) {
      const prompt = await createClackPrompt();
      const argv = await runInitWizard(prompt, targetDir => detectWorkspace(targetDir, createNodeWorkspaceProbe()), {
         targetDir: parsed.targetDir,
         isOccupied: isNonEmptyDir
      });
      return runInitCommand(argv);
   }
   runInit({
      targetDir: assertRequired(parsed.targetDir, '<target-dir>', 'init'),
      name: assertRequired(parsed.name, '--name', 'init'),
      grammars: parsed.grammars,
      heads: parsed.heads,
      force: parsed.force,
      monorepo: parsed.monorepo,
      scope: parsed.scope,
      public: parsed.public
   });
}
