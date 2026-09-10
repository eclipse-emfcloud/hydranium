/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type AstNode,
   AstUtils,
   DefaultLangiumDocumentFactory,
   type LangiumDocument,
   type ParseResult,
   type URI
} from '@hydranium/langium';
import { type ExtendedServiceRegistry } from '../service-registry.js';
import { type Serializer } from '../serialization/serializer.js';

/** Structural view of the per-language serializer slot on the resolved services. */
interface WithSerializer {
   serializer?: { Serializer?: Serializer };
}

/**
 * Framework `LangiumDocumentFactory` that fills in the one thing Langium
 * leaves empty for a code-built document: its text.
 *
 * Langium's `fromModel` produces a document with no text (Langium core has no
 * generic serializer), so a virtual document built from a model cannot be
 * re-read. The framework *does* have a per-language `Serializer`, so this
 * override serializes the model once at creation and retains the result as the
 * document's text — while keeping the ORIGINAL model object as the AST, so node
 * identity survives: adopters holding references to their stdlib nodes, and the
 * scope descriptions pointing at them, stay valid. A `fromString` document
 * already carries its source, so only `fromModel` needs help.
 *
 * Degrades to Langium's text-less `fromModel` when no serializer is bound for
 * the URI's language (the serializer throws or is absent) — the document still
 * works; only a re-read of it would yield empty text, which never happens for a
 * build-once virtual document.
 *
 * Also links the model's container properties (`$container` /
 * `$containerProperty` / `$containerIndex`), which Langium's parser sets via
 * `linkContentToContainer` but `fromModel` skips. Without them the
 * `AstNodeLocator` can't compute node paths, so indexing the document — the
 * point of contributing it as an additional/virtual document — yields broken
 * paths and cross-references into it fail to resolve. Linking is in place, so
 * node identity is preserved.
 */
export class HydraniumLangiumDocumentFactory extends DefaultLangiumDocumentFactory {
   /**
    * Narrows the inherited Langium `ServiceRegistry` field to the framework's
    * {@link ExtendedServiceRegistry}, so the by-id lookup below needs no
    * per-callsite cast. The framework's shared module binds that class.
    */
   declare protected readonly serviceRegistry: ExtendedServiceRegistry;

   /**
    * Parse `text` for `uri` under the grammar `languageId` names, instead of
    * the one `uri` routes to.
    *
    * For a URI that routes to no grammar at all: a directory, or any other URI
    * that names no file and so carries no extension. Langium's ladder ends at
    * the extension, so it reports `no services for the extension ''` from
    * inside the parse — naming neither the URI nor the caller that could have
    * said which grammar it meant.
    *
    * The caller supplies the language because nothing else can. A URI with no
    * extension carries no routing signal, and choosing on its behalf would be a
    * guess the moment a second grammar is registered — which is why this takes
    * the id rather than falling back to a sole registered language.
    *
    * @throws when `languageId` names no registered grammar.
    */
   fromStringInLanguage<T extends AstNode = AstNode>(text: string, uri: URI, languageId: string): LangiumDocument<T> {
      const services = this.serviceRegistry.getServicesById(languageId);
      if (!services) {
         throw new Error(`No grammar is registered for the language id '${languageId}' (parsing ${uri.toString()}).`);
      }
      const parseResult: ParseResult<T> = services.parser.LangiumParser.parse<T>(text);
      return this.createLangiumDocument<T>(parseResult, uri, undefined, text);
   }

   override fromModel<T extends AstNode = AstNode>(model: T, uri: URI): LangiumDocument<T> {
      // Make the code-built AST as structurally complete as a parsed one — the
      // parser links containers, `fromModel` does not. In place (identity kept).
      AstUtils.linkContentToContainer(model, { deep: true });
      const text = this.serializeModel(model, uri);
      if (text === undefined) {
         return super.fromModel(model, uri);
      }
      const parseResult: ParseResult<T> = { value: model, parserErrors: [], lexerErrors: [] };
      return this.createLangiumDocument<T>(parseResult, uri, undefined, text);
   }

   /**
    * Serialize `model` via the per-language serializer, or `undefined` if none
    * is bound, it fails, or it is async — `fromModel` is synchronous, so an
    * async serializer degrades to a text-less document rather than blocking.
    */
   protected serializeModel(model: AstNode, uri: URI): string | undefined {
      try {
         const services = this.serviceRegistry.getServices(uri) as WithSerializer;
         const serialized = services.serializer?.Serializer?.serializeAst(model);
         return typeof serialized === 'string' ? serialized : undefined;
      } catch {
         return undefined;
      }
   }
}
