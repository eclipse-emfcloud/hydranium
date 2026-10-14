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
import { kebab } from './kebab.js';
import { type Expression, type ObjectLiteralExpression, type SourceFile, SyntaxKind } from 'ts-morph';

/** Inputs for {@link emitLanguages}, resolved by the transfer-model command. */
export interface EmitLanguagesOptions {
   /** Destination path for the generated languages module. */
   outFile: string;
   /** Header line naming the command that regenerates the file. */
   regenCommand: string;
}

interface LanguageEntry {
   constName: string;
   languageId: string;
   fileExtensions: string[];
}

/** Suffix langium-cli gives each grammar's metadata const in `module.ts`. */
const METADATA_SUFFIX = 'LanguageMetaData';

/**
 * Emit a module stating each grammar's language id and file extensions for a
 * package a client can depend on.
 *
 * Read from the `<Grammar>LanguageMetaData` consts langium-cli writes into
 * `module.ts`, which is the only place the ids exist outside `langium-config.json`
 * and which a client cannot import, since it pulls in Langium. Generating the
 * copy instead of writing it by hand is what keeps every host's id list in step
 * with the grammars.
 */
export function emitLanguages(moduleSource: SourceFile, options: EmitLanguagesOptions): void {
   const content = buildLanguagesSource(moduleSource, options);
   fs.mkdirSync(path.dirname(options.outFile), { recursive: true });
   if (fs.existsSync(options.outFile) && fs.readFileSync(options.outFile, 'utf-8') === content) {
      console.log('Languages module is up to date.');
      return;
   }
   fs.writeFileSync(options.outFile, content, 'utf-8');
   console.log(`Generated: ${options.outFile}`);
}

/**
 * The module text {@link emitLanguages} would write. Pure over its inputs, so
 * the emitted shape is testable without touching a filesystem. Throws when the
 * source declares no metadata, since an empty list would make every host
 * register nothing without an error.
 */
export function buildLanguagesSource(moduleSource: SourceFile, options: Pick<EmitLanguagesOptions, 'regenCommand'>): string {
   const entries: LanguageEntry[] = [];
   const grammarsByConst = new Map<string, string>();
   for (const declaration of moduleSource.getVariableDeclarations()) {
      const name = declaration.getName();
      if (!name.endsWith(METADATA_SUFFIX)) {
         continue;
      }
      const literal = objectLiteralOf(declaration.getInitializer());
      const grammar = name.slice(0, -METADATA_SUFFIX.length);
      const constName = `${kebab(grammar).replace(/-/g, '_').toUpperCase()}_LANGUAGE`;
      const clash = grammarsByConst.get(constName);
      if (clash !== undefined) {
         throw new Error(
            `Cannot emit the languages module: grammars '${clash}' and '${grammar}' both map to '${constName}'. ` +
               'Rename one grammar so the generated constants stay distinct.'
         );
      }
      grammarsByConst.set(constName, grammar);
      entries.push({
         constName,
         languageId: stringProperty(literal, name, 'languageId'),
         fileExtensions: stringArrayProperty(literal, name, 'fileExtensions')
      });
   }
   if (entries.length === 0) {
      throw new Error(`Cannot emit the languages module: ${moduleSource.getFilePath()} declares no '<Grammar>${METADATA_SUFFIX}'.`);
   }

   const out: string[] = [];
   out.push('/******************************************************************************');
   out.push(' * Generated from the Langium language metadata — DO NOT EDIT MANUALLY!');
   out.push(` * ${options.regenCommand}`);
   out.push(' ******************************************************************************/');
   out.push('');
   for (const entry of entries) {
      const extensions = entry.fileExtensions.map(extension => JSON.stringify(extension)).join(', ');
      out.push(
         `export const ${entry.constName} = { languageId: ${JSON.stringify(entry.languageId)}, fileExtensions: [${extensions}] } as const;`
      );
   }
   out.push('');
   out.push('/** Every language of the project, in the order langium-cli declares them. */');
   out.push(`export const ALL_LANGUAGES = [${entries.map(entry => entry.constName).join(', ')}] as const;`);
   return out.join('\n') + '\n';
}

/** The object literal under `as const` / `satisfies` wrappers, which langium-cli adds. */
function objectLiteralOf(initializer: Expression | undefined): ObjectLiteralExpression | undefined {
   return (
      initializer?.asKind(SyntaxKind.ObjectLiteralExpression) ?? initializer?.getFirstDescendantByKind(SyntaxKind.ObjectLiteralExpression)
   );
}

function stringProperty(literal: ObjectLiteralExpression | undefined, owner: string, key: string): string {
   const value = literal?.getProperty(key)?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer()?.asKind(SyntaxKind.StringLiteral);
   if (value === undefined) {
      throw new Error(`Cannot emit the languages module: ${owner} has no string '${key}'.`);
   }
   return value.getLiteralValue();
}

function stringArrayProperty(literal: ObjectLiteralExpression | undefined, owner: string, key: string): string[] {
   const array = literal
      ?.getProperty(key)
      ?.asKind(SyntaxKind.PropertyAssignment)
      ?.getInitializer()
      ?.asKind(SyntaxKind.ArrayLiteralExpression);
   const values = array?.getElements().map(element => element.asKind(SyntaxKind.StringLiteral)?.getLiteralValue());
   if (values === undefined || !values.every((value): value is string => value !== undefined)) {
      throw new Error(`Cannot emit the languages module: ${owner} has no string array '${key}'.`);
   }
   return values;
}
