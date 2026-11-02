/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `monaco-editor-core` for Node: the model store, the registrations and the
 * editor factory the client reaches, over Monaco's real enums and `Uri`.
 * A model reports each change's range against the text before the edit, in
 * the order given, as Monaco does.
 */

import type * as monaco from 'monaco-editor-core';
import { URI } from 'monaco-editor-core/esm/vs/base/common/uri.js';
import {
   CompletionItemInsertTextRule,
   CompletionItemKind,
   CompletionItemTag,
   CompletionTriggerKind,
   DocumentHighlightKind,
   EditorOption,
   MarkerSeverity,
   MarkerTag
} from 'monaco-editor-core/esm/vs/editor/common/standalone/standaloneEnums.js';

export interface RecordedEdit {
   readonly range: monaco.IRange;
   readonly text: string;
}

export interface RecordedProvider {
   readonly kind: string;
   readonly languageId: string;
   readonly provider: unknown;
}

export const models = new Map<string, TextModelDouble>();
export const registeredLanguages: monaco.languages.ILanguageExtensionPoint[] = [];
export const providers: RecordedProvider[] = [];
export const openers: monaco.editor.ICodeEditorOpener[] = [];
export const editors: EditorDouble[] = [];
const createListeners = new Set<(created: monaco.editor.ICodeEditor) => void>();
export const markers = new Map<string, monaco.editor.IMarkerData[]>();
/** What a model's listeners threw, which Monaco's emitter reports rather than rethrows. */
export const unexpectedErrors: unknown[] = [];

export function reset(): void {
   models.clear();
   registeredLanguages.length = 0;
   providers.length = 0;
   openers.length = 0;
   editors.length = 0;
   createListeners.clear();
   markers.clear();
   unexpectedErrors.length = 0;
}

function offsetAt(text: string, lineNumber: number, column: number): number {
   const lines = text.split('\n');
   let offset = 0;
   for (let i = 0; i < lineNumber - 1; i++) {
      offset += (lines[i] ?? '').length + 1;
   }
   return offset + column - 1;
}

function fullRange(text: string): monaco.IRange {
   const lines = text.split('\n');
   return { startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: (lines[lines.length - 1] ?? '').length + 1 };
}

export class TextModelDouble {
   private value: string;
   private versionId = 1;
   private alternativeVersionId = 1;
   private readonly history: { value: string; alternativeVersionId: number }[] = [];
   private readonly listeners = new Set<(event: monaco.editor.IModelContentChangedEvent) => void>();
   private readonly willDispose = new Set<() => void>();
   /** Every `pushEditOperations` call, as the operations it carried. */
   readonly pushed: RecordedEdit[][] = [];
   /** Every undo-stack call in order, so a test can see an edit bracketed by its undo stops. */
   readonly stackCalls: ('pushStackElement' | 'pushEditOperations')[] = [];
   disposed = false;
   /** Per owner, the markers drawn on the model, which Monaco drops with every decoration on `setValue`. */
   readonly drawnMarkers = new Map<string, monaco.editor.IMarkerData[]>();

   constructor(
      value: string,
      private readonly languageId: string,
      readonly uri: monaco.Uri
   ) {
      this.value = value;
   }

   getValue(): string {
      this.assertNotDisposed();
      return this.value;
   }

   getVersionId(): number {
      this.assertNotDisposed();
      return this.versionId;
   }

   getAlternativeVersionId(): number {
      this.assertNotDisposed();
      return this.alternativeVersionId;
   }

   getLanguageId(): string {
      return this.languageId;
   }

   onDidChangeContent(listener: (event: monaco.editor.IModelContentChangedEvent) => void): monaco.IDisposable {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
   }

   onWillDispose(listener: () => void): monaco.IDisposable {
      this.willDispose.add(listener);
      return { dispose: () => this.willDispose.delete(listener) };
   }

   pushEditOperations(
      _beforeCursorState: monaco.Selection[] | null,
      editOperations: monaco.editor.IIdentifiedSingleEditOperation[],
      _cursorStateComputer: unknown
   ): null {
      this.assertNotDisposed();
      const edits = editOperations.map(operation => ({ range: operation.range, text: operation.text ?? '' }));
      this.pushed.push(edits);
      this.stackCalls.push('pushEditOperations');
      this.edit(edits);
      return null;
   }

   pushStackElement(): void {
      this.stackCalls.push('pushStackElement');
   }

   /** One edit, every range read against the text before it. */
   edit(edits: readonly RecordedEdit[]): void {
      this.assertNotDisposed();
      this.history.push({ value: this.value, alternativeVersionId: this.alternativeVersionId });
      const before = this.value;
      const changes = edits.map(edit => {
         const start = offsetAt(before, edit.range.startLineNumber, edit.range.startColumn);
         const end = offsetAt(before, edit.range.endLineNumber, edit.range.endColumn);
         return { range: edit.range, rangeOffset: start, rangeLength: end - start, text: edit.text };
      });
      let text = before;
      for (const change of [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset)) {
         text = text.slice(0, change.rangeOffset) + change.text + text.slice(change.rangeOffset + change.rangeLength);
      }
      this.value = text;
      this.versionId++;
      this.alternativeVersionId++;
      this.fire(changes, false);
   }

   /** Replace the whole text, normalized as `createModel` does, as a flush that clears the undo stack. */
   setValue(value: string): void {
      this.assertNotDisposed();
      const before = this.value;
      this.value = normalizeText(value);
      this.versionId++;
      this.alternativeVersionId = this.versionId;
      this.history.length = 0;
      this.drawnMarkers.clear();
      this.fire([{ range: fullRange(before), rangeOffset: 0, rangeLength: before.length, text: this.value }], false, true);
   }

   /** Undo the last edit: the alternative version id returns, the version id moves on. */
   undo(): void {
      const previous = this.history.pop();
      if (previous === undefined) {
         return;
      }
      const before = this.value;
      this.value = previous.value;
      this.alternativeVersionId = previous.alternativeVersionId;
      this.versionId++;
      this.fire([{ range: fullRange(before), rangeOffset: 0, rangeLength: before.length, text: this.value }], true);
   }

   getWordUntilPosition(position: monaco.IPosition): monaco.editor.IWordAtPosition {
      this.assertNotDisposed();
      const line = this.value.split('\n')[position.lineNumber - 1] ?? '';
      const word = /[\w$]+$/.exec(line.slice(0, position.column - 1))?.[0] ?? '';
      return { word, startColumn: position.column - word.length, endColumn: position.column };
   }

   isDisposed(): boolean {
      return this.disposed;
   }

   /**
    * Fires `onWillDispose` once, after the model leaves the lookup and before
    * it counts as disposed, and reports a listener's throw without rethrowing
    * it, as Monaco does.
    */
   dispose(): void {
      models.delete(this.uri.toString());
      for (const listener of this.willDispose) {
         try {
            listener();
         } catch (error: unknown) {
            unexpectedErrors.push(error);
         }
      }
      this.willDispose.clear();
      this.disposed = true;
   }

   /** Monaco's model throws on a read or an edit once disposed. */
   private assertNotDisposed(): void {
      if (this.disposed) {
         throw new Error('Model is disposed!');
      }
   }

   private fire(changes: monaco.editor.IModelContentChange[], isUndoing: boolean, isFlush = false): void {
      const event = {
         changes,
         eol: '\n',
         versionId: this.versionId,
         isUndoing,
         isRedoing: false,
         isFlush,
         isEolChange: false,
         detailedReasonsChangeLengths: []
      } as monaco.editor.IModelContentChangedEvent;
      for (const listener of this.listeners) {
         listener(event);
      }
   }
}

/**
 * What Monaco's text buffer builder makes of a model's initial text: the BOM
 * dropped, and every line ending rewritten to the majority form, `\r\n` only
 * when more than half the lines end in it.
 */
function normalizeText(value: string): string {
   const text = value.startsWith('\uFEFF') ? value.slice(1) : value;
   const endings = text.match(/\r\n|\r|\n/g) ?? [];
   const withCarriageReturn = endings.filter(ending => ending !== '\n').length;
   const eol = withCarriageReturn > endings.length / 2 ? '\r\n' : '\n';
   return text.replace(/\r\n|\r|\n/g, eol);
}

function registration(kind: string, languageId: string, provider: unknown): monaco.IDisposable {
   const entry = { kind, languageId, provider };
   providers.push(entry);
   return {
      dispose: () => {
         const index = providers.indexOf(entry);
         if (index >= 0) {
            providers.splice(index, 1);
         }
      }
   };
}

export const languages = {
   CompletionItemKind,
   CompletionItemInsertTextRule,
   CompletionItemTag,
   CompletionTriggerKind,
   DocumentHighlightKind,
   register: (language: monaco.languages.ILanguageExtensionPoint): void => {
      registeredLanguages.push(language);
   },
   registerDocumentSemanticTokensProvider: (languageId: string, provider: unknown) => registration('semanticTokens', languageId, provider),
   registerCompletionItemProvider: (languageId: string, provider: unknown) => registration('completion', languageId, provider),
   registerHoverProvider: (languageId: string, provider: unknown) => registration('hover', languageId, provider),
   registerDefinitionProvider: (languageId: string, provider: unknown) => registration('definition', languageId, provider),
   registerDocumentHighlightProvider: (languageId: string, provider: unknown) => registration('documentHighlight', languageId, provider)
};

/**
 * A double as the Monaco type it stands in for. It implements only the
 * members the client calls, and `Partial` checks each of those against
 * Monaco's own signature.
 */
export function asMonaco<T>(double: Partial<T>): T {
   return double as T;
}

/** An editor as Monaco orders it: `onDidCreateEditor` first, then the model, and a disposed model detaches. */
export class EditorDouble {
   readOnly: boolean;
   disposed = false;
   private model: monaco.editor.ITextModel | null = null;
   private detach: monaco.IDisposable | undefined;
   private readonly modelListeners = new Set<(event: monaco.editor.IModelChangedEvent) => void>();
   private readonly disposeListeners = new Set<() => void>();

   constructor(readonly options: monaco.editor.IStandaloneEditorConstructionOptions) {
      this.readOnly = options.readOnly ?? false;
   }

   getModel(): monaco.editor.ITextModel | null {
      return this.model;
   }

   setModel(model: monaco.editor.ITextModel | null): void {
      if (model === this.model) {
         return;
      }
      const event = { oldModelUrl: this.model?.uri ?? null, newModelUrl: model?.uri ?? null };
      this.detach?.dispose();
      this.model = model;
      this.detach = model?.onWillDispose(() => this.setModel(null));
      for (const listener of [...this.modelListeners]) {
         listener(event);
      }
   }

   /** How many listeners are subscribed to the editor's events. */
   get listenerCount(): number {
      return this.modelListeners.size + this.disposeListeners.size;
   }

   onDidChangeModel(listener: (event: monaco.editor.IModelChangedEvent) => void): monaco.IDisposable {
      this.modelListeners.add(listener);
      return { dispose: () => this.modelListeners.delete(listener) };
   }

   onDidDispose(listener: () => void): monaco.IDisposable {
      this.disposeListeners.add(listener);
      return { dispose: () => this.disposeListeners.delete(listener) };
   }

   /** Only `readOnly` is modelled. */
   getOption<T extends monaco.editor.EditorOption>(id: T): monaco.editor.FindComputedEditorOptionValueById<T> {
      if (id !== EditorOption.readOnly) {
         throw new Error(`The double models only readOnly, not option ${id}`);
      }
      return this.readOnly as monaco.editor.FindComputedEditorOptionValueById<T>;
   }

   updateOptions(options: monaco.editor.IEditorOptions): void {
      this.readOnly = options.readOnly ?? this.readOnly;
   }

   dispose(): void {
      this.disposed = true;
      for (const listener of [...this.disposeListeners]) {
         listener();
      }
      this.modelListeners.clear();
      this.disposeListeners.clear();
   }
}

export const editor = {
   getModel: (uri: monaco.Uri): monaco.editor.ITextModel | null => {
      const model = models.get(uri.toString());
      return model === undefined ? null : asMonaco<monaco.editor.ITextModel>(model);
   },
   createModel: (value: string, language: string | undefined, uri: monaco.Uri): monaco.editor.ITextModel => {
      if (models.has(uri.toString())) {
         throw new Error('ModelService: Cannot add model because it already exists!');
      }
      const model = new TextModelDouble(normalizeText(value), language ?? 'plaintext', uri);
      models.set(uri.toString(), model);
      return asMonaco<monaco.editor.ITextModel>(model);
   },
   setModelMarkers: (model: monaco.editor.ITextModel, owner: string, data: monaco.editor.IMarkerData[]): void => {
      markers.set(`${owner} ${model.uri.toString()}`, data);
      models.get(model.uri.toString())?.drawnMarkers.set(owner, data);
   },
   create: (_container: HTMLElement, options: monaco.editor.IStandaloneEditorConstructionOptions): monaco.editor.IStandaloneCodeEditor => {
      const created = new EditorDouble(options);
      editors.push(created);
      for (const listener of [...createListeners]) {
         listener(asMonaco<monaco.editor.ICodeEditor>(created));
      }
      created.setModel(options.model ?? null);
      return asMonaco<monaco.editor.IStandaloneCodeEditor>(created);
   },
   getEditors: (): monaco.editor.ICodeEditor[] =>
      editors.filter(created => !created.disposed).map(created => asMonaco<monaco.editor.ICodeEditor>(created)),
   onDidCreateEditor: (listener: (created: monaco.editor.ICodeEditor) => void): monaco.IDisposable => {
      createListeners.add(listener);
      return { dispose: () => createListeners.delete(listener) };
   },
   EditorOption,
   registerEditorOpener: (opener: monaco.editor.ICodeEditorOpener): monaco.IDisposable => {
      openers.push(opener);
      return {
         dispose: () => {
            const index = openers.indexOf(opener);
            if (index >= 0) {
               openers.splice(index, 1);
            }
         }
      };
   }
};

export const Uri = URI;
export { MarkerSeverity, MarkerTag };
