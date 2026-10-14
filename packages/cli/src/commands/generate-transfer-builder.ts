/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { describeError } from '@hydranium/protocol';
import { relativeImportPath } from './generated-module-path.js';

/** Inputs for {@link emitTransferBuilder}, resolved by the transfer-model command. */
export interface EmitTransferBuilderOptions {
   /** Destination path for the generated builder module. */
   outFile: string;
   /** Path of the generated transfer model the builder binds to. */
   transferModelFile: string;
   /** Language id derived from the `<LanguageId>AstReflection` class name. */
   languageId: string;
   /** Header line naming the command that regenerates the file. */
   regenCommand: string;
}

/**
 * Emit a test module binding `makeTransferNodeBuilder` to the transfer model's
 * reflection and type map, as `transferNode`.
 *
 * The module usually sits in a test tree of the server package while the
 * transfer model sits in a protocol package of its own, and a relative import
 * would reach into that package's sources. Across packages it therefore imports
 * the model by the package's name, which relies on the package's main entry
 * re-exporting the generated model; within one package it imports by path.
 */
export function emitTransferBuilder(options: EmitTransferBuilderOptions): void {
   const content = buildTransferBuilderSource(options);
   fs.mkdirSync(path.dirname(options.outFile), { recursive: true });
   if (fs.existsSync(options.outFile) && fs.readFileSync(options.outFile, 'utf-8') === content) {
      console.log('Transfer builder is up to date.');
      return;
   }
   fs.writeFileSync(options.outFile, content, 'utf-8');
   console.log(`Generated: ${options.outFile}`);
}

/** The module text {@link emitTransferBuilder} would write. */
export function buildTransferBuilderSource(options: EmitTransferBuilderOptions): string {
   const modelPackage = owningPackage(options.transferModelFile);
   const specifier =
      modelPackage !== undefined && modelPackage.dir !== owningPackage(options.outFile)?.dir
         ? modelPackage.name
         : relativeImportPath(options.outFile, options.transferModelFile);
   const reflection = `${options.languageId}TransferReflection`;
   const typeMap = `${options.languageId}TransferTypes`;
   return [
      '/******************************************************************************',
      ' * Generated from the Langium AST — DO NOT EDIT MANUALLY!',
      ` * ${options.regenCommand}`,
      ' ******************************************************************************/',
      '',
      '/* eslint-disable */',
      '',
      "import { makeTransferNodeBuilder } from '@hydranium/protocol/testing';",
      `import { ${reflection}, type ${typeMap} } from '${specifier}';`,
      '',
      '/**',
      " * Transfer-node factory for this project's grammar, for tests. It fills the",
      ' * grammar defaults, so a test names only the fields it cares about;',
      ' * `transferNode.partial` fills none and types the node as incomplete.',
      ' */',
      `export const transferNode = makeTransferNodeBuilder<${typeMap}, typeof ${reflection}>(${reflection});`,
      ''
   ].join('\n');
}

/** The nearest `package.json` at or above `file` that names a package. */
function owningPackage(file: string): { dir: string; name: string } | undefined {
   let dir = path.dirname(path.resolve(file));
   for (;;) {
      const manifest = path.join(dir, 'package.json');
      if (fs.existsSync(manifest)) {
         let parsed: unknown;
         try {
            parsed = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
         } catch (error: unknown) {
            throw new Error(`Cannot read '${manifest}' to name the transfer model's package: ${describeError(error)}`);
         }
         const name = typeof parsed === 'object' && parsed !== null && 'name' in parsed ? parsed.name : undefined;
         if (typeof name === 'string') {
            return { dir, name };
         }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
         return undefined;
      }
      dir = parent;
   }
}
