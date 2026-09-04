/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { isPromiseLike, type MaybePromise, type TransferElement } from '@hydranium/protocol';
import { type AstNode, type GenericAstNode, isAstNode } from '@hydranium/langium';
import { type HydraniumLanguageServices } from '../language-module.js';
import { AbstractSerializer, type AbstractSerializerOptions } from './abstract-serializer.js';

/**
 * Options for {@link YamlSerializer}. Extends the format-agnostic
 * {@link AbstractSerializerOptions} with YAML-specific style settings.
 */
export interface YamlSerializerOptions extends AbstractSerializerOptions {
   /**
    * Property paths (`"<TypeName>.<propertyName>"`) whose values should be
    * serialized without quotes. Required for grammar terminals that accept
    * unquoted enum-like values (e.g. cardinality keywords, type literals).
    * Defaults to an empty set — grammars without unquoted terminals omit this.
    */
   readonly unquotedProperties?: ReadonlySet<string>;
   /**
    * Properties whose **multi-line** string values serialize as a YAML literal
    * block scalar (`key: |` followed by the indented lines) instead of a single
    * quoted scalar. An entry is matched either as a qualified path
    * (`"<TypeName>.<propertyName>"`, for a property on one specific type) or as
    * a bare property name (`"<propertyName>"`, matching that property on any
    * node — use for a property declared on a shared interface, e.g. a
    * `description` carried by every named element). Single-line values for the
    * same properties serialize normally (quoted). Required for free-text
    * properties that legitimately span multiple lines (e.g. multi-line
    * expressions) and must round-trip through a block-scalar terminal.
    * Defaults to an empty set — grammars without such properties omit this.
    */
   readonly blockScalarProperties?: ReadonlySet<string>;
   /**
    * AST type names that should serialize on the same line as their parent
    * key (rather than as an indented YAML block). Use for thin wrapper types
    * whose own block structure adds noise. Defaults to an empty set —
    * grammars without inline-block types omit this.
    */
   readonly inlineSerializedTypes?: ReadonlySet<string>;
   /**
    * Newline character used between serialized lines. Defaults to `'\n'`.
    * Adopters emitting Windows line endings pass `'\r\n'`.
    */
   readonly newlineChar?: string;
   /**
    * Indentation character. Defaults to `' '` (space). Adopters with a
    * tab-indent house style pass `'\t'`.
    */
   readonly indentationChar?: string;
   /**
    * Number of {@link indentationChar} characters per indentation level.
    * Defaults to `2` (YAML community convention). Set to `4` for 4-space
    * indent.
    */
   readonly indentationAmount?: number;
   /**
    * Lookup table mapping `"<propertyName>.<valueType>"` → substitute YAML
    * keyword. Used when a grammar declares multiple keyword alternatives
    * for the same property (e.g. `element=FooElement |
    * element=BarElement`) and the emitted keyword needs
    * to switch based on the actual `$type` of the value. Defaults to an
    * empty map — grammars without alternative-keyword properties omit
    * this.
    */
   readonly typeSpecificKeywords?: ReadonlyMap<string, string>;
}

/**
 * Hand-written grammar-aware AST → YAML serializer.
 *
 * Implements the YAML-specific layout on top of {@link AbstractSerializer}: nodes
 * become `key: value` lines (2-space block indentation by default), nested
 * nodes go on a new line unless declared in `inlineSerializedTypes`, and
 * arrays render as `- item` block-style lists.
 *
 * The shared dispatch algorithm (reference detection, default-value skipping,
 * reference-wrapper collapsing, custom-value hook) lives in
 * {@link AbstractSerializer}. Consult that class for the format-agnostic extension
 * points. YAML's one addition is unquoted-terminal emission, handled by its
 * {@link serializeCustomValue} override driven by
 * {@link YamlSerializerOptions.unquotedProperties}.
 */
export class YamlSerializer<TAst extends AstNode = AstNode, TTransfer extends TransferElement = TransferElement> extends AbstractSerializer<
   TAst,
   TTransfer
> {
   /** Default {@link YamlSerializerOptions.newlineChar}. */
   static readonly DEFAULT_NEWLINE_CHAR = '\n';
   /** Default {@link YamlSerializerOptions.indentationChar}. */
   static readonly DEFAULT_INDENTATION_CHAR = ' ';
   /** Default {@link YamlSerializerOptions.indentationAmount}. */
   static readonly DEFAULT_INDENTATION_AMOUNT = 2;
   /** Default {@link YamlSerializerOptions.typeSpecificKeywords}: empty map (no dispatch). */
   static readonly DEFAULT_TYPE_SPECIFIC_KEYWORDS: ReadonlyMap<string, string> = new Map();

   /** Narrows the inherited {@link AbstractSerializer.options} field to the YAML-specific shape. */
   declare protected readonly options: YamlSerializerOptions;

   protected readonly newlineChar: string;
   protected readonly indentationChar: string;
   protected readonly indentationAmount: number;
   protected readonly typeSpecificKeywords: ReadonlyMap<string, string>;

   constructor(services: HydraniumLanguageServices, options: YamlSerializerOptions = {}) {
      super(services, options);
      this.newlineChar = options.newlineChar ?? YamlSerializer.DEFAULT_NEWLINE_CHAR;
      this.indentationChar = options.indentationChar ?? YamlSerializer.DEFAULT_INDENTATION_CHAR;
      this.indentationAmount = options.indentationAmount ?? YamlSerializer.DEFAULT_INDENTATION_AMOUNT;
      this.typeSpecificKeywords = options.typeSpecificKeywords ?? YamlSerializer.DEFAULT_TYPE_SPECIFIC_KEYWORDS;
   }

   /**
    * Serialize an AST or transfer-model node as a YAML block. Properties are
    * emitted in grammar-declared order ({@link getOrderedPropertyNames}); each
    * property is rendered as `key: value` either inline (scalars / inline
    * types) or with the value on the next line (nested blocks, arrays).
    *
    * @param isArrayElement when `true`, the first property is not indented
    *        (the array `- ` prefix handles alignment).
    */
   protected override serializeNode(
      node: AstNode | Record<string, unknown>,
      indentationLevel: number,
      isArrayElement = false
   ): MaybePromise<string> {
      const nodeType = (node as AstNode).$type;
      const propNames = this.getOrderedPropertyNames(node, nodeType);
      const state: { isFirst: boolean } = { isFirst: !isArrayElement };
      return this.collectNodeLines(node, nodeType, propNames, indentationLevel, state, [], 0);
   }

   /**
    * Iterate `propNames` from `startIndex`, serialise each property, and
    * accumulate the resulting YAML lines. Stays on the sync fast path while
    * every {@link serializePropertyValue} returns a string; the moment one
    * returns a Promise, switches to a `.then`-chained tail that resumes
    * iteration after the async value resolves. Keeps the all-sync case
    * Promise-free even though the method's declared return type is the union.
    */
   protected collectNodeLines(
      node: AstNode | Record<string, unknown>,
      nodeType: string,
      propNames: readonly string[],
      indentationLevel: number,
      state: { isFirst: boolean },
      lines: string[],
      startIndex: number
   ): MaybePromise<string> {
      for (let i = startIndex; i < propNames.length; i++) {
         const prop = propNames[i];
         const propValue = (node as GenericAstNode)[prop];
         if (this.shouldSkipProperty(nodeType, prop, propValue)) {
            continue;
         }
         // Arrays and non-inline objects start on a new line after the keyword.
         const onNewLine = Array.isArray(propValue) || (isAstNode(propValue) && !this.options.inlineSerializedTypes?.has(propValue.$type));
         // Pick the grammar keyword: when the value is an AST node and the property has
         // type-specific keyword alternatives (e.g. `element` → `fooElement`),
         // `getPropertyKeyword` consults the `YamlSerializerOptions.typeSpecificKeywords`
         // map. Adopters that need procedural logic instead of (or in addition to) the map
         // override the method.
         const valueType = isAstNode(propValue) ? propValue.$type : undefined;
         const keyword = this.getPropertyKeyword(prop, valueType);
         // Multi-line string for a declared block-scalar property: emit `key: |` plus the
         // indented content. The block content carries its own absolute indentation (one level
         // deeper than the key), computed here from the real node level — `serializeCustomValue`
         // cannot do this because inline values are dispatched at level 0.
         if (
            typeof propValue === 'string' &&
            propValue.includes(this.newlineChar) &&
            (this.options.blockScalarProperties?.has(`${nodeType}.${prop}`) || this.options.blockScalarProperties?.has(prop))
         ) {
            const blockScalar = this.serializeBlockScalar(propValue, indentationLevel);
            this.pushNodeLine(blockScalar, keyword, /* onNewLine */ false, indentationLevel, state, lines);
            continue;
         }
         const maybe = this.serializePropertyValue(nodeType, prop, propValue, onNewLine ? indentationLevel + 1 : 0);
         if (isPromiseLike(maybe)) {
            const resumeAt = i + 1;
            return maybe.then(serialized => {
               this.pushNodeLine(serialized, keyword, onNewLine, indentationLevel, state, lines);
               return this.collectNodeLines(node, nodeType, propNames, indentationLevel, state, lines, resumeAt);
            });
         }
         this.pushNodeLine(maybe, keyword, onNewLine, indentationLevel, state, lines);
      }
      return lines.join(this.newlineChar + this.indent('', indentationLevel));
   }

   /**
    * Returns the YAML keyword for a property. Default reads from
    * {@link typeSpecificKeywords} (initialised from
    * {@link YamlSerializerOptions.typeSpecificKeywords} in the constructor):
    * looks up `${prop}.${valueType}` and falls back to the raw property name
    * for non-AST values and unmapped types. Adopters whose keyword follows a
    * rule rather than a fixed table override this method instead of
    * providing the data map.
    */
   protected getPropertyKeyword(prop: string, valueType?: string): string {
      if (valueType === undefined) {
         return prop;
      }
      return this.typeSpecificKeywords.get(`${prop}.${valueType}`) ?? prop;
   }

   protected pushNodeLine(
      serialized: string | undefined,
      keyword: string,
      onNewLine: boolean,
      indentationLevel: number,
      state: { isFirst: boolean },
      lines: string[]
   ): void {
      if (!serialized) {
         return;
      }
      const separator = onNewLine ? this.newlineChar : ' ';
      const line = `${keyword}:${separator}${serialized}`;
      lines.push(state.isFirst ? this.indent(line, indentationLevel) : line);
      state.isFirst = false;
   }

   /** Serialize an array of reference values (Langium References or plain strings). */
   protected override serializeReferenceArray(items: unknown[], indentationLevel: number): MaybePromise<string> {
      return this.collectReferenceArrayLines(items, indentationLevel, [], 0);
   }

   /** Same sync-or-async tail pattern as {@link collectArrayLines}, for reference-array elements. */
   protected collectReferenceArrayLines(
      items: unknown[],
      indentationLevel: number,
      lines: string[],
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
               lines.push(this.indent(`  - ${formatted}`, indentationLevel - 1));
               return this.collectReferenceArrayLines(items, indentationLevel, lines, resumeAt);
            });
         }
         lines.push(this.indent(`  - ${maybe}`, indentationLevel - 1));
      }
      return lines.join(this.newlineChar);
   }

   /** Serialize an array of non-reference values. */
   protected override serializeArray(items: unknown[], nodeType: string, key: string, indentationLevel: number): MaybePromise<string> {
      return this.collectArrayLines(items, nodeType, key, indentationLevel, [], 0);
   }

   /** Same sync-or-async tail pattern as {@link collectNodeLines}, for array elements. */
   protected collectArrayLines(
      items: unknown[],
      nodeType: string,
      key: string,
      indentationLevel: number,
      lines: string[],
      startIndex: number
   ): MaybePromise<string> {
      for (let i = startIndex; i < items.length; i++) {
         const item = items[i];
         if (item === undefined) {
            continue;
         }
         const maybe = this.serializePropertyValue(nodeType, key, item, indentationLevel, /* isArrayElement */ true);
         if (isPromiseLike(maybe)) {
            const resumeAt = i + 1;
            return maybe.then(serialized => {
               this.pushArrayLine(serialized, indentationLevel, lines);
               return this.collectArrayLines(items, nodeType, key, indentationLevel, lines, resumeAt);
            });
         }
         this.pushArrayLine(maybe, indentationLevel, lines);
      }
      return lines.join(this.newlineChar);
   }

   protected pushArrayLine(serialized: string | undefined, indentationLevel: number, lines: string[]): void {
      if (serialized === undefined) {
         return;
      }
      lines.push(this.indent(`  - ${serialized}`, indentationLevel - 1));
   }

   /**
    * YAML emits grammar-declared unquoted terminals (cardinality keywords,
    * type literals) as bare strings rather than quoting them. The decision is
    * `(type, key)`-based, so it rides the {@link AbstractSerializer.serializeCustomValue}
    * hook; non-matching properties delegate up the chain via `super`.
    */
   protected override serializeCustomValue(
      nodeType: string,
      key: string,
      value: unknown,
      indentationLevel: number
   ): MaybePromise<string | undefined> {
      if (typeof value === 'string' && this.options.unquotedProperties?.has(`${nodeType}.${key}`)) {
         return String(value);
      }
      return super.serializeCustomValue(nodeType, key, value, indentationLevel);
   }

   /** Indent a line at the given level. */
   protected indent(text: string, level: number): string {
      return `${this.indentationChar.repeat(level * this.indentationAmount)}${text}`;
   }

   /**
    * Serialize a multi-line string as a YAML literal block scalar. Returns
    * `|` followed by every line indented one level deeper than `indentationLevel`
    * (the node level at which the owning `key:` is emitted), so the block content
    * sits below — and is reparsed relative to — its key. Every line (including
    * blank ones) is indented so a block-string value converter that strips the
    * common indentation round-trips interior and trailing blank lines.
    */
   protected serializeBlockScalar(value: string, indentationLevel: number): string {
      const indent = this.indentationChar.repeat((indentationLevel + 1) * this.indentationAmount);
      const lines = value
         .split(this.newlineChar)
         .map(line => indent + line)
         .join(this.newlineChar);
      return `|${this.newlineChar}${lines}`;
   }
}
