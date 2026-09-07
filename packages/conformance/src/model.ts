/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A fixture value that may be given directly or DEFERRED to check time.
 *
 * Fixtures are written as literals at module load, but some values are not
 * knowable then. The driving case: a grammar whose valid model needs a
 * MANDATORY cross-document reference cannot be self-contained, so its URI has
 * to sit inside a booted workspace — and if the adopter wants pristine input
 * per check, the workspace root does not exist until `connect` runs. A thunk
 * moves the read to the point where it can succeed.
 *
 * Resolved once per check via {@link resolveModel}, never at suite-build time,
 * so a thunk may safely read state that `connect` just established. `languageId`
 * is deliberately NOT deferrable — it is read while building check titles, i.e.
 * before any driver exists.
 */
export type Deferred<T> = T | (() => T);

/**
 * A single model document an adopter supplies to the conformance kit: a URI,
 * the language id the server registered the grammar under, and the model
 * text. Head-agnostic — the SAME `valid` / `invalid` pair feeds the
 * data-server slice (in the RPC envelope) and the LSP slice (over the
 * `didOpen` wire); no head's wire types appear here.
 *
 * `uri` and `text` accept a {@link Deferred} thunk; `languageId` does not (see
 * there for why). Read through {@link resolveModel} rather than field-by-field,
 * so one check sees one consistent set of values.
 */
export interface ConformanceModel {
   readonly uri: Deferred<string>;
   readonly languageId: string;
   readonly text: Deferred<string>;
}

/** A {@link ConformanceModel} with every {@link Deferred} field already read. */
export interface ResolvedConformanceModel {
   readonly uri: string;
   readonly languageId: string;
   readonly text: string;
}

/** Read a possibly-deferred fixture value. */
export function resolveDeferred<T>(value: Deferred<T>): T {
   return typeof value === 'function' ? (value as () => T)() : value;
}

/**
 * Read a fixture model's deferred fields, ONCE, at the top of a check body.
 *
 * Resolving the whole model rather than each field at its use site is the point:
 * a thunk may legitimately return a different value on a later check (that is
 * what makes per-check pristine input possible), so a check that re-read `uri`
 * mid-body could act on two different documents.
 */
export function resolveModel(model: ConformanceModel): ResolvedConformanceModel {
   return {
      uri: resolveDeferred(model.uri),
      languageId: model.languageId,
      text: resolveDeferred(model.text)
   };
}

/**
 * An edit applied to a fixture's document, plus the adopter's grammar-aware
 * assertion that the edit took effect. `to` is the replacement model text;
 * `expect` receives the post-edit transfer/AST root (typed `unknown` because
 * the kit owns no grammar) and returns whether the edit is observable — only
 * the adopter knows what "the edit landed" means for its grammar.
 */
export interface EditSpec {
   /** Replacement model text; {@link Deferred} for the same reasons as `ConformanceModel.text`. */
   readonly to: Deferred<string>;
   readonly expect: (root: unknown) => boolean;
}

/**
 * The per-language fixture. `valid` and `invalid` are defined once and reused
 * across heads; the two extras are per-head opt-ins.
 *
 * Requiring BOTH a valid and an invalid model is the false-green guard — a
 * vacuous "invalid" model that actually parses clean fails the diagnostics
 * checks rather than passing silently.
 *
 * **Which slice reads which field.** The type cannot express this, so it is
 * stated here:
 *
 * - `valid` / `invalid` — read by every slice.
 * - `edit` — read by the **data slice only**. The LSP slice's didChange check
 *   uses `invalid.text` and never calls `edit.expect`, so an LSP-only adopter
 *   has nothing to supply here.
 * - `completionPosition` — read by the **LSP slice only**.
 *
 * Both extras are optional and their checks report *skipped* when absent,
 * rather than silently not running. Making either mandatory would defeat the
 * shared fixture: the head that ignores the field has to invent a value for it,
 * and the two heads' inventions drift apart until one fixture contradicts the
 * other. A required field that one head ignores does not produce a shared
 * fixture; it produces a misleading one.
 *
 * The GLSP fixture is separate (per-diagram-type, generic over the adopter
 * action type) — see `./glsp`.
 */
export interface LanguageFixture {
   readonly valid: ConformanceModel;
   readonly invalid: ConformanceModel;
   /**
    * Optional: an edit plus its observability assertion. The data slice's
    * round-trip and subscription-delivery checks run only when it is supplied.
    */
   readonly edit?: EditSpec;
   /** Optional: a position at which the LSP completion check requests completion. */
   readonly completionPosition?: { readonly line: number; readonly character: number };
}
