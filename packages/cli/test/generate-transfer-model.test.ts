/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Project, type SourceFile } from 'ts-morph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTransferBuilderSource } from '../src/commands/generate-transfer-builder.js';
import {
   generateTransferModel,
   parseTerminals,
   resolveNamespacedStringUnion,
   typeAliasMemberGuard
} from '../src/commands/generate-transfer-model.js';

/**
 * Build an in-memory AST source. Langium's real generated file is far larger, but
 * these tests only read terminal consts and namespaced type aliases, so a
 * hand-written excerpt in the same shape exercises the same code paths without a
 * fixture that has to be regenerated whenever the grammar moves.
 */
function astSource(text: string): SourceFile {
   return new Project({ useInMemoryFileSystem: true }).createSourceFile('ast.ts', text);
}

describe('parseTerminals', () => {
   const singleLanguage = `
      export const ProjectTerminals = {
         ID: /[_a-zA-Z][\\w_]*/,
         WS: /\\s+/
      };
   `;

   const multiLanguage = `
      export namespace LangA {
         export const Terminals = {
            ID: /[_a-zA-Z][\\w_]*/,
            NUMBER: /[0-9]+/
         };
      }
      export namespace LangB {
         export const Terminals = {
            ID: /[_a-zA-Z][\\w_]*/,
            ARROW: /->/
         };
      }
      export const ProjectTerminals = { ...LangA.Terminals, ...LangB.Terminals };
   `;

   it('reads the top-level const for a single-language project', () => {
      const terminals = parseTerminals(astSource(singleLanguage), 'ProjectTerminals', new Set());
      expect(terminals).toEqual([
         { name: 'ID', pattern: '/^(?:[_a-zA-Z][\\w_]*)$/' },
         { name: 'WS', pattern: '/^(?:\\s+)$/' }
      ]);
   });

   it('unions every namespace Terminals const for a multi-language project', () => {
      const names = parseTerminals(astSource(multiLanguage), 'ProjectTerminals', new Set()).map(terminal => terminal.name);
      // The top-level const is a spread (no regex literals of its own), so every
      // pattern comes from the namespaces — and each namespace only carries the
      // terminals its own grammar reaches.
      expect(names).toEqual(['ID', 'NUMBER', 'ARROW']);
   });

   it('de-duplicates a terminal declared by both grammars, keeping the first', () => {
      const terminals = parseTerminals(astSource(multiLanguage), 'ProjectTerminals', new Set());
      expect(terminals.filter(terminal => terminal.name === 'ID')).toHaveLength(1);
   });

   it('honours skipTerminals across both the top-level const and the namespaces', () => {
      const single = parseTerminals(astSource(singleLanguage), 'ProjectTerminals', new Set(['WS'])).map(t => t.name);
      const multi = parseTerminals(astSource(multiLanguage), 'ProjectTerminals', new Set(['ID'])).map(t => t.name);
      expect(single).toEqual(['ID']);
      expect(multi).toEqual(['NUMBER', 'ARROW']);
   });

   it('returns nothing when neither the named const nor a namespace declares terminals', () => {
      expect(parseTerminals(astSource('export const Unrelated = 1;'), 'ProjectTerminals', new Set())).toEqual([]);
   });
});

describe('resolveNamespacedStringUnion', () => {
   const source = astSource(`
      export namespace LangA {
         export type KeywordNames = 'shared' | 'only-a';
      }
      export namespace LangB {
         export type KeywordNames = 'only-b' | 'shared';
         export type NotLiterals = string | number;
      }
   `);

   it('leaves a plain string-literal union untouched', () => {
      expect(resolveNamespacedStringUnion(source, "'a' | 'b'")).toBe("'a' | 'b'");
   });

   it('flattens namespace-qualified members into one union, de-duplicated in first-seen order', () => {
      // 'shared' is declared by both grammars and must appear once.
      expect(resolveNamespacedStringUnion(source, 'LangB.KeywordNames | LangA.KeywordNames')).toBe("'only-b' | 'shared' | 'only-a'");
   });

   it('returns the definition unchanged when a referenced member is not a pure literal union', () => {
      const definition = 'LangB.NotLiterals | LangA.KeywordNames';
      expect(resolveNamespacedStringUnion(source, definition)).toBe(definition);
   });

   it('returns the definition unchanged when the namespace or member does not exist', () => {
      expect(resolveNamespacedStringUnion(source, 'Missing.KeywordNames')).toBe('Missing.KeywordNames');
      expect(resolveNamespacedStringUnion(source, 'LangA.Absent')).toBe('LangA.Absent');
   });
});

describe('typeAliasMemberGuard', () => {
   it('uses typeof for the typeof-checkable Langium primitives', () => {
      expect(typeAliasMemberGuard('string')).toBe("typeof item === 'string'");
      expect(typeAliasMemberGuard('number')).toBe("typeof item === 'number'");
      expect(typeAliasMemberGuard('boolean')).toBe("typeof item === 'boolean'");
      expect(typeAliasMemberGuard('bigint')).toBe("typeof item === 'bigint'");
   });

   it('uses instanceof for Date, which typeof reports as object', () => {
      expect(typeAliasMemberGuard('Date')).toBe('item instanceof Date');
   });

   it('delegates to the generated is<Member> guard for a named type', () => {
      expect(typeAliasMemberGuard('TypeOne')).toBe('isTypeOne(item)');
   });

   it('composes a mixed primitive + named union into a valid expression', () => {
      const definition = ['string', 'Date', 'TypeOne'];
      expect(definition.map(typeAliasMemberGuard).join(' || ')).toBe("typeof item === 'string' || item instanceof Date || isTypeOne(item)");
   });
});

/**
 * A Langium-shaped AST in the reflection layout `langium generate` writes: one
 * union alias, one interface supertype chain, a reference, and the two default
 * shapes grammars produce (`[]` and `false`).
 */
const LANGIUM_AST = `
import * as langium from 'langium';
export type ProjectAstType = { Container: Container; Either: Either; TypeOne: TypeOne; TypeTwo: TypeTwo };
export type Either = TypeOne | TypeTwo;
export const Either = { $type: 'Either' } as const;
export interface Container extends langium.AstNode {
   readonly $type: 'Container';
   items: Array<Either>;
}
export const Container = { $type: 'Container', items: 'items' } as const;
export interface TypeOne extends langium.AstNode {
   readonly $type: 'TypeOne';
   flag: boolean;
   name: string;
   peer?: langium.Reference<TypeOne>;
}
export const TypeOne = { $type: 'TypeOne', flag: 'flag', name: 'name', peer: 'peer' } as const;
export interface TypeTwo extends langium.AstNode {
   readonly $type: 'TypeTwo';
   label: string;
}
export const TypeTwo = { $type: 'TypeTwo', label: 'label' } as const;
export class ProjectAstReflection extends langium.AbstractAstReflection {
   override readonly types = {
      Container: { name: Container.$type, properties: { items: { name: Container.items, defaultValue: [], optional: true } }, superTypes: [] },
      Either: { name: Either.$type, properties: {}, superTypes: [] },
      TypeOne: {
         name: TypeOne.$type,
         properties: {
            flag: { name: TypeOne.flag, defaultValue: false, optional: true },
            name: { name: TypeOne.name },
            peer: { name: TypeOne.peer, referenceType: TypeOne.$type, optional: true }
         },
         superTypes: [Either.$type]
      },
      TypeTwo: { name: TypeTwo.$type, properties: { label: { name: TypeTwo.label } }, superTypes: [Either.$type] }
   } as const satisfies langium.AstMetaData;
}
export const reflection = new ProjectAstReflection();
`;

/**
 * Types named after TypeScript's utility types, which Langium does not reserve
 * the way it reserves the JavaScript globals (`Object`, `Date`, `Array`, …).
 */
const UTILITY_NAMED_AST = `
import * as langium from 'langium';
export type ProjectAstType = { Readonly: Readonly; Record: Record };
export interface Readonly extends langium.AstNode {
   readonly $type: 'Readonly';
   name: string;
}
export const Readonly = { $type: 'Readonly', name: 'name' } as const;
export interface Record extends langium.AstNode {
   readonly $type: 'Record';
   name: string;
}
export const Record = { $type: 'Record', name: 'name' } as const;
export class ProjectAstReflection extends langium.AbstractAstReflection {
   override readonly types = {
      Readonly: { name: Readonly.$type, properties: { name: { name: Readonly.name } }, superTypes: [] },
      Record: { name: Record.$type, properties: { name: { name: Record.name } }, superTypes: [] }
   } as const satisfies langium.AstMetaData;
}
export const reflection = new ProjectAstReflection();
`;

describe('generateTransferModel', () => {
   let scratch: string;

   afterEach(() => {
      vi.restoreAllMocks();
      rmSync(scratch, { recursive: true, force: true });
   });

   async function generate(ast = LANGIUM_AST): Promise<{ text: string; model: Record<string, unknown>; outFile: string }> {
      scratch = mkdtempSync(path.join(tmpdir(), 'hydranium-transfer-model-'));
      const astFile = path.join(scratch, 'ast.ts');
      const augmentationFile = path.join(scratch, 'augmentation.ts');
      const outFile = path.join(scratch, 'transfer-model.ts');
      writeFileSync(astFile, ast);
      writeFileSync(augmentationFile, "export * from './ast.js';\n");
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      generateTransferModel({ astFile, augmentationFile, outFile });
      return {
         text: readFileSync(outFile, 'utf-8'),
         model: (await import(pathToFileURL(outFile).href)) as Record<string, unknown>,
         outFile
      };
   }

   it("emits Langium's per-type constant under the type's own name, unions included", async () => {
      const { text, model } = await generate();

      expect(text).toContain("export const TypeOne = { $type: 'TypeOne', flag: 'flag', name: 'name', peer: 'peer' } as const;");
      expect(model.Either).toEqual({ $type: 'Either' });
      expect(text).not.toMatch(/export const \w+Type = /);
   });

   it('maps each $type to its interface', async () => {
      const { text } = await generate();

      expect(text).toContain(
         'export type ProjectTransferTypes = {\n   Container: Container;\n   Either: Either;\n   TypeOne: TypeOne;\n   TypeTwo: TypeTwo;\n};'
      );
   });

   it("answers the reflection's questions from the grammar metadata", async () => {
      const { model } = await generate();
      const reflection = model.ProjectTransferReflection as {
         getAllTypes(): string[];
         getTypeMetaData(type: string): { properties: Record<string, { defaultValue?: unknown; referenceType?: string }> };
         isSubtype(subtype: string, supertype: string): boolean;
         getAllSubTypes(type: string): string[];
         isInstance(item: unknown, type: string): boolean;
      };

      expect(reflection.getAllTypes()).toEqual(['Container', 'Either', 'TypeOne', 'TypeTwo']);
      expect(reflection.getTypeMetaData('TypeOne').properties).toEqual({
         flag: { name: 'flag', defaultValue: false, optional: true },
         name: { name: 'name' },
         peer: { name: 'peer', optional: true, referenceType: 'TypeOne' }
      });
      expect(reflection.getTypeMetaData('Container').properties.items.defaultValue).toEqual([]);
      expect(reflection.getTypeMetaData('Unknown')).toEqual({ name: 'Unknown', properties: {}, superTypes: [] });
      expect(reflection.isSubtype('TypeOne', 'Either')).toBe(true);
      expect(reflection.isSubtype('Container', 'Either')).toBe(false);
      expect(reflection.getAllSubTypes('Either')).toEqual(['Either', 'TypeOne', 'TypeTwo']);
      expect(reflection.isInstance({ $type: 'TypeTwo', label: '' }, 'Either')).toBe(true);
      expect(reflection.isInstance({ $type: 'Container' }, 'Either')).toBe(false);
      expect(reflection.isInstance('TypeOne', 'TypeOne')).toBe(false);
   });

   it('answers a type name the object prototype also carries as unknown', async () => {
      const { model } = await generate();
      const reflection = model.ProjectTransferReflection as {
         getTypeMetaData(type: string): unknown;
         isSubtype(subtype: string, supertype: string): boolean;
         isInstance(item: unknown, type: string): boolean;
      };

      for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
         expect(reflection.getTypeMetaData(name)).toEqual({ name, properties: {}, superTypes: [] });
         expect(reflection.isSubtype(name, 'Either')).toBe(false);
         expect(reflection.isInstance({ $type: name }, 'Either')).toBe(false);
      }
   });

   it("compiles for a grammar whose types are named like TypeScript's utility types", async () => {
      const { model, outFile } = await generate(UTILITY_NAMED_AST);
      const manifest = findPackageJSON('typescript', import.meta.url);
      if (manifest === undefined) {
         throw new Error('typescript does not resolve from this package');
      }
      const tsc = path.join(path.dirname(manifest), 'bin', 'tsc');
      const args = ['--ignoreConfig', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'nodenext', outFile];

      // vitest strips types on import, so only tsc sees a shadowed type name.
      const result = spawnSync(process.execPath, [tsc, ...args], { encoding: 'utf-8' });
      expect(result.stdout + result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect((model.ProjectTransferReflection as { getAllTypes(): string[] }).getAllTypes()).toEqual(['Readonly', 'Record']);
   });

   it('keeps the guards off the reflection, so importing one does not pull the metadata in', async () => {
      const { text } = await generate();
      const guards = text.slice(text.indexOf('// --- Type Guards ---'), text.indexOf('// --- Type Map ---'));

      expect(guards).toContain("return isTransferElement(item) && item.$type === 'TypeOne';");
      expect(guards).not.toContain('Reflection');
   });
});

describe('buildTransferBuilderSource', () => {
   let scratch: string;

   afterEach(() => {
      rmSync(scratch, { recursive: true, force: true });
   });

   function packageAt(dir: string, name: string): string {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
      return dir;
   }

   it('imports a transfer model in another package by that package name', () => {
      scratch = mkdtempSync(path.join(tmpdir(), 'hydranium-transfer-builder-'));
      const protocol = packageAt(path.join(scratch, 'protocol'), '@example/protocol');
      const server = packageAt(path.join(scratch, 'server'), '@example/server');

      const source = buildTransferBuilderSource({
         outFile: path.join(server, 'test/generated-hydranium/transfer-builder.ts'),
         transferModelFile: path.join(protocol, 'src/generated-hydranium/transfer-model.ts'),
         languageId: 'Project',
         regenCommand: 'Run: regen'
      });

      expect(source).toContain("import { makeTransferNodeBuilder } from '@hydranium/protocol/testing';");
      expect(source).toContain("import { ProjectTransferReflection, type ProjectTransferTypes } from '@example/protocol';");
      expect(source).toContain(
         'export const transferNode = makeTransferNodeBuilder<ProjectTransferTypes, typeof ProjectTransferReflection>(ProjectTransferReflection);'
      );
   });

   it('imports a transfer model in the same package by relative path', () => {
      scratch = mkdtempSync(path.join(tmpdir(), 'hydranium-transfer-builder-'));
      const server = packageAt(path.join(scratch, 'server'), '@example/server');

      const source = buildTransferBuilderSource({
         outFile: path.join(server, 'test/generated-hydranium/transfer-builder.ts'),
         transferModelFile: path.join(server, 'src/transfer-model.ts'),
         languageId: 'Project',
         regenCommand: 'Run: regen'
      });

      expect(source).toContain("from '../../src/transfer-model.js';");
   });

   it('names a manifest it cannot parse', () => {
      scratch = mkdtempSync(path.join(tmpdir(), 'hydranium-transfer-builder-'));
      const server = packageAt(path.join(scratch, 'server'), '@example/server');
      const broken = path.join(scratch, 'protocol', 'package.json');
      mkdirSync(path.dirname(broken), { recursive: true });
      writeFileSync(broken, '{ "name": ');

      expect(() =>
         buildTransferBuilderSource({
            outFile: path.join(server, 'test/generated-hydranium/transfer-builder.ts'),
            transferModelFile: path.join(scratch, 'protocol/src/transfer-model.ts'),
            languageId: 'Project',
            regenCommand: 'Run: regen'
         })
      ).toThrow(broken);
   });
});
