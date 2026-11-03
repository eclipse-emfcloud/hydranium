/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineMessage } from '@hydranium/protocol';
import { createMessageCatalogue } from '../src/commands/message-catalogue.js';
import { parseMessageCatalogueArgs } from '../src/commands/message-catalogue-args.js';

const exec = promisify(execFile);
const binary = fileURLToPath(new URL('../lib/cli.js', import.meta.url));

describe('createMessageCatalogue', () => {
   it('sorts codes, preserves placeholders and deduplicates re-exports', () => {
      const first = { Z: defineMessage('sample/area/z', 'Value {name}.'), helper: () => undefined };
      const second = { A: defineMessage('sample/area/a', 'First.') };
      expect(JSON.stringify(createMessageCatalogue([first, second, first]))).toBe(
         '{"sample/area/a":"First.","sample/area/z":"Value {name}."}'
      );
   });

   it('refuses conflicting defaults instead of letting import order choose', () => {
      expect(() =>
         createMessageCatalogue([{ A: defineMessage('sample/area/a', 'One.') }, { B: defineMessage('sample/area/a', 'Two.') }])
      ).toThrow("Conflicting English defaults for message 'sample/area/a'");
   });
});

describe('parseMessageCatalogueArgs', () => {
   it('accepts repeated barrels and refuses missing inputs and unknown options', () => {
      const fail = (message: string): never => {
         throw new Error(message);
      };
      expect(parseMessageCatalogueArgs(['--barrel', 'one/messages', '--barrel', './two.js', '--out-file', 'en.json'], fail)).toEqual({
         barrels: ['one/messages', './two.js'],
         outFile: 'en.json'
      });
      expect(() => parseMessageCatalogueArgs([], fail)).toThrow(
         'Missing required option: --barrel (hydranium-cli message-catalogue --help)'
      );
      expect(() => parseMessageCatalogueArgs(['--barrel'], fail)).toThrow('Missing value');
      expect(() => parseMessageCatalogueArgs(['--unknown'], fail)).toThrow(
         'Unexpected argument: --unknown (hydranium-cli message-catalogue --help)'
      );
   });
});

describe('hydranium-cli message-catalogue', () => {
   let cwd: string;
   let output: string;
   beforeEach(async () => {
      cwd = await mkdtemp(join(tmpdir(), 'hydranium-catalogue-'));
      output = join(cwd, 'en.json');
      const pkg = join(cwd, 'node_modules', 'sample-messages');
      await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
      await writeFile(join(pkg, 'index.js'), `export const A = { code: 'sample/area/a', text: 'Value {name}.', format() {} };`);
   });
   afterEach(async () => {
      await rm(cwd, { recursive: true, force: true });
   });

   it('resolves message packages from the caller rather than the CLI installation', async () => {
      await exec(process.execPath, [binary, 'message-catalogue', '--barrel', 'sample-messages', '--out-file', output], { cwd });
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ 'sample/area/a': 'Value {name}.' });
   });

   it.each(['import-only', 'dual'] as const)('uses the import target for %s package exports', async kind => {
      const pkg = join(cwd, 'node_modules', 'sample-messages');
      const conditions = kind === 'dual' ? { require: './require.cjs', import: './index.js' } : { import: './index.js' };
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: { './messages': conditions } }));
      await writeFile(join(pkg, 'require.cjs'), `throw new Error('The require target must not load');`);
      await exec(process.execPath, [binary, 'message-catalogue', '--barrel', 'sample-messages/messages', '--out-file', output], { cwd });
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ 'sample/area/a': 'Value {name}.' });
   });

   it('preserves existing output when a later import fails', async () => {
      await writeFile(output, 'existing catalogue');
      await expect(
         exec(
            process.execPath,
            [binary, 'message-catalogue', '--barrel', 'sample-messages', '--barrel', './missing.js', '--out-file', output],
            { cwd }
         )
      ).rejects.toThrow();
      expect(await readFile(output, 'utf8')).toBe('existing catalogue');
   });

   it('refuses an empty barrel instead of silently emitting an incomplete catalogue', async () => {
      await writeFile(join(cwd, 'empty.mjs'), 'export const helper = 1;');
      await expect(exec(process.execPath, [binary, 'message-catalogue', '--barrel', './empty.mjs'], { cwd })).rejects.toThrow(
         'exports no declarations'
      );
   });
});
