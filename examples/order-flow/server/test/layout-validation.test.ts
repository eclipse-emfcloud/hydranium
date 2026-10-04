/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { URI } from '@hydranium/langium';
import { readFileSync } from 'node:fs';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { afterEach, describe, expect, it } from 'vitest';
import { OVERRIDDEN_LAYOUT_ENTRY } from '../src/messages/index.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness } from './order-flow-harness.js';

let scratch: ScratchWorkspace | undefined;

/** Validate `fulfillment.layout` after appending `extra` entries to its body. */
async function validateLayoutWith(
   extra: string[]
): Promise<{ text: string; diagnostics: { line: number; severity?: number; code?: unknown; message: unknown }[] }> {
   const { harness, workspace } = await makeScratchWorkspaceHarness(prepared => {
      const path = prepared.resolve(WORKSPACE_FILES.fulfillmentDiagram);
      const body = extra.map(entry => `   ${entry}\n`).join('');
      prepared.write(WORKSPACE_FILES.fulfillmentDiagram, readFileSync(path, 'utf8').replace(/\n\}\s*$/, `\n${body}}\n`));
   });
   scratch = workspace;
   const document = await harness.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(workspace.resolve(WORKSPACE_FILES.fulfillmentDiagram))
   );
   await harness.shared.workspace.DocumentBuilder.build([document], { validation: true });
   return {
      text: document.textDocument.getText(),
      diagnostics: (document.diagnostics ?? []).map(diagnostic => ({
         line: diagnostic.range.start.line,
         severity: diagnostic.severity,
         code: diagnostic.code,
         message: diagnostic.message
      }))
   };
}

describe('order-flow .layout validation', () => {
   afterEach(() => {
      scratch?.dispose();
      scratch = undefined;
   });

   it('warns on every entry a later entry for the same node overrides, and not on the one in force', async () => {
      const { text, diagnostics } = await validateLayoutWith(['node Pay at 300, 300', 'node Pay at 500, 500']);
      const lines = text.split('\n');
      const payLines = lines.flatMap((line, index) => (line.trim().startsWith('node Pay ') ? [index] : []));

      expect(diagnostics).toEqual(
         payLines.slice(0, -1).map(line => ({
            line,
            severity: DiagnosticSeverity.Warning,
            code: OVERRIDDEN_LAYOUT_ENTRY.code,
            message: OVERRIDDEN_LAYOUT_ENTRY.format({ node: 'Pay' })
         }))
      );
   });

   it('reports nothing for a layout with one entry per node — the control on the row above', async () => {
      const { diagnostics } = await validateLayoutWith([]);

      expect(diagnostics).toEqual([]);
   });
});
