#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Command-line front for the large-workspace fixture generator.
 *
 * Deliberately thin: the generator itself is a compiled module
 * (`src/testing/large-workspace.ts`) so a bench can call it in-process rather
 * than shelling out, and this file only turns flags into its options and prints
 * what was written.
 *
 * Usage:
 *   npm --prefix examples/order-flow/server run generate:large-workspace
 *   npm --prefix examples/order-flow/server run generate:large-workspace -- \
 *      --projects 4 --entities 6 --processes 3 --seed 1 --out /tmp/small
 *
 * The output directory is gitignored, so the corpus is reproducible from a
 * fixed seed rather than carried in the repository.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');

/** Default output: the gitignored sibling of the committed sample workspace. */
const DEFAULT_ROOT = path.resolve(PACKAGE_ROOT, '../workspace-large');

const NUMERIC_FLAGS = ['projects', 'entities', 'processes', 'seed'] as const;
type NumericFlag = (typeof NUMERIC_FLAGS)[number];

/** Mirrors `LargeWorkspaceOptions`, which lives in build output this script cannot import types from. */
interface GeneratorOptions {
   root?: string;
   projects?: number;
   entities?: number;
   processes?: number;
   seed?: number;
}

const isNumericFlag = (name: string): name is NumericFlag => NUMERIC_FLAGS.some(flag => flag === name);

function usage(): string {
   return [
      'Usage: node scripts/generate-large-workspace.mts [options]',
      '',
      '  --projects <n>    generated projects (folders), each with its own descriptor',
      '  --entities <n>    member .domain files per project',
      '  --processes <n>   .process files per project; each but the last also gets a .layout',
      '  --seed <n>        seed for the bounded content variation',
      `  --out <dir>       output directory (default: ${DEFAULT_ROOT})`
   ].join('\n');
}

/** Parse argv into generator options, or exit 1 naming what was wrong. */
function parseArgs(argv: string[]): GeneratorOptions & { root: string } {
   const options: GeneratorOptions = {};
   for (let index = 0; index < argv.length; index++) {
      const flag = argv[index];
      if (flag === '--help' || flag === '-h') {
         process.stdout.write(`${usage()}\n`);
         process.exit(0);
      }
      if (!flag.startsWith('--')) {
         fail(`Unexpected argument: ${flag}`);
      }
      const name = flag.slice(2);
      const value = argv[++index];
      if (value === undefined) {
         fail(`Missing value for --${name}`);
      }
      if (name === 'out') {
         options.root = path.resolve(process.cwd(), value);
      } else if (isNumericFlag(name)) {
         const parsed = Number(value);
         if (!Number.isInteger(parsed)) {
            fail(`--${name} must be an integer, got ${value}`);
         }
         options[name] = parsed;
      } else {
         fail(`Unknown option: --${name}`);
      }
   }
   options.root ??= DEFAULT_ROOT;
   return options as GeneratorOptions & { root: string };
}

function fail(message: string): never {
   process.stderr.write(`${message}\n\n${usage()}\n`);
   process.exit(1);
}

/**
 * Load the generator from `lib/`. A dynamic import so an unbuilt example
 * reports the fix rather than a bare MODULE_NOT_FOUND; anything else rethrows,
 * because a failure inside the module is not a missing build.
 */
async function loadGenerator() {
   try {
      return await import('../lib/testing/large-workspace.js');
   } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
         process.stderr.write('The example is not built. Run "npm run build" at the repo root first.\n');
         process.exit(1);
      }
      throw error;
   }
}

const options = parseArgs(process.argv.slice(2));
const { generateLargeWorkspace } = await loadGenerator();
const summary = generateLargeWorkspace(options);

process.stdout.write(
   [
      `Generated ${summary.root}`,
      `  projects   ${summary.projects} (entities ${summary.entities}, processes ${summary.processes}, seed ${summary.seed})`,
      `  .domain    ${summary.files.domain}`,
      `  .process   ${summary.files.process}`,
      `  .layout    ${summary.files.layout}`,
      `  files      ${summary.files.total}`,
      `  documents  ${summary.documents} (model files plus the stdlib virtual document)`,
      '',
      'Check it builds clean:',
      '  node packages/cli/lib/cli.js validate \\',
      '     --services examples/order-flow/server/lib/services.js \\',
      `     ${summary.root}`,
      ''
   ].join('\n')
);
