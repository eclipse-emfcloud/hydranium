/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
   deriveAstFileFromLangiumConfig,
   loadTransferModelConfig,
   mergeTransferModelOptions
} from '../src/commands/generate-transfer-model-config.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/generate-transfer-model/', import.meta.url));

describe('mergeTransferModelOptions', () => {
   it('takes the first source that defines each field (highest precedence first)', () => {
      const result = mergeTransferModelOptions(
         { outFile: '/flags/out.ts' },
         { astFile: '/config/ast.ts', outFile: '/config/out.ts', elementTypeName: 'Config' },
         { astFile: '/derived/ast.ts', augmentationFile: '/derived/aug.ts' }
      );
      expect(result.outFile).toBe('/flags/out.ts'); // flags win
      expect(result.astFile).toBe('/config/ast.ts'); // config wins over derived
      expect(result.augmentationFile).toBe('/derived/aug.ts'); // only the derived source has it
      expect(result.elementTypeName).toBe('Config');
   });

   it('throws listing every missing required path', () => {
      expect(() => mergeTransferModelOptions({ elementTypeName: 'X' })).toThrow(/astFile.*augmentationFile.*outFile/s);
   });

   it('accepts a complete single source', () => {
      const result = mergeTransferModelOptions({
         astFile: '/a.ts',
         augmentationFile: '/b.ts',
         outFile: '/c.ts'
      });
      expect(result).toMatchObject({ astFile: '/a.ts', augmentationFile: '/b.ts', outFile: '/c.ts' });
   });
});

describe('loadTransferModelConfig', () => {
   it('picks known keys, resolves path keys against the config dir, and drops unknown keys', () => {
      const config = loadTransferModelConfig(path.join(FIXTURES, 'config.json'));
      expect(config.astFile).toBe(path.join(FIXTURES, 'src/generated/ast.ts'));
      expect(config.augmentationFile).toBe(path.join(FIXTURES, 'src/ast.ts'));
      expect(config.outFile).toBe(path.join(FIXTURES, 'src/transfer-model.ts'));
      expect(config.elementTypeName).toBe('FixtureElement');
      expect(config.skipTerminals).toEqual(['WS', 'NEWLINE']);
      expect(config).not.toHaveProperty('ignoredUnknownKey');
   });

   it('throws a clear error for a missing config file', () => {
      expect(() => loadTransferModelConfig(path.join(FIXTURES, 'does-not-exist.json'))).toThrow(/Cannot read transfer-model config/);
   });
});

describe('deriveAstFileFromLangiumConfig', () => {
   it('derives <out>/ast.ts relative to the langium-config dir', () => {
      expect(deriveAstFileFromLangiumConfig(path.join(FIXTURES, 'langium-config.json'))).toBe(path.join(FIXTURES, 'src/generated/ast.ts'));
   });

   it('returns undefined when the config declares no out directory', () => {
      // config.json (the transfer-model config) has no `out` key.
      expect(deriveAstFileFromLangiumConfig(path.join(FIXTURES, 'config.json'))).toBeUndefined();
   });
});
