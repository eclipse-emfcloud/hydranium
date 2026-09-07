/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GenerateTransferModelOptions } from './generate-transfer-model.js';

/** Path-valued option keys — resolved relative to a config/langium-config file's directory. */
const PATH_KEYS = ['astFile', 'augmentationFile', 'outFile'] as const;

/** Resolve `value` against `baseDir` when it is relative; absolute paths pass through. */
function resolveAgainst(baseDir: string, value: string): string {
   return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

/**
 * Read a transfer-model JSON config file into a partial options object. Only the
 * known {@link GenerateTransferModelOptions} keys are picked (unknown keys are
 * ignored); the {@link PATH_KEYS} are resolved relative to the config file's own
 * directory so a config can use paths relative to itself. Throws a clear error on
 * unreadable / non-object / invalid JSON.
 */
export function loadTransferModelConfig(configPath: string): Partial<GenerateTransferModelOptions> {
   let raw: unknown;
   try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
   } catch (error: unknown) {
      throw new Error(`Cannot read transfer-model config '${configPath}': ${error instanceof Error ? error.message : String(error)}`);
   }
   if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`Transfer-model config '${configPath}' must be a JSON object.`);
   }
   const source = raw as Record<string, unknown>;
   const baseDir = path.dirname(path.resolve(configPath));
   const result: Partial<GenerateTransferModelOptions> = {};
   const stringKeys = [
      'astFile',
      'augmentationFile',
      'outFile',
      'elementTypeName',
      'terminalsName',
      'terminalsSourceName',
      'regenCommand'
   ] as const;
   for (const key of stringKeys) {
      const value = source[key];
      if (typeof value === 'string') {
         result[key] = (PATH_KEYS as readonly string[]).includes(key) ? resolveAgainst(baseDir, value) : value;
      }
   }
   for (const key of ['skipTypeAliases', 'skipTerminals'] as const) {
      const value = source[key];
      if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) {
         result[key] = value as string[];
      }
   }
   return result;
}

/**
 * Derive the Langium-generated AST file path from a `langium-config.json`: the
 * generator emits `ast.ts` into the config's `out` directory, so the AST file is
 * `<config-dir>/<out>/ast.ts`. Returns `undefined` when the config declares no
 * `out` (nothing to derive). Throws on unreadable / invalid JSON.
 */
export function deriveAstFileFromLangiumConfig(langiumConfigPath: string): string | undefined {
   let raw: unknown;
   try {
      raw = JSON.parse(fs.readFileSync(langiumConfigPath, 'utf-8'));
   } catch (error: unknown) {
      throw new Error(`Cannot read langium-config '${langiumConfigPath}': ${error instanceof Error ? error.message : String(error)}`);
   }
   const out = (raw as { out?: unknown })?.out;
   if (typeof out !== 'string') {
      return undefined;
   }
   const baseDir = path.dirname(path.resolve(langiumConfigPath));
   return path.resolve(baseDir, out, 'ast.ts');
}

/**
 * Merge partial option sources into a complete {@link GenerateTransferModelOptions},
 * highest precedence first: for each field the first source that defines it wins.
 * Pure over its inputs. Throws listing every required path (`astFile` /
 * `augmentationFile` / `outFile`) still missing after the merge.
 */
export function mergeTransferModelOptions(...sources: Array<Partial<GenerateTransferModelOptions>>): GenerateTransferModelOptions {
   const pick = <K extends keyof GenerateTransferModelOptions>(key: K): GenerateTransferModelOptions[K] | undefined => {
      for (const source of sources) {
         if (source[key] !== undefined) {
            return source[key];
         }
      }
      return undefined;
   };

   const astFile = pick('astFile');
   const augmentationFile = pick('augmentationFile');
   const outFile = pick('outFile');
   const missing = [
      ['astFile (--ast-file)', astFile],
      ['augmentationFile (--augmentation-file)', augmentationFile],
      ['outFile (--out-file)', outFile]
   ]
      .filter(([, value]) => value === undefined)
      .map(([label]) => label);
   if (missing.length) {
      throw new Error(`Missing required transfer-model option(s): ${missing.join(', ')}`);
   }

   return {
      astFile: astFile!,
      augmentationFile: augmentationFile!,
      outFile: outFile!,
      elementTypeName: pick('elementTypeName'),
      terminalsName: pick('terminalsName'),
      terminalsSourceName: pick('terminalsSourceName'),
      skipTypeAliases: pick('skipTypeAliases'),
      skipTerminals: pick('skipTerminals'),
      regenCommand: pick('regenCommand')
   };
}
