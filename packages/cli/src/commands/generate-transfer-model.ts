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
import {
   type Node,
   type ObjectLiteralExpression,
   Project,
   SyntaxKind,
   type ClassDeclaration,
   type InterfaceDeclaration,
   type SourceFile
} from 'ts-morph';

/**
 * Options for the transfer-model generator.
 *
 * The generator reads the Langium-generated AST source plus the consumer's
 * module-augmentation file and emits a serializable "transfer model" — a
 * 1:1 TypeScript projection of the AST suitable for client-server
 * communication. All semantic narrowings happen in the consumer's handwritten
 * overlay file that wraps the generated output.
 */
export interface GenerateTransferModelOptions {
   /** Path to the Langium-generated AST file. */
   astFile: string;
   /** Path to the augmentation file that re-exports the generated AST. */
   augmentationFile: string;
   /** Destination path for the generated transfer model. */
   outFile: string;
   /** Name used for the base element type in the output. Defaults to `TransferElement`. */
   elementTypeName?: string;
   /** Name used for the terminal-patterns const in the output. Defaults to `ModelTerminals`. */
   terminalsName?: string;
   /**
    * Name of the source variable holding the terminal regex literals in the AST file
    * (Langium emits this as `<LanguageId>Terminals`). If omitted, auto-derived from
    * the `<LanguageId>AstReflection` class found in the AST file.
    *
    * In a multi-language project each language's namespace also declares its own
    * `Terminals` const; those are always read in addition to this one, so a
    * multi-language consumer does not need to configure anything here.
    */
   terminalsSourceName?: string;
   /**
    * Type-alias names to skip when emitting. Langium-generated infrastructure type
    * aliases (`<LanguageId>AstType`, `<LanguageId>TerminalNames`, `<LanguageId>TokenNames`)
    * are auto-skipped via the language-id derivation; this list is for additional
    * consumer-specific aliases.
    */
   skipTypeAliases?: string[];
   /** Terminal names to skip when emitting validation patterns. */
   skipTerminals?: string[];
   /**
    * Header comment line shown after "Generated from the Langium AST — DO NOT EDIT
    * MANUALLY!". Defaults to a generic instruction; consumers typically pass the
    * command that regenerates the file in their own repo.
    */
   regenCommand?: string;
}

interface AugmentedProperty {
   name: string;
   type: string;
   optional: boolean;
   readonly: boolean;
   comment?: string;
}

interface ReflectionEntry {
   superTypes: string[];
}

const DEFAULT_ELEMENT_TYPE_NAME = 'TransferElement';
const DEFAULT_TERMINALS_NAME = 'ModelTerminals';
const DEFAULT_REGEN_COMMAND = 'Run the hydranium-cli generate-transfer-model command to regenerate.';
/**
 * Name of the per-language terminals const Langium declares inside each
 * language's namespace in a multi-language project. The top-level
 * `<LanguageId>Terminals` const then spreads these.
 */
const NAMESPACED_TERMINALS_NAME = 'Terminals';

/**
 * Generate once, then re-generate whenever the AST or augmentation file changes,
 * until `signal` aborts (the CLI wires this to SIGINT). Regeneration is debounced
 * so an editor's multi-event save fires a single run, and a generation error is
 * logged without tearing down the watch. Resolves when the signal aborts.
 */
export function watchTransferModel(options: GenerateTransferModelOptions, context: { signal: AbortSignal }): Promise<void> {
   const runSafely = (): void => {
      try {
         generateTransferModel(options);
      } catch (error: unknown) {
         console.error(`Transfer-model generation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
   };
   runSafely();
   console.log(`Watching ${options.astFile} and ${options.augmentationFile} for changes. Press Ctrl-C to stop.`);

   let timer: NodeJS.Timeout | undefined;
   const scheduleRerun = (): void => {
      if (timer) {
         clearTimeout(timer);
      }
      timer = setTimeout(runSafely, 150);
   };
   const watchers = [options.astFile, options.augmentationFile].map(file => fs.watch(file, scheduleRerun));

   return new Promise<void>(resolve => {
      context.signal.addEventListener(
         'abort',
         () => {
            for (const watcher of watchers) {
               watcher.close();
            }
            if (timer) {
               clearTimeout(timer);
            }
            resolve();
         },
         { once: true }
      );
   });
}

/** Run the transfer-model generator. */
export function generateTransferModel(options: GenerateTransferModelOptions): void {
   const elementTypeName = options.elementTypeName ?? DEFAULT_ELEMENT_TYPE_NAME;
   const terminalsName = options.terminalsName ?? DEFAULT_TERMINALS_NAME;
   const regenCommand = options.regenCommand ?? DEFAULT_REGEN_COMMAND;
   const extraSkipTypeAliases = new Set(options.skipTypeAliases ?? []);
   const skipTerminals = new Set(options.skipTerminals ?? []);

   const project = new Project({
      compilerOptions: { strict: true },
      skipAddingFilesFromTsConfig: true
   });
   const astSource = project.addSourceFileAtPath(options.astFile);
   const augSource = project.addSourceFileAtPath(options.augmentationFile);

   // 1. Locate the AstReflection class in the AST source. Langium names it
   //    `<LanguageId>AstReflection` and exports it. We accept any class extending
   //    `AbstractAstReflection`; in practice each language has exactly one.
   const reflectionClass = findAstReflectionClass(astSource);
   const languageId = reflectionClass.getName()?.replace(/AstReflection$/, '') ?? '';

   // 2. Auto-skip Langium infrastructure type aliases derived from the language id,
   //    plus the consumer's extra entries.
   const autoSkipTypeAliases = new Set([`${languageId}AstType`, `${languageId}TerminalNames`, `${languageId}TokenNames`]);
   const skipTypeAliases = new Set([...autoSkipTypeAliases, ...extraSkipTypeAliases]);

   // 3. Extract reflection metadata (superTypes per type) via ts-morph rather than
   //    dynamic-importing the AST module — keeps the CLI runnable on raw .ts source
   //    without requiring a tsx loader on the consumer.
   const reflectionTypes = parseReflectionTypes(reflectionClass);

   // 4. Collect AST interfaces + type aliases.
   const astInterfaces = new Map<string, InterfaceDeclaration>();
   for (const iface of astSource.getInterfaces()) {
      astInterfaces.set(iface.getName(), iface);
   }

   const typeAliases: Array<{ name: string; definition: string }> = [];
   for (const alias of astSource.getTypeAliases()) {
      const name = alias.getName();
      if (skipTypeAliases.has(name)) {
         continue;
      }
      const typeText = alias.getTypeNode()?.getText();
      if (typeText) {
         typeAliases.push({ name, definition: mapType(resolveNamespacedStringUnion(astSource, typeText), elementTypeName) });
      }
   }

   // 5. Parse augmentations from the consumer's `declare module` blocks.
   const constants = resolveConstants(augSource);
   const augmented = parseAugmentations(augSource, constants, elementTypeName);

   // 6. Parse terminal regex literals from the AST file — the top-level const for
   //    a single-language project, plus every per-language namespace's `Terminals`
   //    for a multi-language one.
   const terminalsSourceName = options.terminalsSourceName ?? `${languageId}Terminals`;
   const terminals = parseTerminals(astSource, terminalsSourceName, skipTerminals);

   // 7. Classify interfaces: abstract (union $type) vs concrete (literal $type).
   const interfaceNames: string[] = [];
   const abstractTypes = new Set<string>();
   const concreteTypes = new Set<string>();

   for (const name of Object.keys(reflectionTypes)) {
      const iface = astInterfaces.get(name);
      if (!iface) {
         // Type alias, not an interface — handled separately via `typeAliases`.
         continue;
      }
      interfaceNames.push(name);
      const typeText = iface.getProperty('$type')?.getTypeNode()?.getText() ?? '';
      if (typeText.includes('|')) {
         abstractTypes.add(name);
      } else {
         concreteTypes.add(name);
      }
   }

   // 8. Resolve extends-chains. Filter out type-alias supertypes (Langium reflection
   //    includes them for the grammar hierarchy but TypeScript can't extend a union
   //    type alias). Empty supers fall back to the framework's element type.
   const typeAliasNames = new Set(typeAliases.map(ta => ta.name));
   const getExtends = (name: string): string[] => {
      const supers = reflectionTypes[name]?.superTypes;
      if (!supers?.length) {
         return [elementTypeName];
      }
      const interfaceSupers = supers.filter(s => !typeAliasNames.has(s));
      return interfaceSupers.length ? [...interfaceSupers] : [elementTypeName];
   };

   // 9. Topological sort so base types appear first.
   const sorted = topologicalSort(interfaceNames, getExtends);

   // 10. Build output.
   const out: string[] = [];

   out.push('/******************************************************************************');
   out.push(' * Generated from the Langium AST — DO NOT EDIT MANUALLY!');
   out.push(` * ${regenCommand}`);
   out.push(' ******************************************************************************/');
   out.push('');
   out.push('/* eslint-disable */');
   out.push('');

   // Base types (inlined — no external dependency on @hydranium/protocol so the
   // generated file is fully self-contained and consumers stay in control of how
   // they layer the framework's `TransferElement` on top via the overlay).
   out.push('// eslint-disable-next-line @typescript-eslint/no-unused-vars');
   out.push('export type Reference<T> = string;');
   out.push('');
   out.push(`export interface ${elementTypeName} {`);
   out.push('   readonly $type: string;');
   out.push('}');
   out.push('');

   // Type constants for concrete types.
   out.push('// --- Type Constants ---');
   for (const name of sorted) {
      if (concreteTypes.has(name)) {
         out.push(`export const ${name}Type = '${name}';`);
      }
   }
   out.push('');

   // Type aliases.
   if (typeAliases.length > 0) {
      out.push('// --- Type Aliases ---');
      for (const { name, definition } of typeAliases) {
         out.push(`export type ${name} = ${definition};`);
         const literals = extractStringLiterals(definition);
         if (literals) {
            const items = literals.map(l => `'${l}'`).join(', ');
            out.push(`export const ${name}Values = [${items}] as const;`);
         }
      }
      out.push('');
   }

   // Terminal regex patterns (anchored for full-string validation).
   if (terminals.length > 0) {
      out.push('// --- Terminal Patterns (anchored for validation) ---');
      out.push(`export const ${terminalsName} = {`);
      for (const { name, pattern } of terminals) {
         out.push(`   ${name}: ${pattern},`);
      }
      out.push('};');
      out.push('');
   }

   // Interfaces.
   out.push('// --- Interfaces ---');
   for (const name of sorted) {
      const iface = astInterfaces.get(name)!;
      const isAbstract = abstractTypes.has(name);
      const extendsTypes = getExtends(name);

      out.push(`export interface ${name} extends ${extendsTypes.join(', ')} {`);

      if (isAbstract) {
         const typeValue = iface.getProperty('$type')?.getTypeNode()?.getText() ?? `'${name}'`;
         out.push(`   readonly $type: ${typeValue};`);
      } else {
         out.push(`   readonly $type: typeof ${name}Type;`);
      }

      const emitted = new Set<string>(['$type']);
      for (const prop of iface.getProperties()) {
         const propName = prop.getName();
         if (propName.startsWith('$')) {
            continue;
         }
         const mappedType = mapType(prop.getTypeNode()?.getText() ?? 'unknown', elementTypeName);
         const opt = prop.hasQuestionToken() ? '?' : '';
         const ro = prop.isReadonly() ? 'readonly ' : '';
         const jsDocs = prop.getJsDocs();
         if (jsDocs.length > 0) {
            const comment = jsDocs[0]
               .getInnerText()
               .trim()
               .replace(/\s*\n\s*/g, ' ');
            if (comment) {
               out.push(`   /** ${comment} */`);
            }
         }
         out.push(`   ${ro}${propName}${opt}: ${mappedType};`);
         emitted.add(propName);
      }

      for (const aug of augmented.get(name) ?? []) {
         if (emitted.has(aug.name)) {
            continue;
         }
         const opt = aug.optional ? '?' : '';
         const ro = aug.readonly ? 'readonly ' : '';
         if (aug.comment) {
            out.push(`   /** ${aug.comment} */`);
         }
         out.push(`   ${ro}${aug.name}${opt}: ${aug.type};`);
         emitted.add(aug.name);
      }

      out.push('}');
      out.push('');
   }

   // Type guards.
   out.push('// --- Type Guards ---');

   out.push(`export function is${elementTypeName}(item: unknown): item is ${elementTypeName} {`);
   out.push(`   return !!item && typeof item === 'object' && '$type' in item && typeof (item as ${elementTypeName}).$type === 'string';`);
   out.push('}');
   out.push('');

   for (const name of sorted) {
      const iface = astInterfaces.get(name)!;
      const isAbstract = abstractTypes.has(name);

      out.push(`export function is${name}(item: unknown): item is ${name} {`);
      if (isAbstract) {
         const typeText = iface.getProperty('$type')?.getTypeNode()?.getText() ?? '';
         const members = [...typeText.matchAll(/'([^']+)'/g)].map(m => m[1]);
         const checks = members.map(m => `item.$type === '${m}'`).join(' || ');
         out.push(`   return is${elementTypeName}(item) && (${checks});`);
      } else {
         out.push(`   return is${elementTypeName}(item) && item.$type === ${name}Type;`);
      }
      out.push('}');
      out.push('');
   }

   for (const { name, definition } of typeAliases) {
      const literals = extractStringLiterals(definition);
      if (literals) {
         const checks = literals.map(l => `item === '${l}'`).join(' || ');
         out.push(`export function is${name}(item: unknown): item is ${name} {`);
         out.push(`   return ${checks};`);
         out.push('}');
         out.push('');
      } else {
         // Union (or single) of named members and/or Langium data-type primitives. Each member maps
         // to its own check (typeof / instanceof / named-guard) via typeAliasMemberGuard.
         const members = definition.split('|').map(s => s.trim());
         const checks = members.map(typeAliasMemberGuard).join(' || ');
         out.push(`export function is${name}(item: unknown): item is ${name} {`);
         out.push(`   return ${checks};`);
         out.push('}');
         out.push('');
      }
   }

   // Coverage check: warn on reflection types not emitted.
   const processedSet = new Set(sorted);
   for (const name of Object.keys(reflectionTypes)) {
      if (!processedSet.has(name) && !typeAliasNames.has(name)) {
         console.warn(`Warning: reflection type '${name}' was not included in the transfer model`);
      }
   }

   // Up-to-date check + write.
   const content = out.join('\n') + '\n';
   fs.mkdirSync(path.dirname(options.outFile), { recursive: true });
   if (fs.existsSync(options.outFile) && fs.readFileSync(options.outFile, 'utf-8') === content) {
      console.log('Transfer model is up to date.');
      return;
   }
   fs.writeFileSync(options.outFile, content, 'utf-8');
   console.log(`Generated: ${options.outFile}`);
}

// ---------------------------------------------------------------------------
// AST source parsing helpers
// ---------------------------------------------------------------------------

/**
 * Drill past `as const`, `satisfies X`, and parenthesised wrappers to the
 * underlying object literal. Newer Langium emit decorates the reflection-types
 * initializer with `as const` and/or `satisfies AstReflectionTypes`.
 */
function unwrapToObjectLiteral(node: Node): ObjectLiteralExpression | undefined {
   let current: Node | undefined = node;
   while (current && !current.isKind(SyntaxKind.ObjectLiteralExpression)) {
      if (current.isKind(SyntaxKind.AsExpression) || current.isKind(SyntaxKind.SatisfiesExpression)) {
         current = current.getExpression();
      } else if (current.isKind(SyntaxKind.ParenthesizedExpression)) {
         current = current.getExpression();
      } else {
         return undefined;
      }
   }
   return current?.asKind(SyntaxKind.ObjectLiteralExpression);
}

function findAstReflectionClass(source: SourceFile): ClassDeclaration {
   for (const cls of source.getClasses()) {
      const heritage = cls.getHeritageClauses();
      for (const clause of heritage) {
         for (const type of clause.getTypeNodes()) {
            if (type.getText().includes('AbstractAstReflection')) {
               return cls;
            }
         }
      }
   }
   throw new Error('Could not find a class extending AbstractAstReflection in the AST source.');
}

/**
 * Extract `superTypes` for each entry of the reflection class's `types` property
 * initializer. We rely on the Langium convention that `X.$type === 'X'`, so a
 * supertype expression resolves to the literal type-name string by stripping
 * `.$type`.
 */
function parseReflectionTypes(reflectionClass: ClassDeclaration): Record<string, ReflectionEntry> {
   const result: Record<string, ReflectionEntry> = {};
   const typesProp = reflectionClass.getProperty('types');
   const rawInitializer = typesProp?.getInitializer();
   const initializer = rawInitializer ? unwrapToObjectLiteral(rawInitializer) : undefined;
   if (!initializer) {
      throw new Error('Reflection class is missing an object-literal `types` property.');
   }

   for (const entry of initializer.getProperties()) {
      if (entry.getKind() !== SyntaxKind.PropertyAssignment) {
         continue;
      }
      const name = entry.getFirstChildByKind(SyntaxKind.Identifier)?.getText();
      if (!name) {
         continue;
      }
      const value = entry.getLastChildByKind(SyntaxKind.ObjectLiteralExpression);
      const supersProp = value?.getProperty('superTypes');
      const supersInit = supersProp?.getFirstChildByKind(SyntaxKind.ArrayLiteralExpression);
      const superTypes: string[] = [];
      if (supersInit) {
         for (const element of supersInit.getElements()) {
            const text = element.getText();
            const dotMatch = /^([A-Za-z_$][\w$]*)\.\$type$/.exec(text);
            if (dotMatch) {
               superTypes.push(dotMatch[1]);
               continue;
            }
            // Bare identifier or quoted string fall-back.
            const stringMatch = /^['"](.+)['"]$/.exec(text);
            if (stringMatch) {
               superTypes.push(stringMatch[1]);
            } else {
               superTypes.push(text);
            }
         }
      }
      result[name] = { superTypes };
   }
   return result;
}

/**
 * Collect terminal regex literals from the AST file.
 *
 * Single-language projects put every terminal in one top-level
 * `<LanguageId>Terminals` const. Multi-language projects keep that const as a
 * spread of per-language `Terminals` consts declared inside each language's
 * namespace, and each namespace carries only the terminals its own grammar
 * reaches — so both sources are read and unioned.
 *
 * De-duplicated by terminal name, top-level first: when two grammars declare the
 * same terminal, the first declaration wins and the rest are dropped rather than
 * emitting a duplicate validation pattern. Terminals differing only by grammar are indistinguishable
 * in the flat output, which is why the emitted patterns stay a
 * lowest-common-denominator client-side check rather than a per-language one.
 */
export function parseTerminals(
   astSource: SourceFile,
   terminalsSourceName: string,
   skipTerminals: Set<string>
): Array<{ name: string; pattern: string }> {
   const terminals: Array<{ name: string; pattern: string }> = [];
   const seen = new Set<string>();

   const collectFrom = (objLiteral: ObjectLiteralExpression | undefined): void => {
      if (!objLiteral) {
         return;
      }
      for (const prop of objLiteral.getChildrenOfKind(SyntaxKind.PropertyAssignment)) {
         const name = prop.getName();
         if (skipTerminals.has(name) || seen.has(name)) {
            continue;
         }
         const regex = prop.getFirstChildByKind(SyntaxKind.RegularExpressionLiteral);
         if (!regex) {
            continue;
         }
         const match = /^\/(.+)\/([gimsuy]*)$/s.exec(regex.getText());
         if (match) {
            terminals.push({ name, pattern: `/^(?:${match[1]})$/` });
            seen.add(name);
         }
      }
   };

   collectFrom(astSource.getVariableDeclaration(terminalsSourceName)?.getFirstChildByKind(SyntaxKind.ObjectLiteralExpression));
   for (const namespaceDecl of astSource.getModules()) {
      collectFrom(namespaceDecl.getVariableDeclaration(NAMESPACED_TERMINALS_NAME)?.getFirstChildByKind(SyntaxKind.ObjectLiteralExpression));
   }
   return terminals;
}

function resolveConstants(source: SourceFile): Map<string, string> {
   const constants = new Map<string, string>();
   for (const decl of source.getVariableDeclarations()) {
      const init = decl.getInitializer();
      if (init) {
         const match = /^['"](.+)['"]$/.exec(init.getText());
         if (match) {
            constants.set(decl.getName(), match[1]);
         }
      }
   }
   return constants;
}

function parseAugmentations(source: SourceFile, constants: Map<string, string>, elementTypeName: string): Map<string, AugmentedProperty[]> {
   const result = new Map<string, AugmentedProperty[]>();

   for (const stmt of source.getStatements()) {
      if (stmt.getKind() !== SyntaxKind.ModuleDeclaration) {
         continue;
      }
      const body = stmt.getFirstChildByKind(SyntaxKind.ModuleBlock);
      if (!body) {
         continue;
      }

      for (const iface of body.getChildrenOfKind(SyntaxKind.InterfaceDeclaration)) {
         const props: AugmentedProperty[] = [];

         for (const prop of iface.getProperties()) {
            const nameText = prop.getNameNode().getText();
            let propName: string;
            if (nameText.startsWith('[') && nameText.endsWith(']')) {
               const constName = nameText.slice(1, -1).trim();
               const resolved = constants.get(constName);
               if (!resolved) {
                  continue;
               }
               propName = resolved;
            } else {
               propName = prop.getName();
            }

            if (propName.startsWith('$')) {
               continue;
            }

            const jsDocs = prop.getJsDocs();
            const comment =
               jsDocs.length > 0
                  ? jsDocs[0]
                       .getInnerText()
                       .trim()
                       .replace(/\s*\n\s*/g, ' ')
                  : undefined;

            props.push({
               name: propName,
               type: mapType(prop.getTypeNode()?.getText() ?? 'unknown', elementTypeName),
               optional: prop.hasQuestionToken(),
               readonly: prop.isReadonly(),
               comment: comment || undefined
            });
         }

         if (props.length > 0) {
            const existing = result.get(iface.getName()) ?? [];
            result.set(iface.getName(), [...existing, ...props]);
         }
      }
   }

   return result;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Map AST type text to transfer-model form: strip the `langium.` namespace. */
function mapType(text: string, elementTypeName: string): string {
   return text.replace(/langium\.Reference<(\w+)>/g, 'Reference<$1>').replace(/langium\.AstNode/g, elementTypeName);
}

/**
 * Type-guard expression (against an `item: unknown`) for one member of a non-literal type-alias
 * union. Covers the full set of Langium data-type primitives: the `typeof`-checkable ones
 * (`string`/`number`/`boolean`/`bigint`) use `typeof`; `Date` — the one Langium primitive `typeof`
 * reports as `'object'` — uses `instanceof`; any other member is a named type whose generated
 * `is<Member>` guard is called.
 */
export function typeAliasMemberGuard(member: string): string {
   switch (member) {
      case 'string':
      case 'number':
      case 'boolean':
      case 'bigint':
         return `typeof item === '${member}'`;
      case 'Date':
         return 'item instanceof Date';
      default:
         return `is${member}(item)`;
   }
}

/**
 * Flatten a type-alias definition that references per-language namespace members
 * into a single string-literal union.
 *
 * Langium emits namespace-qualified aliases for a multi-language project, but the
 * protocol package that consumes the generated transfer model cannot see those
 * namespaces, so the reference has to be inlined here or it emits an unresolvable
 * name.
 *
 * Each referenced member is inlined and de-duplicated, preserving first-seen
 * order. The definition is returned UNCHANGED when it holds no
 * namespace-qualified reference (the single-language case) or when any referenced
 * member is not a pure string-literal union — passing it through rather than
 * emitting a half-resolved union.
 */
export function resolveNamespacedStringUnion(astSource: SourceFile, definition: string): string {
   const references = [...definition.matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g)];
   if (references.length === 0) {
      return definition;
   }
   const literals: string[] = [];
   const seen = new Set<string>();
   for (const [, namespaceName, memberName] of references) {
      const alias = astSource.getModule(namespaceName)?.getTypeAlias(memberName);
      const memberLiterals = extractStringLiterals(alias?.getTypeNode()?.getText() ?? '');
      if (!memberLiterals) {
         return definition;
      }
      for (const literal of memberLiterals) {
         if (!seen.has(literal)) {
            seen.add(literal);
            literals.push(literal);
         }
      }
   }
   return literals.map(literal => `'${literal}'`).join(' | ');
}

/** Extract string literals from a union definition, or undefined if not pure literals. */
function extractStringLiterals(definition: string): string[] | undefined {
   const stringLiteral = '(?:\'[^\']*\'|"[^"]*")';
   if (!new RegExp(`^\\|?\\s*${stringLiteral}(\\s*\\|\\s*${stringLiteral})*$`).test(definition.trim())) {
      return undefined;
   }
   return [...definition.matchAll(/'([^']*)'|"([^"]*)"/g)].map(m => m[1] ?? m[2]);
}

function topologicalSort(names: string[], getDeps: (n: string) => string[]): string[] {
   const visited = new Set<string>();
   const nameSet = new Set(names);
   const sorted: string[] = [];

   function visit(name: string): void {
      if (visited.has(name)) {
         return;
      }
      visited.add(name);
      for (const dep of getDeps(name)) {
         if (nameSet.has(dep)) {
            visit(dep);
         }
      }
      sorted.push(name);
   }

   for (const name of names) {
      visit(name);
   }
   return sorted;
}
