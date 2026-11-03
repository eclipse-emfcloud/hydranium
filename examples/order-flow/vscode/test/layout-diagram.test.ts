/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WebviewPanel } from 'vscode';
import { LAYOUT_LANGUAGE } from '@hydranium/example-order-flow-protocol';
import { ORDER_FLOW_LAYOUT_DIAGRAM_VIEW_TYPE, OrderFlowLayoutDiagramEditorProvider } from '../src/layout-diagram-editor';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('vscode', () => ({ commands: { executeCommand }, Uri: { parse: (uri: string) => uri } }));
vi.mock('../src/process-diagram-editor', () => ({ ORDER_FLOW_PROCESS_DIAGRAM_VIEW_TYPE: 'orderFlow.processDiagram' }));

describe('OrderFlowLayoutDiagramEditorProvider', () => {
   it('registers an optional editor for every layout extension', () => {
      const manifest = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
      const editor = manifest.contributes.customEditors.find(
         (entry: { viewType: string }) => entry.viewType === ORDER_FLOW_LAYOUT_DIAGRAM_VIEW_TYPE
      );
      expect(editor.priority).toBe('option');
      expect(editor.selector).toEqual(LAYOUT_LANGUAGE.fileExtensions.map(extension => ({ filenamePattern: `*${extension}` })));
   });

   it('opens the process in the same column before disposing the redirect panel', async () => {
      const provider = new OrderFlowLayoutDiagramEditorProvider();
      const dispose = vi.fn();
      const panel = { viewColumn: 2, dispose } as unknown as WebviewPanel;
      const document = { uri: { toString: () => 'file:///a.layout' }, dispose() {} } as Parameters<typeof provider.resolveCustomEditor>[0];
      await provider.resolveCustomEditor(document, panel);
      expect(executeCommand).toHaveBeenCalledWith('vscode.openWith', 'file:///a.process', 'orderFlow.processDiagram', { viewColumn: 2 });
      expect(dispose).toHaveBeenCalledOnce();
      expect(executeCommand.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0]);
   });

   it('disposes the redirect panel and propagates a failed process open', async () => {
      const provider = new OrderFlowLayoutDiagramEditorProvider();
      const dispose = vi.fn();
      const panel = { viewColumn: 2, dispose } as unknown as WebviewPanel;
      const document = { uri: { toString: () => 'file:///a.layout' }, dispose() {} } as Parameters<typeof provider.resolveCustomEditor>[0];
      const failure = new Error('process editor failed to open');
      executeCommand.mockRejectedValueOnce(failure);

      await expect(provider.resolveCustomEditor(document, panel)).rejects.toBe(failure);
      expect(dispose).toHaveBeenCalledOnce();
   });
});
