/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The page's three editors: two FIXED on the documents the diagram is a view of,
 * and one that shows whatever the workspace list last selected.
 *
 * # Why the pair is fixed
 *
 * **The subject of this page is a MULTI-DOCUMENT store**, and every claim it
 * makes is about a RELATIONSHIP between two documents: a diagram drag rewriting
 * `.layout` while leaving `.process` alone, a rename reaching both in one
 * operation, a save writing one file of the two that are open. None of those is
 * observable with a single document on screen — which is why a tab strip would be
 * the wrong shape here, and why neither of the pair may be swapped out by a
 * selection. A sidebar click that displaced `.process` would leave the diagram
 * above it drawing a model no longer visible, and the reader with no way back
 * except to find the file again.
 *
 * So the pair sits under the canvas, `.process` for the semantics it draws and
 * `.layout` for the coordinates a drag rewrites, and selection drives a third
 * editor beside the list that drives it.
 *
 * # Why a third rather than a fourth
 *
 * One place to look things up in is what the workspace list needs to be worth
 * having. A second would divide the width again without making any further
 * relationship visible, and this page already competes for space with a diagram.
 */

import type * as monaco from 'monaco-editor-core';
import { requireElement } from './dom.js';
import type { VisibleDocuments } from './workspace-panel.js';
import type { MonacoLspAdapter } from './monaco-lsp-adapter.js';

/** One editor: its title element, its Monaco instance, and what is in it. */
interface Pane {
   readonly title: HTMLElement;
   readonly editor: monaco.editor.IStandaloneCodeEditor;
   /** The document currently in it, by path under the workspace root. */
   path: string;
}

export interface EditorAreaOptions {
   readonly adapter: MonacoLspAdapter;
   /** Content by path, as the worker's filesystem holds it. */
   readonly files: Readonly<Record<string, string>>;
   readonly rootUri: string;
   /** The documents the diagram is a view of. Pinned; never swapped. */
   readonly fixed: readonly [string, string];
   /** What the selection editor opens on. */
   readonly initialSelection: string;
   /** Called whenever the visible set changes, so the document list can mark it. */
   readonly onVisibleChanged: (visible: VisibleDocuments) => void;
}

export class EditorArea {
   private readonly fixed: readonly [Pane, Pane];
   private readonly selected: Pane;

   /**
    * Per URI, the last cursor and scroll position, so a document returning to
    * the selection editor comes back where it was.
    *
    * Monaco does NOT keep this across `setModel`: view state lives on the editor,
    * not the model, so showing a document twice loses the position silently and
    * the reader lands back at the declaration every time.
    */
   private readonly viewStates = new Map<string, monaco.editor.ICodeEditorViewState>();

   /** URIs already scrolled to their declaration, which is a one-time reveal. */
   private readonly revealed = new Set<string>();

   constructor(private readonly options: EditorAreaOptions) {
      this.fixed = [
         this.mount('process-editor', 'process-editor-title', options.fixed[0]),
         this.mount('layout-editor', 'layout-editor-title', options.fixed[1])
      ];
      this.selected = this.mount('selected-editor', 'selected-editor-title', options.initialSelection);
      this.announce();
   }

   /**
    * Show `path` in the selection editor.
    *
    * A document already in one of the FIXED panes is focused where it is rather
    * than opened a second time: two editors over one Monaco model share the model
    * but not the cursor, so the reader would be typing into whichever copy they
    * last clicked with no way to tell them apart.
    */
   show(path: string): void {
      const fixed = this.fixed.find(pane => pane.path === path);
      if (fixed !== undefined) {
         fixed.editor.focus();
         return;
      }
      if (path !== this.selected.path) {
         this.load(this.selected, path);
         this.announce();
      }
      this.selected.editor.focus();
   }

   /**
    * Show `path` and put the cursor on `line`.
    *
    * `revealLineInCenter` rather than the top-anchored scroll the initial reveal
    * uses: a diagnostic is a POINT the reader wants context around, where a
    * declaration is the start of a region they want all of.
    */
   reveal(path: string, line: number): void {
      this.show(path);
      const pane = this.fixed.find(candidate => candidate.path === path) ?? this.selected;
      pane.editor.setPosition({ lineNumber: line, column: 1 });
      pane.editor.revealLineInCenter(line);
      pane.editor.focus();
   }

   /** What each kind of editor is showing, so the document list can mark them apart. */
   visible(): VisibleDocuments {
      return { fixed: [this.fixed[0].path, this.fixed[1].path], selected: this.selected.path };
   }

   /** Re-measure every editor, for a divider drag that changed their boxes. */
   layout(): void {
      for (const pane of [...this.fixed, this.selected]) {
         pane.editor.layout();
      }
   }

   private mount(containerId: string, titleId: string, path: string): Pane {
      const pane: Pane = {
         title: requireElement(titleId),
         editor: this.options.adapter.createEditor(requireElement(containerId), this.modelFor(path)),
         path
      };
      // Saved on blur as well as on swap, because a reader can move a document
      // out of the selection editor by selecting a third one — at which point the
      // position they left it at is only recoverable if it was already recorded.
      pane.editor.onDidBlurEditorWidget(() => this.remember(pane));
      this.setTitle(pane, path);
      this.revealOnce(pane, path);
      return pane;
   }

   private load(pane: Pane, path: string): void {
      // The OUTGOING document's position is saved here rather than on every
      // cursor move: `saveViewState` walks the editor's contributions, so doing it
      // per keystroke would put that walk on the typing path for no gain.
      this.remember(pane);
      pane.editor.setModel(this.modelFor(path));
      pane.path = path;
      this.setTitle(pane, path);
      const state = this.viewStates.get(this.uriOf(path));
      if (state !== undefined) {
         pane.editor.restoreViewState(state);
      } else {
         this.revealOnce(pane, path);
      }
   }

   private setTitle(pane: Pane, path: string): void {
      pane.title.textContent = path;
      // The header truncates at a narrow pane, so the full URI has to be
      // reachable without widening it.
      pane.title.title = this.uriOf(path);
   }

   private remember(pane: Pane): void {
      const state = pane.editor.saveViewState();
      if (state !== null) {
         this.viewStates.set(this.uriOf(pane.path), state);
      }
   }

   private revealOnce(pane: Pane, path: string): void {
      const uri = this.uriOf(path);
      if (this.revealed.has(uri)) {
         return;
      }
      this.revealed.add(uri);
      this.options.adapter.revealDeclaration(pane.editor);
   }

   /**
    * The model for `path`, created on first use.
    *
    * A missing key is a hard failure rather than an empty editor: a document
    * opened on text the server does not have would not error, it would overwrite
    * the server's copy on `didOpen` and change the diagnostics the page reports.
    */
   private modelFor(path: string): monaco.editor.ITextModel {
      const text = this.options.files[path];
      if (text === undefined) {
         throw new Error(`The worker's filesystem has no ${path}`);
      }
      return this.options.adapter.openDocument(this.uriOf(path), text);
   }

   private uriOf(path: string): string {
      return `${this.options.rootUri}/${path}`;
   }

   private announce(): void {
      this.options.onVisibleChanged(this.visible());
   }
}
