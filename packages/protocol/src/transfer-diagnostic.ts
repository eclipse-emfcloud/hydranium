/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Generic, transport-friendly diagnostic shape used by the model-server protocol.
 *
 * The `element` path is a `/`-separated location string with `@` and `^` as index
 * and property separators, matching the conventions used by Langium's
 * `AstNodeLocator` service.
 */
export interface TransferDiagnostic {
   /**
    * Which stage produced it. Coarse by construction: only the two syntactic
    * stages are recognised by name and everything else — a framework integrity
    * rule, an adopter check, a linker failure — arrives as `validation-error`.
    * Use it to decide whether the document PARSED, not to identify a rule.
    */
   type: 'lexing-error' | 'parsing-error' | 'validation-error';
   /**
    * `AstNodeLocator`-style path to the offending node. **Empty string when the
    * diagnostic carries no location** — the framework's own validator decorates
    * every diagnostic, but a rebound one need not, and an empty path denotes
    * "unlocated" rather than the document root.
    */
   element: string;
   /**
    * Names the offending property when the diagnostic is about one; absent when
    * it is about the node as a whole. Append it to {@link element} with
    * `ELEMENT_PROPERTY_SEPARATOR` rather than by hand — `getPath` does exactly
    * that and handles the absent case.
    */
   property?: string;
   /**
    * Plain text, always. An LSP `MarkupContent` message is flattened on the way
    * out, so no markup survives the wire and a consumer must not try to render
    * it as rich text.
    */
   message: string;
   /**
    * Three levels against LSP's four: `Hint` and `Information` both arrive as
    * `info`, so a client cannot recover the distinction. Anything that is not
    * an error or a warning lands in `info`, including a diagnostic that carried
    * no severity at all.
    */
   severity: 'error' | 'warning' | 'info';
   /**
    * The diagnostic's own code where it has one, otherwise Langium's internal
    * code — which means it may simply restate {@link type} for a syntactic
    * error. Absent when neither exists, and not unique across languages, so it
    * is not usable as a rule identity on its own.
    */
   code?: number | string;
}

export namespace TransferDiagnostic {
   /** Path separator between AST nodes within an element location. */
   export const ELEMENT_SEGMENT_SEPARATOR = '/';
   /** Index separator within an array property segment. */
   export const ELEMENT_INDEX_SEPARATOR = '@';
   /** Property separator suffixing the element path with the offending property name. */
   export const ELEMENT_PROPERTY_SEPARATOR = '^';

   export function isError(diagnostic: TransferDiagnostic): boolean {
      return diagnostic.severity === 'error';
   }

   export function isParseError(diagnostic: TransferDiagnostic): boolean {
      return diagnostic.type === 'parsing-error';
   }

   export function getPath(diagnostic: TransferDiagnostic): string {
      return diagnostic.property ? `${diagnostic.element}${ELEMENT_PROPERTY_SEPARATOR}${diagnostic.property}` : diagnostic.element;
   }

   export function errors(diagnostics: TransferDiagnostic[]): TransferDiagnostic[] {
      return diagnostics.filter(isError);
   }

   export function hasErrors(diagnostics: TransferDiagnostic[]): boolean {
      return diagnostics.some(isError);
   }

   export function hasParseErrors(diagnostics: TransferDiagnostic[]): boolean {
      return diagnostics.some(isParseError);
   }
}
