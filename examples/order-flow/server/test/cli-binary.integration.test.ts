/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `hydranium-cli` **binary**, spawned as a process, against this example's
 * three real grammars.
 *
 * What only a spawned binary covers: the argv parser, the subcommand dispatch
 * table and the exit codes. Calling the exported `run*` functions directly — as
 * the CLI's own suites and the sibling `cli-stdio.integration.test.ts` do —
 * bypasses all three, so the entry point an adopter actually runs and the exit
 * codes their CI reads are only exercised here.
 *
 * Two properties need a real head, and neither is reachable from the CLI package
 * — which carries no runtime `@hydranium/core` dependency by design, the head's
 * copy being resolved through `--services` at run time:
 *
 * - **The gate's exit code comes from a genuinely broken model.** `validate`
 *   boots the head, builds the workspace, links it, finds the deliberate
 *   `orders/audit-leak.domain` negative and exits non-zero. A stub answering
 *   from a literal cannot show that any of those steps happened.
 * - **One reflection covers every registered language.** `reflect` and
 *   `model-docs` read `shared.ServiceRegistry.all`, so a three-grammar head is
 *   the first input that can tell "reflects the head" apart from "reflects the
 *   only language it has" — the assertion a single-grammar example cannot make.
 *   The sharpest form of it is the cross-grammar reference chain
 *   `LayoutModel.process → ProcessModel → Entity`, which no single language
 *   contributes on its own.
 *
 * Every case asserts BOTH the exit status and the report content, because either
 * alone passes against a broken half: a subcommand that prints the right report
 * and forgets its exit code still lets CI go green, and one that exits non-zero
 * for an unrelated reason reads as a working gate.
 *
 * **stderr is captured, never asserted empty.** `LspLogger` writes the head's
 * info lines there whenever no LSP client is attached, so the line count is
 * log-level-dependent and unbounded; it is reported on failure instead.
 *
 * Deliberately NOT here: an assertion that `generate-transfer-model` reproduces
 * the checked-in `generated-transfer/transfer-model.ts`. Freshness of a
 * generated artefact is the BUILD's job in this repo — the example's `build`
 * runs its own `generate` — so that case emits into a throwaway `--out-file` and
 * asserts the result is well-formed instead.
 */

import { makeScratchWorkspace, type ScratchWorkspace } from '@hydranium/core/testing/node';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKSPACE_FILES, WORKSPACE_ROOT } from './order-flow-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The installed `hydranium-cli` entry — `lib/cli.js`, the file this package's
 * `@hydranium/cli` dependency names under `bin`.
 *
 * Resolved through the dependency edge rather than by walking up to the CLI's own
 * source tree, so what runs is the artefact an adopter gets from
 * `npx hydranium-cli`. A resolution failure means `lib/` is missing, which
 * `turbo run test`'s `dependsOn: ["build"]` rules out; the rethrow names the fix
 * rather than leaving a bare `MODULE_NOT_FOUND`.
 */
const CLI_BIN = resolveCliBin();

/**
 * The zero-arg `createServices` module every headless subcommand loads. Pointed
 * at `lib/` rather than `src/`: the CLI dynamic-imports plain ESM from a `node`
 * child, so what is under test is the compiled module an adopter ships.
 */
const SERVICES_MODULE = path.resolve(HERE, '../lib/services.js');

/**
 * Booting three grammars over the sample workspace in a cold subprocess — and,
 * for `validate`, a second child below it — is well past vitest's 5s default,
 * and a timeout here reads as a hang rather than as slowness.
 */
const SPAWN_TIMEOUT_MS = 60_000;

function resolveCliBin(): string {
   try {
      return createRequire(import.meta.url).resolve('@hydranium/cli/lib/cli.js');
   } catch {
      throw new Error('hydranium-cli is not built. Run "npm run build" before "npm test".');
   }
}

/** What a finished `hydranium-cli` process left behind. */
interface CliRun {
   /** Exit status, `null` if the child was signalled. */
   readonly code: number | null;
   readonly stdout: string;
   readonly stderr: string;
}

/** The seeded copy `validate` builds, and the default cwd for every case. */
let workspace: ScratchWorkspace | undefined;
/** An empty directory for the cases that write, kept out of the workspace copy. */
let outputDir: ScratchWorkspace | undefined;

beforeEach(() => {
   // A copy rather than the committed workspace: the build runs the integrity
   // rules, whose default silent mode persists repairs through
   // `FileSystemProvider.writeFile`, so a child pointed at the sample workspace
   // may rewrite it (see `makeScratchWorkspace`'s own docs).
   workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-cli-binary-' });
   outputDir = makeScratchWorkspace({ prefix: 'order-flow-cli-binary-out-' });
});

afterEach(() => {
   workspace?.dispose();
   outputDir?.dispose();
   workspace = undefined;
   outputDir = undefined;
});

/** A required scratch directory, or a throw naming the missing setup. */
function scratch(directory: ScratchWorkspace | undefined, role: string): ScratchWorkspace {
   if (!directory) {
      throw new Error(`scratch ${role} not initialized`);
   }
   return directory;
}

/**
 * Spawn `node <cli.js> <args...>` and resolve once it is fully finished.
 *
 * `cwd` defaults to the seeded copy, which matters beyond tidiness:
 * `generate-transfer-model` auto-detects `./langium-config.json` and would pick
 * up a real one if the child inherited a package directory, so every case runs
 * from a directory that has none.
 *
 * Resolves on `close`, not `exit`. `validate` sets `process.exitCode` and lets
 * Node exit on its own rather than calling `process.exit`, so at `exit` time the
 * report can still be draining through the pipes; `close` fires only after both
 * streams have ended.
 */
function runCli(args: readonly string[], options: { readonly cwd?: string } = {}): Promise<CliRun> {
   return new Promise<CliRun>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_BIN, ...args], {
         cwd: options.cwd ?? scratch(workspace, 'workspace').root,
         stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => {
         stdout += String(chunk);
      });
      child.stderr.on('data', chunk => {
         stderr += String(chunk);
      });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
   });
}

describe('hydranium-cli binary against a real three-grammar head', () => {
   it(
      "validate: exits non-zero and reports the workspace's one deliberate error",
      async () => {
         const root = scratch(workspace, 'workspace').root;
         const run = await runCli(['validate', '--services', SERVICES_MODULE, root]);

         // The gate contract: a workspace with an error must fail the process.
         expect(run.code, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(1);
         expect(run.stdout).toContain(WORKSPACE_FILES.auditLeak);
         expect(run.stdout).toContain("Could not resolve reference to Declaration named 'AuditStamp'.");
         // 8 = the 7 model files plus the stdlib virtual document. The tally is
         // over `LangiumDocuments`, not over validated documents: the framework
         // validator skips virtual documents, and the stdlib is grammar-clean
         // anyway, so it is counted here and contributes no finding either way.
         expect(run.stdout).toContain('1 error in 8 files.');
      },
      SPAWN_TIMEOUT_MS
   );

   it(
      'reflect: one reflection carries all three languages and the references between them',
      async () => {
         const run = await runCli(['reflect', '--services', SERVICES_MODULE]);

         expect(run.code, `stderr:\n${run.stderr}`).toBe(0);
         // Each language by id, extension and entry rule — the three triples a
         // single-grammar head cannot produce.
         expect(run.stdout).toContain('### order-flow-domain');
         expect(run.stdout).toContain('- File extensions: `.domain`');
         expect(run.stdout).toContain('- Entry rule: `DomainModel`');
         expect(run.stdout).toContain('### order-flow-process');
         expect(run.stdout).toContain('- File extensions: `.process`');
         expect(run.stdout).toContain('- Entry rule: `ProcessModel`');
         expect(run.stdout).toContain('### order-flow-layout');
         expect(run.stdout).toContain('- File extensions: `.layout`');
         expect(run.stdout).toContain('- Entry rule: `LayoutModel`');
         // The load-bearing pair: a chain of cross-references that spans the
         // three grammars, layout → process → domain. It renders only when one
         // reflection holds all of them, so it separates "reflected the head"
         // from "reflected whichever language answered first".
         expect(run.stdout).toContain('- `LayoutModel.process` → `ProcessModel`');
         expect(run.stdout).toContain('- `ProcessModel.subject` → `Entity`');
      },
      SPAWN_TIMEOUT_MS
   );

   it(
      'model-docs: emits a language section and an indexed entry type per grammar',
      async () => {
         const run = await runCli(['model-docs', '--services', SERVICES_MODULE]);

         expect(run.code, `stderr:\n${run.stderr}`).toBe(0);
         expect(run.stdout).toContain('# Model reference');
         expect(run.stdout).toContain('### order-flow-domain');
         expect(run.stdout).toContain('### order-flow-process');
         expect(run.stdout).toContain('### order-flow-layout');
         // The type index is one list over the shared reflection, so all three
         // entry types appearing in it is the cross-grammar claim.
         expect(run.stdout).toContain('- [DomainModel](#domainmodel)');
         expect(run.stdout).toContain('- [ProcessModel](#processmodel)');
         expect(run.stdout).toContain('- [LayoutModel](#layoutmodel)');
      },
      SPAWN_TIMEOUT_MS
   );

   it(
      'generate-transfer-model: emits a well-formed transfer model from the real grammars',
      async () => {
         const outFile = path.join(scratch(outputDir, 'output directory').root, 'transfer-model.ts');
         const run = await runCli([
            'generate-transfer-model',
            '--ast-file',
            path.resolve(HERE, '../src/language-server/generated/ast.ts'),
            '--augmentation-file',
            path.resolve(HERE, '../src/language-server/ast.ts'),
            '--out-file',
            outFile,
            '--element-type-name',
            'OrderFlowElement',
            '--terminals-name',
            'OrderFlowTerminals'
         ]);

         expect(run.code, `stderr:\n${run.stderr}`).toBe(0);
         expect(run.stdout).toContain(`Generated: ${outFile}`);

         const emitted = readFileSync(outFile, 'utf8');
         expect(emitted).toContain('DO NOT EDIT MANUALLY');
         expect(emitted).toContain('export interface OrderFlowElement');
         // One generated file spans all three grammars, because the Langium AST
         // it reads is the shared one: the three entry types, and a terminal
         // (`NUMBER`) plus keywords only the layout grammar declares.
         expect(emitted).toContain("export const DomainModelType = 'DomainModel';");
         expect(emitted).toContain("export const ProcessModelType = 'ProcessModel';");
         expect(emitted).toContain("export const LayoutModelType = 'LayoutModel';");
         expect(emitted).toContain('export const OrderFlowTerminals = {');
         expect(emitted).toContain('NUMBER:');
         expect(emitted).toContain("'layout'");
      },
      SPAWN_TIMEOUT_MS
   );
});

/**
 * The dispatch table's own edges — the only CLI behaviour a user meets before any
 * head is loaded, and the reason a bad invocation must not look like a clean run.
 */
describe('hydranium-cli binary dispatch', () => {
   it(
      'no subcommand: prints usage and exits non-zero',
      async () => {
         const run = await runCli([]);

         // Non-zero on a bare invocation, so a CI step that forgot its
         // subcommand fails instead of reporting success.
         expect(run.code).toBe(1);
         expect(run.stdout).toContain('Usage: hydranium-cli <command> [options]');
         expect(run.stdout).toContain('  validate  ');
      },
      SPAWN_TIMEOUT_MS
   );

   it(
      '--help: prints the same usage and exits zero',
      async () => {
         const run = await runCli(['--help']);

         // Explicitly asking for help succeeded, so `hydranium-cli --help` in a
         // script is not a failure.
         expect(run.code).toBe(0);
         expect(run.stdout).toContain('Usage: hydranium-cli <command> [options]');
      },
      SPAWN_TIMEOUT_MS
   );

   it(
      'unknown subcommand: names it on stderr and exits non-zero',
      async () => {
         const run = await runCli(['not-a-subcommand']);

         expect(run.code).toBe(1);
         expect(run.stderr).toContain('Unknown command: not-a-subcommand');
         expect(run.stdout).toContain('Usage: hydranium-cli <command> [options]');
      },
      SPAWN_TIMEOUT_MS
   );
});
