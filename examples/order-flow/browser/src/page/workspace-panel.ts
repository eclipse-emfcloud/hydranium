/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The sidebar: every document the workspace holds, and every diagnostic the LSP
 * head published, both of them navigable.
 *
 * **The problems list is deliberately NOT filtered to open documents.** The
 * workspace contains `orders/audit-leak.domain` precisely so that a diagnostic
 * exists for a file nobody opened — that is the demonstration, since Langium
 * publishes for every document the workspace walk builds and a client that only
 * heard about its own editors would report a clean workspace. Filtering here
 * would make the page agree with itself instead of with the server. The answer to
 * "the report names documents the page cannot show" is therefore this panel,
 * which makes every one of them openable.
 *
 * It also lists documents the page CANNOT open, and that asymmetry is real
 * rather than an oversight: in-code contributions arrive on the `virtual:`
 * scheme, are registered independently of the workspace folder, and have no file
 * behind them. They are shown with the reason instead of a click target.
 */

import type { Diagnostic, PublishDiagnosticsParams } from 'vscode-languageserver-protocol';
import { el, icon, replaceContent, requireElement } from './dom.js';

/** Where a diagnostic click wants to go. */
export interface DiagnosticTarget {
   readonly uri: string;
   /** One-based, as an editor counts them. */
   readonly line: number;
}

/** What the editors are showing, by path under the workspace root. */
export interface VisibleDocuments {
   /** The pair pinned beside the diagram, on screen regardless of any click. */
   readonly fixed: readonly string[];
   /** What the lookup editor holds, i.e. what the last click selected. */
   readonly selected: string | undefined;
}

export interface WorkspacePanelHandlers {
   /** Open a seeded document, by its path under the workspace root. */
   readonly onOpenDocument: (path: string) => void;
   /** Reveal a diagnostic. The panel has already established that the URI is openable. */
   readonly onOpenDiagnostic: (target: DiagnosticTarget) => void;
   /** Called for a URI with no file behind it, so the page can say so. */
   readonly onUnopenable: (uri: string) => void;
}

/**
 * Diagnostic severity as the stylesheet names it.
 *
 * Numbers rather than the `DiagnosticSeverity` enum, because severity is
 * OPTIONAL on the wire — an omitted one is an error by LSP's own default, and
 * reading `params.diagnostics[i].severity` as a definite value is how a warning
 * ends up styled as nothing at all.
 */
const SEVERITY_CLASSES: Readonly<Record<number, string>> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

function severityClass(severity: number | undefined): string {
   return SEVERITY_CLASSES[severity ?? 1] ?? 'error';
}

function severityIcon(severity: number | undefined): string {
   const name = severityClass(severity);
   return name === 'error' ? 'error' : name === 'warning' ? 'warning' : 'info';
}

/**
 * A diagnostic's message as one line of text.
 *
 * `Diagnostic.message` is `string | MarkupContent` in 3.18, and the union is not
 * hypothetical for a list: the object form would render as `[object Object]`
 * through `textContent`, which is a legible-looking row that says nothing.
 */
function messageText(message: Diagnostic['message']): string {
   return typeof message === 'string' ? message : message.value;
}

export class WorkspacePanel {
   private readonly documents = requireElement('document-list');
   private readonly documentsCount = requireElement('document-list-count');
   private readonly problems = requireElement('problem-list');
   private readonly problemsCount = requireElement('problem-list-count');

   /**
    * What is on screen, split by WHICH KIND of editor holds it.
    *
    * One marker for both would be the confusing shape: the pinned pair is on
    * screen whatever the reader clicks, so marking them the same way as the
    * selection makes three rows look selected and the click that selected one of
    * them look like it did nothing.
    */
   private visible: VisibleDocuments = { fixed: [], selected: undefined };

   /**
    * @param paths every seeded document, by path under the workspace root. Taken
    * from the WORKER's filesystem rather than from the generated seed, so a
    * restored workspace lists what the heads actually came up on.
    * @param rootUri the workspace root, for turning a path into the URI
    * diagnostics are published against.
    */
   constructor(
      private readonly paths: readonly string[],
      private readonly rootUri: string,
      private readonly handlers: WorkspacePanelHandlers
   ) {}

   /** Which documents are showing, so the list marks them without re-querying the editors. */
   setVisible(visible: VisibleDocuments): void {
      this.visible = visible;
   }

   /**
    * Re-render both lists.
    *
    * Rebuilt wholesale on every publish rather than patched, because a publish
    * replaces a document's whole diagnostic array — there is no incremental
    * shape to exploit, and this workspace is eight documents.
    */
   render(diagnosticsByUri: ReadonlyMap<string, PublishDiagnosticsParams>): void {
      this.renderDocuments(diagnosticsByUri);
      this.renderProblems(diagnosticsByUri);
   }

   private renderDocuments(diagnosticsByUri: ReadonlyMap<string, PublishDiagnosticsParams>): void {
      this.documentsCount.textContent = String(this.paths.length);
      replaceContent(
         this.documents,
         [...this.paths].sort().map(path => {
            const count = diagnosticsByUri.get(`${this.rootUri}/${path}`)?.diagnostics.length ?? 0;
            const worst = this.worstSeverity(diagnosticsByUri.get(`${this.rootUri}/${path}`));
            const pinned = this.visible.fixed.includes(path);
            const selected = this.visible.selected === path;
            return el(
               'button',
               {
                  class: `row document-row${selected ? ' is-selected' : ''}${pinned ? ' is-pinned' : ''}`,
                  title: pinned ? `${this.rootUri}/${path} — pinned beside the diagram` : `${this.rootUri}/${path}`,
                  attrs: { type: 'button', 'aria-current': selected ? 'true' : 'false' },
                  onClick: () => this.handlers.onOpenDocument(path)
               },
               [
                  icon('file-code'),
                  el('span', { class: 'row-label', text: path }),
                  // A pin rather than the selection's accent bar, because the pair
                  // beside the diagram is on screen whichever row is selected —
                  // it is a property of the document, not of the last click.
                  pinned && icon('pinned'),
                  // The count is the reason this list exists rather than a
                  // decoration: it is what lets a reader see that a document
                  // nobody opened has a diagnostic.
                  count === 0
                     ? el('span', { class: 'badge badge-quiet', text: '0' })
                     : el('span', { class: `badge badge-${severityClass(worst)}`, text: String(count) })
               ]
            );
         })
      );
   }

   private worstSeverity(params: PublishDiagnosticsParams | undefined): number | undefined {
      // The LOWEST number is the worst, per LSP's ordering, so a document with
      // one error and four hints is badged as an error.
      return params?.diagnostics.reduce<number | undefined>(
         (worst, diagnostic) => (worst === undefined ? (diagnostic.severity ?? 1) : Math.min(worst, diagnostic.severity ?? 1)),
         undefined
      );
   }

   private renderProblems(diagnosticsByUri: ReadonlyMap<string, PublishDiagnosticsParams>): void {
      const total = [...diagnosticsByUri.values()].reduce((sum, params) => sum + params.diagnostics.length, 0);
      this.problemsCount.textContent = String(total);
      if (total === 0) {
         replaceContent(this.problems, [el('p', { class: 'empty', text: 'No diagnostics.' })]);
         return;
      }
      const sections = [];
      for (const uri of [...diagnosticsByUri.keys()].sort()) {
         const params = diagnosticsByUri.get(uri);
         if (params === undefined || params.diagnostics.length === 0) {
            continue;
         }
         sections.push(
            el('div', { class: 'problem-group' }, [
               el('div', { class: 'problem-group-head', title: uri }, [
                  icon('file'),
                  el('span', { class: 'row-label', text: this.label(uri) }),
                  el('span', { class: 'badge badge-quiet', text: String(params.diagnostics.length) })
               ]),
               ...params.diagnostics.map(diagnostic =>
                  el(
                     'button',
                     {
                        class: `row problem-row ${severityClass(diagnostic.severity)}`,
                        title: messageText(diagnostic.message),
                        attrs: { type: 'button' },
                        onClick: () => this.reveal(uri, diagnostic.range.start.line + 1)
                     },
                     [
                        icon(severityIcon(diagnostic.severity)),
                        el('span', { class: 'row-label', text: messageText(diagnostic.message) }),
                        el('span', {
                           class: 'badge badge-quiet',
                           text: `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`
                        })
                     ]
                  )
               )
            ])
         );
      }
      replaceContent(this.problems, sections);
   }

   /**
    * Open a diagnostic's document at its line, or explain why not.
    *
    * The check is on the SEEDED set rather than on the URI scheme, because
    * "under the workspace root" and "has a file the page can open" are different
    * questions and only the second one matters here.
    */
   private reveal(uri: string, line: number): void {
      const path = uri.startsWith(`${this.rootUri}/`) ? uri.slice(this.rootUri.length + 1) : undefined;
      if (path === undefined || !this.paths.includes(path)) {
         this.handlers.onUnopenable(uri);
         return;
      }
      this.handlers.onOpenDiagnostic({ uri, line });
   }

   /** Workspace documents by their path under the root; anything else in full. */
   private label(uri: string): string {
      return uri.startsWith(`${this.rootUri}/`) ? uri.slice(this.rootUri.length + 1) : uri;
   }
}
