/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The client half of the LSP head for a Monaco editor, over the connection the
 * page already holds for the head.
 *
 * Hand-written rather than `monaco-languageclient`, which drags in the
 * `@codingame/monaco-vscode-*` shim stack: at `platform: 'browser'` a bundler
 * refuses a `node:*` builtin rather than shimming it, and that refusal is what
 * keeps a page bundle a neutrality gate over the head composition it carries.
 *
 * A Theia or VS Code integration hands `vscode-languageclient` a document
 * store, a marker service and a provider registry. Here Monaco is all three,
 * and the three translations between it and LSP are the whole of the work:
 *
 * - **Identity.** A Monaco model URI must be string-identical to the LSP URI, or
 *   `publishDiagnostics` addresses a document Monaco does not have and the
 *   markers land nowhere, silently.
 * - **Coordinates.** LSP lines and characters are 0-based; Monaco lines and
 *   columns are 1-based. Every range crossing this file is converted.
 * - **Versions.** Monaco's `versionId` is monotonic per model, which is exactly
 *   what the server's text store wants for its stale-write gate, so it is used
 *   directly rather than counted here in parallel.
 */

import { type BaseVersion, isResponseError, sendByMethodName, type TextState, textHash } from '@hydranium/protocol';
import * as monaco from 'monaco-editor-core';
import { ConnectionErrors, type MessageConnection } from 'vscode-jsonrpc/browser';
import {
   type AnnotatedTextEdit,
   type ApplyWorkspaceEditParams,
   ApplyWorkspaceEditRequest,
   type ApplyWorkspaceEditResult,
   type ClientCapabilities,
   type CompletionContext,
   type CompletionItem,
   CompletionItemKind,
   CompletionItemTag,
   CompletionRequest,
   CompletionTriggerKind,
   DefinitionRequest,
   DidChangeTextDocumentNotification,
   DidCloseTextDocumentNotification,
   DidOpenTextDocumentNotification,
   DocumentHighlightKind,
   DocumentHighlightRequest,
   ErrorCodes,
   type PublishDiagnosticsParams,
   type Diagnostic,
   DiagnosticSeverity,
   DiagnosticTag,
   type Hover,
   HoverRequest,
   InsertTextFormat,
   InsertTextMode,
   type Location,
   LocationLink,
   LSPErrorCodes,
   type MarkupContent,
   MarkupKind,
   type Position as LspPosition,
   type Range as LspRange,
   SemanticTokenModifiers,
   SemanticTokensRequest,
   SemanticTokenTypes,
   type ServerCapabilities,
   SnippetTextEdit,
   type TextDocumentContentChangeEvent,
   TextDocumentEdit,
   type TextEdit,
   type WorkspaceEdit
} from 'vscode-languageserver-protocol';

export interface MonacoLspClientOptions {
   /**
    * The languages the server speaks, as Monaco registers them. A document is
    * routed to the first entry whose `extensions` its URI ends with, and that
    * id is the `languageId` on `didOpen`, which the server routes the document
    * to a grammar by. No entry means the open throws rather than guessing: a
    * document parsed by the wrong grammar reports a page of syntax errors that
    * read as the file being broken.
    */
   readonly languages: readonly monaco.languages.ILanguageExtensionPoint[];
   /** The owner of the markers this client sets, which a host reads them back by; {@link DEFAULT_MARKER_OWNER} by default. */
   readonly markerOwner?: string;
}

/** The marker owner a client sets diagnostics under when its options name none. */
export const DEFAULT_MARKER_OWNER = 'lsp';

/**
 * The client capabilities for a host whose editor is a {@link MonacoLspClient},
 * to pass as `initializeLanguageClient`'s `capabilities`: the two workspace
 * answers of the default, plus every form the client renders, so a server that
 * gates a form on its capability sends it. Multi-line semantic tokens stay
 * undeclared, since Monaco cannot render one, and Langium then splits them
 * per line. Frozen: a host that declares more spreads it.
 */
export const MONACO_CLIENT_CAPABILITIES: ClientCapabilities = deepFreeze({
   workspace: { applyEdit: true, configuration: true, workspaceEdit: { documentChanges: true } },
   textDocument: {
      synchronization: { willSave: false, willSaveWaitUntil: false, didSave: false },
      completion: {
         contextSupport: true,
         completionItem: {
            snippetSupport: true,
            commitCharactersSupport: true,
            documentationFormat: [MarkupKind.Markdown, MarkupKind.PlainText],
            deprecatedSupport: true,
            preselectSupport: true,
            tagSupport: { valueSet: [CompletionItemTag.Deprecated] },
            insertReplaceSupport: true,
            insertTextModeSupport: { valueSet: [InsertTextMode.asIs, InsertTextMode.adjustIndentation] },
            labelDetailsSupport: true
         },
         completionItemKind: { valueSet: Object.values(CompletionItemKind) }
      },
      hover: { contentFormat: [MarkupKind.Markdown, MarkupKind.PlainText] },
      definition: { linkSupport: true },
      documentHighlight: {},
      publishDiagnostics: {
         relatedInformation: true,
         tagSupport: { valueSet: [DiagnosticTag.Unnecessary, DiagnosticTag.Deprecated] },
         codeDescriptionSupport: true
      },
      semanticTokens: {
         requests: { full: true },
         tokenTypes: Object.values(SemanticTokenTypes),
         tokenModifiers: Object.values(SemanticTokenModifiers),
         formats: ['relative']
      }
   }
});

/** `value` and everything it holds, frozen, so a shared constant cannot be changed in place. */
function deepFreeze<T extends object>(value: T): T {
   for (const child of Object.values(value)) {
      if (typeof child === 'object' && child !== null) {
         deepFreeze(child);
      }
   }
   return Object.freeze(value);
}

function toMarkerSeverity(severity: DiagnosticSeverity | undefined): monaco.MarkerSeverity {
   switch (severity) {
      case DiagnosticSeverity.Error:
         return monaco.MarkerSeverity.Error;
      case DiagnosticSeverity.Warning:
         return monaco.MarkerSeverity.Warning;
      case DiagnosticSeverity.Information:
         return monaco.MarkerSeverity.Info;
      case DiagnosticSeverity.Hint:
         return monaco.MarkerSeverity.Hint;
      // An absent severity is an ERROR by the LSP spec's own wording ("the
      // client is free to decide"), and treating it as a hint would hide a
      // deliberate error behind a barely-visible squiggle.
      default:
         return monaco.MarkerSeverity.Error;
   }
}

/**
 * LSP completion kinds to Monaco's.
 *
 * **Written out rather than passed through, because the two enums are different
 * NUMBER SPACES over the same names.** LSP `Class` is 7 and Monaco's 7 is
 * `Interface`; LSP `Text` is 1 and Monaco's 1 is `Function`. A pass-through
 * therefore compiles, runs, and puts the wrong icon on every entry in the list —
 * a defect nobody reports as a bug because the list is otherwise correct.
 *
 * Written by NAME on both sides so the map stays readable and a future enum
 * addition on either side is a compile error rather than a silent gap.
 */
const COMPLETION_KINDS: Readonly<Record<CompletionItemKind, monaco.languages.CompletionItemKind>> = {
   [CompletionItemKind.Text]: monaco.languages.CompletionItemKind.Text,
   [CompletionItemKind.Method]: monaco.languages.CompletionItemKind.Method,
   [CompletionItemKind.Function]: monaco.languages.CompletionItemKind.Function,
   [CompletionItemKind.Constructor]: monaco.languages.CompletionItemKind.Constructor,
   [CompletionItemKind.Field]: monaco.languages.CompletionItemKind.Field,
   [CompletionItemKind.Variable]: monaco.languages.CompletionItemKind.Variable,
   [CompletionItemKind.Class]: monaco.languages.CompletionItemKind.Class,
   [CompletionItemKind.Interface]: monaco.languages.CompletionItemKind.Interface,
   [CompletionItemKind.Module]: monaco.languages.CompletionItemKind.Module,
   [CompletionItemKind.Property]: monaco.languages.CompletionItemKind.Property,
   [CompletionItemKind.Unit]: monaco.languages.CompletionItemKind.Unit,
   [CompletionItemKind.Value]: monaco.languages.CompletionItemKind.Value,
   [CompletionItemKind.Enum]: monaco.languages.CompletionItemKind.Enum,
   [CompletionItemKind.Keyword]: monaco.languages.CompletionItemKind.Keyword,
   [CompletionItemKind.Snippet]: monaco.languages.CompletionItemKind.Snippet,
   [CompletionItemKind.Color]: monaco.languages.CompletionItemKind.Color,
   [CompletionItemKind.File]: monaco.languages.CompletionItemKind.File,
   [CompletionItemKind.Reference]: monaco.languages.CompletionItemKind.Reference,
   [CompletionItemKind.Folder]: monaco.languages.CompletionItemKind.Folder,
   [CompletionItemKind.EnumMember]: monaco.languages.CompletionItemKind.EnumMember,
   [CompletionItemKind.Constant]: monaco.languages.CompletionItemKind.Constant,
   [CompletionItemKind.Struct]: monaco.languages.CompletionItemKind.Struct,
   [CompletionItemKind.Event]: monaco.languages.CompletionItemKind.Event,
   [CompletionItemKind.Operator]: monaco.languages.CompletionItemKind.Operator,
   [CompletionItemKind.TypeParameter]: monaco.languages.CompletionItemKind.TypeParameter
};

/**
 * LSP document-highlight kinds to Monaco's.
 *
 * **The same three names over two number spaces, offset by one.** LSP counts
 * from 1 and Monaco from 0, so a pass-through renders every `Read` as a `Text`
 * and every `Write` as a `Read` — and `Write`, LSP's 3, is outside Monaco's enum
 * entirely. The decoration differs per kind, so the result is a file highlighted
 * in the wrong colours rather than an error.
 */
const HIGHLIGHT_KINDS: Readonly<Record<DocumentHighlightKind, monaco.languages.DocumentHighlightKind>> = {
   [DocumentHighlightKind.Text]: monaco.languages.DocumentHighlightKind.Text,
   [DocumentHighlightKind.Read]: monaco.languages.DocumentHighlightKind.Read,
   [DocumentHighlightKind.Write]: monaco.languages.DocumentHighlightKind.Write
};

/** LSP 0-based line/character to Monaco 1-based line/column. */
function toMonacoRange(range: LspRange): monaco.IRange {
   return {
      startLineNumber: range.start.line + 1,
      startColumn: range.start.character + 1,
      endLineNumber: range.end.line + 1,
      endColumn: range.end.character + 1
   };
}

function toMarker(diagnostic: Diagnostic): monaco.editor.IMarkerData {
   return {
      ...toMonacoRange(diagnostic.range),
      // LSP 3.18 widened `message` to `string | MarkupContent`, and Monaco's
      // marker takes a plain string. Flattening to the markup's `value` rather
      // than stringifying keeps a rich message readable instead of rendering
      // `[object Object]` in the hover.
      message: typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value,
      severity: toMarkerSeverity(diagnostic.severity),
      source: diagnostic.source,
      // Stringified because LSP allows a numeric code and Monaco's marker does
      // not, and `undefined` is preserved rather than becoming `"undefined"` in
      // the problem list.
      code:
         diagnostic.code === undefined
            ? undefined
            : diagnostic.codeDescription === undefined
              ? String(diagnostic.code)
              : { value: String(diagnostic.code), target: monaco.Uri.parse(diagnostic.codeDescription.href) },
      tags: diagnostic.tags?.flatMap(toMarkerTag),
      relatedInformation: diagnostic.relatedInformation?.map(related => ({
         resource: monaco.Uri.parse(related.location.uri),
         message: related.message,
         ...toMonacoRange(related.location.range)
      }))
   };
}

/** A tag Monaco renders, or none for a tag a later LSP version adds. */
function toMarkerTag(tag: DiagnosticTag): monaco.MarkerTag[] {
   switch (tag) {
      case DiagnosticTag.Unnecessary:
         return [monaco.MarkerTag.Unnecessary];
      case DiagnosticTag.Deprecated:
         return [monaco.MarkerTag.Deprecated];
      default:
         return [];
   }
}

/**
 * Monaco's content changes as LSP incremental changes, ordered so that applying
 * them in sequence is correct.
 *
 * **Monaco reports every range against the state BEFORE the edit; LSP reads each
 * range against the state after the previous one.** The two agree only if the
 * changes are applied back-to-front, which is why they are sorted here descending
 * by position. Monaco is documented to deliver them in that order already, and
 * relying on it would be free — but the failure of relying on it wrongly is a
 * multi-cursor edit silently corrupting the server's copy of the document while
 * the editor looks correct, which is not a defect anyone finds from the symptom.
 */
function toContentChanges(changes: readonly monaco.editor.IModelContentChange[]): TextDocumentContentChangeEvent[] {
   return [...changes]
      .sort((left, right) => right.rangeOffset - left.rangeOffset)
      .map(change => ({
         range: {
            start: { line: change.range.startLineNumber - 1, character: change.range.startColumn - 1 },
            end: { line: change.range.endLineNumber - 1, character: change.range.endColumn - 1 }
         },
         rangeLength: change.rangeLength,
         text: change.text
      }));
}

/** Monaco 1-based line/column to an LSP 0-based position. */
function toLspPosition(position: monaco.IPosition): LspPosition {
   return { line: position.lineNumber - 1, character: position.column - 1 };
}

/**
 * Where an editor-opener request wants the caret.
 *
 * Monaco hands the opener a RANGE where it has one and a bare position where it
 * does not, and the two spell their line under different names — so a reader of
 * `lineNumber` alone gets `undefined` for every navigation that carried a range,
 * which is all of the ones a definition result produces: Monaco collapses a
 * target to its start before it reaches here.
 *
 * Line 1, column 1 for a request naming no position at all, which a request to
 * open a document merely by URI is. The top of the file is that request's own
 * answer rather than a fallback.
 */
function toEditorPosition(selectionOrPosition: monaco.IRange | monaco.IPosition | undefined): monaco.IPosition {
   if (selectionOrPosition === undefined) {
      return { lineNumber: 1, column: 1 };
   }
   return 'startLineNumber' in selectionOrPosition
      ? { lineNumber: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
      : { lineNumber: selectionOrPosition.lineNumber, column: selectionOrPosition.column };
}

/**
 * Whether `error` says the connection is closed or disposed, by its code
 * rather than by `instanceof`: a connection the host hands in may come from
 * another `vscode-jsonrpc` copy, whose `ConnectionError` is a different class.
 */
function isConnectionClosedError(error: unknown): boolean {
   return error instanceof Error && 'code' in error && (error.code === ConnectionErrors.Closed || error.code === ConnectionErrors.Disposed);
}

/**
 * Send a notification that a closed connection does not fail: the server's
 * side of the sync ended with the connection. A write that fails later is
 * logged by the connection itself.
 */
function notifyUnlessClosed(send: () => Promise<void>): void {
   try {
      void send().catch(() => undefined);
   } catch (error: unknown) {
      if (!isConnectionClosedError(error)) {
         throw error;
      }
   }
}

/**
 * Whether a request failed because nobody wants its answer any more: the
 * server gave it up (`RequestCancelled`, `ServerCancelled`, or
 * `ContentModified` for a document changed under it), or the connection
 * closed before or while it ran.
 */
function isAbandonedRequest(error: unknown): boolean {
   if (isConnectionClosedError(error)) {
      return true;
   }
   if (!isResponseError(error)) {
      return false;
   }
   return (
      error.code === LSPErrorCodes.RequestCancelled ||
      error.code === LSPErrorCodes.ServerCancelled ||
      error.code === LSPErrorCodes.ContentModified ||
      error.code === ErrorCodes.PendingResponseRejected ||
      error.code === ErrorCodes.ConnectionInactive
   );
}

/**
 * Monaco's cancellation, which it recognises by name and message: Monaco's API
 * does not export the class, and drops this error silently where it reports
 * any other from a timer as an uncaught page error.
 */
function monacoCancellation(): Error {
   const error = new Error('Canceled');
   error.name = 'Canceled';
   return error;
}

function isMarkupContent(value: unknown): value is MarkupContent {
   return typeof value === 'object' && value !== null && 'kind' in value && 'value' in value;
}

/**
 * A `textDocument/definition` result as Monaco location links.
 *
 * **Both wire shapes are live, and reading only one of them fails quietly.** The
 * response is a `Location`, an array of them, or an array of `LocationLink`s,
 * and the framework's head answers with the last — to a client that declared no
 * capabilities at all, so `linkSupport` cannot be relied on to narrow it. The
 * two spell the target under different keys, so a client that reads a link's
 * `uri` parses a URI out of nothing, which addresses no model and navigates
 * nowhere without raising anything.
 *
 * The link form is the richer one and is kept whole rather than flattened to a
 * bare location. `targetRange` is the declaration's full extent and
 * `targetSelectionRange` the name inside it, which is what puts the caret on the
 * name rather than on the keyword in front of it. `originSelectionRange` is the
 * span underlined under the Ctrl key, and dropping it leaves Monaco underlining
 * its own word-at-position instead — a guess about where the reference the
 * server resolved actually begins.
 */
function toDefinitionLinks(result: Location | Location[] | LocationLink[]): monaco.languages.LocationLink[] {
   const entries: readonly (Location | LocationLink)[] = Array.isArray(result) ? result : [result];
   return entries.map(entry =>
      LocationLink.is(entry)
         ? {
              uri: monaco.Uri.parse(entry.targetUri),
              range: toMonacoRange(entry.targetRange),
              targetSelectionRange: toMonacoRange(entry.targetSelectionRange),
              originSelectionRange: entry.originSelectionRange === undefined ? undefined : toMonacoRange(entry.originSelectionRange)
           }
         : { uri: monaco.Uri.parse(entry.uri), range: toMonacoRange(entry.range) }
   );
}

/**
 * `Hover.contents` as Monaco markdown blocks.
 *
 * The LSP type is a union of four shapes — a `MarkupContent`, a plain string, a
 * `{ language, value }` code block, and an array of the latter two — and all
 * four are still live in 3.18 despite the last two being deprecated. Monaco
 * takes markdown, so the code-block form is fenced with its language rather than
 * dropped: rendering it as prose would silently lose the formatting that was the
 * point of sending it that way.
 */
function toMarkdown(contents: Hover['contents']): monaco.IMarkdownString[] {
   if (isMarkupContent(contents)) {
      return [{ value: contents.kind === 'plaintext' ? escapePlaintext(contents.value) : contents.value }];
   }
   const blocks = Array.isArray(contents) ? contents : [contents];
   return blocks.map(block =>
      typeof block === 'string' ? { value: block } : { value: `\`\`\`${block.language}\n${block.value}\n\`\`\`` }
   );
}

/**
 * Plaintext as markdown that renders it verbatim, escaped as Monaco's own
 * `MarkdownString.appendText` does, which Monaco does not export.
 */
function escapePlaintext(text: string): string {
   return text
      .replace(/[\\`*_{}[\]()#+!~]/g, '\\$&')
      .replace(/^([ \t]*)-/gm, '$1\\-')
      .replace(/[ \t]+/g, whitespace => '&nbsp;'.repeat(whitespace.length))
      .replace(/>/g, '\\>')
      .replace(/\n/g, '\n\n');
}

/**
 * The range a completion item applies to.
 *
 * **Monaco REQUIRES a range and LSP does not**, which is the one real asymmetry
 * in this conversion. An LSP item may carry a `textEdit` (either a plain
 * `TextEdit` or an `InsertReplaceEdit`), or nothing at all — in which case the
 * client is expected to replace the word being typed. Getting the fallback wrong
 * does not fail: accepting an item inserts alongside the prefix instead of over
 * it, so `Order.stastatus` appears and reads as a server sending a bad label.
 *
 * **An `InsertReplaceEdit` is forwarded as BOTH ranges, not collapsed to one.**
 * Monaco's `range` accepts the `{ insert, replace }` pair and then honours
 * `suggest.insertMode`, which is the whole point of the server sending two: the
 * server states what a suggestion could stand in for and the USER's setting
 * decides whether accepting it overwrites that or inserts before it. Collapsing
 * to `replace` here would silently overrule that setting, and collapsing to
 * `insert` would throw away the wider range the server went to the trouble of
 * computing.
 */
function toCompletionRange(
   item: CompletionItem,
   model: monaco.editor.ITextModel,
   position: monaco.IPosition
): monaco.IRange | { insert: monaco.IRange; replace: monaco.IRange } {
   const edit = item.textEdit;
   if (edit !== undefined) {
      return 'range' in edit ? toMonacoRange(edit.range) : { insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace) };
   }
   const word = model.getWordUntilPosition(position);
   return {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: position.column
   };
}

/** Monaco's completion trigger in LSP's numbering, which starts at one where Monaco's starts at zero. */
function toCompletionContext(context: monaco.languages.CompletionContext): CompletionContext {
   switch (context.triggerKind) {
      case monaco.languages.CompletionTriggerKind.TriggerCharacter:
         return { triggerKind: CompletionTriggerKind.TriggerCharacter, triggerCharacter: context.triggerCharacter };
      case monaco.languages.CompletionTriggerKind.TriggerForIncompleteCompletions:
         return { triggerKind: CompletionTriggerKind.TriggerForIncompleteCompletions };
      default:
         return { triggerKind: CompletionTriggerKind.Invoked };
   }
}

/** Monaco's insert rules for `item`: a snippet, and whitespace kept as sent for an as-is item. */
function toInsertTextRules(item: CompletionItem): monaco.languages.CompletionItemInsertTextRule | undefined {
   const rules = monaco.languages.CompletionItemInsertTextRule;
   const snippet = item.insertTextFormat === InsertTextFormat.Snippet ? rules.InsertAsSnippet : rules.None;
   const keepWhitespace = item.insertTextMode === InsertTextMode.asIs ? rules.KeepWhitespace : rules.None;
   const combined = snippet | keepWhitespace;
   return combined === rules.None ? undefined : combined;
}

/** The deprecated tag Monaco strikes through, from the tag or the older `deprecated` flag. */
function toCompletionTags(item: CompletionItem): monaco.languages.CompletionItemTag[] | undefined {
   return item.tags?.includes(CompletionItemTag.Deprecated) || item.deprecated === true
      ? [monaco.languages.CompletionItemTag.Deprecated]
      : undefined;
}

function toCompletionItem(
   item: CompletionItem,
   model: monaco.editor.ITextModel,
   position: monaco.IPosition
): monaco.languages.CompletionItem {
   return {
      label:
         item.labelDetails === undefined
            ? item.label
            : { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description },
      // `Text` for an item with no kind, which is Monaco's plainest icon. LSP
      // leaves the kind optional and Monaco does not.
      kind: item.kind === undefined ? monaco.languages.CompletionItemKind.Text : COMPLETION_KINDS[item.kind],
      insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
      insertTextRules: toInsertTextRules(item),
      range: toCompletionRange(item, model, position),
      detail: item.detail,
      // A plain string is Monaco's plaintext.
      documentation: isMarkupContent(item.documentation)
         ? item.documentation.kind === 'plaintext'
            ? item.documentation.value
            : { value: item.documentation.value }
         : item.documentation,
      sortText: item.sortText,
      filterText: item.filterText,
      tags: toCompletionTags(item),
      preselect: item.preselect,
      commitCharacters: item.commitCharacters,
      // Monaco runs it after the item is accepted, if a command of that id is
      // registered: an editor action such as `editor.action.triggerSuggest`.
      command:
         item.command === undefined
            ? undefined
            : { id: item.command.command, title: item.command.title, arguments: item.command.arguments },
      // Forwarded rather than dropped: an item that needs a companion edit (an
      // import, a sibling declaration) is silently half-applied without them,
      // and the half that lands is the one that parses.
      additionalTextEdits: item.additionalTextEdits?.map(edit => ({ range: toMonacoRange(edit.range), text: edit.newText }))
   };
}

/** One document's worth of an inbound workspace edit, ready to push into Monaco. */
export interface ResolvedDocumentEdit {
   readonly model: monaco.editor.ITextModel;
   readonly operations: readonly monaco.editor.IIdentifiedSingleEditOperation[];
}

/**
 * Whether one document's worth of an inbound workspace edit can be applied, and
 * if not, what to tell the server.
 *
 * A REASON rather than a bare `false`, because the reason travels: it becomes
 * `ApplyWorkspaceEditResult.failureReason`, which is the only thing the server
 * learns about a refusal beyond the fact of it.
 */
export type EditResolution =
   | { readonly applicable: true; readonly edit: ResolvedDocumentEdit }
   | { readonly applicable: false; readonly reason: string };

/**
 * One LSP text edit as a Monaco edit operation.
 *
 * An `AnnotatedTextEdit` is a plain edit plus a change-annotation id — a hint
 * that a client with a confirmation UI could group and prompt on. This client
 * has no such UI, so the annotation is dropped and the text applied, which is
 * the behaviour LSP prescribes for a client that does not implement
 * `changeAnnotationSupport`. Dropping the EDIT instead would silently lose part
 * of a server write.
 */
function toEditOperation(edit: TextEdit | AnnotatedTextEdit): monaco.editor.IIdentifiedSingleEditOperation {
   return { range: toMonacoRange(edit.range), text: edit.newText };
}

/** One open document's content and the buffer version that content was read at. */
export interface EditorDocument {
   /**
    * Monaco's form of the URI, as the server knows the document: a host
    * compares it with `Uri.parse(uri).toString()` of its own, since a space or
    * a drive-letter colon is encoded here and not in the string it opened with.
    */
   readonly uri: string;
   readonly text: string;
   readonly version: number;
   /** The model the text was read from: a reopened URI is a new model, and a record of the old one marks nothing. */
   readonly model: monaco.editor.ITextModel;
}

/**
 * The editor settings a server-driven language needs, under whatever the host
 * passes to {@link MonacoLspClient.createEditor}.
 *
 * - `fixedOverflowWidgets`: Monaco sizes the suggest list against the document
 *   body rather than the editor, so in a pane smaller than the list the pane's
 *   clipping ancestor cuts it off part-way down and the list draws no
 *   scrollbar: a nine-item completion reads as a two-item one.
 * - `wordBasedSuggestions` off: Monaco's own word-based suggestions offer every
 *   word already in the document, so in a language whose identifiers are scoped
 *   cross-references they propose names not in scope at the cursor, mixed
 *   indistinguishably into the server's list.
 * - `suggest.insertMode` replace: the client forwards both ranges of an
 *   `InsertReplaceEdit`, and this is the setting that chooses between them. An
 *   identifier in a modelling language is a whole reference, not a prefix
 *   someone is part-way through typing. Monaco's own default is `'insert'`.
 * - `semanticHighlighting.enabled`: the default, `'configuredByTheme'`, leaves
 *   highlighting off for the built-in themes, which is indistinguishable from
 *   the server never answering. Without a grammar underneath, the server's
 *   semantic tokens are the only source of highlighting.
 */
const LSP_EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
   fixedOverflowWidgets: true,
   wordBasedSuggestions: 'off',
   suggest: { insertMode: 'replace' },
   'semanticHighlighting.enabled': true
};

/**
 * Registers the server's languages with Monaco and keeps its models in step
 * with the LSP head on the other end of `connection`.
 *
 * Construction registers the languages, the providers and the inbound
 * `workspace/applyEdit` handler; {@link openDocument} opens one document and
 * {@link closeDocument} closes it; {@link dispose} closes every document and
 * releases every registration. Diagnostics are NOT subscribed here — see
 * {@link applyDiagnostics}.
 */
export class MonacoLspClient {
   /**
    * The models this client opened, by URI in Monaco's form. Every inbound
    * edit, diagnostic and dirty read goes through this map rather than
    * Monaco's global lookup: a page may hold a second client, and a model
    * that client holds is not this one's to write, mark or save, however
    * its URI reads.
    */
   protected readonly models = new Map<string, monaco.editor.ITextModel>();
   /** Per URI, the buffer version last known to be persisted. */
   protected readonly savedVersions = new Map<string, number>();
   /** Everything construction and {@link registerEditorOpener} registered, released in reverse by {@link dispose}. */
   protected readonly registrations: monaco.IDisposable[] = [];
   protected readonly markerOwner: string;
   /**
    * The host's connection, sending by method name: the LSP message types come
    * from `vscode-languageserver-protocol`'s copy of `vscode-jsonrpc`, which
    * need not be the connection's.
    */
   protected readonly connection: MessageConnection;

   constructor(
      connection: MessageConnection,
      capabilities: ServerCapabilities,
      protected readonly options: MonacoLspClientOptions
   ) {
      this.connection = sendByMethodName(connection);
      this.markerOwner = options.markerOwner ?? DEFAULT_MARKER_OWNER;
      // First: it is the one registration on the connection, which throws once
      // closed, and a constructor that throws leaves nothing to dispose.
      this.registerApplyEdit();
      for (const language of options.languages) {
         monaco.languages.register(language);
      }
      this.registerSemanticTokens(capabilities);
      this.registerCompletion(capabilities);
      this.registerHover();
      this.registerDefinition();
      this.registerDocumentHighlight();
   }

   /**
    * The language id for `uri`, by the extensions the options name.
    *
    * Throws rather than falling back to a default id. An unknown extension means
    * the host named a document the server has no grammar for, and the failure of
    * the guessing version is that the document opens, parses as the wrong
    * language and reports a page of syntax errors that look like the file being
    * broken.
    */
   protected languageIdFor(uri: string): string {
      // The path alone: a query or a fragment follows the extension.
      const path = monaco.Uri.parse(uri).path;
      const language = this.options.languages.find(candidate => candidate.extensions?.some(extension => path.endsWith(extension)));
      if (language === undefined) {
         throw new Error(`No language registered for ${uri}`);
      }
      return language.id;
   }

   /**
    * Apply one `publishDiagnostics` notification to the model it addresses.
    *
    * **Called by the host's single notification handler rather than subscribing
    * here, and that is forced rather than stylistic.**
    * `MessageConnection.onNotification` stores handlers in a map keyed by method,
    * so a second registration for `textDocument/publishDiagnostics` REPLACES the
    * first and returns a disposable as though it had worked. A host with a
    * handler for its own diagnostics view would have it taken over by a client
    * that registered its own, and its view would freeze at whatever it had
    * reached — with nothing on the console to say so.
    *
    * A URI with no model of this client's is not an error: a workspace has more
    * documents than the host opens, so most publishes address a file Monaco
    * has never heard of, and a model another client holds is that client's.
    */
   applyDiagnostics(params: PublishDiagnosticsParams): void {
      const model = this.modelOf(params.uri);
      if (model === undefined) {
         return;
      }
      monaco.editor.setModelMarkers(model, this.markerOwner, params.diagnostics.map(toMarker));
   }

   /**
    * Answer `workspace/applyEdit` — the server→text direction, and the half of
    * the sync a client that only sends `didOpen` silently loses.
    *
    * A server-side write (a diagram drag, a form edit, an integrity repair) goes
    * through the framework's `ModelService`, which rewrites the in-memory text
    * document and then mirrors the settled text to whichever client holds it
    * open, as a MINIMAL `workspace/applyEdit` computed against a shadow of that
    * client's buffer. So the request goes out on every such write the moment the
    * host opens a document — and a client with no handler makes
    * `vscode-jsonrpc` answer `MethodNotFound`, which the framework logs through
    * its tracer and therefore onto `window/logMessage`. A host that has no
    * handler for that either loses the whole inbound direction with nothing on
    * the console, in the editor or in the server's own report to say so.
    *
    * **Registered here rather than by the host, unlike `publishDiagnostics`.**
    * `onRequest` keys handlers by method exactly as `onNotification` does, so a
    * second registration would silently replace this one — but nothing else
    * answers `workspace/applyEdit`, so there is no fan-out to arbitrate, and the
    * handler needs the model store, which is this class's business.
    *
    * **The framework does not gate this on a client capability.**
    * `HydraniumTextDocuments.applyEditToLanguageClient` checks that an LSP
    * connection is bound and that the client has the document open, never a
    * capability, and `vscode-languageserver`'s own
    * `RemoteWorkspaceImpl.applyEdit` forwards unconditionally — so declaring
    * `workspace.applyEdit` in `initialize` does not turn the request on and
    * omitting it does not turn it off.
    *
    * **The echo does not LOOP, and is deliberately not suppressed here.**
    * Applying the edit makes Monaco fire `onDidChangeContent`, which
    * {@link openDocument} turns into a `didChange`. The server answers that
    * echo with no push of its own, so nothing ping-pongs.
    * The server correlates that `didChange` against the push still in flight
    * and reconstructs it against the buffer this client held BEFORE the push —
    * which is the only text its incremental ranges address — so an echo mints
    * no version and drives no rebuild.
    *
    * Suppressing it would break what that correlation runs on: `didChange` is
    * what keeps the server's per-URI shadow and its per-client version aligned
    * with this buffer, so withholding it makes the next outbound diff wrong and
    * makes every versioned push arrive stale. A conforming client echoes.
    *
    * **This client echoes the ranges it was handed, and a server must not assume
    * that.** A host is free to minimise a coarse edit against its own buffer
    * before applying it — Theia routes every workspace edit through
    * `computeMoreMinimalEdits` — so the echo of a single full-document replace
    * can arrive as a set of small ranges keyed to text the server never sent.
    */
   protected registerApplyEdit(): void {
      this.registrations.push(
         this.connection.onRequest(ApplyWorkspaceEditRequest.type, (params: ApplyWorkspaceEditParams) =>
            this.applyWorkspaceEdit(params.edit)
         )
      );
   }

   /**
    * Apply `edit` to the models it addresses, or refuse all of it.
    *
    * **Every target is resolved before any is written.** An LSP workspace edit
    * is a unit — `failureHandling` exists precisely because a partially applied
    * one leaves the workspace in a state no participant described — and here the
    * server's text shadow is what would carry the damage: it tracks one text per
    * URI, so a half-applied multi-document edit desynchronises the untouched
    * half's baseline and every later minimal diff for it addresses the wrong
    * lines.
    *
    * The framework's own egress never exercises that: it sends a write that
    * touches two documents as two requests of one `TextDocumentEdit` each,
    * because `applyEditToLanguageClient` is per-URI and coalesced per-URI.
    * The loop is therefore for an adopter's server that batches, and the
    * all-or-nothing shape is what keeps this client honest for one.
    */
   protected applyWorkspaceEdit(edit: WorkspaceEdit): ApplyWorkspaceEditResult {
      const resolved: ResolvedDocumentEdit[] = [];
      // A document named twice is refused whole: each entry is resolved against
      // the buffer as it is now, so a second entry would be refused or applied
      // at positions the first one moved.
      const named = new Set<string>();
      const nameOnce = (uri: string): string | undefined => {
         const key = monaco.Uri.parse(uri).toString();
         if (named.has(key)) {
            return `An edit names ${key} more than once`;
         }
         named.add(key);
         return undefined;
      };
      for (const change of edit.documentChanges ?? []) {
         if (!TextDocumentEdit.is(change)) {
            // A create / rename / delete of a FILE. The framework never sends
            // one, and a page has no filesystem of its own to perform it in —
            // the worker's does, and it is not addressable from here. Refused by
            // name so the reason names the operation rather than the shape.
            return { applied: false, failureReason: `Resource operations are not supported by this client: ${change.kind}` };
         }
         const repeated = nameOnce(change.textDocument.uri);
         if (repeated !== undefined) {
            return { applied: false, failureReason: repeated };
         }
         const resolution = this.resolveDocumentEdit(change.textDocument.uri, change.textDocument.version, change.edits);
         if (!resolution.applicable) {
            return { applied: false, failureReason: resolution.reason };
         }
         resolved.push(resolution.edit);
      }
      // The `changes` map is the pre-3.13 form, carrying no version to check
      // against. Handled rather than refused because it is still live in the
      // spec and an adopter's own server may well send it; the framework's
      // egress does not. Read only without `documentChanges`: the spec makes
      // the two alternatives, and an edit carrying both would apply twice.
      for (const [uri, edits] of Object.entries(edit.documentChanges === undefined ? (edit.changes ?? {}) : {})) {
         const repeated = nameOnce(uri);
         if (repeated !== undefined) {
            return { applied: false, failureReason: repeated };
         }
         const resolution = this.resolveDocumentEdit(uri, null, edits);
         if (!resolution.applicable) {
            return { applied: false, failureReason: resolution.reason };
         }
         resolved.push(resolution.edit);
      }

      for (const target of resolved) {
         // `pushEditOperations`, not `setValue`: the edit joins Monaco's undo
         // stack, so Ctrl+Z reverses a server write from the editor. `setValue`
         // would reset the model — dropping the undo history and the cursor
         // with it, and re-tokenising the whole document for an edit the server
         // went to the trouble of making minimal.
         //
         // An undo stop on either side, so the write is an entry of its own.
         // A typing run leaves Monaco's last element open and an edit pushed
         // then is appended to it, so without the stop before, one Ctrl+Z
         // reverts the write together with the word typed before it; without
         // the stop after, the next keystroke joins the write.
         //
         // `() => null` for the cursor computer: the edit is the SERVER's, not a
         // user gesture, so it must not move a caret the user placed. Returning
         // no selection leaves the cursor where it was.
         target.model.pushStackElement();
         target.model.pushEditOperations(null, [...target.operations], () => null);
         target.model.pushStackElement();
      }
      return { applied: true };
   }

   /**
    * Resolve one document's worth of an inbound edit against the model it names.
    *
    * Refuses, rather than dropping quietly, in three cases:
    *
    * - **No model for the URI.** `applied: true` for an edit that went nowhere
    *   would leave the server's shadow believing this client holds text it does
    *   not, and every later minimal diff for that URI would be computed against
    *   the wrong baseline. The framework pushes only to documents the language
    *   client has opened, and stages or keeps in the store a write to any
    *   other, so this branch should stay unreached — it exists so that if it is
    *   ever reached the failure is loud rather than a slow desynchronisation.
    * - **A stale version.** The framework addresses a position-dependent
    *   (line-keyed) push at its last known version of this buffer, precisely so
    *   the client can refuse a push its buffer has outrun: applying a stale
    *   range does not fail, it splices the file at the wrong lines. Refusing is
    *   not a dead branch — `ModelService` re-pushes a full-range replace on
    *   `applied: false`, which is position-independent and therefore correct
    *   against whatever the buffer now holds. That retry arrives with
    *   `version: null` and passes this gate by construction.
    * - **A snippet edit.** Monaco applies snippets through a controller rather
    *   than through the model, so a `SnippetTextEdit` pushed as text would
    *   insert its placeholder syntax literally.
    */
   protected resolveDocumentEdit(
      uri: string,
      version: number | null,
      edits: readonly (TextEdit | AnnotatedTextEdit | SnippetTextEdit)[]
   ): EditResolution {
      const model = this.modelOf(uri);
      if (model === undefined) {
         return { applicable: false, reason: `No editor open for ${uri}` };
      }
      if (version !== null && version !== model.getVersionId()) {
         return {
            applicable: false,
            reason: `Stale edit for ${uri}: addressed at version ${version}, buffer is at ${model.getVersionId()}`
         };
      }
      const operations: monaco.editor.IIdentifiedSingleEditOperation[] = [];
      for (const edit of edits) {
         if (SnippetTextEdit.is(edit)) {
            return { applicable: false, reason: `Snippet edits are not supported by this client: ${uri}` };
         }
         operations.push(toEditOperation(edit));
      }
      return { applicable: true, edit: { model, operations } };
   }

   /**
    * Create a model for `uri` holding `text`, and tell the server the document is
    * open. Returns the model this client already holds for the URI; a model
    * another client of this page holds is refused, since this client would
    * neither announce it nor send its changes.
    *
    * **`text` must be the bytes the server already has.** A browser host takes
    * it from the worker's own filesystem, so `didOpen` carries what the heads
    * came up on. Inventing placeholder text would not fail — it would
    * OVERWRITE the server's copy through the text-document store and quietly
    * change the diagnostics the server reports.
    *
    * `didOpen` carries the model's text rather than `text` itself: Monaco drops
    * a BOM and rewrites mixed line endings to the majority form when it builds
    * the model, as any editor does, and a server holding the bytes instead
    * would be one character off every position and never match the buffer a
    * save compares it with.
    *
    * Which is also why the second call for a URI is a no-op rather than a
    * refresh: by then the buffer may hold a server write the snapshot never had,
    * and the snapshot is the older claim.
    *
    * The URI is sent in Monaco's form: `Uri.parse(uri).toString()` encodes a
    * space or a drive-letter colon, and the providers name the document by the
    * model's URI, so a `didOpen` with the host's string would open a document
    * no provider request ever addresses.
    */
   openDocument(uri: string, text: string): monaco.editor.ITextModel {
      const key = monaco.Uri.parse(uri).toString();
      // Idempotent, and that is what makes two panes able to swap content: a
      // model is Monaco's per-URI singleton, so a second `createModel` for the
      // same URI THROWS — and re-announcing `didOpen` would push the host's
      // startup snapshot over whatever the server's copy has since become.
      const held = this.models.get(key);
      const existing = monaco.editor.getModel(monaco.Uri.parse(key));
      if (held !== undefined && existing === held) {
         return held;
      }
      if (held !== undefined) {
         // The host disposed this client's model itself. The server still has
         // the document open, so it is closed there before anything else:
         // a second `didOpen` without a `didClose` is a client out of step.
         this.closeDocument(key);
      }
      if (existing !== null) {
         throw new Error(`A model for ${key} exists that this client did not open`);
      }
      const languageId = this.languageIdFor(key);
      const model = monaco.editor.createModel(text, languageId, monaco.Uri.parse(key));
      this.models.set(key, model);
      // The opened content came out of the server's filesystem, so it is by
      // definition already persisted — a document that reported itself dirty on
      // open would make the first save rewrite every file it did not change.
      this.savedVersions.set(key, model.getAlternativeVersionId());

      notifyUnlessClosed(() =>
         this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: { uri: key, languageId, version: model.getVersionId(), text: model.getValue() }
         })
      );

      // Subscribed before the editor is created, so an editor contribution that
      // touches the model on attach cannot slip a change past the server.
      // Typing goes on after the worker dies: the buffer is the page's.
      model.onDidChangeContent(event => {
         notifyUnlessClosed(() =>
            this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
               textDocument: { uri: key, version: event.versionId },
               contentChanges: toContentChanges(event.changes)
            })
         );
      });
      return model;
   }

   /**
    * Dispose the model for `uri` and tell the server the document is closed, so
    * the server drops this client's shadow of it and stops pushing to it. A URI
    * this client never opened is left alone. An editor still showing the model
    * is the host's to re-point first: Monaco detaches a disposed model from it.
    * A model the host disposed itself is closed on the server all the same,
    * here or by the next {@link openDocument} of its URI.
    *
    * The markers go first: Monaco drops a disposed model's markers only for its
    * own schemes, so a `file:` document reopened later would start with the
    * squiggles the server published before the close.
    *
    * The model goes before `didClose`, and a connection already closed does not
    * fail the call: the page's side of the sync is this client's to release
    * whatever became of the worker, and the server's side ends with its
    * connection.
    */
   closeDocument(uri: string): void {
      const key = monaco.Uri.parse(uri).toString();
      const model = this.models.get(key);
      if (model === undefined) {
         return;
      }
      this.models.delete(key);
      this.savedVersions.delete(key);
      // Cleared whether or not the host disposed the model already: the marker
      // service keys by URI and keeps a disposed `file:` model's markers.
      monaco.editor.setModelMarkers(model, this.markerOwner, []);
      if (!model.isDisposed()) {
         model.dispose();
      }
      notifyUnlessClosed(() => this.connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: key } }));
   }

   /**
    * Close every open document and release every registration, in reverse
    * order, the `workspace/applyEdit` handler included: a later request is
    * answered as an unknown method, as for a client that never registered.
    * The languages stay registered, since Monaco cannot unregister one.
    */
   dispose(): void {
      try {
         for (const uri of [...this.models.keys()]) {
            this.closeDocument(uri);
         }
      } finally {
         for (const registration of this.registrations.splice(0).reverse()) {
            registration.dispose();
         }
      }
   }

   /**
    * Create one editor over `model`, with the settings a server-driven language
    * needs under `options`: the host's theme, layout and chrome spread over
    * them, so a host cannot lose one by spreading in the wrong order.
    *
    * Separate from {@link openDocument} because a host may hold a FIXED number
    * of editors and swap their models rather than create an editor per
    * document. That is what keeps a `didOpen` a statement about the workspace
    * instead of about which pane happens to be showing what.
    *
    * `suggest` is merged one level deep: it is the one nested setting here, and
    * a host's own suggest options would otherwise replace the insert mode the
    * forwarded `InsertReplaceEdit` ranges depend on.
    */
   createEditor(
      container: HTMLElement,
      model: monaco.editor.ITextModel,
      options: monaco.editor.IStandaloneEditorConstructionOptions = {}
   ): monaco.editor.IStandaloneCodeEditor {
      return monaco.editor.create(container, {
         ...LSP_EDITOR_OPTIONS,
         ...options,
         suggest: { ...LSP_EDITOR_OPTIONS.suggest, ...options.suggest },
         model
      });
   }

   /**
    * The open documents whose buffer has moved since it was opened or last
    * saved, with the text to persist.
    *
    * **The editor's buffer is the right source for a save**, not the host's copy
    * of the workspace: a server write reaches this buffer through
    * `workspace/applyEdit`, so Monaco's model is the one place both directions of
    * the sync are already merged.
    *
    * **Dirty rather than every open document, and that is not cosmetic.** A save
    * of an unmodified file writes its current bytes into the backing store, and
    * a store that wins over a seed on the next load would then pin a file nobody
    * changed.
    *
    * `getAlternativeVersionId` rather than `getVersionId`, because it is the one
    * that returns to its old value when an edit is UNDONE — undoing a server
    * write leaves nothing to save, which `getVersionId` (monotonic) would report
    * as a change.
    */
   dirtyDocuments(): EditorDocument[] {
      return [...this.models.keys()].flatMap(uri => this.dirtyDocument(uri) ?? []);
   }

   /**
    * The document at `uri`, in any form, if it has unsaved changes, read from
    * its model alone; nothing for a document that is saved or that this client
    * does not hold.
    */
   dirtyDocument(uri: string): EditorDocument | undefined {
      const key = monaco.Uri.parse(uri).toString();
      const model = this.modelOf(key);
      if (model === undefined) {
         return undefined;
      }
      const version = model.getAlternativeVersionId();
      return version === this.savedVersions.get(key) ? undefined : { uri: key, text: model.getValue(), version, model };
   }

   /** The model this client holds for a URI in any form, if it still exists. */
   protected modelOf(uri: string): monaco.editor.ITextModel | undefined {
      const model = this.models.get(monaco.Uri.parse(uri).toString());
      return model === undefined || model.isDisposed() ? undefined : model;
   }

   /**
    * Run one provider's request. A request nobody wants an answer to any more,
    * since the server gave it up or the connection closed, rejects with
    * Monaco's cancellation, which Monaco drops silently. Any other rejection
    * reaches Monaco, which reports it as an uncaught page error.
    */
   protected async request<R>(send: () => Promise<R>): Promise<R> {
      try {
         return await send();
      } catch (error: unknown) {
         throw isAbandonedRequest(error) ? monacoCancellation() : error;
      }
   }

   /**
    * Whether `model` is one this client opened. Monaco picks a provider by
    * language id, so a second client of the same language is handed this
    * client's models and this client the other's; a request for one of those
    * would name a document this client's server never opened.
    */
   protected owns(model: monaco.editor.ITextModel): boolean {
      return this.models.get(model.uri.toString()) === model;
   }

   /**
    * Record that `document`'s content has been persisted.
    *
    * Takes the document rather than the URI so the version recorded is the one
    * the TEXT was read at: a keystroke landing while the save was in flight must
    * leave the document dirty, and marking it against the buffer's current
    * version would silently swallow that edit. A record of a model since closed
    * marks nothing: a reopened URI is a new model whose versions start over, so
    * the old record's version could name an edit of the new one.
    */
   markSaved(document: EditorDocument): void {
      if (this.models.get(document.uri) === document.model) {
         this.savedVersions.set(document.uri, document.version);
      }
   }

   /**
    * Register one `DocumentSemanticTokensProvider` per language, reading the
    * legend off the `initialize` result.
    *
    * The legend has to come from the server rather than being restated here: it
    * is the index space the token stream is encoded in, so a client legend that
    * merely LOOKS right renders every token as the wrong kind — a colouring bug
    * with no error anywhere. Langium builds it by merging every registered
    * language's provider options, which is why one legend serves them all.
    *
    * Absent capability means no provider at all rather than an empty legend: an
    * empty one would decode every token index to nothing and produce a file with
    * no highlighting, which is what a broken server looks like.
    */
   protected registerSemanticTokens(capabilities: ServerCapabilities): void {
      const legend = capabilities.semanticTokensProvider?.legend;
      if (legend === undefined) {
         return;
      }
      for (const language of this.options.languages) {
         this.registrations.push(
            monaco.languages.registerDocumentSemanticTokensProvider(language.id, {
               getLegend: () => legend,
               provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
                  if (!this.owns(model)) {
                     return null;
                  }
                  const tokens = await this.request(() =>
                     this.connection.sendRequest(SemanticTokensRequest.type, { textDocument: { uri: model.uri.toString() } }, token)
                  );
                  // `data` arrives as a plain array over JSON-RPC; Monaco requires
                  // a `Uint32Array` and reads garbage from anything else.
                  return tokens === null ? null : { data: new Uint32Array(tokens.data), resultId: tokens.resultId };
               },
               // Nothing to release: no `resultId`-keyed state is kept here, because
               // this provider does not implement the delta request.
               releaseDocumentSemanticTokens: () => undefined
            })
         );
      }
   }

   /**
    * Register one `CompletionItemProvider` per language.
    *
    * `triggerCharacters` is taken from the server rather than guessed. It is what
    * makes the list appear on `.` without a letter after it; a client that
    * invents its own set either misses a trigger the grammar defines or asks on a
    * character the server has nothing to say about.
    */
   protected registerCompletion(capabilities: ServerCapabilities): void {
      for (const language of this.options.languages) {
         this.registrations.push(
            monaco.languages.registerCompletionItemProvider(language.id, {
               triggerCharacters: capabilities.completionProvider?.triggerCharacters,
               provideCompletionItems: async (model, position, context, token) => {
                  if (!this.owns(model)) {
                     return { suggestions: [] };
                  }
                  const result = await this.request(() =>
                     this.connection.sendRequest(
                        CompletionRequest.type,
                        {
                           textDocument: { uri: model.uri.toString() },
                           position: toLspPosition(position),
                           context: toCompletionContext(context)
                        },
                        token
                     )
                  );
                  if (result === null) {
                     return { suggestions: [] };
                  }
                  // `CompletionList | CompletionItem[]`, and both forms are live —
                  // Langium answers with a list, but an adopter's own provider is
                  // free to return the array.
                  const items = Array.isArray(result) ? result : result.items;
                  return {
                     suggestions: items.map(item => toCompletionItem(item, model, position)),
                     incomplete: Array.isArray(result) ? undefined : result.isIncomplete
                  };
               }
            })
         );
      }
   }

   /**
    * Register one `HoverProvider` per language.
    *
    * Registered unconditionally rather than behind `capabilities.hoverProvider`,
    * unlike the semantic-token provider above, because the two failure modes are
    * not alike: a hover request a server does not implement answers `null` and
    * Monaco shows nothing, whereas a semantic-token provider without the
    * server's legend would decode the token stream against the wrong index space
    * and mis-colour the file.
    */
   protected registerHover(): void {
      for (const language of this.options.languages) {
         this.registrations.push(
            monaco.languages.registerHoverProvider(language.id, {
               provideHover: async (model, position, token) => {
                  if (!this.owns(model)) {
                     return null;
                  }
                  const hover = await this.request(() =>
                     this.connection.sendRequest(
                        HoverRequest.type,
                        { textDocument: { uri: model.uri.toString() }, position: toLspPosition(position) },
                        token
                     )
                  );
                  if (hover === null) {
                     return null;
                  }
                  return {
                     contents: toMarkdown(hover.contents),
                     range: hover.range === undefined ? undefined : toMonacoRange(hover.range)
                  };
               }
            })
         );
      }
   }

   /**
    * Route a definition target in ANOTHER document to `open`, which answers
    * whether it could show it.
    *
    * **Monaco's standalone editor service can only navigate within the editor
    * that was clicked in**, and it declines the rest by doing nothing: it looks
    * the target resource up on the source editor alone, finds a different model,
    * and returns — no message, no marker, no console line. That is the same
    * observable as a server that resolved no reference, which is what makes the
    * seam worth stating rather than discovering. A host with a workbench behind
    * it supplies this step; a plain page supplies it by hand.
    *
    * `false` from `open` leaves the reader where they are, and that is the
    * honest answer for a target the host holds no text for rather than a
    * failure: a `virtual:` in-code contribution is a document to the server and
    * no file to anyone.
    *
    * **A source editor on a model this client does not own is left to the next
    * opener.** Monaco calls every opener for every editor, so on a page with
    * two clients this one would otherwise claim a jump the other client's
    * server resolved, and hand its host a document that host never opened.
    *
    * **A target in the SOURCE editor's own model is deliberately NOT routed
    * here.** Monaco calls the last-registered opener first and falls through to
    * its own on a `false`, and its own is better for that case: it selects the
    * declaration's whole range where this seam could only place a caret, and it
    * is the path the editor's navigation history is recorded on.
    *
    * Released by {@link dispose} as well as by the returned disposable.
    */
   registerEditorOpener(open: (uri: string, position: monaco.IPosition) => boolean): monaco.IDisposable {
      const registration = monaco.editor.registerEditorOpener({
         openCodeEditor: (source, resource, selectionOrPosition) => {
            const model = source.getModel();
            if (model === null || !this.owns(model) || model.uri.toString() === resource.toString()) {
               return false;
            }
            return open(resource.toString(), toEditorPosition(selectionOrPosition));
         }
      });
      this.registrations.push(registration);
      return registration;
   }

   /**
    * Register one `DefinitionProvider` per language.
    *
    * **This is half of go-to-definition, and on its own it moves nothing for a
    * target in another document.** A provider answers where the declaration is;
    * going there is the host's job, and {@link registerEditorOpener} is the
    * other half. Registered unconditionally, for the reason {@link registerHover}
    * states.
    */
   protected registerDefinition(): void {
      for (const language of this.options.languages) {
         this.registrations.push(
            monaco.languages.registerDefinitionProvider(language.id, {
               provideDefinition: async (model, position, token) => {
                  if (!this.owns(model)) {
                     return null;
                  }
                  const result = await this.request(() =>
                     this.connection.sendRequest(
                        DefinitionRequest.type,
                        { textDocument: { uri: model.uri.toString() }, position: toLspPosition(position) },
                        token
                     )
                  );
                  return result === null ? null : toDefinitionLinks(result);
               }
            })
         );
      }
   }

   /**
    * Register one `DocumentHighlightProvider` per language.
    *
    * **Document-scoped by the protocol, unlike every other reference-following
    * request here**, so it answers what a name does in the file being read
    * rather than where it comes from — the declaration and its uses in one view,
    * with no jump and nothing opened. Registered unconditionally, for the reason
    * {@link registerHover} states.
    */
   protected registerDocumentHighlight(): void {
      for (const language of this.options.languages) {
         this.registrations.push(
            monaco.languages.registerDocumentHighlightProvider(language.id, {
               provideDocumentHighlights: async (model, position, token) => {
                  if (!this.owns(model)) {
                     return null;
                  }
                  const highlights = await this.request(() =>
                     this.connection.sendRequest(
                        DocumentHighlightRequest.type,
                        { textDocument: { uri: model.uri.toString() }, position: toLspPosition(position) },
                        token
                     )
                  );
                  if (highlights === null) {
                     return null;
                  }
                  // An absent kind is `Text` by the protocol, which is also what
                  // Monaco assumes for an absent one — stated rather than left off,
                  // so the default is this client's and not a coincidence.
                  return highlights.map(highlight => ({
                     range: toMonacoRange(highlight.range),
                     kind: HIGHLIGHT_KINDS[highlight.kind ?? DocumentHighlightKind.Text]
                  }));
               }
            })
         );
      }
   }
}

/** The two calls of a data session {@link saveDirtyDocuments} makes, which `DataSession` satisfies. */
export interface DocumentPersister {
   /** Open `args.uri`, run `fn` with the opened document, whose `text` is the server's state of it, and close it after. */
   withOpenDocument<T>(args: { readonly uri: string }, fn: (document: { readonly text?: TextState }) => Promise<T>): Promise<T>;
   persistDocument(args: { readonly uri: string; readonly baseVersion: BaseVersion }): Promise<unknown>;
}

/**
 * Persist the dirty documents of `client`, or those of them `uris` names, in
 * the host's form or Monaco's, through `session`, one after another, and
 * return what was saved.
 *
 * **A save persists; it does not author.** Every keystroke already reached the
 * server as a `didChange`, and every server write reached the buffer as a
 * `workspace/applyEdit`, so the server's text is the buffer and disk is the
 * only thing behind. `persistDocument` at `'any'` writes that text without a
 * model: a write of the buffer's text would be authored against no read, so
 * no `ModelVersion` could gate it, and `'any'` on such a write could put an
 * older buffer over a server write still in flight.
 *
 * **The open's text hash is the gate.** A `didChange` travels the LSP port and
 * the persist the data port, and nothing orders one port's messages before
 * the other's, so the open can answer with text a keystroke has not reached.
 * The open answer's hash is `textHash` of the server's text; when it is not
 * the buffer's, the save throws, naming the document, and the document stays
 * dirty for the next save. A keystroke landing after the open persists as
 * newer text, which leaves the buffer dirty the same way.
 *
 * Each document's text is read just before its own open, not once for the
 * set: an earlier document's persist takes time, and a keystroke in a later
 * one during it would otherwise fail that one's hash check for nothing. Each
 * is marked saved at the version its text was read at, one at a time, so a
 * failure part-way through leaves the documents it never reached dirty and a
 * second call retries exactly those. Sequential, not concurrent: each persist
 * runs over the server's shared store.
 */
export async function saveDirtyDocuments(
   client: MonacoLspClient,
   session: DocumentPersister,
   uris?: readonly string[]
): Promise<EditorDocument[]> {
   const wanted = uris?.map(uri => monaco.Uri.parse(uri).toString());
   const dirty = client.dirtyDocuments().filter(document => wanted === undefined || wanted.includes(document.uri));
   const saved: EditorDocument[] = [];
   for (const { uri } of dirty) {
      // Read again now: an undo during an earlier save may have cleaned it.
      const document = client.dirtyDocument(uri);
      if (document === undefined) {
         continue;
      }
      await session.withOpenDocument({ uri }, opened => {
         if (opened.text?.hash !== textHash(document.text)) {
            throw new Error(`The server's text for ${uri} differs from the buffer this save read; the document stays unsaved`);
         }
         return session.persistDocument({ uri, baseVersion: 'any' });
      });
      client.markSaved(document);
      saved.push(document);
   }
   return saved;
}
