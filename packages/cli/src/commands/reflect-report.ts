/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Type-only import: the CLI is head-neutral and carries no runtime `@hydranium/core`
// dependency (the head's copy is resolved at run time via `loadHeadlessContext`).
import type { GrammarReflection, TypeReflection } from '@hydranium/core/node';

/** Escape a value for a Markdown table cell (only `|` and newlines can break a row). */
function cell(value: string): string {
   return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Wrap a value in inline-code backticks, escaping any embedded backtick run. */
function code(value: string): string {
   return `\`${value}\``;
}

/** The Markdown for each language's grammar surface — extensions, entry rule, terminals table. */
function languageSection(reflection: GrammarReflection): string[] {
   const lines: string[] = ['## Languages', ''];
   for (const language of reflection.languages) {
      lines.push(`### ${language.languageId}`, '');
      const extensions = language.fileExtensions.length ? language.fileExtensions.map(code).join(', ') : '_none_';
      lines.push(`- File extensions: ${extensions}`);
      lines.push(`- Entry rule: ${language.entryRule ? code(language.entryRule) : '_none_'}`);
      lines.push(`- Terminals: ${language.terminals.length}`, '');
      if (language.terminals.length) {
         lines.push('| Terminal | Pattern | Hidden |', '| --- | --- | --- |');
         for (const terminal of language.terminals) {
            const pattern = terminal.pattern !== undefined ? code(terminal.pattern) : '';
            lines.push(`| ${cell(terminal.name)} | ${cell(pattern)} | ${terminal.hidden ? 'yes' : ''} |`);
         }
         lines.push('');
      }
   }
   return lines;
}

/**
 * A depth-first hierarchy tree from the roots (types with no super types) down
 * through `directSubTypes`. A type reachable from several supertypes appears under
 * each; a cycle (should not occur in a grammar) is broken by not re-descending a
 * type already on the current path.
 */
function hierarchySection(reflection: GrammarReflection): string[] {
   const byName = new Map(reflection.types.map(type => [type.name, type]));
   const roots = reflection.types.filter(type => type.superTypes.length === 0);
   const lines: string[] = ['## Type hierarchy', ''];
   const walk = (type: TypeReflection, depth: number, path: ReadonlySet<string>): void => {
      lines.push(`${'  '.repeat(depth)}- ${type.name}`);
      const nextPath = new Set(path).add(type.name);
      for (const childName of type.directSubTypes) {
         const child = byName.get(childName);
         if (child && !nextPath.has(childName)) {
            walk(child, depth + 1, nextPath);
         }
      }
   };
   for (const root of roots) {
      walk(root, 0, new Set());
   }
   lines.push('');
   return lines;
}

/** The `Type.property → TargetType` list of every cross-reference in the grammar. */
function crossReferenceSection(reflection: GrammarReflection): string[] {
   const lines: string[] = ['## Cross-reference targets', ''];
   let hasCrossReferences = false;
   for (const type of reflection.types) {
      for (const property of type.properties) {
         if (property.referenceType !== undefined) {
            lines.push(`- ${code(`${type.name}.${property.name}`)} → ${code(property.referenceType)}`);
            hasCrossReferences = true;
         }
      }
   }
   if (!hasCrossReferences) {
      lines.push('_No cross-references._');
   }
   lines.push('');
   return lines;
}

/** Per-type detail: super types plus a property table (name, reference target, array, default). */
function typeDetailSection(reflection: GrammarReflection): string[] {
   const lines: string[] = [`## Types (${reflection.types.length})`, ''];
   for (const type of reflection.types) {
      lines.push(`### ${type.name}`, '');
      if (type.superTypes.length) {
         lines.push(`- Super types: ${type.superTypes.map(code).join(', ')}`);
      }
      if (type.directSubTypes.length) {
         lines.push(`- Sub types: ${type.directSubTypes.map(code).join(', ')}`);
      }
      lines.push('');
      if (type.properties.length) {
         lines.push('| Property | Reference target | Array | Default |', '| --- | --- | --- | --- |');
         for (const property of type.properties) {
            const reference = property.referenceType !== undefined ? code(property.referenceType) : '';
            lines.push(
               `| ${cell(property.name)} | ${cell(reference)} | ${property.array ? 'yes' : ''} | ${property.hasDefault ? 'yes' : ''} |`
            );
         }
      } else {
         lines.push('_No properties._');
      }
      lines.push('');
   }
   return lines;
}

/**
 * Render a grammar reflection for the terminal. `json` emits the raw
 * {@link GrammarReflection} (the machine-readable contract); the default is a
 * Markdown reference — a per-language grammar surface (terminals, entry rule), the
 * type-hierarchy tree, the cross-reference target list, and a per-type property
 * table — suitable for piping into a `.md` file.
 */
export function formatReflectionReport(reflection: GrammarReflection, options: { json?: boolean } = {}): string {
   if (options.json) {
      return JSON.stringify(reflection, undefined, 2);
   }
   return [
      '# Grammar reflection',
      '',
      ...languageSection(reflection),
      ...hierarchySection(reflection),
      ...crossReferenceSection(reflection),
      ...typeDetailSection(reflection)
   ].join('\n');
}
