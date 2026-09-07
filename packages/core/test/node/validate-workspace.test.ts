/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type LangiumDocument, type URI } from '@hydranium/langium';
import { type Diagnostic, DiagnosticSeverity, type Range } from 'vscode-languageserver';
import { describe, expect, it } from 'vitest';
import { makeFakeAstNode, makeFakeDocument, makeNoopSharedServices } from '../../src/testing/index.js';
import { collectValidationResult, validateWorkspace } from '../../src/node/validate-workspace.js';

function range(line: number, character: number): Range {
   return { start: { line, character }, end: { line, character } };
}

function diagnostic(severity: DiagnosticSeverity | undefined, message: string, at: Range, extra: Partial<Diagnostic> = {}): Diagnostic {
   return { severity, message, range: at, ...extra };
}

function docWith(uri: string, diagnostics: Diagnostic[]): LangiumDocument {
   return makeFakeDocument(uri, makeFakeAstNode({ $type: 'Root' }), { diagnostics });
}

/** Strip the `file://…` prefix down to the trailing path segment for a readable relative URI. */
function basename(uri: URI): string {
   const segments = uri.path.split('/');
   return segments[segments.length - 1];
}

describe('collectValidationResult', () => {
   it('maps every severity, tallies counts, and records 0-based position + code/source', () => {
      const documents = [
         docWith('file:///ws/a.a', [
            diagnostic(DiagnosticSeverity.Error, 'boom', range(2, 4), { code: 'no-boom', source: 'integrity' }),
            diagnostic(DiagnosticSeverity.Warning, 'careful', range(0, 0))
         ]),
         docWith('file:///ws/b.a', [
            diagnostic(DiagnosticSeverity.Information, 'fyi', range(1, 1)),
            diagnostic(DiagnosticSeverity.Hint, 'tip', range(3, 3))
         ])
      ];

      const result = collectValidationResult(documents, basename);

      expect(result.documents).toBe(2);
      expect(result.counts).toEqual({ error: 1, warning: 1, info: 1, hint: 1 });
      expect(result.findings[0]).toEqual({
         uri: 'a.a',
         severity: 'error',
         message: 'boom',
         line: 2,
         character: 4,
         code: 'no-boom',
         source: 'integrity'
      });
      // Findings stay grouped by document, in build order.
      expect(result.findings.map(finding => finding.uri)).toEqual(['a.a', 'a.a', 'b.a', 'b.a']);
      expect(result.findings.map(finding => finding.severity)).toEqual(['error', 'warning', 'info', 'hint']);
   });

   it('treats an omitted severity as an error so a rule that forgets one still blocks the gate', () => {
      const result = collectValidationResult([docWith('file:///ws/a.a', [diagnostic(undefined, 'unset', range(0, 0))])], basename);
      expect(result.counts.error).toBe(1);
      expect(result.findings[0].severity).toBe('error');
      expect(result.findings[0].code).toBeUndefined();
      expect(result.findings[0].source).toBeUndefined();
   });

   it('returns an empty, zeroed result for a clean workspace', () => {
      const result = collectValidationResult([docWith('file:///ws/a.a', []), docWith('file:///ws/b.a', [])], basename);
      expect(result).toEqual({ documents: 2, findings: [], counts: { error: 0, warning: 0, info: 0, hint: 0 } });
   });
});

describe('validateWorkspace', () => {
   it('builds the workspace then collects diagnostics via the workspace-relative path', async () => {
      const documents = [docWith('file:///ws/model.a', [diagnostic(DiagnosticSeverity.Error, 'bad ref', range(5, 2))])];
      const events: string[] = [];
      const shared = makeNoopSharedServices({
         workspace: {
            WorkspaceManager: {
               initialize: () => events.push('initialize'),
               initialized: () => {
                  events.push('initialized');
                  return Promise.resolve();
               },
               wsRelativePath: (uri: URI) => basename(uri)
            },
            LangiumDocuments: { all: { toArray: () => documents } },
            DocumentBuilder: {
               build: () => {
                  events.push('build');
                  return Promise.resolve();
               }
            }
         }
      });

      const result = await validateWorkspace({ createServices: () => ({ shared }), workspace: '/ws' });

      expect(events).toEqual(['initialize', 'initialized', 'build']);
      expect(result.documents).toBe(1);
      expect(result.counts.error).toBe(1);
      expect(result.findings[0]).toMatchObject({ uri: 'model.a', severity: 'error', message: 'bad ref', line: 5, character: 2 });
   });
});
