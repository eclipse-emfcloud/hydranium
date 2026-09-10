/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import type { SourceFile } from 'ts-morph';

/** Inputs for {@link emitAstBuilder}, resolved by the transfer-model command. */
export interface EmitAstBuilderOptions {
   /** Destination path for the generated builder module. */
   outFile: string;
   /** Path to the Langium-generated AST file the builder imports from. */
   astFile: string;
   /** Language id derived from the `<LanguageId>AstReflection` class name. */
   languageId: string;
   /** Header line naming the command that regenerates the file. */
   regenCommand: string;
}

/**
 * A single `makeAstNodeBuilder` binding the generator emits.
 *
 * `typeMap` is the type expression handed to the generic — the whole-project
 * alias for the merged binding, `<Namespace>.AstType` for a narrowed one.
 */
interface BuilderBinding {
   exportName: string;
   typeMap: string;
   /** Grammar this binding is narrowed to; absent on the merged binding. */
   namespace?: string;
}

/**
 * Langium declares this type alias inside each language's namespace in a
 * multi-language project. Its presence is what marks a namespace as a grammar's
 * type registry rather than an incidental one.
 */
const NAMESPACED_AST_TYPE_NAME = 'AstType';

/** Export name of the merged, whole-project binding. */
const MERGED_EXPORT_NAME = 'astNode';

/**
 * Emit a module binding {@link makeAstNodeBuilder} to a project's reflection,
 * once per grammar plus once across all of them.
 *
 * **The binding is boilerplate with exactly one degree of freedom** — the type
 * map — so hand-writing it buys nothing and goes stale the moment a grammar is
 * added. Generating it is also the only way a narrowed binding can exist at all:
 * the per-grammar type maps live in namespaces Langium emits only on its
 * multi-language path, so a single-grammar project gets the merged binding alone
 * and there is nothing to narrow.
 *
 * **A narrowed binding is only as narrow as its grammar's import closure.**
 * Langium's per-grammar `AstType` lists everything REACHABLE from that grammar,
 * so where one grammar imports all the others its map equals the project's and
 * its binding checks nothing the merged one does not. The emitted doc says so at
 * each declaration rather than promising a guarantee the type map cannot give.
 *
 * Answers `false` when the AST source declares no whole-project type alias,
 * which means the file did not come from `langium generate` and the caller
 * should report rather than write a module that cannot compile.
 */
export function emitAstBuilder(astSource: SourceFile, options: EmitAstBuilderOptions): boolean {
   const content = buildAstBuilderSource(astSource, options);
   if (content === undefined) {
      return false;
   }

   fs.mkdirSync(path.dirname(options.outFile), { recursive: true });
   if (fs.existsSync(options.outFile) && fs.readFileSync(options.outFile, 'utf-8') === content) {
      console.log('AST builder is up to date.');
      return true;
   }
   fs.writeFileSync(options.outFile, content, 'utf-8');
   console.log(`Generated: ${options.outFile}`);
   return true;
}

/**
 * The module text {@link emitAstBuilder} would write, or `undefined` when the
 * AST source declares no whole-project type alias. Pure over its inputs, so the
 * emitted shape is testable without touching a filesystem.
 */
export function buildAstBuilderSource(astSource: SourceFile, options: EmitAstBuilderOptions): string | undefined {
   const mergedTypeMap = `${options.languageId}AstType`;
   if (!astSource.getTypeAlias(mergedTypeMap)) {
      return undefined;
   }

   const bindings: BuilderBinding[] = [{ exportName: MERGED_EXPORT_NAME, typeMap: mergedTypeMap }];
   for (const namespace of findGrammarNamespaces(astSource)) {
      bindings.push({
         exportName: builderExportName(namespace),
         typeMap: `${namespace}.${NAMESPACED_AST_TYPE_NAME}`,
         namespace
      });
   }
   assertDistinctExportNames(bindings);

   return renderAstBuilder(bindings, {
      reflectionName: findReflectionConstName(astSource, options.languageId),
      importPath: relativeImportPath(options.outFile, options.astFile),
      regenCommand: options.regenCommand
   });
}

/**
 * Namespaces that carry a grammar's type registry, in declaration order.
 *
 * Keyed on the nested `AstType` alias rather than on the namespace being
 * exported, because an adopter's augmentation can add namespaces to the same
 * file for unrelated reasons and only the ones Langium emits per grammar have
 * a type map to bind.
 */
function findGrammarNamespaces(astSource: SourceFile): string[] {
   const names: string[] = [];
   for (const module of astSource.getModules()) {
      const name = module.getName();
      if (name && module.getTypeAlias(NAMESPACED_AST_TYPE_NAME)) {
         names.push(name);
      }
   }
   return names;
}

/**
 * `Domain` → `domainNode`. Lower-cases the leading character only, so a grammar
 * named `OrderFlow` reads as `orderFlowNode` rather than losing its word break.
 */
function builderExportName(namespace: string): string {
   return `${namespace.charAt(0).toLowerCase()}${namespace.slice(1)}Node`;
}

/**
 * Two grammars whose names differ only in their leading character collapse to
 * one export. Emitting anyway would silently drop a binding, so fail with both
 * names rather than leave the caller to discover it at compile time.
 */
function assertDistinctExportNames(bindings: readonly BuilderBinding[]): void {
   const seen = new Map<string, string>();
   for (const binding of bindings) {
      const previous = seen.get(binding.exportName);
      if (previous !== undefined) {
         throw new Error(
            `Cannot emit the AST builder: grammars '${previous}' and '${binding.namespace}' both map to the export ` +
               `'${binding.exportName}'. Rename one grammar so the generated bindings stay distinct.`
         );
      }
      seen.set(binding.exportName, binding.namespace ?? MERGED_EXPORT_NAME);
   }
}

/**
 * Name of the const holding the project's reflection instance.
 *
 * Langium emits `export const reflection = new <LanguageId>AstReflection()`, but
 * the const is located by its initializer rather than by that name so a renamed
 * export still resolves. Falls back to the emitted default when no declaration
 * matches, which keeps the output compiling against a stock Langium file.
 */
function findReflectionConstName(astSource: SourceFile, languageId: string): string {
   const reflectionClass = `${languageId}AstReflection`;
   for (const declaration of astSource.getVariableDeclarations()) {
      if (declaration.getInitializer()?.getText().replace(/\s/g, '') === `new${reflectionClass}()`) {
         return declaration.getName();
      }
   }
   return 'reflection';
}

/**
 * Module specifier for the AST file as seen from the generated module's own
 * directory. Emitted with a `.js` extension and posix separators because the
 * output is ESM TypeScript, where the specifier names the compiled sibling.
 */
function relativeImportPath(outFile: string, astFile: string): string {
   const relative = path.relative(path.dirname(path.resolve(outFile)), path.resolve(astFile));
   const posix = relative.split(path.sep).join('/').replace(/\.ts$/, '.js');
   return posix.startsWith('.') ? posix : `./${posix}`;
}

function renderAstBuilder(
   bindings: readonly BuilderBinding[],
   context: { reflectionName: string; importPath: string; regenCommand: string }
): string {
   const imported = [context.reflectionName, ...bindings.map(binding => `type ${binding.namespace ?? binding.typeMap}`)];
   const out: string[] = [];

   out.push('/******************************************************************************');
   out.push(' * Generated from the Langium AST — DO NOT EDIT MANUALLY!');
   out.push(` * ${context.regenCommand}`);
   out.push(' ******************************************************************************/');
   out.push('');
   out.push('/* eslint-disable */');
   out.push('');
   out.push("import { makeAstNodeBuilder } from '@hydranium/core';");
   out.push(`import { ${imported.join(', ')} } from '${context.importPath}';`);
   out.push('');

   // A single-grammar project has nothing to narrow to, so the merged binding is
   // simply THE binding there and must not point at a sibling that was not emitted.
   const narrowed = bindings.some(binding => binding.namespace !== undefined);
   const guarantee = [
      ' * Mandatory fields are a type error at the call site, and grammar-declared',
      ' * containment arrays are materialised from reflection metadata, so a built',
      ' * node carries `[]` where a cast literal would leave `undefined`.'
   ];

   for (const binding of bindings) {
      out.push('/**');
      if (binding.namespace !== undefined) {
         out.push(` * AST-node factory narrowed to the '${binding.namespace}' grammar.`);
         out.push(' *');
         out.push(' * Narrowed by grammar REACHABILITY, not by ownership: a grammar that');
         out.push(" * imports another sees that one's types too, so this binding is only as");
         out.push(` * narrow as '${binding.namespace}'s import closure. Where that closure is the`);
         out.push(' * whole project, it accepts exactly what the merged binding does and the');
         out.push(' * choice is documentation rather than a check.');
         out.push(' *');
         out.push(...guarantee);
      } else if (narrowed) {
         out.push(' * AST-node factory spanning every grammar in this project.');
         out.push(' *');
         out.push(' * Prefer the narrowed binding matching the grammar the call site works in:');
         out.push(" * it rejects a type outside that grammar's import closure, which this one");
         out.push(' * accepts from anywhere. Reach for this one where a call site genuinely');
         out.push(' * spans grammars.');
      } else {
         out.push(" * AST-node factory for this project's grammar.");
         out.push(' *');
         out.push(...guarantee);
      }
      out.push(' */');
      out.push(`export const ${binding.exportName} = makeAstNodeBuilder<${binding.typeMap}>(${context.reflectionName});`);
      out.push('');
   }

   return out.join('\n');
}
