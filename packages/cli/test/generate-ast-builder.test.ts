/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Project, type SourceFile } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { buildAstBuilderSource } from '../src/commands/generate-ast-builder.js';

/**
 * Build an in-memory AST source in the shape langium-cli emits. Only the
 * whole-project type alias, the per-grammar namespaces and the reflection const
 * are read, so a hand-written excerpt exercises the same paths as a real
 * generated file without a fixture to regenerate.
 */
function astSource(text: string): SourceFile {
   return new Project({ useInMemoryFileSystem: true }).createSourceFile('/src/generated/ast.ts', text);
}

const OPTIONS = {
   outFile: '/src/generated-hydranium/ast-builder.ts',
   astFile: '/src/generated/ast.ts',
   languageId: 'Project',
   regenCommand: 'Run: npm run generate'
};

const MULTI_GRAMMAR = `
   export namespace LangA {
      export type AstType = { NodeA: NodeA }
   }
   export namespace LangB {
      export type AstType = { NodeB: NodeB }
   }
   export type ProjectAstType = LangA.AstType & LangB.AstType
   export class ProjectAstReflection {}
   export const reflection = new ProjectAstReflection();
`;

const SINGLE_GRAMMAR = `
   export type ProjectAstType = { NodeA: NodeA }
   export class ProjectAstReflection {}
   export const reflection = new ProjectAstReflection();
`;

describe('buildAstBuilderSource', () => {
   it('emits the merged binding plus one per grammar', () => {
      const source = buildAstBuilderSource(astSource(MULTI_GRAMMAR), OPTIONS)!;
      expect(source).toContain('export const astNode = makeAstNodeBuilder<ProjectAstType>(reflection);');
      expect(source).toContain('export const langANode = makeAstNodeBuilder<LangA.AstType>(reflection);');
      expect(source).toContain('export const langBNode = makeAstNodeBuilder<LangB.AstType>(reflection);');
   });

   it('imports the reflection and every bound type map from the AST file', () => {
      const source = buildAstBuilderSource(astSource(MULTI_GRAMMAR), OPTIONS)!;
      expect(source).toContain("import { reflection, type ProjectAstType, type LangA, type LangB } from '../generated/ast.js';");
   });

   it('emits only the merged binding for a single-grammar project', () => {
      // langium-cli emits per-grammar namespaces on its multi-language path only,
      // so there is nothing to narrow to — and the merged doc must not point at a
      // narrowed sibling that was never written.
      const source = buildAstBuilderSource(astSource(SINGLE_GRAMMAR), OPTIONS)!;
      expect(source).toContain('export const astNode = makeAstNodeBuilder<ProjectAstType>(reflection);');
      expect(source).not.toContain('makeAstNodeBuilder<LangA');
      expect(source).not.toContain('narrowed binding');
   });

   it('resolves the reflection const by its initializer, not by its name', () => {
      const renamed = SINGLE_GRAMMAR.replace('export const reflection =', 'export const projectReflection =');
      const source = buildAstBuilderSource(astSource(renamed), OPTIONS)!;
      expect(source).toContain('makeAstNodeBuilder<ProjectAstType>(projectReflection)');
      expect(source).toContain('import { projectReflection,');
   });

   it('ignores a namespace that declares no AstType', () => {
      // An adopter's augmentation can add namespaces to the same file; only the
      // ones langium-cli emits per grammar have a type map to bind.
      const withExtra = MULTI_GRAMMAR + '\n export namespace Helpers { export type Other = string }\n';
      const source = buildAstBuilderSource(astSource(withExtra), OPTIONS)!;
      expect(source).not.toContain('helpersNode');
   });

   it('answers undefined when the whole-project alias is absent', () => {
      const notLangium = astSource('export const reflection = {};');
      expect(buildAstBuilderSource(notLangium, OPTIONS)).toBeUndefined();
   });

   it('fails loudly when two grammars collapse to one export name', () => {
      // `Order` and `order` both yield `orderNode`; emitting anyway would drop a
      // binding silently.
      const colliding = `
         export namespace Order { export type AstType = { A: A } }
         export namespace order { export type AstType = { B: B } }
         export type ProjectAstType = Order.AstType & order.AstType
         export class ProjectAstReflection {}
         export const reflection = new ProjectAstReflection();
      `;
      expect(() => buildAstBuilderSource(astSource(colliding), OPTIONS)).toThrow(/both map to the export 'orderNode'/);
   });

   it('carries the regen command into the generated header', () => {
      const source = buildAstBuilderSource(astSource(SINGLE_GRAMMAR), OPTIONS)!;
      expect(source).toContain('DO NOT EDIT MANUALLY!');
      expect(source).toContain('Run: npm run generate');
   });
});
