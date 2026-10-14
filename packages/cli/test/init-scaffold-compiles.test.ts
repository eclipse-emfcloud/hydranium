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
 * further files of DI wiring, a type registry, an AST→GModel walk, the starter
 * operation handler and the test that runs it, and the multi-grammar shape is
 * the only one emitting the shared terminal fragment and the
 * `additionalLanguages` composition. Covering only the simplest case would aim
 * this tier away from the code most likely to break.
 *
 * Each case scaffolds in `--monorepo` mode, which emits the same TypeScript as
 * the standalone shape and additionally exercises what a rendered-template diff
 * cannot check: that the derived `extends` resolves to a config carrying
 * `compilerOptions`. A wrong `extends` inherits nothing and fails silently.
 *
 * They run inside the repo (under a gitignored `out/`) because the scaffold
 * imports `@hydranium/*`, `langium` and `@eclipse-glsp/*`, which resolve through
 * this package's devDependencies — the scaffold's own `npm install` would 404
 * until the packages are published. The server's import of its sibling
 * protocol member is the one no devDependency can answer, so the test links
 * that member where the server resolves it, as the scaffold's workspace would.
 */

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { findPackageJSON } from 'node:module';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateTransferModel } from '../src/commands/generate-transfer-model.js';
import { type InitGrammarSpec, type InitHead, runInit } from '../src/commands/init.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
   // The largest emission: further files the other shapes never reach.
   { label: 'the GLSP head', name: 'Shelf', heads: ['lsp', 'data', 'glsp'] },
   // The only shape emitting common.langium and the additionalLanguages wiring.
   {
      label: 'three grammars',
      name: 'Depot',
      grammars: [{ name: 'Domain' }, { name: 'Process' }, { name: 'Layout' }]
   },
   // The only main.ts that brings the workspace up itself and prints its ports.
   { label: 'no LSP head', name: 'Rack', heads: ['data', 'glsp'] }
];

/**
 * The JSON line `lib/main.js` prints on stdout, beside GLSP's startup line; the
 * process is stopped and has exited when this settles. Rejects with its stderr
 * when it exits before printing the line.
 */
async function portsLine(server: string, args: readonly string[]): Promise<string> {
   const child = spawn(process.execPath, ['lib/main.js', ...args], { cwd: server, stdio: ['ignore', 'pipe', 'pipe'] });
   const stderr: string[] = [];
   child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
   const lines = readline.createInterface({ input: child.stdout });
   const line = new Promise<string>(resolve => lines.on('line', text => text.startsWith('{') && resolve(text)));
   const exit = once(child, 'exit');
   const exited = exit.then(([code]) => Promise.reject(new Error(`main.js exited ${String(code)}:\n${stderr.join('')}`)));
   try {
      return await Promise.race([line, exited]);
   } finally {
      exited.catch(() => undefined);
      child.kill();
      // Waited for, since Windows refuses to delete the directory a live
      // process runs in.
      await exit;
   }
}

/**
 * The file behind `command` in the copy of `packageName` this package resolves.
 *
 * Not `<name>/package.json` through `require.resolve`, which `langium-cli`'s
 * exports map refuses.
 */
function binPath(packageName: string, command: string): string {
   const manifestPath = findPackageJSON(packageName, import.meta.url);
   if (manifestPath === undefined) {
      throw new Error(`${packageName} does not resolve from this package`);
   }
   const bin = (JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { bin?: Record<string, string> }).bin?.[command];
   if (bin === undefined) {
      throw new Error(`${packageName} declares no '${command}' binary`);
   }
   return path.join(path.dirname(manifestPath), bin);
}

/**
 * Run `command` from a package this one declares, in the scaffold.
 *
 * The captured output is re-thrown rather than swallowed: `tsc` reports the
 * offending file and line on STDOUT, and without it a failure here says only
 * "command failed" about a project that no longer exists by the time anyone
 * reads it.
 */
function runTool(targetDir: string, packageName: string, command: string, args: readonly string[]): void {
   try {
      execFileSync(process.execPath, [binPath(packageName, command), ...args], { cwd: targetDir, stdio: 'pipe', encoding: 'utf-8' });
   } catch (err: unknown) {
      const output = err as { stdout?: string; stderr?: string };
      throw new Error(`${command} failed:\n${output.stdout ?? ''}${output.stderr ?? ''}`);
   }
}

describe('the emitted scaffold compiles', () => {
   it.each(CASES.map(entry => [entry.label, entry] as const))(
      'generates and type-checks %s',
      async (_label, { name, heads, grammars }) => {
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
            const server = path.join(targetDir, 'server');
            const protocol = path.join(targetDir, 'protocol');
            // The scaffold is the input to everything below, so its absence must
            // read as "nothing was written" rather than as a generator failing
            // on a file it cannot find.
            expect(fs.existsSync(path.join(server, 'langium-config.json')), 'runInit wrote no scaffold').toBe(true);

            // The `extends` is only meaningful if it resolves; assert that before
            // handing the project to tsc, so a broken path reads as a broken path
            // rather than as a wall of missing-compiler-option errors.
            for (const member of [server, protocol]) {
               const tsconfig = JSON.parse(fs.readFileSync(path.join(member, 'tsconfig.json'), 'utf-8')) as { extends?: string };
               expect(tsconfig.extends).toBeDefined();
               const base = path.resolve(member, tsconfig.extends as string);
               expect(fs.existsSync(base), `${tsconfig.extends} does not resolve from ${member}`).toBe(true);
               expect(JSON.parse(fs.readFileSync(base, 'utf-8'))).toHaveProperty('compilerOptions');
            }

            const protocolName = (JSON.parse(fs.readFileSync(path.join(protocol, 'package.json'), 'utf-8')) as { name: string }).name;
            const link = path.join(server, 'node_modules', protocolName);
            fs.mkdirSync(path.dirname(link), { recursive: true });
            fs.symlinkSync(protocol, link, 'dir');

            // Both halves of the emitted `generate` script, in its order.
            runTool(server, 'langium-cli', 'langium', ['generate', '--file', path.join(server, 'langium-config.json')]);
            generateTransferModel({
               astFile: path.join(server, 'src/language-server/generated/ast.ts'),
               augmentationFile: path.join(server, 'src/language-server/ast.ts'),
               outFile: path.join(protocol, 'src/generated-hydranium/transfer-model.ts'),
               languagesFile: path.join(protocol, 'src/generated-hydranium/languages.ts'),
               elementTypeName: `${name}Element`,
               terminalsName: `${name}Terminals`
            });

            // The emitted `build`'s compile: protocol through the reference, then the server.
            expect(() => runTool(server, 'typescript', 'tsc', ['-b', path.join(server, 'tsconfig.json')])).not.toThrow();

            // The emitted `typecheck:test`, which is a DIFFERENT check: it also
            // covers `test/`, and it turns on `isolatedModules`, so it is the only
            // thing that proves the emitted sources satisfy the stricter rules
            // vitest's per-file transform needs.
            expect(() => runTool(server, 'typescript', 'tsc', ['--noEmit', '-p', path.join(server, 'tsconfig.test.json')])).not.toThrow();

            // The diagram tests run the starter operation handler through an
            // in-process GLSP server; the type check above cannot see what it
            // writes to the document.
            const diagramTests = fs.readdirSync(path.join(server, 'test')).filter(file => file.endsWith('-diagram.test.ts'));
            expect(diagramTests.length > 0).toBe(heads?.includes('glsp') ?? false);
            for (const diagramTest of diagramTests) {
               expect(() => runTool(server, 'vitest', 'vitest', ['run', `test/${diagramTest}`])).not.toThrow();
            }

            // Without an LSP head only main.ts names the workspace and reports
            // the ports, so it is run: every head has to come up and listen.
            if (heads !== undefined && !heads.includes('lsp')) {
               const ports = JSON.parse(await portsLine(server, [path.join(targetDir, 'workspace')])) as unknown;
               expect(ports).toEqual({ dataServer: expect.any(Number), glspServer: expect.any(Number) });
            }
         } finally {
            // In `finally`, so a failing case cannot leave a directory that
            // makes the NEXT run fail for a different and misleading reason.
            fs.rmSync(targetDir, { recursive: true, force: true });
         }
      },
      COMPILE_TIMEOUT_MS
   );
});
