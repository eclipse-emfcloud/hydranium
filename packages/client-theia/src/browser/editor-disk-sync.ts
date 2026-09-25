/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { SystemClock, TIMED_OUT } from '@hydranium/protocol';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ILogger } from '@theia/core/lib/common/logger';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import type { FileResourceVersion } from '@theia/filesystem/lib/browser/file-resource';
import { FileService, type TextFileContent } from '@theia/filesystem/lib/browser/file-service';
import { Clock } from '../common/clock';

/**
 * The members of Theia's Monaco editor model {@link EditorDiskSync} reads and
 * resets. `contentChanges`, `resourceVersion` and `run` are `protected` there,
 * so {@link isResyncableEditorDocument} checks for them at runtime: a Theia
 * that renames them yields a document it refuses, and the sync then leaves it
 * alone.
 */
export interface ResyncableEditorDocument {
   readonly uri: string;
   readonly dirty: boolean;
   getText(): string;
   revert(options: { soft: boolean }): Promise<void>;
   /** The edits the next save applies to the file, in place of the whole text. */
   readonly contentChanges: unknown[];
   /** The file version the next save expects to find on disk. */
   resourceVersion: FileResourceVersion | undefined;
   /** Queue `operation` behind the model's saves and syncs in progress. */
   run(operation: () => Promise<void>): Promise<void>;
   /** Awaited by each save before it takes the pending edits. */
   onModelWillSaveModel(listener: () => Promise<void>): { dispose(): void };
}

/** Whether `document` carries the members of {@link ResyncableEditorDocument}. */
export function isResyncableEditorDocument(document: object): document is ResyncableEditorDocument {
   return (
      'uri' in document &&
      typeof document.uri === 'string' &&
      'dirty' in document &&
      'getText' in document &&
      typeof document.getText === 'function' &&
      'revert' in document &&
      typeof document.revert === 'function' &&
      'contentChanges' in document &&
      Array.isArray(document.contentChanges) &&
      'resourceVersion' in document &&
      'run' in document &&
      typeof document.run === 'function' &&
      'onModelWillSaveModel' in document &&
      typeof document.onModelWillSaveModel === 'function'
   );
}

/**
 * Keeps a dirty editor's save from applying edits its file already holds, as
 * the file does once the server saves a document the editor shows unsaved.
 *
 * Theia keeps such an editor dirty, and its next save corrupts the file: the
 * save applies the editor's pending edits to the file rather than writing the
 * whole text, and the file already holds them, so each is applied twice.
 * Theia's check that the file has not changed since the editor read it passes
 * whenever the new file has the old one's size, so no conflict is reported. A
 * revert alone keeps the pending edits.
 *
 * Before each save of the editor it reads the file. When the file holds the
 * text the buffer held as the save began, it drops the edits pending then and
 * has the save expect the file's version, so the save writes only the edits
 * made after that point, a save participant's included, onto the file as it
 * is. The save is not cancelled: it completes and is reported as saved. Save
 * All relies on this check, since it saves a diagram and then an editor on the
 * same file at once, before the file watcher has reported the diagram's write.
 * The buffer is taken when the save calls its will-save listeners. Theia runs
 * its save participants one after another, each behind an await, and its
 * first one awaits before it edits, so none has changed the buffer by then. A
 * participant ordered ahead of it that edits before its first await makes the
 * file and the taken text differ, and the save applies every edit again.
 *
 * On each change the file watcher reports, it marks the editor clean when the
 * file holds exactly its buffer. The file is compared with the buffer after
 * it has been read, and the editor is marked in the same step, so a keystroke
 * made while the file was read leaves the editor dirty. This sync waits behind
 * a save in flight: that save drops the edits it sent from the pending ones
 * when it finishes, and a sync before then would have it drop the edits typed
 * meanwhile.
 *
 * An editor whose file holds neither text is left to Theia's own save,
 * same-size gap included, and so is one whose file cannot be read within
 * {@link readTimeoutMs}, or whose check throws.
 *
 * The adopter binds it as a `FrontendApplicationContribution`.
 */
@injectable()
export class EditorDiskSync implements FrontendApplicationContribution {
   @inject(FileService) protected readonly fileService!: FileService;
   @inject(EditorManager) protected readonly editorManager!: EditorManager;
   @inject(ILogger) protected readonly logger!: ILogger;
   /** Times {@link readTimeoutMs}: the container's {@link Clock}, or a `SystemClock`. */
   @inject(Clock) @optional() protected readonly clock: Clock = new SystemClock();
   /** Whether an editor's document has failed {@link isResyncableEditorDocument}; warned of once. */
   protected warnedUnsyncable = false;
   /**
    * How long a check waits for the file. The editor's save, and every later
    * save and sync of that editor, waits for the check.
    */
   protected readTimeoutMs = 1_000;

   onStart(): void {
      this.fileService.onDidFilesChange(event => {
         for (const change of event.changes) {
            this.checkFile(change.resource);
         }
      });
      this.editorManager.onCreated(widget => this.guardSaves(widget));
      for (const widget of this.editorManager.all) {
         this.guardSaves(widget);
      }
   }

   /** Check `widget`'s document before each of its saves, for as long as the widget lives. */
   protected guardSaves(widget: EditorWidget): void {
      const document = this.resyncable(widget.editor.document);
      if (document) {
         const registration = document.onModelWillSaveModel(() => this.isolate(() => this.dropChangesOnDisk(document)));
         widget.onDidDispose(() => registration.dispose());
      }
   }

   /** Check each dirty document an editor shows on `uri`, behind that document's save in flight. */
   protected checkFile(uri: URI): void {
      for (const document of this.dirtyDocuments(uri)) {
         void document.run(() => this.isolate(() => this.syncIfOnDisk(document)));
      }
   }

   /** Read the file of `document` if it is dirty, and sync it if the file holds its buffer. */
   protected async syncIfOnDisk(document: ResyncableEditorDocument): Promise<void> {
      if (!document.dirty) {
         return;
      }
      const content = await this.readFile(document);
      if (content && document.getText() === content.value) {
         this.syncFromDisk(document, { etag: content.etag, mtime: content.mtime, encoding: content.encoding });
      }
   }

   /**
    * Before a save of `document`, drop the edits pending now if its file holds
    * the buffer as it is now, and take the file's version. The buffer and the
    * count are taken before the first await, while the save is still calling
    * its will-save listeners; an edit made after that stays pending, and the
    * save writes it onto the file.
    */
   protected async dropChangesOnDisk(document: ResyncableEditorDocument): Promise<void> {
      if (!document.dirty) {
         return;
      }
      const text = document.getText();
      const pending = document.contentChanges.length;
      const content = await this.readFile(document);
      if (content?.value === text) {
         document.contentChanges.splice(0, pending);
         document.resourceVersion = { etag: content.etag, mtime: content.mtime, encoding: content.encoding };
      }
   }

   /**
    * The file of `document`, or `undefined` when it is gone, cannot be read, or
    * is not read within {@link readTimeoutMs}.
    */
   protected async readFile(document: ResyncableEditorDocument): Promise<TextFileContent | undefined> {
      const read = this.fileService.read(new URI(document.uri)).catch(() => undefined);
      const content = await this.clock.raceTimer(read, this.readTimeoutMs);
      return content === TIMED_OUT ? undefined : content;
   }

   /**
    * Run `check`, and log its failure rather than pass it on. A will-save
    * listener that rejects makes Theia drop the save without writing, and a
    * sync that rejects goes unhandled.
    */
   protected async isolate(check: () => Promise<void>): Promise<void> {
      try {
         await check();
      } catch (err: unknown) {
         void this.logger.error('EditorDiskSync: checking an editor against its file failed; the editor is left as it is.', err);
      }
   }

   /** The dirty documents open in an editor on `uri`, each once however many editors show it. */
   protected dirtyDocuments(uri: URI): ResyncableEditorDocument[] {
      const target = uri.toString();
      const documents = new Set<ResyncableEditorDocument>();
      for (const widget of this.editorManager.all) {
         const document = this.resyncable(widget.editor.document);
         if (document && document.uri === target && document.dirty) {
            documents.add(document);
         }
      }
      return [...documents];
   }

   /** `document` if it carries the members the sync resets; otherwise `undefined`, warned of once. */
   protected resyncable(document: object): ResyncableEditorDocument | undefined {
      if (isResyncableEditorDocument(document)) {
         return document;
      }
      if (!this.warnedUnsyncable) {
         this.warnedUnsyncable = true;
         void this.logger.warn(
            'EditorDiskSync: an editor document lacks the Monaco model members the sync resets, so such editors are not synced with their files.'
         );
      }
      return undefined;
   }

   /**
    * Take `version` as the file `document` was last saved to, with nothing
    * pending, and mark it clean. Synchronous throughout: a soft revert only
    * marks the document clean, and reads nothing. The revert also cancels a
    * save queued behind the sync, which would have written the same text.
    */
   protected syncFromDisk(document: ResyncableEditorDocument, version: FileResourceVersion): void {
      document.contentChanges.splice(0, document.contentChanges.length);
      document.resourceVersion = version;
      void document.revert({ soft: true });
   }
}
