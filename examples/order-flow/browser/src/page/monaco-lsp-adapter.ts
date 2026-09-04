/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The client half of the LSP head for a Monaco editor, hand-glued over the SAME
 * `MessagePort` the page already holds for diagnostics.
 *
 * # Why this is hand-written rather than `monaco-languageclient`
 *
 * That library drags in the `@codingame/monaco-vscode-*` shim stack, which would
 * destroy the one property that makes this package's bundle worth having: at
 * `platform: 'browser'` esbuild REFUSES a `node:*` builtin rather than shimming
 * it, so the bundle is a stricter neutrality gate than `check:neutral` — it
 * covers the example's real head composition rather than a package's `.` entry.
 * A package whose subject is what its bundle contains should not shim half of
 * VS Code inside it. The cost of the decision is this file.
 *
 * # What the page has to supply that a shell would not
 *
 * A Theia or VS Code integration hands `vscode-languageclient` a document store,
 * a marker service and a provider registry. Here Monaco is all three, and the
 * three translations between it and LSP are the whole of the work:
 *
 * - **Identity.** A Monaco model URI must be string-identical to the LSP URI, or
 *   `publishDiagnostics` addresses a document Monaco does not have and the
 *   markers land nowhere, silently.
 * - **Coordinates.** LSP lines and characters are 0-based; Monaco lines and
 *   columns are 1-based. Every range crossing this file is converted.
 * - **Versions.** Monaco's `versionId` is monotonic per model, which is exactly
 *   what the server's text store wants for its stale-write gate, so it is used
 *   directly rather than counted here in parallel.
 *
 * # `monaco-editor-core`, not `monaco-editor`
 *
 * `monaco-editor` is core PLUS eighty bundled language definitions — Abap,
 * Bicep, Terraform — and a page whose entire subject is that its language comes
 * from a server should not ship a single one of them. `monaco-editor-core`'s
 * `module` entry is `editor.main.js`, which is `editor.all.js` (every editor
 * contribution: the suggest widget, the hover controller, the
 * document-semantic-tokens controller) plus the standalone quick-access
 * commands. One supported specifier, same API surface, no grammars.
 *
 * Trying to reach the same place from `monaco-editor` does not work cleanly:
 * `features/register.all.js` looks like the language-free entry and omits
 * `coreCommands`, `suggestController` and `documentSemanticTokens`, so composing
 * it takes about ten deep-internal specifiers no export map declares. Measured
 * on 0.56: `monaco-editor`'s root entry bundles 9.7 MB unminified against 7.6 MB
 * for that incomplete composition.
 */

import * as monaco from 'monaco-editor-core';
import type { MessageConnection } from 'vscode-jsonrpc/browser';
import {
   type AnnotatedTextEdit,
   type ApplyWorkspaceEditParams,
   ApplyWorkspaceEditRequest,
   type ApplyWorkspaceEditResult,
   type CompletionItem,
   CompletionItemKind,
   CompletionRequest,
   DidChangeTextDocumentNotification,
   DidOpenTextDocumentNotification,
   type PublishDiagnosticsParams,
   type Diagnostic,
   DiagnosticSeverity,
   type Hover,
   HoverRequest,
   InsertTextFormat,
   type MarkupContent,
   type Position as LspPosition,
   type Range as LspRange,
   SemanticTokensRequest,
   type ServerCapabilities,
   SnippetTextEdit,
   type TextDocumentContentChangeEvent,
   TextDocumentEdit,
   type TextEdit,
   type WorkspaceEdit
} from 'vscode-languageserver-protocol';

/**
 * The three order-flow languages, with the extensions their files carry.
 *
 * The ids are Langium's, from `order-flow-server`'s `langium-config.json`, and
 * they must match: the `languageId` on `didOpen` is what the server routes the
 * document to a grammar by, so a plausible-looking `order-flow` for all three
 * would parse a `.layout` file with whichever grammar answered first.
 *
 * No Monarch or TextMate grammar accompanies them, and that is the point of the
 * exercise rather than an omission — highlighting arrives from the server's
 * semantic-token provider, so there is no second definition of the language to
 * drift from the real one.
 */
const ORDER_FLOW_LANGUAGES: readonly { readonly id: string; readonly extension: string }[] = [
   { id: 'order-flow-domain', extension: '.domain' },
   { id: 'order-flow-process', extension: '.process' },
   { id: 'order-flow-layout', extension: '.layout' }
];

/** Owner of the markers this adapter sets, so it can replace its own and no one else's. */
const MARKER_OWNER = 'order-flow-lsp';

/**
 * Monaco's own worker bundle, substituted at build time from the same constant
 * that sets esbuild's `outfile` — the same arrangement, for the same reason, as
 * the head worker's URL.
 */
declare const __MONACO_WORKER_BUNDLE_URL__: string;

/**
 * Tell Monaco where its editor worker is, before any editor is created.
 *
 * **Assigned at module scope on purpose.** Monaco reads `MonacoEnvironment`
 * lazily, on the first request that needs the worker — so an assignment inside
 * the adapter's constructor would still be early enough today and would break
 * the moment anything touched a model first. A global that must be set before an
 * unknowable first read is safest set at import time.
 *
 * `getWorker` rather than `getWorkerUrl`: the URL form is resolved against
 * Monaco's own `baseUrl` notion, which a bundled deployment does not have, while
 * the factory form lets the page construct the worker from a path it derived
 * from the build.
 */
self.MonacoEnvironment = {
   getWorker: () => new Worker(__MONACO_WORKER_BUNDLE_URL__)
};

/**
 * Which of a pair of values a colour scheme selects — the page's whole theming
 * vocabulary, shared by the editors here and the page chrome in `index.html`.
 */
export type ColourScheme = 'light' | 'dark';

/** The two themes the editors run under, by scheme. */
const ORDER_FLOW_THEMES: Readonly<Record<ColourScheme, string>> = {
   light: 'order-flow-light',
   dark: 'order-flow-dark'
};

/**
 * Colours for the semantic token types the order-flow server emits — its
 * `$type` map plus the framework's keyword pass — in both schemes.
 *
 * **In standalone Monaco a theme rule's `token` is matched against the SEMANTIC
 * TOKEN TYPE NAME directly** — `StandaloneTheme.getTokenStyleMetadata` joins the
 * type and its modifiers with `.` and matches that string against these rules.
 * That is not how VS Code works, where a semantic type reaches a colour through
 * `semanticTokenScopes` and a TextMate scope like `entity.name.type.class`. A
 * theme written the VS Code way therefore compiles, loads, and colours nothing:
 * the tokens still arrive and Monaco still splits the line into one span per
 * token, but every span resolves to the editor's default foreground. That is the
 * state this page was in before these rules existed, and it is indistinguishable
 * from the server never having answered.
 *
 * One entry per type the provider can emit, so an unstyled span means the server
 * sent a type nobody here accounted for rather than a theme that is merely thin.
 *
 * **The two schemes are PAIRED in one table rather than written as two theme
 * definitions**, because the failure of two lists is silent and asymmetric: a
 * type added to one and forgotten in the other renders correctly in whichever
 * scheme the author was looking at and defaults to the editor foreground in the
 * other, which is exactly the appearance of a server that did not answer.
 *
 * The values are the built-in themes' own semantic colours (Light Modern and
 * Dark Modern), so a reader comparing this page against VS Code sees the same
 * hue for the same kind of name.
 */
const SEMANTIC_TOKEN_COLOURS: readonly { readonly token: string; readonly light: string; readonly dark: string }[] = [
   // Declarations a field or a reference can name.
   { token: 'class', light: '267f99', dark: '4ec9b0' },
   { token: 'enum', light: '267f99', dark: '4ec9b0' },
   { token: 'enumMember', light: '0070c1', dark: '4fc1ff' },
   { token: 'property', light: '001080', dark: '9cdcfe' },
   // Flow nodes and the process that contains them.
   { token: 'function', light: '795e26', dark: 'dcdcaa' },
   { token: 'label', light: 'af00db', dark: 'c586c0' },
   { token: 'namespace', light: '267f99', dark: '4ec9b0' },
   // Every keyword of all three grammars, from the server's `highlightKeywords`
   // pass. Unlike its neighbours this row changes nothing on screen, and it is
   // here anyway: `inherit: true` pulls in `vs` / `vs-dark`, which already carry
   // a `keyword` rule at these very hex values, so removing the row leaves the
   // keywords blue — measured, and it is why no test can hold this row in place.
   // The invariant above is what it serves. A table that covers every type but
   // one relies on a base theme happening to name that one, and the day it stops
   // the symptom is a page that looks half-highlighted with nothing here to
   // suspect.
   { token: 'keyword', light: '0000ff', dark: '569cd6' }
];

for (const scheme of ['light', 'dark'] as const) {
   monaco.editor.defineTheme(ORDER_FLOW_THEMES[scheme], {
      base: scheme === 'light' ? 'vs' : 'vs-dark',
      // Inherited, so the editor's own colours (selection, line highlight, the
      // squiggle under a diagnostic) come from a complete theme rather than from
      // the rules above.
      inherit: true,
      rules: SEMANTIC_TOKEN_COLOURS.map(colour => ({ token: colour.token, foreground: colour[scheme] })),
      colors: {}
   });
}

/**
 * The scheme the editors are currently in.
 *
 * Module state, matching Monaco's own: `setTheme` is GLOBAL in standalone Monaco
 * — there is no per-editor theme — so tracking it per adapter instance would
 * imply a choice the library cannot honour. Read by {@link MonacoLspAdapter.openEditor}
 * so an editor created after a switch opens in the current scheme rather than in
 * whatever the last `defineTheme` left as the default.
 */
let currentScheme: ColourScheme = 'light';

/**
 * Put both editors into `scheme`.
 *
 * Exported because the switch that drives it is the PAGE's — one control moves
 * the page chrome, the `--order-flow-*` diagram roles and this, and splitting
 * that across three independent toggles is how a themed page ends up
 * half-switched. The page owns the first two because they are CSS; this is the
 * one piece that is not.
 */
export function applyEditorScheme(scheme: ColourScheme): void {
   currentScheme = scheme;
   monaco.editor.setTheme(ORDER_FLOW_THEMES[scheme]);
}

/**
 * The Langium language id for `uri`, by extension.
 *
 * Throws rather than falling back to a default id. An unknown extension means
 * the page named a document the server has no grammar for, and the failure of
 * the guessing version is that the document opens, parses as the wrong language
 * and reports a page of syntax errors that look like the file being broken.
 */
export function languageIdFor(uri: string): string {
   const language = ORDER_FLOW_LANGUAGES.find(candidate => uri.endsWith(candidate.extension));
   if (language === undefined) {
      throw new Error(`No order-flow language for ${uri}`);
   }
   return language.id;
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
      // client is free to decide"), and treating it as a hint would hide the
      // one deliberate error in this workspace behind a barely-visible squiggle.
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
      code: diagnostic.code === undefined ? undefined : String(diagnostic.code)
   };
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

function isMarkupContent(value: unknown): value is MarkupContent {
   return typeof value === 'object' && value !== null && 'kind' in value && 'value' in value;
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
      return [{ value: contents.value }];
   }
   const blocks = Array.isArray(contents) ? contents : [contents];
   return blocks.map(block =>
      typeof block === 'string' ? { value: block } : { value: `\`\`\`${block.language}\n${block.value}\n\`\`\`` }
   );
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
 * to `replace` here would silently overrule a setting the reader can see in the
 * editor options below, and collapsing to `insert` would throw away the wider
 * range the server went to the trouble of computing.
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

function toCompletionItem(
   item: CompletionItem,
   model: monaco.editor.ITextModel,
   position: monaco.IPosition
): monaco.languages.CompletionItem {
   return {
      label: item.label,
      // `Text` for an item with no kind, which is Monaco's plainest icon. LSP
      // leaves the kind optional and Monaco does not.
      kind: item.kind === undefined ? monaco.languages.CompletionItemKind.Text : COMPLETION_KINDS[item.kind],
      insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
      insertTextRules:
         item.insertTextFormat === InsertTextFormat.Snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
      range: toCompletionRange(item, model, position),
      detail: item.detail,
      documentation: isMarkupContent(item.documentation) ? { value: item.documentation.value } : item.documentation,
      sortText: item.sortText,
      filterText: item.filterText,
      // Forwarded rather than dropped: an item that needs a companion edit (an
      // import, a sibling declaration) is silently half-applied without them,
      // and the half that lands is the one that parses.
      additionalTextEdits: item.additionalTextEdits?.map(edit => ({ range: toMonacoRange(edit.range), text: edit.newText }))
   };
}

/** One document's worth of an inbound workspace edit, ready to push into Monaco. */
interface ResolvedDocumentEdit {
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
type EditResolution =
   { readonly applicable: true; readonly edit: ResolvedDocumentEdit } | { readonly applicable: false; readonly reason: string };

/**
 * One LSP text edit as a Monaco edit operation.
 *
 * An `AnnotatedTextEdit` is a plain edit plus a change-annotation id — a hint
 * that a client with a confirmation UI could group and prompt on. This page has
 * no such UI, so the annotation is dropped and the text applied, which is the
 * behaviour LSP prescribes for a client that does not implement
 * `changeAnnotationSupport`. Dropping the EDIT instead would silently lose part
 * of a server write.
 */
function toEditOperation(edit: TextEdit | AnnotatedTextEdit): monaco.editor.IIdentifiedSingleEditOperation {
   return { range: toMonacoRange(edit.range), text: edit.newText };
}

/**
 * The 1-based line of `text`'s first declaration — the first line that is
 * neither blank nor a line comment.
 *
 * DERIVED rather than configured per document, because the alternative is a
 * literal line number in the page that a fixture edit silently invalidates:
 * adding a sentence to `fulfillment.layout`'s header would leave the editor
 * scrolled into the middle of a comment with nothing to say it had. All three
 * order-flow grammars comment with `//` and none has a block-comment form, so
 * one predicate covers them.
 *
 * Falls back to line 1 for a file that is nothing but comments — the honest
 * answer, and the only line such a file has.
 */
function declarationLine(text: string): number {
   const lines = text.split('\n');
   const index = lines.findIndex(line => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('//');
   });
   return index < 0 ? 1 : index + 1;
}

/**
 * Registers the order-flow languages with Monaco and keeps its models in step
 * with the LSP head on the other end of `connection`.
 *
 * Construction registers the languages, the providers and the inbound
 * `workspace/applyEdit` handler; {@link openEditor} opens one document.
 * Diagnostics are NOT subscribed here — see {@link applyDiagnostics}.
 */
/** One open document's content and the buffer version that content was read at. */
export interface EditorDocument {
   readonly uri: string;
   readonly text: string;
   readonly version: number;
}

export class MonacoLspAdapter {
   protected readonly openUris = new Set<string>();
   /** Per URI, the buffer version last known to be persisted. */
   protected readonly savedVersions = new Map<string, number>();

   constructor(
      protected readonly connection: MessageConnection,
      capabilities: ServerCapabilities
   ) {
      for (const language of ORDER_FLOW_LANGUAGES) {
         monaco.languages.register({ id: language.id, extensions: [language.extension] });
      }
      this.registerSemanticTokens(capabilities);
      this.registerCompletion(capabilities);
      this.registerHover();
      this.registerApplyEdit();
   }

   /**
    * Apply one `publishDiagnostics` notification to the model it addresses.
    *
    * **Called by the page's single notification handler rather than subscribing
    * here, and that is forced rather than stylistic.**
    * `MessageConnection.onNotification` stores handlers in a map keyed by method,
    * so a second registration for `textDocument/publishDiagnostics` REPLACES the
    * first and returns a disposable as though it had worked. The page already
    * has a handler for its diagnostics report, so an adapter that registered its
    * own would take that report over and the page's own count would freeze at
    * whatever it had reached — with nothing on the console to say so.
    *
    * A URI with no model is not an error: the workspace has eight documents and
    * the page opens two of them, so most publishes address a file Monaco has
    * never heard of.
    */
   applyDiagnostics(params: PublishDiagnosticsParams): void {
      const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
      if (model === null) {
         return;
      }
      monaco.editor.setModelMarkers(model, MARKER_OWNER, params.diagnostics.map(toMarker));
   }

   /**
    * Answer `workspace/applyEdit` — the diagram→text direction, and the half of
    * the sync a client that only sends `didOpen` silently loses.
    *
    * A server-side write (a diagram drag, a form edit, an integrity repair) goes
    * through the framework's `ModelService`, which rewrites the in-memory text
    * document and then mirrors the settled text to whichever client holds it
    * open, as a MINIMAL `workspace/applyEdit` computed against a shadow of that
    * client's buffer. So the request goes out on every such write the moment the
    * page opens a document — and a client with no handler makes
    * `vscode-jsonrpc` answer `MethodNotFound`, which the framework logs through
    * its tracer and therefore onto `window/logMessage`. A page that has no
    * handler for that either loses the whole inbound direction with nothing on
    * the console, in the editor or in the server's own report to say so. That
    * was the state of this page between the editors landing and this handler.
    *
    * **Registered here rather than in the page, unlike `publishDiagnostics`.**
    * `onRequest` keys handlers by method exactly as `onNotification` does, so a
    * second registration would silently replace this one — but nothing else in
    * this page answers `workspace/applyEdit`, so there is no fan-out to
    * arbitrate, and the handler needs the model store, which is this class's
    * business.
    *
    * **The framework does not gate this on a client capability, measured.**
    * `HydraniumTextDocuments.applyEditToLanguageClient` checks only that an LSP
    * connection is bound, and `vscode-languageserver`'s own
    * `RemoteWorkspaceImpl.applyEdit` forwards unconditionally — so declaring
    * `workspace.applyEdit` in `initialize` does not turn the request on and
    * omitting it does not turn it off. The page declares it anyway, because it
    * is true; what it must not do is rely on the omission to stay quiet.
    *
    * **The echo does not LOOP, and is deliberately not suppressed here — but it
    * is not harmless, and the difference is a server defect rather than a client
    * one.** Applying the edit makes Monaco fire `onDidChangeContent`, which
    * {@link openEditor} turns into a `didChange`. Measured: one drag costs
    * exactly one inbound request and no push follows it, so nothing ping-pongs.
    * What the server then does with that echo is the problem —
    * `HydraniumTextDocuments` applies its INCREMENTAL ranges to a copy already
    * holding the pushed text, so a push that merely replaces a value is
    * idempotent and fine, one that deletes a line yields a transient parse
    * error, and one that INSERTS a line silently duplicates it.
    *
    * Suppressing the echo here would hide that and break something else:
    * `didChange` is what keeps the server's per-URI shadow and its per-client
    * version aligned with this buffer, so withholding it makes the next outbound
    * diff wrong and makes every versioned push arrive stale. A conforming client
    * echoes; the fix belongs on the other side.
    */
   protected registerApplyEdit(): void {
      this.connection.onRequest(ApplyWorkspaceEditRequest.type, (params: ApplyWorkspaceEditParams) => this.applyWorkspaceEdit(params.edit));
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
    * The framework's own egress never exercises that: measured, a palette create
    * that writes both `.process` and `.layout` arrives as TWO requests of one
    * `TextDocumentEdit` each, because `applyEditToLanguageClient` is per-URI and
    * coalesced per-URI. The loop is therefore for an adopter's server that
    * batches, and the all-or-nothing shape is what keeps this client honest for
    * one.
    */
   protected applyWorkspaceEdit(edit: WorkspaceEdit): ApplyWorkspaceEditResult {
      const resolved: ResolvedDocumentEdit[] = [];
      for (const change of edit.documentChanges ?? []) {
         if (!TextDocumentEdit.is(change)) {
            // A create / rename / delete of a FILE. The framework never sends
            // one, and this page has no filesystem of its own to perform it in —
            // the worker's does, and it is not addressable from here. Refused by
            // name so the reason names the operation rather than the shape.
            return { applied: false, failureReason: `Resource operations are not supported by this client: ${change.kind}` };
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
      // egress does not.
      for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
         const resolution = this.resolveDocumentEdit(uri, null, edits);
         if (!resolution.applicable) {
            return { applied: false, failureReason: resolution.reason };
         }
         resolved.push(resolution.edit);
      }

      for (const target of resolved) {
         // `pushEditOperations`, not `setValue`: the edit joins Monaco's undo
         // stack as one entry, so Ctrl+Z reverses a diagram drag from the
         // editor. `setValue` would reset the model — dropping the undo history
         // and the cursor with it, and re-tokenising the whole document for an
         // edit the server went to the trouble of making minimal.
         //
         // `() => null` for the cursor computer: the edit is the SERVER's, not a
         // user gesture, so it must not move a caret the user placed. Returning
         // no selection leaves the cursor where it was.
         target.model.pushEditOperations(null, [...target.operations], () => null);
      }
      return { applied: true };
   }

   /**
    * Resolve one document's worth of an inbound edit against the model it names.
    *
    * Refuses, rather than dropping quietly, in three cases:
    *
    * - **No model for the URI.** This page has an editor for two of the eight
    *   seeded documents and cannot open the rest. `applied: true` for an edit
    *   that went nowhere would leave the server's shadow believing this client
    *   holds text it does not, and every later minimal diff for that URI would
    *   be computed against the wrong baseline. The framework routes writes to
    *   documents the language client has NOT opened into `stagePendingContent`
    *   instead, so this branch should stay unreached — it exists so that if it
    *   is ever reached the failure is loud rather than a slow desynchronisation.
    * - **A stale version.** The framework addresses a position-dependent
    *   (line-keyed) push at the version this client last declared, precisely so
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
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (model === null) {
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
    * open. Returns the existing model if there already is one.
    *
    * **`text` must be the bytes the server already has.** The page takes it from
    * the worker's own filesystem, so `didOpen` carries exactly what the heads came
    * up on. Inventing placeholder text would not fail — it would OVERWRITE the
    * server's copy through the text-document store and quietly change the
    * diagnostics the page reports, which are compared against a Node oracle.
    *
    * Which is also why the second call for a URI is a no-op rather than a
    * refresh: by then the buffer may hold a diagram write the snapshot never had,
    * and the snapshot is the older claim.
    */
   openDocument(uri: string, text: string): monaco.editor.ITextModel {
      // Idempotent, and that is what makes two panes able to swap content: a
      // model is Monaco's per-URI singleton, so a second `createModel` for the
      // same URI THROWS — and re-announcing `didOpen` would push this page's
      // startup snapshot over whatever the server's copy has since become.
      const existing = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (existing !== null) {
         return existing;
      }
      const languageId = languageIdFor(uri);
      const model = monaco.editor.createModel(text, languageId, monaco.Uri.parse(uri));
      this.openUris.add(uri);
      // The opened content came out of the worker's filesystem, so it is by
      // definition already persisted — a document that reported itself dirty on
      // open would make the first save rewrite every file it did not change.
      this.savedVersions.set(uri, model.getAlternativeVersionId());

      this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
         textDocument: { uri, languageId, version: model.getVersionId(), text }
      });

      // Subscribed before the editor is created, so an editor contribution that
      // touches the model on attach cannot slip a change past the server.
      model.onDidChangeContent(event => {
         this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version: event.versionId },
            contentChanges: toContentChanges(event.changes)
         });
      });
      return model;
   }

   /**
    * Create one editor over `model`, with this page's options.
    *
    * Separate from {@link openDocument} because the page holds a FIXED number of
    * editors and swaps their models, rather than creating an editor per document.
    * That is what keeps a `didOpen` a statement about the workspace instead of
    * about which pane happens to be showing what.
    */
   createEditor(container: HTMLElement, model: monaco.editor.ITextModel): monaco.editor.IStandaloneCodeEditor {
      const editor = monaco.editor.create(container, {
         model,
         // The CURRENT scheme, not a fixed name: an editor created after a theme
         // switch would otherwise open in the other one, since `create` takes the
         // theme it is given rather than the global.
         theme: ORDER_FLOW_THEMES[currentScheme],
         automaticLayout: true,
         minimap: { enabled: false },
         scrollBeyondLastLine: false,
         // OFF, and this is a correctness setting rather than a preference.
         // Monaco's word-based suggestions offer every word already in the
         // document as a completion — so in a language whose every identifier is
         // a scoped cross-reference, they propose names that are not in scope at
         // the cursor, mixed indistinguishably into the server's list. They also
         // make the completion e2e untrustworthy: with the LSP provider removed
         // the list would still contain `status` and `PAID`, because those words
         // are on the screen.
         wordBasedSuggestions: 'off',
         // STATED rather than inherited, because the adapter forwards both of an
         // `InsertReplaceEdit`'s ranges and this is the setting that chooses
         // between them. `'replace'` so accepting a suggestion over an existing
         // reference overwrites it — the behaviour a modelling language wants,
         // where an identifier is a whole reference rather than a prefix someone
         // is part-way through typing. Monaco's own default is `'insert'`.
         suggest: { insertMode: 'replace' },
         // `'configuredByTheme'` is the default and would leave highlighting off
         // for the built-in themes, which is indistinguishable from the server
         // never answering the request. Forced on, because in this page the
         // semantic tokens are the ONLY source of highlighting — there is no
         // Monarch grammar underneath to fall back to.
         'semanticHighlighting.enabled': true
      });

      return editor;
   }

   /**
    * Scroll `editor` so its model's declaration sits at the top of the viewport.
    *
    * **A demonstration requirement rather than a nicety.** Every fixture in this
    * workspace opens with a comment block written for a reader of the repository —
    * `fulfillment.layout`'s runs past thirty lines, so its `layout` block starts
    * below the fold of any editor that fits on a page beside a diagram. Left at
    * the top, the editor a diagram write lands in shows nothing but prose and the
    * write appears to change nothing.
    *
    * Scrolled by SCROLL OFFSET rather than through `revealLine*`, and the
    * difference is not cosmetic. Every `reveal` variant, `revealLineNearTop`
    * included, keeps several lines of context above the target — measured, it
    * left the declaration in the middle of the viewport and the file's closing
    * brace and last entries below the fold, which is precisely the region a
    * diagram write appends to. Putting the declaration exactly at the top is
    * the only form that guarantees everything AFTER it is on screen.
    *
    * `scrollBeyondLastLine: false` then does the rest, and it is what makes one
    * anchor right for every file: the offset is clamped to the last screenful of
    * content, so a file whose declaration sits near the end settles on its tail
    * with the brace and room for an appended entry in view, while one with a
    * longer body gets its declaration at the top exactly.
    *
    * **Measure the result rather than trusting it, because Monaco OVER-RENDERS.**
    * Lines just outside the viewport stay in the DOM, so a line that has been
    * scrolled off is still found by a selector and still reports a box — which
    * means neither a query nor a Playwright locator can tell "on screen" from
    * "one line above the top edge", and an automated hover on such a line lands
    * on whatever sits behind the editor.
    */
   revealDeclaration(editor: monaco.editor.IStandaloneCodeEditor): void {
      const model = editor.getModel();
      if (model === null) {
         return;
      }
      editor.setScrollTop(editor.getTopForLineNumber(declarationLine(model.getValue())));
   }

   /**
    * The open documents whose buffer has moved since it was opened or last
    * saved, with the text to persist.
    *
    * **The editor's buffer is the right source for a save**, not the page's copy
    * of the workspace: a diagram write reaches this buffer through
    * `workspace/applyEdit`, so Monaco's model is the one place both directions of
    * the sync are already merged.
    *
    * **Dirty rather than every open document, and that is not cosmetic.** A save
    * of an unmodified file writes its current bytes into the backing store, which
    * pins it there — and the store wins over the seed on the next load, so a
    * later edit to the committed fixture would never reach a reader who once
    * pressed save. Keeping the store a true delta of what was actually changed is
    * what keeps the seed meaningful.
    *
    * `getAlternativeVersionId` rather than `getVersionId`, because it is the one
    * that returns to its old value when an edit is UNDONE — undoing a diagram
    * drag leaves nothing to save, which `getVersionId` (monotonic) would report
    * as a change.
    *
    * A URI in {@link openUris} with no model would be a torn-down editor, which
    * this page never does — skipped rather than thrown on, since a save must not
    * fail wholesale over one document it can no longer read.
    */
   dirtyDocuments(): EditorDocument[] {
      const documents: EditorDocument[] = [];
      for (const uri of this.openUris) {
         const model = monaco.editor.getModel(monaco.Uri.parse(uri));
         const version = model?.getAlternativeVersionId();
         if (model !== null && version !== undefined && version !== this.savedVersions.get(uri)) {
            documents.push({ uri, text: model.getValue(), version });
         }
      }
      return documents;
   }

   /**
    * Record that `document`'s content has been persisted.
    *
    * Takes the document rather than the URI so the version recorded is the one
    * the TEXT was read at: a keystroke landing while the save was in flight must
    * leave the document dirty, and marking it against the buffer's current
    * version would silently swallow that edit.
    */
   markSaved(document: EditorDocument): void {
      this.savedVersions.set(document.uri, document.version);
   }

   /**
    * Register one `DocumentSemanticTokensProvider` per language, reading the
    * legend off the `initialize` result.
    *
    * The legend has to come from the server rather than being restated here: it
    * is the index space the token stream is encoded in, so a client legend that
    * merely LOOKS right renders every token as the wrong kind — a colouring bug
    * with no error anywhere. Langium builds it by merging every registered
    * language's provider options, which is why one legend serves all three.
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
      for (const language of ORDER_FLOW_LANGUAGES) {
         monaco.languages.registerDocumentSemanticTokensProvider(language.id, {
            getLegend: () => legend,
            provideDocumentSemanticTokens: async model => {
               const tokens = await this.connection.sendRequest(SemanticTokensRequest.type, {
                  textDocument: { uri: model.uri.toString() }
               });
               // `data` arrives as a plain array over JSON-RPC; Monaco requires
               // a `Uint32Array` and reads garbage from anything else.
               return tokens === null ? null : { data: new Uint32Array(tokens.data), resultId: tokens.resultId };
            },
            // Nothing to release: no `resultId`-keyed state is kept here, because
            // this provider does not implement the delta request.
            releaseDocumentSemanticTokens: () => undefined
         });
      }
   }

   /**
    * Register one `CompletionItemProvider` per language.
    *
    * **Completion is the reason a text editor earns its place on this page.**
    * `writes Order.status = PAID` is three references, each scoped by the
    * previous one: `status` is offered only because `Order` resolved, and `PAID`
    * only because `status` is typed `OrderStatus`. Nothing else here makes the
    * framework's scope chain visible — a diagram shows the result of resolution,
    * a diagnostic shows its failure, and only completion shows the candidate set
    * it was drawn from.
    *
    * `triggerCharacters` is taken from the server rather than guessed. It is what
    * makes the list appear on `.` without a letter after it; a client that
    * invents its own set either misses a trigger the grammar defines or asks on a
    * character the server has nothing to say about.
    */
   protected registerCompletion(capabilities: ServerCapabilities): void {
      for (const language of ORDER_FLOW_LANGUAGES) {
         monaco.languages.registerCompletionItemProvider(language.id, {
            triggerCharacters: capabilities.completionProvider?.triggerCharacters,
            provideCompletionItems: async (model, position) => {
               const result = await this.connection.sendRequest(CompletionRequest.type, {
                  textDocument: { uri: model.uri.toString() },
                  position: toLspPosition(position)
               });
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
         });
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
      for (const language of ORDER_FLOW_LANGUAGES) {
         monaco.languages.registerHoverProvider(language.id, {
            provideHover: async (model, position) => {
               const hover = await this.connection.sendRequest(HoverRequest.type, {
                  textDocument: { uri: model.uri.toString() },
                  position: toLspPosition(position)
               });
               if (hover === null) {
                  return null;
               }
               return {
                  contents: toMarkdown(hover.contents),
                  range: hover.range === undefined ? undefined : toMonacoRange(hover.range)
               };
            }
         });
      }
   }
}
