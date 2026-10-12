/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `ModelService` attaches its settled-phase listener in its constructor, so a
 * tree in which nothing resolves the service before the first build must still
 * construct it at bootstrap. The headless init is such a tree: no LSP
 * `initialize` constructs every service first.
 */

import { DefaultModelService, initializeWorkspaceProgrammatically, type ServerSharedServices } from '@hydranium/core';
import { type AstNode, type LangiumDocument } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_FILES, WORKSPACE_ROOT, makeServices, workspaceUri } from './order-flow-harness.js';

describe('ModelService under a headless init', () => {
   it('sees a document settle in the first build, though nothing resolved the service', async () => {
      const settled: string[] = [];
      class RecordingModelService extends DefaultModelService<AstNode> {
         protected override syncToLanguageClient(document: LangiumDocument): void {
            settled.push(document.uri.toString());
            super.syncToLanguageClient(document);
         }
      }
      const harness = makeServices({
         extraSharedModules: [{ model: { ModelService: (services: ServerSharedServices) => new RecordingModelService(services) } }]
      });

      await initializeWorkspaceProgrammatically(harness.shared, WORKSPACE_ROOT);

      expect(settled).toContain(workspaceUri(WORKSPACE_FILES.ordersDomain).toString());
   });
});
