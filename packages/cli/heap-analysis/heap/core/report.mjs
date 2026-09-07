/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Minimal Markdown report builder. Accumulates sections (headings, prose,
 * tables, code blocks) and renders to a single Markdown string -- readable as
 * plain text in a terminal, saveable as a .md file, and cheap for a tool to
 * parse (Markdown headings and tables).
 */

/** Escape `|` so a heap-derived cell value (e.g. a `A | B` union string) cannot shift table columns (GFM). */
function escapeCell(value) {
   return String(value).replace(/\|/g, '\\|');
}

export class Report {
   constructor() {
      this.lines = [];
   }

   /** Top-level title. */
   title(text) {
      this.lines.push(`# ${text}`, '');
      return this;
   }

   /** Section heading (blank line before keeps sections separated). */
   section(text) {
      this.lines.push('', `## ${text}`, '');
      return this;
   }

   /** A paragraph / note line. */
   note(text) {
      this.lines.push(text, '');
      return this;
   }

   /**
    * A Markdown table. `headers` is a string[]; `rows` is string[][]. Cells are
    * stringified as-is (callers pre-format sizes/percentages).
    */
   table(headers, rows) {
      this.lines.push(`| ${headers.map(escapeCell).join(' | ')} |`);
      this.lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
      for (const row of rows) {
         this.lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
      }
      this.lines.push('');
      return this;
   }

   /** A fenced code block (for retainer paths and other monospace content). */
   code(text) {
      this.lines.push('```', text, '```', '');
      return this;
   }

   toString() {
      return this.lines.join('\n');
   }
}
