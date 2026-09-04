/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { isPromiseLike, type MaybePromise, type Tracer, type TransferElement } from '@hydranium/protocol';
import { type AstNode, type AstReflection, type GenericAstNode, isAstNode } from '@hydranium/langium';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type HydraniumLanguageServices } from '../language-module.js';
import { type Serializer } from './serializer.js';
import { isDefaultValue, isReferenceProperty } from './serialization-util.js';

/** A plain object exposing a `$refText` string — the wire-shape equivalent of a Langium `Reference`. */
interface RefTextObject {
   $refText: string;
}

function isRefTextObject(value: unknown): value is RefTextObject {
   return typeof value === 'object' && value !== null && '$refText' in value && typeof (value as RefTextObject).$refText === 'string';
}

/**
 * Format-agnostic options shared by all {@link AbstractSerializer} implementations.
 *
 * Each field captures a piece of language-specific knowledge the algorithm
 * cannot derive from grammar reflection alone. Format-specific subclasses
 * (YAML, JSON, …) extend this with their own style settings.
 *
 * `propertyOrder` is the load-bearing one: Langium's generated AST uses
 * interface-property order which doesn't match grammar-declaration order due
 * to inheritance, so consumers ship an explicit per-type order map.
 *
 * `reflection` is intentionally NOT on this options shape — the serializer
 * reads it from `services.shared.AstReflection` so adopters bind one
 * source of truth at the DI graph rather than passing the reflection
 * object explicitly. Keeping it off `AbstractSerializerOptions` matches the
 * wider `(services, options)` constructor convention.
 */
export interface AbstractSerializerOptions extends LogNameOptions {
   /**
    * Per-AST-type ordered list of property names, matching the grammar's
    * declaration order. Optional — when no entry exists for a given type,
    * the walker falls back to {@link Object.keys}(node), which yields the
    * AST node's own key order (in practice Langium's parser populates
    * properties in grammar-source order, so the fallback is usually
    * correct). Adopters who care about deterministic per-type ordering
    * — e.g. when augmenting the AST with extra fields the grammar didn't
    * place — supply the map; adopters without that concern omit it.
    */
   readonly propertyOrder?: ReadonlyMap<string, readonly string[]>;
   /**
    * AST types that exist to wrap a single cross-reference. Maps the
    * type name to the property holding the reference. The serializer emits
    * just the reference id, dropping the wrapper noise. Defaults to an empty
    * map — grammars without single-reference wrapper types omit this.
    *
    * A type may stay in this map even when it declares further optional
    * properties: the collapse only applies while every other property is
    * empty (see {@link AbstractSerializer.getReferenceWrapperProperty}), so
    * a wrapper that grows an optional property keeps its collapsed form for
    * existing documents and switches to a regular property block as soon as
    * the extra property carries a value.
    */
   readonly referenceWrapperTypes?: ReadonlyMap<string, string>;
   /**
    * Whether {@link AbstractSerializer.serializeAst} trims trailing whitespace
    * from the final output (leading whitespace is always trimmed). Defaults to
    * `true` — the conventional "no trailing blank lines" document shape. Set to
    * `false` for grammars whose values may legitimately END the document with
    * blank lines that must survive a round-trip — e.g. a multi-line block-scalar
    * property (see `YamlSerializerOptions.blockScalarProperties`),
    * where a trailing-trim would silently eat user-typed blank lines.
    */
   readonly trimTrailingWhitespace?: boolean;
}

/**
 * Abstract base for hand-written grammar-aware AST → text serializers.
 *
 * Langium ships no serializer ([discussion 683]; [discussion 863]) so
 * consumers roll their own. This class is the shared algorithm — a
 * property-by-property walk in grammar-declared order, dispatching each value
 * through type-aware paths (references, id properties, inline types,
 * reference-wrapper types, nested AST nodes, arrays, primitives).
 *
 * The same algorithm handles two value shapes uniformly:
 * - **AST mode** — direct Langium AST nodes with `Reference` objects.
 * - **Transfer-model mode** — structurally equivalent objects where references
 *   are plain string ids.
 *
 * Both shapes round-trip through {@link serializeReferenceText}, so consumers
 * don't need a separate serializer per mode — and that holds for a subclass
 * that replaces the generic walk with hand-written per-`$type` emitters, not
 * only for one that inherits it. Such an emitter calls
 * {@link serializeReferenceText} directly, so it is the single method that has
 * to understand both shapes; see its contract for why gating on
 * {@link isReferenceProperty} inside {@link serializePropertyValue} is what
 * makes that safe.
 *
 * Format-specific subclasses (`YamlSerializer`,
 * `JsonSerializer`) implement the abstract
 * methods to lay out the actual output text: how a node's properties are
 * composed into an object representation, how arrays are bracketed, and how
 * indentation is rendered.
 *
 * **Extension points** (override in a subclass):
 * - {@link serializeReferenceText} — extract the textual form of a
 *   cross-reference; defaults to the value's `$refText`.
 * - {@link formatReferenceValue} — format a cross-reference value for emission;
 *   defaults to `JSON.stringify`.
 * - {@link serializeCustomValue} — type-specific serialization for values
 *   that don't fit the generic paths. Runs after all reference detection, so
 *   references never reach this hook. Returns `undefined` to fall through to
 *   the default handling.
 *
 * [discussion 683]: https://github.com/langium/langium/discussions/683
 * [discussion 863]: https://github.com/langium/langium/discussions/863
 */
export abstract class AbstractSerializer<
   TAst extends AstNode = AstNode,
   TTransfer extends TransferElement = TransferElement
> implements Serializer<TAst, TTransfer> {
   protected readonly reflection: AstReflection;
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: HydraniumLanguageServices,
      protected readonly options: AbstractSerializerOptions = {}
   ) {
      this.reflection = services.shared.AstReflection;
      this.tracer = services.shared.Tracer.for(options.logName ?? this.constructor.name).trace('instantiated');
   }

   /**
    * Entry point for AST-shape inputs. Typically the grammar root, but any
    * AST node works — the walker is recursive and shape-agnostic.
    *
    * Preserves the sync fast path: when every subclass override and every
    * adopter hook is sync, the return is a bare `string` (no Promise
    * allocation, no microtask). The async branch fires only if at least one
    * recursive `serializeNode` call resolved to a Promise.
    */
   serializeAst(model: TAst): MaybePromise<string> {
      const result = this.serializeNode(model, 0);
      if (isPromiseLike(result)) {
         return result.then(text => this.trimSerialized(text));
      }
      return this.trimSerialized(result);
   }

   /**
    * Trim the final serialized output. Leading whitespace is always removed;
    * trailing whitespace is removed unless {@link AbstractSerializerOptions.trimTrailingWhitespace}
    * is `false` (which preserves document-ending blank lines, e.g. inside a block scalar).
    */
   protected trimSerialized(text: string | undefined): string {
      if (text === undefined) {
         return '';
      }
      return this.options.trimTrailingWhitespace === false ? text.trimStart() : text.trim();
   }

   /**
    * Entry point for transfer-model-shape inputs (cross-references as plain
    * string ids rather than `Reference` objects).
    * Typically the transfer root, but any transfer element works.
    *
    * Default delegates back to {@link serializeAst} because the property
    * walker is shape-agnostic — both shapes traverse the same
    * {@link serializePropertyValue} dispatch and resolve references through
    * the same {@link serializeReferenceText} read.
    * Adopters who need shape-specific formatting override this method
    * independently.
    *
    * The `as unknown as TAst` cast is honest: `TAst` and `TTransfer` are
    * independent narrowings of two different `AstNode`-rooted hierarchies, so
    * TS rightly refuses a direct narrowing. The walker reads only `$type` and
    * property values, so the runtime read does not depend on the assignment
    * being type-correct.
    */
   serializeTransfer(model: TTransfer): MaybePromise<string> {
      return this.serializeAst(model as unknown as TAst);
   }

   /**
    * Format-specific layout of an AST or transfer-model node's properties.
    * Subclasses iterate {@link getOrderedPropertyNames}, call
    * {@link serializePropertyValue} per property, and compose the results
    * into the format's object representation.
    *
    * Returns {@link MaybePromise} so subclasses may transparently await
    * async adopter hooks; the per-property loop in each subclass gates with
    * {@link isPromiseLike} so sync hooks skip the microtask per
    * iteration.
    *
    * @param isArrayElement when `true`, the caller is producing an array
    *        element — formats may use this to suppress leading indentation
    *        (YAML's `- ` prefix handles alignment).
    */
   protected abstract serializeNode(
      node: AstNode | Record<string, unknown>,
      indentationLevel: number,
      isArrayElement?: boolean
   ): MaybePromise<string>;

   /** Format-specific layout of an array of non-reference values. */
   protected abstract serializeArray(items: unknown[], nodeType: string, key: string, indentationLevel: number): MaybePromise<string>;

   /** Format-specific layout of an array of reference values (Langium References or plain strings). */
   protected abstract serializeReferenceArray(items: unknown[], indentationLevel: number): MaybePromise<string>;

   /**
    * Serialize a single property value. Dispatch order (first match wins):
    *
    * 1. `$`-prefixed keys are skipped (Langium internals — `$type`, `$container`, …).
    * 2. Reference-typed property (per grammar reflection): an array via
    *    {@link serializeReferenceArray}, otherwise a single reference via
    *    {@link serializeReferenceText} — which resolves an AST-mode Langium
    *    `Reference` and a transfer-mode plain string id alike.
    * 3. Reference-wrapper AST node — emitted as the wrapped reference id
    *    (only while the node's other properties are empty, see
    *    {@link getReferenceWrapperProperty}).
    * 4. {@link serializeCustomValue} hook — type-specific consumer overrides.
    * 5. Nested AST node — recurse into {@link serializeNode}.
    * 6. Array — element-by-element via {@link serializeArray}.
    * 7. Anything else — {@link formatPrimitive}.
    *
    * Reference detection (steps 2-3) runs before {@link serializeCustomValue}
    * so that references in either shape always route through
    * {@link formatReferenceValue}; the custom hook never has to defend against
    * them.
    *
    * **Reflection is consulted before the value is inspected**, and that order
    * is load-bearing: it is what lets {@link serializeReferenceText} accept a
    * bare transfer-mode id without a primitive string property such as `name`
    * being mistaken for a cross-reference. Inspecting the value first would
    * force the two shapes down two different code paths — and a hand-written
    * emitter, which has no `(nodeType, key)` pair to offer, could then only
    * reach the AST-mode one.
    *
    * Returns {@link MaybePromise} but does not `await` internally: each
    * dispatch branch either returns a sync value directly or returns the
    * recursive call's result verbatim. Callers (the subclass loops) gate
    * with {@link isPromiseLike} so sync values bypass the
    * microtask per iteration.
    *
    * @param isArrayElement when `true`, nested nodes do not indent their first
    *        property (the array element prefix handles alignment).
    */
   protected serializePropertyValue(
      nodeType: string,
      key: string,
      value: unknown,
      indentationLevel: number,
      isArrayElement = false
   ): MaybePromise<string | undefined> {
      if (key.startsWith('$')) {
         return undefined;
      }

      // Reference-typed properties (per grammar reflection), in EITHER shape: an
      // array of references, or a single reference resolved by
      // `serializeReferenceText`. Gating on reflection first is what lets that
      // method accept a bare transfer-mode id — it only ever sees values the
      // grammar declares a cross-reference, so a plain string property such as
      // `name` can never be mistaken for one.
      if (isReferenceProperty(this.reflection, nodeType, key)) {
         if (Array.isArray(value)) {
            return this.serializeReferenceArray(value, indentationLevel);
         }
         const reference = this.serializeReferenceText(value);
         if (reference !== undefined) {
            return this.formatReferenceValue(reference);
         }
      }

      // Reference wrapper types: a node that exists to wrap a reference, collapsed to the
      // bare reference id while its other properties are empty.
      if (isAstNode(value)) {
         const refProperty = this.getReferenceWrapperProperty(value);
         if (refProperty) {
            const propertyReference = this.serializeReferenceText((value as GenericAstNode)[refProperty]);
            if (propertyReference !== undefined) {
               return this.formatReferenceValue(propertyReference);
            }
         }
      }

      // Custom hook: type-specific consumer overrides (runs after reference detection).
      const custom = this.serializeCustomValue(nodeType, key, value, indentationLevel);
      if (custom !== undefined) {
         return custom;
      }

      // Nested AST node: recurse.
      if (isAstNode(value)) {
         return this.serializeNode(value, indentationLevel, isArrayElement);
      }

      // Arrays of non-reference values.
      if (Array.isArray(value)) {
         return this.serializeArray(value, nodeType, key, indentationLevel);
      }

      // Primitive values.
      return this.formatPrimitive(value);
   }

   /**
    * Render a cross-reference to the text the grammar accepts, in **either**
    * serialization shape:
    *
    * - **AST mode** — a Langium `Reference`, or any `{ $refText }` object.
    *   Langium's `isReference` additionally requires a resolved `ref`, but the
    *   emitted text is the same `$refText` either way, so the single
    *   {@link isRefTextObject} check covers both. Reading `$refText` rather
    *   than the resolved target is deliberate: an unresolvable reference then
    *   round-trips as the text the user typed instead of being dropped.
    * - **Transfer mode** — a plain string id, which the framework
    *   `TransferEncoder` emits for every cross-reference.
    *
    * Returns `undefined` only when the value is neither.
    *
    * **Call this only on values that ARE cross-references.** A bare string is
    * indistinguishable from a primitive string value, so this method trusts
    * its caller. The generic walker earns that trust by gating on
    * {@link isReferenceProperty} (see {@link serializePropertyValue}); a
    * hand-written per-`$type` emitter earns it by construction, because the
    * author calls this on a property they know the grammar declares a
    * reference. That is what makes ONE method correct for both the walker and
    * a custom concrete syntax.
    *
    * Override to apply an adopter-specific reference-text convention — e.g.
    * deriving text from the resolved target via the language's `NameProvider`
    * when `$refText` is empty. The default deliberately does not reach for the
    * `NameProvider`: a real Langium `Reference` always carries a `$refText`
    * string, so no fallback can fire on the common path.
    *
    * Distinct from `ReferenceBuilder.getReferenceName`, which *mints* the name
    * for a NEW reference from a source↔target relationship. This one *renders*
    * a reference that already exists.
    */
   protected serializeReferenceText(value: unknown): string | undefined {
      if (isRefTextObject(value)) {
         return value.$refText;
      }
      return typeof value === 'string' ? value : undefined;
   }

   /**
    * Whether a property should be skipped because it carries no meaningful
    * value: `undefined`, `null`, an empty array, a default value per grammar
    * reflection, or a blank string. Subclasses may override to widen or
    * narrow the skip policy.
    */
   protected shouldSkipProperty(nodeType: string, prop: string, value: unknown): boolean {
      if (value === undefined || value === null) {
         return true;
      }
      if (Array.isArray(value) && value.length === 0) {
         return true;
      }
      if (isDefaultValue(this.reflection, nodeType, prop, value)) {
         return true;
      }
      if (typeof value === 'string' && value.trim() === '') {
         return true;
      }
      return false;
   }

   /**
    * Resolve the property that collapses a reference-wrapper node
    * ({@link AbstractSerializerOptions.referenceWrapperTypes}) to its bare
    * reference id, or `undefined` when the node carries additional non-empty
    * GRAMMAR-DECLARED properties and must serialize as a regular nested node
    * instead — an unconditional collapse would silently drop those values.
    *
    * The scan reads the declared property names from grammar reflection, NOT
    * the node's own keys: transfer-model objects may carry synthesized
    * companion fields (display labels, derived projections) that never
    * persist, and counting those as "more" would break the collapse for
    * every wrapper that crosses the wire in an enriched projection.
    *
    * Emptiness is judged by {@link shouldSkipProperty} plus one
    * reference-specific rule: a reference object with a blank `$refText` is
    * an unset reference and counts as empty. The rule lives here rather than
    * in {@link shouldSkipProperty} so regular property emission is unchanged.
    *
    * Works on both value shapes — Langium AST nodes and transfer-model
    * objects (plain string reference ids).
    */
   protected getReferenceWrapperProperty(node: AstNode): string | undefined {
      const referenceProperty = this.options.referenceWrapperTypes?.get(node.$type);
      if (!referenceProperty) {
         return undefined;
      }
      const generic = node as GenericAstNode;
      const declaredProperties = Object.keys(this.reflection.getTypeMetaData(node.$type).properties);
      const carriesMore = declaredProperties.some(property => {
         if (property === referenceProperty) {
            return false;
         }
         const propertyValue = generic[property];
         if (isRefTextObject(propertyValue) && propertyValue.$refText.trim() === '') {
            return false;
         }
         return !this.shouldSkipProperty(node.$type, property, propertyValue);
      });
      return carriesMore ? undefined : referenceProperty;
   }

   /**
    * Per-type ordered property names. Resolves the configured
    * {@link AbstractSerializerOptions.propertyOrder} entry for `type`; falls back
    * to the node's own JS-key order ({@link Object.keys}) when no entry
    * exists. The walker filters `$`-prefixed keys downstream in
    * {@link serializePropertyValue}, so passing every own key here is safe.
    */
   protected getOrderedPropertyNames(node: AstNode | Record<string, unknown>, type: string): readonly string[] {
      return this.options.propertyOrder?.get(type) ?? Object.keys(node);
   }

   /**
    * Format a cross-reference value for emission. Defaults to `JSON.stringify`.
    * Override to apply language-specific reference quoting — e.g. an
    * id-reference formatter that mirrors the grammar's id convention.
    *
    * Returns {@link MaybePromise} so adopters with async formatting needs
    * (remote schema lookup, external canonical-id resolution) can return a
    * `Promise<string>`. Sync overrides remain valid.
    */
   protected formatReferenceValue(value: string): MaybePromise<string> {
      return JSON.stringify(value);
   }

   /**
    * Format a primitive value (string, number, boolean) for emission. Defaults
    * to `JSON.stringify`, which quotes strings, formats numbers/booleans, and
    * is valid both as a YAML scalar and a JSON value.
    *
    * Returns {@link MaybePromise} so adopters with async formatting needs
    * (e.g. delegating to `prettier.format` for a specific value class) can
    * return a `Promise<string>`.
    */
   protected formatPrimitive(value: unknown): MaybePromise<string> {
      return JSON.stringify(value);
   }

   /**
    * Hook for type-specific serialization that doesn't fit the generic
    * dispatch table. Runs after all reference detection (steps 2-4 of
    * {@link serializePropertyValue}) and before the nested-AST-node recurse,
    * so references never reach this hook and the override may key purely on
    * `(nodeType, key, value)`. Return `undefined` to fall through to the
    * default handling. Default: returns `undefined` for everything.
    *
    * The in-repo override is
    * `YamlSerializer`'s, which emits
    * grammar-declared unquoted terminals as bare strings.
    */
   protected serializeCustomValue(
      _nodeType: string,
      _key: string,
      _value: unknown,
      _indentationLevel: number
   ): MaybePromise<string | undefined> {
      return undefined;
   }
}
