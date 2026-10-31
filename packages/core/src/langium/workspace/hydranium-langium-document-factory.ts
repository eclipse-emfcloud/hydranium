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
   type DefaultMultiReference,
   type DefaultReference,
   DefaultLangiumDocumentFactory,
   DocumentState,
   isAstNode,
   isMultiReference,
   type LangiumDocument,
   type Linker,
   type MultiReference,
   type Mutable,
   type ParseResult,
   type Reference,
   type ReferenceInfo,
   type URI
} from '@hydranium/langium';
import { type CancellationToken } from 'vscode-languageserver-protocol';
import { type TextDocument } from 'vscode-languageserver-textdocument';
import { STALE_VERSION } from '@hydranium/protocol';
import { type ModelLedger } from '../../documents/model-ledger.js';
import { type CstResidencyService } from '../residency/cst-residency-service.js';
import { type VersionSyncService } from '../../documents/version-sync-service.js';
import { type ExtendedServiceRegistry } from '../service-registry.js';
import { type ServerSharedServicesMinimal } from '../shared-services.js';
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
 * The first build grafts the CST of that text onto the model, as for a shed
 * document, which gives every reference the `$refNode` the reference index
 * needs. A model that does not pair node for node with its serialized text is
 * re-parsed from it instead, and its nodes are replaced. A code-built document
 * whose URI names no file is re-read from the text it holds, or from the store
 * while it is open, since reading its URI would throw.
 *
 * Degrades to Langium's text-less `fromModel` when no serializer is bound for
 * the URI's language (the serializer throws or is absent). The document keeps
 * its nodes but gets no CST, so its references stay out of the reference index
 * and it is not relinked when their targets change.
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

   /** A thunk: a version-sync service whose constructor reads this factory would otherwise be a cycle. */
   protected readonly versionSyncService: () => VersionSyncService;
   /** A thunk: a ledger whose constructor reads this factory would otherwise be a cycle. */
   protected readonly modelLedger: () => ModelLedger;
   /** A thunk: the residency service resolves `LangiumDocuments`, which is built with this factory. */
   protected readonly cstResidency: () => CstResidencyService;
   /** The code-built documents, which are re-read from the text they hold when no file is at their URI. */
   protected readonly codeBuiltDocuments = new WeakSet<LangiumDocument>();

   constructor(services: ServerSharedServicesMinimal) {
      super(services);
      this.versionSyncService = () => services.workspace.VersionSyncService;
      this.modelLedger = () => services.workspace.ModelLedger;
      this.cstResidency = () => services.workspace.CstResidencyService;
   }

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
      const services = this.serviceRegistry.getServices(uri);
      // The parser fills in the defaults a model built in code may leave out.
      // Without them the model does not pair with the parse of its text.
      for (const node of AstUtils.streamAst(model)) {
         AstUtils.assignMandatoryProperties(services.shared.AstReflection, node);
      }
      const parseResult: ParseResult<T> = { value: model, parserErrors: [], lexerErrors: [] };
      const document = this.createLangiumDocument<T>(parseResult, uri, undefined, text);
      this.codeBuiltDocuments.add(document);
      const linker = services.references.Linker;
      document.references = AstUtils.streamAst(model)
         .flatMap(node => AstUtils.streamReferences(node))
         .toArray()
         .map(info => this.rebuildReference(linker, info));
      return document;
   }

   /**
    * Replace a code-set reference with one the linker built, holding the same
    * target. A relink resets and the reference index reads only such
    * references, and only those listed in `document.references`. The first
    * build unlinks them before its link phase, which resolves and indexes them.
    */
   protected rebuildReference(linker: Linker, { reference, container, property, index }: ReferenceInfo): Reference | MultiReference {
      let rebuilt: Reference | MultiReference;
      if (isMultiReference(reference)) {
         // Read through the field, as `items` would resolve a linker-built reference.
         const items = '_items' in reference ? reference._items : reference.items;
         const multi = linker.buildMultiReference(container, property, reference.$refNode, reference.$refText) as DefaultMultiReference;
         multi._items = Array.isArray(items) ? [...items] : undefined;
         rebuilt = multi;
      } else {
         const target = '_ref' in reference ? reference._ref : reference.ref;
         const single: DefaultReference = linker.buildReference(container, property, reference.$refNode, reference.$refText);
         single._ref = isAstNode(target) ? target : undefined;
         rebuilt = single;
      }
      const owner: unknown = Reflect.get(container, property);
      Reflect.set(index === undefined || !Array.isArray(owner) ? container : owner, index ?? property, rebuilt);
      return rebuilt;
   }

   protected override createLangiumDocument<T extends AstNode = AstNode>(
      parseResult: ParseResult<T>,
      uri: URI,
      textDocument?: TextDocument,
      text?: string
   ): LangiumDocument<T> {
      const document = super.createLangiumDocument(parseResult, uri, textDocument, text);
      // Without `textDocument` Langium creates one at version 0 on first read,
      // which needs a language for `uri` that a folder URI does not have.
      const parsed = parseResult.value.$cstNode?.root.fullText ?? text ?? textDocument?.getText();
      const version = this.versionOfParsedText(uri, parsed, textDocument?.version ?? 0);
      // A `fromModel` root has no CST to hold its serialized text. Recorded, it
      // is the text a build grafts a CST from, keeping the model's nodes.
      this.versionSyncService().modelProduced(document, { version, text: parseResult.value.$cstNode ? undefined : text });
      return document;
   }

   /**
    * The version is read before the parse, for the same reason as in
    * {@link update}: the text document is the store's, which an edit updates
    * in place while the parse runs.
    */
   protected override async createAsync<T extends AstNode = AstNode>(
      uri: URI,
      content: string | TextDocument,
      cancelToken: CancellationToken
   ): Promise<LangiumDocument<T>> {
      const version = typeof content === 'string' ? undefined : content.version;
      const document = await super.createAsync<T>(uri, content, cancelToken);
      if (version !== undefined) {
         this.versionSyncService().modelProduced(document, { version });
      }
      return document;
   }

   /**
    * The store's version is read before Langium's `update`, which reads the
    * store's text before its first await: read after, it can belong to an
    * edit that arrived while the parse ran.
    *
    * Reconciled with the store here rather than in a `Parsed` listener, which
    * a cancel skips, leaving the root on the version of its earlier text.
    */
   override async update<T extends AstNode = AstNode>(
      document: Mutable<LangiumDocument<T>>,
      cancellationToken: CancellationToken
   ): Promise<LangiumDocument<T>> {
      // Langium keeps the AST when the CST's text equals the new text, but a
      // shed document has no CST and would get new AST nodes, leaving its
      // dependents on the old ones. Grafted only when the new text is the text
      // the AST was parsed from, so an edit on disk or in the store is still
      // re-parsed. Not `isCstShed`: the builder has already reset the document
      // to `Changed`. A refused or diverged graft re-parses, and a build after
      // this one relinks the dependents: this build has prepared its
      // documents, and a reset now would drop their build state.
      const root = document.parseResult.value;
      const parsedFrom = root.$cstNode === undefined ? this.modelLedger().textOf(root) : undefined;
      if (parsedFrom !== undefined) {
         const text =
            this.codeBuiltText(document) ??
            this.textDocuments?.get(document.uri.toString())?.getText() ??
            (await this.fileSystemProvider.readFile(document.uri));
         if (text === parsedFrom) {
            this.cstResidency().rehydrate(document);
            if (root.$cstNode === undefined) {
               this.versionSyncService().rebuildWhileCurrent(document);
            }
         }
      }
      const stored = this.textDocuments?.get(document.uri.toString())?.version;
      const codeBuiltText = this.codeBuiltText(document);
      const updated =
         codeBuiltText === undefined
            ? await super.update(document, cancellationToken)
            : await this.reparse(document, codeBuiltText, cancellationToken);
      const version =
         stored ??
         this.versionOfParsedText(
            updated.uri,
            this.modelLedger().textOf(updated.parseResult.value) ?? updated.textDocument.getText(),
            updated.textDocument.version
         );
      this.versionSyncService().modelProduced(updated, { version });
      return updated;
   }

   /**
    * The text a code-built document is read from when no file is at its URI:
    * the store's while it is open, else the text it holds, serialized at
    * creation or last read, as `VirtualFileSystemProvider` serves it.
    * `undefined` for any other document, which is read as Langium reads it.
    */
   protected codeBuiltText(document: LangiumDocument): string | undefined {
      if (!this.codeBuiltDocuments.has(document) || this.fileSystemProvider.existsSync(document.uri)) {
         return undefined;
      }
      return this.textDocuments?.get(document.uri.toString())?.getText() ?? document.textDocument.getText();
   }

   /** Langium's `update` with `text` in place of the text it reads from the store or the URI. */
   protected async reparse<T extends AstNode = AstNode>(
      document: Mutable<LangiumDocument<T>>,
      text: string,
      cancellationToken: CancellationToken
   ): Promise<LangiumDocument<T>> {
      const textDocument = this.textDocuments?.get(document.uri.toString());
      Object.defineProperty(
         document,
         'textDocument',
         textDocument ? { value: textDocument } : { get: this.createTextDocumentGetter(document.uri, text) }
      );
      if (document.parseResult.value.$cstNode?.root.fullText !== text) {
         document.parseResult = await this.parseAsync<T>(document.uri, text, cancellationToken);
         (document.parseResult.value as Mutable<AstNode>).$document = document;
      }
      document.state = DocumentState.Parsed;
      return document;
   }

   /**
    * `version`, or {@link STALE_VERSION} when the store holds `uri` open with
    * other text than `parsed`: text read from the file while an open landed.
    */
   protected versionOfParsedText(uri: URI, parsed: string | undefined, version: number): number {
      const open = this.textDocuments?.get(uri.toString());
      return open !== undefined && parsed !== undefined && open.getText() !== parsed ? STALE_VERSION : version;
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
