/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The server's own log, over `window/logMessage`.
 *
 * This is the browser equivalent of the output channel a Theia or VS Code shell
 * gives a language server for free, and a plain page has to build — without it
 * every line the server logs goes nowhere, which is how a whole direction of the
 * sync stayed broken and invisible.
 *
 * **ONE panel covers all three heads**, because the framework's logger routes
 * through the shared services' LSP connection: a data-head read and a GLSP write
 * log onto the same channel as the LSP head's own lines.
 */

import { MessageType } from 'vscode-languageserver-protocol';
import { el, requireElement } from './dom.js';

/**
 * Upper bound on lines kept in the panel.
 *
 * The server logs one line per document per build phase, so a few edits reach the
 * hundreds and an unbounded panel makes the DOM the largest thing on the page.
 * The OLDEST lines go, which is the right end to drop: this panel is read to find
 * out what just happened.
 */
const LOG_LINE_CAP = 500;

/** LSP `MessageType` to the class the stylesheet colours by. */
const LOG_LEVEL_CLASSES: Readonly<Partial<Record<MessageType, string>>> = {
   [MessageType.Error]: 'error',
   [MessageType.Warning]: 'warning',
   [MessageType.Info]: 'info',
   [MessageType.Log]: 'log',
   [MessageType.Debug]: 'debug'
};

export class LogPanel {
   private readonly lines = requireElement('log');
   private readonly count = requireElement('log-summary');
   private readonly filterInput = requireElement('log-filter');

   /** Lines currently held, so the cap is enforced without querying the DOM. */
   private held = 0;

   /** Whether any line has arrived at `MessageType.Error`. */
   private sawError = false;

   /** Lowercased needle, or empty for everything. */
   private filter = '';

   constructor() {
      if (!(this.filterInput instanceof HTMLInputElement)) {
         throw new Error('#log-filter is not an input');
      }
      const input = this.filterInput;
      this.filterInput.addEventListener('input', () => {
         this.filter = input.value.trim().toLowerCase();
         this.applyFilter();
      });
      requireElement('log-clear').addEventListener('click', () => this.clear());
   }

   /**
    * Render one `window/logMessage` line.
    *
    * **The message arrives PRE-FORMATTED and is not reformatted here.** The
    * framework's logger builds `[Level - timestamp] [Component] message` itself,
    * so the level and the time are already in the text; `type` is used only to
    * colour the line. Rebuilding the prefix from `type` would produce a second,
    * differently formatted timestamp beside the server's own.
    *
    * Auto-scrolled only when the panel was ALREADY at the bottom. A panel that
    * scrolls unconditionally cannot be read: the line a reader scrolled back to
    * find jumps away on the next build.
    */
   append(type: MessageType, message: string): void {
      const atBottom = this.lines.scrollHeight - this.lines.scrollTop - this.lines.clientHeight < 4;

      const line = el('div', { class: LOG_LEVEL_CLASSES[type] ?? 'log', text: message });
      this.hideIfFiltered(line);
      this.lines.append(line);
      this.held += 1;
      while (this.held > LOG_LINE_CAP && this.lines.firstChild !== null) {
         this.lines.removeChild(this.lines.firstChild);
         this.held -= 1;
      }

      if (type === MessageType.Error) {
         this.sawError = true;
      }
      this.count.textContent = String(this.held);
      // An error is called out by name because the whole reason this panel exists
      // is that a server-side error over `window/logMessage` previously reached
      // nobody — and it stays called out after the line has scrolled away.
      this.count.classList.toggle('badge-error', this.sawError);
      this.count.title = this.sawError ? 'one or more errors have been logged' : 'lines received';

      if (atBottom) {
         this.lines.scrollTop = this.lines.scrollHeight;
      }
   }

   /**
    * Hide the lines that do not match, rather than removing them.
    *
    * The panel is the only record of what the server said, so a filter that
    * dropped lines would make clearing the box a destructive act — and the
    * server does not resend.
    */
   private applyFilter(): void {
      // `Array.from` rather than a spread: this project compiles against a lib
      // where `HTMLCollection` is not declared iterable.
      for (const line of Array.from(this.lines.children)) {
         if (line instanceof HTMLElement) {
            this.hideIfFiltered(line);
         }
      }
   }

   private hideIfFiltered(line: HTMLElement): void {
      line.hidden = this.filter !== '' && !(line.textContent ?? '').toLowerCase().includes(this.filter);
   }

   /**
    * Drop every line held.
    *
    * The error marker goes with them: it says "there is an error in this panel",
    * and once the panel is empty that is no longer true. Keeping it would leave a
    * warning a reader cannot act on or dismiss.
    */
   private clear(): void {
      this.lines.replaceChildren();
      this.held = 0;
      this.sawError = false;
      this.count.textContent = '0';
      this.count.classList.remove('badge-error');
   }
}
