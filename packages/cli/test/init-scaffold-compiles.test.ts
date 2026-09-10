/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The acceptance tier: real scaffolds, generated and then COMPILED.
 *
 * The gap this closes is specific and has bitten before. The sibling goldens pin
 * the emitted bytes and the unit tier pins the file set, but neither can tell
 * whether the emitted TypeScript is *valid* TypeScript — a template literal that
 * over-escapes produces a byte-identical golden, a green unit suite, and a
 * project that does not build. Only a compiler reading the output catches it.
 *
 * **Every shape is compiled, not just the smallest.** The head set and the
 * grammar count each select different templates, and the ones a single-grammar
 * `lsp,data` scaffold never reaches are the intricate ones: the GLSP head emits
 * eight further files of DI wiring, a type registry, an AST→GModel walk and the
 * starter operation handler, and the multi-grammar shape is the only one emitting
 * the shared terminal fragment and the `additionalLanguages` composition. Covering only the simplest case
 * would aim this tier away from the code most likely to break.
 *
 * Each case scaffolds in `--monorepo` mode, which emits the same TypeScript as
 * the standalone shape and additionally exercises what a rendered-template diff
 * cannot check: that the derived `extends` resolves to a config carrying
 * `compilerOptions`. A wrong `extends` inherits nothing and fails silently.
 *
 * They run inside the repo (under a gitignored `out/`) because the scaffold
 * imports `@hydranium/*`, `langium` and `@eclipse-glsp/*`, which resolve through
 * the workspace's hoisted `node_modules` — the scaffold's own `npm install`
 * would 404 until the packages are published.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateTransferModel } from '../src/commands/generate-transfer-model.js';
import { type InitGrammarSpec, type InitHead, runInit } from '../src/commands/init.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');

/** Generating and type-checking a project is slow next to the rest of the suite. */
const COMPILE_TIMEOUT_MS = 180_000;

/** One scaffold shape worth compiling, and what makes it distinct. */
interface CompileCase {
   readonly label: string;
   readonly name: string;
   readonly heads?: readonly InitHead[];
   readonly grammars?: readonly InitGrammarSpec[];
}

const CASES: readonly CompileCase[] = [
   { label: 'the single-grammar default', name: 'Bookshelf', grammars: [{ name: 'Bookshelf', extensions: ['book'] }] },
   // The largest emission: eight further files the other shapes never reach.
   { label: 'the GLSP head', name: 'Shelf', heads: ['lsp', 'data', 'glsp'] },
   // The only shape emitting common.langium and the additionalLanguages wiring.
   {
      label: 'three grammars',
      name: 'Depot',
      grammars: [{ name: 'Domain' }, { name: 'Process' }, { name: 'Layout' }]
   }
];

/**
 * Run a repo-local Node tool in the scaffold.
 *
 * The captured output is re-thrown rather than swallowed: `tsc` reports the
 * offending file and line on STDOUT, and without it a failure here says only
 * "command failed" about a project that no longer exists by the time anyone
 * reads it.
 */
function runTool(targetDir: string, binary: string, args: readonly string[]): void {
   try {
      execFileSync(process.execPath, [path.join(REPO_ROOT, binary), ...args], { cwd: targetDir, stdio: 'pipe', encoding: 'utf-8' });
   } catch (err: unknown) {
      const output = err as { stdout?: string; stderr?: string };
      throw new Error(`${binary} failed:\n${output.stdout ?? ''}${output.stderr ?? ''}`);
   }
}

describe('the emitted scaffold compiles', () => {
   it.each(CASES)(
      'generates and type-checks $label',
      ({ name, heads, grammars }) => {
         const targetDir = path.join(PACKAGE_ROOT, `out/scaffold-compiles-${name.toLowerCase()}`);
         try {
            fs.rmSync(targetDir, { recursive: true, force: true });
            // `force` so a directory left by an interrupted run cannot turn the
            // next one into a confusing "not empty" refusal about state this
            // test owns and is about to overwrite anyway.
            runInit({
               targetDir,
               name,
               heads,
               grammars,
               monorepo: true,
               scope: '@hydranium',
               public: true,
               force: true,
               write: () => undefined
            });
            // The scaffold is the input to everything below, so its absence must
            // read as "nothing was written" rather than as a generator failing
            // on a file it cannot find.
            expect(fs.existsSync(path.join(targetDir, 'langium-config.json')), 'runInit wrote no scaffold').toBe(true);

            // The `extends` is only meaningful if it resolves; assert that before
            // handing the project to tsc, so a broken path reads as a broken path
            // rather than as a wall of missing-compiler-option errors.
            const tsconfig = JSON.parse(fs.readFileSync(path.join(targetDir, 'tsconfig.json'), 'utf-8')) as { extends?: string };
            expect(tsconfig.extends).toBeDefined();
            const base = path.resolve(targetDir, tsconfig.extends as string);
            expect(fs.existsSync(base), `${tsconfig.extends} does not resolve from the scaffold`).toBe(true);
            expect(JSON.parse(fs.readFileSync(base, 'utf-8'))).toHaveProperty('compilerOptions');

            // Both halves of the emitted `generate` script, in its order.
            runTool(targetDir, 'node_modules/langium-cli/bin/langium.js', [
               'generate',
               '--file',
               path.join(targetDir, 'langium-config.json')
            ]);
            generateTransferModel({
               astFile: path.join(targetDir, 'src/language-server/generated/ast.ts'),
               augmentationFile: path.join(targetDir, 'src/language-server/ast.ts'),
               outFile: path.join(targetDir, 'src/language-server/generated-hydranium/transfer-model.ts'),
               elementTypeName: `${name}Element`,
               terminalsName: `${name}Terminals`
            });

            expect(() =>
               runTool(targetDir, 'node_modules/typescript/bin/tsc', ['--noEmit', '-p', path.join(targetDir, 'tsconfig.json')])
            ).not.toThrow();

            // The emitted `typecheck:test`, which is a DIFFERENT check: it also
            // covers `test/`, and it turns on `isolatedModules`, so it is the only
            // thing that proves the emitted sources satisfy the stricter rules the
            // esbuild-based test runner needs.
            expect(() =>
               runTool(targetDir, 'node_modules/typescript/bin/tsc', ['--noEmit', '-p', path.join(targetDir, 'tsconfig.test.json')])
            ).not.toThrow();
         } finally {
            // In `finally`, so a failing case cannot leave a directory that
            // makes the NEXT run fail for a different and misleading reason.
            fs.rmSync(targetDir, { recursive: true, force: true });
         }
      },
      COMPILE_TIMEOUT_MS
   );
});
