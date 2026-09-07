/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstReflection } from '@hydranium/langium';

/**
 * Whether `(type, property)` declares a Langium cross-reference. Driven by the
 * generated AST reflection metadata: a property is a reference when its
 * `propertyMetaData` carries a `referenceType`.
 *
 * Used by serializers to dispatch reference values (Langium `Reference` objects
 * or transfer-model plain string IDs) through reference-formatting paths
 * instead of generic value serialization.
 */
export function isReferenceProperty(reflection: AstReflection, type: string, property: string): boolean {
   const typeMetaData = reflection.getTypeMetaData(type);
   const propertyMetaData = typeMetaData.properties[property];
   return propertyMetaData !== undefined && 'referenceType' in propertyMetaData;
}

/**
 * Whether the given value equals the property's grammar-declared default. Used
 * to skip default-valued properties during serialization (smaller wire shape,
 * cleaner round-trip).
 *
 * Reads `defaultValue` from the Langium reflection metadata; values without a
 * declared default never compare equal here.
 */
export function isDefaultValue(reflection: AstReflection, type: string, property: string, value: unknown): boolean {
   const typeMetaData = reflection.getTypeMetaData(type);
   const propertyMetaData = typeMetaData.properties[property];
   const defaultValue = propertyMetaData?.defaultValue;
   return defaultValue !== undefined && value === defaultValue;
}
