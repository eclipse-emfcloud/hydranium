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
 * A reference-picker query for an element that does not exist yet, plus the
 * candidate the adopter expects it to offer.
 *
 * **The URI a create-element flow holds is a FOLDER**, because the file is not
 * written until the dialog is confirmed. A folder URI names no file and so
 * carries no extension, which is the one shape a head cannot route to a grammar
 * by URI alone — it has to resolve the language some other way. That makes this
 * the create dialog's load-bearing precondition and the reason the query is
 * worth a conformance check of its own: a head that gets it wrong answers no
 * candidates or throws, and the dialog never opens.
 */
export interface ReferenceQuerySpec {
   /** AST type of the element being created — the synthetic source's own type. */
   readonly type: string;
   /** The reference property on the source (or on `syntheticPath`'s leaf) whose candidates the picker fills. */
   readonly property: string;
   /**
    * Steps from the synthetic source down to the node holding `property`, when
    * the reference is not on the source itself. Each step is
    * `[containerProperty, type]` — the kit builds the `SyntheticStep`s, so the
    * fixture names no protocol type.
    */
   readonly path?: ReadonlyArray<readonly [containerProperty: string, type: string]>;
   /**
    * Folder the create flow asks at. {@link Deferred} because a fixture may name
    * a workspace the driver's `connect` only just created. Defaults to the parent
    * of `valid.uri`, which is the folder a sibling of the valid model would go
    * into — the common case, so most fixtures supply only `type` + `property`.
    */
   readonly folderUri?: Deferred<string>;
   /**
    * A candidate label the query MUST offer. Without it an empty result passes,
    * and empty is exactly what the defect this check exists for produces — so
    * the expectation is what makes the check discriminating rather than a
    * smoke test.
    */
   readonly expectCandidate: string;
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
 * - `referenceQuery` — read by the **data slice only**, and only when the
 *   driver supplies `references` (the reference surface is opt-in on the head
 *   too, so both halves have to be present for the check to run).
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
   /**
    * Optional: the create-dialog reference query. Read by the **data slice
    * only**, and only when the driver exposes the opt-in reference surface.
    */
   readonly referenceQuery?: ReferenceQuerySpec;
   /**
    * Optional: a locale plus the sentence the server must publish in it. Read
    * by the **LSP slice only**.
    */
   readonly renderedDiagnostic?: RenderedDiagnosticSpec;
}

/**
 * A locale, and one sentence the server must produce in it for the `invalid`
 * fixture.
 *
 * **Opt-in, and it has to be.** The framework ships no catalogue and selects no
 * locale, so a server that installs no renderer correctly publishes English —
 * mandating this check would fail every adopter without i18n for doing the right
 * thing. Supplying the field is the adopter saying "I render server-side, hold me
 * to it".
 *
 * `expected` is a SUBSTRING, not the whole message. The kit owns no grammar, so
 * it cannot know how many diagnostics `invalid` produces or in what order, and
 * an adopter should be able to pin the translated fragment without restating a
 * sentence they may reword. A substring long enough to be wrong if the render
 * did not happen is the whole requirement.
 *
 * `absentWithoutLocale` is what makes the check a pair rather than a single
 * assertion: "the message contains X" also passes for a server whose English
 * happens to contain X, and for one that renders regardless of locale. Naming
 * the fragment that must DISAPPEAR when no locale is declared is what
 * distinguishes those.
 */
export interface RenderedDiagnosticSpec {
   /** The locale to declare at `initialize` — the tag whose catalogue the server has. */
   readonly locale: string;
   /** A fragment of the translated sentence, present in some diagnostic of the `invalid` fixture. */
   readonly expected: string;
   /**
    * A fragment that must be absent once `locale` is declared, and present
    * without it — normally a piece of the server's own English.
    *
    * Optional only because a catalogue may translate a message whose English
    * shares no distinctive fragment with it. Omitting it drops the second half
    * of the pair and leaves a check that a render-nothing server can pass; the
    * kit reports that rather than pretending otherwise.
    */
   readonly absentWithLocale?: string;
}
