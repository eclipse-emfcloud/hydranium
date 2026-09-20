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
import { isNarrowViewport } from './responsive.js';
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
   /**
    * Called with the document of whichever editor the reader is now in.
    *
    * FOCUS, not selection, because three editors are on screen at once and two
    * of them are pinned: a selection names the document in one pane, where focus
    * names the one being read. Fires on every focus, including a repeat, so a
    * consumer that must not re-act guards on the value.
    */
   readonly onFocusChanged?: (path: string) => void;
   /**
    * Called with the URIs whose buffer has moved since they were last saved,
    * whenever that set is recomputed.
    *
    * Pushed rather than polled, and the editors are the only ones who can push
    * it: a document goes unsaved on a content change and clean on a save, and
    * neither is an event a consumer can subscribe to for itself.
    */
   readonly onDirtyChanged?: (dirty: ReadonlySet<string>) => void;
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

   /**
    * URIs already subscribed for the dirty marks. A model is Monaco's per-URI
    * singleton and outlives the pane showing it, so a second subscription when
    * it returns to the selection editor would recompute the marks once per
    * visit it has ever had.
    */
   private readonly watched = new Set<string>();

   /**
    * The diagram's title, which is marked from the FIXED pair rather than from
    * a document of its own.
    *
    * The canvas has no buffer, so a mark driven by what it draws is the only
    * one it can carry — and it draws both of the pinned documents, the
    * semantics and the coordinates a drag rewrites. Marking it from the one it
    * is labelled with would leave a drag showing an unsaved layout editor under
    * a diagram reporting itself saved, which is the pair this page exists to
    * show moving together.
    */
   private readonly diagramTitle = requireElement('diagram-title');

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
         this.present(fixed);
         // Announced here as well as from the focus listener: focusing an editor
         // that already HAS focus fires no event, so a reader re-selecting the
         // document they are already in would leave a consumer on whatever was
         // announced last.
         this.options.onFocusChanged?.(path);
         return;
      }
      if (path !== this.selected.path) {
         this.load(this.selected, path);
         this.announce();
      }
      this.present(this.selected);
      this.options.onFocusChanged?.(path);
   }

   /**
    * Put `pane` where the reader can see it, and give it the caret only where
    * taking the caret costs nothing.
    *
    * **Focus opens the on-screen keyboard.** In one column the pane a list
    * selection opens is well down a scrolling page, so focusing it covers a
    * document the reader has not been shown yet with a keyboard they did not
    * ask for — and the list they were reading is gone behind it. Scrolling to
    * the pane says the same thing and leaves the input where they put it.
    */
   private present(pane: Pane): void {
      if (isNarrowViewport()) {
         // The whole pane rather than the editor: its header names the document,
         // which is the part that says the selection was honoured.
         pane.editor.getContainerDomNode().closest('.pane')?.scrollIntoView({ block: 'start' });
         return;
      }
      pane.editor.focus();
   }

   /**
    * Show `path` and put the cursor on `line`, at `column` where one is given.
    *
    * `revealLineInCenter` rather than the top-anchored scroll the initial reveal
    * uses: a diagnostic is a POINT the reader wants context around, where a
    * declaration is the start of a region they want all of.
    *
    * The column defaults to the start of the line because a diagnostic's own
    * column is already inside the range it underlines, so the marker says where
    * on the line the problem is. A reference followed to its declaration has no
    * such second marker, and landing at column 1 of `entity Order` leaves the
    * caret on the keyword rather than on the name that was clicked.
    */
   reveal(path: string, line: number, column = 1): void {
      this.show(path);
      const pane = this.fixed.find(candidate => candidate.path === path) ?? this.selected;
      pane.editor.setPosition({ lineNumber: line, column });
      pane.editor.revealLineInCenter(line);
      this.present(pane);
   }

   /**
    * Show the document `uri` addresses at `position`, and report whether this
    * page had a document to show.
    *
    * `false` rather than a throw for a URI with no seeded file behind it, and
    * that case is REACHABLE rather than defensive: this workspace validates an
    * in-code contribution on the `virtual:` scheme, which has no file and no
    * text to open an editor over. A resolved reference into one is a jump the
    * page genuinely cannot make, and saying so lets the caller leave the reader
    * where they are instead of moving them to an editor built on invented text.
    */
   revealUri(uri: string, position: monaco.IPosition): boolean {
      const prefix = `${this.options.rootUri}/`;
      if (!uri.startsWith(prefix)) {
         return false;
      }
      const path = uri.slice(prefix.length);
      if (this.options.files[path] === undefined) {
         return false;
      }
      this.reveal(path, position.lineNumber, position.column);
      return true;
   }

   /** What each kind of editor is showing, so the document list can mark them apart. */
   visible(): VisibleDocuments {
      return { fixed: [this.fixed[0].path, this.fixed[1].path], selected: this.selected.path };
   }

   /**
    * The document of whichever editor holds the caret, or `undefined` when none
    * does.
    *
    * `hasTextFocus` rather than reading `document.activeElement` against the
    * container: Monaco mounts overlays of its own inside that container — the
    * find box among them — and a reader typing in one of those is not editing
    * the document.
    */
   focusedPath(): string | undefined {
      return [...this.fixed, this.selected].find(pane => pane.editor.hasTextFocus())?.path;
   }

   /** Re-measure every editor, for a divider drag that changed their boxes. */
   layout(): void {
      for (const pane of [...this.fixed, this.selected]) {
         pane.editor.layout();
      }
   }

   /**
    * Mark each title whose buffer has moved since that document was last saved,
    * and announce the same set to whoever else shows it.
    *
    * Public because a SAVE clears the state and the save does not happen here:
    * `markSaved` is recorded on the adapter by whoever performed it, and nothing
    * on an editor fires when that happens, so the page says when to look again.
    *
    * Read from the adapter rather than tracked here, so one definition of dirty
    * serves both the marks and what a save actually writes — a second definition
    * would eventually disagree with the button. The announcement carries that
    * same set for the same reason, rather than letting a second reader compute
    * one of its own.
    */
   refreshDirtyMarks(): void {
      const dirty = new Set(this.options.adapter.dirtyDocuments().map(document => document.uri));
      for (const pane of [...this.fixed, this.selected]) {
         pane.title.classList.toggle('is-dirty', dirty.has(this.uriOf(pane.path)));
      }
      const drawn = this.fixed.filter(pane => dirty.has(this.uriOf(pane.path)));
      this.diagramTitle.classList.toggle('is-dirty', drawn.length > 0);
      // Which document, not merely that one moved: the diagram is labelled with
      // the semantics alone, so an unmarked tooltip would leave a reader whose
      // drag rewrote the coordinates looking for the change in the wrong file.
      this.diagramTitle.title = drawn.map(pane => `${this.uriOf(pane.path)} — unsaved`).join('\n');
      this.options.onDirtyChanged?.(dirty);
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
      // `onDidFocusEditorText`, not `…EditorWidget`: the widget form also fires
      // for the find box and any other overlay Monaco mounts inside the editor,
      // which are not a change of document and would republish on every search.
      pane.editor.onDidFocusEditorText(() => this.options.onFocusChanged?.(pane.path));
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
      // The pane now shows a different document, whose dirtiness is its own and
      // is not announced by a content change.
      this.refreshDirtyMarks();
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
      const uri = this.uriOf(path);
      const model = this.options.adapter.openDocument(uri, text);
      if (!this.watched.has(uri)) {
         this.watched.add(uri);
         // Every content change, not only a keystroke: a diagram drag reaches
         // this buffer through `workspace/applyEdit`, and that edit is as
         // unsaved as a typed one.
         //
         // **On the MODEL, not on the editor, and an undo is what separates
         // them.** Monaco delivers a content change twice from one edit: first
         // straight into the attached view models, which is what an editor's
         // `onDidChangeModelContent` re-emits, and then through the model's own
         // deferred emitter. Undo restores the alternative version id BETWEEN
         // those two, so a listener on the editor reads the monotonic id, marks
         // the document unsaved, and is never called again to correct it — the
         // mark then outlives the edit it was reporting, and outlives it in the
         // one direction that matters, since the dirty set is also what a save
         // writes.
         model.onDidChangeContent(() => this.refreshDirtyMarks());
      }
      return model;
   }

   private uriOf(path: string): string {
      return `${this.options.rootUri}/${path}`;
   }

   private announce(): void {
      this.options.onVisibleChanged(this.visible());
   }
}
