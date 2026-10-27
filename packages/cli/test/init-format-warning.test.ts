/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'node:fs';
import type * as NodeModule from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { planInitFiles, resolveInitComposition, resolveInitPackaging, runInit } from '../src/commands/init.js';

// A CLI installed without oxfmt, as `--omit` or a broken install leaves it.
vi.mock('node:module', async importOriginal => {
   const actual = await importOriginal<typeof NodeModule>();
   return {
      ...actual,
      createRequire: (from: string | URL) => {
         const require = actual.createRequire(from);
         const resolve = require.resolve;
         require.resolve = Object.assign(
            (id: string, options?: { paths?: string[] }) => {
               if (id === 'oxfmt/package.json') {
                  throw new Error(`Cannot find module '${id}'`);
               }
               return resolve(id, options);
            },
            { paths: resolve.paths }
         );
         return require;
      }
   };
});

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('runInit without oxfmt', () => {
   it('keeps the scaffold as written and warns to run the format script', () => {
      const targetDir = path.join(PACKAGE_ROOT, 'out/scaffold-without-oxfmt');
      try {
         fs.rmSync(targetDir, { recursive: true, force: true });
         const lines: string[] = [];
         // A name oxfmt rewraps lines for, so a formatted file would differ from the plan.
         runInit({ targetDir, name: 'EnterpriseArchitectureModeling', write: line => lines.push(line) });
         expect(lines.join('')).toContain(
            "Warning: oxfmt did not format the scaffold, so run `npm run format` after `npm install`:\nCannot find module 'oxfmt/package.json'"
         );
         const planned = planInitFiles(
            resolveInitComposition('EnterpriseArchitectureModeling', undefined, undefined, resolveInitPackaging(targetDir, {}), undefined)
         );
         for (const file of planned) {
            expect(fs.readFileSync(path.join(targetDir, file.path), 'utf-8'), file.path).toBe(file.content);
         }
      } finally {
         fs.rmSync(targetDir, { recursive: true, force: true });
      }
   });
});
