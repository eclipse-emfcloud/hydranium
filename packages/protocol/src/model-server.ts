/********************************************************************************
 * Copyright (c) 2023 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Generic model-server protocol types: lifecycle arguments, events, and
 * cross-reference shapes. Free of any specific grammar, AST type, or
 * language identifier — consumers parameterise the document/root types
 * over `TRoot`.
 */

import type { TransferClientArgs } from './model-service/args';
import type { ReferenceCandidate } from './model-service/reference-candidate';

// ---------------------------------------------------------------------------
// Client / server arguments
// ---------------------------------------------------------------------------

// `TransferClientArgs` / `TransferUpdateArgs` / `TransferSaveArgs` live in
// `./model-service/args.ts` and are re-exported by the main barrel via
// `./model-service`. The legacy LSP-style protocol (Open / Close / events)
// defined here only consumes them as a supertype.

/** Open a document on behalf of a client. */
export interface OpenModelArgs extends TransferClientArgs {
   /**
    * Overrides the language the URI's extension would resolve to. Supply it
    * only when the extension does not decide — an unregistered extension, or a
    * document being opened under a language other than its own. A wrong value
    * routes the document to the wrong grammar and it parses as garbage rather
    * than failing.
    */
   languageId?: string;
   /**
    * Seeds the shared version sequence, defaulting to `0`. Only the FIRST open
    * of a URI consumes it; after that the server owns the sequence and advances
    * it itself, so callers never fabricate later numbers.
    */
   version?: number;
   /**
    * Content to open the document with instead of reading the file. Absent
    * means read from the filesystem, which is the normal case.
    *
    * Honoured only on the first open of a URI: opening an already-open document
    * is a no-op, so passing `text` for one silently changes nothing. Write
    * through the update path instead.
    */
   text?: string;
}

/** Close a previously-opened document for the client. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CloseModelArgs extends TransferClientArgs {}

// ---------------------------------------------------------------------------
// Update / save events
// ---------------------------------------------------------------------------

export interface TransferUpdatedEvent<TDocument> {
   document: TDocument;
   sourceClientId: string;
   /** See `ModelDocumentUpdateReason` in `./data/events` for the canonical reason set + semantics. */
   reason: 'changed' | 'deleted' | 'rebuilt' | 'saved';
}

export interface TransferSavedEvent<TDocument> {
   /** The document as persisted — the state that reached disk, not the state at request time. */
   document: TDocument;
   /**
    * The client whose save produced this. Every co-editing client receives the
    * event including the originator, so a recipient compares it against its own
    * id to recognise its own echo; acting on that echo is how an update loop
    * starts.
    */
   sourceClientId: string;
}

// ---------------------------------------------------------------------------
// Cross-reference shapes
// ---------------------------------------------------------------------------

/**
 * The source-side address for a reference query: where the lookup is asked
 * from. One of three shapes — a {@link DocumentSource} (the root of a
 * document at the given URI), an {@link ElementSource} (an element resolved
 * by its qualified name), or a {@link SyntheticSource} (a transient
 * element that does not yet exist on disk, used during element-creation
 * flows).
 *
 * Construct via the {@link ReferenceSource} namespace factories
 * (`ReferenceSource.document(uri)` / `.element(name, type?)` /
 * `.synthetic(uri, type)`) rather than tag-field literals — the factories
 * surface the three variants via autocomplete and centralise any future
 * shape changes.
 */
export type ReferenceSource = DocumentSource | ElementSource | SyntheticSource;

/** A reference anchored at the root element of a document, identified by URI. */
export interface DocumentSource {
   uri: string;
}

/**
 * Narrow an unknown value to a {@link DocumentSource}. Not exclusive within
 * {@link ReferenceSource}: a {@link SyntheticSource} also carries `uri`, so
 * discriminating the union must try {@link isSyntheticSource} first.
 */
export function isDocumentSource(object: unknown): object is DocumentSource {
   return !!object && typeof object === 'object' && 'uri' in object && typeof object.uri === 'string';
}

/**
 * A reference to an element identified by its **qualified name**, optionally
 * narrowed by type.
 *
 * The name is the form a source-text writer would type — normally the
 * project-qualified name (see `NameProvider.getProjectQualifiedName`). It is
 * **not** rename-stable and is distinct from an element *key*: rename the
 * element and this address changes. Clients that need a handle surviving
 * renames address the element some other way; this shape addresses by name.
 */
export interface ElementSource {
   /**
    * The qualified name as a source-text writer would spell it — normally the
    * project-qualified form. Resolution is by exact match against the index, so
    * a partially-qualified or differently-cased spelling simply finds nothing
    * rather than falling back to a looser search.
    */
   name: string;
   /**
    * Disambiguates when one name is claimed by several AST types. Absent means
    * "any type", which for an ambiguous name resolves arbitrarily rather than
    * failing — pass it whenever the caller knows what it is addressing.
    */
   type?: string;
}

export function isElementSource(object: unknown): object is ElementSource {
   return !!object && typeof object === 'object' && 'name' in object && typeof object.name === 'string';
}

/** An element of a document that does not yet exist on disk — used during element creation flows. */
export interface SyntheticSource {
   /**
    * The document the element would belong to. That document must already be
    * LOADED — the default resolution takes its parse root as the synthetic
    * node's container and answers `undefined` when it is not, so a URI for a
    * file that exists on disk but was never opened resolves to nothing.
    */
   uri: string;
   /**
    * The AST type the element will have. Required here, unlike on an
    * {@link ElementSource}, because no node exists yet from which to infer it —
    * it is what scoping filters candidates against.
    */
   type: string;
}

export function isSyntheticSource(object: unknown): object is SyntheticSource {
   return (
      !!object &&
      typeof object === 'object' &&
      'uri' in object &&
      typeof object.uri === 'string' &&
      'type' in object &&
      typeof object.type === 'string'
   );
}

/**
 * Factory helpers for the {@link ReferenceSource} variants. Use instead of
 * tag-field literals so a future shape change lands in one place.
 */
export namespace ReferenceSource {
   export function document(uri: string): DocumentSource {
      return { uri };
   }
   export function element(name: string, type?: string): ElementSource {
      return { name, type };
   }
   export function synthetic(uri: string, type: string): SyntheticSource {
      return { uri, type };
   }
}

/**
 * One step in a synthetic navigation path from a {@link ReferenceSource}
 * toward the property whose references we want to query. Each step describes
 * a transient AST node that does not yet exist in the document — e.g. an
 * element being created via UI flow — and is spliced into the chain so the
 * scope provider sees the world *as if* the synthetic child were already
 * placed at that slot.
 *
 * The field names mirror Langium's `$type` / `$containerProperty` so adopter
 * callsites read consistently with AST-side code.
 *
 * Construct via {@link SyntheticStep.of} rather than a tag-field literal.
 */
export interface SyntheticStep {
   /**
    * The AST `$type` the spliced node claims. Scoping filters candidates
    * against it, so a type the grammar does not declare yields an empty scope
    * rather than an error.
    */
   type: string;
   /**
    * The containment slot on the parent step, or on the source for the first
    * step. It must name a real containment property of that parent: the walk
    * builds the node unconditionally, so a wrong slot produces a plausible node
    * in a place the grammar has no rule for, and the emptiness surfaces later
    * as "no candidates".
    */
   containerProperty: string;
   /**
    * Which element of an array-valued {@link containerProperty} the step
    * addresses. **Mandatory for an array slot** on the resolving read
    * (`ScopeProvider.resolveReferenceSource` given a whole context), which
    * stops rather than descend into the array itself; a scope query reads it
    * only as the stub's `$containerIndex`, since a fabricated node has no
    * siblings to sit between.
    *
    * Absent means the slot holds a single node. Naming an out-of-range element
    * resolves to nothing rather than failing.
    */
   index?: number;
}

/**
 * Narrow an unknown value to a {@link SyntheticStep} — for a consumer
 * validating a step that arrived over the wire. Framework code builds steps
 * through {@link SyntheticStep.of} and never needs the check, so the absent
 * in-repo caller is the seam working rather than unused surface.
 */
export function isSyntheticStep(object: unknown): object is SyntheticStep {
   return (
      !!object &&
      typeof object === 'object' &&
      'type' in object &&
      typeof object.type === 'string' &&
      'containerProperty' in object &&
      typeof object.containerProperty === 'string'
   );
}

export namespace SyntheticStep {
   /**
    * Construct a single {@link SyntheticStep} — "which slot of the parent, of
    * which AST type". Pass `index` to pin the step to an existing array
    * element instead of a transient synthetic node.
    */
   export function of(containerProperty: string, type: string, index?: number): SyntheticStep {
      return { containerProperty, type, index };
   }

   /**
    * Construct a sequence of {@link SyntheticStep}s from `(containerProperty,
    * type)` tuples. Convenience for 3+ step paths where repeating
    * `SyntheticStep.of(...)` per entry is visually noisy. For 1-2 step paths
    * the per-step factory typically reads more clearly.
    */
   export function chain(...steps: ReadonlyArray<Parameters<typeof of>>): SyntheticStep[] {
      return steps.map(step => of(...step));
   }
}

/**
 * Describes the question "what reachable elements are valid for this property
 * of this (possibly synthetic) source-side element?". The server resolves it
 * to a list of reference candidates ({@link ReferenceCandidate} in
 * `@hydranium/protocol/model-service`).
 *
 * Build via {@link ReferenceContext.builder} — the staged builder enforces
 * the `source -> path -> property` order at compile time.
 */
export interface ReferenceContext {
   /** Where the query originates — the source-side {@link ReferenceSource} the lookup is anchored at. */
   source: ReferenceSource;
   /**
    * Synthetic navigation path from the source toward the leaf whose
    * references we want. Each entry is a transient AST node spliced into
    * the navigation chain — useful for elements that are being created or
    * that cannot yet be identified canonically. Empty / absent for queries
    * whose source IS the leaf.
    */
   syntheticPath?: SyntheticStep[];
   /**
    * The property of the leaf element (final step in {@link syntheticPath},
    * or the source when the path is empty) whose reachable references we
    * want to retrieve.
    */
   property: string;
}

/**
 * Narrow a value to a {@link ReferenceContext}, discriminating it from a bare
 * {@link ReferenceSource}. No source variant carries either `source` or
 * `property`, so the pair is unambiguous — which is what lets one resolver
 * accept both an anchor and a whole context.
 */
export function isReferenceContext(object: unknown): object is ReferenceContext {
   return (
      !!object &&
      typeof object === 'object' &&
      'source' in object &&
      'property' in object &&
      typeof (object as ReferenceContext).property === 'string'
   );
}

/**
 * A concrete reference-resolution request: a {@link ReferenceContext} plus the
 * written value to resolve. Extending the context makes resolution literally
 * "the candidate query, narrowed to one value" — and a request carries a
 * `syntheticPath` for free, so a reference anchored at a nested synthetic
 * source resolves the same way it lists candidates.
 *
 * Build via {@link ReferenceRequest.builder} — same staged order as
 * {@link ReferenceContext.builder}, ending with a mandatory `value`.
 */
export interface ReferenceRequest extends ReferenceContext {
   /** The textual value (the `$refText`) of the reference we are resolving. */
   value: string;
}

// ---------------------------------------------------------------------------
// Staged builders for ReferenceContext / ReferenceRequest
// ---------------------------------------------------------------------------

/**
 * First builder stage: pick the {@link ReferenceSource} variant. Generic over
 * the stage that `property()` lands on, so the context and request builders
 * share the source/path stages and differ only at the terminal.
 */
export interface ReferenceSourceStage<TAfterProperty> {
   /** Anchor at the semantic root of a loaded document — a {@link DocumentSource}. */
   document(uri: string): ReferencePathStage<TAfterProperty>;
   /** Anchor at an element addressed by qualified name — an {@link ElementSource}. */
   element(name: string, type?: string): ReferencePathStage<TAfterProperty>;
   /** Anchor at an element that does not exist yet — a {@link SyntheticSource}. */
   synthetic(uri: string, type: string): ReferencePathStage<TAfterProperty>;
}

/**
 * Second builder stage: append synthetic {@link SyntheticStep}s (repeatable,
 * optional), then close on the leaf property. `step()` is unavailable after
 * `property()`, which enforces the `source -> path -> property` order.
 */
export interface ReferencePathStage<TAfterProperty> {
   /**
    * Append one {@link SyntheticStep}, outermost first, and return a new stage
    * carrying the extended path. The builder is persistent, so a stage held in
    * a variable is a reusable prefix: stepping off it twice builds two paths,
    * and neither can be changed afterwards by the other.
    */
   step(containerProperty: string, type: string, index?: number): ReferencePathStage<TAfterProperty>;
   /** Name the leaf property and close the builder. */
   property(property: string): TAfterProperty;
}

/** Context terminal — `property()` closed the chain; build the context. */
export interface ReferenceContextBuildStage {
   build(): ReferenceContext;
}

/** Request value stage — the value is mandatory before {@link ReferenceRequestBuildStage.build}. */
export interface ReferenceRequestValueStage {
   value(value: string): ReferenceRequestBuildStage;
}

/** Request terminal — build the request. */
export interface ReferenceRequestBuildStage {
   build(): ReferenceRequest;
}

/**
 * Shared builder engine for both reference builders. Accumulates the source
 * and the synthetic path, then hands the assembled {@link ReferenceContext} to
 * `onProperty`, which produces the builder-specific terminal stage.
 *
 * **Persistent, not accumulating.** Each `step()` returns a NEW stage over a
 * copied path, and `property()` copies again into the context it emits. A
 * mutable builder would make a held stage a shared cursor — two branches off it
 * would build one path between them, and two contexts built from it would alias
 * a single array that a later `step()` could still change underneath both.
 * Copying a path of two or three entries costs nothing next to a scope query.
 */
function referenceBuilder<TAfterProperty>(onProperty: (context: ReferenceContext) => TAfterProperty): ReferenceSourceStage<TAfterProperty> {
   const pathStageFor = (source: ReferenceSource, steps: readonly SyntheticStep[]): ReferencePathStage<TAfterProperty> => ({
      step(containerProperty, type, index) {
         return pathStageFor(source, [...steps, { containerProperty, type, index }]);
      },
      property(property) {
         return onProperty(steps.length > 0 ? { source, property, syntheticPath: [...steps] } : { source, property });
      }
   });
   return {
      document: uri => pathStageFor({ uri }, []),
      element: (name, type) => pathStageFor({ name, type }, []),
      synthetic: (uri, type) => pathStageFor({ uri, type }, [])
   };
}

export namespace ReferenceContext {
   /** Staged builder entry — `source -> path -> property -> build`. */
   export function builder(): ReferenceSourceStage<ReferenceContextBuildStage> {
      return referenceBuilder(context => ({ build: () => context }));
   }
}

export namespace ReferenceRequest {
   /** Staged builder entry — `source -> path -> property -> value -> build`. */
   export function builder(): ReferenceSourceStage<ReferenceRequestValueStage> {
      return referenceBuilder(context => ({
         value: (value: string) => ({ build: () => ({ ...context, value }) })
      }));
   }

   /**
    * Promote a {@link ReferenceContext} to a request using a selected
    * candidate's value — the find -> select -> resolve flow. The candidate
    * supplies only the value (it is target-side); the source / property /
    * synthetic path come from the context the candidates were listed for.
    * Accepts any {@link ReferenceCandidate} (a `ReferenceTarget` works too).
    */
   export function from(context: ReferenceContext, candidate: ReferenceCandidate): ReferenceRequest {
      return { ...context, value: candidate.value };
   }
}

/**
 * Naming tier for `findNextName`-style lookups — which uniqueness
 * scope a proposed name must be unique within. This is NOT the
 * name-qualification axis, which decides how a name is spelled; the two are
 * independent even though each spells two of its members `local` and
 * `project`, and conflating them reads as an argument to rename `tier`.
 *
 * - `'local'` — unique within the document (the document root is the
 *   uniqueness container).
 * - `'project'` — unique within the owning project's document-qualified
 *   namespace.
 * - `'public'` — unique within the project-qualified (cross-project)
 *   namespace.
 */
export type NameTier = 'local' | 'project' | 'public';

/** Arguments for a next-free-name lookup. */
export interface FindNextNameArgs {
   /**
    * Locates the document, and via its project the qualification context. The
    * create-element flow is the main caller, so this may name a document that
    * does not exist yet; only the `'local'` tier needs it to resolve to one.
    */
   uri: string;
   /**
    * The AST `$type` of the element being named. Collisions are only looked for
    * among elements of that same type, so the returned name may still be taken
    * by an element of another type.
    */
   type: string;
   /**
    * The desired base name, returned unchanged when it is already free and
    * otherwise used as the stem a suffix is appended to. Any occurrence of the
    * name separator is replaced first, so a proposal cannot smuggle in a
    * qualified name.
    */
   proposal: string;
   /**
    * Which uniqueness scope the returned name must be free in — how wide a net
    * to check for collisions. The result is always a bare own-name whatever the
    * tier; this never changes how the name is spelled. Defaults to `'project'`.
    * See {@link NameTier} for what each tier covers.
    */
   tier?: NameTier;
}
