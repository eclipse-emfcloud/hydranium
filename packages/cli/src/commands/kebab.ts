/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Kebab-case a PascalCase/camelCase name. Shared by `init`, which derives a
 * grammar's id from it, and the languages emitter, whose constant names have
 * to split a grammar name the same way.
 */
export function kebab(name: string): string {
   return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
