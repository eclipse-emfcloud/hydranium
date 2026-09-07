/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { AstReflection, TypeMetaData } from '@hydranium/langium';

/** Per-property metadata a {@link makeFakeReflection} type map may declare. */
export interface FakeReflectionProperty {
   defaultValue?: unknown;
   referenceType?: string;
}

/**
 * Build a minimal {@link AstReflection} for serializer / encoder tests.
 *
 * Only `getTypeMetaData(type).properties[prop]` — with the optional
 * `defaultValue` / `referenceType` the serialization utilities read — is
 * populated; every other reflection member is absent, so an accidental new
 * dependency throws loudly rather than silently returning `undefined`. Pass a
 * `type -> property -> metadata` map.
 *
 * The single unavoidable cast (an object literal can't structurally satisfy the
 * generated `AstReflection` interface) is encapsulated here so call sites stay
 * cast-free — the reflection sibling of `makeFakeAstNode`.
 */
export function makeFakeReflection(types: Record<string, Record<string, FakeReflectionProperty>>): AstReflection {
   return {
      getTypeMetaData: (type: string): TypeMetaData =>
         ({
            name: type,
            properties: types[type] ?? {}
         }) as unknown as TypeMetaData
   } as unknown as AstReflection;
}
