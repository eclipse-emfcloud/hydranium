/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { URI, UriUtils } from 'langium';

/**
 * Namespace augmentation: extend Langium's `UriUtils` with framework
 * helpers, so the framework's URI utilities sit on the same namespace as
 * Langium's own rather than on a second surface adopters have to discover
 * separately.
 *
 * **Side-effect import.** This module mutates the runtime `UriUtils`
 * object. It is loaded by this package's entry point (`index.ts`), so
 * importing anything from `@hydranium/langium` — which every framework
 * package does — makes the augmented members visible process-wide. Code
 * that imports `UriUtils` from `langium` without ever loading the
 * framework sees only the stock surface, which is correct.
 *
 * **Rejected: plain exported `toUri` / `isAncestorOrEqual` functions.**
 * They would avoid the side-effect import, which can break under
 * tree-shaking or CJS interop, at the cost of the single-namespace
 * discovery above. Neither hazard reaches a framework consumer: Langium is
 * a non-optional dependency, so the chokepoint is always loaded in a real
 * composition, and type-only imports are erased.
 */
declare module 'langium' {
   namespace UriUtils {
      /**
       * Normalise a `URI | string` argument to a `URI`, so a public API
       * accepting both forms does not have to inline the coercion.
       */
      function toUri(value: URI | string): URI;

      /**
       * `true` when `ancestor` is the same file or a parent folder of
       * `descendant`. Both URIs must share scheme and authority for the
       * comparison to be meaningful — different schemes always return `false`.
       *
       * **vs. `UriUtils.contains`**: `contains(parent, child)` does the
       * same path-prefix check but **ignores scheme and authority** — a
       * `file:` URI can "contain" an `untitled:` URI. Use this stricter
       * variant when scheme correctness matters, and `contains` where
       * scheme equality is already implied by context.
       */
      function isAncestorOrEqual(ancestor: URI, descendant: URI): boolean;
   }
}

function toUri(value: URI | string): URI {
   return typeof value === 'string' ? URI.parse(value) : value;
}

function isAncestorOrEqual(ancestor: URI, descendant: URI): boolean {
   if (ancestor.scheme !== descendant.scheme || ancestor.authority !== descendant.authority) {
      return false;
   }
   const ancestorPath = ancestor.fsPath;
   const descendantPath = descendant.fsPath;
   if (descendantPath === ancestorPath) {
      return true;
   }
   const trailing = ancestorPath.endsWith('/') || ancestorPath.endsWith('\\');
   const prefix = trailing ? ancestorPath : ancestorPath + '/';
   return descendantPath.startsWith(prefix) || descendantPath.startsWith(ancestorPath + '\\');
}

// Runtime attachment. `UriUtils` is a namespace, so at runtime it is a plain
// object that accepts added properties; the cast only strips its declared
// shape, and the augmentation block above supplies the type-level merge.
(UriUtils as { toUri: typeof toUri; isAncestorOrEqual: typeof isAncestorOrEqual }).toUri = toUri;
(UriUtils as { toUri: typeof toUri; isAncestorOrEqual: typeof isAncestorOrEqual }).isAncestorOrEqual = isAncestorOrEqual;
