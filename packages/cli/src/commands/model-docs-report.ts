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

/** GitHub-style heading slug: lowercase, non-alphanumerics to hyphens, collapse repeats. */
function slug(name: string): string {
   return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
}

/** A Markdown link to a type's section, when that type has a section; else bare code. */
function typeLink(name: string, known: ReadonlySet<string>): string {
   return known.has(name) ? `[${name}](#${slug(name)})` : `\`${name}\``;
}

/** Escape a value for a Markdown table cell (only `|` and newlines can break a row). */
function cell(value: string): string {
   return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Per-language grammar summary — extensions, entry rule, terminals table. */
function languageSection(reflection: GrammarReflection): string[] {
   const lines: string[] = ['## Languages', ''];
   for (const language of reflection.languages) {
      lines.push(`### ${language.languageId}`, '');
      const extensions = language.fileExtensions.length ? language.fileExtensions.map(ext => `\`${ext}\``).join(', ') : '_none_';
      lines.push(`- File extensions: ${extensions}`);
      lines.push(`- Entry rule: ${language.entryRule ? `\`${language.entryRule}\`` : '_none_'}`);
      lines.push('');
      if (language.terminals.length) {
         lines.push('| Terminal | Pattern | Hidden |', '| --- | --- | --- |');
         for (const terminal of language.terminals) {
            const pattern = terminal.pattern !== undefined ? `\`${cell(terminal.pattern)}\`` : '';
            lines.push(`| ${cell(terminal.name)} | ${pattern} | ${terminal.hidden ? 'yes' : ''} |`);
         }
         lines.push('');
      }
   }
   return lines;
}

/** The alphabetical type index (TOC), each entry linked, marking abstract vs concrete. */
function typeIndexSection(reflection: GrammarReflection): string[] {
   const lines: string[] = [`## Types (${reflection.types.length})`, ''];
   for (const type of reflection.types) {
      const kind = type.directSubTypes.length ? ' _(abstract)_' : '';
      lines.push(`- [${type.name}](#${slug(type.name)})${kind}`);
   }
   lines.push('');
   return lines;
}

/** Build the reverse index: for each type, the `Type.property` sites that cross-reference it. */
function referencedByIndex(reflection: GrammarReflection): Map<string, string[]> {
   const index = new Map<string, string[]>();
   for (const type of reflection.types) {
      for (const property of type.properties) {
         if (property.referenceType !== undefined) {
            const sites = index.get(property.referenceType) ?? [];
            sites.push(`${type.name}.${property.name}`);
            index.set(property.referenceType, sites);
         }
      }
   }
   return index;
}

/** One type's detail section — extends / subtypes / referenced-by / property table. */
function typeSection(type: TypeReflection, known: ReadonlySet<string>, referencedBy: readonly string[]): string[] {
   const lines: string[] = [`### ${type.name}`, ''];
   if (type.superTypes.length) {
      lines.push(`- Extends: ${type.superTypes.map(name => typeLink(name, known)).join(', ')}`);
   }
   if (type.directSubTypes.length) {
      lines.push(`- Known subtypes: ${type.directSubTypes.map(name => typeLink(name, known)).join(', ')}`);
   }
   if (referencedBy.length) {
      // The reverse index is keyed by type, so each `Owner.property` site links to Owner's section.
      const links = referencedBy.map(site => {
         const owner = site.slice(0, site.indexOf('.'));
         return `${typeLink(owner, known)}.${site.slice(site.indexOf('.') + 1)}`;
      });
      lines.push(`- Referenced by: ${links.join(', ')}`);
   }
   lines.push('');
   if (type.properties.length) {
      lines.push('| Property | Kind | Target | Array |', '| --- | --- | --- | --- |');
      for (const property of type.properties) {
         const isReference = property.referenceType !== undefined;
         const target = isReference ? typeLink(property.referenceType!, known) : '';
         lines.push(`| ${cell(property.name)} | ${isReference ? 'reference' : 'value'} | ${target} | ${property.array ? 'yes' : ''} |`);
      }
   } else {
      lines.push('_No properties._');
   }
   lines.push('');
   return lines;
}

/**
 * Render a grammar reflection as a navigable Markdown model reference for adopter
 * docs: a per-language grammar summary, an anchor-linked type index, and a per-type
 * section with cross-linked super/sub types, a reverse "referenced by" index, and a
 * property table. Distinct from `reflect`'s flat dump — this is the publishable
 * reference (cross-linked, navigable), whereas `reflect --json` is the machine form.
 */
export function formatModelDocs(reflection: GrammarReflection): string {
   const known = new Set(reflection.types.map(type => type.name));
   const referencedBy = referencedByIndex(reflection);
   const typeSections = reflection.types.flatMap(type => typeSection(type, known, referencedBy.get(type.name) ?? []));
   return [
      '# Model reference',
      '',
      'Generated from the grammar reflection. One section per AST node type.',
      '',
      ...languageSection(reflection),
      ...typeIndexSection(reflection),
      '## Type details',
      '',
      ...typeSections
   ].join('\n');
}
