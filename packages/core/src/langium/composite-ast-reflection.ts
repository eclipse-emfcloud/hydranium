/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractAstReflection, type AstMetaData, type AstReflection, type PropertyMetaData, type TypeMetaData } from '@hydranium/langium';

/**
 * One `AstReflection` over the reflections of separately generated language
 * packages. The shared `AstReflection` slot holds a single reflection, so
 * binding each package's generated shared module keeps only the last one's
 * types; bind this over all of them instead.
 *
 * A name several reflections share is taken to be one type, reached through a
 * shared imported grammar, and keeps every super type any of them gives it:
 * each grammar may declare its own union over the type. Only properties that
 * differ in name, reference type or default value throw; two unrelated unions,
 * or same-shaped interfaces, that share a name merge silently, so keep other
 * type names distinct across packages.
 *
 * Only each reflection's `types` is read, so behaviour a reflection overrides
 * is lost. Each package's generated `isX` guards keep using that package's own
 * reflection and answer false for subtypes only another package declares.
 *
 * The protected merge methods run from the constructor, so an override cannot
 * read its own class's fields.
 */
export class CompositeAstReflection extends AbstractAstReflection {
   override readonly types: AstMetaData = {};

   constructor(reflections: readonly AstReflection[]) {
      super();
      const firstDefinedAt = new Map<string, number>();
      reflections.forEach((reflection, index) => {
         for (const [type, metaData] of Object.entries(reflection.types)) {
            const ownerIndex = firstDefinedAt.get(type);
            if (ownerIndex === undefined) {
               this.types[type] = metaData;
               firstDefinedAt.set(type, index);
            } else {
               this.types[type] = this.mergeTypeMetaData(
                  this.types[type],
                  metaData,
                  this.formatReflection(reflections, ownerIndex),
                  this.formatReflection(reflections, index)
               );
            }
         }
      });
   }

   protected mergeTypeMetaData(known: TypeMetaData, added: TypeMetaData, knownFrom: string, addedFrom: string): TypeMetaData {
      const properties: TypeMetaData['properties'] = {};
      const propertyNames = new Set([...Object.keys(known.properties), ...Object.keys(added.properties)]);
      for (const property of propertyNames) {
         const knownProperty = known.properties[property];
         const addedProperty = added.properties[property];
         if (!knownProperty || !addedProperty || !this.sameProperty(knownProperty, addedProperty)) {
            throw new Error(
               `[hydranium] ${knownFrom} and ${addedFrom} define the type ` +
                  `'${known.name}' differently (property '${property}'). A name the composed reflections share must ` +
                  'denote one type, so rename one of them, or have every grammar take the type unchanged from one ' +
                  'shared imported grammar.'
            );
         }
         properties[property] = addedProperty.optional && !knownProperty.optional ? addedProperty : knownProperty;
      }
      // `Required` so a field Langium adds fails compilation until this merge decides on it.
      const merged: Required<TypeMetaData> = {
         name: known.name,
         properties,
         superTypes: [...new Set([...known.superTypes, ...added.superTypes])]
      };
      return merged;
   }

   protected sameProperty(left: PropertyMetaData, right: PropertyMetaData): boolean {
      return COMPARED_PROPERTY_FIELDS.every(field => JSON.stringify(left[field]) === JSON.stringify(right[field]));
   }

   /**
    * Names `reflections[index]` for the clash error: its position and class
    * name. The position is needed because minified bundles and scaffolds
    * sharing a project name leave class names that do not tell reflections
    * apart. An override can name the package each reflection came from.
    */
   protected formatReflection(reflections: readonly AstReflection[], index: number): string {
      return `reflections[${index}] (${reflections[index].constructor.name})`;
   }
}

/** How the merge treats each property field; a field Langium adds fails compilation here until decided. */
const PROPERTY_FIELDS = {
   name: 'compared',
   referenceType: 'compared',
   defaultValue: 'compared',
   // Older generators emit no `optional`, so its absence proves nothing.
   optional: 'merged'
} as const satisfies Record<keyof PropertyMetaData, 'compared' | 'merged'>;

const COMPARED_PROPERTY_FIELDS = (Object.keys(PROPERTY_FIELDS) as Array<keyof PropertyMetaData>).filter(
   field => PROPERTY_FIELDS[field] === 'compared'
);
