/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Branded URI-string types distinguishing the framework's two document-identity
 * spaces. Both are `string` at runtime — the brand is a phantom field, erased by
 * the compiler, so there is zero runtime cost and the values pass freely to any
 * `string` sink (`UriUtils`, RPC payloads, logs). At compile time they are
 * **nominally distinct and mutually non-assignable**, so one cannot be used
 * where the other is expected.
 *
 * - {@link CanonicalUri} — *server-identity* space: the single canonical key a
 *   document is stored under (`LangiumDocuments` keying, AST-document event
 *   filters, request-path lookups). Minted ONLY by
 *   `DocumentUriPolicy.canonicalUri` — the single point that defines what
 *   "canonical" means, so every `CanonicalUri` has provable provenance.
 * - {@link LanguageClientUri} — the URI the LSP *textual* language client
 *   (Monaco / VS Code) actually opened a document under, which may differ from
 *   its canonical identity (e.g. a symlinked path while the document is keyed by
 *   its real path). This is the URI `applyEditToLanguageClient` and diagnostics must
 *   address. Named for the *language client* specifically — the GLSP and
 *   data-server heads are also clients, but they are addressed canonically.
 *
 * Why both are real brands rather than aliases: a plain `type X = string` is
 * assignable to and from any `string` (and a `CanonicalUri` *is* a `string`), so
 * an alias would let a canonical URI flow into a language-client sink unchecked —
 * exactly the class of bug where an outbound sync addressed the client by the
 * canonical URI it never opened. The distinct `__uriSpace` discriminants make
 * that a compile error, and make plain `string` assignable to neither — forcing
 * values through a mint point.
 *
 * Scope: these are an **internal** server-identity discipline. RPC/wire fields
 * and public service parameters stay plain `string` so the brands never leak to
 * adopters or across the wire; conversion happens at the framework boundary.
 */
export type CanonicalUri = string & { readonly __uriSpace: 'canonical' };

/** The LSP textual language client's document URI. See {@link CanonicalUri} for the full rationale. */
export type LanguageClientUri = string & { readonly __uriSpace: 'languageClient' };

/**
 * Mint a {@link CanonicalUri}. The single sanctioned place the brand assertion
 * lives — call this from the one component that defines canonicalisation
 * (`DocumentUriPolicy.canonicalUri`) instead of scattering `as CanonicalUri`
 * casts, so a call site reads as a deliberate identity mint rather than an
 * escape hatch.
 */
export const asCanonicalUri = (value: string): CanonicalUri => value as CanonicalUri;

/**
 * Mint a {@link LanguageClientUri}. The single sanctioned place the brand
 * assertion lives — call this from the component that owns the language-client
 * URI space (the text store's `toLanguageClientUri`). See {@link asCanonicalUri}.
 */
export const asLanguageClientUri = (value: string): LanguageClientUri => value as LanguageClientUri;
