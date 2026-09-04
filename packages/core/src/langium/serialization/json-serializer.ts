/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { isPromiseLike, type MaybePromise, type TransferElement } from '@hydranium/protocol';
import { type AstNode, type GenericAstNode } from '@hydranium/langium';
import { type HydraniumLanguageServices } from '../language-module.js';
import { AbstractSerializer, type AbstractSerializerOptions } from './abstract-serializer.js';

/**
 * Options for {@link JsonSerializer}. Extends the format-agnostic
 * {@link AbstractSerializerOptions} with JSON-specific style settings.
 */
export interface JsonSerializerOptions extends AbstractSerializerOptions {
   /**
    * Indentation policy:
    * - a number — spaces per level (default 2)
    * - `'tab'` — single tab character per level
    * - `false` — compact output, no newlines or indent whitespace
    */
   readonly indent?: number | 'tab' | false;
   /**
    * How to encode cross-references in the output:
    * - `'object-wrapper'` (default) — emit as `{ "$ref": "<id>" }`. Disambiguates
    *   references from plain string values without requiring schema knowledge
    *   on the consumer.
    * - `'string'` — emit as a bare string value: `"<id>"`. Consumer must know
    *   from a schema or other context which properties are references.
    */
   readonly referenceEncoding?: 'object-wrapper' | 'string';
}

/**
 * Hand-written grammar-aware AST → JSON serializer.
 *
 * Sibling of `YamlSerializer` sharing the
 * format-agnostic dispatch in {@link AbstractSerializer}. Use cases:
 *
 * - Deterministic test snapshots — no YAML whitespace ambiguity.
 * - Alternative wire format for the model-server RPC — smaller payload,
 *   faster client parse via native `JSON.parse`.
 * - Debug dumps of AST or transfer-model trees.
 *
 * The grammar-side defaults (property order, references-as-objects flag)
 * and the format-style options (indent, reference encoding) are tuned
 * independently — the same `propertyOrder` map used by a YAML serializer
 * drives the property layout of the JSON output.
 *
 * **Note on `unquotedProperties` (YAML)**: JSON cannot emit bare string
 * values, so the equivalent YAML notion does not exist here. Grammar
 * terminals that YAML serializes unquoted (e.g. `kind: one-to-many`) become
 * quoted JSON strings (`"kind": "one-to-many"`).
 */
export class JsonSerializer<TAst extends AstNode = AstNode, TTransfer extends TransferElement = TransferElement> extends AbstractSerializer<
   TAst,
   TTransfer
> {
   /** Default spaces per indentation level when `indent` is omitted. */
   static readonly DEFAULT_INDENT = 2;
   /** Default reference encoding when `referenceEncoding` is omitted. */
   static readonly DEFAULT_REFERENCE_ENCODING = 'object-wrapper' as const;

   /** Narrows the inherited {@link AbstractSerializer.options} field to the JSON-specific shape. */
   declare protected readonly options: JsonSerializerOptions;

   protected readonly compact: boolean;
   protected readonly indentUnit: string;
   protected readonly referenceEncoding: 'object-wrapper' | 'string';

   constructor(services: HydraniumLanguageServices, options: JsonSerializerOptions = {}) {
      super(services, options);
      const indent = options.indent ?? JsonSerializer.DEFAULT_INDENT;
      this.compact = indent === false;
      this.indentUnit = indent === false ? '' : indent === 'tab' ? '\t' : ' '.repeat(indent);
      this.referenceEncoding = options.referenceEncoding ?? JsonSerializer.DEFAULT_REFERENCE_ENCODING;
   }

   /**
    * Serialize an AST or transfer-model node as a JSON object. Properties are
    * emitted in grammar-declared order ({@link getOrderedPropertyNames}); empty
    * or default-valued properties are skipped per the shared
    * {@link shouldSkipProperty} rules.
    *
    * @param _isArrayElement unused — JSON does not need the YAML
    *        `- ` alignment hint; nested objects nest the same way regardless
    *        of array context.
    */
   protected override serializeNode(
      node: AstNode | Record<string, unknown>,
      indentationLevel: number,
      _isArrayElement = false
   ): MaybePromise<string> {
      const nodeType = (node as AstNode).$type;
      const propNames = this.getOrderedPropertyNames(node, nodeType);
      return this.collectObjectEntries(node, nodeType, propNames, indentationLevel, [], 0);
   }

   /**
    * Iterate `propNames` from `startIndex`, serialise each property, and
    * accumulate the resulting JSON object entries. Stays on the sync fast
    * path while every {@link serializePropertyValue} returns a string; the
    * moment one returns a Promise, switches to a `.then`-chained tail. Keeps
    * the all-sync case Promise-free even though the declared return type is
    * the union.
    */
   protected collectObjectEntries(
      node: AstNode | Record<string, unknown>,
      nodeType: string,
      propNames: readonly string[],
      indentationLevel: number,
      entries: (readonly [string, string])[],
      startIndex: number
   ): MaybePromise<string> {
      for (let i = startIndex; i < propNames.length; i++) {
         const prop = propNames[i];
         const propValue = (node as GenericAstNode)[prop];
         if (this.shouldSkipProperty(nodeType, prop, propValue)) {
            continue;
         }
         const maybe = this.serializePropertyValue(nodeType, prop, propValue, indentationLevel + 1);
         if (isPromiseLike(maybe)) {
            const resumeAt = i + 1;
            return maybe.then(serialized => {
               if (serialized !== undefined) {
                  entries.push([prop, serialized]);
               }
               return this.collectObjectEntries(node, nodeType, propNames, indentationLevel, entries, resumeAt);
            });
         }
         if (maybe !== undefined) {
            entries.push([prop, maybe]);
         }
      }
      if (entries.length === 0) {
         return '{}';
      }
      return this.composeObject(entries, indentationLevel);
   }

   /** Serialize an array of non-reference values as a JSON array. */
   protected override serializeArray(items: unknown[], nodeType: string, key: string, indentationLevel: number): MaybePromise<string> {
      return this.collectArrayElements(items, nodeType, key, indentationLevel, [], 0);
   }

   /** Same sync-or-async tail pattern as {@link collectObjectEntries}, for array elements. */
   protected collectArrayElements(
      items: unknown[],
      nodeType: string,
      key: string,
      indentationLevel: number,
      elements: string[],
      startIndex: number
   ): MaybePromise<string> {
      for (let i = startIndex; i < items.length; i++) {
         const item = items[i];
         if (item === undefined) {
            continue;
         }
         const maybe = this.serializePropertyValue(nodeType, key, item, indentationLevel + 1, /* isArrayElement */ true);
         if (isPromiseLike(maybe)) {
            const resumeAt = i + 1;
            return maybe.then(serialized => {
               if (serialized !== undefined) {
                  elements.push(serialized);
               }
               return this.collectArrayElements(items, nodeType, key, indentationLevel, elements, resumeAt);
            });
         }
         if (maybe !== undefined) {
            elements.push(maybe);
         }
      }
      return this.composeArray(elements, indentationLevel);
   }

   /** Serialize an array of reference values (Langium References or plain strings) as a JSON array. */
   protected override serializeReferenceArray(items: unknown[], indentationLevel: number): MaybePromise<string> {
      return this.collectReferenceArrayElements(items, indentationLevel, [], 0);
   }

   /** Same sync-or-async tail pattern as {@link collectArrayElements}, for reference-array elements. */
   protected collectReferenceArrayElements(
      items: unknown[],
      indentationLevel: number,
      elements: string[],
      startIndex: number
   ): MaybePromise<string> {
      for (let i = startIndex; i < items.length; i++) {
         const item = items[i];
         if (item === undefined) {
            continue;
         }
         const refText = this.serializeReferenceText(item);
         let maybe: MaybePromise<string> | undefined;
         if (refText !== undefined) {
            maybe = this.formatReferenceValue(refText);
         } else if (typeof item === 'string') {
            maybe = this.formatReferenceValue(item);
         }
         if (maybe === undefined) {
            continue;
         }
         if (isPromiseLike(maybe)) {
            const resumeAt = i + 1;
            return maybe.then(formatted => {
               elements.push(formatted);
               return this.collectReferenceArrayElements(items, indentationLevel, elements, resumeAt);
            });
         }
         elements.push(maybe);
      }
      return this.composeArray(elements, indentationLevel);
   }

   /**
    * Format a cross-reference value per {@link JsonSerializerOptions.referenceEncoding}.
    * Default is an object wrapper `{ "$ref": "<id>" }`; the alternative is a
    * bare string `"<id>"`. Subclasses may override for adopter-specific
    * encodings.
    */
   protected override formatReferenceValue(value: string): MaybePromise<string> {
      if (this.referenceEncoding === 'string') {
         return JSON.stringify(value);
      }
      if (this.compact) {
         return `{${JSON.stringify('$ref')}:${JSON.stringify(value)}}`;
      }
      return `{ ${JSON.stringify('$ref')}: ${JSON.stringify(value)} }`;
   }

   protected composeObject(entries: readonly (readonly [string, string])[], indentationLevel: number): string {
      const inner = this.indent(indentationLevel + 1);
      const outer = this.indent(indentationLevel);
      const kvSep = this.compact ? ':' : ': ';
      const entrySep = this.compact ? ',' : `,\n${inner}`;
      const open = this.compact ? '{' : `{\n${inner}`;
      const close = this.compact ? '}' : `\n${outer}}`;
      return open + entries.map(([key, value]) => `${JSON.stringify(key)}${kvSep}${value}`).join(entrySep) + close;
   }

   protected composeArray(elements: readonly string[], indentationLevel: number): string {
      if (elements.length === 0) {
         return '[]';
      }
      const inner = this.indent(indentationLevel + 1);
      const outer = this.indent(indentationLevel);
      if (this.compact) {
         return `[${elements.join(',')}]`;
      }
      return `[\n${inner}${elements.join(`,\n${inner}`)}\n${outer}]`;
   }

   protected indent(level: number): string {
      if (this.compact || this.indentUnit === '') {
         return '';
      }
      return this.indentUnit.repeat(level);
   }
}
