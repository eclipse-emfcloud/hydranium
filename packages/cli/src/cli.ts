#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Command } from 'commander';
import { readCliVersion } from './cli-version.js';
import { runAnalyzeHeapCommand } from './commands/analyze-heap-args.js';
import { runAstGroundTruthCommand } from './commands/ast-ground-truth-args.js';
import { runGenerateTransferModelCommand } from './commands/generate-transfer-model-args.js';
import { runInitCommand } from './commands/init-args.js';
import { InitWizardCancelled } from './commands/init-prompt.js';
import { runLintGrammarCommand } from './commands/lint-grammar-args.js';
import { runMeasureMemoryCommand } from './commands/measure-memory-args.js';
import { runModelDocsCommand } from './commands/model-docs-args.js';
import { runProjectsCommand } from './commands/projects-args.js';
import { runQueryCommand } from './commands/query-args.js';
import { runReflectCommand } from './commands/reflect-args.js';
import { runSaveCommand } from './commands/save-args.js';
import { runValidateCommand } from './commands/validate-args.js';
import { runWatchCommand } from './commands/watch-args.js';

/**
 * The subcommand table, as name → handler over that command's own argv tail.
 *
 * Each handler owns its own flag parsing, in a sibling `<name>-args` module that
 * also holds the command's flag list and its help text as data. `commander`
 * provides the dispatch, the command list and the top-level help, but NOT the
 * option parsing: it would generate the per-command help from declared options,
 * at the price of its own error vocabulary replacing the messages scripts match
 * on. `init` could not follow it there in any case — its grammar-scoped flags
 * (`--extensions` applies to the PRECEDING `--grammar`) depend on the relative
 * order of two DIFFERENT option names, which no declarative option model
 * expresses.
 */
const COMMANDS: Record<string, { readonly summary: string; readonly run: (args: string[]) => void | Promise<void> }> = {
   'analyze-heap': { summary: 'Analyze a V8 heap snapshot (needs optional @memlab/heap-analysis).', run: runAnalyzeHeapCommand },
   'ast-ground-truth': {
      summary: "Tally a workspace's live-model $types (analyze-heap --validate input).",
      run: runAstGroundTruthCommand
   },
   'generate-transfer-model': {
      summary: 'Generate a transfer-model TypeScript file from a Langium AST.',
      run: runGenerateTransferModelCommand
   },
   init: { summary: 'Scaffold a new Hydranium language project (grammar + server head).', run: runInitCommand },
   'lint-grammar': { summary: 'Check a grammar against framework conventions (CI gate).', run: runLintGrammarCommand },
   'measure-memory': { summary: 'Measure model-store memory for a workspace (needs @hydranium/core).', run: runMeasureMemoryCommand },
   'model-docs': { summary: 'Generate a navigable Markdown model reference for adopter docs.', run: runModelDocsCommand },
   projects: { summary: 'List projects exposed by a data-server subprocess.', run: runProjectsCommand },
   query: { summary: 'Print the data-server document envelope for a URI.', run: runQueryCommand },
   reflect: { summary: "Dump a head's grammar/AST reflection (types, terminals, refs).", run: runReflectCommand },
   save: { summary: 'Update + persist a document via a data-server subprocess.', run: runSaveCommand },
   validate: { summary: 'Validate a workspace headlessly; non-zero exit on errors (CI gate).', run: runValidateCommand },
   watch: { summary: 'Subscribe to data-server document updates; print events as NDJSON.', run: runWatchCommand }
};

/**
 * The `commander` program.
 *
 * `.usage()` and the help formatter are pinned to the shape scripts already
 * read — `Usage: hydranium-cli <command> [options]` with a two-space-indented
 * command list — because a CI step that greps the usage line is a contract, not
 * cosmetics. Each subcommand passes its raw tail through to its own handler
 * (`.allowUnknownOption()` plus a variadic operand), so commander owns dispatch
 * and discovery while the handlers keep the exact flag semantics they had.
 */
function buildProgram(): Command {
   const program = new Command();
   program
      .name('hydranium-cli')
      .usage('<command> [options]')
      .addHelpText('after', '\nRun `hydranium-cli <command> --help` for command-specific options.')
      .helpOption('-h, --help', 'Show this help.')
      // Declared so the top-level help lists it; the dispatch below answers it,
      // because commander would otherwise never see the token — an argv whose
      // first word is not a known subcommand is rejected before `parseAsync`.
      .version(readCliVersion(), '-V, --version', 'Show the version.')
      // No `help <command>` alias: the surface stays exactly the COMMANDS
      // table, and `<command> --help` already covers what it would offer.
      .helpCommand(false)
      .configureHelp({ subcommandTerm: command => command.name() });
   for (const [name, { summary, run }] of Object.entries(COMMANDS)) {
      program
         .command(name)
         .summary(summary)
         .description(summary)
         .allowUnknownOption()
         .allowExcessArguments()
         .helpOption(false)
         .argument('[args...]')
         .action(async (args: string[]) => {
            await run(args);
         });
   }
   return program;
}

async function main(argv: string[]): Promise<void> {
   const [command] = argv;
   // Handled ahead of commander so the three shapes a script can depend on keep
   // their exact contract: a bare invocation prints usage on STDOUT and exits 1,
   // `--help` prints the same on stdout and exits 0, and an unknown command
   // names itself on STDERR with the usage still on stdout.
   const program = buildProgram();
   if (!command || command === '--help' || command === '-h') {
      program.outputHelp();
      process.exit(command ? 0 : 1);
   }
   // Ahead of the unknown-command branch, which claims every first token the
   // COMMANDS table does not name and would report the flag as a misspelt
   // subcommand on stderr with a non-zero exit.
   if (command === '--version' || command === '-V') {
      console.log(readCliVersion());
      process.exit(0);
   }
   if (!Object.hasOwn(COMMANDS, command)) {
      console.error(`Unknown command: ${command}`);
      program.outputHelp();
      process.exit(1);
   }
   await program.parseAsync(argv, { from: 'user' });
}

main(process.argv.slice(2)).catch(err => {
   // Ctrl-C out of the wizard is a choice, not a failure: clack has already
   // drawn its cancel line, so printing a stack trace over it would report the
   // user's own decision back to them as an error.
   if (err instanceof InitWizardCancelled) {
      process.exit(130);
   }
   console.error(err instanceof Error ? err.message : String(err));
   process.exit(1);
});
