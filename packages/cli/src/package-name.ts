/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { toPascal } from '@hydranium/protocol';

/**
 * Validates against the npm package-name grammar (scoped or unscoped,
 * lowercase, etc.).
 *
 * Published on this barrel with no caller inside the framework: it is
 * scaffolding vocabulary for a generator that composes package names of its
 * own, which is a job an adopter does in its own repository. It lives on the
 * CLI rather than on the wire-contract package because a package name has no
 * wire meaning and a client bundle should not carry the pattern.
 */
export const NPM_PACKAGE_NAME_REGEX = /^(?:(?:@(?:[a-z0-9-*~][a-z0-9-*._~]*)?\/[a-z0-9-._~])|[a-z0-9-~])[a-z0-9-._~]*$/;

/**
 * Convert an npm package name to a Pascal-case identifier. The optional scope
 * prefix is dropped; remaining segments separated by `-`, `.`, or `~` are
 * Pascal-cased and concatenated.
 *
 * `'@my-org/foo-bar'` → `'FooBar'`
 *
 * The inverse direction of the `kebab` derivation the scaffolder itself runs:
 * that one starts from a PascalCase project name and produces the package id,
 * this one recovers an identifier from a package name that already exists.
 * Same outside-reader constraint as {@link NPM_PACKAGE_NAME_REGEX}.
 */
export function packageNameToId(input: string): string {
   const unscoped = input.split('/').at(-1)!;
   return unscoped.split(/[~.-]/).map(toPascal).join('');
}
